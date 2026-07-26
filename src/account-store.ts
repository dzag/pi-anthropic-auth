import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type PoolScope, resolvePoolLocation } from "./pool-location";

/**
 * One pooled Anthropic OAuth account.
 *
 * Field names mirror pi-ai's `OAuthCredential` (`access` / `refresh` /
 * `expires`) so a credential snapshot read out of Pi's `auth.json` can be
 * stored without translation.
 */
export interface PooledAccount {
  /** Human-readable name used by the `/anthropic-auth:accounts` commands. */
  label: string;
  /** OAuth refresh token. */
  refresh: string;
  /** OAuth access token (`sk-ant-oat...`). */
  access: string;
  /** Epoch millis after which `access` must be refreshed. */
  expires: number;
  /**
   * Epoch millis when this account was last observed to be usage-limited, or
   * `undefined` if it has never been limited.  Informational only — rotation
   * always retries every account once per cycle, because Anthropic does not
   * reliably tell us when a window resets.
   */
  limitedAt?: number;
}

/** On-disk shape of the account pool file. */
export interface AccountPool {
  version: 1;
  /** Index into `accounts` of the account currently in use. */
  activeIndex: number;
  accounts: PooledAccount[];
}

const POOL_FILE_VERSION = 1;
const POOL_FILE_MODE = 0o600;
const POOL_DIR_MODE = 0o700;

/** An empty pool — the default state, meaning "rotation disabled". */
export function emptyPool(): AccountPool {
  return { version: POOL_FILE_VERSION, activeIndex: 0, accounts: [] };
}

/**
 * Reads a pool's active account.
 *
 * Uses `Array.prototype.at` so the result is honestly typed as possibly
 * `undefined` (this repo does not enable `noUncheckedIndexedAccess`).
 */
export function activeAccountOf(pool: AccountPool): PooledAccount | undefined {
  return pool.accounts.at(pool.activeIndex);
}

function isPooledAccount(value: unknown): value is PooledAccount {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.label === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.access === "string" &&
    typeof candidate.expires === "number"
  );
}

/**
 * Coerces arbitrary parsed JSON into a valid pool.
 *
 * Anything unrecognized degrades to an empty pool rather than throwing: a
 * corrupt pool file must never break Anthropic requests, it must only disable
 * rotation.
 */
export function normalizePool(parsed: unknown): AccountPool {
  if (typeof parsed !== "object" || parsed === null) return emptyPool();

  const candidate = parsed as Record<string, unknown>;
  const accounts = Array.isArray(candidate.accounts)
    ? candidate.accounts.filter(isPooledAccount)
    : [];

  if (accounts.length === 0) return emptyPool();

  const rawIndex = candidate.activeIndex;
  const activeIndex =
    typeof rawIndex === "number" &&
    Number.isInteger(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex < accounts.length
      ? rawIndex
      : 0;

  return { version: POOL_FILE_VERSION, activeIndex, accounts };
}

/**
 * File-backed account pool with in-process write serialization.
 *
 * Writes are atomic (temp file + rename) and serialized through a promise
 * chain so concurrent Anthropic call paths — the main loop, compaction, and
 * background agents all share this transport — cannot interleave a
 * read-modify-write.  This mirrors the serialization contract of pi-ai's
 * `InMemoryCredentialStore`.  Cross-process locking is intentionally out of
 * scope: the failure mode is a lost rotation, not a corrupt file.
 */
export class AccountStore {
  private readonly path: string;
  private readonly poolScope: PoolScope;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(path?: string, scope?: PoolScope) {
    if (path === undefined) {
      const location = resolvePoolLocation();
      this.path = location.path;
      this.poolScope = location.scope;
    } else {
      this.path = path;
      this.poolScope = scope ?? "global";
    }
  }

  /** Absolute path of the backing pool file. */
  get filePath(): string {
    return this.path;
  }

  /** Which location this pool came from: env override, project, or global. */
  get scope(): PoolScope {
    return this.poolScope;
  }

  /** Reads the pool, degrading to an empty pool on any read/parse failure. */
  read(): AccountPool {
    if (!existsSync(this.path)) return emptyPool();
    try {
      return normalizePool(JSON.parse(readFileSync(this.path, "utf-8")));
    } catch {
      return emptyPool();
    }
  }

  /** The account currently in use, or `undefined` when the pool is empty. */
  activeAccount(): PooledAccount | undefined {
    return activeAccountOf(this.read());
  }

  /** Number of accounts in the pool; `0` means rotation is disabled. */
  size(): number {
    return this.read().accounts.length;
  }

  /**
   * Serialized read-modify-write.
   *
   * @param mutate - receives the current pool and returns the pool to persist,
   *   or `undefined` to leave the file untouched.
   * @returns the pool as it stands after the operation.
   */
  modify(
    mutate: (pool: AccountPool) => AccountPool | undefined,
  ): Promise<AccountPool> {
    const next = this.chain.then(() => {
      const current = this.read();
      const updated = mutate(current);
      if (updated === undefined) return current;
      this.write(updated);
      return updated;
    });
    // Keep the chain alive even if this task rejects, so one failure does not
    // wedge every later write.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Appends an account, replacing any existing entry with the same label. */
  add(account: PooledAccount): Promise<AccountPool> {
    return this.modify((pool) => {
      const accounts = pool.accounts.filter(
        (existing) => existing.label !== account.label,
      );
      accounts.push(account);
      // Keep pointing at the same account when possible; `normalizePool`
      // clamps an out-of-range index on the next read regardless.
      const previousActive = activeAccountOf(pool);
      const activeIndex = previousActive
        ? accounts.indexOf(previousActive)
        : accounts.length - 1;
      return {
        ...pool,
        accounts,
        activeIndex: activeIndex >= 0 ? activeIndex : accounts.length - 1,
      };
    });
  }

  /** Removes the account matching `label`, if present. */
  remove(label: string): Promise<AccountPool> {
    return this.modify((pool) => {
      const accounts = pool.accounts.filter(
        (existing) => existing.label !== label,
      );
      if (accounts.length === pool.accounts.length) return undefined;
      if (accounts.length === 0) return emptyPool();
      const previousActive = activeAccountOf(pool);
      const remainingIndex = previousActive
        ? accounts.indexOf(previousActive)
        : -1;
      const activeIndex = remainingIndex >= 0 ? remainingIndex : 0;
      return { ...pool, accounts, activeIndex };
    });
  }

  /** Makes `label` the active account. Resolves unchanged if it is unknown. */
  switchTo(label: string): Promise<AccountPool> {
    return this.modify((pool) => {
      const index = pool.accounts.findIndex(
        (account) => account.label === label,
      );
      if (index < 0) return undefined;
      return { ...pool, activeIndex: index };
    });
  }

  /**
   * Advances the active account to the next entry, wrapping around, and marks
   * the account being left behind as limited.
   *
   * @returns the newly active account, or `undefined` when the pool has fewer
   *   than two accounts (nothing to rotate to).
   */
  // Called by `createRotatingStreamSimple` through a destructured dependency,
  // which fallow's class-member analysis does not follow.
  // fallow-ignore-next-line unused-class-member
  rotateNext(now: number = Date.now()): Promise<PooledAccount | undefined> {
    let rotated = false;
    return this.modify((pool) => {
      if (pool.accounts.length < 2) return undefined;
      const accounts = pool.accounts.map((account, index) =>
        index === pool.activeIndex ? { ...account, limitedAt: now } : account,
      );
      const activeIndex = (pool.activeIndex + 1) % accounts.length;
      rotated = true;
      return { ...pool, accounts, activeIndex };
    }).then((pool) => (rotated ? activeAccountOf(pool) : undefined));
  }

  /** Replaces the stored tokens for `label` (used after a token refresh). */
  // Called by `createRotatingStreamSimple` through a destructured dependency,
  // which fallow's class-member analysis does not follow.
  // fallow-ignore-next-line unused-class-member
  updateTokens(
    label: string,
    tokens: Pick<PooledAccount, "access" | "refresh" | "expires">,
  ): Promise<AccountPool> {
    return this.modify((pool) => {
      const index = pool.accounts.findIndex(
        (account) => account.label === label,
      );
      const existing = pool.accounts.at(index);
      if (index < 0 || !existing) return undefined;
      const accounts = [...pool.accounts];
      accounts[index] = { ...existing, ...tokens };
      return { ...pool, accounts };
    });
  }

  private write(pool: AccountPool): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: POOL_DIR_MODE });
    }
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(pool, null, 2)}\n`, {
      encoding: "utf-8",
      mode: POOL_FILE_MODE,
    });
    chmodSync(tempPath, POOL_FILE_MODE);
    renameSync(tempPath, this.path);
  }
}
