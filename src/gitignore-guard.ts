import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Outcome of ensuring a pool file is git-ignored. */
export type GitignoreResult =
  | { kind: "not-a-repo" }
  | { kind: "already-ignored" }
  | { kind: "added"; gitignorePath: string; pattern: string }
  | { kind: "failed"; reason: string };

/** Header written above the pattern we append, so the entry is self-explaining. */
const IGNORE_COMMENT =
  "# Anthropic OAuth account pool (contains refresh tokens) - added by pi-anthropic-auth";

/**
 * Finds the repository root containing `startDir`, if any.
 *
 * Detects `.git` as either a directory (normal clone) or a file (worktree or
 * submodule, where `.git` is a gitdir pointer).
 */
export function findRepoRoot(startDir: string): string | undefined {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Returns true when `.gitignore` already lists a pattern covering `pattern`.
 *
 * Deliberately a literal-line check rather than full gitignore semantics: it
 * only needs to avoid appending a duplicate entry we ourselves wrote.  A
 * pattern ignored by some broader rule elsewhere simply results in a harmless
 * redundant line.
 */
export function isPatternPresent(
  gitignoreContents: string,
  pattern: string,
): boolean {
  return gitignoreContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === pattern || line === `/${pattern}`);
}

/**
 * Ensures the project-local pool file is git-ignored before secrets land in it.
 *
 * The pool stores OAuth **refresh tokens**, so a project-local file inside a
 * repository is one `git add -A` away from leaking a Claude subscription
 * credential.  This appends an ignore entry on first local write.
 *
 * Failure is never fatal: the caller reports the result and continues, so a
 * read-only or unusual repo layout cannot block account management.
 *
 * @param poolPath - absolute path of the project-local pool file.
 * @returns what happened, for the caller to surface to the user.
 */
export function ensureGitIgnored(poolPath: string): GitignoreResult {
  const repoRoot = findRepoRoot(dirname(poolPath));
  if (!repoRoot) return { kind: "not-a-repo" };

  // Git patterns are always forward-slash separated, regardless of platform.
  const pattern = relative(repoRoot, poolPath).split(sep).join("/");
  const gitignorePath = join(repoRoot, ".gitignore");

  try {
    const existing = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, "utf-8")
      : "";
    if (isPatternPresent(existing, pattern)) {
      return { kind: "already-ignored" };
    }

    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(
      gitignorePath,
      `${prefix}\n${IGNORE_COMMENT}\n${pattern}\n`,
      "utf-8",
    );
    return { kind: "added", gitignorePath, pattern };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Renders a `GitignoreResult` as a user-facing line, or `undefined` when there
 * is nothing worth saying (not a repo, or already ignored).
 */
export function describeGitignoreResult(
  result: GitignoreResult,
  poolPath: string,
): string | undefined {
  switch (result.kind) {
    case "added":
      return `Added "${result.pattern}" to ${result.gitignorePath} so the pooled refresh tokens are not committed.`;
    case "failed":
      return `WARNING: could not update .gitignore (${result.reason}). ${poolPath} contains OAuth refresh tokens - ignore it manually before committing.`;
    default:
      return undefined;
  }
}
