// opencode-auto-continue — opencode v2 plugin (clean-room implementation).
//
// Behavior: when enabled, after a session goes idle following a compaction
// event, poll the session at a fixed interval up to maxChecks times; when the
// session is idle, a compaction has completed, and no new user input has
// arrived, submit the configured keyword prompt via the V2 session API so a
// compacted session picks its work back up instead of stopping mid-task.
//
// Config contract (RATIFICATIONS.md R18, defaults): { enabled: false,
// keyword: "continue", interval: 10000, maxChecks: 5 } read from ctx.options.
//
// The interval polling loop is the ratified design: each interval wait spaces
// two readiness checks of session state (transcript + compaction markers +
// tracked status). No other time-based waits exist in this plugin; every wait
// is the inter-poll spacing of the readiness loop.
//
// Guard policy (SPIKE-2.2 amendment 9): every event-callback path is wrapped.
// Non-essential failures (logging, transcript reads, state bookkeeping) are
// logged and the event stream continues. Prompt-submission failures are loud:
// they are logged at error level with the full error message and abort the
// decision for that compaction cycle; they are never silently swallowed and
// never rethrown into the subscription drain loop (a throw there fails the
// live session per the amendment 9 probe evidence).
//
// Dual shape: V2 hosts call setup(ctx); V1 hosts call server(). The V1 half
// was never shipped for this clean-room package (V1 consumers never existed),
// so server() throws a not-supported error instead of fabricating an
// implementation.

const ID = "opencode-auto-continue";
const LOG_PREFIX = `[${ID}]`;

export const OPTIONS_DEFAULTS = Object.freeze({
  enabled: false,
  keyword: "continue",
  interval: 10000,
  maxChecks: 5,
});

const OPTION_SPECS = {
  enabled: { type: "boolean" },
  keyword: { type: "string", minLength: 1 },
  interval: { type: "integer", min: 0 },
  maxChecks: { type: "integer", min: 1 },
};

// Fail-fast options parsing: reject invalid values and unknown keys instead of
// silently running on defaults (a typo'd config key would otherwise disable
// the feature invisibly).
export function parseOptions(raw) {
  if (raw === undefined || raw === null) return { ...OPTIONS_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${LOG_PREFIX}: plugin options must be an object (got ${typeof raw})`
    );
  }
  const out = { ...OPTIONS_DEFAULTS };
  for (const key of Object.keys(raw)) {
    if (!(key in OPTION_SPECS)) {
      throw new Error(
        `${LOG_PREFIX}: unknown plugin option "${key}" (allowed: ${Object.keys(OPTION_SPECS).join(", ")})`
      );
    }
    const spec = OPTION_SPECS[key];
    const value = raw[key];
    if (spec.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`${LOG_PREFIX}: option "${key}" must be a boolean`);
      }
    } else if (spec.type === "string") {
      if (typeof value !== "string" || value.length < spec.minLength) {
        throw new Error(
          `${LOG_PREFIX}: option "${key}" must be a string of at least ${spec.minLength} character(s)`
        );
      }
    } else if (spec.type === "integer") {
      if (!Number.isInteger(value) || value < spec.min) {
        throw new Error(
          `${LOG_PREFIX}: option "${key}" must be an integer >= ${spec.min}`
        );
      }
    }
    out[key] = value;
  }
  return out;
}

// Guarded logger (amendment 9: the logging path is a likely thrower; a failed
// log write must never take down a callback).
function makeLogger() {
  return function log(level, message) {
    try {
      const line = `${LOG_PREFIX} [${level}] ${message}`;
      if (level === "error") console.error(line);
      else console.log(line);
    } catch {
      // Logging is non-essential; never propagate a log failure.
    }
  };
}

// Extract the message-relevant view of one transcript entry. The V2
// ctx.session.context() stream yields { info, parts } entries; the decision
// state machine reads info.role, info.finish, info.error and the latest
// compaction part as evidence.
function summarizeTranscript(messages) {
  const entries = Array.isArray(messages) ? messages : [];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const lastInfo = last?.info ?? last;
  const role = typeof lastInfo?.role === "string" ? lastInfo.role : undefined;
  const finish =
    typeof lastInfo?.finish === "string" ? lastInfo.finish : undefined;
  const hasError = lastInfo?.error != null;
  let compactionSeen = false;
  for (const entry of entries) {
    const parts = entry?.parts;
    if (!Array.isArray(parts)) continue;
    if (parts.some((part) => part?.type === "compaction")) {
      compactionSeen = true;
      break;
    }
  }
  return { role, finish, hasError, compactionSeen, lastRoleKnown: role !== undefined };
}

function definePlugin() {
  return {
    id: ID,

    async setup(ctx) {
      if (!ctx || typeof ctx !== "object") {
        throw new Error(
          `${LOG_PREFIX}: setup requires the opencode v2 plugin context (got ${ctx === null ? "null" : typeof ctx})`
        );
      }
      if (!ctx.event || typeof ctx.event.subscribe !== "function") {
        throw new Error(
          `${LOG_PREFIX}: plugin context is missing event.subscribe (opencode v2 plugin API required)`
        );
      }
      if (!ctx.session || typeof ctx.session.prompt !== "function") {
        throw new Error(
          `${LOG_PREFIX}: plugin context is missing session.prompt (opencode v2 plugin API required)`
        );
      }
      if (typeof ctx.session.context !== "function") {
        throw new Error(
          `${LOG_PREFIX}: plugin context is missing session.context (opencode v2 plugin API required)`
        );
      }

      const options = parseOptions(ctx.options);
      const log = makeLogger();

      if (!options.enabled) {
        log(
          "info",
          `disabled by configuration (enabled: false) — no-op; options: keyword=${JSON.stringify(options.keyword)}, interval=${options.interval}, maxChecks=${options.maxChecks}`
        );
        return () => {};
      }

      log(
        "info",
        `enabled — keyword=${JSON.stringify(options.keyword)}, interval=${options.interval}ms, maxChecks=${options.maxChecks}`
      );

      const controller = new AbortController();
      // Per-session decision state: phase (armed → pending → submitted /
      // aborted / exhausted → disarmed), poll tick count, pending timer, and
      // the tracked session status from session.status events.
      const sessions = new Map();

      const dropState = (sessionID) => {
        const state = sessions.get(sessionID);
        if (state?.timer !== undefined) clearTimeout(state.timer);
        sessions.delete(sessionID);
      };

      const dispose = () => {
        for (const sessionID of [...sessions.keys()]) dropState(sessionID);
        controller.abort();
        log("info", "disposed — event subscription aborted, pollers cleared");
      };

      // Schedule the next readiness poll for a tracked session. The interval
      // wait spaces two readiness checks of session state (the ratified
      // polling design); it is not a synchronization sleep elsewhere in the
      // code path.
      const schedulePoll = (sessionID, state) => {
        if (controller.signal.aborted) return;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void pollOnce(sessionID).catch((error) => {
            // Guard (amendment 9): an unexpected failure inside a poll is
            // non-essential to the event stream; log loudly and stop the
            // decision cycle so it can never spin.
            log(
              "error",
              `poll failed for session ${sessionID} (decision cycle aborted): ${describeError(error)}`
            );
            dropState(sessionID);
          });
        }, options.interval);
      };

      // One readiness check. Returns nothing; decides and mutates state.
      const pollOnce = async (sessionID) => {
        const state = sessions.get(sessionID);
        if (!state || state.phase !== "pending") return;
        state.ticks += 1;

        // Readiness check 1: tracked session status. A busy status means the
        // session resumed without this plugin (user input, warming, another
        // plugin) — abort the decision.
        if (state.status === "busy" || state.status === "retry") {
          log(
            "info",
            `decision for session ${sessionID}: ABORT (status=${state.status} — session resumed without continuation)`
          );
          dropState(sessionID);
          return;
        }

        // Readiness check 2: transcript. Non-essential read failures are
        // logged and abort the cycle (never retried blindly).
        let transcript;
        try {
          transcript = await ctx.session.context({ sessionID });
        } catch (error) {
          log(
            "warn",
            `transcript read failed for session ${sessionID} (decision cycle aborted): ${describeError(error)}`
          );
          dropState(sessionID);
          return;
        }
        const summary = summarizeTranscript(transcript);

        // Readiness check 3: no new user input. A user message as the latest
        // transcript entry means input arrived after the model stopped.
        if (summary.role === "user") {
          log(
            "info",
            `decision for session ${sessionID}: ABORT (new user input present — continuation not ours to send)`
          );
          dropState(sessionID);
          return;
        }

        // Readiness check 4: the model actually stopped (a completed
        // assistant message without an error). An unfinished last assistant
        // message is a transient not-ready state — keep polling until
        // maxChecks, then give up.
        const modelStopped =
          summary.role === "assistant" &&
          summary.finish !== undefined &&
          !summary.hasError;
        const notReadyReason =
          summary.role === "assistant" && summary.finish === undefined
            ? "last assistant message not finished yet"
            : summary.hasError
              ? "last assistant message ended in error"
              : summary.lastRoleKnown
                ? `unexpected last message role ${JSON.stringify(summary.role)}`
                : "transcript empty or unreadable";

        if (!modelStopped) {
          if (state.ticks < options.maxChecks) {
            log(
              "info",
              `poll ${state.ticks}/${options.maxChecks} for session ${sessionID}: not ready (${notReadyReason}) — polling again in ${options.interval}ms`
            );
            schedulePoll(sessionID, state);
          } else {
            log(
              "info",
              `decision for session ${sessionID}: GIVE UP (maxChecks=${options.maxChecks} exhausted; last reason: ${notReadyReason})`
            );
            dropState(sessionID);
          }
          return;
        }

        // All readiness checks hold: idle + compaction completed + model
        // stopped + no new input → submit the continuation prompt exactly
        // once for this compaction cycle.
        dropState(sessionID);
        log(
          "info",
          `decision for session ${sessionID}: SUBMIT (compaction completed, model stopped with finish=${JSON.stringify(summary.finish)}, no new input) — submitting prompt ${JSON.stringify(options.keyword)}`
        );
        try {
          await ctx.session.prompt({ sessionID, text: options.keyword });
          log("info", `continuation prompt submitted to session ${sessionID}`);
        } catch (error) {
          // Loud failure (never swallowed): error-level log with the full
          // message. Not rethrown — a throw inside the subscription drain
          // loop fails the live session (SPIKE-2.2 probe C evidence).
          log(
            "error",
            `continuation prompt submission FAILED for session ${sessionID}: ${describeError(error)}`
          );
        }
      };

      const armForCompaction = (sessionID) => {
        const state = sessions.get(sessionID) ?? {
          phase: "disarmed",
          ticks: 0,
          timer: undefined,
          status: undefined,
        };
        if (state.phase === "pending") return; // already mid-decision
        state.phase = "armed";
        sessions.set(sessionID, state);
        log("info", `decision state for session ${sessionID}: ARMED (compaction started)`);
      };

      const disarmForCompaction = (sessionID, reason) => {
        const state = sessions.get(sessionID);
        if (!state) return;
        if (state.phase === "pending") {
          log(
            "info",
            `decision for session ${sessionID}: ABORT (${reason})`
          );
          dropState(sessionID);
        } else {
          dropState(sessionID);
          log(
            "info",
            `decision state for session ${sessionID}: DISARMED (${reason})`
          );
        }
      };

      const handleSessionIdle = (sessionID) => {
        const state = sessions.get(sessionID);
        if (!state || state.phase === "disarmed") {
          log(
            "info",
            `decision for session ${sessionID}: SKIP (session.idle without a preceding compaction — not auto-continued)`
          );
          return;
        }
        if (state.phase === "pending") return; // poller already running
        state.phase = "pending";
        state.ticks = 0;
        log(
          "info",
          `decision for session ${sessionID}: PENDING (idle after compaction) — first readiness poll in ${options.interval}ms`
        );
        schedulePoll(sessionID, state);
      };

      const handleEvent = async (event) => {
        if (!event || typeof event.type !== "string") {
          log("warn", "ignoring malformed event without a type");
          return;
        }
        const sessionID = event.properties?.sessionID;
        switch (event.type) {
          case "session.compaction.started":
            if (typeof sessionID === "string") armForCompaction(sessionID);
            return;
          case "session.compaction.ended":
            if (typeof sessionID === "string") {
              log("info", `compaction ended for session ${sessionID}`);
            }
            return;
          case "session.compaction.failed":
            if (typeof sessionID === "string") {
              disarmForCompaction(sessionID, "compaction failed");
            }
            return;
          case "session.idle":
            if (typeof sessionID === "string") handleSessionIdle(sessionID);
            return;
          case "session.status": {
            if (typeof sessionID !== "string") return;
            const status = event.properties?.status?.type;
            const state = sessions.get(sessionID);
            if (!state) return;
            state.status = status;
            if (
              (status === "busy" || status === "retry") &&
              state.phase === "pending"
            ) {
              log(
                "info",
                `decision for session ${sessionID}: ABORT (session.status=${status} — session resumed without continuation)`
              );
              dropState(sessionID);
            }
            return;
          }
          case "session.deleted":
            if (typeof sessionID === "string") {
              dropState(sessionID);
              log("info", `state dropped for deleted session ${sessionID}`);
            }
            return;
          default:
            return; // uninteresting event type — not logged (stream volume)
        }
      };

      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            signal: controller.signal,
          })) {
            try {
              await handleEvent(event);
            } catch (error) {
              // Guard (amendment 9): a failure while handling one event is
              // non-essential to the stream; log and keep consuming.
              log(
                "error",
                `event handler failed for event ${describeType(event)} (stream continues): ${describeError(error)}`
              );
            }
          }
        } catch (error) {
          if (controller.signal.aborted) {
            log("info", "event subscription ended (disposed)");
          } else {
            log(
              "error",
              `event subscription ended unexpectedly: ${describeError(error)}`
            );
          }
        }
      })();

      return dispose;
    },

    // V1 hosts call server(). No V1 implementation exists or ever shipped
    // for this clean-room package: the V1 half was never published, there
    // are no V1 consumers, and fabricating one is out of contract (R18).
    // V2 hosts never call this entry point.
    async server() {
      throw new Error(
        `${LOG_PREFIX}: not supported — this package ships only the opencode v2 plugin API implementation (setup); no V1 server() implementation exists`
      );
    },
  };
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeType(event) {
  try {
    return JSON.stringify(event?.type ?? null);
  } catch {
    return "unknown";
  }
}

export default definePlugin();
