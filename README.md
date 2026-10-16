# opencode-auto-continue

opencode v2 plugin: automatically continue sessions after context compaction, so a
compacted session picks its work back up instead of stopping mid-task.

## Status: v2 implementation (v1.0.0)

Clean-room implementation of the ratified auto-continue behavior contract
(RATIFICATIONS.md R18) on the opencode v2 plugin API.

## Behavior specification

When `enabled` (default **off**), the plugin watches the server event stream. When a
session goes idle following a compaction, it polls the session at a fixed interval
and submits the configured `keyword` prompt so the model picks its work back up.

### Decision state machine

Per session, tracked from the event stream (`event.type` / `event.properties.sessionID`):

```
DISARMED ──(session.compaction.started)──▶ ARMED
ARMED    ──(session.compaction.failed)──▶ DISARMED        (log: compaction failed)
ARMED    ──(session.idle)───────────────▶ PENDING         (first poll after `interval`)
PENDING  ──(poll: readiness checks hold)─▶ SUBMITTED      (prompt sent exactly once → DISARMED)
PENDING  ──(poll: new user input)───────▶ DISARMED        (log: abort — input arrived)
PENDING  ──(poll: session busy/retry)────▶ DISARMED        (log: abort — session resumed)
PENDING  ──(poll: read failure)─────────▶ DISARMED        (log: warn — never retried blindly)
PENDING  ──(poll: not ready, ticks<max)─▶ PENDING         (next poll after `interval`)
PENDING  ──(poll: not ready, ticks=max)─▶ DISARMED        (log: GIVE UP — maxChecks exhausted)
any      ──(session.deleted)────────────▶ state dropped
```

### Readiness checks (one per poll, in order)

1. **Status** — tracked from `session.status` events; `busy`/`retry` aborts (the
   session resumed without this plugin).
2. **Transcript** — read via the session context API; a read failure aborts the
   decision cycle (logged, never retried).
3. **No new user input** — the latest transcript entry must not be a user message;
   input arrived after the model stopped means the continuation is not ours to send.
4. **Model stopped** — the latest transcript entry is an assistant message that has
   a `finish` value and no `error`. An unfinished last assistant message is a
   transient not-ready state: the poll loop keeps checking (up to `maxChecks`)
   and then gives up.

When all checks hold, the plugin submits the `keyword` prompt for that session —
**exactly once per compaction cycle**. A new compaction re-arms the cycle.

### Interval polling is the ratified wait mechanism

Each poll is preceded by one `interval` wait. Those waits are the spacing between
readiness checks of session state — they are the ratified design, not a
synchronization sleep. No other time-based waits exist in this plugin.

Every decision (arm, disarm, skip, poll result, submit, abort, give up) is logged
with the session ID and reason.

## Configuration

Plugin options are read from `ctx.options` (the object form in the `plugins` array
of `opencode.jsonc`). Unknown option keys and invalid values fail fast.

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. The plugin is a logged no-op when off. |
| `keyword` | `"continue"` | Prompt text submitted as the continuation. |
| `interval` | `10000` | Milliseconds between readiness polls. |
| `maxChecks` | `5` | Poll budget per compaction cycle before giving up. |

```jsonc
{
  "plugins": [
    {
      "package": "@matthew-dresden/opencode-auto-continue",
      "options": { "enabled": true, "keyword": "continue", "interval": 10000, "maxChecks": 5 }
    }
  ]
}
```

## V2 API surface

Implemented against the [opencode v2 plugin API](https://opencode.ai/v2/docs/build/plugins):

- `Plugin.define({ id, setup(ctx) })` entrypoint shape; this package exports the
  definition structurally (`id`, `setup`, `server`) with no runtime dependency.
- `ctx.options` — plugin options.
- `ctx.event.subscribe({ signal })` — the server event stream (async iterable);
  consumed types: `session.compaction.started`, `session.compaction.ended`,
  `session.compaction.failed`, `session.idle`, `session.status`, `session.deleted`.
- `ctx.session.context({ sessionID })` — transcript reads for the readiness checks.
- `ctx.session.prompt({ sessionID, text })` — continuation prompt submission.
- Cleanup function returned from `setup` aborts the subscription signal and clears
  pending pollers.

## V1 asymmetry (deliberate)

The default export carries both V2 and V1 entry-point names: V2 hosts call
`setup(ctx)`, V1 hosts call `server()`. **`server()` throws a not-supported error.**
This package is a clean-room implementation for the v2 plugin API; the V1 half was
never shipped (no V1 consumers ever existed), and fabricating a V1 implementation
is out of contract (R18). There is nothing to migrate from — V1 hosts must not
load this package.

## Guard policy

All event-callback paths are guarded (SPIKE-2.2 amendment 9): non-essential
failures (logging, transcript reads, bookkeeping) are logged and the event stream
keeps running. Prompt-submission failures are loud: logged at error level with the
full cause, the decision cycle closes, and the stream continues — a failure is
never silently swallowed, and never rethrown into the subscription drain loop
(where a throw fails the live session).

## Pipeline

- `.github/workflows/ci.yml` — PR checks: conventional PR title, syntax lint
  (`node --check`), build artifact check (`npm pack --dry-run`), behavioral tests
  (`node --test`), license/NOTICE compliance, tarball allowlist and secret-leak
  gates, package.json version immutability.
- `.github/workflows/main-validation.yml` — on push to main: full validation,
  then an automated release PR that bumps package.json and CHANGELOG.md.
- `.github/workflows/tag-release.yml` — tags release commits and creates the
  GitHub Release. The publish job is structurally dead: it requires a manual
  `workflow_dispatch` AND the `REGISTRY_READY` repository variable, which is
  intentionally unset.
- `.github/workflows/automerge.yml` — enables squash auto-merge on pull
  requests; branch protection rules gate the actual merge.

## Clean-room statement

This is an independent implementation. It is inspired by
[hjzccc/opencode-auto-continue](https://github.com/hjzccc/opencode-auto-continue),
but no code, files, or structure were copied or derived from it. The upstream
repository is unlicensed, which permits no reuse. See [NOTICE](NOTICE).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
