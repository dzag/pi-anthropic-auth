import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Redirect the agent directory at temp storage for the whole suite, so no
    // test can read or write the developer's real `~/.pi/agent` state (notably
    // the Anthropic account rotation pool, which `AccountStore` resolves from
    // `PI_AGENT_DIR`).
    setupFiles: ["./test/setup/isolate-agent-dir.ts"],
  },
});
