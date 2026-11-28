import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Contract for scripts/security/install-hooks.sh (the package.json "prepare"
// hook): the gitleaks probe is the branch point.
//
//   CI=true (GitHub Actions sets it natively) -> clean deterministic skip;
//     runners never need gitleaks for `npm ci`/`npm pack` to succeed. The
//     security workflow provisions its own pinned gitleaks and stays the
//     enforcement plane.
//   CI unset (developer checkout) -> behavior unchanged: hooks installed,
//     gitleaks still hard-required.
//
// The sandbox below gives every row an isolated HOME and a working directory
// that is NOT a git repo, so a stray `git config core.hooksPath` would fail
// loudly instead of silently mutating state: exit 0 in that directory is
// itself proof the CI branch skipped the install.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "scripts", "security", "install-hooks.sh");

// A PATH that carries a git toolchain but no gitleaks: gitleaks lives in the
// Homebrew prefix on dev machines and is absent from GitHub runners.
const noGitleaksPath = "/usr/bin:/bin";

const gitleaksDir = (() => {
  try {
    return path.dirname(execFileSync("/usr/bin/which", ["gitleaks"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
})();

function makeScratch(label) {
  return mkdtempSync(path.join(tmpdir(), `install-hooks-${label}-`));
}

function runInstaller({ extraEnv = {}, withGitleaks = false, cwd }) {
  const home = mkdtempSync(path.join(tmpdir(), "install-hooks-home-"));
  const gitleaksPrefix = withGitleaks && gitleaksDir ? `${gitleaksDir}:` : "";
  try {
    return spawnSync("bash", [installer], {
      cwd,
      env: {
        ...extraEnv,
        PATH: `${gitleaksPrefix}${noGitleaksPath}`,
        HOME: home,
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("prepare installer skips cleanly under CI=true without gitleaks", () => {
  const cwd = makeScratch("ci");
  try {
    const result = runInstaller({ extraEnv: { CI: "true" }, cwd });
    assert.equal(
      result.status,
      0,
      `expected clean skip, got status ${result.status}; stderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /skipping git hooks install/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("prepare installer still fails loudly without gitleaks when CI is unset", () => {
  const cwd = makeScratch("dev");
  try {
    const result = runInstaller({ cwd });
    assert.notEqual(result.status, 0, "developer checkouts must hard-require gitleaks");
    assert.match(result.stderr, /gitleaks is not on PATH/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("prepare installer keeps developer behavior: hooks installed with gitleaks present", { skip: gitleaksDir === null ? "gitleaks not installed on this machine" : false }, () => {
  const cwd = makeScratch("parity");
  execFileSync("git", ["init", "--quiet", cwd], { cwd });
  try {
    const result = runInstaller({ withGitleaks: true, cwd });
    assert.equal(
      result.status,
      0,
      `expected hooks install to succeed, got status ${result.status}; stderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /Hooks installed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
