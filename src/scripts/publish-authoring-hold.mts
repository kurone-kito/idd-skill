#!/usr/bin/env node
// idd-generated-from: src/scripts/publish-authoring-hold.mts
//
// The scripts/publish-authoring-hold.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Capability-checked Stage 1 publication of one held orphan issue
// (kurone-kito/idd-skill#4127). The issue-authoring skill allows a new issue
// only through a create-with-label command and stops when none exists. This
// helper runs the contract's "New-issue ownership" sequence in order: journal
// check, publication line, lint, labels, pending intent, create, identity
// attach, owner marker, provenance, member. It spawns the sibling helpers
// (audit-authored-issue, post-idd-marker, authoring-owner-provenance) rather
// than reimplementing their checks. It never runs a review, a Stage 2
// release, or a close. A failed marker post is uncertain unless the
// child's error envelope proves that nothing was sent (#4171).

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AuthoringOwnerProvenanceComment,
  fetchProvenanceCommentsGraphql,
} from './authoring-owner-provenance.mts';
import { resolveBundleRoot } from './bundle-root.mts';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { ghApiJson, ghText, resolveViewerLogin } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import { readRepositoryPolicyFile } from './idd-config.mts';
import { resolveOpenLinkedPrIssues } from './idd-roadmap-audit-execute.mts';
import {
  normalizeMarkerPrefix,
  parseAuthoringOwnerComment,
  parseAuthoringPublicationComment,
} from './marker-helpers.mts';
import {
  AUTHORING_JOURNAL_REFERENCE_PATTERN,
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  readClaimStaleAgeMs,
  resolveActiveClaimForWriteGate,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';

export const PUBLISH_BUCKETS = [
  'ready',
  'needs-decision',
  'blocked-by-human',
] as const;
export type PublishBucket = (typeof PUBLISH_BUCKETS)[number];

const PUBLISH_AUTHORING_HOLD_FLAG_SPEC = {
  '--title': { type: 'string' },
  '--body-file': { type: 'string' },
  '--review-result': { type: 'string' },
  '--shape': { type: 'string', default: 'orphan' },
  '--bucket': { type: 'string', default: 'ready' },
  '--apply': { type: 'boolean' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--marker-prefix': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A record that may have been posted but could not be verified: replay the
 * journal to learn its state. */
const JOURNAL_STATE_UNCERTAIN = 'uncertain: replay the journal';

/** HTTP statuses that, on the post's first attempt, prove nothing landed
 * (the retry layer never reports them after a later attempt, #4171). */
const NOTHING_SENT_HTTP_STATUSES = new Set([401, 404, 422]);

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('publish-authoring-hold', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

/** The opaque ids one publication carries. For an orphan, anchor = target. */
export interface PublicationIds {
  target: string;
  anchor: string;
  set: string;
  session: string;
  token: string;
  owner: string;
}

export function generatePublicationIds(
  uuid: () => string = randomUUID,
): PublicationIds {
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

/** The exact HTML-first body line of contract.md's "New-issue ownership". */
export function renderPublicationLine(
  markerPrefix: string,
  ids: PublicationIds,
): string {
  return `<!-- ${markerPrefix}-authoring-publication: target=${ids.target}; anchor=${ids.anchor}; set=${ids.set}; session=${ids.session}; token=${ids.token} -->`;
}

/**
 * Put the publication line first, followed by one blank line and the draft.
 * Throws when the draft already carries a publication line (the command owns
 * the ids, so a second line would make the token ambiguous) or when the
 * injected line does not parse back to the same ids.
 */
export function injectPublicationLine(
  body: string,
  markerPrefix: string,
  ids: PublicationIds,
): string {
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
 * Check the review-result file contents. It must be a JSON object with
 * `"completed": true`. An optional `findings` array holds findings-ledger
 * entries; each needs a `disposition` of `fixed` or `rejected`, because a
 * draft with an open `deferred` entry is not published (contract.md,
 * "Carry-forward of rejected findings"). Returns a refusal reason, or null.
 */
export function checkReviewResult(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'the review result is not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'the review result is not a JSON object';
  }
  const record = parsed as { completed?: unknown; findings?: unknown };
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
        ? (entry as { disposition?: unknown }).disposition
        : undefined;
    if (disposition !== 'fixed' && disposition !== 'rejected') {
      return `review finding ${index} has disposition ${JSON.stringify(disposition ?? null)}; every finding must be fixed or rejected before publication`;
    }
  }
  return null;
}

/**
 * The linter argv for the injected body. A ready publish passes neither
 * `--expect-bucket` nor `--label`; a non-ready publish passes the bucket and
 * one `--label` for each configured label.
 */
export function buildLintArgs(input: {
  shape: string;
  title: string;
  bodyFile: string;
  markerPrefix: string;
  currentRepo: string;
  bucket: PublishBucket;
  labels: readonly string[];
  policy?: string;
}): string[] {
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
  if (input.bucket !== 'ready') {
    args.push('--expect-bucket', input.bucket);
    for (const label of input.labels) {
      args.push('--label', label);
    }
  }
  return args;
}

/** The authoring label, plus the bucket label for a non-ready publish. */
export function resolvePublishLabels(
  config: unknown,
  bucket: PublishBucket,
): string[] {
  const normalized = normalizePolicyConfig(config);
  const labels = [normalized.issueAuthoring.authoringLabelName];
  if (bucket === 'needs-decision') {
    labels.push(normalized.labels.needsDecisionLabelName);
  } else if (bucket === 'blocked-by-human') {
    labels.push(normalized.labels.blockedByHumanLabelName);
  }
  return labels;
}

/** Parse the configured journal reference, or null when unset or malformed. */
export function parseJournalReference(
  value: unknown,
): { owner: string; repo: string; number: number; ref: string } | null {
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

/** `--shape child` is refused before the strict parse, per #4127. */
export function requestsChildShape(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--shape' && argv[index + 1] === 'child') {
      return true;
    }
    if (arg === '--shape=child') {
      return true;
    }
  }
  return false;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/publish-authoring-hold.mjs --title <text> --body-file <path> --review-result <path> [--shape orphan] [--bucket ready|needs-decision|blocked-by-human] [--owner <owner> --repo <repo>] [--policy <path>] [--trusted-marker-logins <csv>] [--marker-prefix <prefix>] [--apply]

Publishes one drafted orphan issue under the issue-authoring hold, running
contract.md's "New-issue ownership" steps in order:

  1. refuse --shape child (exit 2, nothing else runs), then check the review
     result file;
  2. check issueAuthoring.journalIssue in the repository policy file: it
     must be set, match owner/repo#N, and name an existing issue (it may be
     closed). Otherwise report the blocked-by-human outcome and exit 2;
  3. generate the opaque target, anchor (= target), set, session, token and
     owner ids and put the authoring-publication line first in the body;
  4. lint that exact body with audit-authored-issue --new-issue (a
     non-ready bucket adds the expected bucket and one label flag per
     configured label);
  5. resolve the authoring label (issueAuthoring.authoringLabelName) and,
     for a non-ready bucket, labels.needsDecisionLabelName or
     labels.blockedByHumanLabelName; create a missing label;
  6. append the pending publication-intent record (issue=none) to the
     journal through post-idd-marker and read it back;
  7. create the issue with every label in one gh issue create call;
  8. attach the returned identity to the pending record, append the
     mode=acquire owner marker, wait claim.verifySettleDelay, run
     authoring-owner-provenance, re-read labels, body and claim state,
     and only then append state=member.

Every policy value (the journal, the marker prefix, the label names, the
trusted marker actors and claim.verifySettleDelay) comes from the
repository's own policy file (--policy, or .github/idd/config.json), never
from a user-global layer, because each describes the target repository.
The marker prefix comes from that file only when the issue and the journal
are both in this checkout's repository. Otherwise pass --marker-prefix
with the prefix the target repository configures.

Before any write, the authenticated login must be a trusted marker actor
(--trusted-marker-logins, IDD_TRUSTED_MARKER_ACTORS, or trustedMarkerActors)
and, unless it is a bot, hold Write, Maintain or Admin permission on the
issue's and the journal's repositories.

The review result file is a JSON object with "completed": true. An
optional "findings" array holds findings-ledger entries, and each needs a
disposition of fixed or rejected. The file is not tied to the body; the
caller keeps it for the reviewed draft.

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
labels and is never closed. The Stage 2 release stays a separate,
explicit request.

Exit codes: 0 published (or planned), 1 refused or failed, 2 usage error,
--shape child, or the blocked-by-human journal stop.
`);
}

interface ParsedArgs {
  title: string;
  bodyFile: string;
  reviewResult: string;
  shape: string;
  bucket: string;
  apply: boolean;
  owner: string;
  repo: string;
  policy: string;
  trustedMarkerLogins: string;
  markerPrefix: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, PUBLISH_AUTHORING_HOLD_FLAG_SPEC);
  const text = (key: string): string =>
    ((values[key] as string | undefined) ?? '').trim();
  return {
    title: text('title'),
    bodyFile: (values['body-file'] as string | undefined) ?? '',
    reviewResult: (values['review-result'] as string | undefined) ?? '',
    shape: text('shape'),
    bucket: text('bucket'),
    apply: values.apply === true,
    owner: text('owner'),
    repo: text('repo'),
    policy: (values.policy as string | undefined) ?? '',
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    markerPrefix: text('marker-prefix'),
    help,
  };
}

function usage(message: string): HelperCliResult {
  process.stderr.write(`publish-authoring-hold: ${message}\n`);
  return { exitCode: 2, kind: 'usage', message };
}

function refuse(
  message: string,
  report: Record<string, unknown> = {},
): HelperCliResult {
  process.stdout.write(
    `${JSON.stringify({ outcome: 'refused', reason: message, ...report }, null, 2)}\n`,
  );
  process.stderr.write(`publish-authoring-hold: ${message}\n`);
  return { exitCode: 1, kind: 'gate', message };
}

/** Synchronous wait for the settle delay. */
function sleepMs(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

interface HelperRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSiblingHelper(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): HelperRun {
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

function parseJsonOutput(run: HelperRun): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(run.stdout) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
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
export function markerPostSentNothing(stderr: string): boolean {
  const last = stderr.trimEnd().split('\n').pop() ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return false;
  }
  const envelope = (parsed as { iddHelperError?: unknown } | null)
    ?.iddHelperError as
    | { helper?: unknown; notDispatched?: unknown; httpStatus?: unknown }
    | undefined;
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

function helperFailure(name: string, run: HelperRun): string {
  const lines = (run.stderr.trim() || run.stdout.trim()).split('\n');
  let detail = lines.pop();
  // A requested envelope is the last line; its message names the error,
  // where the line before it may be a stack frame.
  try {
    const message = (
      JSON.parse(detail ?? '') as { iddHelperError?: { message?: unknown } }
    ).iddHelperError?.message;
    if (typeof message === 'string' && message !== '') {
      detail = message;
    }
  } catch {
    // Not an envelope: keep the line as it is.
  }
  return `${name} exited ${run.status ?? 'without a status'}${detail ? `: ${detail}` : ''}`;
}

interface IssueSnapshot {
  labels: string[];
  body: string;
  pullRequest: boolean;
}

function readIssue(owner: string, repo: string, number: number): IssueSnapshot {
  const raw = ghApiJson(`repos/${owner}/${repo}/issues/${number}`) as {
    labels?: unknown;
    body?: unknown;
    pull_request?: unknown;
  } | null;
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`${owner}/${repo}#${number} is not a readable issue`);
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label) =>
          typeof label === 'string'
            ? label
            : String((label as { name?: unknown })?.name ?? ''),
        )
        .filter((name) => name !== '')
    : [];
  return {
    labels,
    body: typeof raw.body === 'string' ? raw.body : '',
    pullRequest: raw.pull_request != null,
  };
}

function hasLabel(labels: readonly string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}

function labelExists(owner: string, repo: string, name: string): boolean {
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
function hasWritePermission(
  owner: string,
  repo: string,
  login: string,
  cache: CollaboratorPermissionCache,
): boolean {
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

/** Inputs of the write-gate claim resolver for the created issue. */
interface ClaimGate {
  owner: string;
  repo: string;
  trusted: readonly string[];
  policyPath: string;
  config: unknown;
}

/** True when the comments carry an active claim, resolved with the same
 * write-gate resolver the review helpers use: a released claim does not
 * count, a forced-handoff successor does when the repository enables forced
 * handoffs, and a claim marker whose edit state is unknown throws (fail
 * closed). The caller has already refused to run with no trusted login. */
function hasActiveClaim(
  comments: readonly AuthoringOwnerProvenanceComment[],
  gate: ClaimGate,
): boolean {
  const trustedSet = new Set(gate.trusted.map((login) => login.toLowerCase()));
  const policyPath = gate.policyPath || undefined;
  const authorityPolicy = readForcedHandoffAuthorityPolicy(policyPath);
  const permissionCache: CollaboratorPermissionCache = new Map();
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
function hasForeignOwnerMarker(
  comments: readonly AuthoringOwnerProvenanceComment[],
  markerPrefix: string,
  trusted: readonly string[],
): boolean {
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
 * owner, set and session. Returns a refusal reason, or null.
 */
export function checkOwnerLogStillOurs(input: {
  comments: readonly AuthoringOwnerProvenanceComment[];
  markerPrefix: string;
  trusted: readonly string[];
  ids: Pick<PublicationIds, 'owner' | 'set' | 'session'>;
}): string | null {
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
      parsed.session !== input.ids.session
    ) {
      return `owner marker ${comment.id} is not this run's marker`;
    }
    ours += 1;
  }
  return ours > 0 ? null : "this run's owner marker is not on the issue";
}

/** True when the issue carries a comment with exactly this body by `actor`.
 * Throws when the comments cannot be read. */
function hasExactComment(
  where: { owner: string; repo: string; number: number },
  body: string,
  actor: string,
): boolean {
  const comments = ghApiJson(
    `repos/${where.owner}/${where.repo}/issues/${where.number}/comments`,
    { paginate: true },
  );
  if (!Array.isArray(comments)) {
    throw new Error('the comments are not readable');
  }
  return comments.some((comment) => {
    const row = comment as { body?: unknown; user?: { login?: unknown } };
    return (
      row.body === body &&
      String(row.user?.login ?? '').toLowerCase() === actor.toLowerCase()
    );
  });
}

/** Compare bodies the way GitHub may store them (CRLF and trailing space). */
function sameBody(left: string, right: string): boolean {
  const normalize = (text: string): string =>
    text.replace(/\r\n/g, '\n').trimEnd();
  return normalize(left) === normalize(right);
}

interface Step {
  step: string;
  status: 'done' | 'planned';
  detail?: unknown;
}

function runCli(): HelperCliResult {
  const argv = process.argv.slice(2);
  if (requestsChildShape(argv)) {
    const message =
      '--shape child is not supported yet; this command publishes a standalone orphan only';
    process.stdout.write(
      `${JSON.stringify({ outcome: 'refused', reason: message }, null, 2)}\n`,
    );
    return usage(message);
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return usage((error as Error).message);
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.shape !== 'orphan') {
    return usage(`--shape must be orphan (got ${JSON.stringify(args.shape)})`);
  }
  if (!(PUBLISH_BUCKETS as readonly string[]).includes(args.bucket)) {
    return usage(`--bucket must be one of ${PUBLISH_BUCKETS.join(', ')}`);
  }
  const bucket = args.bucket as PublishBucket;
  if (args.title === '') {
    return usage('--title is required');
  }
  if (args.bodyFile === '') {
    return usage('--body-file is required');
  }
  if (args.reviewResult === '') {
    return usage(
      '--review-result is required: the completed draft adversarial review must be recorded before publication',
    );
  }
  if ((args.owner === '') !== (args.repo === '')) {
    return usage('--owner and --repo must be provided together or not at all');
  }

  // Step 1: the completed review is recorded, and the draft is readable.
  let reviewRaw: string;
  try {
    reviewRaw = readFileSync(args.reviewResult, 'utf8');
  } catch (error) {
    return refuse(
      `cannot read the review result ${args.reviewResult}: ${(error as Error).message}`,
    );
  }
  const reviewProblem = checkReviewResult(reviewRaw);
  if (reviewProblem !== null) {
    return refuse(reviewProblem);
  }
  let draft: string;
  try {
    draft = readFileSync(args.bodyFile, 'utf8');
  } catch (error) {
    return refuse(
      `cannot read the body file ${args.bodyFile}: ${(error as Error).message}`,
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
  let journalSetting: unknown;
  let policyError = '';
  let config: {
    markerPrefix?: unknown;
    trustedMarkerActors?: unknown;
    claim?: { verifySettleDelay?: unknown };
  } | null = null;
  let policyPath = '';
  try {
    const loaded = readRepositoryPolicyFile(args.policy || undefined);
    policyPath = loaded.path;
    const repositoryPolicy = loaded.config as {
      markerPrefix?: unknown;
      trustedMarkerActors?: unknown;
      claim?: { verifySettleDelay?: unknown };
      issueAuthoring?: { journalIssue?: unknown };
    } | null;
    config = repositoryPolicy;
    journalSetting = repositoryPolicy?.issueAuthoring?.journalIssue;
  } catch (error) {
    policyError = (error as Error).message;
  }
  const blockedByHuman = (reason: string): HelperCliResult => {
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
      `issueAuthoring.journalIssue ${journal.ref} cannot be verified: ${(error as Error).message}`,
    );
  }

  const { actors: trusted } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
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
  // The local policy's prefix is the target's prefix only when the issue and
  // the journal both live in this checkout's repository (contract.md,
  // "Target marker prefix"); otherwise the caller must name it.
  let markerPrefix: string;
  if (args.markerPrefix !== '') {
    markerPrefix = normalizeMarkerPrefix(args.markerPrefix);
  } else {
    let local: { owner: string; repo: string } | null;
    try {
      local =
        args.owner && args.repo
          ? resolveCurrentGithubRepository()
          : currentRepo;
    } catch {
      local = null;
    }
    const same = (a: { owner: string; repo: string }): boolean =>
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

  // Step 3: ids and the publication line.
  const ids = generatePublicationIds();
  let injected: string;
  try {
    injected = injectPublicationLine(draft, markerPrefix, ids);
  } catch (error) {
    return refuse((error as Error).message);
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
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function publish(input: {
  args: ParsedArgs;
  bucket: PublishBucket;
  journal: { owner: string; repo: string; number: number; ref: string };
  owner: string;
  repo: string;
  markerPrefix: string;
  trusted: readonly string[];
  settleMs: number;
  config: unknown;
  policyPath: string;
  ids: PublicationIds;
  injected: string;
  bodyPath: string;
}): HelperCliResult {
  const { args, bucket, journal, owner, repo, markerPrefix, ids } = input;
  const repoRef = `${owner}/${repo}`;
  const steps: Step[] = [];
  const claimGate: ClaimGate = {
    owner,
    repo,
    trusted: input.trusted,
    policyPath: input.policyPath,
    config: input.config,
  };
  const base = {
    repository: { owner, repo },
    journal: journal.ref,
    ids,
  };

  // Step 4: lint the exact body that will be created.
  const labels = resolvePublishLabels(input.config, bucket);
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
  let missing: string[];
  try {
    missing = labels.filter((name) => !labelExists(owner, repo, name));
  } catch (error) {
    return refuse(`cannot read the labels: ${(error as Error).message}`, base);
  }
  // A record from a login replay cannot trust is not valid evidence, so with
  // no trusted marker actor configured nothing is written at all.
  const actor = resolveViewerLogin();
  if (input.trusted.length === 0) {
    return refuse(
      'no trusted marker actor is configured (trustedMarkerActors, IDD_TRUSTED_MARKER_ACTORS or --trusted-marker-logins), so the journal records could not be verified on replay',
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
    const cache: CollaboratorPermissionCache = new Map();
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
  const intentArgs = (state: string, issue: string): string[] => [
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
  ];
  const renderMarker = (markerArgs: string[]): string => {
    const run = runSiblingHelper('post-idd-marker.mjs', markerArgs);
    const body = parseJsonOutput(run)?.body;
    if (run.status !== 0 || typeof body !== 'string') {
      throw new Error(helperFailure('post-idd-marker (dry run)', run));
    }
    return body;
  };

  if (!args.apply) {
    let pendingRecord: string;
    try {
      pendingRecord = renderMarker(intentArgs('pending', 'none'));
    } catch (error) {
      return refuse((error as Error).message, base);
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
      { step: 'owner-marker', status: 'planned' },
      { step: 'provenance', status: 'planned' },
      { step: 'member', status: 'planned' },
    );
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', outcome: 'planned', ...base, labels, steps }, null, 2)}\n`,
    );
    return 0;
  }

  for (const name of missing) {
    try {
      ghText(['label', 'create', name, '--repo', repoRef]);
    } catch (error) {
      return refuse(
        `cannot create the label ${name}, so the create could not apply it: ${(error as Error).message}`,
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
  const postVerified = (
    markerArgs: string[],
    where: { owner: string; repo: string; number: number },
  ): number => {
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
    const landed = (message: string): Error =>
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
      let found: boolean | null;
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
    let stored: { body?: unknown; user?: { login?: unknown } } | null;
    try {
      stored = ghApiJson(
        `repos/${where.owner}/${where.repo}/issues/comments/${commentId}`,
      ) as { body?: unknown; user?: { login?: unknown } } | null;
    } catch (error) {
      throw landed(
        `comment ${commentId} could not be read back: ${(error as Error).message}`,
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
      `the pending publication-intent record could not be verified, so nothing was created: ${(error as Error).message}`,
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
  let number: number;
  let url: string;
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
      reason: `${(error as Error).message}; check the repository for an issue carrying token ${ids.token} before retrying`,
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
  let created: IssueSnapshot;
  try {
    created = readIssue(owner, repo, number);
  } catch (error) {
    return recoveryHold({
      ...held,
      failedStep: 'create-verify',
      reason: (error as Error).message,
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
      reason += `; the safe-hold recovery failed: ${(error as Error).message}`;
    }
    return recoveryHold({ ...held, failedStep: 'create-verify', reason });
  }

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
      issueRef,
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
      failedStep: attached ? 'owner-marker' : 'identity-attach',
      reason: (error as Error).message,
      ...(attached
        ? // The owner marker is on the issue, not in the journal, so the
          // journal stays at the attached pending record and the marker's
          // own state is reported instead.
          {
            nothingSent: outcome.nothingSent,
            ...(isPosted(error) ? { ownerMarker: 'uncertain' } : {}),
          }
        : outcome),
    });
  }

  sleepMs(input.settleMs);
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
  const marker = verdict?.marker as
    | {
        owner?: unknown;
        set?: unknown;
        session?: unknown;
        bodySha256?: unknown;
      }
    | null
    | undefined;
  if (
    verdict?.verdict !== 'pass' ||
    marker?.owner !== ids.owner ||
    marker?.set !== ids.set ||
    marker?.session !== ids.session
  ) {
    return recoveryHold({
      ...held,
      failedStep: 'provenance',
      reason:
        verdict?.verdict === 'pass'
          ? 'the winning acquire marker is not the one this run posted'
          : helperFailure('authoring-owner-provenance', provenance),
      provenance: verdict ?? provenance.stdout,
    });
  }
  steps.push({
    step: 'provenance',
    status: 'done',
    detail: { verdict: 'pass' },
  });

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
    });
    if (ownerLog !== null) {
      throw new Error(`the owner-marker replay failed: ${ownerLog}`);
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
      failedStep: 'member',
      reason: (error as Error).message,
      ...postOutcome(error),
    });
  }

  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', outcome: 'published', ...held, journalState: 'member' }, null, 2)}\n`,
  );
  return 0;
}

function isPosted(error: unknown): boolean {
  return (error as { posted?: unknown } | null)?.posted === true;
}

/**
 * The report fields of a failed step: `nothingSent: true` when the envelope
 * proves the post unsent, or `nothingSent: false` with the uncertain journal
 * state when it may have landed. A failure that made no post at all (a check
 * before it) reports neither.
 */
function postOutcome(error: unknown): {
  nothingSent?: boolean;
  journalState?: string;
} {
  if ((error as { nothingSent?: unknown } | null)?.nothingSent === true) {
    return { nothingSent: true };
  }
  if (isPosted(error)) {
    return { nothingSent: false, journalState: JOURNAL_STATE_UNCERTAIN };
  }
  return {};
}

function recoveryHold(report: Record<string, unknown>): HelperCliResult {
  const message = `recovery hold at step ${String(report.failedStep)}: ${String(report.reason)}`;
  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', outcome: 'recovery-hold', journalState: 'pending', ...report }, null, 2)}\n`,
  );
  process.stderr.write(
    `publish-authoring-hold: ${message}${report.issue ? ` (issue ${String(report.issue)} stays held)` : ''}\n`,
  );
  return { exitCode: 1, kind: 'gate', message };
}
