import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * Points `PI_AGENT_DIR` at a throwaway directory for every test file.
 *
 * Without this, anything that constructs an `AccountStore` with its default
 * path — including `src/index.ts` during the registration tests — reads the
 * developer's real `~/.pi/agent/anthropic-accounts.json`.  A populated real
 * pool would then silently change behavior under test (rotation switches from
 * passthrough to active), which is exactly the false failure this prevents.
 */
let agentDir: string | undefined;
let previous: string | undefined;

beforeAll(() => {
  previous = process.env.PI_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-anthropic-auth-agent-dir-"));
  process.env.PI_AGENT_DIR = agentDir;
});

afterAll(() => {
  if (previous === undefined) {
    delete process.env.PI_AGENT_DIR;
  } else {
    process.env.PI_AGENT_DIR = previous;
  }
  if (agentDir) {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
