#!/usr/bin/env node
// Tarball leak gates for opencode-auto-continue.
//
// Packs the package (npm pack), then asserts the tarball matches the
// package.json "files" allowlist policy and contains no secret material:
//   ALLOWLIST (exact set): package.json, README.md, LICENSE, NOTICE, index.js.
//   npm adds the mandatory metadata files automatically; index.js is the only
//   shipped source file. Any member outside the allowlist is a violation;
//   extend the allowlist when new shipped sources or build output land.
//   FORBIDDEN content: private key blocks, cloud API token shapes, and
//   key=value secret assignments in text files.
//
// Usage: node scripts/check-tarball.mjs
// Exit 0 on success; exit 1 with all violations listed on failure.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALLOWLIST = new Set(["package.json", "README.md", "LICENSE", "NOTICE", "index.js"]);

const SECRET_PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  {
    name: "key=value secret assignment",
    // multiline flag: the anchor must match on every line of a member, not
    // only the first (secrets appended mid-file would otherwise be missed).
    re: /^\s*(?:api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/im,
  },
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (result.status !== 0) {
    process.stderr.write(
      `FATAL: ${cmd} ${args.join(" ")} failed (exit ${result.status})\n${result.stderr ?? ""}\n`
    );
    process.exit(1);
  }
  return result;
}

function main() {
  const workdir = mkdtempSync(join(tmpdir(), "auto-continue-tarball-"));
  try {
    run("npm", ["pack", "--pack-destination", workdir], {
      cwd: process.cwd(),
    });
    // Locate the produced tarball directly in the pack destination rather
    // than parsing npm's human-readable stdout.
    const produced = readdirSync(workdir).filter((name) => name.endsWith(".tgz"));
    if (produced.length !== 1) {
      process.stderr.write(
        `FATAL: expected exactly one tarball in ${workdir}, found: ${JSON.stringify(produced)}\n`
      );
      process.exit(1);
    }
    const packed = join(workdir, produced[0]);

    const listing = run("tar", ["-tzf", packed]).stdout;
    const entries = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));

    const violations = [];

    // Exact allowlist check: every tarball member must be expected, and every
    // allowlisted file must be present.
    const names = new Set(entries.map((entry) => entry.replace(/^package\//, "")));
    for (const entry of entries) {
      const name = entry.replace(/^package\//, "");
      if (!ALLOWLIST.has(name)) {
        violations.push(`NOT IN ALLOWLIST: ${entry} (files allowlist ships index.js only)`);
      }
    }
    for (const required of ALLOWLIST) {
      if (!names.has(required)) {
        violations.push(`MISSING ALLOWLISTED FILE: ${required}`);
      }
    }

    // Content leak scan on text members.
    for (const entry of entries) {
      const show = run("tar", ["-xzOf", packed, entry], { maxBuffer: 32 * 1024 * 1024 });
      const content = show.stdout;
      if (content.includes("\u0000")) {
        continue; // binary member, pattern scan not meaningful
      }
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(content)) {
          violations.push(`SECRET PATTERN (${name}) in tarball member: ${entry}`);
        }
      }
    }

    if (violations.length > 0) {
      process.stderr.write(`tarball check FAILED with ${violations.length} violation(s):\n`);
      for (const violation of violations) {
        process.stderr.write(`  - ${violation}\n`);
      }
      process.exit(1);
    }

    process.stdout.write(
      `tarball check: OK (${entries.length} members, exact allowlist match, no leaks)\n`
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
