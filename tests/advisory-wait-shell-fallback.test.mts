import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type AdvisoryWaitMarkerSummary,
  summarizeAdvisoryWaitMarkers,
} from '../src/scripts/protocol-helpers.mts';

// Runs the fenced shell blocks of the shell fallback document under bash and
// jq, so the blocks are executed rather than only matched as text (#3860).
//
// The gh guard analyses the shell text a test spawns, and that analysis cannot
// follow a GraphQL variable declaration inside a quoted argument such as
// `query($owner:String!)`. So for execution only, each query's declared
// variables are inlined as their literal values (inlineGraphqlVariables). The
// shell code is otherwise unchanged. Each block's `gh` calls resolve to a
// fixture named `gh` on a sandbox PATH that holds no real gh, and the script
// is fed on stdin.

const DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'idd-template',
  'docs',
  'idd-advisory-wait-shell-fallback.md',
);

// Tools the blocks may call. Everything else, including curl and node, is
// absent from the sandbox PATH on purpose.
const ALLOWED_TOOLS = [
  'awk',
  'cat',
  'cut',
  'date',
  'dirname',
  'grep',
  'head',
  'jq',
  'mkdir',
  'rm',
  'sed',
  'sort',
  'tail',
  'tr',
  'uniq',
  'wc',
] as const;

const SKIP_REASON = findSkipReason();

function findSkipReason(): string | null {
  if (process.platform === 'win32') {
    return 'POSIX shell blocks only (the Windows CI job runs named files only)';
  }
  if (findTool('bash') === null) {
    return 'bash is not installed';
  }
  if (findTool('jq') === null) {
    return 'jq is not installed';
  }
  return null;
}

function findTool(name: string): string | null {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  });
  const path = result.stdout.trim();
  return result.status === 0 && path !== '' ? path : null;
}

const PR_NUMBER = '3909';
const OWNER = 'kurone-kito';
const REPO = 'idd-skill';
const HEAD_SHA = '1'.repeat(40);
const BOT_LOGIN = 'copilot-pull-request-reviewer';
const AGENT_LOGIN = 'idd-bot';

/** The first fenced sh block after the given heading, without its fences. */
function fencedBlock(heading: string): string {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) {
    throw new Error(`heading not found: ${heading}`);
  }
  const open = lines.indexOf('```sh', start);
  const close = lines.indexOf('```', open + 1);
  if (open < 0 || close < 0) {
    throw new Error(`no sh block under ${heading}`);
  }
  return lines.slice(open + 1, close).join('\n');
}

function substitutePlaceholders(text: string): string {
  return text
    .replaceAll('{pr-number}', PR_NUMBER)
    .replaceAll('{owner}', OWNER)
    .replaceAll('{repo}', REPO)
    .replaceAll('{agent-id}', AGENT_LOGIN)
    .replace(/(?<!\$)\{PR_HEAD_SHA\}/g, HEAD_SHA)
    .replaceAll('{ISO8601-recovery-time}', '2026-10-08T10:00:00Z')
    .replaceAll('{issue-number}', '3860')
    .replaceAll('{claim-id}', 'claim-3860')
    .replaceAll('{nonce}', 'nonce-3860')
    .replaceAll('{n}', '1')
    .replaceAll('{primary-advisory-bot-rest-login}', `${BOT_LOGIN}[bot]`)
    .replaceAll('{primary-advisory-bot-login}', BOT_LOGIN)
    .replaceAll('{primary-advisory-bot}', BOT_LOGIN);
}

function manualBlockAfter(heading: string, marker: string): string {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) {
    throw new Error('heading not found: ' + heading);
  }
  const markerIndex = lines.findIndex(
    (line, index) => index > start && line.includes(marker),
  );
  const fence = String.fromCharCode(96).repeat(3);
  const previousOpen = lines.lastIndexOf(fence + 'sh', markerIndex);
  const previousClose = lines.lastIndexOf(fence, markerIndex);
  const markerIsInsideBlock = previousOpen > previousClose;
  const open = markerIsInsideBlock
    ? previousOpen
    : lines.indexOf(fence + 'sh', markerIndex);
  const close = lines.indexOf(fence, open + 1);
  if (markerIndex < 0 || open < 0 || close < 0) {
    throw new Error('no manual sh block after ' + marker);
  }
  return lines
    .slice(markerIsInsideBlock ? markerIndex + 1 : open + 1, close)
    .join('\n');
}

/**
 * Inline the variables each GraphQL query declares, for execution only (#3860).
 * The query keeps its selection set; `$endCursor` becomes a null cursor.
 */
function inlineGraphqlVariables(text: string): string {
  return text.replace(/-f query='([^']*)'/g, (_match, query: string) => {
    const inlined = query
      .replace(
        /query\(\$owner:String!, \$repo:String!, \$number:Int!(?:, \$endCursor:String)?\)/g,
        'query',
      )
      .replaceAll('$endCursor', 'null')
      .replaceAll('$owner', `"${OWNER}"`)
      .replaceAll('$repo', `"${REPO}"`)
      .replaceAll('$number', PR_NUMBER);
    return `-f query='${inlined}'`;
  });
}

// The fixture answers from fixture files named in the environment. A --jq
// expression is applied to the fixture with jq, as gh would apply it.
const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
jq_expr=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then jq_expr="$a"; fi
  prev="$a"
done
answer() {
  if [ -n "$jq_expr" ]; then "$JQ_BIN" -c "$jq_expr" "$1"; else cat "$1"; fi
}
case "$*" in
  "repo view --json owner,name,url"*) "$JQ_BIN" -c "$jq_expr" "$STUB_REPO_URL" ;;
  "repo view --json owner"*) echo "${OWNER}" ;;
  "repo view --json name"*) echo "${REPO}" ;;
  "repo view --json url"*) "$JQ_BIN" -r "$jq_expr" "$STUB_REPO_URL" ;;
  "pr view "*"--json headRefOid"*) cat "$STUB_HEAD" ;;
  "api user"*) echo "$STUB_LOGIN" ;;
  "auth status --active --hostname "*) exit "$STUB_AUTH_STATUS_EXIT" ;;
  "pr edit "*) exit "\${STUB_PR_EDIT_EXIT:-0}" ;;
  "api graphql"*)
    case "$*" in
      *reviewRequests*)
        if [ "$(grep -c reviewRequests "$GH_CALLS")" -le 1 ]; then
          cat "$STUB_PROOF_BEFORE"
        else
          cat "$STUB_PROOF"
        fi ;;
      *reviewThreads*) answer "$STUB_THREADS" ;;
      *"comments(first"*) answer "$STUB_EDIT" ;;
      *) echo "stub: unrecognised graphql query" >&2; exit 1 ;;
    esac ;;
  *"/pulls/"*"/reviews/"*"/comments"*)
    case "$STUB_REVIEW_COMMENTS_FAIL" in
      first) exit 1 ;;
      late) cat "$STUB_REVIEW_COMMENTS"; exit 1 ;;
    esac
    answer "$STUB_REVIEW_COMMENTS" ;;
  *"/pulls/"*"/reviews"*)
    case "$STUB_REVIEW_LIST_FAIL" in
      first) exit 1 ;;
      late) cat "$STUB_REVIEWS"; exit 1 ;;
    esac
    answer "$STUB_REVIEWS" ;;
  *"/pulls/"*"/requested_reviewers"*) exit 0 ;;
  "api repos/"*"/issues/"*"/timeline"*)
    if [ "\${STUB_TIMELINE_FAIL:-0}" = 1 ]; then exit 1; fi
    cat "$STUB_TIMELINE" ;;
  *"/issues/"*"/comments"*)
    case "$*" in
      *"--method POST"*)
        case "$*" in
          *"--silent"*) exit 0 ;;
          *) echo '{"id": 1, "body": "posted"}'; exit 0 ;;
        esac ;;
    esac
    if [ "\${STUB_REST_FAIL:-0}" = 1 ]; then exit 1; fi
    answer "$STUB_REST" ;;
  *) echo "stub: unhandled gh call: $*" >&2; exit 1 ;;
esac
`;

interface Fixtures {
  rest?: unknown;
  edit?: unknown;
  threads?: unknown;
  reviews?: unknown;
  reviewComments?: unknown;
  reviewListFail?: 'first' | 'late';
  reviewCommentsFail?: 'first' | 'late';
  repoUrl?: string;
  authStatusExit?: number;
  proof?: string;
  proofBefore?: string;
  restFail?: boolean;
  timeline?: string;
  timelineFail?: boolean;
  prEditExit?: number;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  ghCalls: string[];
  registrationCalls: number;
}

/** A sandbox with the gh fixture, the claim-routing stub, and the allowed tools. */
function makeSandbox(fixtures: Fixtures): string {
  const root = mkdtempSync(join(tmpdir(), 'idd-shell-fallback-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'resume-claim-routing'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'resume-claim-routing'), 0o755);
  for (const tool of ALLOWED_TOOLS) {
    const path = findTool(tool);
    if (path !== null) {
      symlinkSync(path, join(bin, tool));
    }
  }
  const write = (name: string, value: unknown): void => {
    writeFileSync(
      join(root, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('rest.json', fixtures.rest ?? []);
  write('edit.json', fixtures.edit ?? emptyNodes('comments'));
  write('threads.json', fixtures.threads ?? emptyThreads());
  write(
    'reviews.json',
    fixtures.reviews ?? [
      {
        user: { login: `${BOT_LOGIN}[bot]` },
        submitted_at: '2026-10-08T09:00:00Z',
        commit_id: HEAD_SHA,
        id: 900,
      },
    ],
  );
  write('review-comments.json', fixtures.reviewComments ?? []);
  write('review-list-fail.txt', fixtures.reviewListFail ?? '');
  write('review-comments-fail.txt', fixtures.reviewCommentsFail ?? '');
  write('repo-url.json', {
    owner: { login: OWNER },
    name: REPO,
    url: fixtures.repoUrl ?? 'https://github.com/' + OWNER + '/' + REPO,
  });
  write('auth-status-exit.txt', String(fixtures.authStatusExit ?? 0));
  const proof =
    fixtures.proof ??
    '{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[]}}}}}';
  write('proof.json', proof);
  // The first removal read is the baseline; it defaults to the same evidence.
  write('proof-before.json', fixtures.proofBefore ?? proof);
  write('head.txt', HEAD_SHA);
  write('pr-edit-exit.txt', String(fixtures.prEditExit ?? 0));
  write('rest-fail.txt', fixtures.restFail ? '1' : '0');
  write('timeline.json', fixtures.timeline ?? '[]');
  write('timeline-fail.txt', fixtures.timelineFail ? '1' : '0');
  return root;
}

function emptyNodes(field: 'comments'): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          [field]: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  };
}

function emptyThreads(): unknown {
  return threadsResponse([]);
}

/**
 * Run `call` with this sandbox's gh fixture registered with the gh guard, as
 * a test declares its stub (#3860). The previous registration is restored.
 */
function withRegisteredGh<T>(ghPath: string, call: () => T): T {
  const previous = process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS;
  process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS = JSON.stringify([ghPath]);
  try {
    return call();
  } finally {
    if (previous === undefined) {
      delete process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS;
    } else {
      process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS = previous;
    }
  }
}

function runScript(
  root: string,
  body: string,
  env: Record<string, string>,
): RunResult {
  const bash = findTool('bash');
  assert.notEqual(bash, null, 'bash must be available for this test');
  const ghCalls = join(root, 'gh-calls.log');
  const registration = join(root, 'registration.log');
  writeFileSync(ghCalls, '');
  writeFileSync(registration, '');
  const result = withRegisteredGh(join(root, 'bin', 'gh'), () =>
    spawnSync(bash as string, [], {
      input: body,
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: join(root, 'bin'),
        GH_CALLS: ghCalls,
        JQ_BIN: findTool('jq') ?? 'jq',
        OWNER,
        REPO,
        PR_HEAD_SHA: HEAD_SHA,
        STUB_HEAD: join(root, 'head.txt'),
        STUB_LOGIN: AGENT_LOGIN,
        STUB_REST: join(root, 'rest.json'),
        STUB_EDIT: join(root, 'edit.json'),
        STUB_THREADS: join(root, 'threads.json'),
        STUB_REVIEWS: join(root, 'reviews.json'),
        STUB_REVIEW_COMMENTS: join(root, 'review-comments.json'),
        STUB_REVIEW_LIST_FAIL: readFileSync(
          join(root, 'review-list-fail.txt'),
          'utf8',
        ).trim(),
        STUB_REVIEW_COMMENTS_FAIL: readFileSync(
          join(root, 'review-comments-fail.txt'),
          'utf8',
        ).trim(),
        STUB_REPO_URL: join(root, 'repo-url.json'),
        STUB_AUTH_STATUS_EXIT: readFileSync(
          join(root, 'auth-status-exit.txt'),
          'utf8',
        ).trim(),
        STUB_PROOF: join(root, 'proof.json'),
        STUB_PROOF_BEFORE: join(root, 'proof-before.json'),
        STUB_PR_EDIT_EXIT: readFileSync(
          join(root, 'pr-edit-exit.txt'),
          'utf8',
        ).trim(),
        STUB_REST_FAIL: readFileSync(
          join(root, 'rest-fail.txt'),
          'utf8',
        ).trim(),
        STUB_TIMELINE: join(root, 'timeline.json'),
        STUB_TIMELINE_FAIL: readFileSync(
          join(root, 'timeline-fail.txt'),
          'utf8',
        ).trim(),
        REG_LOG: registration,
        IDD_TRUSTED_MARKER_ACTORS: AGENT_LOGIN,
        IDD_AGENT_LOGINS: AGENT_LOGIN,
        ...env,
      },
    }),
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ghCalls: readFileSync(ghCalls, 'utf8')
      .split('\n')
      .filter((line) => line !== ''),
    registrationCalls: readFileSync(registration, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length,
  };
}

// ---------------------------------------------------------------------------
// AW2: same-HEAD evidence and the request cap, with the edit state (#3860).
// ---------------------------------------------------------------------------

const AW2_MARKER_TIME = '2026-10-08T10:00:00Z';
const AW2_MARKER_ID = 101;

function aw2Rest(): unknown {
  return [
    {
      id: AW2_MARKER_ID,
      user: { login: AGENT_LOGIN },
      body: `advisory-wait: claim-x ${HEAD_SHA} ${AW2_MARKER_TIME}`,
      created_at: AW2_MARKER_TIME,
      updated_at: '2026-10-08T10:05:00Z',
    },
  ];
}

function aw2Edit(
  lastEditedAt: string | null | 'missing' | 'absent-field',
): unknown {
  const node =
    lastEditedAt === 'missing'
      ? { databaseId: 999 }
      : lastEditedAt === 'absent-field'
        ? { databaseId: AW2_MARKER_ID }
        : { databaseId: AW2_MARKER_ID, lastEditedAt };
  return {
    data: {
      repository: {
        pullRequest: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [node],
          },
        },
      },
    },
  };
}

function runAw2(fixtures: Fixtures): {
  status: number;
  stderr: string;
  values: Record<string, string>;
} {
  const root = makeSandbox(fixtures);
  const body = [
    `PR_HEAD_SHA=${HEAD_SHA}`,
    `OWNER=${OWNER}`,
    `REPO=${REPO}`,
    inlineGraphqlVariables(substitutePlaceholders(fencedBlock('## AW2'))),
    'printf "EARLIEST=%s\\nPRESENT=%s\\nCOUNT=%s\\n" "$EARLIEST_SAME_HEAD_AT" "$SAME_HEAD_REQUEST_MARKER_PRESENT" "$REQUEST_MARKER_COUNT"',
  ].join('\n');
  const result = runScript(root, body, {});
  const values: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key !== undefined && rest.length > 0) {
      values[key] = rest.join('=');
    }
  }
  rmSync(root, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, values };
}

test('AW2 ignores an edited same-HEAD marker as evidence but still counts it toward the cap (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({
    rest: aw2Rest(),
    edit: aw2Edit('2026-10-08T10:05:00Z'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.values.EARLIEST, '');
  assert.equal(run.values.PRESENT, 'false');
  assert.equal(run.values.COUNT, '1');
});

test('AW2 keeps an unedited marker that was minimized as same-HEAD evidence (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({ rest: aw2Rest(), edit: aw2Edit(null) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.values.EARLIEST, AW2_MARKER_TIME);
  assert.equal(run.values.PRESENT, 'true');
  assert.equal(run.values.COUNT, '1');
});

test('AW2 treats a marker whose edit state cannot be resolved as no evidence, still counted (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({ rest: aw2Rest(), edit: aw2Edit('missing') });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.values.EARLIEST, '');
  assert.equal(run.values.PRESENT, 'false');
  assert.equal(run.values.COUNT, '1');
});

test('AW2 stops with a non-zero exit when the comment list read fails (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({ rest: aw2Rest(), edit: aw2Edit(null), restFail: true });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /AW2 comment list read failed/);
});

// ---------------------------------------------------------------------------
// AW3-S: removal retry and removal proof before the request step (#3860).
// ---------------------------------------------------------------------------

function aw3sBody(resumeStub: string): string {
  const block = inlineGraphqlVariables(
    substitutePlaceholders(fencedBlock('## AW3-S')),
  );
  const cut = block.indexOf('# Step 5 --');
  assert.ok(cut > 0, 'AW3-S must keep its Step 5 line');
  const head = block
    .slice(0, cut)
    .replaceAll(
      '<profile-selected-resume-claim-routing-command>',
      `"${resumeStub}"`,
    );
  return [
    'COPILOT_PENDING=true',
    `PR_HEAD_SHA=${HEAD_SHA}`,
    'registration_attempt() { echo called >> "$REG_LOG"; return 0; }',
    head,
  ].join('\n');
}

function runAw3s(fixtures: Fixtures): {
  status: number;
  stderr: string;
  registrationCalls: number;
  prEdits: number;
} {
  const root = makeSandbox(fixtures);
  const result = runScript(
    root,
    aw3sBody(join(root, 'bin', 'resume-claim-routing')),
    {},
  );
  rmSync(root, { recursive: true, force: true });
  return {
    status: result.status,
    stderr: result.stderr,
    registrationCalls: result.registrationCalls,
    prEdits: result.ghCalls.filter((call) => call.startsWith('pr edit '))
      .length,
  };
}

const PROOF_LISTING_BOT = `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[{"requestedReviewer":{"__typename":"Bot","login":"${BOT_LOGIN}"}}]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[]}}}}}`;
const PROOF_BOT_GONE = `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[]}}}}}`;
const PROOF_REMOVED_EVENT = `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[{"requestedReviewer":{"__typename":"Bot","login":"${BOT_LOGIN}"}}]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[{"id":"E-after","createdAt":"2999-01-01T00:00:00Z","requestedReviewer":{"__typename":"Bot","login":"${BOT_LOGIN}"}}]}}}}}`;

test('AW3-S retries a failed removal three times and routes to AW4 without requesting (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({ prEditExit: 1 });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.prEdits, 3);
  assert.equal(run.registrationCalls, 0);
  assert.match(run.stderr, /route to AW4/);
});

test('AW3-S requests again only after the removal proof shows the bot gone (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({ prEditExit: 0, proof: PROOF_BOT_GONE });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.registrationCalls, 1);
});

const listedBot = (login: string, extra = ''): string =>
  `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[{"requestedReviewer":{"__typename":"Bot","login":"${login}"}}]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[${extra}]}}}}}`;
const removedEvent = (id: string, login: string): string =>
  `{"id":"${id}","createdAt":"2999-01-01T00:00:00Z","requestedReviewer":{"__typename":"Bot","login":"${login}"}}`;

test('AW3-S stops on an unreadable removal proof (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({
    prEditExit: 0,
    proofBefore: PROOF_BOT_GONE,
    proof: 'not json',
  });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(run.stderr, /removal proof unreadable; route to AW4/);
});

test('AW3-S stops on an unreadable baseline before it removes anything (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({ prEditExit: 0, proofBefore: 'not json' });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.prEdits, 0);
  assert.equal(run.registrationCalls, 0);
  assert.match(run.stderr, /removal baseline unreadable; route to AW4/);
});

test('AW3-S ignores a removal event that existed before the attempt (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const existing = listedBot(BOT_LOGIN, removedEvent('E1', BOT_LOGIN));
  const run = runAw3s({
    prEditExit: 0,
    proofBefore: existing,
    proof: existing,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(
    run.stderr,
    /removal not proven: bot still requested; route to AW4/,
  );
});

test('AW3-S accepts a removal event that is new since the baseline (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const before = listedBot(BOT_LOGIN, removedEvent('E1', BOT_LOGIN));
  const after = listedBot(
    BOT_LOGIN,
    `${removedEvent('E1', BOT_LOGIN)},${removedEvent('E2', BOT_LOGIN)}`,
  );
  const run = runAw3s({ prEditExit: 0, proofBefore: before, proof: after });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.registrationCalls, 1);
});

test('AW3-S reads the [bot] spelling of the primary Copilot login as the same bot (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({
    prEditExit: 0,
    proof: listedBot(`${BOT_LOGIN}[bot]`),
  });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(
    run.stderr,
    /removal not proven: bot still requested; route to AW4/,
  );
});

test('AW3-S stops when the proof still lists the bot and shows no removal event (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({ prEditExit: 0, proof: PROOF_LISTING_BOT });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(
    run.stderr,
    /removal not proven: bot still requested; route to AW4/,
  );
});

test('AW3-S accepts a review_request_removed event after the call as proof (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // The baseline lists no removal event, so the event below is new (#3860 review).
  const run = runAw3s({
    prEditExit: 0,
    proofBefore: PROOF_LISTING_BOT,
    proof: PROOF_REMOVED_EVENT,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.registrationCalls, 1);
});

// ---------------------------------------------------------------------------
// F2: thread and regular-comment dispositions with the edit state (#3860).
// ---------------------------------------------------------------------------

const F2_FINDING_TIME = '2026-10-08T09:10:00Z';
const F2_DISPOSITION_TIME = '2026-10-08T09:20:00Z';
const F2_LATER_TIME = '2026-10-08T09:40:00Z';

function threadsResponse(nodes: unknown[]): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  };
}

/** A review thread; its first comment is the originating one. */
function thread(comments: Array<Record<string, unknown>>): unknown {
  return {
    isResolved: false,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: comments.map((c) => ({ commit: null, lastEditedAt: null, ...c })),
    },
  };
}

function finding(login: string, createdAt: string): Record<string, unknown> {
  return {
    author: { login },
    body: 'please fix',
    createdAt,
    commit: { oid: HEAD_SHA },
    lastEditedAt: null,
  };
}

function disposition(
  createdAt: string,
  lastEditedAt: string | null,
): Record<string, unknown> {
  return {
    author: { login: AGENT_LOGIN },
    body: '**Accepted** — fixed',
    createdAt,
    commit: null,
    lastEditedAt,
  };
}

function f2Edit(
  nodes: Array<{ databaseId: number; lastEditedAt: string | null }>,
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  };
}

interface F2Result {
  status: number;
  stdout: string;
  stderr: string;
  conjuncts: string[];
  missingRegularComments: number;
  missingThreads: number;
  ghCalls: string[];
}

function runF2(fixtures: Fixtures): F2Result {
  const root = makeSandbox(fixtures);
  const block = inlineGraphqlVariables(
    substitutePlaceholders(fencedBlock('## F2')),
  );
  const script = 'PR_HEAD_SHA=' + HEAD_SHA + '\n' + block;
  const result = runScript(root, script, {});
  rmSync(root, { recursive: true, force: true });
  const conjuncts =
    /conjuncts=(\S+)/.exec(result.stdout)?.[1]?.split(',') ?? [];
  const regular = /missingRegularComments=(\d+)/.exec(result.stdout)?.[1];
  const threads = /missingThreads=(\d+)/.exec(result.stdout)?.[1];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    conjuncts,
    missingRegularComments: Number(regular ?? '-1'),
    missingThreads: Number(threads ?? '-1'),
    ghCalls: result.ghCalls,
  };
}

test('F2 blocks a failed review-list read on its first or later page (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const first = runF2({ reviewListFail: 'first' });
  assert.equal(first.status, 2);
  assert.match(first.stderr, /F2 review list read failed; not converged/);

  const late = runF2({ reviews: '[]', reviewListFail: 'late' });
  assert.equal(late.status, 2);
  assert.match(late.stderr, /F2 review list read failed; not converged/);
});

test('F2 rejects empty, malformed, and unexpected review-list data (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const emptyTransport = runF2({ reviews: '' });
  assert.equal(emptyTransport.status, 2);
  assert.match(emptyTransport.stderr, /F2 review list read empty/);

  for (const reviews of ['null', '[{}]', '[]\nnull']) {
    const run = runF2({ reviews });
    assert.equal(run.status, 2, reviews);
    assert.match(run.stderr, /F2 review list malformed; not converged/);
  }

  const botReview = {
    user: { login: BOT_LOGIN + '[bot]' },
    submitted_at: '2026-10-08T09:00:00Z',
    commit_id: HEAD_SHA,
    id: 901,
  };
  for (const review of [
    { ...botReview, submitted_at: '' },
    { ...botReview, submitted_at: 'not-a-date' },
    { ...botReview, submitted_at: '2026-02-31T09:00:00Z' },
    { ...botReview, submitted_at: '2026-10-08T09:00:00+25:00' },
    { ...botReview, commit_id: '' },
    { ...botReview, id: 0 },
    { ...botReview, user: { login: null } },
  ]) {
    const run = runF2({ reviews: JSON.stringify([review]) });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /F2 review list malformed; not converged/);
  }

  const validEmptyList = runF2({ reviews: '[]' });
  assert.equal(validEmptyList.status, 0, validEmptyList.stderr);
  assert.deepEqual(validEmptyList.conjuncts, ['false', 'false', 'true']);
});

test('F2 selects the latest review and counts comments across valid pages (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const reviews =
    JSON.stringify([
      { user: null },
      {
        user: { login: BOT_LOGIN + '[bot]' },
        submitted_at: '2026-10-08T09:00:00Z',
        commit_id: '0'.repeat(40),
        id: 900,
      },
    ]) +
    '\n' +
    JSON.stringify([
      {
        user: { login: BOT_LOGIN + '[bot]' },
        submitted_at: '2026-10-08T09:00:00.123Z',
        commit_id: HEAD_SHA,
        id: 901,
      },
    ]);
  const reviewComments =
    '[]\n' + JSON.stringify([{ id: 1, path: 'src/one.mts', body: 'finding' }]);
  const run = runF2({ reviews, reviewComments });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.conjuncts,
    ['true', 'false', 'true'],
    run.stdout + run.stderr + JSON.stringify(run.ghCalls),
  );
  assert.ok(
    run.ghCalls.some((call) =>
      call.includes('/pulls/' + PR_NUMBER + '/reviews/901/comments'),
    ),
  );
});

test('F2 blocks a failed review-comment read on its first or later page (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const first = runF2({ reviewCommentsFail: 'first' });
  assert.equal(first.status, 2);
  assert.match(first.stderr, /F2 review-comment read failed; not converged/);

  const late = runF2({
    reviewComments: '[]',
    reviewCommentsFail: 'late',
  });
  assert.equal(late.status, 2);
  assert.match(late.stderr, /F2 review-comment read failed; not converged/);
});

test('F2 rejects empty transport, malformed pages, and invalid review comments (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const emptyTransport = runF2({ reviewComments: '' });
  assert.equal(emptyTransport.status, 2);
  assert.match(emptyTransport.stderr, /F2 review-comment read empty/);

  for (const reviewComments of [
    'null',
    '[]\nnull',
    '[{}]',
    JSON.stringify([{ id: 0, path: 'src/file.mts', body: 'finding' }]),
    JSON.stringify([{ id: 1, path: '', body: 'finding' }]),
  ]) {
    const run = runF2({ reviewComments });
    assert.equal(run.status, 2, reviewComments);
    assert.match(run.stderr, /F2 review-comment read malformed; not converged/);
  }

  const emptyArray = runF2({ reviewComments: '[]' });
  assert.equal(emptyArray.status, 0, emptyArray.stderr);
  assert.deepEqual(emptyArray.conjuncts, ['true', 'true', 'true']);
});

function runManualRecoveryPost(
  heading: string,
  marker: string,
  repoUrl: string,
  authStatusExit = 0,
): RunResult {
  const root = makeSandbox({ repoUrl, authStatusExit });
  const body = substitutePlaceholders(manualBlockAfter(heading, marker));
  const result = runScript(root, body, {});
  rmSync(root, { recursive: true, force: true });
  return result;
}

for (const example of [
  { heading: '## AW3-R', marker: 'or manually:' },
  {
    heading: '## AW3-S',
    marker:
      'instructions-only profile, or any profile if the helper is unavailable',
  },
]) {
  for (const route of [
    {
      url: 'https://github.com/' + OWNER + '/' + REPO,
      authHost: 'github.com',
    },
    {
      url: 'https://ghe.example.test/' + OWNER + '/' + REPO,
      authHost: 'ghe.example.test',
    },
  ]) {
    test(example.heading +
      ' keeps its manual POST on ' +
      route.authHost +
      ' (#4638)', {
      skip: SKIP_REASON ?? false,
    }, () => {
      const result = runManualRecoveryPost(
        example.heading,
        example.marker,
        route.url,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.ghCalls.some((call) =>
          call.includes('auth status --active --hostname ' + route.authHost),
        ),
      );
      const apiEndpoint = 'repos/' + OWNER + '/' + REPO;
      assert.ok(
        result.ghCalls.some(
          (call) =>
            call.includes('api --hostname ' + route.authHost) &&
            call.includes(apiEndpoint + '/issues/' + PR_NUMBER + '/comments') &&
            call.includes('--method POST') &&
            call.includes('--silent'),
        ),
      );
      assert.ok(!result.ghCalls.some((call) => call.includes('auth token')));
      assert.ok(!result.stdout.includes('STUB_SECRET'));
      assert.ok(!result.stderr.includes('STUB_SECRET'));
    });
  }

  test(example.heading + ' fails closed for a ported GHES URL (#4638)', {
    skip: SKIP_REASON ?? false,
  }, () => {
    const result = runManualRecoveryPost(
      example.heading,
      example.marker,
      'https://ghe.example.test:8443/' + OWNER + '/' + REPO,
    );
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /cannot verify authentication for a ported GitHub host/,
    );
    assert.ok(!result.ghCalls.some((call) => call.startsWith('auth status')));
    assert.ok(!result.ghCalls.some((call) => call.includes('--method POST')));
    assert.ok(!result.ghCalls.some((call) => call.includes('auth token')));
    assert.ok(!result.stdout.includes('STUB_SECRET'));
    assert.ok(!result.stderr.includes('STUB_SECRET'));
  });
}

test('manual recovery POST stops when the host is unresolved or unauthenticated (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const hostMissing = runManualRecoveryPost('## AW3-R', 'or manually:', '');
  assert.equal(
    hostMissing.status,
    2,
    hostMissing.stdout +
      hostMissing.stderr +
      JSON.stringify(hostMissing.ghCalls),
  );
  assert.ok(
    !hostMissing.ghCalls.some((call) => call.includes('api --hostname')),
  );
  assert.ok(
    !hostMissing.ghCalls.some((call) => call.includes('--method POST')),
  );

  const unauthenticated = runManualRecoveryPost(
    '## AW3-S',
    'instructions-only profile, or any profile if the helper is unavailable',
    'https://ghe.example.test/' + OWNER + '/' + REPO,
    1,
  );
  assert.equal(unauthenticated.status, 2);
  assert.ok(
    !unauthenticated.ghCalls.some((call) => call.includes('--method POST')),
  );
});

test('manual recovery POST stops before authentication for invalid or mismatched repository URLs (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  for (const repoUrl of [
    'http://ghe.example.test/' + OWNER + '/' + REPO,
    'https://ghe.example.test:65536/' + OWNER + '/' + REPO,
    'https://ghe.example.test:8443/other/repo',
    'https://ghe.example.test:8443.evil.test/' + OWNER + '/' + REPO,
  ]) {
    const result = runManualRecoveryPost('## AW3-R', 'or manually:', repoUrl);
    assert.equal(result.status, 2, repoUrl + '\n' + result.stderr);
    assert.ok(
      !result.ghCalls.some((call) => call.startsWith('auth status')),
      repoUrl,
    );
    assert.ok(
      !result.ghCalls.some((call) => call.includes('--method POST')),
      repoUrl,
    );
  }
});

test('F2 does not count an edited disposition reply as a fresh disposition (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, F2_LATER_TIME),
      ]),
    ]),
    edit: f2Edit([]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.conjuncts, ['true', 'true', 'false']);
});

test('F2 lets an edited reply advance feedback past an earlier disposition (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, null),
        disposition(F2_LATER_TIME, F2_LATER_TIME),
      ]),
    ]),
    edit: f2Edit([]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.conjuncts, ['true', 'true', 'false']);
});

test('F2 accepts an unedited disposition reply (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, null),
      ]),
    ]),
    edit: f2Edit([]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.conjuncts, ['true', 'true', 'true']);
});

test('F2 counts a human thread whose only agent disposition is edited as missing (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const humanThread = (lastEditedAt: string | null) =>
    threadsResponse([
      thread([
        finding('human-reviewer', F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, lastEditedAt),
      ]),
    ]);
  const edited = runF2({
    threads: humanThread(F2_LATER_TIME),
    edit: f2Edit([]),
  });
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.missingThreads, 1);

  const unedited = runF2({ threads: humanThread(null), edit: f2Edit([]) });
  assert.equal(unedited.status, 0, unedited.stderr);
  assert.equal(unedited.missingThreads, 0);
});

// A regular comment from a human (id 5001), answered by an agent disposition (id 5002).
function regularRest(): unknown {
  return [
    {
      id: 5001,
      user: { login: 'human-reviewer' },
      body: 'please rename this',
      created_at: F2_FINDING_TIME,
    },
    {
      id: 5002,
      user: { login: AGENT_LOGIN },
      body: '**Accepted** — renamed',
      created_at: F2_DISPOSITION_TIME,
    },
  ];
}

test('F2 counts a regular comment whose answering disposition is edited, or missing from the edit join, as missing (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const edited = runF2({
    rest: regularRest(),
    threads: emptyThreads(),
    edit: f2Edit([
      { databaseId: 5001, lastEditedAt: null },
      { databaseId: 5002, lastEditedAt: F2_LATER_TIME },
    ]),
  });
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.missingRegularComments, 1);

  const missedJoin = runF2({
    rest: regularRest(),
    threads: emptyThreads(),
    edit: f2Edit([{ databaseId: 5001, lastEditedAt: null }]),
  });
  assert.equal(missedJoin.status, 0, missedJoin.stderr);
  assert.equal(missedJoin.missingRegularComments, 1);
});

test('F2 clears a regular comment answered by an unedited disposition (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    rest: regularRest(),
    threads: emptyThreads(),
    edit: f2Edit([
      { databaseId: 5001, lastEditedAt: null },
      { databaseId: 5002, lastEditedAt: null },
    ]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.missingRegularComments, 0);
});

test('F2 stops when the regular-comment read fails (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, null),
      ]),
    ]),
    edit: f2Edit([]),
    restFail: true,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /F2 regular-comment read failed; not converged \(#3860\)/,
  );
});

test('F2 stops when the regular-comment read is empty (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, null),
      ]),
    ]),
    edit: f2Edit([]),
    rest: '',
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /F2 regular-comment read empty; not converged \(#3860\)/,
  );
});

test('F2 counts a bare Copilot thread author as the Copilot reviewer (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([thread([finding('Copilot', F2_FINDING_TIME)])]),
    edit: f2Edit([]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.conjuncts, ['true', 'true', 'false']);
});

test('AW2 stops on a malformed comment list instead of reading it as empty (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({ rest: 'null' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /AW2 comment list malformed; not trusted \(#3860\)/);
});

test('F2 stops on a malformed regular-comment list instead of reading it as empty (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2({
    threads: threadsResponse([
      thread([
        finding(`${BOT_LOGIN}[bot]`, F2_FINDING_TIME),
        disposition(F2_DISPOSITION_TIME, null),
      ]),
    ]),
    edit: f2Edit([]),
    rest: 'null',
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /F2 regular-comment read malformed; not converged \(#3860\)/,
  );
});

test('AW2 treats a GraphQL row without lastEditedAt as unresolved, not as unedited (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw2({ rest: aw2Rest(), edit: aw2Edit('absent-field') });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.values.EARLIEST, '');
  assert.equal(run.values.PRESENT, 'false');
  assert.equal(run.values.COUNT, '1');
});

// AW1: the head-and-request timeline read, fail-closed (#3860 review).
function runAw1(fixtures: Fixtures): {
  status: number;
  stderr: string;
  covers: string;
} {
  const root = makeSandbox(fixtures);
  const block = substitutePlaceholders(fencedBlock('## AW1'));
  const result = runScript(
    root,
    `${block}\nprintf "COVERS=%s\\n" "$COPILOT_PENDING_COVERS_HEAD"`,
    {},
  );
  rmSync(root, { recursive: true, force: true });
  return {
    status: result.status,
    stderr: result.stderr,
    covers: /COVERS=(\S*)/.exec(result.stdout)?.[1] ?? '',
  };
}

const TIMELINE_HEAD = `[{"event":"committed","sha":"${HEAD_SHA}"}]`;
const TIMELINE_REQUEST = `[{"event":"review_requested","requested_reviewer":{"login":"${BOT_LOGIN}[bot]"}}]`;

test('AW1 stops when the timeline read fails (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw1({ timelineFail: true });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /timeline read failed; not trusted \(#3860\)/);
});

test('AW1 stops on an empty timeline instead of reading it as empty (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw1({ timeline: '' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /timeline read malformed; not trusted \(#3860\)/);
});

test('AW1 stops on a malformed timeline page (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw1({ timeline: '{"message":"not a list"}' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /timeline read malformed; not trusted \(#3860\)/);
});

test('AW1 reads a multi-page timeline and finds the request after HEAD (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw1({ timeline: `${TIMELINE_HEAD}\n${TIMELINE_REQUEST}` });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.covers, 'true');
});

test('AW3-S stops when the removal snapshot is truncated (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runAw3s({
    prEditExit: 0,
    proof: listedBot(BOT_LOGIN).replace(
      '"hasNextPage":false',
      '"hasNextPage":true',
    ),
  });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(run.stderr, /removal evidence truncated; route to AW4/);
});

test('AW3-S counts a configured User account that is still requested (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const user = `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[{"requestedReviewer":{"__typename":"User","login":"${BOT_LOGIN}"}}]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[]}}}}}`;
  const run = runAw3s({ prEditExit: 0, proof: user });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.registrationCalls, 0);
  assert.match(
    run.stderr,
    /removal not proven: bot still requested; route to AW4/,
  );
});

test('AW3-S does not treat a User node spelled with the [bot] suffix as the bot (#3860)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const user = `{"data":{"repository":{"pullRequest":{"reviewRequests":{"pageInfo":{"hasNextPage":false},"nodes":[{"requestedReviewer":{"__typename":"User","login":"${BOT_LOGIN}[bot]"}}]},"timelineItems":{"pageInfo":{"hasPreviousPage":false},"nodes":[]}}}}}`;
  const run = runAw3s({ prEditExit: 0, proof: user });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.registrationCalls, 1);
});

// #3948: the shell fallback and the runtime reader must agree on the same
// fixture. Both sides read the same REST rows and the same GraphQL edit-state
// object, so the reader never sees a value the shell route does not.
type Aw2Row = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
};

function aw2RestRows(login: string = AGENT_LOGIN): Aw2Row[] {
  return [
    {
      id: AW2_MARKER_ID,
      user: { login },
      body: `advisory-wait: claim-x ${HEAD_SHA} ${AW2_MARKER_TIME}`,
      created_at: AW2_MARKER_TIME,
      updated_at: '2026-10-08T10:05:00Z',
    },
  ];
}

/** The reader's comments, mapped from the same rows and edit object the shell
 * route reads. A row with no node, or a node without `lastEditedAt`, is
 * unresolved, exactly as the shell join treats it. */
function runtimeAw2(rows: Aw2Row[], edit: unknown): AdvisoryWaitMarkerSummary {
  const nodes = (
    edit as {
      data: {
        repository: {
          pullRequest: {
            comments: {
              nodes: { databaseId: number; lastEditedAt?: string | null }[];
            };
          };
        };
      };
    }
  ).data.repository.pullRequest.comments.nodes;
  const comments = rows.map((row) => {
    const node = nodes.find((candidate) => candidate.databaseId === row.id);
    const lastEditedAt =
      node === undefined || !('lastEditedAt' in node)
        ? 'unresolved'
        : node.lastEditedAt;
    return { ...row, lastEditedAt };
  });
  return summarizeAdvisoryWaitMarkers(comments, HEAD_SHA, [AGENT_LOGIN]);
}

function assertAw2Parity(
  run: { values: Record<string, string> },
  summary: AdvisoryWaitMarkerSummary,
): void {
  assert.equal(run.values.EARLIEST, summary.earliestSameHeadAt);
  assert.equal(
    run.values.PRESENT,
    String(summary.sameHeadRequestMarkerPresent),
  );
  assert.equal(run.values.COUNT, String(summary.requestMarkerCount));
}

test('differential: an unedited trusted same-HEAD marker reads the same in shell and runtime (#3948)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const rows = aw2RestRows();
  const run = runAw2({ rest: rows, edit: aw2Edit(null) });
  assert.equal(run.status, 0, run.stderr);
  assertAw2Parity(run, runtimeAw2(rows, aw2Edit(null)));
});

test('differential: an edited trusted marker reads the same in shell and runtime (#3948)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const rows = aw2RestRows();
  const run = runAw2({ rest: rows, edit: aw2Edit('2026-10-08T10:05:00Z') });
  assert.equal(run.status, 0, run.stderr);
  assertAw2Parity(run, runtimeAw2(rows, aw2Edit('2026-10-08T10:05:00Z')));
});

test('differential: a trusted marker with no edit-state join row reads the same in shell and runtime (#3948)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const rows = aw2RestRows();
  const run = runAw2({ rest: rows, edit: aw2Edit('missing') });
  assert.equal(run.status, 0, run.stderr);
  assertAw2Parity(run, runtimeAw2(rows, aw2Edit('missing')));
});

test('differential: an untrusted author with the same body reads the same in shell and runtime (#3948)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const rows = aw2RestRows('someone-else');
  const run = runAw2({ rest: rows, edit: aw2Edit(null) });
  assert.equal(run.status, 0, run.stderr);
  assertAw2Parity(run, runtimeAw2(rows, aw2Edit(null)));
});

test('differential: an edited request marker reads the same in shell and runtime, and still counts (#3948)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const rows = aw2RestRows();
  const run = runAw2({ rest: rows, edit: aw2Edit('2026-10-08T10:05:00Z') });
  assert.equal(run.status, 0, run.stderr);
  const summary = runtimeAw2(rows, aw2Edit('2026-10-08T10:05:00Z'));
  assertAw2Parity(run, summary);
  assert.equal(summary.requestMarkerCount, 1);
});
