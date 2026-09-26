// idd-generated-from: src/scripts/advisory-convergence-identity.mts
//
// The scripts/advisory-convergence-identity.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Shared `idd-advisory-convergence` producer-identity and triggering-event
// resolution. Pre-merge readiness and the #3465 watermark gate both need
// the same two downgrades (`identity unresolved`, `non-target event only`);
// keeping the algorithm here stops either caller from growing a second copy.
import { DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR } from './advisory-wait-policy.mjs';
import {
  CHECK_PASS_EQUIVALENT_STATES,
  selectLatestCheckInstance,
} from './protocol-helpers.mjs';
import { parseRunIdFromUrl } from './rerun-advisory-convergence.mjs';

const MAX_ADVISORY_CONVERGENCE_WORKFLOW_PATH_LOOKUPS = 50;
/**
 * Resolve workflow-file path and triggering event for every live
 * `idd-advisory-convergence` check-run, then report the two readiness
 * downgrades pre-merge already applies (#2919, #3256).
 *
 * `listPaths` is called only when at least one advisory instance has a
 * parseable run id and every advisory instance does (a mixed set, a
 * lookup failure, a duplicate `detailsUrl`, or a missing path/event is
 * identity-unresolved for the whole check name). A check name with no
 * parseable run id at all stays permissive: there was no identity
 * evidence to resolve. `nonTargetEventOnly` is true only when resolution
 * succeeded, at least one producer group's selected representative is
 * pass-equivalent, and none of those representatives is a
 * `pull_request_target` pass.
 */
export function resolveAdvisoryConvergenceIdentitySignals(checks, listPaths) {
  const empty = {
    identityUnresolved: false,
    nonTargetEventOnly: false,
    workflowPathByIndex: new Map(),
    workflowEventByIndex: new Map(),
  };
  const advisoryEntries = checks
    .map((check, index) => ({ check, index }))
    .filter(
      ({ check }) =>
        check.type === 'check-run' &&
        check.name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
    );
  if (advisoryEntries.length === 0) {
    return empty;
  }
  const runIdsByIndex = new Map();
  for (const { check, index } of advisoryEntries) {
    const runId = parseRunIdFromUrl(check.detailsUrl);
    if (runId) {
      runIdsByIndex.set(index, runId);
    }
  }
  if (runIdsByIndex.size === 0) {
    return empty;
  }
  if (runIdsByIndex.size < advisoryEntries.length) {
    return { ...empty, identityUnresolved: true };
  }
  const uniqueRunIds = [...new Set(runIdsByIndex.values())];
  if (uniqueRunIds.length > MAX_ADVISORY_CONVERGENCE_WORKFLOW_PATH_LOOKUPS) {
    return { ...empty, identityUnresolved: true };
  }
  let associations = [];
  try {
    associations = listPaths();
  } catch {
    return { ...empty, identityUnresolved: true };
  }
  const pathByDetailsUrl = new Map();
  const eventByDetailsUrl = new Map();
  const duplicateDetailsUrls = new Set();
  for (const association of associations) {
    if (pathByDetailsUrl.has(association.detailsUrl)) {
      duplicateDetailsUrls.add(association.detailsUrl);
    } else {
      pathByDetailsUrl.set(association.detailsUrl, association.workflowPath);
      eventByDetailsUrl.set(association.detailsUrl, association.event);
    }
  }
  const rollupDetailsUrlCounts = new Map();
  for (const { check } of advisoryEntries) {
    rollupDetailsUrlCounts.set(
      check.detailsUrl,
      (rollupDetailsUrlCounts.get(check.detailsUrl) ?? 0) + 1,
    );
  }
  const workflowPathByIndex = new Map();
  const workflowEventByIndex = new Map();
  for (const { check, index } of advisoryEntries) {
    const path = pathByDetailsUrl.get(check.detailsUrl);
    const event = eventByDetailsUrl.get(check.detailsUrl);
    if (
      duplicateDetailsUrls.has(check.detailsUrl) ||
      (rollupDetailsUrlCounts.get(check.detailsUrl) ?? 0) > 1 ||
      !path ||
      !event
    ) {
      return { ...empty, identityUnresolved: true };
    }
    workflowPathByIndex.set(index, path);
    workflowEventByIndex.set(index, event);
  }
  const groups = new Map();
  for (const { check, index } of advisoryEntries) {
    const type = check.type ? String(check.type).trim() : '';
    const workflowName = check.workflowName
      ? String(check.workflowName).trim()
      : '';
    const path = workflowPathByIndex.get(index) ?? '';
    const key = `${type}\0${workflowName}\0${path}`;
    const entry = {
      state: String(check.state ?? '').toUpperCase(),
      completedAt: check.completedAt,
      event: workflowEventByIndex.get(index) ?? '',
    };
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  const selected = [...groups.values()].map((group) =>
    selectLatestCheckInstance(group),
  );
  const hasPassEquivalent = selected.some((item) =>
    CHECK_PASS_EQUIVALENT_STATES.has(item.state),
  );
  const hasQualifyingTargetPass = selected.some(
    (item) =>
      CHECK_PASS_EQUIVALENT_STATES.has(item.state) &&
      item.event === 'pull_request_target',
  );
  return {
    identityUnresolved: false,
    nonTargetEventOnly: hasPassEquivalent && !hasQualifyingTargetPass,
    workflowPathByIndex,
    workflowEventByIndex,
  };
}
