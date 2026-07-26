import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

/** File name used for the account pool in every location. */
export const POOL_FILE_NAME = "anthropic-accounts.json";

/**
 * Project config directory name.
 *
 * Mirrors the coding-agent's `CONFIG_DIR_NAME`.  Duplicated as a literal
 * rather than imported so this module stays free of the Pi SDK and remains
 * unit-testable against a temp directory tree; the value is part of Pi's
 * user-facing convention and does not drift.
 */
export const PROJECT_CONFIG_DIR = ".pi";

/** Environment variable that pins the pool file to an explicit path. */
export const POOL_PATH_ENV = "PI_ANTHROPIC_AUTH_ACCOUNTS_FILE";

/** Where a resolved pool file came from. */
export type PoolScope = "env" | "project" | "global";

/** A resolved pool file: its path plus the scope that produced it. */
export interface PoolLocation {
  path: string;
  scope: PoolScope;
}

/** Global pool path, beside Pi's own `auth.json` in the agent directory. */
export function globalPoolPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir =
    env.PI_AGENT_DIR ?? join(homedir(), PROJECT_CONFIG_DIR, "agent");
  return join(agentDir, POOL_FILE_NAME);
}

/**
 * Path a project-local pool would occupy for a given project root.
 *
 * Used both to look for an existing local pool and to place a new one when
 * `/anthropic-auth:accounts add --local` runs.
 */
export function projectPoolPathFor(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR, POOL_FILE_NAME);
}

/**
 * Finds an existing project-local pool by walking up from `startDir`.
 *
 * Walking up (rather than checking only `cwd`) means the pool is still found
 * when Pi is launched from a subdirectory of the project, matching how project
 * config is normally discovered.
 *
 * @returns the pool path, or `undefined` when no ancestor has one.
 */
export function findProjectPool(startDir: string): string | undefined {
  let current = startDir;
  // `parse(current).root` is the filesystem root; stop once we reach it.
  const { root } = parse(current);
  for (;;) {
    const candidate = projectPoolPathFor(current);
    if (existsSync(candidate)) return candidate;
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolves which pool file is authoritative for this process.
 *
 * Precedence, highest first:
 *
 * 1. `PI_ANTHROPIC_AUTH_ACCOUNTS_FILE` — an explicit override, for CI and
 *    one-off invocations.
 * 2. A project-local `.pi/anthropic-accounts.json` found by walking up from
 *    the working directory.
 * 3. The global pool in the agent directory.
 *
 * A project-local pool **fully replaces** the global one rather than extending
 * it: exactly one file is authoritative, so the effective account set is
 * always obvious from the resolved path (surfaced by `/anthropic-auth:status`).
 */
export function resolvePoolLocation(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): PoolLocation {
  const explicit = env[POOL_PATH_ENV];
  if (explicit) {
    return { path: explicit, scope: "env" };
  }

  const project = findProjectPool(cwd);
  if (project) {
    return { path: project, scope: "project" };
  }

  return { path: globalPoolPath(env), scope: "global" };
}
