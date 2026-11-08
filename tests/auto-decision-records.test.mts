import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  type AutoDecisionIssueListRequest,
  type AutoDecisionIssuePageRequest,
  type AutoDecisionRecordsProvider,
  type ConfirmationFinderInput,
  type ConfirmationFinderRead,
  type ConfirmationIssueRead,
  countPendingConfirmationIssues,
  type DecisionLinksRead,
  findConfirmationIssues,
  matchDecisionRecord,
  readConfirmationIssue,
  readDecisionLinks,
  runAutoDecisionRecordsCli,
} from '../src/scripts/auto-decision-records.mts';
import type { TrustedAutoDecideReport } from '../src/scripts/idd-config.mts';
import { renderAuthoringOwnerMarker } from '../src/scripts/marker-helpers.mts';
import { pinLoadControlOff, stubExecutable } from './test-utils.mts';

const OWNER = 'kurone-kito';
const REPO = 'idd-skill';
const PREFIX = 'idd-skill';
const TRUSTED = 'kurone-kito';
const STRANGER = 'mallory';
const CONFIRMATION_LABEL = 'status:needs-confirmation';
const AUTHORING_LABEL = 'status:authoring';
const SOURCE = `${OWNER}/${REPO}#100`;
const SUBJECT = '/work/idd-skill.issue-100';
const EDITED_AT = '2026-11-02T00:00:00Z';
const REPOSITORY = { owner: OWNER, repo: REPO };

const policyDir = mkdtempSync(join(tmpdir(), 'auto-decision-records-'));
after(() => rmSync(policyDir, { recursive: true, force: true }));

function policyFile(name: string, content: string): string {
  const path = join(policyDir, name);
  writeFileSync(path, content);
  return path;
}

const TRUSTED_POLICY = policyFile(
  'trusted.json',
  JSON.stringify({ trustedMarkerActors: [TRUSTED] }),
);

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

interface CommentFixture {
  id: number;
  author?: string;
  body: string;
  lastEditedAt?: string | null;
}

interface IssueFixture {
  number: number;
  state?: 'OPEN' | 'CLOSED';
  author?: string;
  body: string;
  lastEditedAt?: string | null;
  labels?: string[];
  comments: CommentFixture[];
  /** Listed by the REST endpoint as a pull request. */
  pullRequest?: boolean;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function createdAt(id: number): string {
  return new Date(Date.UTC(2026, 10, 1) + id * 1000).toISOString();
}

/**
 * A stub of the two GitHub reads. Comments are served `pageSize` at a time,
 * and the REST list honours the label, the state, and the page size.
 */
class FakeGithub implements AutoDecisionRecordsProvider {
  readonly issues = new Map<number, IssueFixture>();
  readonly issueCalls: AutoDecisionIssuePageRequest[] = [];
  readonly listCalls: AutoDecisionIssueListRequest[] = [];
  pageSize = 100;
  /** Returns a payload to serve instead, or undefined for the normal one. */
  issuePageOverride?: (request: AutoDecisionIssuePageRequest) => unknown;
  listPageOverride?: (request: AutoDecisionIssueListRequest) => unknown;

  constructor(...issues: IssueFixture[]) {
    for (const issue of issues) {
      this.issues.set(issue.number, issue);
    }
  }

  readIssuePage(request: AutoDecisionIssuePageRequest): unknown {
    this.issueCalls.push(request);
    const override = this.issuePageOverride?.(request);
    if (override !== undefined) {
      return override;
    }
    const issue = this.issues.get(request.number);
    if (issue === undefined || issue.pullRequest === true) {
      return {
        data: { repository: { issue: null } },
        errors: [{ message: 'Could not resolve to an Issue' }],
      };
    }
    const start = request.cursor === null ? 0 : Number(request.cursor.slice(1));
    const end = start + this.pageSize;
    const hasNextPage = end < issue.comments.length;
    return {
      data: {
        repository: {
          issue: {
            number: issue.number,
            state: issue.state ?? 'OPEN',
            body: issue.body,
            lastEditedAt: issue.lastEditedAt ?? null,
            author: { login: issue.author ?? TRUSTED },
            labels: {
              nodes: (issue.labels ?? []).map((name) => ({ name })),
              pageInfo: { hasNextPage: false },
            },
            comments: {
              nodes: issue.comments.slice(start, end).map((comment) => ({
                databaseId: comment.id,
                lastEditedAt: comment.lastEditedAt ?? null,
                createdAt: createdAt(comment.id),
                updatedAt: createdAt(comment.id),
                body: comment.body,
                author: { login: comment.author ?? TRUSTED },
                isMinimized: false,
                minimizedReason: null,
              })),
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? `c${end}` : null,
              },
            },
          },
        },
      },
    };
  }

  listIssuesPage(request: AutoDecisionIssueListRequest): unknown {
    this.listCalls.push(request);
    const override = this.listPageOverride?.(request);
    if (override !== undefined) {
      return override;
    }
    const rows = [...this.issues.values()]
      .filter((issue) =>
        (issue.labels ?? []).some(
          (name) =>
            name.trim().toLowerCase() === request.label.trim().toLowerCase(),
        ),
      )
      .filter(
        (issue) =>
          request.state === 'all' || (issue.state ?? 'OPEN') === 'OPEN',
      )
      .sort((a, b) => a.number - b.number);
    const start = (request.page - 1) * request.perPage;
    return rows.slice(start, start + request.perPage).map((issue) => ({
      number: issue.number,
      state: (issue.state ?? 'OPEN').toLowerCase(),
      body: issue.body,
      user: { login: issue.author ?? TRUSTED },
      labels: (issue.labels ?? []).map((name) => ({ name })),
      ...(issue.pullRequest === true
        ? { pull_request: { url: `https://example.test/pull/${issue.number}` } }
        : {}),
    }));
  }
}

/** The comments connection of one served GraphQL page. */
interface CommentsConnection {
  nodes?: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** A provider that serves `issue` `pageSize` comments at a time and lets
 * `mutate` change each page's comments connection before it is returned. */
function servedWith(
  issue: IssueFixture,
  pageSize: number,
  mutate: (comments: CommentsConnection, cursor: string | null) => void,
): FakeGithub {
  const plain = new FakeGithub(issue);
  plain.pageSize = pageSize;
  const served = new FakeGithub(issue);
  served.issuePageOverride = (request) => {
    const payload = plain.readIssuePage(request) as {
      data: { repository: { issue: { comments: CommentsConnection } } };
    };
    mutate(payload.data.repository.issue.comments, request.cursor);
    return payload;
  };
  return served;
}

interface RecordFields {
  cls?: string;
  source?: string;
  claim?: string;
  set?: string;
  decision?: string;
}

function recordLine(fields: RecordFields = {}): string {
  return `<!-- ${PREFIX}-auto-decision: class=${fields.cls ?? 'worktreeRemnant'}; source=${fields.source ?? SOURCE}; claim=${fields.claim ?? 'claim-a'}; set=${fields.set ?? 'none'}; decision=${fields.decision ?? 'd1'} -->`;
}

function publicationLine(number: number): string {
  return `<!-- ${PREFIX}-authoring-publication: target=target-${number}; anchor=${OWNER}/${REPO}#${number}; set=set-c${number}; session=session-c; token=token-c -->`;
}

/** The five confirmation sections, with a Subject: line when `subject` is a
 * string. */
function sections(subject: string | null): string[] {
  return [
    '## Stop',
    '',
    ...(subject === null
      ? ['The session stopped on a question.']
      : [`Subject: \`${subject}\``, '', 'A leftover blocked the claim.']),
    '',
    '## Options',
    '',
    "### Keep today's behavior",
    '',
    'Cost: the operator attests by hand.',
    '',
    '### Remove the leftover',
    '',
    'Cost: the preserved copy needs a review.',
    '',
    '## Chosen option',
    '',
    'Remove the leftover',
    '',
    '## How to undo',
    '',
    'Restore the preserved copy.',
    '',
    '## Question',
    '',
    'Question: Close this issue to confirm the choice, or comment with another option to ask for rework.',
  ];
}

function subjectFor(
  fields: RecordFields,
  subject?: string | null,
): string | null {
  if (subject !== undefined) {
    return subject;
  }
  const cls = fields.cls ?? 'worktreeRemnant';
  return cls === 'worktreeRemnant' || cls === 'b1Leftover' ? SUBJECT : null;
}

function confirmationBody(
  number: number,
  fields: RecordFields = {},
  subject?: string | null,
): string {
  return [
    publicationLine(number),
    '',
    recordLine(fields),
    '',
    ...sections(subjectFor(fields, subject)),
    '',
  ].join('\n');
}

function recordComment(
  fields: RecordFields = {},
  subject?: string | null,
): string {
  return [
    recordLine(fields),
    '',
    ...sections(subjectFor(fields, subject)),
  ].join('\n');
}

function acquireComment(number: number, body: string): string {
  const target = `${OWNER}/${REPO}#${number}`;
  return renderAuthoringOwnerMarker({
    markerPrefix: PREFIX,
    target,
    anchor: target,
    mode: 'acquire',
    owner: 'owner-c',
    set: `set-c${number}`,
    session: 'session-c',
    bodySha256: sha256(body),
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function voidComment(decision: string): string {
  return `<!-- ${PREFIX}-auto-decision-void: decision=${decision} -->\nThis decision was not acted on.`;
}

function noteComment(decision: string, kind: 'location' | 'failure'): string {
  return `<!-- ${PREFIX}-auto-decision-note: decision=${decision}; kind=${kind} -->\nPreserved at /state/preserved.`;
}

function linkComment(fields: {
  cls?: string;
  claim?: string;
  set?: string;
  decision?: string;
  confirmation?: string;
}): string {
  return `<!-- ${PREFIX}-auto-decision-link: class=${fields.cls ?? 'worktreeRemnant'}; claim=${fields.claim ?? 'claim-a'}; set=${fields.set ?? 'none'}; decision=${fields.decision ?? 'd1'}; confirmation=${fields.confirmation ?? `${OWNER}/${REPO}#200`} -->\nA confirmation issue records this decision.`;
}

interface ConfirmationOptions {
  fields?: RecordFields;
  subject?: string | null;
  body?: string;
  /** The body the acquire marker hashes; the issue body by default. */
  acquireBody?: string;
  acquireAuthor?: string;
  comments?: CommentFixture[];
  labels?: string[];
  state?: 'OPEN' | 'CLOSED';
  author?: string;
  lastEditedAt?: string | null;
  pullRequest?: boolean;
}

/** A confirmation issue whose body record counts unless an option breaks it.
 * Comment IDs start at `number * 1000 + 1` with the acquire marker. */
function confirmationIssue(
  number: number,
  options: ConfirmationOptions = {},
): IssueFixture {
  const body =
    options.body ?? confirmationBody(number, options.fields, options.subject);
  return {
    number,
    state: options.state ?? 'OPEN',
    author: options.author ?? TRUSTED,
    body,
    lastEditedAt: options.lastEditedAt ?? null,
    labels: options.labels ?? [CONFIRMATION_LABEL],
    pullRequest: options.pullRequest,
    comments: [
      {
        id: number * 1000 + 1,
        author: options.acquireAuthor ?? TRUSTED,
        body: acquireComment(number, options.acquireBody ?? body),
      },
      ...(options.comments ?? []),
    ],
  };
}

/** A plain source issue holding link markers. */
function sourceIssue(number: number, comments: CommentFixture[]): IssueFixture {
  return {
    number,
    body: 'The source issue.',
    labels: [],
    comments,
  };
}

function read(
  github: FakeGithub,
  number: number,
  policyPath: string = TRUSTED_POLICY,
): ConfirmationIssueRead {
  return readConfirmationIssue(
    {
      repository: REPOSITORY,
      number,
      confirmationLabel: CONFIRMATION_LABEL,
      authoringLabel: AUTHORING_LABEL,
      policyPath,
    },
    github,
  );
}

function find(
  github: FakeGithub,
  input: Partial<ConfirmationFinderInput> = {},
): ConfirmationFinderRead {
  return findConfirmationIssues(
    {
      repository: REPOSITORY,
      class: 'worktreeRemnant',
      confirmationLabel: CONFIRMATION_LABEL,
      authoringLabel: AUTHORING_LABEL,
      policyPath: TRUSTED_POLICY,
      ...input,
    },
    github,
  );
}

function links(
  github: FakeGithub,
  number: number,
  policyPath: string = TRUSTED_POLICY,
): DecisionLinksRead {
  return readDecisionLinks(
    {
      repository: REPOSITORY,
      number,
      confirmationLabel: CONFIRMATION_LABEL,
      policyPath,
    },
    github,
  );
}

function readable<T extends { status: string }>(
  result: T,
): Extract<T, { status: 'readable' }> {
  assert.equal(result.status, 'readable', JSON.stringify(result));
  return result as Extract<T, { status: 'readable' }>;
}

function decisions(result: ConfirmationIssueRead): string[] {
  return readable(result).records.map((record) => record.decision);
}

function foundNumbers(result: ConfirmationFinderRead): number[] {
  return readable(result).issues.map((issue) => issue.number);
}

// ---------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------

test('a trusted, unedited confirmation issue reports its body record', () => {
  const github = new FakeGithub(
    confirmationIssue(200, { labels: [CONFIRMATION_LABEL, AUTHORING_LABEL] }),
  );
  const result = readable(read(github, 200));
  assert.equal(result.state, 'open');
  assert.equal(result.confirmationLabel, true);
  assert.equal(result.authoringLabel, true);
  assert.equal(result.bodyRecordCounts, true);
  assert.equal(result.bodyRecordReason, null);
  assert.deepEqual(result.records, [
    {
      issue: 200,
      from: 'body',
      class: 'worktreeRemnant',
      source: SOURCE,
      claim: 'claim-a',
      set: 'none',
      decision: 'd1',
      subject: SUBJECT,
      locationNote: false,
      failureNote: false,
    },
  ]);
  assert.deepEqual(result.voidedDecisions, []);
  assert.deepEqual(result.notes, []);
});

test('an HTML comment cannot supply a fake Stop section or subject', () => {
  const body = confirmationBody(200).replace(
    '## Stop',
    '<!--\n## Stop\nSubject: `/work/fake`\n-->\n## Stop',
  );
  const github = new FakeGithub(confirmationIssue(200, { body }));
  const result = readable(read(github, 200));
  assert.equal(result.records[0]?.subject, SUBJECT);
  assert.equal(
    matchDecisionRecord(result, {
      class: 'worktreeRemnant',
      source: SOURCE,
      claim: 'claim-a',
      subject: SUBJECT,
    }).verdict,
    'match',
  );
});

test('an inline-code example cannot supply a fake Stop section or subject', () => {
  const body = confirmationBody(200).replace(
    '## Stop',
    '``## Stop\nSubject: `/work/fake`\n``\n## Stop',
  );
  const github = new FakeGithub(confirmationIssue(200, { body }));
  const result = readable(read(github, 200));
  assert.equal(result.records[0]?.subject, SUBJECT);
  assert.equal(
    matchDecisionRecord(result, {
      class: 'worktreeRemnant',
      source: SOURCE,
      claim: 'claim-a',
      subject: SUBJECT,
    }).verdict,
    'match',
  );
  assert.equal(
    matchDecisionRecord(result, {
      class: 'worktreeRemnant',
      source: SOURCE,
      claim: 'claim-a',
      subject: '/work/fake',
    }).verdict,
    'no-match',
  );
});

test('an issue-head change between comment pages is unreadable', () => {
  const issue = confirmationIssue(200, {
    comments: [{ id: 200002, body: recordComment({ decision: 'd2' }) }],
  });
  const plain = new FakeGithub(issue);
  plain.pageSize = 1;
  const github = new FakeGithub(issue);
  github.issuePageOverride = (request) => {
    const page = plain.readIssuePage(request) as {
      data: {
        repository: {
          issue: { lastEditedAt: string | null };
        };
      };
    };
    if (request.cursor !== null) {
      page.data.repository.issue.lastEditedAt = EDITED_AT;
    }
    return page;
  };

  const result = read(github, 200);
  assert.deepEqual(result, {
    status: 'unreadable',
    error: 'kurone-kito/idd-skill#200 changed while reading comment pages',
  });
});

test('a record source in another repository does not count', () => {
  const source = `${OWNER}/another-repo#100`;
  const github = new FakeGithub(
    confirmationIssue(200, {
      fields: { source },
      comments: [
        { id: 200002, body: recordComment({ source, decision: 'd2' }) },
      ],
    }),
  );
  const result = readable(read(github, 200));
  assert.equal(result.bodyRecordCounts, false);
  assert.deepEqual(result.records, []);
  assert.match(result.bodyRecordReason ?? '', /confirmation repository/);
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('an HTML comment inside Stop cannot add a Subject line', () => {
  const body = confirmationBody(200).replace(
    `Subject: \`${SUBJECT}\``,
    `Subject: \`${SUBJECT}\`\n<!--\nSubject: \`/work/fake\`\n-->`,
  );
  const github = new FakeGithub(confirmationIssue(200, { body }));
  const result = readable(read(github, 200));
  assert.equal(result.records[0]?.subject, SUBJECT);
});

test('a closed issue without the authoring label reports both facts', () => {
  const github = new FakeGithub(confirmationIssue(200, { state: 'CLOSED' }));
  const result = readable(read(github, 200));
  assert.equal(result.state, 'closed');
  assert.equal(result.authoringLabel, false);
  assert.deepEqual(decisions(result), ['d1']);
});

test('a runtimeQuestion record carries no subject', () => {
  const github = new FakeGithub(
    confirmationIssue(200, { fields: { cls: 'runtimeQuestion' } }),
  );
  const [record] = readable(read(github, 200)).records;
  assert.equal(record?.class, 'runtimeQuestion');
  assert.equal(record?.subject, null);
});

// ---------------------------------------------------------------------
// One test per acceptance row
// ---------------------------------------------------------------------

test('row: an entry from a login outside trustedMarkerActors is not counted', () => {
  // A record comment from an untrusted login.
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        {
          id: 200002,
          author: STRANGER,
          body: recordComment({ decision: 'd2' }),
        },
      ],
    }),
    // A body written by an untrusted login.
    confirmationIssue(201, { author: STRANGER }),
  );
  assert.deepEqual(decisions(read(github, 200)), ['d1']);
  const untrustedBody = readable(read(github, 201));
  assert.equal(untrustedBody.bodyRecordCounts, false);
  assert.match(
    untrustedBody.bodyRecordReason ?? '',
    /not in trustedMarkerActors/,
  );
  assert.deepEqual(untrustedBody.records, []);
});

test('row: an empty or missing trustedMarkerActors list counts nothing', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [{ id: 200002, body: recordComment({ decision: 'd2' }) }],
    }),
  );
  for (const policy of [
    policyFile('empty.json', JSON.stringify({ trustedMarkerActors: [] })),
    policyFile('missing.json', JSON.stringify({ markerPrefix: PREFIX })),
  ]) {
    const result = readable(read(github, 200, policy));
    assert.equal(result.bodyRecordCounts, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(foundNumbers(find(github, { policyPath: policy })), []);
  }
});

test('row: a policy file that is present but unreadable is unreadable', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    sourceIssue(100, [{ id: 100001, body: linkComment({}) }]),
  );
  for (const policy of [
    policyFile('broken.json', '{"trustedMarkerActors": ['),
    policyFile('array.json', '[]'),
  ]) {
    const issue = read(github, 200, policy);
    assert.equal(issue.status, 'unreadable');
    assert.match(
      issue.status === 'unreadable' ? issue.error : '',
      /failed to load policy/,
    );
    assert.equal(find(github, { policyPath: policy }).status, 'unreadable');
    assert.equal(links(github, 100, policy).status, 'unreadable');
    assert.equal(
      matchDecisionRecord(issue, {
        class: 'worktreeRemnant',
        source: SOURCE,
        claim: 'claim-a',
        subject: SUBJECT,
      }).verdict,
      'unreadable',
    );
  }
});

test('row: a comment with a non-null lastEditedAt is not counted', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        {
          id: 200002,
          body: recordComment({ decision: 'd2' }),
          lastEditedAt: EDITED_AT,
        },
        { id: 200003, body: recordComment({ decision: 'd3' }) },
      ],
    }),
  );
  assert.deepEqual(decisions(read(github, 200)), ['d1', 'd3']);
});

test('the body record does not count once the body was edited', () => {
  const github = new FakeGithub(
    confirmationIssue(200, { lastEditedAt: EDITED_AT }),
  );
  const result = readable(read(github, 200));
  assert.equal(result.bodyRecordCounts, false);
  assert.match(result.bodyRecordReason ?? '', /edited/);
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('row: a body whose digest differs from the first trusted acquire does not count, and the finder skips it', () => {
  const body = confirmationBody(200);
  const github = new FakeGithub(
    // The acquire marker hashed another body.
    confirmationIssue(200, { acquireBody: `${body}changed` }),
    // A later acquire with the right digest does not stand in for the first.
    confirmationIssue(201, {
      acquireBody: 'another body',
      comments: [
        {
          id: 201002,
          body: acquireComment(201, confirmationBody(201)),
        },
      ],
    }),
  );
  for (const number of [200, 201]) {
    const result = readable(read(github, number));
    assert.equal(result.bodyRecordCounts, false, String(number));
    assert.match(result.bodyRecordReason ?? '', /digest differs/);
    assert.deepEqual(result.records, []);
  }
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('row: a body with no trusted acquire marker does not count, and the finder skips it', () => {
  const github = new FakeGithub(
    confirmationIssue(200, { acquireAuthor: STRANGER }),
  );
  const result = readable(read(github, 200));
  assert.equal(result.bodyRecordCounts, false);
  assert.match(result.bodyRecordReason ?? '', /no trusted mode=acquire/);
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('row: a marker not at its pinned position is not counted', () => {
  const proseFirst = [
    publicationLine(200),
    '',
    'A line of prose before the record.',
    recordLine(),
    '',
    ...sections(SUBJECT),
  ].join('\n');
  const indented = [
    publicationLine(201),
    '',
    ` ${recordLine()}`,
    '',
    ...sections(SUBJECT),
  ].join('\n');
  const noPublication = [recordLine(), '', ...sections(SUBJECT)].join('\n');
  const github = new FakeGithub(
    confirmationIssue(200, { body: proseFirst }),
    confirmationIssue(201, { body: indented }),
    confirmationIssue(202, { body: noPublication }),
    confirmationIssue(203, {
      comments: [
        // The record marker on the second line of a comment.
        {
          id: 203002,
          body: `Retried append.\n${recordComment({ decision: 'd2' })}`,
        },
      ],
    }),
  );
  for (const number of [200, 201, 202]) {
    const result = readable(read(github, number));
    assert.equal(result.bodyRecordCounts, false, String(number));
    assert.match(result.bodyRecordReason ?? '', /not a record marker/);
  }
  assert.deepEqual(decisions(read(github, 203)), ['d1']);
});

test('row: a record comment on an issue whose body record does not count is not counted', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      author: STRANGER,
      comments: [{ id: 200002, body: recordComment({ decision: 'd2' }) }],
    }),
  );
  const result = readable(read(github, 200));
  assert.equal(result.bodyRecordCounts, false);
  assert.deepEqual(result.records, []);
});

test('row: a record comment with another class or source than the body is not counted', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        {
          id: 200002,
          body: recordComment({
            decision: 'd2',
            cls: 'b1Leftover',
            claim: 'none',
          }),
        },
        {
          id: 200003,
          body: recordComment({
            decision: 'd3',
            source: `${OWNER}/${REPO}#999`,
          }),
        },
        // The source compares without case.
        {
          id: 200004,
          body: recordComment({
            decision: 'd4',
            source: `${OWNER.toUpperCase()}/${REPO}#100`,
          }),
        },
      ],
    }),
  );
  assert.deepEqual(decisions(read(github, 200)), ['d1', 'd4']);
});

test('row: a link marker from an untrusted login, edited, or not on the first line is not counted', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    sourceIssue(100, [
      { id: 100001, body: linkComment({ decision: 'd1' }) },
      { id: 100002, author: STRANGER, body: linkComment({ decision: 'd2' }) },
      {
        id: 100003,
        body: linkComment({ decision: 'd3' }),
        lastEditedAt: EDITED_AT,
      },
      {
        id: 100004,
        body: `See below.\n${linkComment({ decision: 'd4' })}`,
      },
      // A link naming a confirmation issue in another repository.
      {
        id: 100005,
        body: linkComment({ decision: 'd5', confirmation: 'other/repo#200' }),
      },
    ]),
  );
  const result = readable(links(github, 100));
  assert.deepEqual(result.links, [
    {
      class: 'worktreeRemnant',
      claim: 'claim-a',
      set: 'none',
      decision: 'd1',
      confirmation: `${OWNER}/${REPO}#200`,
      commentId: 100001,
    },
  ]);
});

test('row: the same decision ID twice with the same fields counts once', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [{ id: 200002, body: recordComment() }],
    }),
    sourceIssue(100, [
      { id: 100001, body: linkComment({}) },
      { id: 100002, body: linkComment({}) },
    ]),
  );
  const result = readable(read(github, 200));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.from, 'body');
  assert.deepEqual(result.conflictingDecisions, []);
  const linked = readable(links(github, 100));
  assert.deepEqual(
    linked.links.map((link) => link.commentId),
    [100001],
  );
});

test('the finder deduplicates one decision across confirmation issues and merges notes', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      comments: [{ id: 201002, body: noteComment('d1', 'location') }],
    }),
  );
  const result = readable(find(github));
  assert.deepEqual(foundNumbers(result), [200]);
  assert.equal(result.issues[0]?.records[0]?.locationNote, true);
});

test('the finder keeps counting notes from an issue whose body record does not count', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      body: 'The edited body no longer carries its record.',
      lastEditedAt: EDITED_AT,
      comments: [
        { id: 201002, body: noteComment('d1', 'location') },
        { id: 201003, body: noteComment('d1', 'failure') },
      ],
    }),
  );
  const result = readable(find(github));
  assert.equal(result.issues[0]?.records[0]?.locationNote, true);
  assert.equal(result.issues[0]?.records[0]?.failureNote, true);
});

test('the finder drops decision IDs that conflict across confirmation issues before filtering', () => {
  const claimConflict = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, { fields: { claim: 'claim-b' } }),
  );
  assert.deepEqual(foundNumbers(find(claimConflict, { claim: 'claim-a' })), []);

  const sourceConflict = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, { fields: { source: `${OWNER}/${REPO}#101` } }),
  );
  assert.deepEqual(foundNumbers(find(sourceConflict, { source: SOURCE })), []);

  const issueConflict = new FakeGithub(
    confirmationIssue(200, {
      comments: [{ id: 200002, body: recordComment({ claim: 'claim-b' }) }],
    }),
    confirmationIssue(201),
  );
  assert.deepEqual(foundNumbers(find(issueConflict, { claim: 'claim-a' })), []);
});

test('a voided decision is removed across the full finder result', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      body: 'The edited body no longer carries its record.',
      lastEditedAt: EDITED_AT,
      comments: [{ id: 201002, body: voidComment('d1') }],
    }),
  );
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('row: the same decision ID with a different claim, set, or subject counts neither', () => {
  const github = new FakeGithub(
    // Another claim.
    confirmationIssue(200, {
      comments: [
        { id: 200002, body: recordComment({ claim: 'claim-b' }) },
        { id: 200003, body: recordComment({ decision: 'd2' }) },
      ],
    }),
    // Another subject.
    confirmationIssue(201, {
      comments: [{ id: 201002, body: recordComment({}, '/work/other') }],
    }),
    // Another set.
    confirmationIssue(202, {
      fields: { cls: 'authoringChoice', claim: 'none', set: 'set-x' },
      comments: [
        {
          id: 202002,
          body: recordComment({
            cls: 'authoringChoice',
            claim: 'none',
            set: 'set-y',
          }),
        },
      ],
    }),
    sourceIssue(100, [
      { id: 100001, body: linkComment({}) },
      { id: 100002, body: linkComment({ claim: 'claim-b' }) },
    ]),
  );
  const claim = readable(read(github, 200));
  assert.deepEqual(decisions(claim), ['d2']);
  assert.deepEqual(claim.conflictingDecisions, ['d1']);
  for (const number of [201, 202]) {
    const result = readable(read(github, number));
    assert.deepEqual(result.records, [], String(number));
    assert.deepEqual(result.conflictingDecisions, ['d1']);
  }
  const linked = readable(links(github, 100));
  assert.deepEqual(linked.links, []);
  assert.deepEqual(linked.conflictingDecisions, ['d1']);
});

test('a void on another confirmation issue removes the linked decision', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      body: 'The edited body no longer carries its record.',
      lastEditedAt: EDITED_AT,
      comments: [{ id: 201002, body: voidComment('d1') }],
    }),
    sourceIssue(100, [
      {
        id: 100001,
        body: linkComment({
          decision: 'd1',
          confirmation: `${OWNER}/${REPO}#200`,
        }),
      },
    ]),
  );
  const linked = readable(links(github, 100));
  assert.deepEqual(linked.links, []);
  assert.deepEqual(linked.voidedDecisions, ['d1']);
});

test('a directly linked unlabelled target still contributes void markers', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      labels: [],
      comments: [{ id: 200002, body: voidComment('d1') }],
    }),
    sourceIssue(100, [
      {
        id: 100001,
        body: linkComment({ confirmation: `${OWNER}/${REPO}#200` }),
      },
    ]),
  );

  const linked = readable(links(github, 100));
  assert.deepEqual(linked.links, []);
  assert.deepEqual(linked.voidedDecisions, ['d1']);
});

test('void markers still count when a listed issue loses its label after the REST scan', () => {
  const issueWithVoid = confirmationIssue(200, {
    comments: [{ id: 200002, body: voidComment('d1') }],
  });
  const linkedTarget = confirmationIssue(201);
  const source = sourceIssue(100, [
    {
      id: 100001,
      body: linkComment({ confirmation: `${OWNER}/${REPO}#201` }),
    },
  ]);
  const plain = new FakeGithub(issueWithVoid, linkedTarget, source);
  const github = new FakeGithub(issueWithVoid, linkedTarget, source);
  github.issuePageOverride = (request) => {
    const page = plain.readIssuePage(request) as {
      data: {
        repository: {
          issue: { labels: { nodes: unknown[] } };
        };
      };
    };
    if (request.number === 200) {
      page.data.repository.issue.labels.nodes = [];
    }
    return page;
  };

  const linked = readable(links(github, 100));
  assert.deepEqual(linked.links, []);
  assert.deepEqual(linked.voidedDecisions, ['d1']);
  assert.deepEqual(foundNumbers(find(github)), []);
});

test('a comma-containing confirmation label makes link reads unreadable', () => {
  const github = new FakeGithub(sourceIssue(100, []));
  const result = readDecisionLinks(
    {
      repository: REPOSITORY,
      number: 100,
      confirmationLabel: CONFIRMATION_LABEL + ',another-label',
      policyPath: TRUSTED_POLICY,
    },
    github,
  );
  assert.deepEqual(result, {
    status: 'unreadable',
    error: 'the confirmation label name contains a comma',
  });
  assert.deepEqual(github.issueCalls, []);
  assert.deepEqual(github.listCalls, []);
});

test('row: a REST list entry that is a pull request is skipped', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, { pullRequest: true }),
  );
  assert.deepEqual(foundNumbers(find(github)), [200]);
  assert.deepEqual(
    github.issueCalls.map((call) => call.number),
    [200],
  );
});

test('the finder rechecks the current label and state after the REST scan', () => {
  const issue = confirmationIssue(200);
  const labelRemoved = new FakeGithub(issue);
  labelRemoved.issuePageOverride = (request) => {
    const page = new FakeGithub(issue).readIssuePage(request) as {
      data: {
        repository: {
          issue: { labels: { nodes: unknown[] } };
        };
      };
    };
    page.data.repository.issue.labels.nodes = [];
    return page;
  };
  assert.deepEqual(foundNumbers(find(labelRemoved)), []);

  const closed = new FakeGithub(issue);
  closed.issuePageOverride = (request) => {
    const page = new FakeGithub(issue).readIssuePage(request) as {
      data: {
        repository: {
          issue: { state: string };
        };
      };
    };
    page.data.repository.issue.state = 'CLOSED';
    return page;
  };
  assert.deepEqual(foundNumbers(find(closed)), []);
  assert.deepEqual(foundNumbers(find(closed, { state: 'all' })), [200]);
});

test('row: a failed read is unreadable', () => {
  const failing = new FakeGithub(confirmationIssue(200));
  failing.issuePageOverride = () => {
    throw new Error('gh: HTTP 502');
  };
  const issue = read(failing, 200);
  assert.deepEqual(issue, { status: 'unreadable', error: 'gh: HTTP 502' });
  assert.equal(find(failing).status, 'unreadable');
  assert.equal(links(failing, 200).status, 'unreadable');

  const listFailing = new FakeGithub(confirmationIssue(200));
  listFailing.listPageOverride = () => {
    throw new Error('gh: HTTP 500');
  };
  assert.equal(find(listFailing).status, 'unreadable');

  // A GraphQL error payload, and an issue number that is not an issue.
  const errors = new FakeGithub(confirmationIssue(200));
  errors.issuePageOverride = () => ({
    data: null,
    errors: [{ message: 'rate limited' }],
  });
  assert.equal(read(errors, 200).status, 'unreadable');
  assert.equal(read(new FakeGithub(), 999).status, 'unreadable');

  // The confirmation issue a link names cannot be read.
  const dangling = new FakeGithub(
    sourceIssue(100, [{ id: 100001, body: linkComment({}) }]),
  );
  assert.equal(links(dangling, 100).status, 'unreadable');
});

test('row: a missing comments page is unreadable', () => {
  const issue = confirmationIssue(200, {
    comments: [
      { id: 200002, body: recordComment({ decision: 'd2' }) },
      { id: 200003, body: recordComment({ decision: 'd3' }) },
    ],
  });
  // Every page served: the records come from all of them.
  const paged = new FakeGithub(issue);
  paged.pageSize = 1;
  assert.deepEqual(decisions(read(paged, 200)), ['d1', 'd2', 'd3']);
  assert.equal(paged.issueCalls.length, 3);

  // The second page fails.
  const secondFails = new FakeGithub(issue);
  secondFails.pageSize = 1;
  secondFails.issuePageOverride = (request) => {
    if (request.cursor === 'c2') {
      throw new Error('gh: page read failed');
    }
    return undefined;
  };
  assert.equal(read(secondFails, 200).status, 'unreadable');

  // A page that reports a next page without a cursor, a page with no nodes
  // array, and a cursor served twice.
  const mutations: [
    RegExp,
    (comments: CommentsConnection, cursor: string | null) => void,
  ][] = [
    [
      /hasNextPage without endCursor/,
      (comments, cursor) => {
        if (cursor === null) {
          comments.pageInfo = { hasNextPage: true, endCursor: null };
        }
      },
    ],
    [
      /missing a nodes array/,
      (comments, cursor) => {
        if (cursor === null) {
          delete comments.nodes;
        }
      },
    ],
    [
      /repeated comments cursor/,
      (comments, cursor) => {
        if (cursor === 'c1') {
          comments.pageInfo = { hasNextPage: true, endCursor: 'c1' };
        }
      },
    ],
  ];
  for (const [message, mutate] of mutations) {
    const result = read(servedWith(issue, 1, mutate), 200);
    assert.equal(result.status, 'unreadable');
    assert.match(result.status === 'unreadable' ? result.error : '', message);
  }
});

test('row: incomplete edit evidence is unreadable', () => {
  const issue = confirmationIssue(200);
  // A comment whose lastEditedAt is missing.
  const comment = read(
    servedWith(issue, 100, (comments) => {
      const node = comments.nodes?.[0] as { lastEditedAt?: unknown };
      delete node.lastEditedAt;
    }),
    200,
  );
  assert.equal(comment.status, 'unreadable');
  // An issue whose lastEditedAt is missing.
  const plain = new FakeGithub(issue);
  const body = new FakeGithub(issue);
  body.issuePageOverride = (request) => {
    const payload = plain.readIssuePage(request) as {
      data: { repository: { issue: { lastEditedAt?: unknown } } };
    };
    delete payload.data.repository.issue.lastEditedAt;
    return payload;
  };
  const result = read(body, 200);
  assert.equal(result.status, 'unreadable');
  assert.match(
    result.status === 'unreadable' ? result.error : '',
    /body-edit evidence is incomplete/,
  );
});

test('row: a missing REST list page is unreadable', () => {
  // Page 1 is full (100 pull requests, all skipped), and page 2 fails.
  const github = new FakeGithub(confirmationIssue(200));
  github.listPageOverride = (request) => {
    if (request.page === 1) {
      return Array.from({ length: request.perPage }, (_, index) => ({
        number: 1000 + index,
        body: '',
        pull_request: { url: 'x' },
      }));
    }
    throw new Error('gh: page 2 failed');
  };
  assert.equal(find(github).status, 'unreadable');
  assert.deepEqual(
    github.listCalls.map((call) => call.page),
    [1, 2],
  );

  for (const payload of [{ message: 'Not Found' }, null, [{ title: 'x' }]]) {
    const broken = new FakeGithub(confirmationIssue(200));
    broken.listPageOverride = () => payload;
    assert.equal(find(broken).status, 'unreadable', JSON.stringify(payload));
  }
});

/** A REST list row for a fixture, as the issues endpoint returns it. */
function listRow(issue: IssueFixture): Record<string, unknown> {
  return {
    number: issue.number,
    state: (issue.state ?? 'OPEN').toLowerCase(),
    body: issue.body,
    labels: (issue.labels ?? []).map((name) => ({ name })),
  };
}

/** 99 pull requests, so one more entry fills page 1 of the REST list. */
const PAGE_ONE_FILLERS = Array.from({ length: 99 }, (_, index) => ({
  number: 1000 + index,
  body: '',
  pull_request: { url: 'x' },
}));

test('a list that shifts during a scan is scanned again, so the shifted issue is not dropped', () => {
  const removed = confirmationIssue(200);
  const shifted = confirmationIssue(201);
  const github = new FakeGithub(removed, shifted);
  // #200 sits last on page 1 and #201 first on page 2. Right after the first
  // read of page 1, #200 loses the label, so #201 shifts onto page 1, which
  // that scan has already read, and its page 2 comes back empty.
  let labelRemoved = false;
  github.listPageOverride = (request) => {
    const rows = labelRemoved
      ? [...PAGE_ONE_FILLERS, listRow(shifted)]
      : [...PAGE_ONE_FILLERS, listRow(removed), listRow(shifted)];
    const start = (request.page - 1) * request.perPage;
    const page = rows.slice(start, start + request.perPage);
    if (request.page === 1 && !labelRemoved) {
      labelRemoved = true;
      removed.labels = [];
    }
    return page;
  };
  // A single scan would list only #200 and return it, dropping #201.
  const result = find(github);
  assert.deepEqual(foundNumbers(result), [201]);
  // The first scan saw {#200}, the second {#201}, and the third agreed.
  assert.deepEqual(
    github.listCalls.map((call) => call.page),
    [1, 2, 1, 2, 1, 2],
  );
});

test('a list whose scans never agree is unreadable', () => {
  const github = new FakeGithub(
    confirmationIssue(300),
    confirmationIssue(301),
    confirmationIssue(302),
  );
  let scan = 0;
  github.listPageOverride = (request) => {
    if (request.page === 1) {
      scan += 1;
    }
    const issue = github.issues.get(299 + scan);
    return issue === undefined ? [] : [listRow(issue)];
  };
  const result = find(github);
  assert.equal(result.status, 'unreadable');
  assert.match(
    result.status === 'unreadable' ? result.error : '',
    /changed between each of 3 consecutive scans/,
  );
  assert.equal(github.listCalls.length, 3);
  // No issue was read, so nothing from a changing list was returned.
  assert.deepEqual(github.issueCalls, []);
});

test('the page shape checks apply to every scan', () => {
  const github = new FakeGithub(confirmationIssue(200));
  let calls = 0;
  github.listPageOverride = () => {
    calls += 1;
    // The first scan reads normally; the second gets an error object.
    return calls === 1 ? undefined : { message: 'Server Error' };
  };
  assert.equal(find(github).status, 'unreadable');
  assert.equal(calls, 2);
});

test('row: a counting record for the class, source, claim or set, and subject matches', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      fields: {
        cls: 'authoringChoice',
        claim: 'none',
        set: 'set-x',
        decision: 'd201',
      },
    }),
  );
  const byClaim = matchDecisionRecord(read(github, 200), {
    class: 'worktreeRemnant',
    source: SOURCE.toUpperCase(),
    claim: 'claim-a',
    subject: SUBJECT,
  });
  assert.equal(byClaim.verdict, 'match', byClaim.reason);
  assert.deepEqual(
    byClaim.records.map((record) => record.decision),
    ['d1'],
  );
  const bySet = matchDecisionRecord(read(github, 201), {
    class: 'authoringChoice',
    source: SOURCE,
    set: 'set-x',
  });
  assert.equal(bySet.verdict, 'match', bySet.reason);
  // The matcher takes a finder result too.
  const viaFinder = matchDecisionRecord(find(github), {
    class: 'worktreeRemnant',
    source: SOURCE,
    claim: 'claim-a',
    subject: SUBJECT,
  });
  assert.equal(viaFinder.verdict, 'match', viaFinder.reason);
});

test('row: a record with another claim, set, or subject does not match', () => {
  const github = new FakeGithub(
    confirmationIssue(200),
    confirmationIssue(201, {
      fields: { cls: 'authoringChoice', claim: 'none', set: 'set-x' },
    }),
  );
  const worktree = read(github, 200);
  const base = { class: 'worktreeRemnant' as const, source: SOURCE };
  for (const expected of [
    { ...base, claim: 'claim-b', subject: SUBJECT },
    { ...base, claim: 'claim-a', subject: '/work/other' },
    {
      ...base,
      source: `${OWNER}/${REPO}#101`,
      claim: 'claim-a',
      subject: SUBJECT,
    },
  ]) {
    assert.equal(
      matchDecisionRecord(worktree, expected).verdict,
      'no-match',
      JSON.stringify(expected),
    );
  }
  assert.equal(
    matchDecisionRecord(read(github, 201), {
      class: 'authoringChoice',
      source: SOURCE,
      set: 'set-y',
    }).verdict,
    'no-match',
  );
  // The matcher refuses an expectation with no claim and no set, and a
  // subject class with no subject.
  assert.equal(
    matchDecisionRecord(worktree, { ...base, subject: SUBJECT }).verdict,
    'no-match',
  );
  assert.equal(
    matchDecisionRecord(worktree, { ...base, claim: 'claim-a' }).verdict,
    'no-match',
  );
});

test('row: the finder with a class and a set but no source returns the matching records of every labelled confirmation issue', () => {
  const choice = (
    set: string,
    source: string,
    decision: string,
  ): ConfirmationOptions => ({
    fields: { cls: 'authoringChoice', claim: 'none', set, source, decision },
  });
  const github = new FakeGithub(
    confirmationIssue(300, choice('set-s', `${OWNER}/${REPO}#100`, 'd300')),
    confirmationIssue(301, choice('set-s', `${OWNER}/${REPO}#101`, 'd301')),
    confirmationIssue(302, choice('set-t', `${OWNER}/${REPO}#102`, 'd302')),
    confirmationIssue(303, {
      fields: { cls: 'runtimeQuestion', set: 'none', decision: 'd303' },
    }),
    // Unlabelled: never listed.
    confirmationIssue(304, { ...choice('set-s', SOURCE, 'd304'), labels: [] }),
    // Closed: listed only for state=all.
    confirmationIssue(305, {
      ...choice('set-s', `${OWNER}/${REPO}#103`, 'd305'),
      state: 'CLOSED',
    }),
  );
  const open = find(github, { class: 'authoringChoice', set: 'set-s' });
  assert.deepEqual(foundNumbers(open), [300, 301]);
  assert.deepEqual(
    readable(open).issues.map((issue) => issue.records[0]?.source),
    [`${OWNER}/${REPO}#100`, `${OWNER}/${REPO}#101`],
  );
  assert.deepEqual(
    foundNumbers(
      find(github, { class: 'authoringChoice', set: 'set-s', state: 'all' }),
    ),
    [300, 301, 305],
  );
  assert.deepEqual(
    readable(
      find(github, { class: 'authoringChoice', set: 'set-s', state: 'all' }),
    ).issues.map((issue) => issue.state),
    ['open', 'open', 'closed'],
  );
});

test("row: a record comment whose claim differs from the body's is returned when filtered by its claim", () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      labels: [CONFIRMATION_LABEL, AUTHORING_LABEL],
      comments: [
        {
          id: 200002,
          body: recordComment({ decision: 'd2', claim: 'claim-b' }),
        },
      ],
    }),
  );
  const result = readable(find(github, { claim: 'claim-b' }));
  assert.equal(result.issues.length, 1);
  const [issue] = result.issues;
  assert.equal(issue?.number, 200);
  assert.equal(issue?.confirmationLabel, true);
  assert.equal(issue?.authoringLabel, true);
  assert.deepEqual(
    issue?.records.map((record) => [
      record.from,
      record.decision,
      record.claim,
    ]),
    [[200002, 'd2', 'claim-b']],
  );
  // The source filter keeps both, and the body claim keeps only the body.
  assert.deepEqual(
    readable(find(github, { source: SOURCE })).issues[0]?.records.map(
      (record) => record.decision,
    ),
    ['d1', 'd2'],
  );
  assert.deepEqual(
    readable(find(github, { claim: 'claim-a' })).issues[0]?.records.map(
      (record) => record.decision,
    ),
    ['d1'],
  );
});

test('row: a trusted void marker removes the decision from every result', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        { id: 200002, body: recordComment({ decision: 'd2' }) },
        { id: 200003, body: voidComment('d1') },
      ],
    }),
    sourceIssue(100, [
      { id: 100001, body: linkComment({ decision: 'd1' }) },
      { id: 100002, body: linkComment({ decision: 'd2' }) },
    ]),
  );
  const result = readable(read(github, 200));
  assert.deepEqual(decisions(result), ['d2']);
  assert.deepEqual(result.voidedDecisions, ['d1']);
  assert.deepEqual(
    readable(find(github)).issues[0]?.records.map((record) => record.decision),
    ['d2'],
  );
  const expected = {
    class: 'worktreeRemnant' as const,
    source: SOURCE,
    claim: 'claim-a',
    subject: SUBJECT,
  };
  assert.equal(
    matchDecisionRecord(result, { ...expected, decision: 'd1' }).verdict,
    'no-match',
  );
  assert.equal(
    matchDecisionRecord(find(github), { ...expected, decision: 'd1' }).verdict,
    'no-match',
  );
  const linked = readable(links(github, 100));
  assert.deepEqual(
    linked.links.map((link) => link.decision),
    ['d2'],
  );
  assert.deepEqual(linked.voidedDecisions, ['d1']);
});

test('a voided body decision leaves the record comments of the issue counting', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        { id: 200002, body: voidComment('d1') },
        {
          id: 200003,
          body: recordComment({ decision: 'd2', claim: 'claim-b' }),
        },
      ],
    }),
  );
  assert.deepEqual(foundNumbers(find(github, { claim: 'claim-b' })), [200]);
});

test('row: a void marker from an untrusted login, or edited, is ignored', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        { id: 200002, author: STRANGER, body: voidComment('d1') },
        { id: 200003, body: voidComment('d1'), lastEditedAt: EDITED_AT },
        { id: 200004, body: `Voided.\n${voidComment('d1')}` },
      ],
    }),
  );
  const result = readable(read(github, 200));
  assert.deepEqual(decisions(result), ['d1']);
  assert.deepEqual(result.voidedDecisions, []);
});

test('row: a trusted location or failure note sets its flag, and the decision still counts', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        { id: 200002, body: recordComment({ decision: 'd2' }) },
        { id: 200003, body: noteComment('d1', 'location') },
        { id: 200004, body: noteComment('d2', 'failure') },
      ],
    }),
  );
  const result = readable(read(github, 200));
  assert.deepEqual(
    result.records.map((record) => [
      record.decision,
      record.locationNote,
      record.failureNote,
    ]),
    [
      ['d1', true, false],
      ['d2', false, true],
    ],
  );
  assert.deepEqual(result.notes, [
    { decision: 'd1', kind: 'location', commentId: 200003 },
    { decision: 'd2', kind: 'failure', commentId: 200004 },
  ]);
  assert.deepEqual(
    readable(find(github)).issues[0]?.records.map((record) => [
      record.decision,
      record.locationNote,
      record.failureNote,
    ]),
    [
      ['d1', true, false],
      ['d2', false, true],
    ],
  );
});

test('row: a note from an untrusted login, edited, or not on the first line is ignored', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      comments: [
        { id: 200002, author: STRANGER, body: noteComment('d1', 'location') },
        {
          id: 200003,
          body: noteComment('d1', 'failure'),
          lastEditedAt: EDITED_AT,
        },
        { id: 200004, body: `Acted.\n${noteComment('d1', 'location')}` },
      ],
    }),
  );
  const result = readable(read(github, 200));
  assert.deepEqual(result.notes, []);
  assert.equal(result.records[0]?.locationNote, false);
  assert.equal(result.records[0]?.failureNote, false);
});

test("row: the matcher given a decision ID that differs from the matching record's does not match", () => {
  const github = new FakeGithub(confirmationIssue(200));
  const result = read(github, 200);
  const expected = {
    class: 'worktreeRemnant' as const,
    source: SOURCE,
    claim: 'claim-a',
    subject: SUBJECT,
  };
  const other = matchDecisionRecord(result, { ...expected, decision: 'd9' });
  assert.equal(other.verdict, 'no-match');
  assert.match(other.reason, /another decision ID/);
  assert.equal(
    matchDecisionRecord(result, { ...expected, decision: 'd1' }).verdict,
    'match',
  );
});

test('row: the passed confirmation label is used, never the local configuration', () => {
  const localPolicy = policyFile(
    'other-label.json',
    JSON.stringify({
      trustedMarkerActors: [TRUSTED],
      autoDecide: { confirmationLabelName: 'local:other-label' },
    }),
  );
  const github = new FakeGithub(
    confirmationIssue(200, { labels: ['  Status:Needs-Confirmation '] }),
    confirmationIssue(201, { labels: ['local:other-label'] }),
  );
  assert.equal(
    readable(read(github, 200, localPolicy)).confirmationLabel,
    true,
  );
  assert.equal(
    readable(read(github, 201, localPolicy)).confirmationLabel,
    false,
  );
  assert.deepEqual(
    foundNumbers(find(github, { policyPath: localPolicy })),
    [200],
  );
  assert.deepEqual(
    [...new Set(github.listCalls.map((call) => call.label))],
    [CONFIRMATION_LABEL],
  );
});

// ---------------------------------------------------------------------
// The default provider
// ---------------------------------------------------------------------

test('the default provider reads through gh: GraphQL for the issue, the REST list by label', () => {
  const issue = confirmationIssue(200);
  const fake = new FakeGithub(issue);
  const graphqlPayload = fake.readIssuePage({
    owner: OWNER,
    repo: REPO,
    number: 200,
    cursor: null,
  });
  const listPayload = fake.listIssuesPage({
    owner: OWNER,
    repo: REPO,
    label: CONFIRMATION_LABEL,
    state: 'open',
    page: 1,
    perPage: 100,
  });
  const argvLog = join(policyDir, 'gh-argv.jsonl');
  writeFileSync(argvLog, '');
  const script = `
    const { appendFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'api' && args.includes('graphql')) {
      process.stdout.write(${JSON.stringify(JSON.stringify(graphqlPayload))});
      process.exit(0);
    }
    if (args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))) {
      process.stdout.write(${JSON.stringify(JSON.stringify(listPayload))});
      process.exit(0);
    }
    process.stderr.write('unexpected gh ' + args.join(' '));
    process.exit(2);
  `;
  const restoreLoadControl = pinLoadControlOff();
  const previousGhHost = process.env.GH_HOST;
  const previousServerUrl = process.env.GITHUB_SERVER_URL;
  delete process.env.GH_HOST;
  process.env.GITHUB_SERVER_URL = 'https://ghes.example.com/';
  const restoreGh = stubExecutable('gh', script);
  try {
    const result = readConfirmationIssue({
      repository: REPOSITORY,
      number: 200,
      confirmationLabel: CONFIRMATION_LABEL,
      authoringLabel: AUTHORING_LABEL,
      policyPath: TRUSTED_POLICY,
    });
    assert.deepEqual(decisions(result), ['d1']);
    const found = findConfirmationIssues({
      repository: REPOSITORY,
      class: 'worktreeRemnant',
      confirmationLabel: CONFIRMATION_LABEL,
      authoringLabel: AUTHORING_LABEL,
      policyPath: TRUSTED_POLICY,
    });
    assert.deepEqual(foundNumbers(found), [200]);
  } finally {
    restoreGh();
    restoreLoadControl();
    if (previousGhHost === undefined) {
      delete process.env.GH_HOST;
    } else {
      process.env.GH_HOST = previousGhHost;
    }
    if (previousServerUrl === undefined) {
      delete process.env.GITHUB_SERVER_URL;
    } else {
      process.env.GITHUB_SERVER_URL = previousServerUrl;
    }
  }
  const calls = readFileSync(argvLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const graphql = calls.find((args) => args.includes('graphql')) ?? [];
  assert.deepEqual(graphql.slice(0, 4), [
    'api',
    '--hostname',
    'ghes.example.com',
    'graphql',
  ]);
  assert.ok(graphql.includes('number=200'), JSON.stringify(graphql));
  assert.ok(
    graphql.some(
      (arg) => arg.startsWith('query=') && arg.includes('lastEditedAt'),
    ),
  );
  const list = calls.find((args) =>
    args.some((arg) => arg.startsWith('repos/')),
  );
  assert.ok(
    list?.some((arg) =>
      arg.startsWith(
        `repos/${OWNER}/${REPO}/issues?labels=status%3Aneeds-confirmation&state=open&`,
      ),
    ),
    JSON.stringify(list),
  );
  const listCalls = calls.filter((args) =>
    args.some((arg) => arg.startsWith('repos/')),
  );
  assert.ok(listCalls.length > 0);
  assert.ok(
    listCalls.every(
      (args) =>
        args[0] === 'api' &&
        args[1] === '--hostname' &&
        args[2] === 'ghes.example.com',
    ),
    JSON.stringify(listCalls),
  );
});

const REMOTE_CONFIRMATION_LABEL = 'trusted:needs-confirmation';

function trustedAutoDecideReport(
  ref: string,
  label = CONFIRMATION_LABEL,
  status: 'readable' | 'unreadable' = 'readable',
): TrustedAutoDecideReport {
  return {
    status,
    source: 'repository',
    ref,
    master: status === 'readable' ? 'disabled' : 'unreadable',
    classes: {},
    ...(status === 'readable' ? { confirmationLabelName: label } : {}),
    ...(status === 'unreadable'
      ? { error: 'trusted policy cannot be read' }
      : {}),
  } as unknown as TrustedAutoDecideReport;
}

interface CliFixtureOptions {
  label?: string;
  status?: 'readable' | 'unreadable';
  repositorySlug?: string | null;
  trustedConfig?: unknown;
}

function runCliFixture(
  github: FakeGithub,
  argv: readonly string[],
  options: CliFixtureOptions = {},
): {
  outcome: ReturnType<typeof runAutoDecisionRecordsCli>;
  report: Record<string, unknown>;
  trustedInputs: Array<{ owner: string; repo: string; baseRefName?: string }>;
  configReads: Array<{ owner: string; repo: string; ref: string }>;
} {
  let stdout = '';
  const trustedInputs: Array<{
    owner: string;
    repo: string;
    baseRefName?: string;
  }> = [];
  const configReads: Array<{ owner: string; repo: string; ref: string }> = [];
  const outcome = runAutoDecisionRecordsCli(argv, {
    repositorySlug: () =>
      options.repositorySlug === undefined
        ? `${OWNER}/${REPO}`
        : options.repositorySlug,
    readTrustedAutoDecide: (input) => {
      trustedInputs.push(input);
      return trustedAutoDecideReport(
        input.baseRefName ?? 'main',
        options.label,
        options.status,
      );
    },
    loadTrustedConfig: (owner, repo, ref) => {
      configReads.push({ owner, repo, ref });
      return (
        options.trustedConfig ?? {
          issueAuthoring: { authoringLabelName: AUTHORING_LABEL },
        }
      );
    },
    provider: github,
    policyPath: TRUSTED_POLICY,
    writeOutput: (text) => {
      stdout += text;
    },
  });
  return {
    outcome,
    report: JSON.parse(stdout) as Record<string, unknown>,
    trustedInputs,
    configReads,
  };
}

function cliExitCode(
  outcome: ReturnType<typeof runAutoDecisionRecordsCli>,
): number {
  return typeof outcome === 'number' ? outcome : outcome.exitCode;
}

test('CLI uses the trusted label from origin policy for pending count', () => {
  const github = new FakeGithub(
    confirmationIssue(200, { labels: [REMOTE_CONFIRMATION_LABEL] }),
    confirmationIssue(201, { labels: [CONFIRMATION_LABEL] }),
    confirmationIssue(202, {
      labels: [REMOTE_CONFIRMATION_LABEL],
      state: 'CLOSED',
    }),
  );
  const result = runCliFixture(github, ['--pending-count'], {
    label: REMOTE_CONFIRMATION_LABEL,
  });
  assert.equal(cliExitCode(result.outcome), 0);
  assert.equal(result.report.mode, 'pending-count');
  assert.equal(result.report.confirmationLabel, REMOTE_CONFIRMATION_LABEL);
  assert.equal(result.report.pendingCount, 1);
  assert.deepEqual(result.report.repository, { owner: OWNER, repo: REPO });
  assert.deepEqual(result.trustedInputs, [{ owner: OWNER, repo: REPO }]);
  assert.deepEqual(result.configReads, []);
});

test('pending count scans every stable page and excludes pull requests', () => {
  const issues = Array.from({ length: 101 }, (_, index) =>
    confirmationIssue(1000 + index),
  );
  issues.push(
    confirmationIssue(1200, { state: 'CLOSED' }),
    confirmationIssue(1201, { pullRequest: true }),
  );
  const github = new FakeGithub(...issues);
  const result = countPendingConfirmationIssues(
    { repository: REPOSITORY, confirmationLabel: CONFIRMATION_LABEL },
    github,
  );
  assert.deepEqual(result, { status: 'readable', count: 101 });
  assert.deepEqual(
    github.listCalls.map((request) => request.page),
    [1, 2, 1, 2],
  );
  assert.ok(github.listCalls.every((request) => request.state === 'open'));
  assert.equal(github.issueCalls.length, 101);
});

test('CLI records flatten issue labels and note flags and pass --base-ref', () => {
  const github = new FakeGithub(
    confirmationIssue(200, {
      labels: [CONFIRMATION_LABEL, AUTHORING_LABEL],
      comments: [
        { id: 200002, body: noteComment('d1', 'location') },
        { id: 200003, body: noteComment('d1', 'failure') },
      ],
    }),
    confirmationIssue(201, {
      fields: { claim: 'claim-b', set: 'set-b', decision: 'd2' },
      state: 'CLOSED',
    }),
  );
  const byClaim = runCliFixture(github, [
    '--records',
    '--class',
    'worktreeRemnant',
    '--source',
    '100',
    '--claim',
    'claim-a',
    '--subject',
    SUBJECT,
    '--state',
    'open',
    '--owner',
    OWNER,
    '--repo',
    REPO,
    '--base-ref',
    'release/2026',
  ]);
  assert.equal(cliExitCode(byClaim.outcome), 0);
  assert.deepEqual(byClaim.trustedInputs, [
    { owner: OWNER, repo: REPO, baseRefName: 'release/2026' },
  ]);
  assert.deepEqual(byClaim.configReads, [
    { owner: OWNER, repo: REPO, ref: 'release/2026' },
  ]);
  const claimRecords = byClaim.report.records as Array<Record<string, unknown>>;
  assert.equal(claimRecords.length, 1);
  assert.deepEqual(
    {
      issue: claimRecords[0]?.issue,
      state: claimRecords[0]?.state,
      confirmationLabel: claimRecords[0]?.confirmationLabel,
      authoringLabel: claimRecords[0]?.authoringLabel,
      locationNote: claimRecords[0]?.locationNote,
      failureNote: claimRecords[0]?.failureNote,
    },
    {
      issue: 200,
      state: 'open',
      confirmationLabel: true,
      authoringLabel: true,
      locationNote: true,
      failureNote: true,
    },
  );

  const bySet = runCliFixture(github, [
    '--records',
    '--class',
    'worktreeRemnant',
    '--source',
    '100',
    '--set',
    'set-b',
    '--subject',
    SUBJECT,
    '--state',
    'all',
    '--owner',
    OWNER,
    '--repo',
    REPO,
  ]);
  assert.equal(cliExitCode(bySet.outcome), 0);
  const setRecords = bySet.report.records as Array<Record<string, unknown>>;
  assert.equal(setRecords.length, 1);
  assert.equal(setRecords[0]?.issue, 201);
  assert.equal(setRecords[0]?.state, 'closed');
});

test('CLI confirmation and links modes expose their reader reports', () => {
  const issue = confirmationIssue(200, {
    comments: [
      { id: 200002, body: noteComment('d1', 'location') },
      { id: 200003, body: noteComment('d1', 'failure') },
    ],
  });
  const github = new FakeGithub(
    issue,
    sourceIssue(300, [
      {
        id: 300001,
        body: linkComment({ confirmation: `${OWNER}/${REPO}#200` }),
      },
    ]),
  );
  const confirmation = runCliFixture(github, [
    '--confirmation',
    '200',
    '--owner',
    OWNER,
    '--repo',
    REPO,
  ]);
  assert.equal(cliExitCode(confirmation.outcome), 0);
  assert.equal(confirmation.report.number, 200);
  assert.equal(confirmation.report.authoringLabel, false);
  assert.deepEqual(confirmation.report.notes, [
    { decision: 'd1', kind: 'location', commentId: 200002 },
    { decision: 'd1', kind: 'failure', commentId: 200003 },
  ]);
  assert.equal(confirmation.configReads[0]?.ref, 'main');

  const links = runCliFixture(github, [
    '--links',
    '--issue',
    '300',
    '--owner',
    OWNER,
    '--repo',
    REPO,
  ]);
  assert.equal(cliExitCode(links.outcome), 0);
  assert.equal(links.report.number, 300);
  assert.deepEqual(
    (links.report.links as Array<Record<string, unknown>>).map(
      (link) => link.decision,
    ),
    ['d1'],
  );
  assert.deepEqual(links.configReads, []);
});

test('CLI stops unreadable trusted policy and usage errors before provider reads', () => {
  const github = new FakeGithub(confirmationIssue(200));
  const unreadable = runCliFixture(
    github,
    ['--pending-count', '--owner', OWNER, '--repo', REPO],
    { status: 'unreadable' },
  );
  assert.equal(cliExitCode(unreadable.outcome), 1);
  assert.equal(unreadable.report.status, 'unreadable');
  assert.equal(github.issueCalls.length, 0);
  assert.equal(github.listCalls.length, 0);

  for (const argv of [[], ['--unknown']]) {
    let stdout = '';
    const invalid = runAutoDecisionRecordsCli(argv, {
      writeOutput: (text) => {
        stdout += text;
      },
    });
    assert.equal(cliExitCode(invalid), 2);
    assert.equal(
      (JSON.parse(stdout) as { status?: string }).status,
      'usage-error',
    );
  }
});

test('CLI returns unreadable for provider failures in every mode', () => {
  const cases = [
    {
      name: 'pending count list failure',
      argv: ['--pending-count'],
      fail: 'list',
      issues: [confirmationIssue(200)],
    },
    {
      name: 'pending count issue failure',
      argv: ['--pending-count'],
      fail: 'issue',
      issues: [confirmationIssue(200)],
    },
    {
      name: 'records list failure',
      argv: ['--records', '--class', 'worktreeRemnant', '--state', 'all'],
      fail: 'list',
      issues: [confirmationIssue(200)],
    },
    {
      name: 'records issue failure',
      argv: ['--records', '--class', 'worktreeRemnant', '--state', 'all'],
      fail: 'issue',
      issues: [confirmationIssue(200)],
    },
    {
      name: 'confirmation issue failure',
      argv: ['--confirmation', '200'],
      fail: 'issue',
      issues: [confirmationIssue(200)],
    },
    {
      name: 'links issue failure',
      argv: ['--links', '--issue', '300'],
      fail: 'issue',
      issues: [sourceIssue(300, [{ id: 300001, body: linkComment({}) }])],
    },
  ] as const;

  for (const fixture of cases) {
    const github = new FakeGithub(...fixture.issues);
    if (fixture.fail === 'list') {
      github.listPageOverride = () => {
        throw new Error('gh: HTTP 502');
      };
    } else {
      github.issuePageOverride = () => {
        throw new Error('gh: HTTP 502');
      };
    }
    const result = runCliFixture(github, fixture.argv);
    assert.equal(cliExitCode(result.outcome), 1, fixture.name);
    assert.equal(result.report.status, 'unreadable', fixture.name);
    assert.match(String(result.report.error), /HTTP 502/, fixture.name);
  }
});
