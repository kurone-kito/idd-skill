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
  summarizeDispositionEvidenceForGate,
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
    throw new Error(`heading not found: ${heading}`);
  }
  const markerIndex = lines.findIndex(
    (line, index) => index > start && line.includes(marker),
  );
  const fence = String.fromCharCode(96).repeat(3);
  const previousOpen = lines.lastIndexOf(`${fence}sh`, markerIndex);
  const previousClose = lines.lastIndexOf(fence, markerIndex);
  const markerIsInsideBlock = previousOpen > previousClose;
  const open = markerIsInsideBlock
    ? previousOpen
    : lines.indexOf(`${fence}sh`, markerIndex);
  const close = lines.indexOf(fence, open + 1);
  if (markerIndex < 0 || open < 0 || close < 0) {
    throw new Error(`no manual sh block after ${marker}`);
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
      *reviewThreads*)
        if [ "\${STUB_THREADS_FAIL:-0}" = 1 ]; then exit 1; fi
        answer "$STUB_THREADS" ;;
      *"comments(first"*)
        if [ "\${STUB_EDIT_FAIL:-0}" = 1 ]; then exit 1; fi
        answer "$STUB_EDIT" ;;
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
  markerPrefixConfig?: string;
  advisoryBotLogins?: string[];
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
    url: fixtures.repoUrl ?? `https://github.com/${OWNER}/${REPO}`,
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

function runF2(fixtures: Fixtures, env: Record<string, string> = {}): F2Result {
  const root = makeSandbox(fixtures);
  if (
    fixtures.markerPrefixConfig !== undefined ||
    fixtures.advisoryBotLogins !== undefined
  ) {
    mkdirSync(join(root, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'idd', 'config.json'),
      JSON.stringify({
        ...(fixtures.markerPrefixConfig !== undefined
          ? { markerPrefix: fixtures.markerPrefixConfig }
          : {}),
        ...(fixtures.advisoryBotLogins !== undefined
          ? { advisoryBotLogins: fixtures.advisoryBotLogins }
          : {}),
      }),
    );
  }
  const block = inlineGraphqlVariables(
    substitutePlaceholders(fencedBlock('## F2')),
  );
  const script = `PR_HEAD_SHA=${HEAD_SHA}\n${block}`;
  const result = runScript(root, script, env);
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
    user: { login: `${BOT_LOGIN}[bot]` },
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
        user: { login: `${BOT_LOGIN}[bot]` },
        submitted_at: '2026-10-08T09:00:00Z',
        commit_id: '0'.repeat(40),
        id: 900,
      },
    ]) +
    '\n' +
    JSON.stringify([
      {
        user: { login: `${BOT_LOGIN}[bot]` },
        submitted_at: '2026-10-08T09:00:00.123Z',
        commit_id: HEAD_SHA,
        id: 901,
      },
    ]);
  const reviewComments = `[]\n${JSON.stringify([{ id: 1, path: 'src/one.mts', body: 'finding' }])}`;
  const run = runF2({ reviews, reviewComments });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.conjuncts,
    ['true', 'false', 'true'],
    run.stdout + run.stderr + JSON.stringify(run.ghCalls),
  );
  assert.ok(
    run.ghCalls.some((call) =>
      call.includes(`/pulls/${PR_NUMBER}/reviews/901/comments`),
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
      url: `https://github.com/${OWNER}/${REPO}`,
      authHost: 'github.com',
    },
    {
      url: `https://ghe.example.test/${OWNER}/${REPO}`,
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
          call.includes(`auth status --active --hostname ${route.authHost}`),
        ),
      );
      const apiEndpoint = `repos/${OWNER}/${REPO}`;
      assert.ok(
        result.ghCalls.some(
          (call) =>
            call.includes(`api --hostname ${route.authHost}`) &&
            call.includes(`${apiEndpoint}/issues/${PR_NUMBER}/comments`) &&
            call.includes('--method POST') &&
            call.includes('--silent'),
        ),
      );
      assert.ok(!result.ghCalls.some((call) => call.includes('auth token')));
      assert.ok(!result.stdout.includes('STUB_SECRET'));
      assert.ok(!result.stderr.includes('STUB_SECRET'));
    });
  }

  test(`${example.heading} fails closed for a ported GHES URL (#4638)`, {
    skip: SKIP_REASON ?? false,
  }, () => {
    const result = runManualRecoveryPost(
      example.heading,
      example.marker,
      `https://ghe.example.test:8443/${OWNER}/${REPO}`,
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

test('both manual recovery examples stop before POST when host or auth fails (#4659)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const examples = [
    { heading: '## AW3-R', marker: 'or manually:' },
    {
      heading: '## AW3-S',
      marker:
        'instructions-only profile, or any profile if the helper is unavailable',
    },
  ];

  for (const example of examples) {
    const hostMissing = runManualRecoveryPost(
      example.heading,
      example.marker,
      '',
    );
    assert.equal(
      hostMissing.status,
      2,
      `${example.heading}\n${hostMissing.stdout}${hostMissing.stderr}`,
    );
    assert.ok(
      !hostMissing.ghCalls.some((call) => call.startsWith('auth status')),
      example.heading,
    );
    assert.ok(
      !hostMissing.ghCalls.some((call) => call.includes('api --hostname')),
      example.heading,
    );
    assert.ok(
      !hostMissing.ghCalls.some((call) => call.includes('--method POST')),
      example.heading,
    );

    const unauthenticated = runManualRecoveryPost(
      example.heading,
      example.marker,
      `https://ghe.example.test/${OWNER}/${REPO}`,
      1,
    );
    assert.equal(
      unauthenticated.status,
      2,
      `${example.heading}\n${unauthenticated.stdout}${unauthenticated.stderr}`,
    );
    assert.ok(
      unauthenticated.ghCalls.some((call) =>
        call.includes('auth status --active --hostname ghe.example.test'),
      ),
      example.heading,
    );
    assert.ok(
      !unauthenticated.ghCalls.some((call) => call.includes('--method POST')),
      example.heading,
    );
  }
});

test('manual recovery POST stops before authentication for invalid or mismatched repository URLs (#4638)', {
  skip: SKIP_REASON ?? false,
}, () => {
  for (const repoUrl of [
    `http://ghe.example.test/${OWNER}/${REPO}`,
    `https://ghe.example.test:65536/${OWNER}/${REPO}`,
    'https://ghe.example.test:8443/other/repo',
    `https://ghe.example.test:8443.evil.test/${OWNER}/${REPO}`,
  ]) {
    const result = runManualRecoveryPost('## AW3-R', 'or manually:', repoUrl);
    assert.equal(result.status, 2, `${repoUrl}\n${result.stderr}`);
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

// ---------------------------------------------------------------------------
// F2 origin-specific dispositions (#4696): each case runs the shell block and
// the runtime helper on the same fixture, and the missing counts must agree.
// ---------------------------------------------------------------------------

const F2_CASE_TIME_1 = '2026-10-08T09:00:00Z';
const F2_CASE_TIME_2 = '2026-10-08T09:10:00Z';
const F2_CASE_TIME_3 = '2026-10-08T09:20:00Z';
const F2_EDITED_AT = '2026-10-08T09:50:00Z';

interface F2RegularRow {
  id: number;
  login: string;
  body: string;
  at: string;
  edited?: boolean;
  updatedAt?: string;
}

interface F2DifferentialCase {
  regular?: F2RegularRow[];
  threads?: unknown[];
  env?: Record<string, string>;
  advisoryBotLogins?: string[];
  trustedMarkerLogins?: string[];
  markerPrefix?: string;
}

interface F2CanonicalComment {
  id: string;
  author: { login: string };
  body: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
}

type F2CanonicalInput = Parameters<
  typeof summarizeDispositionEvidenceForGate
>[0];

/** One GraphQL review-thread comment, as the shell and the runtime both read it. */
function f2ThreadComment(
  login: string,
  body: string,
  createdAt: string,
  lastEditedAt: string | null = null,
): Record<string, unknown> {
  return {
    author: { login },
    body,
    createdAt,
    commit: null,
    lastEditedAt,
    updatedAt: lastEditedAt,
  };
}

/** A review thread whose comment list may be truncated. */
function f2Thread(
  comments: Array<Record<string, unknown>>,
  hasNextPage = false,
): unknown {
  return {
    isResolved: false,
    comments: {
      pageInfo: { hasNextPage },
      nodes: comments,
    },
  };
}

/**
 * Runs the F2 shell block and the runtime helper on one fixture and returns
 * both results, so each test can assert the shell agrees with the runtime.
 */
function runF2Differential(c: F2DifferentialCase): {
  shell: F2Result;
  canonical: ReturnType<typeof summarizeDispositionEvidenceForGate>;
} {
  const regular = c.regular ?? [];
  const threads = c.threads ?? [];
  const shell = runF2(
    {
      rest: regular.map((row) => ({
        id: row.id,
        user: { login: row.login },
        body: row.body,
        created_at: row.at,
        updated_at: row.updatedAt ?? row.at,
      })),
      edit: f2Edit(
        regular.map((row) => ({
          databaseId: row.id,
          lastEditedAt: row.edited ? F2_EDITED_AT : null,
        })),
      ),
      threads: threadsResponse(threads),
      markerPrefixConfig: c.markerPrefix,
      advisoryBotLogins: c.advisoryBotLogins,
    },
    c.env ?? {},
  );
  const canonicalComments: F2CanonicalComment[] = regular.map((row) => ({
    id: String(row.id),
    author: { login: row.login },
    body: row.body,
    createdAt: row.at,
    updatedAt: row.updatedAt ?? row.at,
    lastEditedAt: row.edited ? F2_EDITED_AT : null,
  }));
  const canonical = summarizeDispositionEvidenceForGate(
    {
      comments: canonicalComments,
      threads: threads,
    } as unknown as F2CanonicalInput,
    {
      iddAgentLogins: [AGENT_LOGIN],
      trustedMarkerLogins: c.trustedMarkerLogins ?? [AGENT_LOGIN],
      advisoryBotLogins: c.advisoryBotLogins ?? [],
      prHeadSha: HEAD_SHA,
      markerPrefix: c.markerPrefix ?? 'idd-skill',
    },
  );
  return { shell, canonical };
}

function assertF2Parity(
  c: F2DifferentialCase,
  expectedRegular: number,
  expectedThreads: number,
): void {
  const { shell, canonical } = runF2Differential(c);
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(canonical.missingRegularCommentCount, expectedRegular);
  assert.equal(canonical.missingThreadCount, expectedThreads);
  assert.equal(shell.missingRegularComments, expectedRegular, shell.stdout);
  assert.equal(shell.missingThreads, expectedThreads, shell.stdout);
}

const COPILOT_THREAD_FINDING = f2ThreadComment(
  `${BOT_LOGIN}[bot]`,
  'please fix',
  F2_CASE_TIME_1,
);

test('differential: an advisory-bot regular comment with no disposition is missing (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6001,
          login: 'coderabbitai[bot]',
          body: 'nit: rename this',
          at: F2_CASE_TIME_1,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a fresh unedited disposition settles one advisory comment and no other (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6002,
          login: 'coderabbitai[bot]',
          body: 'nit: rename this',
          at: F2_CASE_TIME_1,
        },
        {
          id: 6003,
          login: AGENT_LOGIN,
          body: '**Accepted** — renamed',
          at: F2_CASE_TIME_2,
        },
        {
          id: 6004,
          login: 'coderabbitai[bot]',
          body: 'nit: fix the typo',
          at: F2_CASE_TIME_3,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: an edited advisory disposition does not settle its comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6005,
          login: 'coderabbitai[bot]',
          body: 'nit: rename this',
          at: F2_CASE_TIME_1,
        },
        {
          id: 6006,
          login: AGENT_LOGIN,
          body: '**Accepted** — renamed',
          at: F2_CASE_TIME_2,
          edited: true,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a human-origin thread with only human follow-up is presence-only (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment('human-reviewer', 'ping, still open', F2_CASE_TIME_2),
        ]),
      ],
    },
    0,
    0,
  );
});

test('differential: a bot reply after a human-origin thread keeps the human origin (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment('coderabbitai[bot]', 'Looks good', F2_CASE_TIME_2),
        ]),
      ],
    },
    0,
    0,
  );
});

test('differential: a human thread with a later IDD reply needs a fresh disposition (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment('human-reviewer', 'still wrong', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a bot-origin thread with only a later human reply is missing (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('coderabbitai[bot]', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment('human-reviewer', 'agreed', F2_CASE_TIME_2),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a bot-origin thread with a fresh unedited disposition is settled (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment(`${BOT_LOGIN}[bot]`, 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
        ]),
      ],
    },
    0,
    0,
  );
});

test('differential: an edited, untrusted, or stale thread disposition stays missing (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // Edited: the disposition's edit state is not unedited.
  assertF2Parity(
    {
      threads: [
        f2Thread([
          COPILOT_THREAD_FINDING,
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
            F2_EDITED_AT,
          ),
        ]),
      ],
    },
    0,
    1,
  );
  // Untrusted: a disposition from a login that is not an IDD agent.
  assertF2Parity(
    {
      threads: [
        f2Thread([
          COPILOT_THREAD_FINDING,
          f2ThreadComment(
            'someone-else',
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
        ]),
      ],
    },
    0,
    1,
  );
  // Stale: later feedback postdates the disposition.
  assertF2Parity(
    {
      threads: [
        f2Thread([
          COPILOT_THREAD_FINDING,
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment(`${BOT_LOGIN}[bot]`, 'still broken', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a truncated human thread stays missing despite presence-only follow-up (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread(
          [
            f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
            f2ThreadComment('human-reviewer', 'ping', F2_CASE_TIME_2),
          ],
          true,
        ),
      ],
    },
    0,
    1,
  );
});

test('differential: a configured advisory bot from IDD_ADVISORY_BOT_LOGINS is advisory origin (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment(
            'my-review-bot[bot]',
            'please rename',
            F2_CASE_TIME_1,
          ),
          f2ThreadComment('human-reviewer', 'agreed', F2_CASE_TIME_2),
        ]),
      ],
      env: { IDD_ADVISORY_BOT_LOGINS: 'other-bot, my-review-bot[bot]' },
      advisoryBotLogins: ['my-review-bot[bot]'],
    },
    0,
    1,
  );
});

test('differential: a failed review-thread read blocks, never a clean zero (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2(
    { rest: [], edit: f2Edit([]), threads: threadsResponse([]) },
    { STUB_THREADS_FAIL: '1' },
  );
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /review-thread read failed/);
});

test('differential: a pending-decision reply after a disposition does not settle the thread (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          COPILOT_THREAD_FINDING,
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment(
            AGENT_LOGIN,
            '**Awaiting maintainer decision**\n\nPick one.',
            F2_CASE_TIME_3,
          ),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: feedback edited after a disposition reopens the thread (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          COPILOT_THREAD_FINDING,
          f2ThreadComment(
            AGENT_LOGIN,
            '**Accepted** — renamed',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment(
            'human-reviewer',
            'still broken',
            F2_CASE_TIME_1,
            F2_EDITED_AT,
          ),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: an advisory comment edited after its disposition is missing again (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6010,
          login: 'coderabbitai[bot]',
          body: 'nit: rename this',
          at: F2_CASE_TIME_1,
          updatedAt: F2_EDITED_AT,
        },
        {
          id: 6011,
          login: AGENT_LOGIN,
          body: '**Accepted** — renamed',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

// A terminal Codex no-find result: the canonical recognizer needs the exact
// "About Codex" details block after the reviewed-commit line (#4696).
const CODEX_NO_FIND_BODY = [
  "Codex Review: Didn't find any major issues. You're on a roll.",
  '',
  '**Reviewed commit:** `1111111`',
  '',
  '<details>',
  '<summary>ℹ️ About Codex in GitHub</summary>',
  '<br/>',
  '[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general)',
  'Reviews are triggered when you',
  '- Open a pull request for review',
  '- Mark a draft as ready',
  '- Comment "@codex review".',
  '</details>',
].join('\n');

test('differential: a Codex no-find result is cleared only by a disposition naming its source (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6601,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY,
          at: F2_CASE_TIME_1,
        },
        {
          id: 6602,
          login: AGENT_LOGIN,
          body: '**Accepted** — fixed',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
  assertF2Parity(
    {
      regular: [
        {
          id: 6603,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY,
          at: F2_CASE_TIME_1,
        },
        {
          id: 6604,
          login: AGENT_LOGIN,
          body: '**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-6603)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: a GitHub Actions waiver marker is not an outstanding comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6701,
          login: 'github-actions[bot]',
          body: '<!-- idd-external-check-waiver: run-1 -->\n\nWaiver recorded.',
          at: F2_CASE_TIME_1,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: a review-reply stamp from a human counts as an IDD-originated reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            'someone-else',
            'done <!-- idd-skill-review-reply -->',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment('human-reviewer', 'still wrong', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: an Accepted. or Rejected** variant with a dot still counts as an IDD disposition (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // A dotted **Accepted.** reply clears the regular comment it answers.
  assertF2Parity(
    {
      regular: [
        {
          id: 6801,
          login: 'coderabbitai[bot]',
          body: 'nit: rename this',
          at: F2_CASE_TIME_1,
        },
        {
          id: 6802,
          login: AGENT_LOGIN,
          body: '**Accepted.** renamed',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
  // A dotted IDD reply on a human thread is IDD-originated, so presence-only does not apply.
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(AGENT_LOGIN, '**Accepted.** renamed', F2_CASE_TIME_2),
          f2ThreadComment('human-reviewer', 'still wrong', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a source-bound Codex clearance must name the current HEAD (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6901,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY,
          at: F2_CASE_TIME_1,
        },
        {
          id: 6902,
          login: AGENT_LOGIN,
          body: '**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 2222222; no actionable findings were reported (source: #issuecomment-6901)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a source-bound Codex clearance must name the same bot login (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6911,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY,
          at: F2_CASE_TIME_1,
        },
        {
          id: 6912,
          login: AGENT_LOGIN,
          body: '**Accepted** — coderabbitai[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-6911)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a trusted-marker actor that is not an IDD agent clears no regular comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 6921,
          login: 'alice',
          body: 'please change this',
          at: F2_CASE_TIME_1,
        },
        {
          id: 6922,
          login: 'alice',
          body: '**Accepted** — changed',
          at: F2_CASE_TIME_2,
        },
      ],
      env: { IDD_TRUSTED_MARKER_ACTORS: `${AGENT_LOGIN},alice` },
      trustedMarkerLogins: [AGENT_LOGIN, 'alice'],
    },
    2,
    0,
  );
});

test('a Bot-typed originating author is advisory even when no list names it (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // Shell-only: the canonical helper knows only configured bots, so this case
  // documents the fail-closed direction rather than a parity check.
  const run = runF2({
    threads: threadsResponse([
      f2Thread([
        {
          author: { login: 'my-review-bot[bot]', __typename: 'Bot' },
          body: 'please rename',
          createdAt: F2_CASE_TIME_1,
          commit: null,
          lastEditedAt: null,
        },
        f2ThreadComment('human-reviewer', 'agreed', F2_CASE_TIME_2),
      ]),
    ]),
    edit: f2Edit([]),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.missingThreads, 1);
});

test('F2 stops when the edit-state read fails (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const run = runF2(
    { rest: regularRest(), threads: emptyThreads(), edit: f2Edit([]) },
    { STUB_EDIT_FAIL: '1' },
  );
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /edit-state read failed/);
});

test('differential: a source-bound Codex clearance must match the canonical sentence exactly (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const dispositions = [
    // Trailing text after the sentence: the canonical anchored regex rejects it.
    '**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7101) extra text',
    // No em dash.
    '**Accepted** chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7101)',
    // A login that only ends in the bot name.
    '**Accepted** — not-chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7101)',
  ];
  for (const body of dispositions) {
    assertF2Parity(
      {
        regular: [
          {
            id: 7101,
            login: 'chatgpt-codex-connector[bot]',
            body: CODEX_NO_FIND_BODY,
            at: F2_CASE_TIME_1,
          },
          { id: 7102, login: AGENT_LOGIN, body, at: F2_CASE_TIME_2 },
        ],
      },
      1,
      0,
    );
  }
});

test('differential: a Codex no-find whose reviewed commit is not the current HEAD is not clearable (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 7201,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY.replace('1111111', '0000000'),
          at: F2_CASE_TIME_1,
        },
        {
          id: 7202,
          login: AGENT_LOGIN,
          body: '**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7201)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: an older-HEAD Codex no-find is cleared by a generic IDD reply, not a source-bound one (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const older = CODEX_NO_FIND_BODY.replace('1111111', '0000000');
  // Alone, the older result stays missing.
  assertF2Parity(
    {
      regular: [
        {
          id: 7301,
          login: 'chatgpt-codex-connector[bot]',
          body: older,
          at: F2_CASE_TIME_1,
        },
      ],
    },
    1,
    0,
  );
  // An unedited IDD rejection after it clears it, as canonical does.
  assertF2Parity(
    {
      regular: [
        {
          id: 7302,
          login: 'chatgpt-codex-connector[bot]',
          body: older,
          at: F2_CASE_TIME_1,
        },
        {
          id: 7303,
          login: AGENT_LOGIN,
          body: '**Rejected** — superseded by a newer HEAD',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: a Codex comment with the phrase but no terminal no-find shape is an ordinary comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 7401,
          login: 'chatgpt-codex-connector[bot]',
          body: "Codex Review: Didn't find any major issues. Some other text.",
          at: F2_CASE_TIME_1,
        },
        {
          id: 7402,
          login: AGENT_LOGIN,
          body: '**Accepted** — fixed',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: a Codex result is terminal only with its exact opening and details shape (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const generic = {
    id: 7502,
    login: AGENT_LOGIN,
    body: '**Accepted** — fixed',
    at: F2_CASE_TIME_2,
  };
  // An unprefixed :rocket: opening is not a terminal result.
  assertF2Parity(
    {
      regular: [
        {
          id: 7501,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY.replace(
            "Codex Review: Didn't find any major issues. You're on a roll.",
            "Codex Review: Didn't find any major issues. :rocket:",
          ),
          at: F2_CASE_TIME_1,
        },
        generic,
      ],
    },
    0,
    0,
  );
  // A details block that is not the canonical one is not a terminal result.
  assertF2Parity(
    {
      regular: [
        {
          id: 7503,
          login: 'chatgpt-codex-connector[bot]',
          body: CODEX_NO_FIND_BODY.replace('Mark a draft as ready\n', ''),
          at: F2_CASE_TIME_1,
        },
        { ...generic, id: 7504 },
      ],
    },
    0,
    0,
  );
});

test('differential: a settled reply that mentions the pending phrase still settles (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 7601,
          login: 'coderabbitai[bot]',
          body: 'nit: stale message',
          at: F2_CASE_TIME_1,
        },
        {
          id: 7602,
          login: AGENT_LOGIN,
          body: '**Accepted** — removed the stale awaiting maintainer decision message.',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: an ordinary reply that mentions the no-find phrase still clears an ordinary comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 7701,
          login: 'coderabbitai[bot]',
          body: 'nit: check the wording',
          at: F2_CASE_TIME_1,
        },
        {
          id: 7702,
          login: AGENT_LOGIN,
          body: '**Accepted** — the no-find result at HEAD was reviewed by hand',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: a rejection confirmation clears a resolved advisory thread only (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const thread = (isResolved: boolean) => ({
    isResolved,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        COPILOT_THREAD_FINDING,
        f2ThreadComment(
          AGENT_LOGIN,
          '**Rejection confirmed by maintainer** — agreed',
          F2_CASE_TIME_2,
        ),
      ],
    },
  });
  assertF2Parity({ threads: [thread(true)] }, 0, 0);
  assertF2Parity({ threads: [thread(false)] }, 0, 1);
});

test('differential: a review-reply stamp with another prefix is not an IDD reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            'someone-else',
            'done <!-- other-review-reply -->',
            F2_CASE_TIME_2,
          ),
        ]),
      ],
    },
    0,
    0,
  );
});

test('differential: an upper-case review-reply stamp is an IDD-originated reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            'someone-else',
            'done <!-- IDD-SKILL-review-reply -->',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment('human-reviewer', 'still wrong', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a stamp with a longer suffix is not an IDD-originated reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            'someone-else',
            'done <!-- idd-skill-review-reply-extra -->',
            F2_CASE_TIME_2,
          ),
        ]),
      ],
    },
    0,
    0,
  );
});

test('differential: a rejection confirmation without the em-dash sentence does not settle a resolved thread (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const thread = {
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        COPILOT_THREAD_FINDING,
        f2ThreadComment(
          AGENT_LOGIN,
          '**Rejection confirmed by maintainer**? Still waiting for confirmation.',
          F2_CASE_TIME_2,
        ),
      ],
    },
  };
  assertF2Parity({ threads: [thread] }, 0, 1);
});

test('differential: leading whitespace before a rejection confirmation still settles a resolved thread (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  const thread = {
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        COPILOT_THREAD_FINDING,
        f2ThreadComment(
          AGENT_LOGIN,
          '\n**Rejection confirmed by maintainer** — agreed',
          F2_CASE_TIME_2,
        ),
      ],
    },
  };
  assertF2Parity({ threads: [thread] }, 0, 0);
});

test('differential: leading whitespace does not turn a current Codex no-find into an ordinary comment (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // A generic accepted reply cannot clear a current no-find, even with leading whitespace.
  assertF2Parity(
    {
      regular: [
        {
          id: 7801,
          login: 'chatgpt-codex-connector[bot]',
          body: `\n${CODEX_NO_FIND_BODY}`,
          at: F2_CASE_TIME_1,
        },
        {
          id: 7802,
          login: AGENT_LOGIN,
          body: '**Accepted** — fixed',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
  // The helper trims the source-bound reply, so a leading newline still clears it.
  assertF2Parity(
    {
      regular: [
        {
          id: 7803,
          login: 'chatgpt-codex-connector[bot]',
          body: `\n${CODEX_NO_FIND_BODY}`,
          at: F2_CASE_TIME_1,
        },
        {
          id: 7804,
          login: AGENT_LOGIN,
          body: '\n**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7803)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
  // An untrimmed source-bound reply with no leading newline still clears it.
  assertF2Parity(
    {
      regular: [
        {
          id: 7805,
          login: 'chatgpt-codex-connector[bot]',
          body: `\n${CODEX_NO_FIND_BODY}`,
          at: F2_CASE_TIME_1,
        },
        {
          id: 7806,
          login: AGENT_LOGIN,
          body: '**Accepted** — chatgpt-codex-connector[bot] no-find result at HEAD 1111111; no actionable findings were reported (source: #issuecomment-7805)',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: the configured marker prefix, not the default, names an IDD reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // With a custom configured prefix, a stamp with that prefix is an IDD reply.
  assertF2Parity(
    {
      markerPrefix: 'custom',
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            'someone-else',
            'done <!-- custom-review-reply -->',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment('human-reviewer', 'still wrong', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a pending-decision marker inside code or quoted text does not block a settled reply (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 7901,
          login: 'coderabbitai[bot]',
          body: 'nit: show the marker',
          at: F2_CASE_TIME_1,
        },
        {
          id: 7902,
          login: AGENT_LOGIN,
          body: '**Accepted** — added the example:\n```\n**Awaiting maintainer decision**\n```',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
  assertF2Parity(
    {
      regular: [
        {
          id: 7903,
          login: 'coderabbitai[bot]',
          body: 'nit: quote the marker',
          at: F2_CASE_TIME_1,
        },
        {
          id: 7904,
          login: AGENT_LOGIN,
          body: '**Accepted** — quoted it\n> **Awaiting maintainer decision** example',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});

test('differential: an IDD pending-decision reply on a human thread is IDD-originated (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment('human-reviewer', 'please rename', F2_CASE_TIME_1),
          f2ThreadComment(
            AGENT_LOGIN,
            '**Awaiting maintainer decision**\n\nPick one.',
            F2_CASE_TIME_2,
          ),
          f2ThreadComment('human-reviewer', 'still open', F2_CASE_TIME_3),
        ]),
      ],
    },
    0,
    1,
  );
});

test('differential: a bot listed only in the repository config is advisory origin (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      threads: [
        f2Thread([
          f2ThreadComment(
            'my-review-bot[bot]',
            'please rename',
            F2_CASE_TIME_1,
          ),
          f2ThreadComment('human-reviewer', 'agreed', F2_CASE_TIME_2),
        ]),
      ],
      advisoryBotLogins: ['my-review-bot[bot]'],
    },
    0,
    1,
  );
});

test('differential: an inline triple-backtick span does not hide a top-level pending marker (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  assertF2Parity(
    {
      regular: [
        {
          id: 8001,
          login: 'coderabbitai[bot]',
          body: 'nit: keep the marker',
          at: F2_CASE_TIME_1,
        },
        {
          id: 8002,
          login: AGENT_LOGIN,
          body: '**Accepted** — ok ```x```\n**Awaiting maintainer decision** pick one.',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a fence closes only on a matching backtick count (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // The marker sits inside a four-backtick fence that holds a three-backtick line: masked.
  assertF2Parity(
    {
      regular: [
        {
          id: 8101,
          login: 'coderabbitai[bot]',
          body: 'nit: show the example',
          at: F2_CASE_TIME_1,
        },
        {
          id: 8102,
          login: AGENT_LOGIN,
          body: '**Accepted** — example:\n````\n```\n**Awaiting maintainer decision** inside\n````',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
  // The same marker after the closing four-backtick fence is a live top-level marker.
  assertF2Parity(
    {
      regular: [
        {
          id: 8103,
          login: 'coderabbitai[bot]',
          body: 'nit: show the example',
          at: F2_CASE_TIME_1,
        },
        {
          id: 8104,
          login: AGENT_LOGIN,
          body: '**Accepted** — example:\n````\n```\n````\n**Awaiting maintainer decision** live',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    1,
    0,
  );
});

test('differential: a closing fence with trailing text does not close the fence (#4696)', {
  skip: SKIP_REASON ?? false,
}, () => {
  // "````x" is not a closing fence; an unclosed fence runs to the end, so the marker stays masked.
  assertF2Parity(
    {
      regular: [
        {
          id: 8201,
          login: 'coderabbitai[bot]',
          body: 'nit: show the example',
          at: F2_CASE_TIME_1,
        },
        {
          id: 8202,
          login: AGENT_LOGIN,
          body: '**Accepted** — example:\n````\n**Awaiting maintainer decision** inside\n````x\nstill inside',
          at: F2_CASE_TIME_2,
        },
      ],
    },
    0,
    0,
  );
});
