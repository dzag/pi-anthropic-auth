import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AccountStore, type PooledAccount } from "./account-store";
import { debugLog } from "./debug";
import type { EventStreamFactory } from "./host-transport";
import { isAccountUsageLimitError } from "./limit-detection";
import { isAnthropicOAuthToken } from "./oauth-transport";
import { isExpired, refreshAccessToken } from "./token-refresh";

/**
 * A `streamSimple`-shaped transport, wide enough for the API registry (which
 * registers per `Api`, not per model).
 */
export type StreamSimpleLike = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Injectable collaborators, so the transport is testable without I/O. */
export interface RotatingTransportDeps {
  /** The wrapped transport — in production, the OAuth-shaping wrapper. */
  delegate: StreamSimpleLike;
  /** Factory for the outer stream we own (see `resolveEventStreamFactory`). */
  createStream: EventStreamFactory;
  /** Account pool. */
  store: AccountStore;
  /** Token refresh; injectable to avoid network calls in tests. */
  refresh?: typeof refreshAccessToken;
  /** Clock, injectable for expiry tests. */
  now?: () => number;
  /**
   * Optional escape hatch used by the live-repro debug switch: when it returns
   * true for an attempt, that attempt is treated as usage-limited without
   * calling Anthropic.  Enabled via `PI_ANTHROPIC_AUTH_FORCE_ROTATE`.
   */
  forceLimitOnAttempt?: (attempt: number) => boolean;
}

/**
 * Events that indicate the response has begun producing observable content.
 *
 * Once one of these has been forwarded to the caller, a retry would duplicate
 * or interleave content, so rotation is abandoned for that request.  In
 * practice an HTTP 429 fails inside `client.messages.create(...)` *before* the
 * built-in transport pushes `start`, so limit failures reliably arrive with
 * nothing forwarded yet.
 */
function isContentEvent(event: AssistantMessageEvent): boolean {
  return event.type !== "error";
}

function errorMessageOf(event: AssistantMessageEvent): string | undefined {
  if (event.type !== "error") return undefined;
  const error = (event as { error?: Partial<AssistantMessage> }).error;
  return typeof error?.errorMessage === "string"
    ? error.errorMessage
    : undefined;
}

/**
 * Wraps a `streamSimple` transport with multi-account failover.
 *
 * Two behaviors, both gated on an Anthropic OAuth token *and* a non-empty
 * account pool — with an empty pool this is a transparent passthrough, so the
 * default install behaves exactly as before:
 *
 * 1. **Account selection.**  `options.apiKey` is replaced with the active
 *    pooled account's access token, refreshed locally first if expired.  We
 *    override the key rather than writing Pi's `auth.json`, whose writable
 *    `AuthStorage` is not part of the coding-agent public API.
 * 2. **Failover.**  When an attempt ends in an account-scoped usage-limit error
 *    and no content event has been forwarded yet, the pool rotates to the next
 *    account and the delegate is re-invoked.  After one full cycle through the
 *    pool the original error is forwarded, so an exhausted pool surfaces the
 *    real Anthropic failure instead of looping.
 *
 * Non-limit errors (including 529 overload and the misleading "extra usage"
 * 400) never rotate — see `src/limit-detection.ts`.
 */
export function createRotatingStreamSimple(
  deps: RotatingTransportDeps,
): StreamSimpleLike {
  const {
    delegate,
    createStream,
    store,
    refresh = refreshAccessToken,
    now = Date.now,
    forceLimitOnAttempt,
  } = deps;

  return (model, context, options) => {
    const isOAuth = isAnthropicOAuthToken(options?.apiKey);
    const poolSize = store.size();
    debugLog("rotation.gate", {
      isOAuth,
      poolSize,
      forcedRotationEnabled: forceLimitOnAttempt !== undefined,
      poolFile: store.filePath,
    });

    // Passthrough: not OAuth, or rotation not configured.
    if (!isOAuth || poolSize === 0) {
      return delegate(model, context, options);
    }

    const outer = createStream();
    void runWithFailover(outer);
    return outer;

    async function runWithFailover(
      out: AssistantMessageEventStream,
    ): Promise<void> {
      // One attempt per pooled account: the pool is fully exhausted after this
      // many usage-limit failures.
      const maxAttempts = store.size();
      let firstLimitEvent: AssistantMessageEvent | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const account = await resolveActiveAccount();
        if (!account) break;

        const attemptOptions: SimpleStreamOptions = {
          ...options,
          apiKey: account.access,
        };

        let forwardedContent = false;
        let limitEvent: AssistantMessageEvent | undefined;

        try {
          if (forceLimitOnAttempt?.(attempt)) {
            limitEvent = syntheticLimitEvent(model);
          } else {
            for await (const event of delegate(
              model,
              context,
              attemptOptions,
            )) {
              if (
                !forwardedContent &&
                event.type === "error" &&
                isAccountUsageLimitError(errorMessageOf(event))
              ) {
                limitEvent = event;
                break;
              }
              if (isContentEvent(event)) forwardedContent = true;
              out.push(event);
            }
          }
        } catch (error) {
          // The built-in transport reports failures as events, but a wrapper or
          // future host could throw; treat that as a non-rotatable failure.
          out.push(errorEvent(model, formatError(error)));
          out.end();
          return;
        }

        if (!limitEvent) {
          out.end();
          return;
        }

        firstLimitEvent ??= limitEvent;
        debugLog("rotation.usage-limit", {
          attempt,
          account: account.label,
          message: errorMessageOf(limitEvent),
        });

        const next = await store.rotateNext(now());
        if (!next) break;
      }

      // Pool exhausted (or nothing to rotate to): surface the real failure.
      out.push(
        firstLimitEvent ??
          errorEvent(
            model,
            "All Anthropic accounts in the rotation pool are usage-limited.",
          ),
      );
      out.end();
    }

    /**
     * Returns the active account with a usable access token, refreshing it
     * locally when expired.  A refresh failure leaves the account as-is and
     * returns it anyway, so the request still reaches Anthropic and produces a
     * real, reportable error rather than a silent local failure.
     */
    async function resolveActiveAccount(): Promise<PooledAccount | undefined> {
      const account = store.activeAccount();
      if (!account) return undefined;
      if (!isExpired(account.expires, now())) return account;

      try {
        const tokens = await refresh(account.refresh, now());
        await store.updateTokens(account.label, tokens);
        debugLog("rotation.refreshed", { account: account.label });
        return { ...account, ...tokens };
      } catch (error) {
        debugLog("rotation.refresh-failed", {
          account: account.label,
          error: formatError(error),
        });
        return account;
      }
    }
  };
}

/**
 * Builds a well-formed `error` event for a failure we synthesize ourselves.
 *
 * The `error` payload must be a *complete* `AssistantMessage`, not just an
 * `errorMessage`: Pi's consumers read `content`, `usage`, and the model fields
 * off it unconditionally (a bare `{ errorMessage }` crashes the caller with
 * "Cannot read properties of undefined (reading 'filter')").  The field set
 * mirrors the initial `output` object the built-in Anthropic transport creates.
 */
function errorEvent(
  model: Model<Api>,
  message: string,
): AssistantMessageEvent {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error };
}

function syntheticLimitEvent(model: Model<Api>): AssistantMessageEvent {
  return errorEvent(
    model,
    'PI_ANTHROPIC_AUTH_FORCE_ROTATE: simulated 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

/**
 * Reads the forced-rotation debug switch.
 *
 * `PI_ANTHROPIC_AUTH_FORCE_ROTATE=1` fails the first attempt; a larger integer
 * fails that many attempts, letting a live repro exercise a full pool cycle
 * without waiting on a real usage limit.
 */
export function forcedRotationAttempts(
  value: string | undefined = process.env.PI_ANTHROPIC_AUTH_FORCE_ROTATE,
): ((attempt: number) => boolean) | undefined {
  if (!value) return undefined;
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count <= 0) return undefined;
  return (attempt) => attempt < count;
}
