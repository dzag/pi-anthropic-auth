import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import {
  findProjectPool,
  globalPoolPath,
  POOL_PATH_ENV,
  projectPoolPathFor,
  resolvePoolLocation,
} from "#src/pool-location";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pool-location-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeProjectPool(projectRoot: string): string {
  const path = projectPoolPathFor(projectRoot);
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(path, '{"version":1,"activeIndex":0,"accounts":[]}');
  return path;
}

test("globalPoolPath honors PI_AGENT_DIR", () => {
  const path = globalPoolPath({ PI_AGENT_DIR: "/custom/agent" });

  assert.equal(path, "/custom/agent/anthropic-accounts.json");
});

test("resolvePoolLocation falls back to the global pool when nothing is local", () => {
  const cwd = tempDir();

  const location = resolvePoolLocation(cwd, { PI_AGENT_DIR: "/custom/agent" });

  assert.equal(location.scope, "global");
  assert.equal(location.path, "/custom/agent/anthropic-accounts.json");
});

test("a project-local pool takes precedence over the global one", () => {
  const project = tempDir();
  const localPool = writeProjectPool(project);

  const location = resolvePoolLocation(project, {
    PI_AGENT_DIR: "/custom/agent",
  });

  assert.equal(location.scope, "project");
  assert.equal(location.path, localPool);
});

test("a project-local pool is found from a nested working directory", () => {
  const project = tempDir();
  const localPool = writeProjectPool(project);
  const nested = join(project, "packages", "app", "src");
  mkdirSync(nested, { recursive: true });

  const location = resolvePoolLocation(nested, {
    PI_AGENT_DIR: "/custom/agent",
  });

  assert.equal(location.scope, "project");
  assert.equal(location.path, localPool);
});

test("the env override beats both project and global pools", () => {
  const project = tempDir();
  writeProjectPool(project);

  const location = resolvePoolLocation(project, {
    PI_AGENT_DIR: "/custom/agent",
    [POOL_PATH_ENV]: "/explicit/pool.json",
  });

  assert.equal(location.scope, "env");
  assert.equal(location.path, "/explicit/pool.json");
});

test("findProjectPool returns undefined when no ancestor has a pool", () => {
  const dir = tempDir();

  assert.equal(findProjectPool(dir), undefined);
});

test("findProjectPool ignores a .pi directory without a pool file", () => {
  const project = tempDir();
  mkdirSync(join(project, ".pi"), { recursive: true });

  assert.equal(findProjectPool(project), undefined);
});
