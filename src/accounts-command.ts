import {
  type AccountPool,
  AccountStore,
  activeAccountOf,
} from "./account-store";
import {
  describeGitignoreResult,
  ensureGitIgnored,
  findRepoRoot,
} from "./gitignore-guard";
import { type PoolScope, projectPoolPathFor } from "./pool-location";

/**
 * Minimal shape of a stored Pi credential, as returned by the coding-agent's
 * `readStoredCredential`.
 *
 * Declared structurally so the command is testable with a plain fake and does
 * not depend on the Pi SDK at type level.
 */
export interface StoredCredential {
  type: string;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

/** Reads the credential Pi currently has stored for a provider. */
export type CredentialReader = (
  providerId: string,
) => StoredCredential | undefined;

/**
 * Narrow subset of `ExtensionCommandContext` the accounts handler uses.
 *
 * Mirrors `StatusCommandContext` in `src/diagnostics.ts` so both commands stay
 * SDK-free and trivially fakeable.
 */
export interface AccountsCommandContext {
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

const USAGE = [
  "Usage: /anthropic-auth:accounts <subcommand>",
  "  list                 show pooled accounts (no secrets)",
  "  add <label> [-l]     snapshot the current /login anthropic credential into the pool",
  "  switch <label>       make an account active",
  "  remove <label>       drop an account from the pool",
  "",
  "  -l, --local          write to this project's .pi/anthropic-accounts.json",
  "                       instead of the global pool (a project pool fully",
  "                       replaces the global one for this project)",
].join("\n");

/** Human-readable description of where a pool file came from. */
function describeScope(scope: PoolScope): string {
  switch (scope) {
    case "env":
      return "env override";
    case "project":
      return "project-local (overrides global)";
    default:
      return "global";
  }
}

/**
 * Renders the pool as a masked, human-readable listing.
 *
 * Never prints token material: only the label, active marker, expiry, and last
 * observed usage-limit time.
 */
export function formatPool(
  pool: AccountPool,
  poolPath: string,
  scope?: PoolScope,
): string {
  const location = scope
    ? `Pool file: ${poolPath} (${describeScope(scope)})`
    : `Pool file: ${poolPath}`;
  if (pool.accounts.length === 0) {
    return [
      "No Anthropic accounts pooled — rotation is disabled.",
      location,
      "",
      "To enable rotation: run `/login anthropic` for each account, then",
      "`/anthropic-auth:accounts add <label>` after each login.",
    ].join("\n");
  }

  const rows = pool.accounts.map((account, index) => {
    const marker = index === pool.activeIndex ? "*" : " ";
    const expiry = new Date(account.expires).toISOString();
    const limited = account.limitedAt
      ? `, limited at ${new Date(account.limitedAt).toISOString()}`
      : "";
    return `${marker} ${index}. ${account.label} (token expires ${expiry}${limited})`;
  });

  return [
    `Anthropic account pool (${pool.accounts.length}), * = active:`,
    ...rows,
    location,
  ].join("\n");
}

/**
 * Builds the `/anthropic-auth:accounts` command handler.
 *
 * `add` deliberately reuses Pi's own login flow instead of reimplementing it:
 * the user runs `/login anthropic` for an account, then `add <label>` snapshots
 * the resulting credential out of `auth.json` into the pool.  This keeps the
 * extension clear of the `oauth` registration override that caused Issue #43.
 */
export function createAccountsCommandHandler(
  store: AccountStore,
  readCredential: CredentialReader,
  deps: AccountsCommandDeps = {},
): (args: string, ctx: AccountsCommandContext) => Promise<void> {
  const {
    cwd = () => process.cwd(),
    createStore = (path) => new AccountStore(path, "project"),
    ensureIgnored = ensureGitIgnored,
  } = deps;

  return async (args, ctx) => {
    const { subcommand, target, local } = parseArgs(args);

    const report: Reporter = (message, isError = false) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, isError ? "error" : "info");
      } else if (isError) {
        console.error(message);
      } else {
        console.log(message);
      }
    };

    if (subcommand === "list") {
      report(formatPool(store.read(), store.filePath, store.scope));
      return;
    }

    const run = SUBCOMMANDS.get(subcommand);
    if (!run) {
      report(USAGE, true);
      return;
    }
    if (!target) {
      report(`Usage: /anthropic-auth:accounts ${subcommand} <label>`, true);
      return;
    }
    if (local && subcommand !== "add") {
      report(
        "--local applies only to `add`; other subcommands act on the pool currently in effect.",
        true,
      );
      return;
    }

    // `add --local` targets this project's pool, creating it if needed; every
    // other subcommand operates on whichever pool is currently authoritative.
    const targetStore = local
      ? createStore(projectPoolPathFor(findRepoRoot(cwd()) ?? cwd()))
      : store;

    await run({
      store: targetStore,
      readCredential,
      target,
      report,
      ensureIgnored: local ? ensureIgnored : undefined,
    });
  };
}

const LOCAL_FLAGS = new Set(["-l", "--local"]);

/** Parsed command line: subcommand, label, and whether `--local` was given. */
function parseArgs(args: string): {
  subcommand: string;
  target: string;
  local: boolean;
} {
  const words = args.trim().split(/\s+/).filter(Boolean);
  return {
    subcommand: words.at(0) ?? "list",
    target: words
      .slice(1)
      .filter((word) => !LOCAL_FLAGS.has(word))
      .join(" "),
    local: words.some((word) => LOCAL_FLAGS.has(word)),
  };
}

// A Map rather than an object literal so the lookup is honestly typed as
// possibly-missing (this repo does not enable `noUncheckedIndexedAccess`).
const SUBCOMMANDS = new Map<string, (input: SubcommandInput) => Promise<void>>([
  ["add", addAccount],
  ["switch", switchAccount],
  ["remove", removeAccount],
]);

/** Injectable collaborators, so the command is testable without touching git or cwd. */
export interface AccountsCommandDeps {
  /** Working directory used to locate the project root. */
  cwd?: () => string;
  /** Builds a store for an explicit path (used by `add --local`). */
  createStore?: (path: string) => AccountStore;
  /** Ensures a project-local pool file is git-ignored before secrets land. */
  ensureIgnored?: typeof ensureGitIgnored;
}

/** Emits a message to the user, as an error when `isError` is set. */
type Reporter = (message: string, isError?: boolean) => void;

/** Everything a subcommand needs; `target` is guaranteed non-empty. */
interface SubcommandInput {
  store: AccountStore;
  readCredential: CredentialReader;
  target: string;
  report: Reporter;
  /** Set only for `add --local`, where a new project pool may be created. */
  ensureIgnored?: typeof ensureGitIgnored;
}

/**
 * Extracts OAuth token fields from a stored credential.
 *
 * @returns the token triple, or `undefined` when the credential is absent, not
 *   an OAuth credential, or missing required fields.
 */
function readOAuthTokens(
  credential: StoredCredential | undefined,
): { access: string; refresh: string; expires: number } | undefined {
  if (credential?.type !== "oauth") return undefined;
  const { access, refresh, expires } = credential;
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    typeof expires !== "number"
  ) {
    return undefined;
  }
  return { access, refresh, expires };
}

async function addAccount({
  store,
  readCredential,
  target,
  report,
  ensureIgnored,
}: SubcommandInput): Promise<void> {
  const credential = readCredential("anthropic");
  if (credential?.type !== "oauth") {
    report(
      "No Anthropic OAuth credential is stored. Run `/login anthropic` first, then re-run this command.",
      true,
    );
    return;
  }

  const tokens = readOAuthTokens(credential);
  if (!tokens) {
    report(
      "The stored Anthropic credential is missing OAuth token fields; cannot pool it.",
      true,
    );
    return;
  }

  // Ignore the pool before writing it, so refresh tokens never exist in a
  // tracked file even momentarily.
  const ignoreNote = ensureIgnored
    ? describeGitignoreResult(ensureIgnored(store.filePath), store.filePath)
    : undefined;

  await store.add({ label: target, ...tokens });

  report(
    [
      `Pooled the current Anthropic credential as "${target}".`,
      ...(ignoreNote ? [ignoreNote] : []),
      formatPool(store.read(), store.filePath, store.scope),
    ].join("\n"),
  );
}

async function switchAccount({
  store,
  target,
  report,
}: SubcommandInput): Promise<void> {
  const pool = await store.switchTo(target);
  if (activeAccountOf(pool)?.label !== target) {
    report(`No pooled account labelled "${target}".`, true);
    return;
  }
  report(`Active Anthropic account is now "${target}".`);
}

async function removeAccount({
  store,
  target,
  report,
}: SubcommandInput): Promise<void> {
  const before = store.size();
  await store.remove(target);
  if (store.size() === before) {
    report(`No pooled account labelled "${target}".`, true);
    return;
  }
  report(
    `Removed "${target}".\n${formatPool(store.read(), store.filePath, store.scope)}`,
  );
}
