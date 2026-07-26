import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import {
  AccountStore,
  normalizePool,
  type PooledAccount,
} from "#src/account-store";

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
  const dir = mkdtempSync(join(tmpdir(), "pi-anthropic-accounts-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return new AccountStore(join(dir, "anthropic-accounts.json"));
}

test("a missing pool file reads as an empty pool", () => {
  const store = createStore();

  assert.equal(store.size(), 0);
  assert.equal(store.activeAccount(), undefined);
});

test("added accounts round-trip through the pool file", async () => {
  const store = createStore();

  await store.add(account("work"));
  await store.add(account("personal"));

  const reread = new AccountStore(store.filePath);
  assert.equal(reread.size(), 2);
  assert.equal(reread.activeAccount()?.label, "work");
});

test("adding a duplicate label replaces the existing entry", async () => {
  const store = createStore();

  await store.add(account("work", { access: "sk-ant-oat01-old" }));
  await store.add(account("work", { access: "sk-ant-oat01-new" }));

  assert.equal(store.size(), 1);
  assert.equal(store.activeAccount()?.access, "sk-ant-oat01-new");
});

test("rotateNext wraps around and marks the account it leaves as limited", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));

  const second = await store.rotateNext(1000);
  assert.equal(second?.label, "b");
  assert.equal(store.read().accounts[0]?.limitedAt, 1000);

  const wrapped = await store.rotateNext(2000);
  assert.equal(wrapped?.label, "a");
  assert.equal(store.read().accounts[1]?.limitedAt, 2000);
});

test("rotateNext is a no-op with fewer than two accounts", async () => {
  const store = createStore();
  await store.add(account("only"));

  assert.equal(await store.rotateNext(), undefined);
  assert.equal(store.activeAccount()?.label, "only");
});

test("switchTo selects by label and ignores unknown labels", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));

  await store.switchTo("b");
  assert.equal(store.activeAccount()?.label, "b");

  await store.switchTo("nope");
  assert.equal(store.activeAccount()?.label, "b");
});

test("remove keeps the active account stable when a different entry goes away", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  await store.add(account("c"));
  await store.switchTo("c");

  await store.remove("a");

  assert.equal(store.size(), 2);
  assert.equal(store.activeAccount()?.label, "c");
});

test("remove falls back to the first account when the active one is removed", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  await store.switchTo("b");

  await store.remove("b");

  assert.equal(store.activeAccount()?.label, "a");
});

test("updateTokens replaces credentials for one label only", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));

  await store.updateTokens("b", {
    access: "sk-ant-oat01-fresh",
    refresh: "refresh-fresh",
    expires: 99,
  });

  const pool = store.read();
  assert.equal(pool.accounts[0]?.access, "sk-ant-oat01-a");
  assert.equal(pool.accounts[1]?.access, "sk-ant-oat01-fresh");
  assert.equal(pool.accounts[1]?.expires, 99);
});

test("a corrupt pool file degrades to an empty pool instead of throwing", () => {
  const store = createStore();
  writeFileSync(store.filePath, "{ not json");

  assert.equal(store.size(), 0);
});

test("normalizePool drops malformed entries and clamps activeIndex", () => {
  const pool = normalizePool({
    version: 1,
    activeIndex: 17,
    accounts: [account("good"), { label: "bad", access: "x" }, "nonsense"],
  });

  assert.equal(pool.accounts.length, 1);
  assert.equal(pool.accounts[0]?.label, "good");
  assert.equal(pool.activeIndex, 0);
});

test("concurrent writes are serialized rather than lost", async () => {
  const store = createStore();

  await Promise.all([
    store.add(account("a")),
    store.add(account("b")),
    store.add(account("c")),
  ]);

  assert.equal(store.size(), 3);
});
