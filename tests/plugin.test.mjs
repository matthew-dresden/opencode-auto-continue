import assert from "node:assert/strict";
import { test } from "node:test";

import plugin, { OPTIONS_DEFAULTS, parseOptions } from "../index.js";

// ---------------------------------------------------------------------------
// Mock opencode v2 plugin context. The event subscription is an async
// generator the test controls (push-driven); session methods are spies.
// ---------------------------------------------------------------------------

function createEventStream() {
  const queue = [];
  let wake = null;
  let finallyRun = false;
  let started = false;

  async function* subscribe({ signal } = {}) {
    started = true;
    try {
      while (true) {
        if (signal?.aborted) return;
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          const onAbort = () => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
          wake = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        });
      }
    } finally {
      finallyRun = true;
    }
  }

  return {
    subscribe,
    push(event) {
      queue.push(event);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    get finallyRun() {
      return finallyRun;
    },
    get started() {
      return started;
    },
  };
}

function makeCtx({
  options = {},
  context = async () => [],
  prompt = async () => ({}),
  stream = createEventStream(),
} = {}) {
  const promptSpy = { calls: [] };
  const contextSpy = { calls: [] };
  const wrappedPrompt = async (input) => {
    promptSpy.calls.push(input);
    return prompt(input);
  };
  const wrappedContext = async (input) => {
    contextSpy.calls.push(input);
    return context(input);
  };
  const ctx = {
    options,
    event: { subscribe: stream.subscribe },
    session: { context: wrappedContext, prompt: wrappedPrompt },
  };
  return { ctx, promptSpy, contextSpy, stream };
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

// Log capture: console.log / console.error are the plugin's logging surface.
function captureLogs() {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(`ERROR: ${args.join(" ")}`);
  return {
    logs,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

const event = (type, properties = {}) => ({ type, properties });

const IDLE = () => event("session.idle", { sessionID: "ses_test" });
const COMPACT_STARTED = () =>
  event("session.compaction.started", { sessionID: "ses_test", reason: "auto" });
const COMPACT_ENDED = () =>
  event("session.compaction.ended", { sessionID: "ses_test", reason: "auto" });
const COMPACT_FAILED = () =>
  event("session.compaction.failed", { sessionID: "ses_test", reason: "auto" });
const STATUS_BUSY = () =>
  event("session.status", { sessionID: "ses_test", status: { type: "busy" } });

const assistantFinished = (finish = "stop") => [
  { info: { role: "assistant", finish }, parts: [] },
];
const assistantUnfinished = () => [
  { info: { role: "assistant" }, parts: [] },
];
const userLast = () => [{ info: { role: "user" }, parts: [] }];

// ---------------------------------------------------------------------------
// Options contract
// ---------------------------------------------------------------------------

test("options contract: R18 defaults when ctx.options is undefined or null", () => {
  assert.deepEqual(parseOptions(undefined), {
    enabled: false,
    keyword: "continue",
    interval: 10000,
    maxChecks: 5,
  });
  assert.deepEqual(parseOptions(null), { ...OPTIONS_DEFAULTS });
});

test("options contract: all four options overridable", () => {
  assert.deepEqual(
    parseOptions({
      enabled: true,
      keyword: "keep going",
      interval: 250,
      maxChecks: 2,
    }),
    { enabled: true, keyword: "keep going", interval: 250, maxChecks: 2 }
  );
});

test("options contract: unknown option key fails fast", () => {
  assert.throws(() => parseOptions({ enable: true }), /unknown plugin option "enable"/);
});

test("options contract: invalid values fail fast", () => {
  assert.throws(() => parseOptions({ enabled: "yes" }), /option "enabled" must be a boolean/);
  assert.throws(() => parseOptions({ keyword: "" }), /option "keyword" must be a string/);
  assert.throws(() => parseOptions({ interval: -1 }), /option "interval" must be an integer >= 0/);
  assert.throws(() => parseOptions({ interval: 1.5 }), /option "interval" must be an integer >= 0/);
  assert.throws(() => parseOptions({ maxChecks: 0 }), /option "maxChecks" must be an integer >= 1/);
  assert.throws(() => parseOptions("nope"), /plugin options must be an object/);
});

// ---------------------------------------------------------------------------
// Dual shape
// ---------------------------------------------------------------------------

test("dual shape: stable id, V2 setup, and server() throws not-supported for V1 hosts", async () => {
  assert.equal(plugin.id, "opencode-auto-continue");
  assert.equal(typeof plugin.setup, "function");
  await assert.rejects(
    plugin.server(),
    (error) =>
      error instanceof Error &&
      error.message ===
        "[opencode-auto-continue]: not supported — this package ships only the opencode v2 plugin API implementation (setup); no V1 server() implementation exists"
  );
});

test("dual shape: setup validates the V2 context and fails fast without it", async () => {
  await assert.rejects(plugin.setup(null), /setup requires the opencode v2 plugin context/);
  await assert.rejects(plugin.setup({}), /missing event\.subscribe/);
  await assert.rejects(
    plugin.setup({ event: { subscribe: () => {} } }),
    /missing session\.prompt/
  );
});

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

test("disabled by default: setup is a no-op and never prompts", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({});
    const dispose = await plugin.setup(ctx);
    assert.equal(typeof dispose, "function");
    assert.equal(stream.started, false, "no event subscription when disabled");
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();
    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("disabled by configuration")),
      "disabled decision logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

// ---------------------------------------------------------------------------
// Decision state machine
// ---------------------------------------------------------------------------

test("idle after compaction: prompt submitted exactly once", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, contextSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();

    // A second idle for the same (now disarmed) cycle must not re-submit.
    stream.push(IDLE());
    await settle();

    assert.equal(promptSpy.calls.length, 1);
    assert.deepEqual(promptSpy.calls[0], { sessionID: "ses_test", text: "continue" });
    assert.equal(contextSpy.calls.length, 1);
    assert.ok(
      capture.logs.some((line) => line.includes("SUBMIT")),
      "submit decision logged"
    );
    assert.ok(
      capture.logs.some((line) => line.includes("SKIP") && line.includes("without a preceding compaction")),
      "second idle logged as skip (already disarmed)"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("idle without compaction: no prompt", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, contextSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
    });
    const dispose = await plugin.setup(ctx);
    stream.push(IDLE());
    await settle();
    assert.equal(promptSpy.calls.length, 0);
    assert.equal(contextSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("SKIP")),
      "skip decision logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("compaction failed: no prompt", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_FAILED());
    stream.push(IDLE());
    await settle();
    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("DISARMED") && line.includes("compaction failed")),
      "disarm decision logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("new user input after model stopped: abort, no prompt", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => userLast(),
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();
    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("ABORT") && line.includes("new user input")),
      "abort decision logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("session resumed busy before poll: abort, no prompt", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 30, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    stream.push(STATUS_BUSY()); // processed well before the 30ms first poll
    await settle(80);
    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("ABORT") && line.includes("status=busy")),
      "busy abort decision logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("transient not-ready state: polls again, then submits when ready", async () => {
  const capture = captureLogs();
  try {
    const contextSpy = { calls: 0 };
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 3 },
      context: async () => {
        contextSpy.calls += 1;
        return contextSpy.calls === 1 ? assistantUnfinished() : assistantFinished("stop");
      },
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();
    assert.equal(promptSpy.calls.length, 1);
    assert.equal(contextSpy.calls, 2, "first poll not ready, second poll submitted");
    assert.ok(
      capture.logs.some((line) => line.includes("not ready") && line.includes("polling again")),
      "not-ready poll logged"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("maxChecks exhaustion: gives up, logs, never prompts", async () => {
  const capture = captureLogs();
  try {
    const contextSpy = { calls: 0 };
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 2 },
      context: async () => {
        contextSpy.calls += 1;
        return assistantUnfinished();
      },
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle(60);

    assert.equal(contextSpy.calls, 2, "exactly maxChecks polls ran");
    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some(
        (line) => line.includes("GIVE UP") && line.includes("maxChecks=2 exhausted")
      ),
      "give-up decision logged"
    );

    // The cycle is closed: a later idle does not resurrect the decision.
    stream.push(IDLE());
    await settle();
    assert.equal(contextSpy.calls, 2);
  } finally {
    capture.restore();
  }
});

test("interval polling honored: polls are spaced by the configured interval", async () => {
  const capture = captureLogs();
  try {
    const interval = 20;
    const maxChecks = 3;
    const contextSpy = { calls: 0 };
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval, maxChecks },
      context: async () => {
        contextSpy.calls += 1;
        return assistantUnfinished();
      },
    });
    const dispose = await plugin.setup(ctx);
    const start = Date.now();
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle(120);

    const elapsed = Date.now() - start;
    assert.equal(contextSpy.calls, maxChecks, "one readiness poll per check");
    assert.ok(
      elapsed >= interval * maxChecks,
      `poll spacing honored: elapsed ${elapsed}ms must be >= ${interval * maxChecks}ms (interval waits are the spacing between readiness checks)`
    );
    assert.equal(promptSpy.calls.length, 0);
    dispose();
  } finally {
    capture.restore();
  }
});

// ---------------------------------------------------------------------------
// Guards (SPIKE-2.2 amendment 9)
// ---------------------------------------------------------------------------

test("prompt-submission failure is loud and does not kill the event stream", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
      prompt: async () => {
        throw new Error("session service unavailable");
      },
    });
    const dispose = await plugin.setup(ctx);
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();

    assert.equal(promptSpy.calls.length, 1);
    assert.ok(
      capture.logs.some(
        (line) =>
          line.startsWith("ERROR:") &&
          line.includes("continuation prompt submission FAILED") &&
          line.includes("session service unavailable")
      ),
      "failure logged loudly at error level with the cause"
    );

    // Stream still alive: a later event is handled.
    stream.push(event("session.deleted", { sessionID: "ses_test" }));
    await settle();
    assert.ok(
      capture.logs.some((line) => line.includes("state dropped for deleted session")),
      "subscription still consuming after a loud prompt failure"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

test("malformed events and transcript read failures are guarded, stream continues", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, stream } = makeCtx({
      options: { enabled: true, interval: 1, maxChecks: 5 },
      context: async () => {
        throw new Error("transient store error");
      },
    });
    const dispose = await plugin.setup(ctx);
    stream.push({ properties: {} }); // malformed: no event type
    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE());
    await settle();

    assert.equal(promptSpy.calls.length, 0);
    assert.ok(
      capture.logs.some((line) => line.includes("ignoring malformed event")),
      "malformed event guarded"
    );
    assert.ok(
      capture.logs.some(
        (line) =>
          line.includes("transcript read failed") && line.includes("transient store error")
      ),
      "transcript read failure guarded and logged"
    );

    // Stream still consuming.
    stream.push(event("session.deleted", { sessionID: "ses_test" }));
    await settle();
    assert.ok(
      capture.logs.some((line) => line.includes("state dropped for deleted session")),
      "subscription alive after guarded failures"
    );
    dispose();
  } finally {
    capture.restore();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("dispose aborts the event subscription and clears pollers", async () => {
  const capture = captureLogs();
  try {
    const { ctx, promptSpy, contextSpy, stream } = makeCtx({
      options: { enabled: true, interval: 30, maxChecks: 5 },
      context: async () => assistantFinished("stop"),
    });
    const dispose = await plugin.setup(ctx);
    assert.equal(stream.started, true);

    stream.push(COMPACT_STARTED());
    stream.push(COMPACT_ENDED());
    stream.push(IDLE()); // poller now pending at +30ms
    await settle(5);
    dispose();

    // Aborting the signal ends the generator on a later microtask; give the
    // subscription loop a beat to run its finalizer.
    await settle(10);
    assert.equal(stream.finallyRun, true, "subscription generator finalizer ran on abort");

    // Wait past the pending poll tick: it must never fire after dispose.
    await settle(80);
    assert.equal(contextSpy.calls.length, 0, "pending poll cleared by dispose");
    assert.equal(promptSpy.calls.length, 0);

    // Events pushed after dispose are not consumed.
    stream.push(COMPACT_STARTED());
    await settle(10);
    const armedCount = capture.logs.filter((line) =>
      line.includes("ARMED (compaction started)")
    ).length;
    assert.equal(armedCount, 1, "no new arming after dispose");
    assert.ok(
      capture.logs.some((line) => line.includes("disposed")),
      "dispose logged"
    );
  } finally {
    capture.restore();
  }
});
