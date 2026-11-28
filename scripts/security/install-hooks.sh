#!/bin/sh
# Installs the repo git hooks (githooks/) and verifies gitleaks is available.
# House rule: no secret-shaped material (real, test, or synthetic) in code or
# history, ever.
set -e

# CI runners (GitHub Actions sets CI=true natively) skip the hook install
# entirely: the prepare lifecycle must not demand gitleaks from
# `npm ci`/`npm pack`, and enforcement stays in the security workflow, which
# provisions its own pinned gitleaks binary. Developer checkouts (CI unset)
# keep the original behavior: hooks installed, gitleaks hard-required.
if [ "${CI:-}" = "true" ]; then
  echo "CI detected; skipping git hooks install (gitleaks enforced by the security workflow)."
  exit 0
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'MSG'
ERROR: gitleaks is not on PATH. Install it before installing hooks:
  macOS: brew install gitleaks
  Linux: see https://github.com/gitleaks/gitleaks#installing
MSG
  exit 1
fi

git config core.hooksPath githooks
echo "Hooks installed (core.hooksPath=githooks); gitleaks $(gitleaks version) detected."
