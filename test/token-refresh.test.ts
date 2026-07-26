import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { isExpired, refreshAccessToken } from "#src/token-refresh";

type FetchCall = { url: string; body: unknown };

function stubFetch(respond: () => Response | Promise<Response>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const body = init?.body;
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof body === "string" ? JSON.parse(body) : undefined,
    });
    return Promise.resolve(respond());
  };
  onTestFinished(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("isExpired compares against the stored skew-adjusted expiry", () => {
  assert.equal(isExpired(1000, 999), false);
  assert.equal(isExpired(1000, 1000), true);
  assert.equal(isExpired(1000, 5000), true);
});

test("refreshAccessToken posts a refresh_token grant to the Anthropic token endpoint", async () => {
  const { calls } = stubFetch(() =>
    jsonResponse({
      access_token: "sk-ant-oat01-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }),
  );

  const tokens = await refreshAccessToken("refresh-old", 1_000_000);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://platform.claude.com/v1/oauth/token");
  assert.deepEqual(calls[0]?.body, {
    grant_type: "refresh_token",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    refresh_token: "refresh-old",
  });
  assert.equal(tokens.access, "sk-ant-oat01-new");
  assert.equal(tokens.refresh, "refresh-new");
  // 1_000_000 + 3_600_000 - 300_000 skew
  assert.equal(tokens.expires, 4_300_000);
});

test("refreshAccessToken keeps the previous refresh token when the response omits rotation", async () => {
  stubFetch(() =>
    jsonResponse({ access_token: "sk-ant-oat01-new", expires_in: 3600 }),
  );

  const tokens = await refreshAccessToken("refresh-old");

  assert.equal(tokens.refresh, "refresh-old");
});

test("refreshAccessToken throws with context on a non-2xx response", async () => {
  stubFetch(() => jsonResponse({ error: "invalid_grant" }, 400));

  await assert.rejects(refreshAccessToken("dead-token"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /status=400/);
    assert.match(error.message, /invalid_grant/);
    return true;
  });
});

test("refreshAccessToken throws on invalid JSON", async () => {
  stubFetch(
    () => new Response("<html>gateway timeout</html>", { status: 200 }),
  );

  await assert.rejects(refreshAccessToken("refresh-old"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid JSON/);
    return true;
  });
});

test("refreshAccessToken throws when the payload has no access token", async () => {
  stubFetch(() => jsonResponse({ refresh_token: "refresh-new" }));

  await assert.rejects(refreshAccessToken("refresh-old"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no access token/);
    return true;
  });
});

test("refreshAccessToken wraps network failures", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  onTestFinished(() => {
    globalThis.fetch = original;
  });

  await assert.rejects(refreshAccessToken("refresh-old"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /request failed/);
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });
});
