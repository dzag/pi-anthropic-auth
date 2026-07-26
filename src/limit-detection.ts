/**
 * Classification of an Anthropic error, used to decide whether rotating to a
 * different account could plausibly help.
 *
 * - `usage-limit`: the *account* is out of quota (per-account rate limit or
 *   Claude Pro/Max usage window exhausted).  Rotating to another account is
 *   the correct response.
 * - `auth`: the credential itself is rejected (401 / invalid_grant).  Rotating
 *   is not appropriate: the pooled refresh token is dead and needs a fresh
 *   `/login anthropic`.
 * - `other`: everything else — including 529 `overloaded_error` (an
 *   Anthropic-wide capacity signal, identical on every account) and the
 *   "extra usage" 400 that actually indicates a request-shaping problem.
 */
export type AnthropicErrorKind = "usage-limit" | "auth" | "other";

/**
 * Substrings that identify an account-scoped quota failure.
 *
 * Matched case-insensitively against the error message text the built-in
 * transport records in `AssistantMessage.errorMessage` (which embeds the HTTP
 * status and the Anthropic error JSON).
 *
 * Kept centralized because Anthropic's wording drifts; updating a signature
 * should be a one-file change (see the "Isolate Compatibility Logic"
 * principle in AGENTS.md).
 */
const USAGE_LIMIT_SIGNATURES: readonly string[] = [
  "rate_limit_error",
  "usage limit reached",
  "usage limit has been reached",
  "exceeded your account's rate limit",
  "quota exceeded",
];

/**
 * Substrings that identify a rejected credential.
 *
 * Checked before the usage-limit signatures so an auth failure is never
 * mistaken for a quota failure.
 */
const AUTH_SIGNATURES: readonly string[] = [
  "authentication_error",
  "invalid_grant",
  "oauth token has expired",
  "invalid bearer token",
];

/**
 * Substrings that must never be treated as a usage limit even though they
 * contain limit-adjacent wording.
 *
 * `overloaded_error` is Anthropic-wide, so rotating burns through the whole
 * pool for nothing.  The "extra usage" 400 is the misleading response
 * Anthropic returns for third-party-app-shaped OAuth requests — a shaping bug
 * on our side, not a quota problem (see AGENTS.md "Gap Identified So Far").
 */
const NEVER_ROTATE_SIGNATURES: readonly string[] = [
  "overloaded_error",
  "out of extra usage",
  "extra usage",
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Classifies an Anthropic failure message.
 *
 * @param errorMessage - the message recorded by the built-in transport, or
 *   `undefined` when no message was captured.
 * @returns the error kind; `other` for unknown, empty, or missing messages so
 *   an unrecognized failure never triggers rotation.
 */
export function classifyAnthropicError(
  errorMessage: string | undefined,
): AnthropicErrorKind {
  if (!errorMessage) {
    return "other";
  }

  const text = errorMessage.toLowerCase();

  if (containsAny(text, NEVER_ROTATE_SIGNATURES)) {
    return "other";
  }
  if (containsAny(text, AUTH_SIGNATURES)) {
    return "auth";
  }
  if (containsAny(text, USAGE_LIMIT_SIGNATURES)) {
    return "usage-limit";
  }
  if (/\b429\b/.test(text)) {
    return "usage-limit";
  }
  if (/\b401\b/.test(text)) {
    return "auth";
  }

  return "other";
}

/**
 * Convenience predicate: should this failure trigger account rotation?
 */
export function isAccountUsageLimitError(
  errorMessage: string | undefined,
): boolean {
  return classifyAnthropicError(errorMessage) === "usage-limit";
}
