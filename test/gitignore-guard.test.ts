import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import {
  describeGitignoreResult,
  ensureGitIgnored,
  findRepoRoot,
  isPatternPresent,
} from "#src/gitignore-guard";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-gitignore-guard-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Creates a repo-like tree with a `.pi/anthropic-accounts.json` path. */
function createRepo(options: { gitignore?: string } = {}): {
  root: string;
  poolPath: string;
} {
  const root = tempDir();
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  if (options.gitignore !== undefined) {
    writeFileSync(join(root, ".gitignore"), options.gitignore);
  }
  return { root, poolPath: join(root, ".pi", "anthropic-accounts.json") };
}

test("appends an ignore entry when the pool is not yet ignored", () => {
  const { root, poolPath } = createRepo({ gitignore: "node_modules\n" });

  const result = ensureGitIgnored(poolPath);

  assert.equal(result.kind, "added");
  const contents = readFileSync(join(root, ".gitignore"), "utf-8");
  assert.match(contents, /^node_modules$/m);
  assert.match(contents, /^\.pi\/anthropic-accounts\.json$/m);
  assert.match(contents, /contains refresh tokens/);
});

test("creates .gitignore when the repo has none", () => {
  const { root, poolPath } = createRepo();

  const result = ensureGitIgnored(poolPath);

  assert.equal(result.kind, "added");
  assert.match(
    readFileSync(join(root, ".gitignore"), "utf-8"),
    /^\.pi\/anthropic-accounts\.json$/m,
  );
});

test("is idempotent — a second call does not duplicate the entry", () => {
  const { root, poolPath } = createRepo();

  ensureGitIgnored(poolPath);
  const second = ensureGitIgnored(poolPath);

  assert.equal(second.kind, "already-ignored");
  const lines = readFileSync(join(root, ".gitignore"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() === ".pi/anthropic-accounts.json");
  assert.equal(lines.length, 1);
});

test("recognizes an existing rooted pattern", () => {
  const { poolPath } = createRepo({
    gitignore: "/.pi/anthropic-accounts.json\n",
  });

  assert.equal(ensureGitIgnored(poolPath).kind, "already-ignored");
});

test("does not append a newline-splitting entry to a file without a trailing newline", () => {
  const { root, poolPath } = createRepo({ gitignore: "node_modules" });

  ensureGitIgnored(poolPath);

  const contents = readFileSync(join(root, ".gitignore"), "utf-8");
  assert.match(contents, /^node_modules$/m);
});

test("reports not-a-repo outside a git working tree", () => {
  const dir = tempDir();
  mkdirSync(join(dir, ".pi"), { recursive: true });

  const result = ensureGitIgnored(join(dir, ".pi", "anthropic-accounts.json"));

  assert.equal(result.kind, "not-a-repo");
});

test("findRepoRoot detects a .git file (worktree/submodule layout)", () => {
  const root = tempDir();
  writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });

  assert.equal(findRepoRoot(nested), root);
});

test("isPatternPresent matches bare and rooted forms only", () => {
  assert.equal(isPatternPresent(".pi/pool.json\n", ".pi/pool.json"), true);
  assert.equal(isPatternPresent("/.pi/pool.json\n", ".pi/pool.json"), true);
  assert.equal(isPatternPresent("  .pi/pool.json  \n", ".pi/pool.json"), true);
  assert.equal(isPatternPresent("other.json\n", ".pi/pool.json"), false);
});

test("describeGitignoreResult stays quiet unless action or attention is needed", () => {
  assert.equal(
    describeGitignoreResult({ kind: "not-a-repo" }, "/tmp/pool.json"),
    undefined,
  );
  assert.equal(
    describeGitignoreResult({ kind: "already-ignored" }, "/tmp/pool.json"),
    undefined,
  );
  assert.match(
    describeGitignoreResult(
      { kind: "added", gitignorePath: "/repo/.gitignore", pattern: ".pi/p" },
      "/tmp/pool.json",
    ) ?? "",
    /Added ".pi\/p"/,
  );
  assert.match(
    describeGitignoreResult(
      { kind: "failed", reason: "EACCES" },
      "/tmp/pool.json",
    ) ?? "",
    /WARNING.*EACCES/,
  );
});
