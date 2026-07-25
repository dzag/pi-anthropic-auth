import {
  type AccountPool,
  type AccountStore,
  activeAccountOf,
} from "./account-store";

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
  "  add <label>          snapshot the current /login anthropic credential into the pool",
  "  switch <label>       make an account active",
  "  remove <label>       drop an account from the pool",
].join("\n");

/**
 * Renders the pool as a masked, human-readable listing.
 *
 * Never prints token material: only the label, active marker, expiry, and last
 * observed usage-limit time.
 */
export function formatPool(pool: AccountPool, poolPath: string): string {
  if (pool.accounts.length === 0) {
    return [
      "No Anthropic accounts pooled — rotation is disabled.",
      `Pool file: ${poolPath}`,
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
    `Pool file: ${poolPath}`,
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
): (args: string, ctx: AccountsCommandContext) => Promise<void> {
  return async (args, ctx) => {
    const words = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = words.at(0) ?? "list";
    const target = words.slice(1).join(" ");

    const report = (message: string, isError = false): void => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, isError ? "error" : "info");
      } else if (isError) {
        console.error(message);
      } else {
        console.log(message);
      }
    };

    switch (subcommand) {
      case "list":
        report(formatPool(store.read(), store.filePath));
        return;

      case "add": {
        if (!target) {
          report("Usage: /anthropic-auth:accounts add <label>", true);
          return;
        }
        const credential = readCredential("anthropic");
        if (credential?.type !== "oauth") {
          report(
            "No Anthropic OAuth credential is stored. Run `/login anthropic` first, then re-run this command.",
            true,
          );
          return;
        }
        if (
          typeof credential.access !== "string" ||
          typeof credential.refresh !== "string" ||
          typeof credential.expires !== "number"
        ) {
          report(
            "The stored Anthropic credential is missing OAuth token fields; cannot pool it.",
            true,
          );
          return;
        }
        await store.add({
          label: target,
          access: credential.access,
          refresh: credential.refresh,
          expires: credential.expires,
        });
        report(
          `Pooled the current Anthropic credential as "${target}".\n${formatPool(store.read(), store.filePath)}`,
        );
        return;
      }

      case "switch": {
        if (!target) {
          report("Usage: /anthropic-auth:accounts switch <label>", true);
          return;
        }
        const pool = await store.switchTo(target);
        if (activeAccountOf(pool)?.label !== target) {
          report(`No pooled account labelled "${target}".`, true);
          return;
        }
        report(`Active Anthropic account is now "${target}".`);
        return;
      }

      case "remove": {
        if (!target) {
          report("Usage: /anthropic-auth:accounts remove <label>", true);
          return;
        }
        const before = store.size();
        await store.remove(target);
        if (store.size() === before) {
          report(`No pooled account labelled "${target}".`, true);
          return;
        }
        report(
          `Removed "${target}".\n${formatPool(store.read(), store.filePath)}`,
        );
        return;
      }

      default:
        report(USAGE, true);
    }
  };
}
