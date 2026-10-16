import assert from "node:assert/strict";
import { test } from "node:test";

import plugin from "../index.js";

// The bootstrap skeleton has exactly one contract: every entry point fails
// fast with a not-implemented error, so nothing can silently consume the
// package before the v1.0.0 port (story 2.5) lands. This is a real,
// failable behavioral test of that contract.
test("bootstrap skeleton contract: setup and server throw not-implemented", async () => {
  await assert.rejects(
    plugin.setup(),
    (error) =>
      error instanceof Error &&
      error.message ===
        "opencode-auto-continue: not yet implemented (bootstrap skeleton; port lands in v1.0.0)"
  );

  await assert.rejects(
    plugin.server(),
    (error) =>
      error instanceof Error &&
      error.message === "opencode-auto-continue: not yet implemented"
  );
});
