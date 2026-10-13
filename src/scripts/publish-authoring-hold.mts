#!/usr/bin/env node
// idd-generated-from: src/scripts/publish-authoring-hold.mts
//
// The scripts/publish-authoring-hold.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Read-only planning and validation for the Stage 1 publication of one held
// orphan issue (kurone-kito/idd-skill#4127): review-result check, journal
// check, publication line, lint of the exact body, label lookup, and the
// rendered pending publication-intent record. It spawns the sibling helpers
// (audit-authored-issue, post-idd-marker's dry run) rather than reimplementing
// their checks. It writes nothing: --apply is refused until the publication
// path (journal records, create, owner marker, member) lands as a follow-up.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBundleRoot } from './bundle-root.mts';
import { parseCliArgs } from './cli-args.mts';
import { ghApiJson, resolveViewerLogin } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import { readRepositoryPolicyFile } from './idd-config.mts';
import {
  normalizeMarkerPrefix,
  parseAuthoringPublicationComment,
} from './marker-helpers.mts';
import {
  AUTHORING_JOURNAL_REFERENCE_PATTERN,
  normalizePolicyConfig,
} from './policy-helpers.mts';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mts';

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
  '--marker-prefix': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;

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
  node scripts/publish-authoring-hold.mjs --title <text> --body-file <path> --review-result <path> [--shape orphan] [--bucket ready|needs-decision|blocked-by-human] [--owner <owner> --repo <repo>] [--policy <path>] [--marker-prefix <prefix>]

Plans and validates the Stage 1 publication of one drafted orphan issue
under the issue-authoring hold. It writes nothing: --apply is refused with
exit 2 until the publication path lands as a follow-up of #4127. The
checks follow contract.md's "New-issue ownership" order:

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
     labels.blockedByHumanLabelName, and report which ones are missing;
  6. render the pending publication-intent record through post-idd-marker's
     dry run, and list the remaining publication steps as planned.

Every policy value (the journal, the marker prefix and the label names)
comes from the repository's own policy file (--policy, or
.github/idd/config.json), never from a user-global layer, because each
describes the target repository. The marker prefix comes from that file
only when the issue and the journal are both in this checkout's repository. Otherwise pass
--marker-prefix with the prefix the target repository configures.

The review result file is a JSON object with "completed": true. An
optional "findings" array holds findings-ledger entries, and each needs a
disposition of fixed or rejected. The file is not tied to the body; the
caller keeps it for the reviewed draft.

Exit codes: 0 planned, 1 refused, 2 usage error (including --apply),
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

interface HelperRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSiblingHelper(script: string, args: string[]): HelperRun {
  const root = resolveBundleRoot(import.meta.dirname);
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', script), ...args],
    { encoding: 'utf8', env: process.env, maxBuffer: 16 * 1024 * 1024 },
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

function helperFailure(name: string, run: HelperRun): string {
  const detail = (run.stderr.trim() || run.stdout.trim()).split('\n').pop();
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
  if (args.apply) {
    // The write path (journal records, create, owner marker, member) is not
    // shipped yet; it is tracked as a follow-up of #4127.
    return usage(
      '--apply is not yet supported: this command plans and validates only, and the publication itself is tracked as a follow-up',
    );
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
  // Every policy value this helper reads (journal, marker prefix, label names)
  // describes the target repository, so it comes from the repository's own
  // policy file only, never from a user-global layer (contract.md, "Target
  // marker prefix").
  let journalSetting: unknown;
  let policyError = '';
  let config: { markerPrefix?: unknown } | null = null;
  let policyPath = '';
  try {
    const loaded = readRepositoryPolicyFile(args.policy || undefined);
    policyPath = loaded.path;
    const repositoryPolicy = loaded.config as {
      markerPrefix?: unknown;
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
      config,
      policyPath,
      ids,
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
  config: unknown;
  policyPath: string;
  ids: PublicationIds;
  bodyPath: string;
}): HelperCliResult {
  const { args, bucket, journal, owner, repo, markerPrefix, ids } = input;
  const repoRef = `${owner}/${repo}`;
  const steps: Step[] = [];
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
  const actor = resolveViewerLogin();
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
