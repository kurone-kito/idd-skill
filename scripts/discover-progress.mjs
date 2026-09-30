// idd-generated-from: src/scripts/discover-progress.mts
//
// The scripts/discover-progress.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Operator-visible progress and safe recovery for the annotated
// `discover-roadmap-graph --all-roadmaps` scan (kurone-kito/idd-skill#3598).
//
// Three small pieces live here, none of which touch GitHub themselves:
//
// - a phase/count tracker that writes rate-bounded progress lines through an
//   injected writer (the CLI wires stderr, so stdout stays machine-readable);
// - a classifier that recognizes the only three failures a scan may report as
//   "interrupted" (a rate limit, a timeout, an admission deadline) and reads
//   any retry time from the existing admission contract (#3586) and request
//   observations (#3585) instead of new regexes;
// - the incomplete result a caller gets back instead of a report.
//
// Everything written or returned here is an enum, an integer, or an ISO
// time. No token, issue body, comment body, title, or raw error text is ever
// copied through: an error is reduced to a `reason` and an optional retry
// time, and the raw message is dropped.
import {
  classifyThrottle,
  MAX_COOLDOWN_MS,
} from './github-api-load-control.mjs';
import { observeGhFailure } from './github-api-observation.mjs';
import { findLoadControlRefusal } from './github-api-refusal.mjs';
/** Default gap between in-phase progress lines. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 2000;
/**
 * Exit code of a run that printed an incomplete result. `75` is sysexits'
 * `EX_TEMPFAIL` ("temporary failure, the user is invited to retry"); it
 * collides with none of the other helper gate codes (`1`-`4`).
 */
export const DISCOVER_INCOMPLETE_EXIT_CODE = 75;
function normalizeIntervalMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_PROGRESS_INTERVAL_MS;
}
/**
 * Create the phase/count tracker of one scan. Without a `write` it only keeps
 * state (the recovery path still needs the counts); with one it also prints
 * bounded progress lines. Phase boundaries always print; in-phase updates are
 * limited to one per `minIntervalMs`, so the output never grows with the
 * number of low-level requests. It is event-driven: nothing prints while a
 * single blocked request is still running.
 */
export function createDiscoverProgress(options = {}) {
  const write = options.write;
  const now = options.now ?? Date.now;
  const minIntervalMs = normalizeIntervalMs(options.minIntervalMs);
  const helper = options.helper ?? 'discover-roadmap-graph';
  const startedAt = now();
  let phase = null;
  let lastCompletedPhase = null;
  let counts = {
    unit: 'roots',
    completed: 0,
    known: null,
    leavesKnown: null,
  };
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let closed = false;
  const emit = (event, extra = {}) => {
    if (write === undefined || closed || phase === null) {
      return;
    }
    const at = now();
    lastEmitAt = at;
    const line = JSON.stringify({
      iddProgress: {
        helper,
        event,
        phase,
        unit: counts.unit,
        completed: counts.completed,
        known: counts.known,
        leavesKnown: counts.leavesKnown,
        elapsedMs: Math.max(0, Math.round(at - startedAt)),
        ...extra,
      },
    });
    try {
      write(`${line}\n`);
    } catch {
      // A writer that throws must never fail the scan it describes. (A
      // stream's asynchronous error event is outside this try; the helper's
      // other stderr writes carry the same exposure.)
    }
  };
  return {
    begin(nextPhase, unit, known) {
      phase = nextPhase;
      counts = { unit, completed: 0, known, leavesKnown: counts.leavesKnown };
      emit('start');
    },
    advance() {
      counts = { ...counts, completed: counts.completed + 1 };
      if (now() - lastEmitAt >= minIntervalMs) {
        emit('progress');
      }
    },
    setKnown(known) {
      counts = { ...counts, known };
    },
    setLeavesKnown(leavesKnown) {
      counts = { ...counts, leavesKnown };
    },
    complete() {
      lastCompletedPhase = phase;
      // A finished phase has done everything it knew about, including a batch
      // phase that never counts items one by one.
      if (counts.known !== null) {
        counts = { ...counts, completed: counts.known };
      }
      emit('complete');
    },
    interrupted(reason) {
      // A failure before the first phase began (the repository lookup that
      // precedes the scan) is still an interrupted root discovery, so the
      // operator sees it on stderr too.
      if (phase === null) {
        phase = 'root-discovery';
      }
      emit('interrupted', { reason });
    },
    snapshot() {
      return { phase, lastCompletedPhase, counts: { ...counts } };
    },
    close() {
      closed = true;
    },
  };
}
const MAX_CAUSE_DEPTH = 8;
function causeLinks(error) {
  const links = [];
  let current = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined;
    depth += 1
  ) {
    links.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return links;
}
function isoOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
/**
 * Retry time from one throttled failure's own observation: a `retry-after`
 * (seconds from now) wins, else a primary quota reset (epoch seconds). Both
 * are clamped to the same one-hour ceiling the cooldown layer honors, and a
 * reset that has already passed reports nothing rather than a past time.
 */
function throttleRetryAt(observation, nowMs) {
  const { retryAfter, reset } = observation;
  let untilMs = null;
  if (typeof retryAfter === 'number' && retryAfter >= 0) {
    untilMs = nowMs + retryAfter * 1000;
  } else if (typeof reset === 'number' && reset * 1000 > nowMs) {
    untilMs = reset * 1000;
  }
  if (untilMs === null) {
    return null;
  }
  return {
    retryAt: new Date(Math.min(untilMs, nowMs + MAX_COOLDOWN_MS)).toISOString(),
    retryAtSource: 'server',
  };
}
function failureStreams(link) {
  const candidate = link;
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const stdout = typeof candidate?.stdout === 'string' ? candidate.stdout : '';
  return stderr === '' && stdout === '' ? null : { stderr, stdout };
}
/**
 * Whether captured stdout is a GraphQL response body (top-level `data` or
 * `errors`). A GraphQL body can carry user content under `data`, such as a
 * comment that quotes a rate-limit phrase, so the observation must read only
 * its error entries and never the whole body. A REST error body has neither
 * key and keeps its full-text scan, which is where the headers appear.
 */
function isGraphqlBody(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) {
    return false;
  }
  try {
    const root = JSON.parse(stdout.slice(start));
    return (
      typeof root === 'object' &&
      root !== null &&
      ('data' in root || 'errors' in root)
    );
  } catch {
    return false;
  }
}
function isTimeoutLink(link) {
  const candidate = link;
  const code = candidate?.code;
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return true;
  }
  // A child Node killed on its own timeout has `killed: true` and no string
  // `code`; a string `code` (for example a stdio buffer overflow) is a
  // different failure and must not read as a timeout.
  return candidate?.killed === true && typeof code !== 'string';
}
/**
 * Decide whether `error` is one of the three failures a scan reports as an
 * interruption, and read its retry time when the failure exposes one. Any
 * other error (authentication, a 5xx, a missing issue, a defect) returns
 * `null` so the caller rethrows it unchanged, as before.
 *
 * Order matters: a load-control refusal is the admission contract's own
 * verdict and carries its own timing; an explicit throttle reading comes
 * next; a timeout is last. The whole `cause` chain is inspected because the
 * provider adapter wraps transport failures. The raw message is never read.
 */
export function classifyDiscoverInterruption(error, nowMs) {
  const refusal = findLoadControlRefusal(error);
  if (refusal !== undefined) {
    const retryAt = isoOrNull(refusal.retryAt);
    return {
      // A cooldown is the rate limit itself, even when the refusal came from
      // an expired wait deadline; only a full slot is a plain deadline.
      reason: refusal.reason === 'cooldown' ? 'rate-limit' : 'deadline',
      retryAt,
      retryAtSource:
        retryAt !== null ? (refusal.retryAtSource ?? 'server') : null,
    };
  }
  const links = causeLinks(error);
  for (const link of links) {
    const streams = failureStreams(link);
    if (streams === null) {
      continue;
    }
    const observation = observeGhFailure(streams, {
      graphql: isGraphqlBody(streams.stdout),
    });
    if (classifyThrottle(observation, streams) !== null) {
      const timing = throttleRetryAt(observation, nowMs);
      return {
        reason: 'rate-limit',
        retryAt: timing?.retryAt ?? null,
        retryAtSource: timing?.retryAtSource ?? null,
      };
    }
  }
  if (links.some(isTimeoutLink)) {
    return { reason: 'timeout', retryAt: null, retryAtSource: null };
  }
  return null;
}
export function buildDiscoverIncompleteResult(
  snapshot,
  interruption,
  rerunArguments,
) {
  return {
    mode: 'all-roadmaps',
    status: 'incomplete',
    incomplete: {
      reason: interruption.reason,
      phase: snapshot.phase ?? 'root-discovery',
      lastCompletedPhase: snapshot.lastCompletedPhase,
      counts: snapshot.counts,
      retryAt: interruption.retryAt,
      retryAtSource: interruption.retryAtSource,
      exhausted: false,
      recovery: {
        safeToRerun: true,
        sameArguments: true,
        notBefore: interruption.retryAt,
        ...(rerunArguments ? { arguments: [...rerunArguments] } : {}),
      },
    },
  };
}
/** Whether a computed report is the incomplete result rather than a report. */
export function isDiscoverIncompleteResult(value) {
  return (
    typeof value === 'object' && value !== null && value.status === 'incomplete'
  );
}
