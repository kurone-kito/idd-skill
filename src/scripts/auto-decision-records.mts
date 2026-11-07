// idd-generated-from: src/scripts/auto-decision-records.mts
//
// The scripts/auto-decision-records.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

/**
 * Trusted reader of auto-decide confirmation records
 * (kurone-kito/idd-skill#4962, roadmap #4955).
 *
 * #4961 pins the grammar of the record, link, void, and note markers and of
 * the `Subject:` line, and exports a line parser for each; this module reuses
 * those parsers and applies the trust rule of contract.md ("Auto-decide
 * confirmation issue", "Trust") to live GitHub data:
 *
 * - trust comes only from `trustedMarkerActors` in the repository policy
 *   file, read the way `publish-authoring-hold` reads it
 *   (`readRepositoryPolicyFile` and `resolveTrustedMarkerActors({ config })`,
 *   with no flag or environment override). An empty or missing list counts
 *   nothing;
 * - a comment, and the issue body, counts only while GraphQL `lastEditedAt`
 *   is null (the edit-state check of the draft carrier release);
 * - the body counts only while its current sha256 equals the `body-sha256`
 *   of the issue's first trusted `mode=acquire` owner marker, found by
 *   `findStageOneAcquire`;
 * - a marker counts only at its pinned position: the first non-blank line
 *   after the publication line of the body, or the first line of a comment;
 * - a record comment counts only on an issue whose body record counts, with
 *   the same class and source;
 * - two counting entries with one `decision` ID and different fields both
 *   stop counting, while identical entries (a retried append) count once.
 *
 * Every read goes through an injectable provider. Any failed read, missing or
 * malformed page, or a policy file that is present but unreadable makes the
 * whole result `unreadable`, never an empty list.
 *
 * The label names are caller inputs. A caller passes the confirmation label
 * name from the trusted read of #4958 (`readTrustedAutoDecide` in
 * idd-config.mts, its `confirmationLabelName`) and the authoring label name
 * resolved as `publish-authoring-hold` resolves it; this module never reads
 * either from the local checkout, so a worktree whose configuration names
 * another label cannot change the result.
 *
 * Read-only: it never posts, labels, or edits anything.
 */

import { createHash } from 'node:crypto';
import {
  AUTO_DECIDE_CONFIRMATION_CLASSES,
  type AutoDecideConfirmationClass,
  type ConfirmationMarkerFields,
  parseAutoDecisionLinkMarker,
  parseAutoDecisionNoteMarker,
  parseAutoDecisionRecordMarker,
  parseAutoDecisionVoidMarker,
  parseConfirmationSubjectLine,
} from './audit-authored-issue.mts';
import {
  type AuthoringOwnerProvenanceComment,
  findStageOneAcquire,
  inspectGraphqlCommentsPage,
  mapGraphqlIssueCommentNode,
} from './authoring-owner-provenance.mts';
import { ghTextUnbounded } from './gh-exec.mts';
import { readRepositoryPolicyFile } from './idd-config.mts';
import { maskMarkdownForScan } from './markdown-code.mts';
import { normalizeMarkerPrefix } from './marker-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';

/** The repository whose issues are read. */
export interface AutoDecisionRepository {
  owner: string;
  repo: string;
}

/** One page of the GraphQL issue read: the issue and a page of comments. */
export interface AutoDecisionIssuePageRequest {
  owner: string;
  repo: string;
  number: number;
  /** The comments cursor, or null for the first page. */
  cursor: string | null;
}

/** One page of the REST issue list, filtered by one label. */
export interface AutoDecisionIssueListRequest {
  owner: string;
  repo: string;
  label: string;
  state: 'open' | 'all';
  /** 1-based page number. */
  page: number;
  perPage: number;
}

/**
 * The GitHub reads, injectable for tests. Each method returns the parsed JSON
 * of one response and throws when the read fails. This module checks every
 * shape itself, so a provider only transports.
 */
export interface AutoDecisionRecordsProvider {
  /** The GraphQL payload of {@link ISSUE_PAGE_QUERY} for one page. */
  readIssuePage(request: AutoDecisionIssuePageRequest): unknown;
  /** The REST payload of `GET /repos/{owner}/{repo}/issues` for one page. */
  listIssuesPage(request: AutoDecisionIssueListRequest): unknown;
}

/** Options every reader takes. */
export interface AutoDecisionReadOptions {
  /** The repository policy file; the default path when omitted. */
  policyPath?: string;
  /** Overrides the policy file's `markerPrefix`. */
  markerPrefix?: string;
}

/** One record that counts. */
export interface AutoDecisionRecord {
  /** The confirmation issue that holds the record. */
  issue: number;
  /** `body` for the body record, or the record comment's database ID. */
  from: 'body' | number;
  class: AutoDecideConfirmationClass;
  source: string;
  claim: string;
  set: string;
  decision: string;
  /** The `Subject:` value of a `worktreeRemnant` or `b1Leftover` record;
   * null for the other classes and for a missing or malformed line. */
  subject: string | null;
  /** A counting `location` note exists for this decision. */
  locationNote: boolean;
  /** A counting `failure` note exists for this decision. */
  failureNote: boolean;
}

/** One note marker that counts. */
export interface AutoDecisionNote {
  decision: string;
  kind: 'location' | 'failure';
  commentId: number;
}

/** What the confirmation issue reader reports for one readable issue. */
export interface ConfirmationIssueReport {
  number: number;
  /** Lowercase, as the REST issue list reports it. */
  state: 'open' | 'closed';
  /** The caller's confirmation label is present (trimmed, case-insensitive). */
  confirmationLabel: boolean;
  /** The caller's authoring label is still present (trimmed, case-insensitive). */
  authoringLabel: boolean;
  bodyRecordCounts: boolean;
  /** Why the body record does not count; null when it counts. */
  bodyRecordReason: string | null;
  /** Counting records, body first, then comments in comment order. */
  records: AutoDecisionRecord[];
  /** Decision IDs a counting void marker removed, sorted. */
  voidedDecisions: string[];
  /** Decision IDs dropped because two counting records disagree, sorted. */
  conflictingDecisions: string[];
  /** Counting note markers, in comment order. */
  notes: AutoDecisionNote[];
}

/** An `unreadable` verdict: a read failed or a page is missing. */
export interface AutoDecisionUnreadable {
  status: 'unreadable';
  error: string;
}

export type ConfirmationIssueRead =
  | ({ status: 'readable' } & ConfirmationIssueReport)
  | AutoDecisionUnreadable;

/** One link marker that counts. */
export interface AutoDecisionLink {
  class: AutoDecideConfirmationClass;
  claim: string;
  set: string;
  decision: string;
  confirmation: string;
  commentId: number;
}

export type DecisionLinksRead =
  | {
      status: 'readable';
      /** The source issue whose comments were read. */
      number: number;
      /** Counting links, in comment order. */
      links: AutoDecisionLink[];
      /** Decision IDs dropped because two counting links disagree, sorted. */
      conflictingDecisions: string[];
      /** Decision IDs removed from links by trusted void markers, sorted. */
      voidedDecisions: string[];
    }
  | AutoDecisionUnreadable;

/** One confirmation issue the finder returns. */
export interface ConfirmationFinderIssue {
  number: number;
  state: 'open' | 'closed';
  confirmationLabel: boolean;
  authoringLabel: boolean;
  /** Only the counting records that match every filter. */
  records: AutoDecisionRecord[];
}

export type ConfirmationFinderRead =
  | { status: 'readable'; issues: ConfirmationFinderIssue[] }
  | AutoDecisionUnreadable;

/** What a matcher call expects. Name a claim, a set, or both. */
export interface DecisionMatchExpectation {
  class: AutoDecideConfirmationClass;
  source: string;
  claim?: string;
  set?: string;
  /** Required for `worktreeRemnant` and `b1Leftover`. */
  subject?: string;
  /** When given, the matching record must carry this decision ID. */
  decision?: string;
}

export interface DecisionMatch {
  verdict: 'match' | 'no-match' | 'unreadable';
  /** The counting records that match. */
  records: AutoDecisionRecord[];
  reason: string;
}

const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** The publication line the record marker follows (the #4961 linter's own
 * position rule in `auditConfirmationShape`). */
const PUBLICATION_LINE_PATTERN = /^<!--\s+\S+-authoring-publication:/;
const ISSUE_REFERENCE_PATTERN =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
/** The classes whose stop names one subject on a `Subject:` line. */
const SUBJECT_CLASSES: ReadonlySet<string> = new Set([
  'worktreeRemnant',
  'b1Leftover',
]);
const LIST_PAGE_SIZE = 100;
/** A runaway guard for the REST list: 10,000 labelled issues. */
const MAX_LIST_PAGES = 100;
/** Full list scans before a list that keeps changing is unreadable. */
const MAX_LIST_SCANS = 3;

/** The GraphQL read of one issue page. `lastEditedAt` and `isMinimized`
 * exist only on the GraphQL shape, so neither read uses REST comments. */
const ISSUE_PAGE_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      number state body lastEditedAt author { login }
      labels(first:100){ nodes { name } pageInfo { hasNextPage } }
      comments(first:100,after:$cursor){
        nodes { databaseId lastEditedAt createdAt updatedAt body author { login } isMinimized minimizedReason }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** The provider that reads live GitHub data through the `gh` wrappers. Page
 * bodies can exceed a bounded buffer, so both reads use `ghTextUnbounded`, as
 * `fetchProvenanceCommentsGraphql` does. */
function createGithubProvider(): AutoDecisionRecordsProvider {
  return {
    readIssuePage({ owner, repo, number, cursor }) {
      const raw = ghTextUnbounded([
        'api',
        'graphql',
        '-f',
        `query=${ISSUE_PAGE_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${number}`,
        ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
      ]);
      return JSON.parse(raw || 'null') as unknown;
    },
    listIssuesPage({ owner, repo, label, state, page, perPage }) {
      const raw = ghTextUnbounded([
        'api',
        `repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc&per_page=${perPage}&page=${page}`,
      ]);
      return JSON.parse(raw || 'null') as unknown;
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(error: unknown): AutoDecisionUnreadable {
  return { status: 'unreadable', error: messageOf(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParseableTimestamp(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function assertRepository(repository: AutoDecisionRepository): void {
  if (
    !REPO_TOKEN_PATTERN.test(String(repository?.owner ?? '')) ||
    !REPO_TOKEN_PATTERN.test(String(repository?.repo ?? ''))
  ) {
    throw new Error('the repository owner and name must be plain tokens');
  }
}

function assertIssueNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `the issue number must be a positive integer (got ${number})`,
    );
  }
}

function assertLabel(name: string, setting: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`the ${setting} must be a non-empty name`);
  }
}

function assertListableConfirmationLabel(name: string): void {
  assertLabel(name, 'confirmation label');
  // The REST label filter splits on commas, so such a name cannot be listed exactly.
  if (name.includes(',')) {
    throw new Error('the confirmation label name contains a comma');
  }
}

function isConfirmationClass(
  value: unknown,
): value is AutoDecideConfirmationClass {
  return (AUTO_DECIDE_CONFIRMATION_CLASSES as readonly unknown[]).includes(
    value,
  );
}

/** The trusted logins and the marker prefix, from the repository policy file
 * only. Throws when the file is present but unreadable. */
interface TrustContext {
  trusted: ReadonlySet<string>;
  trustedList: string[];
  markerPrefix: string;
}

function readTrustContext(options: AutoDecisionReadOptions): TrustContext {
  const loaded = readRepositoryPolicyFile(options.policyPath || undefined);
  const config = loaded.config as {
    markerPrefix?: unknown;
    trustedMarkerActors?: unknown;
  } | null;
  // Repository policy only: no flag or environment value may widen the list.
  const { actors } = resolveTrustedMarkerActors({ config });
  return {
    trusted: new Set(actors),
    trustedList: actors,
    markerPrefix: normalizeMarkerPrefix(
      options.markerPrefix ?? config?.markerPrefix,
    ),
  };
}

function isTrusted(login: string, context: TrustContext): boolean {
  return context.trusted.has(login.trim().toLowerCase());
}

// ---------------------------------------------------------------------
// GraphQL issue snapshot
// ---------------------------------------------------------------------

interface IssueSnapshot {
  number: number;
  state: 'open' | 'closed';
  body: string;
  bodyEdited: boolean;
  authorLogin: string;
  labels: string[];
  /** Every comment, in `createdAt` order with ties broken by ID. */
  comments: AuthoringOwnerProvenanceComment[];
}

function graphqlIssue(
  payload: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`the GraphQL read of ${label} is not a JSON object`);
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors
      .map((error) => String((error as { message?: unknown })?.message ?? ''))
      .filter(Boolean)
      .join('; ');
    throw new Error(`the GraphQL read of ${label} failed: ${detail}`);
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const repository = isRecord(data?.repository) ? data.repository : null;
  const issue = repository?.issue;
  if (!isRecord(issue)) {
    throw new Error(`${label} is not an issue or does not exist`);
  }
  return issue;
}

function issueHead(
  issue: Record<string, unknown>,
  number: number,
  label: string,
): Omit<IssueSnapshot, 'comments'> {
  if (issue.number !== number) {
    throw new Error(`the GraphQL read of ${label} returned another issue`);
  }
  const state =
    issue.state === 'OPEN'
      ? 'open'
      : issue.state === 'CLOSED'
        ? 'closed'
        : null;
  if (state === null) {
    throw new Error(`${label} has an unreadable state`);
  }
  if (typeof issue.body !== 'string') {
    throw new Error(`${label} has a missing or non-string body`);
  }
  // Explicit JSON null means never edited. Anything other than a parseable
  // timestamp is incomplete evidence, as for a comment.
  const lastEditedAt = issue.lastEditedAt;
  let bodyEdited: boolean;
  if (lastEditedAt === null) {
    bodyEdited = false;
  } else if (
    typeof lastEditedAt === 'string' &&
    isParseableTimestamp(lastEditedAt)
  ) {
    bodyEdited = true;
  } else {
    throw new Error(
      `${label} has a missing, empty, or unparseable lastEditedAt -- body-edit evidence is incomplete`,
    );
  }
  const author = isRecord(issue.author) ? issue.author : null;
  const labelsConnection = isRecord(issue.labels) ? issue.labels : null;
  const labelNodes = labelsConnection?.nodes;
  const labelPageInfo = isRecord(labelsConnection?.pageInfo)
    ? labelsConnection.pageInfo
    : null;
  if (
    !Array.isArray(labelNodes) ||
    typeof labelPageInfo?.hasNextPage !== 'boolean'
  ) {
    throw new Error(`${label} has an unreadable labels page`);
  }
  if (labelPageInfo.hasNextPage) {
    throw new Error(`${label} has more labels than one page holds`);
  }
  const labels = labelNodes.map((node) => {
    const name = isRecord(node) ? node.name : undefined;
    if (typeof name !== 'string') {
      throw new Error(`${label} has a label with no name`);
    }
    return name;
  });
  return {
    number,
    state,
    body: issue.body,
    bodyEdited,
    authorLogin: typeof author?.login === 'string' ? author.login : '',
    labels,
  };
}

function sameIssueHead(
  a: Omit<IssueSnapshot, 'comments'>,
  b: Omit<IssueSnapshot, 'comments'>,
): boolean {
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.body === b.body &&
    a.bodyEdited === b.bodyEdited &&
    a.authorLogin === b.authorLogin &&
    a.labels.length === b.labels.length &&
    a.labels.every((label, index) => label === b.labels[index])
  );
}

function compareComments(
  a: AuthoringOwnerProvenanceComment,
  b: AuthoringOwnerProvenanceComment,
): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id - b.id;
}

/**
 * Read one issue and every comment page. Throws on a failed read, on a page
 * whose shape is incomplete, and on a repeated cursor, so a missing page
 * never reads as the last one.
 */
function readIssueSnapshot(
  provider: AutoDecisionRecordsProvider,
  owner: string,
  repo: string,
  number: number,
): IssueSnapshot {
  const label = `${owner}/${repo}#${number}`;
  let head: Omit<IssueSnapshot, 'comments'> | null = null;
  const comments: AuthoringOwnerProvenanceComment[] = [];
  const requested = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const key = cursor ?? '';
    if (requested.has(key)) {
      throw new Error(`repeated comments cursor for ${label}`);
    }
    requested.add(key);
    const issue = graphqlIssue(
      provider.readIssuePage({ owner, repo, number, cursor }),
      label,
    );
    const currentHead = issueHead(issue, number, label);
    if (head === null) {
      head = currentHead;
    } else if (!sameIssueHead(head, currentHead)) {
      throw new Error(`${label} changed while reading comment pages`);
    }
    const connection = issue.comments;
    if (!isRecord(connection)) {
      throw new Error(`${label} returned no comments connection`);
    }
    const page = inspectGraphqlCommentsPage(connection, label);
    if (!page.ok) {
      throw new Error(page.reason);
    }
    for (const node of page.connection.nodes) {
      const mapped = mapGraphqlIssueCommentNode(node);
      if (!mapped.ok) {
        throw new Error(mapped.reason);
      }
      comments.push(mapped.comment);
    }
    if (!page.connection.pageInfo.hasNextPage) {
      break;
    }
    cursor = page.connection.pageInfo.endCursor;
  }
  comments.sort(compareComments);
  return { ...head, comments };
}

// ---------------------------------------------------------------------
// Marker positions
// ---------------------------------------------------------------------

/** The record marker at the body's pinned position: the first non-blank line
 * after the publication line. */
function bodyRecordFields(
  body: string,
  markerPrefix: string,
): ConfirmationMarkerFields | null {
  const lines = body.split('\n');
  const publication = lines.findIndex((line) =>
    PUBLICATION_LINE_PATTERN.test(line),
  );
  if (publication < 0) {
    return null;
  }
  const next = lines.slice(publication + 1).find((line) => line.trim() !== '');
  return next === undefined
    ? null
    : parseAutoDecisionRecordMarker(next, markerPrefix);
}

/**
 * The `Subject:` value of a record, located as the #4961 linter locates it:
 * the `## Stop` section is found on masked text, so fenced headings and HTML
 * comments do not count. The visible section holds exactly one `Subject:`
 * line, and it is the first non-blank one.
 */
function recordSubject(text: string, cls: string): string | null {
  if (!SUBJECT_CLASSES.has(cls)) {
    return null;
  }
  const raw = text.split('\n');
  const masked = maskMarkdownForScan(text, {
    inlineCode: 'mask',
    htmlComments: 'mask',
  }).split('\n');
  const start = masked.findIndex((line) => line.trim() === '## Stop');
  if (start < 0) {
    return null;
  }
  let end = masked.length;
  for (let index = start + 1; index < masked.length; index += 1) {
    if (masked[index]?.startsWith('## ') === true) {
      end = index;
      break;
    }
  }
  const rawSection = raw.slice(start + 1, end);
  const visibleSection = masked.slice(start + 1, end);
  const firstVisibleLine = visibleSection.findIndex(
    (line) => line.trim() !== '',
  );
  if (
    firstVisibleLine < 0 ||
    visibleSection.filter((line) => line.startsWith('Subject:')).length !== 1
  ) {
    return null;
  }
  return parseConfirmationSubjectLine(rawSection[firstVisibleLine] ?? '');
}

// ---------------------------------------------------------------------
// Decision grouping
// ---------------------------------------------------------------------

/**
 * Group entries by decision ID. Identical entries (a retried append) keep the
 * first; entries that disagree on any compared field are all dropped.
 */
function resolveDecisions<T extends { decision: string }>(
  entries: readonly T[],
  same: (a: T, b: T) => boolean,
): { kept: T[]; conflicting: string[] } {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const group = groups.get(entry.decision);
    if (group === undefined) {
      groups.set(entry.decision, [entry]);
    } else {
      group.push(entry);
    }
  }
  const kept: T[] = [];
  const conflicting: string[] = [];
  for (const [decision, group] of groups) {
    const first = group[0] as T;
    if (group.every((entry) => same(first, entry))) {
      kept.push(first);
    } else {
      conflicting.push(decision);
    }
  }
  return { kept, conflicting: sortedUnique(conflicting) };
}

function sameRecord(a: AutoDecisionRecord, b: AutoDecisionRecord): boolean {
  return (
    a.class === b.class &&
    sameText(a.source, b.source) &&
    a.claim === b.claim &&
    a.set === b.set &&
    a.subject === b.subject
  );
}

interface FinderRecordEntry {
  issue: Omit<ConfirmationFinderIssue, 'records'>;
  record: AutoDecisionRecord;
}

/** Resolve decision IDs across the finder result before applying its filters. */
function resolveFinderRecords(
  entries: readonly FinderRecordEntry[],
  removedDecisions: ReadonlySet<string>,
  countingNotes: {
    location: ReadonlySet<string>;
    failure: ReadonlySet<string>;
  },
): FinderRecordEntry[] {
  const groups = new Map<string, FinderRecordEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.record.decision);
    if (group === undefined) {
      groups.set(entry.record.decision, [entry]);
    } else {
      group.push(entry);
    }
  }

  const kept: FinderRecordEntry[] = [];
  for (const [decision, group] of groups) {
    if (removedDecisions.has(decision)) {
      continue;
    }
    const first = group[0];
    if (
      first === undefined ||
      !group.every((entry) => sameRecord(first.record, entry.record))
    ) {
      continue;
    }
    kept.push({
      ...first,
      record: {
        ...first.record,
        locationNote:
          countingNotes.location.has(decision) ||
          group.some((entry) => entry.record.locationNote),
        failureNote:
          countingNotes.failure.has(decision) ||
          group.some((entry) => entry.record.failureNote),
      },
    });
  }
  return kept;
}

function sameLink(a: AutoDecisionLink, b: AutoDecisionLink): boolean {
  return (
    a.class === b.class &&
    a.claim === b.claim &&
    a.set === b.set &&
    sameText(a.confirmation, b.confirmation)
  );
}

// ---------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------

function recordFrom(
  fields: ConfirmationMarkerFields,
  issue: number,
  from: 'body' | number,
  text: string,
): AutoDecisionRecord {
  const cls = fields.class as AutoDecideConfirmationClass;
  return {
    issue,
    from,
    class: cls,
    source: fields.source ?? '',
    claim: fields.claim ?? '',
    set: fields.set ?? '',
    decision: fields.decision ?? '',
    subject: recordSubject(text, cls),
    locationNote: false,
    failureNote: false,
  };
}

/** The body record when it counts, or the reason it does not. */
function evaluateBodyRecord(
  snapshot: IssueSnapshot,
  repository: AutoDecisionRepository,
  context: TrustContext,
): { record: AutoDecisionRecord | null; reason: string | null } {
  if (!isTrusted(snapshot.authorLogin, context)) {
    return {
      record: null,
      reason: `the issue author ${JSON.stringify(snapshot.authorLogin)} is not in trustedMarkerActors`,
    };
  }
  if (snapshot.bodyEdited) {
    return { record: null, reason: 'the issue body was edited' };
  }
  const fields = bodyRecordFields(snapshot.body, context.markerPrefix);
  if (fields === null) {
    return {
      record: null,
      reason:
        'the first non-blank line after the publication line is not a record marker',
    };
  }
  const sourceReference = ISSUE_REFERENCE_PATTERN.exec(fields.source ?? '');
  if (
    sourceReference === null ||
    !sameText(sourceReference[1] ?? '', repository.owner) ||
    !sameText(sourceReference[2] ?? '', repository.repo)
  ) {
    return {
      record: null,
      reason:
        'the record source is not an issue in the confirmation repository',
    };
  }
  const target = `${repository.owner}/${repository.repo}#${snapshot.number}`;
  const { event, rejectReason } = findStageOneAcquire(
    snapshot.comments,
    target,
    context.markerPrefix,
    context.trustedList,
  );
  if (event === null) {
    return {
      record: null,
      reason:
        rejectReason === null
          ? 'the issue has no trusted mode=acquire owner marker'
          : `the first trusted owner marker is not a valid acquire: ${rejectReason}`,
    };
  }
  if (sha256Hex(snapshot.body) !== event.parsed.bodySha256) {
    return {
      record: null,
      reason:
        "the body digest differs from the first trusted acquire marker's body-sha256",
    };
  }
  return {
    record: recordFrom(fields, snapshot.number, 'body', snapshot.body),
    reason: null,
  };
}

/** A comment whose author is trusted and whose body was never edited. */
function countingComments(
  snapshot: IssueSnapshot,
  context: TrustContext,
): AuthoringOwnerProvenanceComment[] {
  return snapshot.comments.filter(
    (comment) =>
      isTrusted(comment.authorLogin, context) && comment.lastEditedAt === null,
  );
}

/** Counting void markers on an issue: the decision IDs they void. */
function countingVoids(
  snapshot: IssueSnapshot,
  context: TrustContext,
): Set<string> {
  const voids = new Set<string>();
  for (const comment of countingComments(snapshot, context)) {
    const decision = parseAutoDecisionVoidMarker(
      firstLine(comment.body),
      context.markerPrefix,
    );
    if (decision !== null) {
      voids.add(decision);
    }
  }
  return voids;
}

function evaluateConfirmationIssue(
  snapshot: IssueSnapshot,
  repository: AutoDecisionRepository,
  context: TrustContext,
  labels: { confirmationLabel: string; authoringLabel: string },
): ConfirmationIssueReport {
  const body = evaluateBodyRecord(snapshot, repository, context);
  const entries: AutoDecisionRecord[] =
    body.record === null ? [] : [body.record];
  const notes: AutoDecisionNote[] = [];
  for (const comment of countingComments(snapshot, context)) {
    const line = firstLine(comment.body);
    const fields = parseAutoDecisionRecordMarker(line, context.markerPrefix);
    if (fields !== null) {
      const head = body.record;
      if (
        head !== null &&
        fields.class === head.class &&
        sameText(fields.source ?? '', head.source)
      ) {
        entries.push(
          recordFrom(fields, snapshot.number, comment.id, comment.body),
        );
      }
      continue;
    }
    const note = parseAutoDecisionNoteMarker(line, context.markerPrefix);
    if (note !== null) {
      notes.push({ ...note, commentId: comment.id });
    }
  }
  const voids = countingVoids(snapshot, context);
  const { kept, conflicting } = resolveDecisions(entries, sameRecord);
  const records = kept
    .filter((record) => !voids.has(record.decision))
    .map((record) => ({
      ...record,
      locationNote: notes.some(
        (note) => note.decision === record.decision && note.kind === 'location',
      ),
      failureNote: notes.some(
        (note) => note.decision === record.decision && note.kind === 'failure',
      ),
    }));
  return {
    number: snapshot.number,
    state: snapshot.state,
    confirmationLabel: snapshot.labels.some((name) =>
      sameText(name, labels.confirmationLabel),
    ),
    authoringLabel: snapshot.labels.some((name) =>
      sameText(name, labels.authoringLabel),
    ),
    bodyRecordCounts: body.record !== null,
    bodyRecordReason: body.reason,
    records,
    voidedDecisions: sortedUnique(voids),
    conflictingDecisions: conflicting,
    notes,
  };
}

// ---------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------

export interface ConfirmationIssueInput extends AutoDecisionReadOptions {
  repository: AutoDecisionRepository;
  number: number;
  /** From the trusted read of #4958, never from the local checkout. */
  confirmationLabel: string;
  /** Resolved as `publish-authoring-hold` resolves it. */
  authoringLabel: string;
}

/**
 * Read one confirmation issue: its state, both label flags, the records that
 * count, the voided decision IDs, and the counting notes.
 */
// audit:ignore-dead-export: the worktree-remnant and B1-leftover modes (#4955) consume this reader; until they land, only the focused tests call it
export function readConfirmationIssue(
  input: ConfirmationIssueInput,
  provider: AutoDecisionRecordsProvider = createGithubProvider(),
): ConfirmationIssueRead {
  try {
    assertRepository(input.repository);
    assertIssueNumber(input.number);
    assertLabel(input.confirmationLabel, 'confirmation label');
    assertLabel(input.authoringLabel, 'authoring label');
    const context = readTrustContext(input);
    const snapshot = readIssueSnapshot(
      provider,
      input.repository.owner,
      input.repository.repo,
      input.number,
    );
    return {
      status: 'readable',
      ...evaluateConfirmationIssue(snapshot, input.repository, context, input),
    };
  } catch (error) {
    return unreadable(error);
  }
}

export interface DecisionLinksInput extends AutoDecisionReadOptions {
  repository: AutoDecisionRepository;
  /** The source issue whose comments hold the link markers. */
  number: number;
  /** From the trusted read of #4958, never from the local checkout. */
  confirmationLabel: string;
}

/**
 * Read the link markers that count on one source issue. A link counts when a
 * trusted login posted it as the first line of a comment that was never
 * edited, and it names a confirmation issue in the same repository (the
 * contract keeps a record's source in its confirmation issue's repository).
 * A trusted void marker on any currently labelled confirmation issue removes
 * that decision from the result.
 */
// audit:ignore-dead-export: the auto-decide caps and crash recovery (#4955) consume this reader; until they land, only the focused tests call it
export function readDecisionLinks(
  input: DecisionLinksInput,
  provider: AutoDecisionRecordsProvider = createGithubProvider(),
): DecisionLinksRead {
  try {
    assertRepository(input.repository);
    assertIssueNumber(input.number);
    assertListableConfirmationLabel(input.confirmationLabel);
    const context = readTrustContext(input);
    const { owner, repo } = input.repository;
    const snapshot = readIssueSnapshot(provider, owner, repo, input.number);
    const entries: AutoDecisionLink[] = [];
    for (const comment of countingComments(snapshot, context)) {
      const fields = parseAutoDecisionLinkMarker(
        firstLine(comment.body),
        context.markerPrefix,
      );
      const reference = ISSUE_REFERENCE_PATTERN.exec(
        fields?.confirmation ?? '',
      );
      if (
        fields === null ||
        reference === null ||
        !sameText(reference[1] ?? '', owner) ||
        !sameText(reference[2] ?? '', repo)
      ) {
        continue;
      }
      entries.push({
        class: fields.class as AutoDecideConfirmationClass,
        claim: fields.claim ?? '',
        set: fields.set ?? '',
        decision: fields.decision ?? '',
        confirmation: fields.confirmation ?? '',
        commentId: comment.id,
      });
    }
    const { kept, conflicting } = resolveDecisions(entries, sameLink);
    const listed = listLabelledIssues(
      provider,
      owner,
      repo,
      input.confirmationLabel,
      'all',
    );
    const voids = new Set<string>();
    for (const issue of listed) {
      const confirmation = readIssueSnapshot(
        provider,
        owner,
        repo,
        issue.number,
      );
      if (
        !confirmation.labels.some((name) =>
          sameText(name, input.confirmationLabel),
        )
      ) {
        continue;
      }
      for (const decision of countingVoids(confirmation, context)) {
        voids.add(decision);
      }
    }
    const voided: string[] = [];
    const links = kept.filter((link) => {
      if (voids.has(link.decision)) {
        voided.push(link.decision);
        return false;
      }
      return true;
    });
    return {
      status: 'readable',
      number: input.number,
      links,
      conflictingDecisions: conflicting,
      voidedDecisions: sortedUnique(voided),
    };
  } catch (error) {
    return unreadable(error);
  }
}

export interface ConfirmationFinderInput extends AutoDecisionReadOptions {
  repository: AutoDecisionRepository;
  class: AutoDecideConfirmationClass;
  /** From the trusted read of #4958, never from the local checkout. */
  confirmationLabel: string;
  /** Resolved as `publish-authoring-hold` resolves it. */
  authoringLabel: string;
  /** `open` (the default) or `all` (open and closed). */
  state?: 'open' | 'all';
  /** Each filter applies to each counting record, body and comments alike. */
  source?: string;
  claim?: string;
  set?: string;
  subject?: string;
}

interface ListedIssue {
  number: number;
  body: string;
}

/**
 * One pass over the REST list for one label, pull requests skipped. The REST
 * list, not search, so the result has no index lag. A page that is not an
 * array, or an entry with no issue number, is unreadable.
 */
function scanLabelledIssues(
  provider: AutoDecisionRecordsProvider,
  owner: string,
  repo: string,
  label: string,
  state: 'open' | 'all',
): ListedIssue[] {
  const listed = new Map<number, ListedIssue>();
  for (let page = 1; ; page += 1) {
    if (page > MAX_LIST_PAGES) {
      throw new Error(
        `the issue list for ${JSON.stringify(label)} has more than ${MAX_LIST_PAGES} pages`,
      );
    }
    const payload = provider.listIssuesPage({
      owner,
      repo,
      label,
      state,
      page,
      perPage: LIST_PAGE_SIZE,
    });
    if (!Array.isArray(payload)) {
      throw new Error(
        `page ${page} of the issue list for ${JSON.stringify(label)} is not a readable page`,
      );
    }
    for (const item of payload) {
      const number = isRecord(item) ? item.number : undefined;
      if (
        typeof number !== 'number' ||
        !Number.isInteger(number) ||
        number <= 0
      ) {
        throw new Error(
          `page ${page} of the issue list for ${JSON.stringify(label)} has an entry with no issue number`,
        );
      }
      // The REST issues endpoint returns pull requests too.
      if (isRecord(item) && item.pull_request != null) {
        continue;
      }
      const body = isRecord(item) ? item.body : undefined;
      if (body !== null && typeof body !== 'string') {
        throw new Error(
          `page ${page} of the issue list for ${JSON.stringify(label)} has an entry with an unreadable body`,
        );
      }
      if (!listed.has(number)) {
        listed.set(number, { number, body: body ?? '' });
      }
    }
    if (payload.length < LIST_PAGE_SIZE) {
      break;
    }
  }
  return [...listed.values()].sort((a, b) => a.number - b.number);
}

function sameIssueNumbers(
  a: readonly ListedIssue[],
  b: readonly ListedIssue[],
): boolean {
  return (
    a.length === b.length &&
    a.every((issue, index) => issue.number === b[index]?.number)
  );
}

/**
 * Every issue on the REST list for one label, from a set that two consecutive
 * scans agree on. The list pages by number, so an issue that closes or loses
 * the label during a scan shifts every later entry back by one, and the entry
 * that crosses onto a page already read is silently skipped. For a cap count
 * that undercount is not acceptable, so the list is scanned twice, and once
 * more when the two sets differ. A third scan that still differs from the
 * second is unreadable. The bodies come from the later agreeing scan.
 */
function listLabelledIssues(
  provider: AutoDecisionRecordsProvider,
  owner: string,
  repo: string,
  label: string,
  state: 'open' | 'all',
): ListedIssue[] {
  let previous = scanLabelledIssues(provider, owner, repo, label, state);
  for (let scan = 2; scan <= MAX_LIST_SCANS; scan += 1) {
    const current = scanLabelledIssues(provider, owner, repo, label, state);
    if (sameIssueNumbers(previous, current)) {
      return current;
    }
    previous = current;
  }
  throw new Error(
    `the issue list for ${JSON.stringify(label)} changed between each of ${MAX_LIST_SCANS} consecutive scans`,
  );
}

function recordMatchesFilters(
  record: AutoDecisionRecord,
  filters: Pick<
    ConfirmationFinderInput,
    'source' | 'claim' | 'set' | 'subject'
  >,
): boolean {
  return (
    (filters.source === undefined || sameText(record.source, filters.source)) &&
    (filters.claim === undefined || record.claim === filters.claim) &&
    (filters.set === undefined || record.set === filters.set) &&
    (filters.subject === undefined || record.subject === filters.subject)
  );
}

/**
 * List the confirmation issues that carry the caller's confirmation label and
 * whose body record counts with the given class. An issue is returned when
 * any of its counting records matches every given filter, with only the
 * matching records.
 */
// audit:ignore-dead-export: the auto-decide caps and crash recovery (#4955) consume this finder; until they land, only the focused tests call it
export function findConfirmationIssues(
  input: ConfirmationFinderInput,
  provider: AutoDecisionRecordsProvider = createGithubProvider(),
): ConfirmationFinderRead {
  try {
    assertRepository(input.repository);
    assertListableConfirmationLabel(input.confirmationLabel);
    assertLabel(input.authoringLabel, 'authoring label');
    if (!isConfirmationClass(input.class)) {
      throw new Error(
        `the class must be one of ${AUTO_DECIDE_CONFIRMATION_CLASSES.join(', ')}`,
      );
    }
    const state = input.state ?? 'open';
    if (state !== 'open' && state !== 'all') {
      throw new Error(`the state must be open or all (got ${String(state)})`);
    }
    const context = readTrustContext(input);
    const { owner, repo } = input.repository;
    const listed = listLabelledIssues(
      provider,
      owner,
      repo,
      input.confirmationLabel,
      state,
    );
    const entries: FinderRecordEntry[] = [];
    const voidedDecisions = new Set<string>();
    const locationNotes = new Set<string>();
    const failureNotes = new Set<string>();
    for (const entry of listed) {
      // Read every listed issue before applying the finder's filters: a
      // trusted void marker can remove an ID even after its body record stops
      // counting, and conflicts can span classes, sources, and issues.
      const report = evaluateConfirmationIssue(
        readIssueSnapshot(provider, owner, repo, entry.number),
        input.repository,
        context,
        input,
      );
      if (
        !report.confirmationLabel ||
        (state === 'open' && report.state !== 'open')
      ) {
        continue;
      }
      for (const decision of report.voidedDecisions) {
        voidedDecisions.add(decision);
      }
      for (const decision of report.conflictingDecisions) {
        voidedDecisions.add(decision);
      }
      for (const note of report.notes) {
        (note.kind === 'location' ? locationNotes : failureNotes).add(
          note.decision,
        );
      }
      // A counting body record whose own decision was voided or dropped still
      // lets the issue's record comments count.
      if (!report.bodyRecordCounts) {
        continue;
      }
      const issue = {
        number: report.number,
        state: report.state,
        confirmationLabel: report.confirmationLabel,
        authoringLabel: report.authoringLabel,
      };
      for (const record of report.records) {
        entries.push({ issue, record });
      }
    }
    const resolved = resolveFinderRecords(entries, voidedDecisions, {
      location: locationNotes,
      failure: failureNotes,
    });
    const byIssue = new Map<number, ConfirmationFinderIssue>();
    for (const { issue, record } of resolved) {
      if (
        record.class !== input.class ||
        !recordMatchesFilters(record, input)
      ) {
        continue;
      }
      let result = byIssue.get(issue.number);
      if (result === undefined) {
        result = { ...issue, records: [] };
        byIssue.set(issue.number, result);
      }
      result.records.push(record);
    }
    return {
      status: 'readable',
      issues: [...byIssue.values()].sort((a, b) => a.number - b.number),
    };
  } catch (error) {
    return unreadable(error);
  }
}

/**
 * Report whether a counting record exists for the expected class, source,
 * claim or set, and subject, and, when `expected.decision` is given, whether
 * that record carries that decision ID. Takes the result of
 * {@link readConfirmationIssue} or {@link findConfirmationIssues}; an
 * `unreadable` result stays `unreadable`.
 */
// audit:ignore-dead-export: the worktree-remnant and B1-leftover modes (#4955) consume this matcher; until they land, only the focused tests call it
export function matchDecisionRecord(
  read: ConfirmationIssueRead | ConfirmationFinderRead,
  expected: DecisionMatchExpectation,
): DecisionMatch {
  if (read.status === 'unreadable') {
    return { verdict: 'unreadable', records: [], reason: read.error };
  }
  const noMatch = (reason: string): DecisionMatch => ({
    verdict: 'no-match',
    records: [],
    reason,
  });
  if (!isConfirmationClass(expected.class)) {
    return noMatch('the expected class is not a confirmation class');
  }
  if (expected.claim === undefined && expected.set === undefined) {
    return noMatch('the expectation names neither a claim nor a set');
  }
  if (SUBJECT_CLASSES.has(expected.class) && expected.subject === undefined) {
    return noMatch(`a ${expected.class} expectation must name its subject`);
  }
  const all =
    'issues' in read
      ? read.issues.flatMap((issue) => issue.records)
      : read.records;
  const matching = all.filter(
    (record) =>
      record.class === expected.class &&
      sameText(record.source, expected.source) &&
      recordMatchesFilters(record, {
        claim: expected.claim,
        set: expected.set,
        subject: expected.subject,
      }),
  );
  if (matching.length === 0) {
    return noMatch('no counting record matches the expectation');
  }
  if (expected.decision !== undefined) {
    const withDecision = matching.filter(
      (record) => record.decision === expected.decision,
    );
    if (withDecision.length === 0) {
      return noMatch(
        `the matching record carries another decision ID than ${expected.decision}`,
      );
    }
    return {
      verdict: 'match',
      records: withDecision,
      reason: 'a counting record matches, with the expected decision ID',
    };
  }
  return {
    verdict: 'match',
    records: matching,
    reason: 'a counting record matches',
  };
}
