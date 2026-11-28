# Security kit

Enforces the house rule: no secret-shaped material (real, test, or synthetic) in code or git history, ever. Real credentials are fetched from AWS SSM at runtime; test crypto material is generated at runtime.

- Install: `scripts/security/install-hooks.sh` (requires gitleaks on PATH).
- `githooks/pre-commit` scans staged changes; `githooks/pre-push` scans full history.
- CI (`.github/workflows/security.yml`) runs `gitleaks detect` on every push and PR (gitleaks pinned to v8.30.1).
- A finding blocks the operation: remove the material (or purge history with `git filter-repo`) and use runtime generation instead.
