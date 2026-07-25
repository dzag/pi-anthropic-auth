/**
 * Local Anthropic OAuth token refresh for **pooled** accounts.
 *
 * Pi's built-in `anthropicOAuth.refresh` only ever runs for the single
 * credential stored in `auth.json`, and pi-ai >=0.80.8 made the underlying
 * `refreshAnthropicToken` module-private (Issue #43).  Accounts held in our
 * rotation pool therefore have to refresh themselves.
 *
 * The endpoint, client id, request body, and expiry skew mirror upstream
 * (`@earendil-works/pi-ai/dist/auth/oauth/anthropic.js`) exactly, so a pooled
 * refresh is indistinguishable from Pi's own.  Keep this file in sync if
 * upstream changes those values.
 */

/** Anthropic OAuth token endpoint (matches upstream `TOKEN_URL`). */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Public Claude Code OAuth client id (matches upstream `CLIENT_ID`).
 *
 * Base64-encoded upstream; decoded literally here so it is greppable.
 */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Refresh this long before nominal expiry, as upstream does. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 30_000;

/** Tokens produced by a successful refresh. */
export interface RefreshedTokens {
  access: string;
  refresh: string;
  /** Epoch millis, already reduced by the upstream 5-minute skew. */
  expires: number;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * True when an access token is expired or close enough to expiry that it
 * should be refreshed before use.
 *
 * `expires` is already skew-adjusted when written by `refreshAccessToken`, so
 * this is a plain comparison.
 */
export function isExpired(expires: number, now: number = Date.now()): boolean {
  return expires <= now;
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * @param refreshToken - the pooled account's current refresh token.  It is also
 *   the no-rotation fallback: Anthropic sometimes omits `refresh_token` from the
 *   response, and dropping it would strand the account until a manual
 *   `/login anthropic`.  Preserving it restores the hardening the old
 *   `mergeRefreshedCredentials` provided before Issue #43 removed it.
 * @param now - injectable clock for tests.
 * @returns the refreshed tokens.
 * @throws when the request fails, the response is not JSON, or the payload has
 *   no access token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  now: number = Date.now(),
): Promise<RefreshedTokens> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatError(error)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic token refresh failed. status=${response.status}; url=${TOKEN_URL}; body=${body}`,
    );
  }

  let data: TokenResponseBody;
  try {
    data = JSON.parse(body) as TokenResponseBody;
  } catch (error) {
    throw new Error(
      `Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${body}; details=${formatError(error)}`,
    );
  }

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error(
      `Anthropic token refresh returned no access token. url=${TOKEN_URL}; body=${body}`,
    );
  }

  const expiresIn =
    typeof data.expires_in === "number" ? data.expires_in : 3600;

  return {
    access: data.access_token,
    // Preserve the existing refresh token when the response omits a rotated
    // one, so a partial response cannot strand the pooled account.
    refresh:
      typeof data.refresh_token === "string" && data.refresh_token.length > 0
        ? data.refresh_token
        : refreshToken,
    expires: now + expiresIn * 1000 - EXPIRY_SKEW_MS,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
