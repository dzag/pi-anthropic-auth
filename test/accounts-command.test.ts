import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { AccountStore, type PooledAccount } from "#src/account-store";
import {
  type AccountsCommandContext,
  createAccountsCommandHandler,
  formatPool,
  type StoredCredential,
} from "#src/accounts-command";

function createStore(): AccountStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-accounts-command-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return new AccountStore(join(dir, "anthropic-accounts.json"));
}

function account(label: string, overrides: Partial<PooledAccount> = {}) {
  return {
    label,
    access: `sk-ant-oat01-${label}`,
    refresh: `refresh-${label}`,
    expires: 1_700_000_000_000,
    ...overrides,
  } satisfies PooledAccount;
}

function createContext(): AccountsCommandContext & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    hasUI: true,
    ui: {
      notify(message) {
        messages.push(message);
      },
    },
  };
}

const OAUTH_CREDENTIAL: StoredCredential = {
  type: "oauth",
  access: "sk-ant-oat01-from-auth-json",
  refresh: "refresh-from-auth-json",
  expires: 1_800_000_000_000,
};

test("list reports an empty pool with enablement guidance", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => undefined);

  await handler("list", ctx);

  assert.match(ctx.messages[0] ?? "", /rotation is disabled/);
  assert.match(ctx.messages[0] ?? "", /\/login anthropic/);
});

test("no subcommand defaults to list", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => undefined);

  await handler("", ctx);

  assert.match(ctx.messages[0] ?? "", /rotation is disabled/);
});

test("add snapshots the stored Anthropic OAuth credential into the pool", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => OAUTH_CREDENTIAL);

  await handler("add work", ctx);

  const pooled = store.activeAccount();
  assert.ok(pooled);
  assert.equal(pooled.label, "work");
  assert.equal(pooled.access, "sk-ant-oat01-from-auth-json");
  assert.equal(pooled.refresh, "refresh-from-auth-json");
});

test("add refuses when no OAuth credential is stored", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => ({
    type: "api_key",
  }));

  await handler("add work", ctx);

  assert.equal(store.size(), 0);
  assert.match(ctx.messages[0] ?? "", /Run `\/login anthropic` first/);
});

test("add requires a label", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => OAUTH_CREDENTIAL);

  await handler("add", ctx);

  assert.equal(store.size(), 0);
  assert.match(ctx.messages[0] ?? "", /Usage/);
});

test("switch changes the active account and rejects unknown labels", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => OAUTH_CREDENTIAL);

  await handler("switch b", ctx);
  assert.equal(store.activeAccount()?.label, "b");

  await handler("switch ghost", ctx);
  assert.match(ctx.messages[1] ?? "", /No pooled account labelled "ghost"/);
});

test("remove drops an account and reports unknown labels", async () => {
  const store = createStore();
  await store.add(account("a"));
  await store.add(account("b"));
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => OAUTH_CREDENTIAL);

  await handler("remove a", ctx);
  assert.equal(store.size(), 1);

  await handler("remove ghost", ctx);
  assert.match(ctx.messages[1] ?? "", /No pooled account labelled "ghost"/);
});

test("an unknown subcommand reports usage", async () => {
  const store = createStore();
  const ctx = createContext();
  const handler = createAccountsCommandHandler(store, () => undefined);

  await handler("frobnicate", ctx);

  assert.match(ctx.messages[0] ?? "", /Usage: \/anthropic-auth:accounts/);
});

test("formatPool masks token material and marks the active account", () => {
  const pool = {
    version: 1 as const,
    activeIndex: 1,
    accounts: [account("a"), account("b", { limitedAt: 1_700_000_100_000 })],
  };

  const report = formatPool(pool, "/tmp/pool.json");

  assert.ok(!report.includes("sk-ant-oat01"));
  assert.ok(!report.includes("refresh-"));
  assert.match(report, /\* 1\. b/);
  assert.match(report, /limited at/);
});
