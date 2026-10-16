#!/usr/bin/env node
// License compliance check for opencode-auto-continue.
//
// Fails unless:
//   - LICENSE exists and is the Apache-2.0 text
//   - NOTICE exists (clean-room inspiration credit for the unlicensed upstream)
//   - package.json "license" field is exactly "Apache-2.0"
//
// Usage: node scripts/check-license.mjs
// Exit 0 on success; exit 1 with violations listed on failure.

import { readFileSync, existsSync } from "node:fs";

const violations = [];

if (!existsSync("LICENSE")) {
  violations.push("LICENSE file is missing");
} else if (!readFileSync("LICENSE", "utf-8").includes("Apache License")) {
  violations.push('LICENSE exists but does not contain the Apache License text ("Apache License")');
}

if (!existsSync("NOTICE")) {
  violations.push("NOTICE file is missing (clean-room attribution required)");
}

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  if (pkg.license !== "Apache-2.0") {
    violations.push(
      `package.json "license" must be exactly "Apache-2.0" (found: ${JSON.stringify(pkg.license)})`
    );
  }
} catch (error) {
  violations.push(`package.json is not readable JSON: ${error.message}`);
}

if (violations.length > 0) {
  process.stderr.write(`license check FAILED with ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    process.stderr.write(`  - ${violation}\n`);
  }
  process.exit(1);
}

process.stdout.write("license check: OK (Apache-2.0 LICENSE + NOTICE + package.json field)\n");
