# Anthropic Account Rotation: Multi-Account Pool With Automatic Failover

## Release Recommendation

**Release:** ship independently

This is a new opt-in feature with no roadmap batch tag.
It is additive (no behavior change when no account pool exists), so it ships on its own, likely as a minor version bump.

## Problem Statement

Claude Pro/Max subscriptions have per-account usage limits.
When the active OAuth account hits its limit, Anthropic rejects requests (HTTP 429 `rate_limit_error`, "usage limit reached" style messages) and the session stalls until the window resets or the user manually runs `/login anthropic` with a different account.

Goal: allow storing multiple Anthropic OAuth accounts, and on a usage-limit error automatically switch to the next account and retry the request transparently.

## Scouting Findings (verified against installed pi 0.80.10)

1. **Pi's credential store holds one credential per provider id.**
   `auth.json` (via `AuthStorage` in `pi-coding-agent/dist/core/auth-storage.js`) is keyed by provider id — there is no native multi-account support to reuse.
2. **The credential store is effectively read-only for extensions.**
   The coding-agent package root exports only `readStoredCredential`; the writable `AuthStorage` class is not on the public index.
   Writing `auth.json` ourselves would mean replicating its `proper-lockfile` semantics — a compat liability to avoid.
3. **Our transport wrapper already sees every Anthropic call** (`src/oauth-transport.ts`), and `options.apiKey` carries the resolved token.
   Overriding `options.apiKey` before delegating is a supported seam — the built-in transport uses `options.apiKey` verbatim to build its client.
4. **The built-in transport never throws; errors surface as stream events.**
   On failure it pushes a single `{ type: "error", reason: "error", error: { errorMessage } }` event and ends (`pi-ai/dist/api/anthropic-messages.js` ~L575).
   Crucially, an HTTP-level 429 throws from `client.messages.create(...).asResponse()` **before** the `start` event is pushed, so a limit-failed stream contains exactly one `error` event — a clean retry point with no partial content to reconcile.
5. **Streams are constructible.**
   `createAssistantMessageEventStream()` and the `AssistantMessageEventStream` class are exported from the pi-ai root (host-aliased), so a retry wrapper can own the outer stream and pipe delegate events into it.
6. **Token refresh for pooled accounts must be local.**
   Pi's `anthropicOAuth.refresh` only runs for the credential stored in `auth.json`.
   `refreshAnthropicToken` is module-private in pi-ai >=0.80.8 (Issue #43), but it is a plain POST to the OAuth token endpoint with a public `CLIENT_ID` (`pi-ai/dist/auth/oauth/anthropic.js` ~L268) — ~30 lines to replicate.
7. **`registerProvider` supplying `oauth` again is off the table** (Issue #43): login/refresh for the primary account stays delegated to the built-in `anthropicOAuth`.

## Design

### Chosen strategy: pool-owned apiKey override (no `auth.json` writes)

Store the account pool in our own file, `~/.pi/agent/anthropic-accounts.json` (mode 0600):

```json
{
  "version": 1,
  "activeIndex": 0,
  "accounts": [
    { "label": "work", "refresh": "...", "access": "...", "expires": 1234567890 },
    { "label": "personal", "refresh": "...", "access": "...", "expires": 1234567890 }
  ]
}
```

Behavior:

1. **Pool empty (default):** everything works exactly as today — passthrough, zero behavior change.
2. **Pool non-empty and the request is Anthropic OAuth** (`sk-ant-oat` gate, same as shaping): the transport overrides `options.apiKey` with the active pooled account's access token (refreshing it locally first if expired) before delegating.
3. **On a usage-limit error event** (and only before any content event was forwarded): rotate `activeIndex` to the next account, refresh it if needed, re-invoke the delegate with the new token, and pipe the new stream into the same outer stream.
4. **Give up after one full cycle** through the pool (all accounts limited): forward the original error event so the user sees the real failure.

Account management commands (extending the existing `/anthropic-auth:*` command surface):

1. `/anthropic-auth:accounts` — list pool entries (label, active marker, expiry; never print secrets).
2. `/anthropic-auth:accounts add <label>` — snapshot the current `anthropic` credential from `auth.json` (via the exported `readStoredCredential`) into the pool.
   Adding account N means: run `/login anthropic` with that account, then `accounts add`.
   This completely avoids reimplementing the login flow.
3. `/anthropic-auth:accounts switch <label|index>` — manual rotation.
4. `/anthropic-auth:accounts remove <label|index>` — drop an entry.

### Rejected alternatives

1. **Write-through rotation into `auth.json`** — rejected: no public write API (finding 2); replicating `AuthStorage` locking is fragile and races with Pi's own refresh writes.
2. **Re-registering `oauth` to intercept login for multi-account capture** — rejected: re-opens the exact Issue #43 wound; `registerProvider` merge semantics make a stale `oauth` override sticky.
3. **Rotate-on-next-request only (no in-flight retry)** — simpler, but fails the requirement; kept as a degraded fallback if the retry stream proves unreliable (see Risks).

### Limit-error classification

Rotation must trigger only on **account-scoped** limit errors:

1. Rotate: HTTP 429 / `rate_limit_error` / "usage limit reached" / "will reset at" message signatures.
2. Do **not** rotate: 529 `overloaded_error` (global, not account-bound), the "extra usage" 400 (a request-shaping problem, not a quota problem), auth errors (401 — surface to user; the pooled refresh token is dead), or any other error.

Classification operates on the `errorMessage` string of the error event (the SDK error text includes the status code and error JSON).
Keep it in a dedicated helper so signatures are easy to adjust as Anthropic drifts (per the "Isolate Compatibility Logic" principle).

### New source layout

1. `src/account-store.ts` — pool file load/save (atomic write, 0600, in-process write serialization), add/remove/switch/rotate operations.
2. `src/token-refresh.ts` — local Anthropic OAuth refresh (POST `grant_type=refresh_token`, same endpoint/CLIENT_ID as upstream; 5-minute expiry skew like upstream).
3. `src/limit-detection.ts` — `classifyAnthropicError(errorMessage): "usage-limit" | "auth" | "other"`.
4. `src/rotating-transport.ts` — wraps the existing OAuth-shaping transport: apiKey override, event piping via `createAssistantMessageEventStream()`, retry-on-limit loop with the one-full-cycle cap.
5. `src/index.ts` — compose `rotating(shaping(builtin))`, register the `accounts` command; surface pool status in `/anthropic-auth:status` diagnostics.

Layering: rotation wraps **outside** the shaping wrapper, so each retry re-runs shaping with the correct per-account token gate, and shaping stays single-purpose.

## Implementation Steps

Each step is a red→green→commit cycle.

1. **`limit-detection.ts`** — classification helper.
   Tests: representative 429/usage-limit messages rotate; 529, extra-usage 400, 401, and generic errors do not.
2. **`account-store.ts`** — pool schema, load/save, add/switch/remove/rotateNext.
   Tests: round-trip persistence to a temp path, active-index wraparound, label collision handling, corrupt-file degradation (treat as empty pool, never crash the transport).
3. **`token-refresh.ts`** — refresh helper with mocked `globalThis.fetch` (existing test convention).
   Tests: success maps `refresh_token`/`access_token`/`expires_in` (with skew); preserves the previous refresh token when the response omits rotation (restoring the old `mergeRefreshedCredentials` hardening for pooled accounts); network/JSON failures throw typed errors.
4. **`rotating-transport.ts`** — the core.
   Tests with a scripted fake delegate:
   a. pool empty → delegate called once with original options, events pass through untouched;
   b. pool active → `options.apiKey` replaced with pooled access token;
   c. expired pooled token → refresh called and persisted before delegate;
   d. limit error before content → delegate re-invoked with next account's token, second stream's events forwarded, error event of the first attempt suppressed;
   e. limit error **after** a content event → no retry, events forwarded as-is;
   f. all accounts limited → original error event forwarded after one full cycle;
   g. non-limit error → no retry;
   h. non-OAuth apiKey → full passthrough.
5. **Command surface** — `accounts` list/add/switch/remove handlers plus diagnostics extension.
   Tests: add snapshots via a stubbed `readStoredCredential`; list masks secrets; switch/remove update the pool file.
6. **Wiring in `index.ts`** — compose the transports, register the command.
   Extend `test/index-registration.test.ts` for the new registration shape.
7. **Docs** — README feature section, AGENTS.md architecture/local-files updates, this plan's close-out notes.
8. **Live repro** (mandatory per AGENTS.md): `pi -p ... -e ./src/index.ts` under the real loader — verify pool-empty passthrough, `accounts add`, and a forced-rotation dry run (e.g. a debug env var `PI_ANTHROPIC_AUTH_FORCE_ROTATE=1` that treats the first request as limit-failed) before calling it done.

## Risks and Open Questions

1. **Retry stream fidelity.**
   The outer stream must faithfully forward `start`/`text_*`/`done`/`error` events and terminal semantics.
   Mitigation: only retry when zero events were forwarded (finding 4 makes this the common case for 429s); otherwise pass through.
2. **`createAssistantMessageEventStream` availability under both loader modes.**
   Verified exported from the pi-ai root in the installed dev copy; must be verified under Node `alias` and Bun `virtualModules` independently (per the "Verify Each Loader Mode" gotcha) during step 8.
   Fallback: resolve it through `@earendil-works/pi-ai/compat` alongside the transport in `host-transport.ts`.
3. **Refresh-token divergence between pool and `auth.json`.**
   If the pooled account is also the one in `auth.json`, Pi's own refresh may rotate the refresh token there while our pool copy goes stale (Anthropic refresh tokens may be single-use).
   Mitigation: on each request, if `readStoredCredential("anthropic")` shares a label-snapshot lineage with the active pool entry and is fresher (`expires` greater), sync it back into the pool before use.
   This needs a live test with a real account in step 8; if rotation invalidates the stale twin, document that pooled accounts should be distinct from the `/login anthropic` primary, or make `add` the moment the account "moves into" the pool.
4. **Retrying with a different account mid-conversation** changes billing attribution and may produce slightly different cache behavior (cache is account-scoped, so the retry pays cold-cache input costs once).
   Acceptable; note it in the README.
5. **Anthropic error-message drift.**
   Classification is string-based; keep signatures centralized (`limit-detection.ts`) and covered by fixtures so updating them is a one-file change.
6. **Concurrent background agents** (compaction, observers) share the transport and may race rotation.
   Mitigation: serialize pool mutations in-process through a promise chain (same pattern as pi-ai's `InMemoryCredentialStore`); cross-process races are out of scope for v1.

## Testing Plan Summary

1. Unit suites per new module as listed in the steps (vitest, `node:assert/strict`, mocked `fetch`, scripted fake delegates — matching existing conventions in `test/oauth-transport.test.ts`).
2. Registration-shape coverage in `test/index-registration.test.ts`.
3. Live `pi` CLI repro under both loader modes before completion, including the forced-rotation debug switch.
