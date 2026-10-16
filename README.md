# opencode-auto-continue

opencode v2 plugin: automatically continue sessions after context compaction, so a
compacted session picks its work back up instead of stopping mid-task.

## Status: bootstrap

This repository is a clean-room bootstrap. The plugin is not implemented yet:

- `index.js` is a minimal fail-fast skeleton: calling `setup()` or `server()`
  throws a `not yet implemented` error.
- The v2 plugin API port lands in v1.0.0. Nothing should reference this package
  before that release.

## Clean-room statement

This is an independent implementation. It is inspired by
[hjzccc/opencode-auto-continue](https://github.com/hjzccc/opencode-auto-continue),
but no code, files, or structure were copied or derived from it. The upstream
repository is unlicensed, which permits no reuse. See [NOTICE](NOTICE).

## Pipeline

- `.github/workflows/ci.yml` — PR checks: conventional PR title, syntax lint
  (`node --check`), build artifact check (`npm pack --dry-run`), behavioral test
  of the skeleton contract (`node --test`), license/NOTICE compliance, tarball
  allowlist and secret-leak gates, package.json version immutability.
- `.github/workflows/main-validation.yml` — on push to main: full validation,
  then an automated release PR that bumps package.json and CHANGELOG.md.
- `.github/workflows/tag-release.yml` — tags release commits and creates the
  GitHub Release. The publish job is structurally dead: it requires a manual
  `workflow_dispatch` AND the `REGISTRY_READY` repository variable, which is
  intentionally unset.
- `.github/workflows/automerge.yml` — enables squash auto-merge on pull
  requests; branch protection rules gate the actual merge.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
