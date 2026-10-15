#!/usr/bin/env node
// idd-generated-from: src/scripts/publish-authoring-hold.mts
//
// The scripts/publish-authoring-hold.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Capability-checked Stage 1 publication of one held issue: a standalone
// orphan (kurone-kito/idd-skill#4127), a draft carrier (#4253), a roadmap
// shell, or a child under an existing set anchor (#4251). The
// issue-authoring skill allows a new issue only through a create-with-label
// command and stops when none exists. This
// helper runs the contract's "New-issue ownership" sequence in order: journal
// check, publication line, lint, labels, pending intent, create, identity
// attach, owner marker, provenance, member. It spawns the sibling helpers
// (audit-authored-issue, post-idd-marker, authoring-owner-provenance) rather
// than reimplementing their checks. It never runs a review or a close. A
// roadmap is its own set anchor, like an orphan. A child needs `--anchor`:
// it joins the anchor's set (the anchor's set id and session, the anchor's
// real reference in its markers), with a same-owner anchor heartbeat before
// its own owner marker, and never edits the anchor's body. For a
// draft carrier it then runs the carrier release (contract.md, "Carrier
// creation-hold exception"). A failed marker post is uncertain unless the
// child's error envelope proves that nothing was sent (#4171).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateAuthoringOwnerProvenance,
  fetchProvenanceCommentsGraphql,
  inspectLastEditedAt,
  looksLikeOwnerMarker,
  sameIssueRef,
} from './authoring-owner-provenance.mjs';
import { isOutdatedMinimized } from './authoring-set-members.mjs';
import { resolveBundleRoot } from './bundle-root.mjs';
import { parseCliArgs } from './cli-args.mjs';
import {
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mjs';
import { ghApiJson, ghText, resolveViewerLogin } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { readRepositoryPolicyFile } from './idd-config.mjs';
import { resolveOpenLinkedPrIssues } from './idd-roadmap-audit-execute.mjs';
import { maskMarkdownCodeRegionsPreservingPositions } from './markdown-code.mjs';
import {
  normalizeMarkerPrefix,
  parseAuthoringOwnerComment,
  parseAuthoringPublicationComment,
  parseAuthoringPublicationIntentComment,
} from './marker-helpers.mjs';
import {
  AUTHORING_JOURNAL_REFERENCE_PATTERN,
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
import {
  validateAuthoringOwnerModeDigestCoupling,
  validateAuthoringOwnerSupersedesModeCoupling,
} from './post-idd-marker.mjs';
import {
  readClaimStaleAgeMs,
  resolveActiveClaimForWriteGate,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
export const PUBLISH_BUCKETS = ['ready', 'needs-decision', 'blocked-by-human'];
/** The shapes this command publishes (#4127, #4253, #4251). */
const PUBLISH_SHAPES = ['orphan', 'carrier', 'roadmap', 'child'];
const PUBLISH_AUTHORING_HOLD_FLAG_SPEC = {
  '--title': { type: 'string' },
  '--body-file': { type: 'string' },
  '--review-result': { type: 'string' },
  '--shape': { type: 'string', default: 'orphan' },
  '--anchor': { type: 'string' },
  '--bucket': { type: 'string', default: 'ready' },
  '--apply': { type: 'boolean' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--marker-prefix': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** The transitions an exact-token publication-intent record may make. Declared
 * above the entry-point call, so it is initialized when the CLI runs. */
const INTENT_TRANSITIONS = {
  pending: ['pending', 'member', 'cleanup'],
  member: ['cleanup'],
  cleanup: ['abandoned'],
  abandoned: [],
};
/** A record that may have been posted but could not be verified: replay the
 * journal to learn its state. */
const JOURNAL_STATE_UNCERTAIN = 'uncertain: replay the journal';
/** HTTP statuses that, on the post's first attempt, prove nothing landed
 * (the retry layer never reports them after a later attempt, #4171). */
const NOTHING_SENT_HTTP_STATUSES = new Set([401, 404, 422]);
/** The release steps in order; a dry run lists them as planned. */
export const CARRIER_RELEASE_PLAN = [
  'release-preflight',
  'release-guard',
  'preconditions',
  'heartbeat',
  'label-removal',
  'release-complete',
  'closing-sweep',
];
const CARRIER_READ_ATTEMPTS = 3;
const CARRIER_SWEEP_DEADLINE_MS = 300_000;
const CARRIER_HELD_NEXT_ACTION =
  "A person's release is required. The labels are left in place, and any release, release-guard, or heartbeat marker already posted stays for that release to reuse.";
const CARRIER_RECOVERY_NEXT_ACTION =
  "Replay the carrier's owner-marker log and the journal's publication-intent log before any release. Do not release from this report.";
/** Heartbeat coalescing: only these modes may be reused (contract.md). */
const COALESCING_MODES = new Set([
  'acquire',
  'bootstrap',
  'resume',
  'heartbeat',
]);
/** Stops the carrier release at a named step: `held` keeps the labels for a
 * person's release, `recovery-hold` needs an owner-log replay first. Declared
 * above the entry-point call, so the class is initialized when the CLI runs. */
class CarrierReleaseStop extends Error {
  state;
  failedStep;
  constructor(state, failedStep, message) {
    super(message);
    this.state = state;
    this.failedStep = failedStep;
  }
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('publish-authoring-hold', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
export function generatePublicationIds(uuid = randomUUID) {
  const target = `target-${uuid()}`;
  return {
    target,
    anchor: target,
    set: `set-${uuid()}`,
    session: `session-${uuid()}`,
    token: `token-${uuid()}`,
    owner: `owner-${uuid()}`,
  };
}
/**
 * The ids of a child published under an existing set anchor (#4251). Its
 * `target`, token and per-target owner are new. Its `anchor` is the anchor's
 * real reference, not an opaque id, and its `set` and `session` are the
 * anchor's, because every marker of a set repeats the same set, anchor and
 * owning session (contract.md, "Per-target ownership").
 */
export function generateChildPublicationIds(anchor, uuid = randomUUID) {
  return {
    target: `target-${uuid()}`,
    anchor: anchor.ref,
    set: anchor.set,
    session: anchor.session,
    token: `token-${uuid()}`,
    owner: `owner-${uuid()}`,
  };
}
/** The exact HTML-first body line of contract.md's "New-issue ownership". */
export function renderPublicationLine(markerPrefix, ids) {
  return `<!-- ${markerPrefix}-authoring-publication: target=${ids.target}; anchor=${ids.anchor}; set=${ids.set}; session=${ids.session}; token=${ids.token} -->`;
}
/**
 * Put the publication line first, followed by one blank line and the draft.
 * Throws when the draft already carries a publication line (the command owns
 * the ids, so a second line would make the token ambiguous) or when the
 * injected line does not parse back to the same ids.
 */
export function injectPublicationLine(body, markerPrefix, ids) {
  if (
    body
      .toLowerCase()
      .includes(`${markerPrefix.toLowerCase()}-authoring-publication:`)
  ) {
    throw new Error(
      'the body already carries an authoring-publication line; pass the draft without it',
    );
  }
  const injected = `${renderPublicationLine(markerPrefix, ids)}\n\n${body}`;
  const parsed = parseAuthoringPublicationComment(injected, markerPrefix);
  if (
    parsed === null ||
    parsed.target !== ids.target ||
    parsed.anchor !== ids.anchor ||
    parsed.set !== ids.set ||
    parsed.session !== ids.session ||
    parsed.token !== ids.token
  ) {
    throw new Error('the injected authoring-publication line does not parse');
  }
  return injected;
}
/**
 * For an orphan, check the review-result file contents. It must be a JSON
 * object with `"completed": true`. An optional `findings` array holds
 * findings-ledger entries; each needs a `disposition` of `fixed` or
 * `rejected`, because a draft with an open `deferred` entry is not published
 * (contract.md, "Carry-forward of rejected findings"). Returns a refusal
 * reason, or null.
 */
export function checkReviewResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'the review result is not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'the review result is not a JSON object';
  }
  const record = parsed;
  if (record.completed !== true) {
    return 'the review result does not record a completed review ("completed": true)';
  }
  if (record.findings === undefined) {
    return null;
  }
  if (!Array.isArray(record.findings)) {
    return 'the review result "findings" is not an array';
  }
  for (const [index, entry] of record.findings.entries()) {
    const disposition =
      entry !== null && typeof entry === 'object'
        ? entry.disposition
        : undefined;
    if (disposition !== 'fixed' && disposition !== 'rejected') {
      return `review finding ${index} has disposition ${JSON.stringify(disposition ?? null)}; every finding must be fixed or rejected before publication`;
    }
  }
  return null;
}
/**
 * Check a draft carrier's review-result file. A carrier publishes on the lint
 * alone, because each draft's `Review:` line records its own review state, so
 * the file only has to be a JSON object whose `completed` is a boolean (false
 * is accepted) and whose `findings`, when present, is an array of objects.
 * Findings dispositions are not checked: a carrier holds drafts whose review
 * may be incomplete. Returns a refusal reason, or null.
 */
export function checkCarrierReviewResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'the review result is not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'the review result is not a JSON object';
  }
  const record = parsed;
  if (typeof record.completed !== 'boolean') {
    return 'the review result does not record whether the review completed ("completed": true or false)';
  }
  if (record.findings === undefined) {
    return null;
  }
  if (
    !Array.isArray(record.findings) ||
    record.findings.some(
      (entry) =>
        entry === null || typeof entry !== 'object' || Array.isArray(entry),
    )
  ) {
    return 'the review result "findings" is not an array of objects';
  }
  return null;
}
/**
 * The linter argv for the injected body. A ready orphan publish passes neither
 * `--expect-bucket` nor `--label`; a non-ready orphan publish passes the bucket
 * and one `--label` for each configured label. A carrier passes one `--label`
 * for each configured label and never a bucket.
 */
export function buildLintArgs(input) {
  const args = [
    '--shape',
    input.shape,
    '--new-issue',
    '--title',
    input.title,
    '--body-file',
    input.bodyFile,
    '--marker-prefix',
    input.markerPrefix,
    '--current-repo',
    input.currentRepo,
  ];
  if (input.policy) {
    args.push('--config', input.policy);
  }
  if (input.shape === 'carrier') {
    // audit-authored-issue refuses --expect-bucket with --shape carrier (#4250).
    for (const label of input.labels) {
      args.push('--label', label);
    }
  } else if (input.bucket !== 'ready') {
    args.push('--expect-bucket', input.bucket);
    for (const label of input.labels) {
      args.push('--label', label);
    }
  }
  return args;
}
/**
 * The labels one publish applies. An orphan takes the authoring label, plus the
 * bucket label for a non-ready publish. A draft carrier (#4253) has no bucket
 * and takes the authoring label and the authoring-only label (#4250), which
 * keeps Discover from claiming it. The authoring label stays at index 0.
 */
export function resolvePublishLabels(config, bucket, shape = 'orphan') {
  const normalized = normalizePolicyConfig(config);
  const labels = [normalized.issueAuthoring.authoringLabelName];
  if (shape === 'carrier') {
    labels.push(normalized.labels.authoringOnlyLabelName);
    return labels;
  }
  if (bucket === 'needs-decision') {
    labels.push(normalized.labels.needsDecisionLabelName);
  } else if (bucket === 'blocked-by-human') {
    labels.push(normalized.labels.blockedByHumanLabelName);
  }
  return labels;
}
/** Parse an `owner/repo#number` reference (the configured journal, or the
 * `--anchor` of a child), or null when unset or malformed. */
export function parseJournalReference(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = AUTHORING_JOURNAL_REFERENCE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) {
    return null;
  }
  return { owner: match[1], repo: match[2], number, ref: value };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/publish-authoring-hold.mjs --title <text> --body-file <path> [--review-result <path>] [--shape orphan|carrier|roadmap|child] [--anchor <owner>/<repo>#<number>] [--bucket ready|needs-decision|blocked-by-human] [--owner <owner> --repo <repo>] [--policy <path>] [--marker-prefix <prefix>] [--apply]

Publishes one drafted issue under the issue-authoring hold, running
contract.md's "New-issue ownership" steps in order. The default shape,
orphan, publishes one standalone held orphan. --shape carrier publishes a
draft carrier: an issue that holds drafts which cannot be published as
their final issues yet. --shape roadmap publishes one held roadmap shell;
an empty Tracks list is valid, and it is its own set anchor, like an
orphan. --shape child publishes one held child under an existing set: it
needs --anchor, the anchor's owner/repo#number, which must be an issue in
the same repository. Every other shape refuses --anchor (exit 2). One call
publishes one issue; a child call never edits the anchor's body, so the
roadmap's Tracks list stays a separate reviewed edit.

  1. check the usage (a child needs --anchor and no other shape takes it),
     then check the review result file: required for an orphan, a roadmap
     and a child, and optional for a carrier (when given, it is checked as
     described below). An --anchor in another repository exits 2 as soon
     as the repository is resolved, before anything is written;
  2. check issueAuthoring.journalIssue in the repository policy file: it
     must be set, match owner/repo#N, and name an existing issue (it may be
     closed). Otherwise report the blocked-by-human outcome and exit 2;
  3. generate the opaque target, anchor (= target), set, session, token and
     owner ids and put the authoring-publication line first in the body. A
     child instead takes the anchor's own set and session, uses the
     anchor's real reference as its anchor, and generates only its own
     target, token and owner ids. Before that, the anchor must pass a
     read-only check (a dry run does it too): an open issue, not a pull
     request, that still has the authoring label, no active claim and no
     open linked pull request, whose trusted unedited owner-marker log
     replays to one open generation (every marker follows the field rules
     of its mode; no release in progress, no second opener, no reuse of a
     completed set; a resume keeps a release in progress). The token of
     the anchor's own publication line must also replay to state=member in
     the journal (trusted, unedited records that match the line on target,
     anchor, set, session and token, in order, with a conflicting or
     out-of-order record failing closed), which is how the set's
     originating hold is verified. Otherwise the report is a refusal and
     nothing is written. The command does not serialize concurrent calls
     of one session, so publish the children of a set one call at a time
     (preventive; no observed incident yet);
  4. lint that exact body with audit-authored-issue --new-issue (a
     non-ready bucket adds the expected bucket and one label flag per
     configured label; a carrier adds one label flag per configured label
     and no bucket, and needs markdown-it, so without it nothing is
     written);
  5. resolve the authoring label (issueAuthoring.authoringLabelName) and,
     for a non-ready bucket, labels.needsDecisionLabelName or
     labels.blockedByHumanLabelName, or for a carrier
     labels.authoringOnlyLabelName; create a missing label;
  6. append the pending publication-intent record (issue=none) to the
     journal through post-idd-marker and read it back;
  7. create the issue with every label in one gh issue create call;
  8. attach the returned identity to the pending record, append the
     mode=acquire owner marker, wait claim.verifySettleDelay, run
     authoring-owner-provenance, re-read labels, body and claim state,
     and only then append state=member. For a child, an anchor heartbeat
     comes first: a same-owner heartbeat marker on the anchor (a fresh
     matching marker is reused under issueAuthoring.heartbeatCoalesceWindow),
     the settle wait, and a replay of the anchor's log that must show the
     same owner, set and session. The child's owner marker then carries the
     anchor's reference, provenance runs in process with that anchor
     expected, and the anchor and the child are read again before member;
     a changed anchor owner stops there. A failed heartbeat is a recovery
     hold with the child held;
  9. for --shape carrier only, the carrier release (contract.md, "Carrier
     creation-hold exception"): the release, release-guard, heartbeat,
     release-complete markers, the preconditions, one label removal of the
     authoring label, three sweeps and their minimization-backlog counts. The
     authoring-only label stays. The report's release object carries state
     (released, held or recovery-hold), failedStep, nextAction, sweeps and
     backlog.

Every policy value (the journal, the marker prefix, the label names, the
trusted marker actors and claim.verifySettleDelay) comes from the
repository's own policy file (--policy, or .github/idd/config.json), never
from a user-global layer, because each describes the target repository.
The marker prefix comes from that file only when the issue and the journal
are both in this checkout's repository. Otherwise pass --marker-prefix
with the prefix the target repository configures.

With --apply, before any write, the authenticated login must be listed in
the repository policy file's trustedMarkerActors (no flag or environment
variable can replace that list, because the records this command writes
are trusted by it later) and, unless it is a bot, hold Write, Maintain or
Admin permission on the issue's and the journal's repositories. A dry run
makes neither check.

For an orphan, a roadmap and a child, the review result file is a JSON object
with "completed": true. An optional "findings" array holds findings-ledger
entries, and each needs a disposition of fixed or rejected. For a carrier, --review-result is optional.
When it is given, the file must be a JSON object whose "completed" is true or
false, and any "findings" must be an array of objects; the findings are not
checked, because a carrier holds drafts whose review may be incomplete. The
file is not tied to the body; the caller keeps it for the reviewed draft.

A carrier takes only --bucket ready, its default, because it has no readiness
bucket; any other bucket exits 2 before anything is read. It is labelled with
the authoring label and labels.authoringOnlyLabelName, which must be different
names. After state=member it runs the carrier release: the authoring label is
removed only when every precondition holds, and the authoring-only label stays.
A held outcome leaves the carrier held for a person's release and exits 0; a
recovery-hold exits 1.

Without --apply this is a dry run: it makes the read-only checks, the lint
and the label lookups, prints the planned steps, and writes nothing.

A failed post-idd-marker --apply sent nothing only when its iddHelperError
envelope reports notDispatched, or HTTP status 401, 404 or 422. Then the
report carries "nothingSent": true. Any other failure is uncertain:
"nothingSent": false, and a journal record's state is "uncertain: replay
the journal" (an owner marker's is "ownerMarker": "uncertain"). Before the
create, the report adds "retry": "permitted" after a nothing-sent failure,
or "retry": "replay the journal first" after an uncertain one; an
uncertain pending record stops before the create, so no second
publication-intent record and no issue are written. After the create,
never rerun the command: it would create a second issue.

A failure after the create prints a recovery-hold JSON object with the
created issue, the failed step and the last journal state, and exits 1.
That state is pending, or "uncertain: replay the journal" when a record
may have been posted but could not be verified. The issue keeps its
labels and is never closed. The Stage 2 release of an orphan, a roadmap or a
child stays a separate, explicit request; a carrier's release runs after
member, as described above.

Exit codes: 0 published (or planned; a carrier whose release is held also
exits 0), 1 refused, failed, or a recovery hold (a carrier release that stops
at a recovery hold; an unusable anchor), 2 usage error, a child without a
valid --anchor in the issue's repository, --anchor on another shape, a
carrier with a bucket other than ready, or the blocked-by-human journal stop.
`);
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, PUBLISH_AUTHORING_HOLD_FLAG_SPEC);
  const text = (key) => (values[key] ?? '').trim();
  return {
    title: text('title'),
    bodyFile: values['body-file'] ?? '',
    reviewResult: values['review-result'] ?? '',
    reviewResultGiven: values['review-result'] !== undefined,
    shape: text('shape'),
    anchor: text('anchor'),
    anchorGiven: values.anchor !== undefined,
    bucket: text('bucket'),
    apply: values.apply === true,
    owner: text('owner'),
    repo: text('repo'),
    policy: values.policy ?? '',
    markerPrefix: text('marker-prefix'),
    help,
  };
}
function usage(message) {
  process.stderr.write(`publish-authoring-hold: ${message}\n`);
  return { exitCode: 2, kind: 'usage', message };
}
function refuse(message, report = {}) {
  process.stdout.write(
    `${JSON.stringify({ outcome: 'refused', reason: message, ...report }, null, 2)}\n`,
  );
  process.stderr.write(`publish-authoring-hold: ${message}\n`);
  return { exitCode: 1, kind: 'gate', message };
}
/** Synchronous wait for the settle delay. */
function sleepMs(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}
function runSiblingHelper(script, args, env = process.env) {
  const root = resolveBundleRoot(import.meta.dirname);
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', script), ...args],
    { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
function parseJsonOutput(run) {
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
/**
 * True only when a failed `post-idd-marker --apply` run reports that nothing
 * was sent: the last stderr line is its `iddHelperError` envelope, and it
 * carries `notDispatched: true` (load control refused the request before any
 * `gh` process started) or `httpStatus` 401, 404 or 422 (rejected; the retry
 * layer reports these only for a first attempt, #4171). Every other failure,
 * including a missing or unparseable envelope, may have landed (option 1 of
 * #4171), so the caller treats it as uncertain.
 */
export function markerPostSentNothing(stderr) {
  const last = stderr.trimEnd().split('\n').pop() ?? '';
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return false;
  }
  const envelope = parsed?.iddHelperError;
  if (
    envelope === undefined ||
    envelope === null ||
    typeof envelope !== 'object' ||
    envelope.helper !== 'post-idd-marker'
  ) {
    return false;
  }
  return (
    envelope.notDispatched === true ||
    (typeof envelope.httpStatus === 'number' &&
      NOTHING_SENT_HTTP_STATUSES.has(envelope.httpStatus))
  );
}
function helperFailure(name, run) {
  const lines = (run.stderr.trim() || run.stdout.trim()).split('\n');
  let detail = lines.pop();
  // A requested envelope is the last line; its message names the error,
  // where the line before it may be a stack frame.
  try {
    const message = JSON.parse(detail ?? '').iddHelperError?.message;
    if (typeof message === 'string' && message !== '') {
      detail = message;
    }
  } catch {
    // Not an envelope: keep the line as it is.
  }
  return `${name} exited ${run.status ?? 'without a status'}${detail ? `: ${detail}` : ''}`;
}
function readIssue(owner, repo, number) {
  const raw = ghApiJson(`repos/${owner}/${repo}/issues/${number}`);
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`${owner}/${repo}#${number} is not a readable issue`);
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label) =>
          typeof label === 'string' ? label : String(label?.name ?? ''),
        )
        .filter((name) => name !== '')
    : [];
  return {
    labels,
    body: typeof raw.body === 'string' ? raw.body : '',
    pullRequest: raw.pull_request != null,
    state: typeof raw.state === 'string' ? raw.state : '',
  };
}
function hasLabel(labels, name) {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}
function labelExists(owner, repo, name) {
  try {
    ghApiJson(`repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    return true;
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return false;
    }
    throw error;
  }
}
/** Write, Maintain or Admin on the repository; an unreadable permission is
 * false (fail closed). */
function hasWritePermission(owner, repo, login, cache) {
  const { permission, roleName } = collaboratorPermission(
    owner,
    repo,
    login,
    cache,
  );
  return (
    ['admin', 'maintain', 'write'].includes(roleName) ||
    permission === 'admin' ||
    permission === 'write'
  );
}
/** True when the comments carry an active claim, resolved with the same
 * write-gate resolver the review helpers use: a released claim does not
 * count, a forced-handoff successor does when the repository enables forced
 * handoffs, and a claim marker whose edit state is unknown throws (fail
 * closed). The caller has already refused to run with no trusted login. */
function hasActiveClaim(comments, gate) {
  const trustedSet = new Set(gate.trusted.map((login) => login.toLowerCase()));
  const policyPath = gate.policyPath || undefined;
  const authorityPolicy = readForcedHandoffAuthorityPolicy(policyPath);
  const permissionCache = new Map();
  return (
    resolveActiveClaimForWriteGate(
      comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: { login: comment.authorLogin },
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
      })),
      {
        isTrustedAuthor: (login) => trustedSet.has(login.trim().toLowerCase()),
        forcedHandoffEnabled:
          readForcedHandoffMode(policyPath) === 'human-gated',
        // Issue-scoped: the created issue has no pull request of its own.
        expectedLinkedPrs: null,
        isAuthorizedForcedHandoff: (forcedBy) =>
          isAuthorizedForcedHandoffActor(
            gate.owner,
            gate.repo,
            forcedBy,
            authorityPolicy,
            permissionCache,
          ),
        requireAuthorMatchesForcedBy: true,
        staleAgeMs: readClaimStaleAgeMs(gate.config),
      },
    ) !== null
  );
}
/** True when a trusted login wrote an authoring-owner marker on the issue,
 * edited or not (fail closed). */
function hasForeignOwnerMarker(comments, markerPrefix, trusted) {
  const trustedSet = new Set(trusted.map((login) => login.toLowerCase()));
  const token = `${markerPrefix.toLowerCase()}-authoring-owner:`;
  return comments.some(
    (comment) =>
      trustedSet.has(comment.authorLogin.trim().toLowerCase()) &&
      comment.body.toLowerCase().includes(token),
  );
}
/**
 * Replay the owner-marker log right before `member`: every trusted
 * authoring-owner marker on the issue must be unedited and carry this run's
 * owner, set and session, and the anchor the run posted (the issue itself for
 * a set anchor, the anchor's real reference for a child). Returns a refusal
 * reason, or null.
 */
export function checkOwnerLogStillOurs(input) {
  const trustedSet = new Set(input.trusted.map((login) => login.toLowerCase()));
  const token = `${input.markerPrefix.toLowerCase()}-authoring-owner:`;
  let ours = 0;
  for (const comment of input.comments) {
    if (!trustedSet.has(comment.authorLogin.trim().toLowerCase())) {
      continue;
    }
    if (!comment.body.toLowerCase().includes(token)) {
      continue;
    }
    if (comment.lastEditedAt !== null) {
      return `owner marker ${comment.id} was edited`;
    }
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (
      parsed === null ||
      parsed.owner !== input.ids.owner ||
      parsed.set !== input.ids.set ||
      parsed.session !== input.ids.session ||
      !sameIssueRef(parsed.anchor, input.anchor)
    ) {
      return `owner marker ${comment.id} is not this run's marker`;
    }
    ours += 1;
  }
  return ours > 0 ? null : "this run's owner marker is not on the issue";
}
/**
 * The mode-specific field rules `post-idd-marker` enforces before it posts an
 * owner marker (the digest sentinel and the `supersedes` coupling of the
 * contract's mode table), checked on a marker already on the log. A trusted
 * author's marker that breaks them is not a valid owner marker, so it cannot
 * open or extend a generation. Returns the violated rule, or null.
 */
function ownerMarkerFieldProblem(parsed) {
  const fields = {
    mode: parsed.mode,
    'marker-owner': parsed.owner,
    'body-sha256': parsed.bodySha256,
    'snapshot-sha256': parsed.snapshotSha256,
    supersedes: parsed.supersedes,
  };
  return (
    validateAuthoringOwnerModeDigestCoupling(fields) ??
    validateAuthoringOwnerSupersedesModeCoupling(fields)
  );
}
/**
 * One step of the anchor replay: the state after a marker, or the problem that
 * marker causes. A pure function over explicit types, so the replay loop stays
 * free of self-referential narrowing.
 */
function advanceAnchorGeneration(state, parsed, latest) {
  const { open, closedSets } = state;
  const malformed = ownerMarkerFieldProblem(parsed);
  if (malformed !== null) {
    return {
      problem: `owner marker ${latest.id} (mode=${parsed.mode}) is malformed: ${malformed}`,
    };
  }
  const mismatch = () => ({
    problem: `owner marker ${latest.id} (mode=${parsed.mode}) does not match the open generation`,
  });
  switch (parsed.mode) {
    case 'acquire':
    case 'bootstrap':
      if (open !== null) {
        return {
          problem: `owner marker ${latest.id} (mode=${parsed.mode}) opens a second generation while set ${open.set} is open`,
        };
      }
      // A completed set is closed for good: a later acquisition starts a fresh
      // generation under a new set id (contract.md, `release-complete`).
      if (closedSets.has(parsed.set)) {
        return {
          problem: `owner marker ${latest.id} (mode=${parsed.mode}) reuses set ${parsed.set}, which a release-complete marker already closed`,
        };
      }
      return {
        open: {
          owner: parsed.owner,
          set: parsed.set,
          session: parsed.session,
          releasing: false,
          latest,
        },
        closedSets,
      };
    case 'resume':
      if (
        open === null ||
        parsed.set !== open.set ||
        parsed.supersedes !== open.owner
      ) {
        return mismatch();
      }
      return {
        open: {
          owner: parsed.owner,
          set: open.set,
          session: parsed.session,
          // A resume recovers the interrupted set; only release-complete ends
          // a release that began (contract.md, "Per-target ownership").
          releasing: open.releasing,
          latest,
        },
        closedSets,
      };
    case 'heartbeat':
    case 'release':
    case 'release-guard':
    case 'release-complete':
      if (
        open === null ||
        parsed.set !== open.set ||
        parsed.owner !== open.owner
      ) {
        return mismatch();
      }
      // The anchor-only terminal modes retain the anchor's current session
      // (contract.md, `release-guard` and `release-complete`).
      if (
        (parsed.mode === 'release-guard' ||
          parsed.mode === 'release-complete') &&
        parsed.session !== open.session
      ) {
        return {
          problem: `owner marker ${latest.id} (mode=${parsed.mode}) does not retain the session of the open generation`,
        };
      }
      if (parsed.mode === 'release-complete') {
        // It is the terminal event of a release, so it closes nothing else.
        if (!open.releasing) {
          return {
            problem: `owner marker ${latest.id} (mode=release-complete) closes a generation with no release in progress`,
          };
        }
        return { open: null, closedSets: new Set([...closedSets, open.set]) };
      }
      return {
        open: {
          owner: open.owner,
          set: open.set,
          session: open.session,
          releasing: open.releasing || parsed.mode !== 'heartbeat',
          latest,
        },
        closedSets,
      };
    default:
      return {
        problem: `owner marker ${latest.id} has the unknown mode ${parsed.mode}`,
      };
  }
}
/**
 * Replay the trusted authoring-owner markers on a set anchor's own comment log
 * and return its one open generation, or the reason there is none. Fails
 * closed: an edited or unparseable marker, a marker whose digest or
 * `supersedes` fields break the rules of its mode, a marker that names another
 * target or anchor, a second opening marker inside an open generation, a
 * heartbeat or release from another owner or set, a resume that does not
 * supersede the current owner, a release in progress, and a log with no open
 * generation all return a problem instead of a guess. The generation is
 * closed by `release-complete`, after which a later `acquire` or `bootstrap`
 * opens a new one, but never under the closed set's id (contract.md,
 * "Per-target ownership"). `session` is compared only where the contract pins
 * it: an opening marker sets it, and a heartbeat or release from another
 * session of the same owner is accepted.
 */
export function resolveAnchorGeneration(input) {
  const trustedSet = new Set(input.trusted.map((login) => login.toLowerCase()));
  const shaped = [];
  for (const comment of input.comments) {
    if (
      !trustedSet.has(comment.authorLogin.trim().toLowerCase()) ||
      !looksLikeOwnerMarker(comment.body, input.markerPrefix)
    ) {
      continue;
    }
    const edited = inspectLastEditedAt(comment);
    if (edited !== null) {
      return { problem: edited };
    }
    // A read that omits the minimization state, or a minimized comment without
    // its reason, is incomplete evidence and fails closed.
    if (
      typeof comment.isMinimized !== 'boolean' ||
      (comment.isMinimized &&
        (typeof comment.minimizedReason !== 'string' ||
          comment.minimizedReason.trim() === ''))
    ) {
      return {
        problem: `owner marker ${comment.id} has no readable minimization state`,
      };
    }
    const time = Date.parse(comment.createdAt);
    if (!Number.isFinite(time)) {
      return {
        problem: `owner marker ${comment.id} has a creation time that cannot be read`,
      };
    }
    shaped.push({ comment, time });
  }
  shaped.sort((a, b) => a.time - b.time || a.comment.id - b.comment.id);
  let state = { open: null, closedSets: new Set() };
  for (const { comment } of shaped) {
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed === null) {
      return { problem: `owner marker ${comment.id} does not parse` };
    }
    if (
      !sameIssueRef(parsed.target, input.anchorRef) ||
      !sameIssueRef(parsed.anchor, input.anchorRef)
    ) {
      return {
        problem: `owner marker ${comment.id} names target ${parsed.target} and anchor ${parsed.anchor}, not the anchor ${input.anchorRef} itself`,
      };
    }
    const next = advanceAnchorGeneration(state, parsed, {
      id: comment.id,
      mode: parsed.mode,
      owner: parsed.owner,
      session: parsed.session,
      createdAt: comment.createdAt,
      bodySha256: parsed.bodySha256,
      outdated: isOutdatedMinimized(comment),
    });
    if ('problem' in next) {
      return next;
    }
    state = next;
  }
  const { open } = state;
  if (open === null) {
    return {
      problem: `${input.anchorRef} has no open owner generation: no trusted acquire, bootstrap or resume marker, or its set was released`,
    };
  }
  if (open.releasing) {
    return {
      problem: `the set of ${input.anchorRef} is being released, so a child cannot join it`,
    };
  }
  // History that a sweep hid still counts, but the marker that carries the
  // generation to now is never a hidden one: a latest marker minimized as
  // outdated was disavowed, so it cannot prove an open generation.
  if (open.latest.outdated) {
    return {
      problem: `the latest owner marker of ${input.anchorRef}, comment ${open.latest.id}, is minimized as outdated, so it cannot prove an open generation`,
    };
  }
  return {
    generation: {
      owner: open.owner,
      set: open.set,
      session: open.session,
      latest: open.latest,
    },
  };
}
/**
 * Replay the journal's records of one publication token (contract.md, "On
 * resume, paginate the hold log and select the latest valid record for the
 * exact token tuple; missing, conflicting, or out-of-order records fail
 * closed"). Every record that carries the token must be written by a trusted
 * author who is the actor it names, be unedited, and repeat the publication
 * line's target, anchor, set and session and this journal. The records, in
 * comment order, must run `pending` (no issue yet), `pending` with the
 * issue, `member`, and only then `cleanup` and `abandoned`; the issue never
 * changes once attached. The replay must end at `member` for the anchor.
 * Returns a problem, or null.
 */
export function replayAnchorHold(input) {
  const trustedSet = new Set(input.trusted.map((login) => login.toLowerCase()));
  const intentToken = `${input.markerPrefix.toLowerCase()}-authoring-publication-intent:`;
  const tokenField = `token=${input.publication.token}`;
  const records = [];
  for (const comment of input.comments) {
    const lower = comment.body.toLowerCase();
    if (!lower.includes(intentToken) || !comment.body.includes(tokenField)) {
      continue;
    }
    const where = `publication-intent record ${comment.id} of the token`;
    const author = comment.authorLogin.trim().toLowerCase();
    if (!trustedSet.has(author)) {
      return `${where} is written by ${comment.authorLogin}, who is not a trusted marker actor`;
    }
    if (inspectLastEditedAt(comment) !== null) {
      return `${where} was edited after posting, or its edit state is unreadable`;
    }
    const intent = parseAuthoringPublicationIntentComment(
      comment.body,
      input.markerPrefix,
    );
    if (intent === null || intent.token !== input.publication.token) {
      return `${where} does not parse`;
    }
    if (
      intent.target !== input.publication.target ||
      intent.anchor !== input.publication.anchor ||
      intent.set !== input.publication.set ||
      intent.session !== input.publication.session ||
      !sameIssueRef(intent.journal, input.journalRef) ||
      intent.actor.toLowerCase() !== author
    ) {
      return `${where} conflicts with the anchor's publication line, this journal, or its own author`;
    }
    const time = Date.parse(comment.createdAt);
    if (!Number.isFinite(time)) {
      return `${where} has a creation time that cannot be read`;
    }
    records.push({
      id: comment.id,
      time,
      state: intent.state,
      issue: intent.issue,
    });
  }
  if (records.length === 0) {
    return `no publication-intent record of the anchor's token is in the journal ${input.journalRef}`;
  }
  records.sort((a, b) => a.time - b.time || a.id - b.id);
  let state = null;
  let attached = null;
  for (const record of records) {
    if (state === null) {
      if (record.state !== 'pending' || record.issue.toLowerCase() !== 'none') {
        return `the first record of the token, comment ${record.id}, is not the pending record without an issue`;
      }
    } else if (!(INTENT_TRANSITIONS[state] ?? []).includes(record.state)) {
      return `record ${record.id} moves the token from ${state} to ${record.state}, which is out of order`;
    }
    if (record.state === 'member' && attached === null) {
      return `record ${record.id} makes the token a member before any record attached its issue`;
    }
    if (record.issue.toLowerCase() === 'none') {
      if (attached !== null || record.state !== 'pending') {
        return `record ${record.id} drops the issue of the token after it was attached`;
      }
    } else if (attached === null) {
      if (!sameIssueRef(record.issue, input.anchorRef)) {
        return `record ${record.id} attaches the token to ${record.issue}, not the anchor ${input.anchorRef}`;
      }
      attached = record.issue;
    } else if (!sameIssueRef(record.issue, attached)) {
      return `record ${record.id} changes the issue of the token from ${attached} to ${record.issue}`;
    }
    state = record.state;
  }
  if (state !== 'member') {
    return `the latest record of the anchor's token is ${state}, not member`;
  }
  return null;
}
/**
 * Verify the originating Stage 1 hold of a child's anchor (#4251). This command
 * records a set in `issueAuthoring.journalIssue`, so an anchor it can extend has
 * its own publication-intent records there: the replay of the token in the
 * anchor's own publication line (self-anchored, in the open generation's set)
 * must end at `state=member` (see {@link replayAnchorHold}). An anchor whose
 * hold is elsewhere, whose body carries no publication line, or whose records
 * were never made a member, is refused, so a child's records never land in a
 * log the set's recovery would not replay. Returns a problem, or null.
 */
function checkAnchorHold(input) {
  const publication = parseAuthoringPublicationComment(
    input.anchorBody,
    input.markerPrefix,
  );
  if (publication === null) {
    return `the body of the anchor ${input.anchorRef} carries no authoring-publication line, so its hold in the journal ${input.journal.ref} cannot be matched`;
  }
  if (publication.anchor !== publication.target) {
    return `the authoring-publication line of ${input.anchorRef} names another anchor (${publication.anchor}), so it is not a set anchor`;
  }
  if (publication.set !== input.set) {
    return `the authoring-publication line of ${input.anchorRef} names set ${publication.set}, not the open generation's set ${input.set}`;
  }
  let comments;
  try {
    comments = fetchProvenanceCommentsGraphql(
      input.journal.owner,
      input.journal.repo,
      input.journal.number,
    );
  } catch (error) {
    return `the journal ${input.journal.ref} cannot be read, so the hold of the anchor ${input.anchorRef} is not verified: ${messageOf(error)}`;
  }
  const problem = replayAnchorHold({
    comments,
    publication,
    anchorRef: input.anchorRef,
    journalRef: input.journal.ref,
    markerPrefix: input.markerPrefix,
    trusted: input.trusted,
  });
  return problem === null
    ? null
    : `the originating hold of the anchor ${input.anchorRef} is not verified in the journal ${input.journal.ref}: ${problem}`;
}
function sameGeneration(a, b) {
  return a.owner === b.owner && a.set === b.set && a.session === b.session;
}
/**
 * Read the anchor of a child and replay its owner log. The anchor must be an
 * open issue (not a pull request) that still carries the authoring label, has
 * no active claim, and has one open owner generation. Reads only; the problem
 * names what makes the anchor unusable.
 */
function checkAnchor(input) {
  const ref = `${input.owner}/${input.repo}#${input.number}`;
  let snapshot;
  let comments;
  try {
    snapshot = readIssue(input.owner, input.repo, input.number);
    comments = fetchProvenanceCommentsGraphql(
      input.owner,
      input.repo,
      input.number,
    );
  } catch (error) {
    return { problem: `the anchor ${ref} cannot be read: ${messageOf(error)}` };
  }
  if (snapshot.pullRequest) {
    return { problem: `the anchor ${ref} is a pull request, not an issue` };
  }
  if (snapshot.state.toLowerCase() !== 'open') {
    return {
      problem: `the anchor ${ref} is not open (state ${JSON.stringify(snapshot.state)})`,
    };
  }
  if (!hasLabel(snapshot.labels, input.authoringLabel)) {
    return {
      problem: `the anchor ${ref} does not carry the authoring label ${input.authoringLabel}, so its set is not held`,
    };
  }
  let claimed;
  try {
    claimed = hasActiveClaim(comments, input.claimGate);
  } catch (error) {
    return {
      problem: `the claim state of the anchor ${ref} cannot be resolved: ${messageOf(error)}`,
    };
  }
  if (claimed) {
    return { problem: `the anchor ${ref} has an active claim` };
  }
  // An open linked pull request is active execution too (contract.md,
  // "Conflict check before every edit"), and an unreadable one counts as open.
  let openPrs;
  try {
    openPrs = resolveOpenLinkedPrIssues(
      createGithubProviderAdapter(input.owner, input.repo),
      [input.number],
    ).length;
  } catch (error) {
    return {
      problem: `the pull-request state of the anchor ${ref} cannot be read: ${messageOf(error)}`,
    };
  }
  if (openPrs > 0) {
    return {
      problem: `the anchor ${ref} has an open linked pull request, or its pull-request state cannot be read`,
    };
  }
  const replay = resolveAnchorGeneration({
    comments,
    anchorRef: ref,
    markerPrefix: input.markerPrefix,
    trusted: input.trusted,
  });
  if ('problem' in replay) {
    return replay;
  }
  return { generation: replay.generation, snapshot, comments };
}
/**
 * The anchor heartbeat a child needs before its own owner marker (contract.md,
 * "Acquire one set anchor before acquiring any other target"): re-read the
 * anchor, reuse a fresh matching marker under the coalescing rule or post a
 * same-owner heartbeat carrying a digest of the anchor body just read, wait
 * the settle delay, and replay the anchor's log. The replay must show the
 * same owner generation and the heartbeat on the log. Throws when any of that
 * fails; a marker post error keeps its `posted` / `nothingSent` flags.
 */
function heartbeatAnchor(input) {
  const { anchor } = input;
  const read = () =>
    checkAnchor({
      owner: anchor.owner,
      repo: anchor.repo,
      number: anchor.number,
      authoringLabel: input.authoringLabel,
      markerPrefix: input.markerPrefix,
      trusted: input.trusted,
      claimGate: input.claimGate,
    });
  const fresh = read();
  if ('problem' in fresh) {
    throw new Error(fresh.problem);
  }
  if (!sameGeneration(fresh.generation, anchor.generation)) {
    throw new Error(
      `the owner generation of the anchor ${anchor.ref} changed since it was verified`,
    );
  }
  const digest = sha256Hex(fresh.snapshot.body);
  const latest = fresh.generation.latest;
  const reused =
    COALESCING_MODES.has(latest.mode) &&
    latest.session === anchor.generation.session &&
    Date.now() - Date.parse(latest.createdAt) < input.heartbeatWindowMs &&
    latest.bodySha256 === digest;
  const commentId = reused
    ? latest.id
    : input.postMarker(
        [
          '--type',
          'authoring-owner',
          '--target',
          'issue',
          String(anchor.number),
          '--owner',
          anchor.owner,
          '--repo',
          anchor.repo,
          '--marker-target',
          anchor.ref,
          '--anchor',
          anchor.ref,
          '--mode',
          'heartbeat',
          '--marker-owner',
          anchor.generation.owner,
          '--set',
          anchor.generation.set,
          '--session',
          anchor.generation.session,
          '--body-sha256',
          digest,
          '--snapshot-sha256',
          'none',
          '--supersedes',
          anchor.generation.owner,
          '--marker-prefix',
          input.markerPrefix,
          ...input.trustedFlag,
        ],
        { owner: anchor.owner, repo: anchor.repo, number: anchor.number },
      );
  sleepMs(input.settleMs);
  const replay = read();
  if ('problem' in replay) {
    throw new Error(`after the heartbeat: ${replay.problem}`);
  }
  if (!sameGeneration(replay.generation, anchor.generation)) {
    throw new Error(
      `the owner generation of the anchor ${anchor.ref} changed during the heartbeat`,
    );
  }
  if (!replay.comments.some((comment) => comment.id === commentId)) {
    throw new Error(
      `the heartbeat marker ${commentId} is not on the anchor ${anchor.ref} after the settle wait`,
    );
  }
  return { commentId, reused };
}
/** True when the issue carries a comment with exactly this body by `actor`.
 * Throws when the comments cannot be read. */
function hasExactComment(where, body, actor) {
  const comments = ghApiJson(
    `repos/${where.owner}/${where.repo}/issues/${where.number}/comments`,
    { paginate: true },
  );
  if (!Array.isArray(comments)) {
    throw new Error('the comments are not readable');
  }
  return comments.some((comment) => {
    const row = comment;
    return (
      row.body === body &&
      String(row.user?.login ?? '').toLowerCase() === actor.toLowerCase()
    );
  });
}
/** Compare bodies the way GitHub may store them (CRLF and trailing space). */
function sameBody(left, right) {
  const normalize = (text) => text.replace(/\r\n/g, '\n').trimEnd();
  return normalize(left) === normalize(right);
}
function runCli() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return usage(error.message);
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!PUBLISH_SHAPES.includes(args.shape)) {
    return usage(
      `--shape must be one of ${PUBLISH_SHAPES.join(', ')} (got ${JSON.stringify(args.shape)})`,
    );
  }
  // A child joins an existing set, so it names the set's anchor; every other
  // shape is its own set anchor and has none to name (#4251).
  let anchorRef = null;
  if (args.shape === 'child') {
    if (args.anchor === '') {
      return usage(
        '--anchor <owner>/<repo>#<number> is required for --shape child: a child is published under the anchor of an existing set',
      );
    }
    anchorRef = parseJournalReference(args.anchor);
    if (anchorRef === null) {
      return usage(
        `--anchor must be an owner/repo#number reference (got ${JSON.stringify(args.anchor)})`,
      );
    }
  } else if (args.anchorGiven) {
    return usage(
      `--anchor is only valid with --shape child: --shape ${args.shape} is its own set anchor`,
    );
  }
  if (!PUBLISH_BUCKETS.includes(args.bucket)) {
    return usage(`--bucket must be one of ${PUBLISH_BUCKETS.join(', ')}`);
  }
  const bucket = args.bucket;
  if (args.shape === 'carrier' && bucket !== 'ready') {
    return usage(
      `--bucket must be ready for --shape carrier (got ${JSON.stringify(bucket)}): a draft carrier has no readiness bucket`,
    );
  }
  if (args.title === '') {
    return usage('--title is required');
  }
  if (args.bodyFile === '') {
    return usage('--body-file is required');
  }
  if (args.reviewResultGiven && args.reviewResult === '') {
    return usage('--review-result needs a file path');
  }
  if (args.reviewResult === '' && args.shape !== 'carrier') {
    return usage(
      `--review-result is required for --shape ${args.shape}: the completed draft adversarial review must be recorded before publication`,
    );
  }
  if ((args.owner === '') !== (args.repo === '')) {
    return usage('--owner and --repo must be provided together or not at all');
  }
  // Step 1: a given review result is readable and well formed, and the draft
  // is readable. An orphan requires one; a carrier's review result is optional.
  if (args.reviewResult !== '') {
    let reviewRaw;
    try {
      reviewRaw = readFileSync(args.reviewResult, 'utf8');
    } catch (error) {
      return refuse(
        `cannot read the review result ${args.reviewResult}: ${error.message}`,
      );
    }
    const reviewProblem =
      args.shape === 'carrier'
        ? checkCarrierReviewResult(reviewRaw)
        : checkReviewResult(reviewRaw);
    if (reviewProblem !== null) {
      return refuse(reviewProblem);
    }
  }
  let draft;
  try {
    draft = readFileSync(args.bodyFile, 'utf8');
  } catch (error) {
    return refuse(
      `cannot read the body file ${args.bodyFile}: ${error.message}`,
    );
  }
  if (draft.trim() === '') {
    return refuse('the body file is empty');
  }
  // Step 2: the journal must be set and verifiable before any target exists.
  // Every policy value this helper reads (journal, marker prefix, label names,
  // trusted actors, settle delay) describes the target repository, so it
  // comes from the repository's own policy file only, never from a
  // user-global layer (contract.md, "Target marker prefix").
  let journalSetting;
  let policyError = '';
  let config = null;
  let policyPath = '';
  try {
    const loaded = readRepositoryPolicyFile(args.policy || undefined);
    policyPath = loaded.path;
    const repositoryPolicy = loaded.config;
    config = repositoryPolicy;
    journalSetting = repositoryPolicy?.issueAuthoring?.journalIssue;
  } catch (error) {
    policyError = error.message;
  }
  const blockedByHuman = (reason) => {
    process.stdout.write(
      `${JSON.stringify({ outcome: 'blocked-by-human', reason }, null, 2)}\n`,
    );
    process.stderr.write(
      `publish-authoring-hold: blocked-by-human: ${reason}\n`,
    );
    return { exitCode: 2, kind: 'gate', message: reason };
  };
  const journal = parseJournalReference(journalSetting);
  if (policyError !== '') {
    return blockedByHuman(
      `the repository policy file cannot be read, so issueAuthoring.journalIssue cannot be verified: ${policyError}`,
    );
  }
  if (journal === null) {
    return blockedByHuman(
      journalSetting === undefined
        ? 'issueAuthoring.journalIssue is not set; a standalone set has no journal to record its publication intent'
        : 'issueAuthoring.journalIssue is not an owner/repo#N reference',
    );
  }
  try {
    const journalIssue = readIssue(journal.owner, journal.repo, journal.number);
    if (journalIssue.pullRequest) {
      return blockedByHuman(
        `issueAuthoring.journalIssue ${journal.ref} is a pull request, not an issue`,
      );
    }
  } catch (error) {
    return blockedByHuman(
      `issueAuthoring.journalIssue ${journal.ref} cannot be verified: ${error.message}`,
    );
  }
  // The records this command writes are trusted later through the
  // repository's own trustedMarkerActors, so no flag or environment value may
  // replace that list here.
  const { actors: trusted } = resolveTrustedMarkerActors({
    config,
  });
  const currentRepo =
    args.owner && args.repo
      ? { owner: args.owner, repo: args.repo }
      : resolveCurrentGithubRepository();
  const { owner, repo } = currentRepo;
  if (!REPO_TOKEN_PATTERN.test(owner) || !REPO_TOKEN_PATTERN.test(repo)) {
    return refuse('could not resolve a repository owner and name');
  }
  // The child, its journal records and the anchor's heartbeat share one
  // repository: a set that spans repositories raises marker-prefix and
  // permission questions this command does not answer (#4251).
  if (
    anchorRef !== null &&
    (anchorRef.owner.toLowerCase() !== owner.toLowerCase() ||
      anchorRef.repo.toLowerCase() !== repo.toLowerCase())
  ) {
    return usage(
      `--anchor must name an issue in ${owner}/${repo}, the repository of the new issue (got ${anchorRef.ref})`,
    );
  }
  // The local policy's prefix is the target's prefix only when the issue and
  // the journal both live in this checkout's repository (contract.md,
  // "Target marker prefix"); otherwise the caller must name it.
  let markerPrefix;
  if (args.markerPrefix !== '') {
    markerPrefix = normalizeMarkerPrefix(args.markerPrefix);
  } else {
    let local;
    try {
      local =
        args.owner && args.repo
          ? resolveCurrentGithubRepository()
          : currentRepo;
    } catch {
      local = null;
    }
    const same = (a) =>
      local !== null &&
      a.owner.toLowerCase() === local.owner.toLowerCase() &&
      a.repo.toLowerCase() === local.repo.toLowerCase();
    if (!same({ owner, repo }) || !same(journal)) {
      return usage(
        '--marker-prefix is required when the issue or the journal is not in this checkout repository (or that repository cannot be resolved)',
      );
    }
    markerPrefix = normalizeMarkerPrefix(config?.markerPrefix);
  }
  const claimGate = {
    owner,
    repo,
    trusted,
    policyPath,
    config,
  };
  // Step 3: ids and the publication line. A child first verifies its anchor
  // (read-only, so a dry run does it too), because the anchor's set and
  // session are part of the child's ids.
  let anchor = null;
  if (anchorRef !== null) {
    const ref = `${owner}/${repo}#${anchorRef.number}`;
    const checked = checkAnchor({
      owner,
      repo,
      number: anchorRef.number,
      authoringLabel: resolvePublishLabels(config, bucket, args.shape)[0] ?? '',
      markerPrefix,
      trusted,
      claimGate,
    });
    if ('problem' in checked) {
      return refuse(checked.problem, {
        repository: { owner, repo },
        anchor: ref,
      });
    }
    const holdProblem = checkAnchorHold({
      journal,
      anchorRef: ref,
      anchorBody: checked.snapshot.body,
      set: checked.generation.set,
      markerPrefix,
      trusted,
    });
    if (holdProblem !== null) {
      return refuse(holdProblem, {
        repository: { owner, repo },
        anchor: ref,
      });
    }
    anchor = {
      ref,
      owner,
      repo,
      number: anchorRef.number,
      generation: checked.generation,
    };
  }
  const ids =
    anchor === null
      ? generatePublicationIds()
      : generateChildPublicationIds({
          ref: anchor.ref,
          set: anchor.generation.set,
          session: anchor.generation.session,
        });
  let injected;
  try {
    injected = injectPublicationLine(draft, markerPrefix, ids);
  } catch (error) {
    return refuse(error.message);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'idd-publish-authoring-hold-'));
  try {
    const bodyPath = join(scratch, 'body.md');
    writeFileSync(bodyPath, injected);
    return publish({
      args,
      bucket,
      journal,
      owner,
      repo,
      markerPrefix,
      trusted,
      settleMs:
        parseIsoDurationToMs(
          normalizePolicyConfig(config).claim.verifySettleDelay,
        ) ?? 0,
      config,
      policyPath,
      ids,
      injected,
      bodyPath,
      claimGate,
      anchor,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function publish(input) {
  const { args, bucket, journal, owner, repo, markerPrefix, ids, claimGate } =
    input;
  const { anchor } = input;
  const repoRef = `${owner}/${repo}`;
  const steps = [];
  const heartbeatWindowMs =
    parseIsoDurationToMs(
      input.config?.issueAuthoring?.heartbeatCoalesceWindow ?? 'PT2M',
    ) ?? 120_000;
  const base = {
    repository: { owner, repo },
    journal: journal.ref,
    ids,
    ...(anchor === null
      ? {}
      : {
          anchor: {
            issue: anchor.ref,
            owner: anchor.generation.owner,
            set: anchor.generation.set,
            session: anchor.generation.session,
            latestMode: anchor.generation.latest.mode,
          },
        }),
  };
  if (anchor !== null) {
    steps.push({
      step: 'anchor-check',
      status: 'done',
      detail: base.anchor,
    });
  }
  // Step 4: lint the exact body that will be created.
  const labels = resolvePublishLabels(input.config, bucket, args.shape);
  // A carrier's release removes the authoring label by name, so identical names
  // would strip the authoring-only label too, and an empty name would remove
  // nothing: refuse before any write.
  if (args.shape === 'carrier') {
    const authoringName = labels[0] ?? '';
    const authoringOnlyName = labels[1] ?? '';
    if (
      authoringName === '' ||
      authoringOnlyName === '' ||
      authoringName.toLowerCase() === authoringOnlyName.toLowerCase()
    ) {
      return refuse(
        'the authoring label and labels.authoringOnlyLabelName must be different, non-empty names for a carrier',
        base,
      );
    }
  }
  const lintArgs = buildLintArgs({
    shape: args.shape,
    title: args.title,
    bodyFile: input.bodyPath,
    markerPrefix,
    currentRepo: repoRef,
    bucket,
    labels,
    // An explicit --config keeps the linter on the same repository file,
    // without its own user-global layers.
    policy: input.policyPath,
  });
  const lint = runSiblingHelper('audit-authored-issue.mjs', lintArgs);
  const lintReport = { args: lintArgs, exitCode: lint.status };
  if (lint.status !== 0) {
    return refuse(helperFailure('audit-authored-issue', lint), {
      ...base,
      lint: { ...lintReport, output: parseJsonOutput(lint) ?? lint.stdout },
    });
  }
  steps.push({ step: 'lint', status: 'done', detail: lintReport });
  // Step 5: resolve the labels before any journal write.
  let missing;
  try {
    missing = labels.filter((name) => !labelExists(owner, repo, name));
  } catch (error) {
    return refuse(`cannot read the labels: ${error.message}`, base);
  }
  const actor = resolveViewerLogin();
  // A dry run may have no trusted set; --apply refuses one before any post.
  const trustedFlag =
    input.trusted.length > 0
      ? ['--trusted-marker-logins', input.trusted.join(',')]
      : [];
  const intentArgs = (state, issue) => [
    '--type',
    'authoring-publication-intent',
    '--target',
    'issue',
    String(journal.number),
    '--owner',
    journal.owner,
    '--repo',
    journal.repo,
    '--marker-target',
    ids.target,
    '--anchor',
    ids.anchor,
    '--set',
    ids.set,
    '--session',
    ids.session,
    '--token',
    ids.token,
    '--journal',
    journal.ref,
    '--issue',
    issue,
    '--actor',
    actor,
    '--state',
    state,
    '--marker-prefix',
    markerPrefix,
    // The child's own trust reads (the authoring-owner identity check and
    // the hide step) use the repository set, never its environment or cwd.
    ...trustedFlag,
  ];
  const renderMarker = (markerArgs) => {
    const run = runSiblingHelper('post-idd-marker.mjs', markerArgs);
    const body = parseJsonOutput(run)?.body;
    if (run.status !== 0 || typeof body !== 'string') {
      throw new Error(helperFailure('post-idd-marker (dry run)', run));
    }
    return body;
  };
  if (!args.apply) {
    let pendingRecord;
    try {
      pendingRecord = renderMarker(intentArgs('pending', 'none'));
    } catch (error) {
      return refuse(error.message, base);
    }
    steps.push(
      {
        step: 'labels',
        status: 'planned',
        detail: { labels, create: missing },
      },
      {
        step: 'journal-pending',
        status: 'planned',
        detail: { record: pendingRecord },
      },
      {
        step: 'create',
        status: 'planned',
        detail: { title: args.title, labels },
      },
      { step: 'identity-attach', status: 'planned' },
      ...(anchor === null
        ? []
        : [{ step: 'anchor-heartbeat', status: 'planned' }]),
      { step: 'owner-marker', status: 'planned' },
      { step: 'provenance', status: 'planned' },
      ...(anchor === null
        ? []
        : [{ step: 'anchor-verify', status: 'planned' }]),
      { step: 'member', status: 'planned' },
    );
    if (args.shape === 'carrier') {
      steps.push({
        step: 'carrier-release',
        status: 'planned',
        detail: { steps: CARRIER_RELEASE_PLAN },
      });
    }
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', outcome: 'planned', ...base, labels, steps }, null, 2)}\n`,
    );
    return 0;
  }
  // Admission runs on --apply only, before the first write; a dry run
  // writes nothing and needs neither trust nor permission.
  // A record from a login replay cannot trust is not valid evidence, so with
  // no trusted marker actor configured nothing is written at all.
  if (input.trusted.length === 0) {
    return refuse(
      'no trusted marker actor is configured in the repository policy file (trustedMarkerActors), so the journal records could not be verified on replay',
      base,
    );
  }
  if (
    !input.trusted.some((login) => login.toLowerCase() === actor.toLowerCase())
  ) {
    return refuse(
      `the authenticated login ${actor} is not a trusted marker actor, so its journal records would not be valid evidence`,
      base,
    );
  }
  // The contract also needs Write, Maintain or Admin on every repository
  // that receives a marker, unless the actor is a configured bot or app.
  if (!actor.toLowerCase().endsWith('[bot]')) {
    const cache = new Map();
    const targets = [
      { owner, repo },
      { owner: journal.owner, repo: journal.repo },
    ];
    for (const target of targets) {
      if (!hasWritePermission(target.owner, target.repo, actor, cache)) {
        return refuse(
          `${actor} does not have Write, Maintain or Admin permission on ${target.owner}/${target.repo}, or it could not be read, so its markers would not be trusted`,
          base,
        );
      }
    }
  }
  for (const name of missing) {
    try {
      ghText(['label', 'create', name, '--repo', repoRef]);
    } catch (error) {
      return refuse(
        `cannot create the label ${name}, so the create could not apply it: ${error.message}`,
        base,
      );
    }
  }
  steps.push({
    step: 'labels',
    status: 'done',
    detail: { labels, created: missing },
  });
  /** Post a marker, then read it back by id and compare body and author. */
  const postVerified = (markerArgs, where) => {
    const expected = renderMarker(markerArgs);
    // The envelope is what tells a write that sent nothing from one that may
    // have landed, so it is requested whatever the caller's own setting.
    const run = runSiblingHelper(
      'post-idd-marker.mjs',
      [...markerArgs, '--apply'],
      { ...process.env, IDD_HELPER_ERROR_ENVELOPE: '1' },
    );
    // A comment that exists, or may exist, leaves the record's state unknown
    // rather than unchanged.
    const landed = (message) =>
      Object.assign(new Error(message), { posted: true });
    const commentId = Number(parseJsonOutput(run)?.commentId);
    if (run.status !== 0 || !Number.isInteger(commentId) || commentId <= 0) {
      const failure = helperFailure('post-idd-marker', run);
      if (run.status !== 0 && markerPostSentNothing(run.stderr)) {
        throw Object.assign(new Error(`${failure}; nothing was sent`), {
          nothingSent: true,
        });
      }
      // Any other failure may have landed (#4171, option 1). A lagging read
      // can miss a record that did land, so the exact-body search only adds
      // detail: not finding the body never proves that nothing was written.
      let found;
      try {
        found = hasExactComment(where, expected, actor);
      } catch {
        found = null;
      }
      throw landed(
        `${failure}; ${
          found === true
            ? 'the record is on the issue anyway'
            : found === false
              ? 'the record may have been posted, and the comments do not show it yet'
              : 'the record may have been posted, and the comments could not be read'
        }`,
      );
    }
    let stored;
    try {
      stored = ghApiJson(
        `repos/${where.owner}/${where.repo}/issues/comments/${commentId}`,
      );
    } catch (error) {
      throw landed(
        `comment ${commentId} could not be read back: ${error.message}`,
      );
    }
    if (stored?.body !== expected) {
      throw landed(`comment ${commentId} does not carry the posted marker`);
    }
    if (
      String(stored.user?.login ?? '').toLowerCase() !== actor.toLowerCase()
    ) {
      throw landed(`comment ${commentId} was not written by ${actor}`);
    }
    return commentId;
  };
  const journalWhere = {
    owner: journal.owner,
    repo: journal.repo,
    number: journal.number,
  };
  // Step 6: the pending record must be verified before the create.
  try {
    const commentId = postVerified(intentArgs('pending', 'none'), journalWhere);
    steps.push({
      step: 'journal-pending',
      status: 'done',
      detail: { commentId },
    });
  } catch (error) {
    return refuse(
      `the pending publication-intent record could not be verified, so nothing was created: ${error.message}`,
      {
        ...base,
        steps,
        ...postOutcome(error),
        // Nothing was created, so a retry is safe once nothing was sent;
        // after an uncertain post it must replay the journal first.
        ...(postOutcome(error).nothingSent === true
          ? { retry: 'permitted' }
          : isPosted(error)
            ? { retry: 'replay the journal first' }
            : {}),
      },
    );
  }
  // Step 7: one create call with every label.
  const createArgs = [
    'issue',
    'create',
    '--repo',
    repoRef,
    '--title',
    args.title,
    '--body-file',
    input.bodyPath,
  ];
  for (const label of labels) {
    createArgs.push('--label', label);
  }
  let number;
  let url;
  try {
    const out = ghText(createArgs).trim();
    url = out.split('\n').pop()?.trim() ?? '';
    const match = /\/issues\/([1-9][0-9]*)$/.exec(url);
    if (!match) {
      throw new Error(`gh issue create printed no issue URL: ${out}`);
    }
    number = Number(match[1]);
  } catch (error) {
    return recoveryHold({
      ...base,
      issue: null,
      failedStep: 'create',
      reason: `${error.message}; check the repository for an issue carrying token ${ids.token} before retrying`,
      steps,
    });
  }
  const issueRef = `${repoRef}#${number}`;
  steps.push({
    step: 'create',
    status: 'done',
    detail: { issue: issueRef, url },
  });
  const held = { ...base, issue: issueRef, number, url, steps };
  // Step 8: the label must be on the issue; restore it as a safe hold if not.
  let created;
  try {
    created = readIssue(owner, repo, number);
  } catch (error) {
    return recoveryHold({
      ...held,
      failedStep: 'create-verify',
      reason: error.message,
    });
  }
  const authoringLabel = labels[0] ?? '';
  if (!labels.every((name) => hasLabel(created.labels, name))) {
    let reason = `the created issue lacks a required label (has ${JSON.stringify(created.labels)})`;
    try {
      // This run has not posted its owner marker yet, so any trusted owner
      // marker here belongs to another session or set.
      const comments = fetchProvenanceCommentsGraphql(owner, repo, number);
      if (hasForeignOwnerMarker(comments, markerPrefix, input.trusted)) {
        reason +=
          '; another owner marker is present, so the labels were not touched';
      } else if (hasActiveClaim(comments, claimGate)) {
        reason += '; a claim marker is present, so the labels were not touched';
      } else {
        ghText([
          'issue',
          'edit',
          String(number),
          '--repo',
          repoRef,
          ...labels.flatMap((name) => ['--add-label', name]),
        ]);
        const after = readIssue(owner, repo, number);
        reason += labels.every((name) => hasLabel(after.labels, name))
          ? '; the labels were added as a safe hold'
          : hasLabel(after.labels, authoringLabel)
            ? '; the authoring label was added as a safe hold, but another label could not be verified'
            : '; adding the labels could not be verified';
      }
    } catch (error) {
      reason += `; the safe-hold recovery failed: ${error.message}`;
    }
    return recoveryHold({ ...held, failedStep: 'create-verify', reason });
  }
  let failedStep = 'identity-attach';
  try {
    const attachId = postVerified(
      intentArgs('pending', issueRef),
      journalWhere,
    );
    steps.push({
      step: 'identity-attach',
      status: 'done',
      detail: { commentId: attachId },
    });
    // A child renews its anchor before it acquires, so the set's owner sees
    // a fresh generation first (contract.md, "Acquire one set anchor").
    if (anchor !== null) {
      failedStep = 'anchor-heartbeat';
      const heartbeat = heartbeatAnchor({
        anchor,
        markerPrefix,
        trusted: input.trusted,
        trustedFlag,
        authoringLabel,
        claimGate,
        settleMs: input.settleMs,
        heartbeatWindowMs,
        postMarker: postVerified,
      });
      steps.push({
        step: 'anchor-heartbeat',
        status: 'done',
        detail: heartbeat,
      });
    }
    failedStep = 'owner-marker';
    const ownerArgs = [
      '--type',
      'authoring-owner',
      '--target',
      'issue',
      String(number),
      '--owner',
      owner,
      '--repo',
      repo,
      '--marker-target',
      issueRef,
      '--anchor',
      // A set anchor names itself; a child names the anchor's real reference.
      anchor === null ? issueRef : ids.anchor,
      '--mode',
      'acquire',
      '--marker-owner',
      ids.owner,
      '--set',
      ids.set,
      '--session',
      ids.session,
      '--snapshot-sha256',
      'none',
      '--supersedes',
      'none',
      '--marker-prefix',
      markerPrefix,
      ...trustedFlag,
    ];
    const ownerId = postVerified(ownerArgs, { owner, repo, number });
    steps.push({
      step: 'owner-marker',
      status: 'done',
      detail: { commentId: ownerId },
    });
  } catch (error) {
    const attached = steps.some((s) => s.step === 'identity-attach');
    const outcome = postOutcome(error);
    return recoveryHold({
      ...held,
      failedStep: attached ? failedStep : 'identity-attach',
      reason: error.message,
      ...(attached
        ? // The owner marker and the anchor heartbeat are on issues, not in
          // the journal, so the journal stays at the attached pending record
          // and the marker's own state is reported instead.
          {
            nothingSent: outcome.nothingSent,
            ...(isPosted(error)
              ? failedStep === 'anchor-heartbeat'
                ? { anchorHeartbeat: 'uncertain' }
                : { ownerMarker: 'uncertain' }
              : {}),
          }
        : outcome),
    });
  }
  sleepMs(input.settleMs);
  let verdictName;
  let marker;
  let provenanceFailure;
  let provenanceReport;
  if (anchor === null) {
    const provenanceArgs = [
      '--issue',
      String(number),
      '--owner',
      owner,
      '--repo',
      repo,
      '--marker-prefix',
      markerPrefix,
    ];
    if (input.policyPath) {
      provenanceArgs.push('--policy', input.policyPath);
    }
    if (input.trusted.length > 0) {
      provenanceArgs.push('--trusted-marker-logins', input.trusted.join(','));
    }
    const provenance = runSiblingHelper(
      'authoring-owner-provenance.mjs',
      provenanceArgs,
    );
    const verdict = parseJsonOutput(provenance);
    verdictName = verdict?.verdict;
    marker = verdict?.marker;
    provenanceFailure = helperFailure('authoring-owner-provenance', provenance);
    provenanceReport = verdict ?? provenance.stdout;
  } else {
    // The helper's command line refuses a marker whose anchor differs from its
    // target, which is every child's marker, so a child runs the same check in
    // process with the anchor it expects (#4251).
    try {
      const result = evaluateAuthoringOwnerProvenance({
        target: issueRef,
        liveBody: readIssue(owner, repo, number).body,
        comments: fetchProvenanceCommentsGraphql(owner, repo, number),
        markerPrefix,
        trustedMarkerLogins: [...input.trusted],
        expectedAnchor: ids.anchor,
      });
      verdictName = result.verdict;
      marker = result.marker;
      provenanceFailure =
        result.checks
          .filter((check) => check.result === 'fail')
          .map((check) => check.evidence)
          .join(' ') || `the verdict is ${result.verdict}`;
      provenanceReport = result;
    } catch (error) {
      return recoveryHold({
        ...held,
        failedStep: 'provenance',
        reason: `the provenance of the child could not be read: ${messageOf(error)}`,
      });
    }
  }
  if (
    verdictName !== 'pass' ||
    marker?.owner !== ids.owner ||
    marker?.set !== ids.set ||
    marker?.session !== ids.session
  ) {
    return recoveryHold({
      ...held,
      failedStep: 'provenance',
      reason:
        verdictName === 'pass'
          ? 'the winning acquire marker is not the one this run posted'
          : provenanceFailure,
      provenance: provenanceReport,
    });
  }
  steps.push({
    step: 'provenance',
    status: 'done',
    detail:
      anchor === null
        ? { verdict: 'pass' }
        : { verdict: 'pass', inProcess: true, expectedAnchor: ids.anchor },
  });
  let finalStep = 'member';
  try {
    const reread = readIssue(owner, repo, number);
    if (!labels.every((name) => hasLabel(reread.labels, name))) {
      throw new Error('a required label is no longer on the issue');
    }
    const digest = createHash('sha256')
      .update(reread.body, 'utf8')
      .digest('hex');
    if (digest !== marker.bodySha256) {
      throw new Error('the issue body changed after the owner marker');
    }
    if (!sameBody(reread.body, input.injected)) {
      throw new Error('the issue body is not the body this run created');
    }
    const comments = fetchProvenanceCommentsGraphql(owner, repo, number);
    if (hasActiveClaim(comments, claimGate)) {
      throw new Error(
        'the issue has an active claim, so execution began during acquisition',
      );
    }
    if (
      resolveOpenLinkedPrIssues(createGithubProviderAdapter(owner, repo), [
        number,
      ]).length > 0
    ) {
      throw new Error(
        'the issue has an open linked pull request, or its pull-request state cannot be read',
      );
    }
    const ownerLog = checkOwnerLogStillOurs({
      comments,
      markerPrefix,
      trusted: input.trusted,
      ids,
      anchor: anchor === null ? issueRef : ids.anchor,
    });
    if (ownerLog !== null) {
      throw new Error(`the owner-marker replay failed: ${ownerLog}`);
    }
    if (anchor !== null) {
      // Both the anchor and the child are read again, and a changed anchor
      // owner stops here rather than forming a split set.
      finalStep = 'anchor-verify';
      const again = checkAnchor({
        owner: anchor.owner,
        repo: anchor.repo,
        number: anchor.number,
        authoringLabel,
        markerPrefix,
        trusted: input.trusted,
        claimGate,
      });
      if ('problem' in again) {
        throw new Error(`the anchor no longer holds the set: ${again.problem}`);
      }
      if (!sameGeneration(again.generation, anchor.generation)) {
        throw new Error(
          `the owner generation of the anchor ${anchor.ref} changed before member`,
        );
      }
      steps.push({
        step: 'anchor-verify',
        status: 'done',
        detail: { ownerGeneration: 'unchanged' },
      });
      finalStep = 'member';
    }
    const memberId = postVerified(intentArgs('member', issueRef), journalWhere);
    steps.push({
      step: 'member',
      status: 'done',
      detail: { commentId: memberId },
    });
  } catch (error) {
    return recoveryHold({
      ...held,
      failedStep: finalStep,
      reason: error.message,
      ...postOutcome(error),
    });
  }
  if (args.shape === 'carrier') {
    const release = releaseCarrier({
      owner,
      repo,
      number,
      markerPrefix,
      trusted: input.trusted,
      ids,
      journal,
      authoringLabel: labels[0] ?? '',
      authoringOnlyLabel: labels[1] ?? '',
      settleMs: input.settleMs,
      heartbeatWindowMs,
      policyPath: input.policyPath,
      trustedFlag,
      postMarker: postVerified,
    });
    const stuck = release.state === 'recovery-hold';
    process.stdout.write(
      `${JSON.stringify({ mode: 'apply', outcome: stuck ? 'recovery-hold' : 'published', ...held, journalState: 'member', release }, null, 2)}\n`,
    );
    if (stuck) {
      const message = `release recovery hold at step ${String(release.failedStep)}: ${String(release.reason)}`;
      process.stderr.write(
        `publish-authoring-hold: ${message} (issue ${issueRef} stays held)\n`,
      );
      return { exitCode: 1, kind: 'gate', message };
    }
    return 0;
  }
  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', outcome: 'published', ...held, journalState: 'member' }, null, 2)}\n`,
  );
  return 0;
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
/** The set snapshot digest (contract.md, "Stage 2"): SHA-256 of the
 * `<owner>/<repo>#<number>:<body-sha256>` line, with the repository identity
 * normalized as NFC(lowercase(NFC(component))). */
export function carrierSetSnapshot(owner, repo, number, bodySha256) {
  const identity = (component) =>
    component.normalize('NFC').toLowerCase().normalize('NFC');
  return sha256Hex(
    `${identity(owner)}/${identity(repo)}#${number}:${bodySha256}`,
  );
}
/** The earliest unedited trusted authoring-owner marker of this run that the
 * predicate accepts, or null. Edited or unparseable markers never match. */
function oursMatching(log, input, accept) {
  const trusted = new Set(input.trusted.map((login) => login.toLowerCase()));
  // GitHub repository identities are case-insensitive, so the target and the
  // anchor are compared without case (a retry may name the repo in other case).
  const issueRef = `${input.owner}/${input.repo}#${input.number}`.toLowerCase();
  let best = null;
  for (const comment of log) {
    if (!trusted.has(comment.authorLogin.trim().toLowerCase())) {
      continue;
    }
    if (comment.lastEditedAt !== null) {
      continue;
    }
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (
      parsed === null ||
      parsed.owner !== input.ids.owner ||
      parsed.set !== input.ids.set ||
      parsed.session !== input.ids.session ||
      parsed.target.toLowerCase() !== issueRef ||
      parsed.anchor.toLowerCase() !== issueRef ||
      !accept(parsed)
    ) {
      continue;
    }
    if (best === null || comment.id < best.id) {
      best = { id: comment.id, createdAt: comment.createdAt, parsed };
    }
  }
  return best;
}
/** The latest unedited trusted marker of this run, by comment id: the one a
 * heartbeat coalescing check reads (contract.md, "Heartbeat coalescing"). */
function latestOursMarker(log, input) {
  let latest = null;
  for (const comment of log) {
    const earliest = oursMatching([comment], input, () => true);
    if (earliest !== null && (latest === null || earliest.id > latest.id)) {
      latest = earliest;
    }
  }
  return latest;
}
/** The field rules post-idd-marker enforces for each mode this run posts (the
 * contract's mode table). `acquire` and `resume` pass here: provenance and the
 * acquire-digest check cover them. */
function markerFieldsValid(parsed, input, bodySha256, snapshot) {
  const selfSuperseded = parsed.supersedes === input.ids.owner;
  switch (parsed.mode) {
    case 'release':
    case 'heartbeat':
      return (
        selfSuperseded &&
        parsed.bodySha256 === bodySha256 &&
        parsed.snapshotSha256 === 'none'
      );
    case 'release-guard':
      return (
        selfSuperseded &&
        parsed.bodySha256 === 'none' &&
        parsed.snapshotSha256 === 'none'
      );
    case 'release-complete':
      return (
        selfSuperseded &&
        parsed.bodySha256 === 'none' &&
        parsed.snapshotSha256 === snapshot
      );
    default:
      return true;
  }
}
/** The valid markers of this run with `mode`, earliest first. A marker that
 * matches this run's identity but breaks the mode's field rules is a defect in
 * an append-only log, so it stops the release with recovery-hold rather than
 * counting as a match or as absence. */
function validOwned(log, input, mode, bodySha256, snapshot, step) {
  const valid = [];
  for (const comment of log) {
    const owned = oursMatching(
      [comment],
      input,
      (parsed) => parsed.mode === mode,
    );
    if (owned === null) {
      continue;
    }
    if (!markerFieldsValid(owned.parsed, input, bodySha256, snapshot)) {
      throw new CarrierReleaseStop(
        'recovery-hold',
        step,
        `a ${mode} marker of this run (comment ${owned.id}) does not carry the fields of this release`,
      );
    }
    valid.push(owned);
  }
  return valid.sort((left, right) => left.id - right.id);
}
function readOwnerLog(input, step) {
  try {
    return fetchProvenanceCommentsGraphql(
      input.owner,
      input.repo,
      input.number,
    );
  } catch (error) {
    throw new CarrierReleaseStop(
      'held',
      step,
      `the owner-marker log is unreadable: ${messageOf(error)}`,
    );
  }
}
/** Competing or edited trusted owner markers are recovery-hold, with no write. */
function replayOrRecover(input, log, step) {
  const problem = checkOwnerLogStillOurs({
    comments: log,
    markerPrefix: input.markerPrefix,
    trusted: input.trusted,
    ids: input.ids,
    anchor: `${input.owner}/${input.repo}#${input.number}`,
  });
  if (problem !== null) {
    throw new CarrierReleaseStop('recovery-hold', step, problem);
  }
}
function readCarrierSnapshot(input, step) {
  try {
    return readIssue(input.owner, input.repo, input.number);
  } catch (error) {
    throw new CarrierReleaseStop(
      'held',
      step,
      `the carrier cannot be read: ${messageOf(error)}`,
    );
  }
}
/** Up to CARRIER_READ_ATTEMPTS bounded re-reads. `found` is true only when the
 * check finds what it looks for. `lastError` is the last read failure (empty
 * when the last read was readable), so a stop can name an unreadable log. */
function readUntil(input, check) {
  let lastError = '';
  for (let attempt = 1; attempt <= CARRIER_READ_ATTEMPTS; attempt += 1) {
    try {
      const log = fetchProvenanceCommentsGraphql(
        input.owner,
        input.repo,
        input.number,
      );
      lastError = '';
      if (check(log)) {
        return { found: true, lastError };
      }
    } catch (error) {
      // A recovery-hold stop from the check (a malformed marker of this run)
      // is a defect, not an unreadable read: it propagates, never absence.
      if (
        error instanceof CarrierReleaseStop &&
        error.state === 'recovery-hold'
      ) {
        throw error;
      }
      lastError = messageOf(error);
    }
    if (attempt < CARRIER_READ_ATTEMPTS) {
      sleepMs(input.settleMs);
    }
  }
  return { found: false, lastError };
}
/** True when the comment with this id is an unedited trusted marker of this
 * run whose mode is one of `modes`. */
function markerOnLogModes(log, input, id, modes) {
  return log.some(
    (comment) =>
      oursMatching([comment], input, (parsed) => modes.includes(parsed.mode))
        ?.id === id,
  );
}
function ownerMarkerArgs(input, mode, bodySha256, snapshotSha256) {
  const issueRef = `${input.owner}/${input.repo}#${input.number}`;
  return [
    '--type',
    'authoring-owner',
    '--target',
    'issue',
    String(input.number),
    '--owner',
    input.owner,
    '--repo',
    input.repo,
    '--marker-target',
    issueRef,
    '--anchor',
    issueRef,
    '--mode',
    mode,
    '--marker-owner',
    input.ids.owner,
    '--set',
    input.ids.set,
    '--session',
    input.ids.session,
    '--body-sha256',
    bodySha256,
    '--snapshot-sha256',
    snapshotSha256,
    '--supersedes',
    input.ids.owner,
    '--marker-prefix',
    input.markerPrefix,
    ...input.trustedFlag,
  ];
}
/** Post one owner marker through the verified poster; a failure is held. */
function postCarrierMarker(input, mode, bodySha256, snapshotSha256, step) {
  try {
    return input.postMarker(
      ownerMarkerArgs(input, mode, bodySha256, snapshotSha256),
      { owner: input.owner, repo: input.repo, number: input.number },
    );
  } catch (error) {
    throw new CarrierReleaseStop('held', step, messageOf(error));
  }
}
/** A runnable helper call; the helper's own output is parsed, never trusted
 * as a pass unless its own exit and fields say so. */
function runCarrierHelper(script, args) {
  const run = runSiblingHelper(script, args);
  return { status: run.status, json: parseJsonOutput(run), run };
}
function runCarrierAudit(input, bodyFile, extra) {
  const args = [
    '--shape',
    'carrier',
    '--body-file',
    bodyFile,
    '--marker-prefix',
    input.markerPrefix,
    '--current-repo',
    `${input.owner}/${input.repo}`,
    '--label',
    input.authoringLabel,
    '--label',
    input.authoringOnlyLabel,
    ...extra,
  ];
  if (input.policyPath) {
    args.push('--config', input.policyPath);
  }
  const { status, json } = runCarrierHelper('audit-authored-issue.mjs', args);
  const rawFindings = json?.findings;
  const findings = Array.isArray(rawFindings) ? rawFindings : [];
  const failingIds = findings
    .filter(
      (finding) =>
        typeof finding === 'object' &&
        finding !== null &&
        finding.result === 'fail',
    )
    .map((finding) => finding.id);
  return {
    status,
    passed: status === 0 && json?.passed === true,
    failingIds,
    findings,
  };
}
/** Preconditions (a) to (e) of the carrier creation-hold exception, in order.
 * Returns the acquire marker's body digest, which the removal must keep. */
function checkCarrierPreconditions(input, scratch, snapshot) {
  const { body } = snapshot;
  // (a) no roadmap-id marker outside code: read on the code-masked body.
  const masked = maskMarkdownCodeRegionsPreservingPositions(body);
  if (
    new RegExp(
      `<!--\\s*${escapeRegExp(input.markerPrefix)}-roadmap-id\\b`,
      'iu',
    ).test(masked)
  ) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-roadmap-id',
      'a roadmap-id marker is outside code in the carrier body',
    );
  }
  // (b) sole member of the set, with no requested-set entry that blocks.
  const setArgs = [
    '--set',
    input.ids.set,
    '--issue',
    String(input.number),
    '--owner',
    input.owner,
    '--repo',
    input.repo,
    '--marker-prefix',
    input.markerPrefix,
  ];
  if (input.policyPath) {
    setArgs.push('--policy', input.policyPath);
  }
  if (input.trusted.length > 0) {
    setArgs.push('--trusted-marker-logins', input.trusted.join(','));
  }
  const members = runCarrierHelper('authoring-set-members.mjs', setArgs);
  if (members.status !== 0 || members.json === null) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-sole-member',
      `the sole-member check is inconclusive: ${helperFailure('authoring-set-members', members.run)}`,
    );
  }
  const issues = Array.isArray(members.json.issues)
    ? members.json.issues
    : null;
  if (
    members.json.soleMember !== true ||
    issues === null ||
    issues.length !== 1 ||
    issues[0] !== input.number
  ) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-sole-member',
      `the carrier is not the sole member of its set: issues ${JSON.stringify(members.json.issues ?? null)}`,
    );
  }
  // A skipped-markers value that is present but not a list, or an entry of a
  // shape this check does not recognize, makes the result inconclusive.
  if (
    members.json.skippedMarkers !== undefined &&
    !Array.isArray(members.json.skippedMarkers)
  ) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-sole-member',
      'the sole-member result carries skippedMarkers that are not a list',
    );
  }
  const skipped = Array.isArray(members.json.skippedMarkers)
    ? members.json.skippedMarkers
    : [];
  for (const entry of skipped) {
    // A non-object entry (null, a number) has no kind, so it is unrecognized.
    const record = typeof entry === 'object' && entry !== null ? entry : {};
    const hasIssue =
      typeof record.issueNumber === 'number' &&
      Number.isInteger(record.issueNumber);
    const recognized =
      hasIssue &&
      ((record.kind === 'requested-set' && typeof record.mode === 'string') ||
        (record.kind === 'unattributable' &&
          typeof record.namesRequestedSet === 'boolean'));
    if (!recognized) {
      throw new CarrierReleaseStop(
        'held',
        'precondition-sole-member',
        'a skipped marker has a shape this check does not recognize, so the sole-member result is inconclusive',
      );
    }
    if (
      record.kind === 'requested-set' &&
      record.issueNumber === input.number
    ) {
      continue;
    }
    // A requested-set entry carries no namesRequestedSet field, so its kind
    // blocks on any other issue; only the carrier's own hidden marker passes.
    if (record.kind === 'requested-set' || record.namesRequestedSet === true) {
      throw new CarrierReleaseStop(
        'held',
        'precondition-sole-member',
        'a skipped marker names the requested set',
      );
    }
  }
  // (c) the carrier audit: one carrier marker outside code, and the checklist.
  const bodyFile = join(scratch, 'carrier-body.md');
  writeFileSync(bodyFile, body);
  const audit = runCarrierAudit(input, bodyFile, []);
  if (!audit.passed) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-audit',
      `audit-authored-issue --shape carrier did not pass: ${audit.failingIds.join(', ') || 'no verdict'}`,
    );
  }
  // The body and the labels that (d) and (e) check are read now, after the
  // slow checks above: a body edit or label change during them must not pass
  // on the start-of-check snapshot.
  const current = readCarrierSnapshot(input, 'precondition-body-digest');
  if (sha256Hex(current.body) !== sha256Hex(body)) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-body-digest',
      'the body changed while the preconditions ran',
    );
  }
  // (d) the body digest still equals the acquire marker's body-sha256.
  const log = readOwnerLog(input, 'precondition-body-digest');
  replayOrRecover(input, log, 'precondition-body-digest');
  const acquire = oursMatching(
    log,
    input,
    (parsed) => parsed.mode === 'acquire',
  );
  if (acquire === null) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-body-digest',
      'no acquire owner marker of this run is on the carrier',
    );
  }
  const digest = sha256Hex(body);
  if (digest !== acquire.parsed.bodySha256) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-body-digest',
      'the body no longer matches the acquire marker body-sha256',
    );
  }
  // The acquire marker must carry the fields post-idd-marker enforces for it:
  // no supersession and no snapshot. A digest match alone is not enough.
  if (
    acquire.parsed.supersedes !== 'none' ||
    acquire.parsed.snapshotSha256 !== 'none'
  ) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-body-digest',
      'the acquire marker does not carry supersedes none and snapshot none',
    );
  }
  // (e) both labels are present, on the fresh read.
  if (
    !hasLabel(current.labels, input.authoringOnlyLabel) ||
    !hasLabel(current.labels, input.authoringLabel)
  ) {
    throw new CarrierReleaseStop(
      'held',
      'precondition-labels',
      'a required label is missing from the carrier',
    );
  }
  return acquire.parsed.bodySha256;
}
/** The backlog count from `authoring-marker-minimization-backlog`, read from
 * the audit's own finding detail. Recorded only: it never blocks. */
function runCarrierBacklog(input, point, bodyFile, scratch, backlog) {
  const toAuditComments = (comments) =>
    comments.map((comment) => ({
      id: String(comment.id),
      body: comment.body,
      author: comment.authorLogin,
      createdAt: comment.createdAt,
      isMinimized: comment.isMinimized === true,
    }));
  let count = null;
  let failure = 'the audit did not report a count';
  try {
    const carrier = fetchProvenanceCommentsGraphql(
      input.owner,
      input.repo,
      input.number,
    );
    const journal = fetchProvenanceCommentsGraphql(
      input.journal.owner,
      input.journal.repo,
      input.journal.number,
    );
    const commentsFile = join(scratch, `comments-${point}.json`);
    const journalFile = join(scratch, `journal-${point}.json`);
    writeFileSync(commentsFile, JSON.stringify(toAuditComments(carrier)));
    writeFileSync(journalFile, JSON.stringify(toAuditComments(journal)));
    const audit = runCarrierAudit(input, bodyFile, [
      '--comments-file',
      commentsFile,
      '--journal-comments-file',
      journalFile,
      '--trusted-marker-logins',
      input.trusted.join(','),
    ]);
    const finding = audit.findings.find(
      (entry) => entry.id === 'authoring-marker-minimization-backlog',
    );
    const detail = typeof finding?.detail === 'string' ? finding.detail : '';
    const match = /^(\d+) eligible/u.exec(detail);
    if (match) {
      count = Number(match[1]);
    } else if (/no eligible/u.test(detail)) {
      count = 0;
    }
  } catch (error) {
    count = null;
    failure = messageOf(error);
  }
  backlog.push({
    point,
    count,
    detail: count === null ? failure : 'counted',
  });
}
/** A sweep attempt: recorded, never blocking (contract.md, "Mandatory
 * release-time hide-on-supersede sweep"). */
function runCarrierSweep(input, point, sweeps) {
  const args = [
    '--owner',
    input.owner,
    '--repo',
    input.repo,
    '--issue',
    String(input.number),
    '--issue',
    input.journal.ref,
    '--marker-prefix',
    input.markerPrefix,
    '--trusted-marker-logins',
    input.trusted.join(','),
    '--deadline-ms',
    String(CARRIER_SWEEP_DEADLINE_MS),
    '--apply',
    '--format',
    'json',
  ];
  const { status, json, run } = runCarrierHelper(
    'sweep-authoring-markers.mjs',
    args,
  );
  const failed = status !== 0 || json === null;
  sweeps.push({
    point,
    exitCode: status,
    failed,
    detail: failed ? helperFailure('sweep-authoring-markers', run) : 'ok',
  });
}
/** Bounded re-reads until the marker with this id is on the carrier's log. */
function requireMarkerOnLog(input, id, mode, step, bodySha256, snapshot) {
  const confirmed = readUntil(input, (log) =>
    validOwned(log, input, mode, bodySha256, snapshot, step).some(
      (owned) => owned.id === id,
    ),
  );
  if (!confirmed.found) {
    const cause = confirmed.lastError === '' ? '' : `: ${confirmed.lastError}`;
    throw new CarrierReleaseStop(
      'held',
      step,
      `the ${mode} marker ${id} is not found conclusively on the carrier log${cause}`,
    );
  }
}
/** Remove the authoring label, then verify. A failed verification restores the
 * label only when the owner log is still ours (contract.md, "label removal"). */
function removeAuthoringLabel(input, releaseId, acquireDigest) {
  const repoRef = `${input.owner}/${input.repo}`;
  let removeError = null;
  try {
    ghText([
      'issue',
      'edit',
      String(input.number),
      '--repo',
      repoRef,
      '--remove-label',
      input.authoringLabel,
    ]);
  } catch (error) {
    removeError = messageOf(error);
  }
  const after = readCarrierAfterWrite(input, 'label-removal');
  if (hasLabel(after.labels, input.authoringLabel)) {
    throw new CarrierReleaseStop(
      'held',
      'label-removal',
      removeError === null
        ? 'the authoring label is still present after the removal'
        : `the removal could not be verified and the label is still present: ${removeError}`,
    );
  }
  // The label is gone. Verify the rest of the release state.
  const problems = [];
  if (!hasLabel(after.labels, input.authoringOnlyLabel)) {
    problems.push('the authoring-only label is missing');
  }
  if (sha256Hex(after.body) !== acquireDigest) {
    problems.push('the body snapshot changed');
  }
  const log = readOwnerLogAfterWrite(input, 'label-removal-verify');
  replayOrRecover(input, log, 'label-removal-verify');
  if (
    !validOwned(
      log,
      input,
      'release',
      acquireDigest,
      'none',
      'label-removal-verify',
    ).some((owned) => owned.id === releaseId)
  ) {
    // A lagging log can miss a landed marker, so confirm the absence with
    // bounded re-reads before a restore. An unreadable log is never absence.
    const confirmed = readUntil(input, (fresh) =>
      validOwned(
        fresh,
        input,
        'release',
        acquireDigest,
        'none',
        'label-removal-verify',
      ).some((owned) => owned.id === releaseId),
    );
    if (!confirmed.found) {
      if (confirmed.lastError !== '') {
        throw new CarrierReleaseStop(
          'recovery-hold',
          'label-removal-verify',
          `the release marker cannot be confirmed: ${confirmed.lastError}`,
        );
      }
      problems.push('the release marker is missing');
    }
  }
  if (problems.length === 0) {
    return;
  }
  // Verification failed with the label absent. Replay the owner log once more
  // right before the restore: a competing trusted marker that appeared since
  // the first read stops here with no write.
  replayOrRecover(
    input,
    readOwnerLogAfterWrite(input, 'label-removal-verify'),
    'label-removal-verify',
  );
  restoreReleaseLabels(
    input,
    after.labels,
    `verification after the removal failed (${problems.join('; ')})`,
    'label-removal-verify',
  );
}
/** Restore the release labels that are missing, then verify the restore. The
 * caller has replayed the owner log and found it ours. Always throws: `held`
 * once both labels are back (a person's release is still needed), and
 * `recovery-hold` when the restore fails or cannot be verified. */
function restoreReleaseLabels(input, labels, problem, step) {
  const repoRef = `${input.owner}/${input.repo}`;
  // Replay the owner log right before any restore: a competing trusted marker
  // that appeared since the last read stops here with no label write.
  replayOrRecover(input, readOwnerLogAfterWrite(input, step), step);
  // Every missing release label, the authoring-only label included, so no
  // path leaves the carrier without its exclusion label.
  const restoreNames = [input.authoringLabel, input.authoringOnlyLabel].filter(
    (name) => !hasLabel(labels, name),
  );
  if (restoreNames.length > 0) {
    try {
      ghText([
        'issue',
        'edit',
        String(input.number),
        '--repo',
        repoRef,
        ...restoreNames.flatMap((name) => ['--add-label', name]),
      ]);
    } catch (error) {
      throw new CarrierReleaseStop(
        'recovery-hold',
        'label-restore',
        `the restore of the labels failed: ${messageOf(error)}`,
      );
    }
  }
  const restored = readCarrierAfterWrite(input, 'label-restore');
  if (
    !hasLabel(restored.labels, input.authoringLabel) ||
    !hasLabel(restored.labels, input.authoringOnlyLabel)
  ) {
    throw new CarrierReleaseStop(
      'recovery-hold',
      'label-restore',
      'the restored labels are not all on the carrier',
    );
  }
  throw new CarrierReleaseStop(
    'held',
    step,
    `${problem}; both release labels are on the carrier`,
  );
}
/** A read after the label has been removed or reapplied. It is recovery-hold,
 * not held, when it fails: a held reason would say both labels stay in place,
 * which is no longer true once a write has landed. */
function readCarrierAfterWrite(input, step) {
  let lastError = '';
  for (let attempt = 1; attempt <= CARRIER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readIssue(input.owner, input.repo, input.number);
    } catch (error) {
      lastError = messageOf(error);
    }
    if (attempt < CARRIER_READ_ATTEMPTS) {
      sleepMs(input.settleMs);
    }
  }
  throw new CarrierReleaseStop(
    'recovery-hold',
    step,
    `the carrier cannot be read after a label write (${CARRIER_READ_ATTEMPTS} attempts): ${lastError}`,
  );
}
function readOwnerLogAfterWrite(input, step) {
  let lastError = '';
  for (let attempt = 1; attempt <= CARRIER_READ_ATTEMPTS; attempt += 1) {
    try {
      return fetchProvenanceCommentsGraphql(
        input.owner,
        input.repo,
        input.number,
      );
    } catch (error) {
      lastError = messageOf(error);
    }
    if (attempt < CARRIER_READ_ATTEMPTS) {
      sleepMs(input.settleMs);
    }
  }
  throw new CarrierReleaseStop(
    'recovery-hold',
    step,
    `the owner-marker log cannot be read after a label write (${CARRIER_READ_ATTEMPTS} attempts): ${lastError}`,
  );
}
/** Run the release for one carrier. Never throws: every stop is reported. */
export function releaseCarrier(input) {
  const sweeps = [];
  const backlog = [];
  const steps = [];
  let scratch = '';
  let step = CARRIER_RELEASE_PLAN[0];
  const mark = (name) => {
    step = name;
    steps.push(name);
  };
  try {
    // The scratch directory is allocated inside the guard: a failure here is
    // still reported as a recovery hold, and nothing has been written yet.
    scratch = mkdtempSync(join(tmpdir(), 'idd-carrier-release-'));
    runCarrierRelease(input, scratch, { sweeps, backlog, mark });
    return {
      state: 'released',
      failedStep: null,
      nextAction: '',
      reason: null,
      sweeps,
      backlog,
      steps,
    };
  } catch (error) {
    const stop =
      error instanceof CarrierReleaseStop
        ? error
        : new CarrierReleaseStop('recovery-hold', step, messageOf(error));
    return {
      state: stop.state,
      failedStep: stop.failedStep,
      nextAction:
        stop.state === 'held'
          ? CARRIER_HELD_NEXT_ACTION
          : CARRIER_RECOVERY_NEXT_ACTION,
      reason: stop.message,
      sweeps,
      backlog,
      steps,
    };
  } finally {
    // A failed cleanup of the scratch copies never changes the reported result.
    if (scratch !== '') {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Left for the operator's temporary-directory cleanup.
      }
    }
  }
}
function runCarrierRelease(input, scratch, ctx) {
  const { owner, repo, number } = input;
  const bodyFile = join(scratch, 'release-body.md');
  // (1) Preflight: replay, sweep, backlog, then reuse or post `release`.
  ctx.mark('release-preflight');
  replayOrRecover(
    input,
    readOwnerLog(input, 'release-preflight'),
    'release-preflight',
  );
  runCarrierSweep(input, 'preflight', ctx.sweeps);
  const preflight = readCarrierSnapshot(input, 'release-preflight');
  writeFileSync(bodyFile, preflight.body);
  runCarrierBacklog(input, 'preflight', bodyFile, scratch, ctx.backlog);
  const digest = sha256Hex(preflight.body);
  // The reuse decision reads the log after the sweep and backlog, replays it,
  // and reuses only a release marker whose fields match this release.
  const preLog = readOwnerLog(input, 'release-preflight');
  replayOrRecover(input, preLog, 'release-preflight');
  const existingRelease = validOwned(
    preLog,
    input,
    'release',
    digest,
    'none',
    'release-preflight',
  )[0];
  const releaseId =
    existingRelease?.id ??
    postCarrierMarker(input, 'release', digest, 'none', 'release-preflight');
  // (2) release-guard on the anchor, which is the carrier itself.
  ctx.mark('release-guard');
  const guardLog = readOwnerLog(input, 'release-guard');
  replayOrRecover(input, guardLog, 'release-guard');
  const guardExisting = validOwned(
    guardLog,
    input,
    'release-guard',
    'none',
    'none',
    'release-guard',
  )[0];
  const guardId =
    guardExisting?.id ??
    postCarrierMarker(input, 'release-guard', 'none', 'none', 'release-guard');
  requireMarkerOnLog(
    input,
    guardId,
    'release-guard',
    'release-guard',
    'none',
    'none',
  );
  replayOrRecover(input, readOwnerLog(input, 'release-guard'), 'release-guard');
  // (3) Preconditions, before the heartbeat.
  ctx.mark('preconditions');
  const beforeHeartbeat = readCarrierSnapshot(input, 'preconditions');
  const acquireDigest = checkCarrierPreconditions(
    input,
    scratch,
    beforeHeartbeat,
  );
  // (4) Heartbeat, with the coalescing rule, then the settle wait and replay.
  ctx.mark('heartbeat');
  const heartbeatBody = readCarrierSnapshot(input, 'heartbeat');
  const heartbeatDigest = sha256Hex(heartbeatBody.body);
  const heartbeatLog = readOwnerLog(input, 'heartbeat');
  replayOrRecover(input, heartbeatLog, 'heartbeat');
  const latest = latestOursMarker(heartbeatLog, input);
  // Reuse only a marker whose fields match what a fresh heartbeat would carry:
  // an acquire marker of this run (supersedes none, snapshot none) or a valid
  // heartbeat. Anything else is posted fresh and verified like any heartbeat.
  const reusable =
    latest !== null &&
    COALESCING_MODES.has(latest.parsed.mode) &&
    Date.now() - Date.parse(latest.createdAt) < input.heartbeatWindowMs &&
    latest.parsed.bodySha256 === heartbeatDigest &&
    ((latest.parsed.mode === 'acquire' &&
      latest.parsed.supersedes === 'none' &&
      latest.parsed.snapshotSha256 === 'none') ||
      (latest.parsed.mode === 'heartbeat' &&
        markerFieldsValid(latest.parsed, input, heartbeatDigest, 'none')));
  const coalescedId = reusable && latest !== null ? latest.id : null;
  // The mode of the reused marker, for its identity check after the settle
  // wait: the same validated mode, not every coalescing mode.
  const coalescedMode = reusable && latest !== null ? latest.parsed.mode : '';
  const heartbeatId =
    coalescedId ??
    postCarrierMarker(input, 'heartbeat', heartbeatDigest, 'none', 'heartbeat');
  sleepMs(input.settleMs);
  const replayLog = readOwnerLog(input, 'heartbeat-replay');
  replayOrRecover(input, replayLog, 'heartbeat-replay');
  if (
    !validOwned(
      replayLog,
      input,
      'release',
      acquireDigest,
      'none',
      'heartbeat-replay',
    ).some((owned) => owned.id === releaseId)
  ) {
    throw new CarrierReleaseStop(
      'held',
      'heartbeat-replay',
      'the release marker is not on the carrier after the settle wait',
    );
  }
  // A reused marker is verified exactly as a posted one would be (contract.md,
  // "Heartbeat coalescing"): the reused id must still be an ours marker.
  const heartbeatModes = coalescedId === null ? ['heartbeat'] : [coalescedMode];
  if (!markerOnLogModes(replayLog, input, heartbeatId, heartbeatModes)) {
    throw new CarrierReleaseStop(
      'held',
      'heartbeat-replay',
      'the heartbeat marker is not on the carrier after the settle wait',
    );
  }
  const afterSettle = readCarrierSnapshot(input, 'heartbeat-replay');
  if (sha256Hex(afterSettle.body) !== acquireDigest) {
    throw new CarrierReleaseStop(
      'held',
      'heartbeat-replay',
      'the body no longer matches the acquire marker body-sha256 after the settle wait',
    );
  }
  checkCarrierPreconditions(input, scratch, afterSettle);
  // (5) The single label removal, with its verification.
  ctx.mark('label-removal');
  // Immediately before the removal the owner log must still be ours, with the
  // release, guard, and heartbeat markers on it (contract.md, "Stage 2"). No
  // label has changed yet, so a failed read is held, not recovery-hold.
  const beforeRemoval = readOwnerLog(input, 'label-removal');
  replayOrRecover(input, beforeRemoval, 'label-removal');
  // The body and both labels, read now: (d) and (e) must hold at the edit.
  const edited = readCarrierSnapshot(input, 'label-removal');
  const stateChanged =
    sha256Hex(edited.body) !== acquireDigest ||
    !hasLabel(edited.labels, input.authoringLabel) ||
    !hasLabel(edited.labels, input.authoringOnlyLabel);
  const markersPresent =
    validOwned(
      beforeRemoval,
      input,
      'release',
      acquireDigest,
      'none',
      'label-removal',
    ).some((owned) => owned.id === releaseId) &&
    validOwned(
      beforeRemoval,
      input,
      'release-guard',
      'none',
      'none',
      'label-removal',
    ).some((owned) => owned.id === guardId) &&
    markerOnLogModes(beforeRemoval, input, heartbeatId, heartbeatModes);
  if (!markersPresent) {
    throw new CarrierReleaseStop(
      'held',
      'label-removal',
      'the release, guard, or heartbeat marker is not on the carrier immediately before the removal',
    );
  }
  if (stateChanged) {
    throw new CarrierReleaseStop(
      'held',
      'label-removal',
      'the body or a release label changed immediately before the removal',
    );
  }
  // The full precondition pass runs once more here, on this fresh read: the
  // sole-member result, the carrier audit, the body digest, and both labels
  // must hold at the removal itself (contract.md, "Carrier creation-hold").
  checkCarrierPreconditions(input, scratch, edited);
  removeAuthoringLabel(input, releaseId, acquireDigest);
  // (6) release-complete. The sweep and the backlog run first, so the fresh
  // reads below are the last ones before the decision and the post.
  ctx.mark('release-complete');
  runCarrierSweep(input, 'pre-release-complete', ctx.sweeps);
  const beforeBacklog = readCarrierAfterWrite(input, 'release-complete');
  writeFileSync(bodyFile, beforeBacklog.body);
  runCarrierBacklog(
    input,
    'pre-release-complete',
    bodyFile,
    scratch,
    ctx.backlog,
  );
  // Drift check right before the decision (contract.md, "Stage 2"): the body,
  // the absent label, the present authoring-only label, and both release
  // markers must still hold on reads taken now. Any drift is recovery-hold.
  const current = readCarrierAfterWrite(input, 'release-complete');
  const driftLog = readOwnerLogAfterWrite(input, 'release-complete');
  replayOrRecover(input, driftLog, 'release-complete');
  const drifted =
    sha256Hex(current.body) !== acquireDigest ||
    hasLabel(current.labels, input.authoringLabel) ||
    !hasLabel(current.labels, input.authoringOnlyLabel) ||
    validOwned(
      driftLog,
      input,
      'release',
      acquireDigest,
      'none',
      'release-complete',
    ).every((owned) => owned.id !== releaseId) ||
    validOwned(
      driftLog,
      input,
      'release-guard',
      'none',
      'none',
      'release-complete',
    ).every((owned) => owned.id !== guardId);
  if (drifted) {
    // The removal already landed, so restore what is missing while the owner
    // log is ours, and stay held: no completion marker was posted.
    restoreReleaseLabels(
      input,
      current.labels,
      'the carrier drifted after the label removal (body, labels, or a release marker); no completion marker was posted',
      'release-complete',
    );
  }
  const snapshot = carrierSetSnapshot(owner, repo, number, acquireDigest);
  const completeExisting =
    validOwned(
      driftLog,
      input,
      'release-complete',
      'none',
      snapshot,
      'release-complete',
    )[0] ?? null;
  let postError = null;
  if (completeExisting === null) {
    try {
      input.postMarker(
        ownerMarkerArgs(input, 'release-complete', 'none', snapshot),
        { owner, repo, number },
      );
    } catch (error) {
      postError = error;
    }
  }
  let found = completeExisting !== null;
  let conclusive = false;
  for (
    let attempt = 1;
    attempt <= CARRIER_READ_ATTEMPTS && !found;
    attempt += 1
  ) {
    try {
      const log = readOwnerLog(input, 'release-complete');
      conclusive = true;
      replayOrRecover(input, log, 'release-complete');
      found =
        validOwned(
          log,
          input,
          'release-complete',
          'none',
          snapshot,
          'release-complete',
        ).length > 0;
    } catch (error) {
      if (
        error instanceof CarrierReleaseStop &&
        error.state === 'recovery-hold'
      ) {
        throw error;
      }
      conclusive = false;
    }
    if (!found && attempt < CARRIER_READ_ATTEMPTS) {
      sleepMs(input.settleMs);
    }
  }
  if (!found) {
    // A post that reported nothing sent, plus a complete read that finds no
    // trusted marker, proves nothing was appended: reapply the label.
    // Only the nothingSent flag (notDispatched, or HTTP 401, 404 or 422) proves
    // the post never landed; any other error is uncertain and stops here.
    const nothingSent = postError?.nothingSent === true;
    if (nothingSent && conclusive) {
      // Reapply and verify every release label that is missing, the
      // authoring-only label included (the same helper as the restores above).
      const current = readCarrierAfterWrite(input, 'release-complete-reapply');
      restoreReleaseLabels(
        input,
        current.labels,
        'the release-complete post reported nothing sent',
        'release-complete',
      );
    }
    throw new CarrierReleaseStop(
      'recovery-hold',
      'release-complete',
      'the release-complete marker cannot be reconciled; the release guard and the current labels stay in place',
    );
  }
  // (7) Closing sweep, once the release is complete.
  ctx.mark('closing-sweep');
  runCarrierSweep(input, 'closing', ctx.sweeps);
  // The release is already complete here, so a failed read of the closing
  // backlog is recorded and never turns `released` into a hold.
  try {
    const closing = readIssue(owner, repo, number);
    writeFileSync(bodyFile, closing.body);
    runCarrierBacklog(input, 'closing', bodyFile, scratch, ctx.backlog);
  } catch (error) {
    ctx.backlog.push({
      point: 'closing',
      count: null,
      detail: messageOf(error),
    });
  }
}
function isPosted(error) {
  return error?.posted === true;
}
/**
 * The report fields of a failed step: `nothingSent: true` when the envelope
 * proves the post unsent, or `nothingSent: false` with the uncertain journal
 * state when it may have landed. A failure that made no post at all (a check
 * before it) reports neither.
 */
function postOutcome(error) {
  if (error?.nothingSent === true) {
    return { nothingSent: true };
  }
  if (isPosted(error)) {
    return { nothingSent: false, journalState: JOURNAL_STATE_UNCERTAIN };
  }
  return {};
}
function recoveryHold(report) {
  const message = `recovery hold at step ${String(report.failedStep)}: ${String(report.reason)}`;
  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', outcome: 'recovery-hold', journalState: 'pending', ...report }, null, 2)}\n`,
  );
  process.stderr.write(
    `publish-authoring-hold: ${message}${report.issue ? ` (issue ${String(report.issue)} stays held)` : ''}\n`,
  );
  return { exitCode: 1, kind: 'gate', message };
}
