# pi-anthropic-auth

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-anthropic-auth?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-anthropic-auth/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-anthropic-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

A [Pi](https://pi.mariozechner.at/) extension that improves compatibility with Anthropic Claude Pro/Max OAuth (i.e., your Claude subscription) while preserving Pi's normal Anthropic behavior.

## What It Does

Pi works great with Anthropic API keys out of the box.
This extension fills in the gaps for users who want to use their **Claude Pro or Max subscription** via OAuth instead.

It keeps everything you'd expect — the built-in `anthropic` provider, the full model list, API-key behavior, and the native `/login anthropic` flow — and layers on the compatibility fixes needed to make OAuth subscriptions work reliably.

Requests to non-Anthropic providers and plain API-key Anthropic requests pass through completely untouched — the extension only activates when it detects an Anthropic OAuth access token (`sk-ant-oat`).

Shaping runs in a thin transport wrapper around Pi's own Anthropic transport, so it applies to every OAuth call path — the interactive loop, compaction, and any background-agent work — not just the main turn.
See [docs/architecture.md](docs/architecture.md) for how this works.

## Install

```bash
pi install npm:@gotgenes/pi-anthropic-auth
```

To try it without permanently installing:

```bash
pi -e npm:@gotgenes/pi-anthropic-auth
```

## Usage

1. Run `/login anthropic` as usual — Pi's native Anthropic login flow is preserved.
2. Select a Claude Pro/Max model and start chatting. The extension handles compatibility transparently.
3. API-key behavior is unaffected; the extension's changes apply only to OAuth sessions.

## Account Rotation (Multiple Claude Accounts)

If you have more than one Claude Pro/Max subscription, the extension can pool them and automatically fail over when one hits its usage limit.
The request that hit the limit is retried on the next account, so the failover is transparent.

Rotation is **opt-in**: with an empty pool the feature is a complete passthrough and nothing changes.

### Enabling it

Accounts are added by snapshotting Pi's own login result, so there is no separate login flow to learn:

```text
/login anthropic                        # log in as your first account
/anthropic-auth:accounts add work
/login anthropic                        # log in as your second account
/anthropic-auth:accounts add personal
```

### Managing the pool

```text
/anthropic-auth:accounts list           # show pooled accounts (never prints tokens)
/anthropic-auth:accounts switch work    # manually change the active account
/anthropic-auth:accounts remove work    # drop an account
```

The pool lives in `~/.pi/agent/anthropic-accounts.json` (mode `0600`), alongside Pi's own `auth.json`.
Pooled access tokens are refreshed automatically as they expire.

### What triggers a rotation

Only **account-scoped** quota failures rotate — HTTP 429 / `rate_limit_error` / "usage limit reached".
Deliberately excluded:

1. `529 overloaded_error` — an Anthropic-wide capacity signal, identical on every account.
2. The "out of extra usage" 400 — actually a request-shaping symptom, not a quota problem.
3. `401` / `invalid_grant` — the credential is bad; run `/login anthropic` again for that account.

After one full cycle through the pool without success, the original Anthropic error is surfaced rather than retried further.
Rotation is also skipped once a response has begun streaming content, so a retry can never duplicate partial output.

Note: each account bills separately and caches separately, so a failover pays a cold prompt cache once.

## Troubleshooting

### Verify the extension is loaded

Run `/anthropic-auth:status` in Pi to print a diagnostics report:

```text
pi-anthropic-auth diagnostics
  version: 0.6.5
  module:  /root/.pi/agent/.../src/index.ts
  built-in Anthropic transport: resolved
  account rotation pool: 2 account(s), active: work
  pool file: /root/.pi/agent/anthropic-accounts.json
```

The `module` line shows which copy of the extension loaded.
If the command is not found, the extension is not loaded at all.

### `ANTHROPIC_API_KEY` is ignored when OAuth credentials exist

Pi's auth resolver gives stored credentials priority over environment variables.
If you have previously run `/login anthropic` and credentials are stored in `~/.pi/agent/auth.json`, Pi uses the stored OAuth token on every request — even when `ANTHROPIC_API_KEY` is also set.

To use the API key instead, run `/logout anthropic` inside Pi to remove the stored credentials, or delete `auth.json` before starting the session.

### Docker: extension missing after volume mount

If you install the extension at image build time with `RUN pi install npm:@gotgenes/pi-anthropic-auth` and then mount a persistent volume over `~/.pi/agent` at runtime, Docker may mask the build-time install.
Docker seeds a named volume with the image directory only on its first creation.
If the volume already exists from a previous image, the extension directory inside it may be empty or out of date.

To fix this, either:

- Remove the volume and let Docker re-seed it: `docker volume rm <volume-name>`.
- Or install the extension at container startup rather than at image build time, after the volume is mounted.

## Development

### Requirements

- `pnpm`
- a local `pi` installation
- Anthropic OAuth credentials configured through Pi

### Commands

```bash
pnpm install      # install dependencies
pnpm run check    # typecheck
pnpm test         # run tests
pnpm run build    # compile
```

### Load a Local Build

```bash
pi -e /absolute/path/to/pi-anthropic-auth/dist/index.js
```

### Debug Logging

Set `PI_ANTHROPIC_AUTH_DEBUG` to enable structured debug logs from the OAuth shaping layer.

Modes:

- `PI_ANTHROPIC_AUTH_DEBUG=all` — log all Anthropic OAuth shaping events
- `PI_ANTHROPIC_AUTH_DEBUG=tool-use` — log only requests that include `tool_use`

### Testing Account Rotation

Waiting for a real usage limit is impractical, so rotation has a forced-failure switch:

```bash
PI_ANTHROPIC_AUTH_FORCE_ROTATE=1 \
PI_ANTHROPIC_AUTH_DEBUG=all \
pi --model anthropic/claude-haiku-4-5 --no-session -p "hello"
```

`=1` treats the first attempt as usage-limited (so you should still get a normal answer, served by the second account); a larger number fails that many attempts, and a number at or above the pool size exercises the exhausted-pool path.

Example:

```bash
PI_ANTHROPIC_AUTH_DEBUG=tool-use \
pi \
  --model anthropic/claude-haiku-4-5 \
  --no-session \
  --tools read,grep,find,ls \
  -e /absolute/path/to/pi-anthropic-auth/src/index.ts \
  -p "How many lines are in @AGENTS.md ?"
```

## Similar Projects

- [opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth/) — Anthropic OAuth compatibility work for [OpenCode](https://opencode.ai/).
- [pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth) — a Pi extension that takes a fuller provider-override approach.

For notes on how this project compares to similar work, see [docs/comparison-to-similar-projects.md](docs/comparison-to-similar-projects.md).

## Acknowledgments

This project was inspired by [opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth/), which solved the same Anthropic OAuth compatibility problem for [OpenCode](https://opencode.ai/).

## License

MIT
