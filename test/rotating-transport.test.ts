import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { onTestFinished, test } from "vitest";
import { AccountStore, type PooledAccount } from "#src/account-store";
import {
  createRotatingStreamSimple,
  forcedRotationAttempts,
} from "#src/rotating-transport";

const OAUTH_TOKEN = "sk-ant-oat01-resolved-by-pi";
const API_KEY = "sk-ant-api03-example-key";

const MODEL = {
  id: "claude-haiku-4-5",
  api: "anthropic-messages",
  provider: "anthropic",
} as unknown as Model<Api>;

const CONTEXT = { messages: [] } as unknown as Context;

const LIMIT_MESSAGE =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}';

function createStream(): AssistantMessageEventStream {
  return createAssistantMessageEventStream();
}

function contentEvent(text: string): AssistantMessageEvent {
  return { type: "text_start", contentIndex: 0, partial: { text } } as unknown as AssistantMessageEvent;
}

function doneEvent(): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: {} } as unknown as AssistantMessageEvent;
}

function errorEvent(message: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: { errorMessage: message },
  } as unknown as AssistantMessageEvent;
}

type Attempt = { apiKey?: string };

/** Delegate that replays a scripted event list per attempt. */
function scriptedDelegate(scripts: AssistantMessageEvent[][]) {
  const attempts: Attempt[] = [];
  const delegate = (
    _model: Model<Api>,
    _context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const script = scripts[attempts.length] ?? [doneEvent()];
    attempts.push({ apiKey: options?.apiKey });
    const stream = createStream();
    // Deliver asynchronously so the consumer's iteration is exercised.
    setTimeout(() => {
      for (const event of script) stream.push(event);
      stream.end();
    }, 0);
    return stream;
  };
  return { delegate, attempts };
}

function account(label: string, overrides: Partial<PooledAccount> = {}) {
  return {
    label,
    access: `sk-ant-oat01-${label}`,
    refresh: `refresh-${label}`,
    expires: Date.now() + 3_600_000,
    ...overrides,
  } satisfies PooledAccount;
}

function createStore(): AccountStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-rotating-transport-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return new AccountStore(join(dir, "anthropic-accounts.json"));
}

async function collect(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("passes through untouched when the pool is empty", async () => {
  const store = createStore();
  const { delegate, attempts } = scriptedDelegate([[doneEvent()]]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.apiKey, OAUTH_TOKEN);
});

test("passes through untouched for API-key requests even with a populated pool", async () => {
  const store = createStore();
  await store.add(account("work"));
  const { delegate, attempts } = scriptedDelegate([[doneEvent()]]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  await collect(wrapped(MODEL, CONTEXT, { apiKey: API_KEY }));

  assert.equal(attempts[0]?.apiKey, API_KEY);
});

test("substitutes the active pooled account's access token", async () => {
  const store = createStore();
  await store.add(account("work"));
  const { delegate, attempts } = scriptedDelegate([[doneEvent()]]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts[0]?.apiKey, "sk-ant-oat01-work");
});

test("refreshes an expired pooled token before the request and persists it", async () => {
  const store = createStore();
  await store.add(account("work", { expires: 500 }));
  const { delegate, attempts } = scriptedDelegate([[doneEvent()]]);
  let refreshCalls = 0;
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
    now: () => 1000,
    refresh: (refreshToken) => {
      refreshCalls++;
      assert.equal(refreshToken, "refresh-work");
      return Promise.resolve({
        access: "sk-ant-oat01-refreshed",
        refresh: "refresh-rotated",
        expires: 900_000,
      });
    },
  });

  await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(refreshCalls, 1);
  assert.equal(attempts[0]?.apiKey, "sk-ant-oat01-refreshed");
  assert.equal(store.activeAccount()?.refresh, "refresh-rotated");
});

test("rotates and retries on a usage-limit error before any content", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const { delegate, attempts } = scriptedDelegate([
    [errorEvent(LIMIT_MESSAGE)],
    [contentEvent("hello"), doneEvent()],
  ]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.apiKey, "sk-ant-oat01-a");
  assert.equal(attempts[1]?.apiKey, "sk-ant-oat01-b");
  // The first attempt's limit error is suppressed; the retry's events surface.
  assert.deepEqual(
    events.map((event) => event.type),
    ["text_start", "done"],
  );
  assert.equal(store.activeAccount()?.label, "b");
  assert.ok(store.read().accounts[0]?.limitedAt);
});

test("does not retry once content has been forwarded", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const { delegate, attempts } = scriptedDelegate([
    [contentEvent("partial"), errorEvent(LIMIT_MESSAGE)],
  ]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["text_start", "error"],
  );
});

test("forwards the original error after one full cycle through the pool", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const { delegate, attempts } = scriptedDelegate([
    [errorEvent(LIMIT_MESSAGE)],
    [errorEvent(LIMIT_MESSAGE)],
    [errorEvent(LIMIT_MESSAGE)],
  ]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 2, "one attempt per pooled account, no more");
  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
});

test("does not rotate on a non-limit error", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const { delegate, attempts } = scriptedDelegate([
    [errorEvent('529 {"error":{"type":"overloaded_error"}}')],
  ]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(store.activeAccount()?.label, "a");
});

test("does not rotate with a single pooled account", async () => {
  const store = createStore();
  await store.add(account("only"));
  const { delegate, attempts } = scriptedDelegate([[errorEvent(LIMIT_MESSAGE)]]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts.length, 1);
  assert.equal(events[0]?.type, "error");
});

test("converts a thrown delegate failure into a single error event", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const wrapped = createRotatingStreamSimple({
    delegate: () => {
      throw new Error("transport exploded");
    },
    createStream,
    store,
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
});

test("a failed refresh still attempts the request with the stale token", async () => {
  const store = createStore();
  await store.add(account("work", { expires: 0 }));
  const { delegate, attempts } = scriptedDelegate([[doneEvent()]]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
    refresh: () => Promise.reject(new Error("invalid_grant")),
  });

  await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  assert.equal(attempts[0]?.apiKey, "sk-ant-oat01-work");
});

test("forcedRotationAttempts parses the debug switch", () => {
  assert.equal(forcedRotationAttempts(undefined), undefined);
  assert.equal(forcedRotationAttempts(""), undefined);
  assert.equal(forcedRotationAttempts("0"), undefined);
  assert.equal(forcedRotationAttempts("nope"), undefined);

  const one = forcedRotationAttempts("1");
  assert.ok(one);
  assert.equal(one(0), true);
  assert.equal(one(1), false);
});

test("the forced-rotation switch drives a real rotation without network calls", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  // The forced attempt never reaches the delegate, so the first script entry
  // is consumed by the retry.
  const { delegate, attempts } = scriptedDelegate([
    [contentEvent("from second account"), doneEvent()],
  ]);
  const wrapped = createRotatingStreamSimple({
    delegate,
    createStream,
    store,
    forceLimitOnAttempt: forcedRotationAttempts("1"),
  });

  const events = await collect(wrapped(MODEL, CONTEXT, { apiKey: OAUTH_TOKEN }));

  // Attempt 0 was forced to fail without reaching the delegate.
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.apiKey, "sk-ant-oat01-b");
  assert.deepEqual(
    events.map((event) => event.type),
    ["text_start", "done"],
  );
});
