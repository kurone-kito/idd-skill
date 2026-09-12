import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderAuthoringOwnerMarker,
  renderAuthoringPublicationIntentMarker,
} from '../src/scripts/marker-helpers.mts';
import { runMinimize } from '../src/scripts/minimize-superseded-markers.mts';
import {
  computeSweepExitCode,
  fetchIssueCommentsGraphql,
  runAuthoringMarkerSweep,
  type SweepGraphqlComment,
} from '../src/scripts/sweep-authoring-markers.mts';
import { stubExecutable } from './test-utils.mts';

const MARKER_PREFIX = 'idd-skill';
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'sweep-authoring-markers.mjs',
);

function ownerMarker(mode: string, owner: string): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target: 'kurone-kito/idd-skill#100',
    anchor: 'kurone-kito/idd-skill#100',
    mode,
    owner,
    set: 'set-1',
    session: 'session-1',
    bodySha256: 'none',
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function intentMarker(state: string, issue: string): string {
  return renderAuthoringPublicationIntentMarker({
    markerPrefix: MARKER_PREFIX,
    target: 'kurone-kito/idd-skill#100',
    anchor: 'kurone-kito/idd-skill#100',
    set: 'set-1',
    session: 'session-1',
    token: 'pub-1',
    journal: 'kurone-kito/idd-skill#200',
    issue,
    actor: 'kurone-kito',
    state,
  });
}

function comment(
  nodeId: string,
  body: string,
  authorLogin: string,
  isMinimized = false,
): SweepGraphqlComment {
  return {
    nodeId,
    url: `https://example.invalid/${nodeId}`,
    body,
    authorLogin,
    isMinimized,
  };
}

// Stub gh so runMinimize's own probe+apply calls are deterministic and
// offline: every probe reports a trusted, minimizable IssueComment; every
// apply mutation confirms isMinimized: true. This is deliberately
// coarse -- the point of these tests is sweep-authoring-markers.mts's OWN
// classify/filter/aggregate logic, not runMinimize's already-covered
// probe/apply behavior (tests/minimize-superseded-markers.test.mts) -- and
// it is safe here because this file's own pre-filter (classifyAuthoring
// MarkerFamily) already restricts every subjectId reaching runMinimize to
// an already-known-trusted, not-yet-minimized candidate.
const GH_MINIMIZE_STUB = `
const argv = process.argv.slice(2);
const queryArg = argv.find((a) => a.startsWith('query=')) || '';
const idArg = (argv.find((a) => a.startsWith('id=')) || '').slice(3);
if (queryArg.includes('minimizeComment')) {
  process.stdout.write(JSON.stringify({
    data: { minimizeComment: { minimizedComment: { __typename: 'IssueComment', id: idArg, isMinimized: true, minimizedReason: 'OUTDATED' } } },
  }));
} else {
  process.stdout.write(JSON.stringify({
    data: { node: { __typename: 'IssueComment', url: 'https://example.invalid/' + idArg, isMinimized: false, minimizedReason: null, viewerCanMinimize: true, author: { login: 'trusted-bot' } } },
  }));
}
`;

test('runAuthoringMarkerSweep classifies both families independently per issue and minimizes exactly the eligible candidates', () => {
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_t0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'), // eligible
    comment('IC_t1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot', true), // already-minimized
    comment('IC_t2', ownerMarker('release', 'owner-1'), 'untrusted-user'), // untrusted
    comment('IC_t3', 'just some prose, not a marker at all', 'trusted-bot'), // non-canonical
    comment('IC_t4', ownerMarker('release-guard', 'owner-1'), 'trusted-bot'), // newest trusted -> protected
  ];
  const journalComments: SweepGraphqlComment[] = [
    comment('IC_j0', intentMarker('pending', 'none'), 'trusted-bot'), // eligible
    comment('IC_j1', intentMarker('member', '2935'), 'trusted-bot'), // newest trusted -> protected
  ];

  const fetchIssueComments = (
    owner: string,
    repo: string,
    issueNumber: number,
  ): SweepGraphqlComment[] => {
    assert.equal(owner, 'kurone-kito');
    assert.equal(repo, 'idd-skill');
    if (issueNumber === 100) {
      return targetComments;
    }
    if (issueNumber === 200) {
      return journalComments;
    }
    throw new Error(`unexpected issue ${issueNumber}`);
  };

  const restore = stubExecutable('gh', GH_MINIMIZE_STUB);
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100, 200],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: true,
      },
      { fetchIssueComments, minimize: runMinimize },
    );

    assert.equal(computeSweepExitCode(report), 0);
    assert.equal(report.mode, 'apply');
    assert.deepEqual(
      report.issues.map((entry) => ({
        issue: entry.issue,
        commentCount: entry.commentCount,
        nonCanonical: entry.nonCanonical,
        error: entry.error,
      })),
      [
        { issue: 100, commentCount: 5, nonCanonical: 1, error: undefined },
        { issue: 200, commentCount: 2, nonCanonical: 0, error: undefined },
      ],
    );

    const owner = report.families['authoring-owner'];
    assert.equal(owner.scanned, 4);
    assert.equal(owner.untrusted, 1);
    assert.equal(owner.protectedNewest, 1);
    assert.equal(owner.alreadyMinimized, 1);
    assert.equal(owner.eligible, 1);
    assert.equal(owner.minimized, 1);
    assert.equal(owner.raceAlreadyMinimized, 0);
    assert.equal(owner.deadlineSkipped, 0);
    assert.equal(owner.failed, 0);

    const intent = report.families['authoring-publication-intent'];
    assert.equal(intent.scanned, 2);
    assert.equal(intent.untrusted, 0);
    assert.equal(intent.protectedNewest, 1);
    assert.equal(intent.alreadyMinimized, 0);
    assert.equal(intent.eligible, 1);
    assert.equal(intent.minimized, 1);
    assert.equal(intent.failed, 0);
  } finally {
    restore();
  }
});

test('runAuthoringMarkerSweep treats a drifted (non-byte-exact) marker body as non-canonical, never counting or submitting it', () => {
  const drifted = `${ownerMarker('acquire', 'owner-1')} `; // trailing space breaks the byte-exact re-render match
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_r0', drifted, 'trusted-bot'),
    comment('IC_r1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot'),
  ];
  const restore = stubExecutable('gh', 'process.exit(1);\n');
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: true,
      },
      { fetchIssueComments: () => targetComments, minimize: runMinimize },
    );
    assert.equal(report.issues[0].nonCanonical, 1);
    // Only one real owner-family match (IC_r1) -- fewer than two, so
    // nothing is "superseded" and nothing is submitted; the drifted
    // comment is never even a candidate.
    assert.equal(report.families['authoring-owner'].scanned, 1);
    assert.equal(report.families['authoring-owner'].eligible, 0);
    assert.equal(report.items.length, 0);
    assert.equal(computeSweepExitCode(report), 0);
  } finally {
    restore();
  }
});

test('runAuthoringMarkerSweep skips the mutation entirely once the deadline is already spent before it, marking every eligible candidate deadlineSkipped', () => {
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_e0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'),
    comment('IC_e1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot'),
  ];
  // gh must never be invoked here: a stub that exits non-zero proves the
  // mutation call never happened (the deadline is checked BEFORE calling
  // deps.minimize, not left to runMinimize's own index-0 exemption).
  const restore = stubExecutable('gh', 'process.exit(1);\n');
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: true,
        deadlineMs: 10,
      },
      {
        // Busy-wait past the 10ms budget before returning, so the
        // post-fetch `remaining()` check before the mutation stage is
        // deterministically negative, without relying on flaky real gh
        // latency.
        fetchIssueComments: () => {
          const until = Date.now() + 30;
          while (Date.now() < until) {
            // busy-wait
          }
          return targetComments;
        },
        minimize: runMinimize,
      },
    );
    assert.equal(report.issues[0].error, undefined);
    const owner = report.families['authoring-owner'];
    assert.equal(owner.eligible, 1);
    assert.equal(owner.deadlineSkipped, 1);
    assert.equal(owner.minimized, 0);
    assert.equal(owner.failed, 0);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].status, 'skipped');
    assert.equal(report.items[0].reason, 'deadline-exceeded');
  } finally {
    restore();
  }
});

test('runAuthoringMarkerSweep dry run (apply omitted) still reports a would-be minimize count without mutating', () => {
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_d0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'),
    comment('IC_d1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot'),
  ];
  const restore = stubExecutable('gh', GH_MINIMIZE_STUB);
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: false,
      },
      {
        fetchIssueComments: () => targetComments,
        minimize: runMinimize,
      },
    );
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.families['authoring-owner'].eligible, 1);
    assert.equal(report.families['authoring-owner'].minimized, 1);
    assert.equal(computeSweepExitCode(report), 0);
  } finally {
    restore();
  }
});

test('runAuthoringMarkerSweep records a fetch failure for one issue without aborting the others', () => {
  const otherComments: SweepGraphqlComment[] = [
    comment('IC_o0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'),
  ];
  const report = runAuthoringMarkerSweep(
    {
      owner: 'kurone-kito',
      repo: 'idd-skill',
      issues: [100, 200],
      markerPrefix: MARKER_PREFIX,
      classifier: 'OUTDATED',
      trustedSet: new Set(['trusted-bot']),
      apply: true,
    },
    {
      fetchIssueComments: (_owner, _repo, issueNumber) => {
        if (issueNumber === 100) {
          throw new Error('gh-graphql-error: boom');
        }
        return otherComments;
      },
      minimize: runMinimize,
    },
  );
  assert.equal(report.issues[0].error, 'gh-graphql-error: boom');
  assert.equal(report.issues[1].error, undefined);
  assert.equal(computeSweepExitCode(report), 1);
});

test('computeSweepExitCode returns 0 for a clean report with no candidates', () => {
  const clean = runAuthoringMarkerSweep(
    {
      owner: 'o',
      repo: 'r',
      issues: [1],
      markerPrefix: MARKER_PREFIX,
      classifier: 'OUTDATED',
      trustedSet: new Set(['trusted-bot']),
      apply: true,
    },
    {
      fetchIssueComments: () => [],
      minimize: runMinimize,
    },
  );
  assert.equal(computeSweepExitCode(clean), 0);
});

test('computeSweepExitCode returns 1 when the mutation genuinely fails for a candidate, but a non-failure skip alone stays 0', () => {
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_f0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'),
    comment('IC_f1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot'),
  ];
  // Probe succeeds normally (trusted, minimizable, not yet minimized), but
  // the minimizeComment mutation itself returns a GraphQL error -- a
  // genuine `status: "failed"` from runMinimize, distinct from every
  // other skip reason this sweep's own pre-filter can still let through
  // to runMinimize (viewer-cannot-minimize, unsupported-type,
  // untrusted-author), none of which should ever flip the exit code.
  const restore = stubExecutable(
    'gh',
    `
const argv = process.argv.slice(2);
const queryArg = argv.find((a) => a.startsWith('query=')) || '';
const idArg = (argv.find((a) => a.startsWith('id=')) || '').slice(3);
if (queryArg.includes('minimizeComment')) {
  process.stdout.write(JSON.stringify({ errors: [{ message: 'boom' }] }));
} else {
  process.stdout.write(JSON.stringify({
    data: { node: { __typename: 'IssueComment', url: 'https://example.invalid/' + idArg, isMinimized: false, minimizedReason: null, viewerCanMinimize: true, author: { login: 'trusted-bot' } } },
  }));
}
`,
  );
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: true,
      },
      { fetchIssueComments: () => targetComments, minimize: runMinimize },
    );
    assert.equal(report.families['authoring-owner'].failed, 1);
    assert.equal(report.families['authoring-owner'].skippedOther, 0);
    assert.equal(report.items[0].status, 'failed');
    assert.equal(computeSweepExitCode(report), 1);
  } finally {
    restore();
  }
});

test('a live re-probe skip (viewer-cannot-minimize) counts as skippedOther, not failed, and never flips the exit code', () => {
  const targetComments: SweepGraphqlComment[] = [
    comment('IC_s0', ownerMarker('acquire', 'owner-1'), 'trusted-bot'),
    comment('IC_s1', ownerMarker('heartbeat', 'owner-1'), 'trusted-bot'),
  ];
  const restore = stubExecutable(
    'gh',
    `
process.stdout.write(JSON.stringify({
  data: { node: { __typename: 'IssueComment', url: 'https://example.invalid/x', isMinimized: false, minimizedReason: null, viewerCanMinimize: false, author: { login: 'trusted-bot' } } },
}));
`,
  );
  try {
    const report = runAuthoringMarkerSweep(
      {
        owner: 'kurone-kito',
        repo: 'idd-skill',
        issues: [100],
        markerPrefix: MARKER_PREFIX,
        classifier: 'OUTDATED',
        trustedSet: new Set(['trusted-bot']),
        apply: true,
      },
      { fetchIssueComments: () => targetComments, minimize: runMinimize },
    );
    assert.equal(report.families['authoring-owner'].skippedOther, 1);
    assert.equal(report.families['authoring-owner'].failed, 0);
    assert.equal(report.items[0].status, 'skipped');
    assert.equal(report.items[0].reason, 'viewer-cannot-minimize');
    assert.equal(computeSweepExitCode(report), 0);
  } finally {
    restore();
  }
});

test('fetchIssueCommentsGraphql walks every page and selects isMinimized', () => {
  const restore = stubExecutable(
    'gh',
    `
const argv = process.argv.slice(2);
const hasCursor = argv.some((a) => a.startsWith('cursor='));
if (!hasCursor) {
  process.stdout.write(JSON.stringify({
    data: { repository: { issue: { comments: {
      nodes: [{ id: 'IC_p0', url: 'https://x/0', body: 'body-0', isMinimized: false, author: { login: 'a' } }],
      pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
    } } } },
  }));
} else {
  process.stdout.write(JSON.stringify({
    data: { repository: { issue: { comments: {
      nodes: [{ id: 'IC_p1', url: 'https://x/1', body: 'body-1', isMinimized: true, author: { login: 'b' } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } },
  }));
}
`,
  );
  try {
    const result = fetchIssueCommentsGraphql(
      'kurone-kito',
      'idd-skill',
      100,
      undefined,
    );
    assert.deepEqual(result, [
      {
        nodeId: 'IC_p0',
        url: 'https://x/0',
        body: 'body-0',
        authorLogin: 'a',
        isMinimized: false,
      },
      {
        nodeId: 'IC_p1',
        url: 'https://x/1',
        body: 'body-1',
        authorLogin: 'b',
        isMinimized: true,
      },
    ]);
  } finally {
    restore();
  }
});

test('fetchIssueCommentsGraphql throws a clear error when the number is not an issue', () => {
  const restore = stubExecutable(
    'gh',
    `process.stdout.write(JSON.stringify({ data: { repository: { issue: null } } }));`,
  );
  try {
    assert.throws(
      () =>
        fetchIssueCommentsGraphql('kurone-kito', 'idd-skill', 999, undefined),
      /is not an issue or does not exist/,
    );
  } finally {
    restore();
  }
});

test('fetchIssueCommentsGraphql bails before any gh call once the deadline is already exhausted', () => {
  const restore = stubExecutable('gh', 'process.exit(1);\n');
  try {
    assert.throws(
      () => fetchIssueCommentsGraphql('kurone-kito', 'idd-skill', 100, 0),
      /deadline exceeded/,
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Runs the CLI from a fresh, empty sandbox directory (never this repo's
// own working directory): this repository's real `.github/idd/config.json`
// configures a real `trustedMarkerActors` list, which would otherwise let
// a CLI-parse-error test silently pass validation and go on to attempt a
// real, uncontrolled `gh` network call against the live repository --
// exactly the failure `tests/minimize-superseded-markers.test.mts`'s own
// "config-only resolution" test isolates against the same way.
function runCli(args: string[]): SpawnSyncReturns<string> {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-sweep-authoring-'));
  try {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('--help exits 0 and documents every flag the contract worked examples use', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const flag of [
    '--issue',
    '--owner',
    '--repo',
    '--marker-prefix',
    '--classifier',
    '--trusted-marker-logins',
    '--apply',
    '--format',
    '--deadline-ms',
  ]) {
    assert.match(result.stdout, new RegExp(flag.replace('-', '\\-')));
  }
});

test('an omitted --issue is rejected by name', () => {
  const result = runCli([
    '--trusted-marker-logins',
    'kurone-kito',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
  ]);
  assert.equal(result.status, 2);
  assert.equal(
    result.stderr.trim(),
    'error: --issue must be supplied at least once',
  );
});

test('a missing trusted-marker-logins source is rejected with no --allow-untrusted escape hatch', () => {
  const result = runCli([
    '--issue',
    '1',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no trusted marker logins supplied/);
});

test('an invalid --classifier is rejected before any network call', () => {
  const result = runCli([
    '--issue',
    '1',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--trusted-marker-logins',
    'kurone-kito',
    '--classifier',
    'BOGUS',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--classifier must be one of/);
});
