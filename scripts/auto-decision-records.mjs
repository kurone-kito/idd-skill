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
  parseAutoDecisionLinkMarker,
  parseAutoDecisionNoteMarker,
  parseAutoDecisionRecordMarker,
  parseAutoDecisionVoidMarker,
  parseConfirmationSubjectLine,
} from './audit-authored-issue.mjs';
import {
  findStageOneAcquire,
  inspectGraphqlCommentsPage,
  mapGraphqlIssueCommentNode,
} from './authoring-owner-provenance.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { ghTextUnbounded } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import {
  deriveRepositoryIdentity,
  loadTrustedIddConfig,
  readRepositoryPolicyFile,
  readTrustedAutoDecide,
} from './idd-config.mjs';
import { maskMarkdownForScan } from './markdown-code.mjs';
import { normalizeMarkerPrefix } from './marker-helpers.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';

// Declared above the entry-point call for the same temporal-dead-zone reason
// documented in idd-critique-delegate.mts.
const AUTO_DECISION_CLI_FLAG_SPEC = {
  '--pending-count': { type: 'boolean' },
  '--records': { type: 'boolean' },
  '--class': { type: 'string' },
  '--source': { type: 'string' },
  '--claim': { type: 'string' },
  '--set': { type: 'string' },
  '--subject': { type: 'string' },
  '--state': { type: 'string' },
  '--confirmation': { type: 'string' },
  '--links': { type: 'boolean' },
  '--issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--base-ref': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** The publication line the record marker follows (the #4961 linter's own
 * position rule in `auditConfirmationShape`). */
const PUBLICATION_LINE_PATTERN = /^<!--\s+\S+-authoring-publication:/;
const ISSUE_REFERENCE_PATTERN =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
/** The classes whose stop names one subject on a `Subject:` line. */
const SUBJECT_CLASSES = new Set(['worktreeRemnant', 'b1Leftover']);
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
function createGithubProvider() {
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
      return JSON.parse(raw || 'null');
    },
    listIssuesPage({ owner, repo, label, state, page, perPage }) {
      const raw = ghTextUnbounded([
        'api',
        `repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc&per_page=${perPage}&page=${page}`,
      ]);
      return JSON.parse(raw || 'null');
    },
  };
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function unreadable(error) {
  return { status: 'unreadable', error: messageOf(error) };
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isParseableTimestamp(value) {
  return value.trim() !== '' && !Number.isNaN(Date.parse(value));
}
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function sameText(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function firstLine(text) {
  return text.split('\n')[0] ?? '';
}
function sortedUnique(values) {
  return [...new Set(values)].sort();
}
function assertRepository(repository) {
  if (
    !REPO_TOKEN_PATTERN.test(String(repository?.owner ?? '')) ||
    !REPO_TOKEN_PATTERN.test(String(repository?.repo ?? ''))
  ) {
    throw new Error('the repository owner and name must be plain tokens');
  }
}
function assertIssueNumber(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `the issue number must be a positive integer (got ${number})`,
    );
  }
}
function issueNumberFromReference(reference) {
  const numberText = ISSUE_REFERENCE_PATTERN.exec(reference)?.[3];
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(
      `the issue reference ${JSON.stringify(reference)} is invalid`,
    );
  }
  return number;
}
function assertLabel(name, setting) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`the ${setting} must be a non-empty name`);
  }
}
function assertListableConfirmationLabel(name) {
  assertLabel(name, 'confirmation label');
  // The REST label filter splits on commas, so such a name cannot be listed exactly.
  if (name.includes(',')) {
    throw new Error('the confirmation label name contains a comma');
  }
}
function isConfirmationClass(value) {
  return AUTO_DECIDE_CONFIRMATION_CLASSES.includes(value);
}
function readTrustContext(options) {
  const loaded = readRepositoryPolicyFile(options.policyPath || undefined);
  const config = loaded.config;
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
function isTrusted(login, context) {
  return context.trusted.has(login.trim().toLowerCase());
}
function graphqlIssue(payload, label) {
  if (!isRecord(payload)) {
    throw new Error(`the GraphQL read of ${label} is not a JSON object`);
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors
      .map((error) => String(error?.message ?? ''))
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
function issueHead(issue, number, label) {
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
  let bodyEdited;
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
function sameIssueHead(a, b) {
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
function compareComments(a, b) {
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
function readIssueSnapshot(provider, owner, repo, number) {
  const label = `${owner}/${repo}#${number}`;
  let head = null;
  const comments = [];
  const requested = new Set();
  let cursor = null;
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
function bodyRecordFields(body, markerPrefix) {
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
function recordSubject(text, cls) {
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
function resolveDecisions(entries, same) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.decision);
    if (group === undefined) {
      groups.set(entry.decision, [entry]);
    } else {
      group.push(entry);
    }
  }
  const kept = [];
  const conflicting = [];
  for (const [decision, group] of groups) {
    const first = group[0];
    if (group.every((entry) => same(first, entry))) {
      kept.push(first);
    } else {
      conflicting.push(decision);
    }
  }
  return { kept, conflicting: sortedUnique(conflicting) };
}
function sameRecord(a, b) {
  return (
    a.class === b.class &&
    sameText(a.source, b.source) &&
    a.claim === b.claim &&
    a.set === b.set &&
    a.subject === b.subject
  );
}
/** Resolve decision IDs across the finder result before applying its filters. */
function resolveFinderRecords(entries, removedDecisions, countingNotes) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.record.decision);
    if (group === undefined) {
      groups.set(entry.record.decision, [entry]);
    } else {
      group.push(entry);
    }
  }
  const kept = [];
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
function sameLink(a, b) {
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
function recordFrom(fields, issue, from, text) {
  const cls = fields.class;
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
function evaluateBodyRecord(snapshot, repository, context) {
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
function countingComments(snapshot, context) {
  return snapshot.comments.filter(
    (comment) =>
      isTrusted(comment.authorLogin, context) && comment.lastEditedAt === null,
  );
}
/** Counting void markers on an issue: the decision IDs they void. */
function countingVoids(snapshot, context) {
  const voids = new Set();
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
function evaluateConfirmationIssue(snapshot, repository, context, labels) {
  const body = evaluateBodyRecord(snapshot, repository, context);
  const entries = body.record === null ? [] : [body.record];
  const notes = [];
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
/**
 * Read one confirmation issue: its state, both label flags, the records that
 * count, the voided decision IDs, and the counting notes.
 */
// audit:ignore-dead-export: the worktree-remnant and B1-leftover modes (#4955) consume this reader; until they land, only the focused tests call it
export function readConfirmationIssue(
  input,
  provider = createGithubProvider(),
) {
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
/**
 * Read the link markers that count on one source issue. A link counts when a
 * trusted login posted it as the first line of a comment that was never
 * edited, and it names a confirmation issue in the same repository (the
 * contract keeps a record's source in its confirmation issue's repository).
 * A trusted void marker on any successfully read confirmation target removes
 * that decision from the result, even when its confirmation label is gone.
 */
// audit:ignore-dead-export: the auto-decide caps and crash recovery (#4955) consume this reader; until they land, only the focused tests call it
export function readDecisionLinks(input, provider = createGithubProvider()) {
  try {
    assertRepository(input.repository);
    assertIssueNumber(input.number);
    assertListableConfirmationLabel(input.confirmationLabel);
    const context = readTrustContext(input);
    const { owner, repo } = input.repository;
    const snapshot = readIssueSnapshot(provider, owner, repo, input.number);
    const entries = [];
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
        class: fields.class,
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
    const voids = new Set();
    const readConfirmationNumbers = new Set();
    for (const issue of listed) {
      const confirmation = readIssueSnapshot(
        provider,
        owner,
        repo,
        issue.number,
      );
      readConfirmationNumbers.add(issue.number);
      for (const decision of countingVoids(confirmation, context)) {
        voids.add(decision);
      }
    }
    for (const link of kept) {
      const number = issueNumberFromReference(link.confirmation);
      if (readConfirmationNumbers.has(number)) {
        continue;
      }
      // A link still names an issue even when it no longer appears in the
      // confirmation-label scan. Read it directly so a missing or failed
      // target cannot turn into a readable empty result.
      const confirmation = readIssueSnapshot(provider, owner, repo, number);
      for (const decision of countingVoids(confirmation, context)) {
        voids.add(decision);
      }
      readConfirmationNumbers.add(number);
    }
    const voided = [];
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
/**
 * One pass over the REST list for one label, pull requests skipped. The REST
 * list, not search, so the result has no index lag. A page that is not an
 * array, or an entry with no issue number, is unreadable.
 */
function scanLabelledIssues(provider, owner, repo, label, state) {
  const listed = new Map();
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
function sameIssueNumbers(a, b) {
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
function listLabelledIssues(provider, owner, repo, label, state) {
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
function recordMatchesFilters(record, filters) {
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
  input,
  provider = createGithubProvider(),
) {
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
    const entries = [];
    const voidedDecisions = new Set();
    const locationNotes = new Set();
    const failureNotes = new Set();
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
      // The REST scan establishes the confirmation-issue scope. Keep voids
      // from that snapshot even if its label or state changed before this read.
      for (const decision of report.voidedDecisions) {
        voidedDecisions.add(decision);
      }
      if (
        !report.confirmationLabel ||
        (state === 'open' && report.state !== 'open')
      ) {
        continue;
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
    const byIssue = new Map();
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
 * Count every open issue carrying the trusted confirmation label. The REST
 * list is scanned until two consecutive all-page snapshots agree, then each
 * listed issue is read again so a closure or label removal during pagination
 * does not inflate the count. A failed list or issue read stays unreadable.
 */
export function countPendingConfirmationIssues(
  input,
  provider = createGithubProvider(),
) {
  try {
    assertRepository(input.repository);
    assertListableConfirmationLabel(input.confirmationLabel);
    const { owner, repo } = input.repository;
    const listed = listLabelledIssues(
      provider,
      owner,
      repo,
      input.confirmationLabel,
      'open',
    );
    let count = 0;
    for (const entry of listed) {
      const snapshot = readIssueSnapshot(provider, owner, repo, entry.number);
      if (
        snapshot.state === 'open' &&
        snapshot.labels.some((name) => sameText(name, input.confirmationLabel))
      ) {
        count += 1;
      }
    }
    return { status: 'readable', count };
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
export function matchDecisionRecord(read, expected) {
  if (read.status === 'unreadable') {
    return { verdict: 'unreadable', records: [], reason: read.error };
  }
  const noMatch = (reason) => ({
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
function parsePositiveIssueNumber(value, flag) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive issue number`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${flag} must be a safe positive issue number`);
  }
  return number;
}
/** Parse and validate arguments before any repository or GitHub reads. */
export function parseAutoDecisionRecordsArgs(argv) {
  const { values, help } = parseCliArgs(argv, AUTO_DECISION_CLI_FLAG_SPEC);
  if (help) return { help: true, mode: null };
  const flag = (name) => values[name] === true;
  const optional = (name) => values[name];
  const modes = [
    flag('pending-count') ? 'pending-count' : null,
    flag('records') ? 'records' : null,
    values.confirmation === undefined ? null : 'confirmation',
    flag('links') ? 'links' : null,
  ];
  const selected = modes.filter((mode) => mode !== null);
  if (selected.length !== 1) {
    throw new Error(
      'give exactly one mode: --pending-count, --records, --confirmation, or --links',
    );
  }
  const mode = selected[0];
  const ownerValue = optional('owner');
  const repoValue = optional('repo');
  const owner = ownerValue?.trim();
  const repo = repoValue?.trim();
  if ((ownerValue === undefined) !== (repoValue === undefined)) {
    throw new Error('--owner and --repo must be given together');
  }
  if (ownerValue !== undefined && (owner === '' || repo === '')) {
    throw new Error('--owner and --repo must be non-empty');
  }
  const baseRefValue = optional('base-ref');
  const baseRef = baseRefValue?.trim();
  if (baseRefValue !== undefined && baseRef === '') {
    throw new Error('--base-ref must be non-empty when given');
  }
  const modeFlags = {
    'pending-count': ['pending-count'],
    records: ['records', 'class', 'source', 'claim', 'set', 'subject', 'state'],
    confirmation: ['confirmation'],
    links: ['links', 'issue'],
  };
  const commonFlags = new Set(['owner', 'repo', 'base-ref']);
  const allowedFlags = new Set([...commonFlags, ...(modeFlags[mode] ?? [])]);
  for (const name of Object.keys(values)) {
    if (!allowedFlags.has(name)) {
      throw new Error(`--${name} is not valid with --${mode}`);
    }
  }
  const parsed = {
    help: false,
    mode,
    ...(owner === undefined ? {} : { owner }),
    ...(repo === undefined ? {} : { repo }),
    ...(baseRef === undefined ? {} : { baseRef }),
  };
  if (mode === 'records') {
    const className = optional('class');
    const state = optional('state');
    if (className === undefined) {
      throw new Error('--records requires --class <class>');
    }
    if (!isConfirmationClass(className)) {
      throw new Error(
        `--class must be one of ${AUTO_DECIDE_CONFIRMATION_CLASSES.join(', ')}`,
      );
    }
    if (state !== 'open' && state !== 'all') {
      throw new Error('--records requires --state open|all');
    }
    const source = optional('source');
    const claim = optional('claim');
    const set = optional('set');
    const subject = optional('subject');
    if (claim !== undefined && set !== undefined) {
      throw new Error('--claim and --set cannot be used together');
    }
    for (const [name, value] of [
      ['--claim', claim],
      ['--set', set],
      ['--subject', subject],
    ]) {
      if (value !== undefined && value.trim() === '') {
        throw new Error(`${name} must be non-empty when given`);
      }
    }
    parsed.class = className;
    parsed.state = state;
    if (source !== undefined) {
      parsed.source = parsePositiveIssueNumber(source, '--source');
    }
    if (claim !== undefined) parsed.claim = claim;
    if (set !== undefined) parsed.set = set;
    if (subject !== undefined) parsed.subject = subject;
    return parsed;
  }
  if (mode === 'confirmation') {
    parsed.confirmation = parsePositiveIssueNumber(
      optional('confirmation') ?? '',
      '--confirmation',
    );
    return parsed;
  }
  if (mode === 'links') {
    const issue = optional('issue');
    if (issue === undefined) {
      throw new Error('--links requires --issue <number>');
    }
    parsed.issue = parsePositiveIssueNumber(issue, '--issue');
  }
  return parsed;
}
function repositoryForCli(args, dependencies) {
  let owner = args.owner ?? '';
  let repo = args.repo ?? '';
  if (owner === '' && repo === '') {
    const slug = dependencies.repositorySlug
      ? dependencies.repositorySlug()
      : deriveRepositoryIdentity({ cwd: process.cwd() }).githubSlug;
    const parts = slug?.split('/') ?? [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        'cannot resolve the repository from this checkout\'s GitHub "origin" remote; pass --owner and --repo',
      );
    }
    owner = parts[0];
    repo = parts[1];
  }
  const repository = { owner, repo };
  assertRepository(repository);
  return repository;
}
function outputJson(output, value) {
  output(`${JSON.stringify(value, null, 2)}\n`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function usageResult(output, message) {
  outputJson(output, { status: 'usage-error', error: message });
  return { exitCode: 2, kind: 'usage', message, httpStatus: null };
}
function unreadableResult(output, mode, repository, error, details = {}) {
  outputJson(output, {
    status: 'unreadable',
    mode,
    repository,
    ...details,
    error,
  });
  return { exitCode: 1, kind: 'gate', message: error, httpStatus: null };
}
function printAutoDecisionRecordsHelp(output) {
  output(`Usage:
  node scripts/auto-decision-records.mjs --pending-count [--owner <owner> --repo <repo>] [--base-ref <name>]
  node scripts/auto-decision-records.mjs --records --class <class> [--source <number>] [--claim <id> | --set <id>] [--subject <value>] --state open|all [--owner <owner> --repo <repo>] [--base-ref <name>]
  node scripts/auto-decision-records.mjs --confirmation <number> [--owner <owner> --repo <repo>] [--base-ref <name>]
  node scripts/auto-decision-records.mjs --links --issue <number> [--owner <owner> --repo <repo>] [--base-ref <name>]

Read auto-decision confirmation records as JSON. The confirmation label and
policy are read from a trusted repository ref; the command never writes.
`);
}
/** Run the read-only command. All CLI and provider effects are injectable. */
export function runAutoDecisionRecordsCli(argv, dependencies = {}) {
  const output =
    dependencies.writeOutput ?? ((text) => process.stdout.write(text));
  let args;
  try {
    args = parseAutoDecisionRecordsArgs(argv);
  } catch (error) {
    return usageResult(output, errorMessage(error));
  }
  if (args.help) {
    printAutoDecisionRecordsHelp(output);
    return 0;
  }
  const mode = args.mode;
  let repository;
  try {
    repository = repositoryForCli(args, dependencies);
  } catch (error) {
    return usageResult(output, errorMessage(error));
  }
  let trusted;
  try {
    const reader = dependencies.readTrustedAutoDecide ?? readTrustedAutoDecide;
    trusted = reader({
      owner: repository.owner,
      repo: repository.repo,
      ...(args.baseRef === undefined ? {} : { baseRefName: args.baseRef }),
    });
  } catch (error) {
    const message = `the trusted confirmation-label policy could not be read: ${errorMessage(error)}`;
    return unreadableResult(output, mode, repository, message);
  }
  if (trusted.status !== 'readable') {
    return unreadableResult(
      output,
      mode,
      repository,
      trusted.error ?? 'the trusted confirmation-label policy is unreadable',
      { trustedPolicy: trusted },
    );
  }
  const confirmationLabel = trusted.confirmationLabelName;
  if (
    typeof confirmationLabel !== 'string' ||
    confirmationLabel.trim() === ''
  ) {
    return unreadableResult(
      output,
      mode,
      repository,
      'the trusted confirmation-label policy has no readable label name',
      { trustedPolicy: trusted },
    );
  }
  let authoringLabel;
  if (mode === 'records' || mode === 'confirmation') {
    try {
      const loadTrustedConfig =
        dependencies.loadTrustedConfig ??
        ((owner, repo, ref) =>
          loadTrustedIddConfig(owner, repo, ref, undefined, undefined, {
            userGlobalFallback: false,
          }));
      const config = loadTrustedConfig(
        repository.owner,
        repository.repo,
        trusted.ref,
      );
      authoringLabel =
        normalizePolicyConfig(config).issueAuthoring.authoringLabelName;
    } catch (error) {
      const message = `the trusted authoring-label policy could not be read: ${errorMessage(error)}`;
      return unreadableResult(output, mode, repository, message);
    }
  }
  const provider = dependencies.provider ?? createGithubProvider();
  if (mode === 'pending-count') {
    const result = countPendingConfirmationIssues(
      { repository, confirmationLabel },
      provider,
    );
    if (result.status === 'unreadable') {
      return unreadableResult(output, mode, repository, result.error);
    }
    outputJson(output, {
      status: 'readable',
      mode,
      repository,
      confirmationLabel,
      pendingCount: result.count,
    });
    return 0;
  }
  if (mode === 'records') {
    const result = findConfirmationIssues(
      {
        repository,
        class: args.class,
        confirmationLabel,
        authoringLabel: authoringLabel,
        state: args.state,
        ...(args.source === undefined
          ? {}
          : {
              source: `${repository.owner}/${repository.repo}#${args.source}`,
            }),
        ...(args.claim === undefined ? {} : { claim: args.claim }),
        ...(args.set === undefined ? {} : { set: args.set }),
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        ...(dependencies.policyPath === undefined
          ? {}
          : { policyPath: dependencies.policyPath }),
      },
      provider,
    );
    if (result.status === 'unreadable') {
      return unreadableResult(output, mode, repository, result.error);
    }
    const records = result.issues.flatMap((issue) =>
      issue.records.map((record) => ({
        ...record,
        state: issue.state,
        confirmationLabel: issue.confirmationLabel,
        authoringLabel: issue.authoringLabel,
      })),
    );
    outputJson(output, {
      status: 'readable',
      mode,
      repository,
      class: args.class,
      state: args.state,
      records,
    });
    return 0;
  }
  if (mode === 'confirmation') {
    const result = readConfirmationIssue(
      {
        repository,
        number: args.confirmation,
        confirmationLabel,
        authoringLabel: authoringLabel,
        ...(dependencies.policyPath === undefined
          ? {}
          : { policyPath: dependencies.policyPath }),
      },
      provider,
    );
    if (result.status === 'unreadable') {
      return unreadableResult(output, mode, repository, result.error);
    }
    const { status: _status, ...report } = result;
    outputJson(output, { status: 'readable', mode, repository, ...report });
    return 0;
  }
  const result = readDecisionLinks(
    {
      repository,
      number: args.issue,
      confirmationLabel,
      ...(dependencies.policyPath === undefined
        ? {}
        : { policyPath: dependencies.policyPath }),
    },
    provider,
  );
  if (result.status === 'unreadable') {
    return unreadableResult(output, mode, repository, result.error);
  }
  const { status: _status, ...report } = result;
  outputJson(output, { status: 'readable', mode, repository, ...report });
  return 0;
}
function runCli() {
  return runAutoDecisionRecordsCli(process.argv.slice(2));
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('auto-decision-records', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
