import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type CollaboratorPermissionCache,
  isAuthorizedForcedHandoffActor,
} from '../src/scripts/collaborator-permission.mts';
// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main`; previously the import
// parsed process.argv and called process.exit, aborting the test process.
import {
  __resetTrustedMarkerCachesForTest,
  configuredTrustedMarkerAuthors,
  isTrustedMarkerAuthor,
  trustCollaboratorMarkers,
} from '../src/scripts/live-status-digest.mts';
import {
  applyDigestUpsert,
  compareLiveStatusDigestSnapshot,
  createLiveStatusDigestSnapshot,
  findLiveStatusDigestComments,
  LIVE_STATUS_DIGEST_HISTORICAL_MARKER,
  LIVE_STATUS_DIGEST_MARKER,
  planLiveStatusDigestRepair,
  planLiveStatusDigestUpsert,
  renderLiveStatusDigest,
  renderLiveStatusDigestRepairEvidence,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  retireLiveStatusDigestBody,
  summarizeClaimValidation,
} from '../src/scripts/protocol-helpers.mts';
import { stubExecutable } from './test-utils.mts';

const fields = {
  phase: 'B2 planned',
  claim: 'codex-cli / claim-1',
  branch: 'issue/198-live-status-digest-helper',
  lastChecked: '2026-05-10T16:20:00Z',
  openBlockers: 'none',
  nextAction: 'B3 implement',
  authoritativeBy: 'verified claim claim-1',
};

function currentDigestComment(id: number, phase = fields.phase) {
  return {
    id,
    body: renderLiveStatusDigest({ ...fields, phase }),
  };
}

test('discovers only current live status digest comments', () => {
  const comments = [
    {
      id: 1,
      body: `${LIVE_STATUS_DIGEST_MARKER}\n\n| Field | Value |`,
    },
    {
      id: 2,
      body: ` ${LIVE_STATUS_DIGEST_MARKER}\n\nnot first-column marker`,
    },
    {
      id: 3,
      body: '<!-- claimed-by: codex-cli claim-1 supersedes: none 2026-05-10T16:00:00Z branch: issue/example -->',
    },
  ];

  assert.deepEqual(
    findLiveStatusDigestComments(comments).map((comment) => comment.id),
    [1],
  );
});

test('plans creation when no digest exists', () => {
  const plan = planLiveStatusDigestUpsert([], fields);

  assert.equal(plan.action, 'create');
  assert.equal(plan.canApply, true);
  assert.equal(plan.body, renderLiveStatusDigest(fields));
});

test('plans update for the single current digest', () => {
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: 'https://github.example/comment/101',
        body: renderLiveStatusDigest({ ...fields, phase: 'A5 claimed' }),
      },
    ],
    fields,
  );

  assert.equal(plan.action, 'update');
  assert.equal(plan.commentId, 101);
  assert.equal(plan.url, 'https://github.example/comment/101');
});

test('refuses duplicate current digests and reports repair context', () => {
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: 'https://github.example/comment/101',
        body: renderLiveStatusDigest({ ...fields, phase: 'A5 claimed' }),
      },
      {
        id: 102,
        html_url: 'https://github.example/comment/102',
        body: renderLiveStatusDigest({ ...fields, phase: 'B2 planned' }),
      },
    ],
    fields,
  );

  assert.equal(plan.action, 'duplicate');
  assert.equal(plan.canApply, false);
  assert.equal(plan.body, null);
  assert.deepEqual(
    plan.duplicates.map((comment) => comment.url),
    [
      'https://github.example/comment/101',
      'https://github.example/comment/102',
    ],
  );
  assert.match(plan.repairPath, /Do not delete or minimize/);
});

test('duplicate repair rejects zero or one current digest', () => {
  const noDigest = planLiveStatusDigestRepair({
    comments: [],
    targetState: 'open',
    retainedCommentId: '101',
  });
  assert.equal(noDigest.action, 'invalid');
  assert.equal(noDigest.reason, 'duplicate-set-too-small');

  const oneDigest = planLiveStatusDigestRepair({
    comments: [currentDigestComment(101)],
    targetState: 'open',
    retainedCommentId: '101',
  });
  assert.equal(oneDigest.action, 'invalid');
  assert.equal(oneDigest.reason, 'duplicate-set-too-small');
});

test('duplicate repair requires an explicit retained current digest', () => {
  const plan = planLiveStatusDigestRepair({
    comments: [currentDigestComment(101), currentDigestComment(102)],
    targetState: 'open',
    retainedCommentId: '999',
  });

  assert.equal(plan.action, 'invalid');
  assert.equal(plan.canApply, false);
  assert.equal(plan.reason, 'retained-comment-is-not-current');
});

test('duplicate repair plans historical retirement while preserving content', () => {
  const comments = [
    currentDigestComment(101, 'retained'),
    {
      ...currentDigestComment(102, 'retired'),
      body: `${renderLiveStatusDigest({ ...fields, phase: 'retired' })}\nextra audit detail`,
    },
  ];
  const plan = planLiveStatusDigestRepair({
    comments,
    targetState: 'open',
    retainedCommentId: '101',
  });

  assert.equal(plan.action, 'ready');
  assert.equal(plan.canApply, true);
  assert.equal(plan.retainedCommentId, '101');
  assert.deepEqual(
    plan.retirements.map((retirement) => retirement.id),
    ['102'],
  );
  assert.match(
    plan.retirements[0].retiredBody,
    /^<!-- idd-live-status: historical -->/,
  );
  assert.equal(
    plan.retirements[0].retiredBody.slice(
      LIVE_STATUS_DIGEST_HISTORICAL_MARKER.length,
    ),
    plan.retirements[0].originalBody.slice(LIVE_STATUS_DIGEST_MARKER.length),
  );
  assert.equal(
    retireLiveStatusDigestBody(plan.retirements[0].originalBody),
    plan.retirements[0].retiredBody,
  );
});

test('duplicate repair detects body, target-state, and digest-set drift', () => {
  const comments = [currentDigestComment(101), currentDigestComment(102)];
  const snapshot = createLiveStatusDigestSnapshot(comments, 'open');

  assert.equal(
    compareLiveStatusDigestSnapshot(
      comments,
      'open',
      snapshot.entries.map((entry) => entry.id),
      snapshot.sha256,
    ).matches,
    true,
  );
  assert.equal(
    compareLiveStatusDigestSnapshot(
      [currentDigestComment(101, 'changed'), currentDigestComment(102)],
      'open',
      snapshot.entries.map((entry) => entry.id),
      snapshot.sha256,
    ).reason,
    'snapshot-drift',
  );
  assert.equal(
    compareLiveStatusDigestSnapshot(
      [currentDigestComment(101)],
      'open',
      snapshot.entries.map((entry) => entry.id),
      snapshot.sha256,
    ).reason,
    'digest-set-drift',
  );
  assert.equal(
    compareLiveStatusDigestSnapshot(
      comments,
      'closed',
      snapshot.entries.map((entry) => entry.id),
      snapshot.sha256,
    ).reason,
    'snapshot-drift',
  );
});

test('duplicate repair evidence records actor, entries, and target snapshots', () => {
  const comments = [currentDigestComment(101), currentDigestComment(102)];
  const preflight = createLiveStatusDigestSnapshot(comments, 'open');
  const postflight = createLiveStatusDigestSnapshot(
    [currentDigestComment(101)],
    'open',
  );
  const evidence = renderLiveStatusDigestRepairEvidence({
    target: 'issue #3158',
    status: 'complete',
    actor: 'maintainer',
    retainedCommentId: '101',
    retiredCommentIds: ['102'],
    preflight,
    postflight,
  });

  assert.match(evidence, /idd-live-status-repair: v1/);
  assert.match(evidence, /maintainer/);
  assert.match(evidence, /101/);
  assert.match(evidence, /102/);
  assert.match(evidence, new RegExp(preflight.sha256));
  assert.match(evidence, new RegExp(postflight.sha256));
  for (const [label, snapshot] of [
    ['Pre-repair digest entries', preflight],
    ['Post-repair digest entries', postflight],
  ] as const) {
    const renderedEntries = snapshot.entries
      .map((entry) => `${entry.id}:${entry.bodySha256}`)
      .join(', ');
    assert.ok(evidence.includes(`| ${label} | ${renderedEntries} |`));
  }
});

test('duplicate repair authorization rejects untrusted write actors', () => {
  const cache: CollaboratorPermissionCache = new Map([
    ['owner/repo:contributor', { permission: 'write', roleName: 'write' }],
    ['owner/repo:maintainer', { permission: 'write', roleName: 'maintain' }],
  ]);

  assert.equal(
    isAuthorizedForcedHandoffActor(
      'owner',
      'repo',
      'contributor',
      'owners-and-maintainers-only',
      cache,
    ),
    false,
  );
  assert.equal(
    isAuthorizedForcedHandoffActor(
      'owner',
      'repo',
      'maintainer',
      'owners-and-maintainers-only',
      cache,
    ),
    true,
  );
});

test('duplicate repair CLI keeps dry-run read-only and applies the selected snapshot', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-live-status-repair-cli-'));
  const statePath = join(tempRoot, 'state.json');
  const logPath = join(tempRoot, 'gh-args.jsonl');
  const bomPrefixedRetirement = currentDigestComment(102);
  const initialComments = [
    currentDigestComment(101),
    { ...bomPrefixedRetirement, body: `\uFEFF${bomPrefixedRetirement.body}` },
  ];
  writeFileSync(
    statePath,
    JSON.stringify({
      comments: initialComments,
      mutations: 0,
      evidence: 0,
      conditionalUpdates: 0,
      failAfterMutation: false,
      invalidTargetState: false,
      viewer: 'maintainer',
    }),
  );
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const apiArgs = args.slice(1);
const methodIndex = apiArgs.indexOf('-X');
const method = methodIndex >= 0 ? apiArgs[methodIndex + 1] : 'GET';
const bodyArgument = apiArgs.find((value) => value.startsWith('body='));
const requestBody = apiArgs.includes('--input')
  ? JSON.parse(fs.readFileSync(0, 'utf8')).body
  : bodyArgument?.slice('body='.length);
const ifMatch = apiArgs.find((value) => value.startsWith('If-Match:'));
const path = apiArgs.find((value) => value.startsWith('repos/')) ?? apiArgs[0];
if (apiArgs[0] === 'user') {
  process.stdout.write(state.viewer);
} else if (path.endsWith('/collaborators/maintainer/permission')) {
  process.stdout.write(JSON.stringify({ permission: 'write', role_name: 'maintain' }));
} else if (path.endsWith('/collaborators/contributor/permission')) {
  process.stdout.write(JSON.stringify({ permission: 'write', role_name: 'write' }));
} else if (apiArgs.includes('--include') && path.includes('/issues/comments/')) {
  const id = path.split('/').at(-1);
  const comment = state.comments.find((item) => String(item.id) === id);
  if (!comment) process.exit(1);
  process.stdout.write('HTTP/2.0 200 OK\\nEtag: "etag-' + id + '"\\n\\n' + JSON.stringify(comment));
} else if (method === 'PATCH' && path.includes('/issues/comments/')) {
  const id = path.split('/').at(-1);
  const comment = state.comments.find((item) => String(item.id) === id);
  if (!comment || requestBody === undefined || !ifMatch) process.exit(1);
  comment.body = requestBody;
  state.mutations += 1;
  state.conditionalUpdates += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.patchResponseLost) process.exit(1);
  process.stdout.write(JSON.stringify(comment));
} else if (method === 'POST' && path.endsWith('/comments')) {
  const evidenceId = 900 + state.evidence + 1;
  state.evidence += 1;
  state.comments.push({ id: evidenceId, body: requestBody });
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.evidenceResponseLost) process.exit(1);
  process.stdout.write(JSON.stringify({ id: evidenceId }));
} else if (apiArgs.includes('--paginate')) {
  if (state.failAfterMutation && state.mutations > 0) process.exit(1);
  for (const comment of state.comments) process.stdout.write(JSON.stringify(comment) + '\\n');
} else if (path.endsWith('/issues/123')) {
  process.stdout.write(
    state.invalidTargetState
      ? '{}'
      : JSON.stringify({ state: 'open', state_reason: null }),
  );
} else {
  process.exit(1);
}
`,
  );
  try {
    const cliPath = join(REPO_ROOT, 'scripts/live-status-digest.mjs');
    const baseArgs = [
      cliPath,
      '--repo',
      'owner/repo',
      '--issue',
      '123',
      '--repair-duplicate',
      '--retain-comment-id',
      '101',
      '--format',
      'json',
    ];
    const dryRun = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, '--dry-run'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as {
      repair: {
        preflight: { entries: { id: string }[]; sha256: string };
      };
    };
    const afterDryRun = JSON.parse(readFileSync(statePath, 'utf8')) as {
      comments: { id: number; body: string }[];
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterDryRun.mutations, 0);
    assert.equal(afterDryRun.evidence, 0);
    assert.equal(afterDryRun.comments.length, 2);

    const applyArgs = [
      '--apply',
      '--expected-current-digest-ids',
      dryRun.repair.preflight.entries.map((entry) => entry.id).join(','),
      '--expected-current-digest-sha256',
      dryRun.repair.preflight.sha256,
    ];

    const driftedState = JSON.parse(readFileSync(statePath, 'utf8')) as {
      comments: { id: number; body: string }[];
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
      failAfterMutation: boolean;
      invalidTargetState: boolean;
      viewer: string;
    };
    driftedState.comments[0].body += '\\nchanged after dry-run';
    writeFileSync(statePath, JSON.stringify(driftedState));
    assert.throws(
      () =>
        execFileSync(process.execPath, [...baseArgs, ...applyArgs], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      (error: unknown) => {
        const report = JSON.parse(
          String((error as { stdout?: string | Buffer }).stdout ?? ''),
        ) as { action: string; repair: { recoveryHold: string } };
        assert.equal(report.action, 'repair-drift');
        assert.equal(report.repair.recoveryHold, 'snapshot-drift');
        return true;
      },
    );
    const afterDrift = JSON.parse(readFileSync(statePath, 'utf8')) as {
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterDrift.mutations, 0);
    assert.equal(afterDrift.evidence, 0);
    assert.equal(afterDrift.conditionalUpdates, 0);

    writeFileSync(
      statePath,
      JSON.stringify({
        comments: initialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: false,
        invalidTargetState: true,
        viewer: 'maintainer',
      }),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [...baseArgs, ...applyArgs], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      (error: unknown) => {
        const report = JSON.parse(
          String((error as { stdout?: string | Buffer }).stdout ?? ''),
        ) as { action: string; repair: { recoveryHold: string } };
        assert.equal(report.action, 'repair-recovery-hold');
        assert.match(
          report.repair.recoveryHold,
          /missing required target-state/,
        );
        return true;
      },
    );
    const afterInvalidTarget = JSON.parse(readFileSync(statePath, 'utf8')) as {
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterInvalidTarget.mutations, 0);
    assert.equal(afterInvalidTarget.evidence, 0);
    assert.equal(afterInvalidTarget.conditionalUpdates, 0);

    writeFileSync(
      statePath,
      JSON.stringify({
        comments: initialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: false,
        invalidTargetState: false,
        viewer: 'contributor',
      }),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [...baseArgs, ...applyArgs], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      (error: unknown) => {
        const report = JSON.parse(
          String((error as { stdout?: string | Buffer }).stdout ?? ''),
        ) as { action: string; repair: { recoveryHold: string } };
        assert.equal(report.action, 'repair-recovery-hold');
        assert.match(report.repair.recoveryHold, /authorization failed/);
        return true;
      },
    );
    const afterUnauthorized = JSON.parse(readFileSync(statePath, 'utf8')) as {
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterUnauthorized.mutations, 0);
    assert.equal(afterUnauthorized.evidence, 0);
    assert.equal(afterUnauthorized.conditionalUpdates, 0);

    writeFileSync(
      statePath,
      JSON.stringify({
        comments: initialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: false,
        invalidTargetState: false,
        viewer: 'maintainer',
      }),
    );

    const applied = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, ...applyArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as {
      action: string;
      repair: { retiredCommentIds: string[]; evidenceCommentId: number };
    };
    assert.equal(applied.action, 'repair-complete');
    assert.deepEqual(applied.repair.retiredCommentIds, ['102']);
    assert.equal(applied.repair.evidenceCommentId, 901);

    const afterApply = JSON.parse(readFileSync(statePath, 'utf8')) as {
      comments: { id: number; body: string }[];
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterApply.mutations, 1);
    assert.equal(afterApply.evidence, 1);
    assert.equal(afterApply.conditionalUpdates, 1);
    assert.match(afterApply.comments[1].body, /idd-live-status: historical/);
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some(
        (args) =>
          args.includes('-X') && args[args.indexOf('-X') + 1] === 'PATCH',
      ),
      true,
    );

    writeFileSync(
      statePath,
      JSON.stringify({
        comments: initialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: false,
        patchResponseLost: true,
        evidenceResponseLost: false,
        invalidTargetState: false,
        viewer: 'maintainer',
      }),
    );
    const ambiguousPatchDryRun = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, '--dry-run'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as {
      repair: { preflight: { entries: { id: string }[]; sha256: string } };
    };
    const ambiguousPatchArgs = [
      '--apply',
      '--expected-current-digest-ids',
      ambiguousPatchDryRun.repair.preflight.entries
        .map((entry) => entry.id)
        .join(','),
      '--expected-current-digest-sha256',
      ambiguousPatchDryRun.repair.preflight.sha256,
    ];
    assert.throws(
      () =>
        execFileSync(process.execPath, [...baseArgs, ...ambiguousPatchArgs], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      (error: unknown) => {
        const report = JSON.parse(
          String((error as { stdout?: string | Buffer }).stdout ?? ''),
        ) as {
          action: string;
          repair: { retiredCommentIds: string[]; evidenceCommentId: number };
        };
        assert.equal(report.action, 'repair-recovery-hold');
        assert.deepEqual(report.repair.retiredCommentIds, ['102']);
        assert.equal(report.repair.evidenceCommentId, 901);
        return true;
      },
    );
    const afterAmbiguousPatch = JSON.parse(readFileSync(statePath, 'utf8')) as {
      comments: { id: number; body: string }[];
      mutations: number;
      evidence: number;
    };
    assert.equal(afterAmbiguousPatch.mutations, 1);
    assert.equal(afterAmbiguousPatch.evidence, 1);
    assert.match(
      afterAmbiguousPatch.comments[1].body,
      /idd-live-status: historical/,
    );

    writeFileSync(
      statePath,
      JSON.stringify({
        comments: initialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: false,
        patchResponseLost: false,
        evidenceResponseLost: true,
        invalidTargetState: false,
        viewer: 'maintainer',
      }),
    );
    const ambiguousEvidenceDryRun = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, '--dry-run'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as {
      repair: { preflight: { entries: { id: string }[]; sha256: string } };
    };
    const ambiguousEvidenceArgs = [
      '--apply',
      '--expected-current-digest-ids',
      ambiguousEvidenceDryRun.repair.preflight.entries
        .map((entry) => entry.id)
        .join(','),
      '--expected-current-digest-sha256',
      ambiguousEvidenceDryRun.repair.preflight.sha256,
    ];
    const reconciledEvidence = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, ...ambiguousEvidenceArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as { action: string; repair: { evidenceCommentId: number } };
    assert.equal(reconciledEvidence.action, 'repair-complete');
    assert.equal(reconciledEvidence.repair.evidenceCommentId, 901);
    const afterAmbiguousEvidence = JSON.parse(
      readFileSync(statePath, 'utf8'),
    ) as { evidence: number; comments: { id: number; body: string }[] };
    assert.equal(afterAmbiguousEvidence.evidence, 1);
    assert.equal(afterAmbiguousEvidence.comments.length, 3);

    const partialComments = [
      currentDigestComment(101),
      currentDigestComment(102),
      currentDigestComment(103),
    ];
    writeFileSync(
      statePath,
      JSON.stringify({
        comments: partialComments,
        mutations: 0,
        evidence: 0,
        conditionalUpdates: 0,
        failAfterMutation: true,
        invalidTargetState: false,
        viewer: 'maintainer',
      }),
    );
    const partialDryRun = JSON.parse(
      execFileSync(process.execPath, [...baseArgs, '--dry-run'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as {
      repair: { preflight: { entries: { id: string }[]; sha256: string } };
    };
    const partialArgs = [
      '--apply',
      '--expected-current-digest-ids',
      partialDryRun.repair.preflight.entries.map((entry) => entry.id).join(','),
      '--expected-current-digest-sha256',
      partialDryRun.repair.preflight.sha256,
    ];
    assert.throws(
      () =>
        execFileSync(process.execPath, [...baseArgs, ...partialArgs], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      (error: unknown) => {
        const report = JSON.parse(
          String((error as { stdout?: string | Buffer }).stdout ?? ''),
        ) as {
          action: string;
          repair: { retiredCommentIds: string[]; evidenceCommentId: number };
        };
        assert.equal(report.action, 'repair-recovery-hold');
        assert.deepEqual(report.repair.retiredCommentIds, ['102']);
        assert.equal(report.repair.evidenceCommentId, 901);
        return true;
      },
    );
    const afterPartial = JSON.parse(readFileSync(statePath, 'utf8')) as {
      mutations: number;
      evidence: number;
      conditionalUpdates: number;
    };
    assert.equal(afterPartial.mutations, 1);
    assert.equal(afterPartial.evidence, 1);
    assert.equal(afterPartial.conditionalUpdates, 1);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('plans no-op when the current digest is already up to date', () => {
  const body = renderLiveStatusDigest(fields);
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: 'https://github.example/comment/101',
        body,
      },
    ],
    fields,
  );

  assert.equal(plan.action, 'noop');
  assert.equal(plan.commentId, 101);
  assert.equal(plan.body, body);
});

test('does not modify operational marker comments during digest operations', () => {
  const operationalMarkerComment = {
    id: 200,
    body: '<!-- claimed-by: codex-cli claim-1 supersedes: none 2026-05-10T16:00:00Z branch: example -->',
  };
  const digestComment = {
    id: 201,
    body: `${LIVE_STATUS_DIGEST_MARKER}\n\n| Field | Value |`,
  };

  const plan = planLiveStatusDigestUpsert(
    [operationalMarkerComment, digestComment],
    fields,
  );

  assert.equal(plan.action, 'update');
  assert.equal(plan.commentId, 201);
  assert.notEqual(plan.commentId, 200);
});

test('applyDigestUpsert revalidates the claim after the replan and before the mutation', () => {
  const calls: string[] = [];
  const result = applyDigestUpsert({
    skipClaimCheck: false,
    refetchAndPlan: () => {
      calls.push('replan');
      return { action: 'create', body: 'digest body', duplicates: [] };
    },
    assertClaim: () => {
      calls.push('assertClaim');
    },
    createComment: (body) => {
      calls.push(`create:${body}`);
      return { id: 42, html_url: 'https://example.test/c/42' };
    },
    updateComment: () => {
      calls.push('update');
      return {};
    },
  });
  assert.deepEqual(calls, ['replan', 'assertClaim', 'create:digest body']);
  assert.equal(result.outcome, 'created');
  assert.equal(result.commentId, 42);
  assert.equal(result.url, 'https://example.test/c/42');
});

test('applyDigestUpsert aborts the write when the claim check throws after the replan', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      applyDigestUpsert({
        skipClaimCheck: false,
        refetchAndPlan: () => {
          calls.push('replan');
          return { action: 'update', body: 'x', commentId: 7, duplicates: [] };
        },
        assertClaim: () => {
          calls.push('assertClaim');
          throw new Error('claim lost: superseded by another session');
        },
        createComment: () => {
          calls.push('create');
          return {};
        },
        updateComment: () => {
          calls.push('update');
          return {};
        },
      }),
    /claim lost/,
  );
  // The replan ran, the claim check ran and threw, and crucially NO
  // create/update mutation happened — a claim change between the replan and
  // the write aborts the apply.
  assert.deepEqual(calls, ['replan', 'assertClaim']);
});

test('applyDigestUpsert skips the claim check and mutation on a duplicate plan', () => {
  const calls: string[] = [];
  const result = applyDigestUpsert({
    skipClaimCheck: false,
    refetchAndPlan: () => ({ action: 'duplicate', body: null, duplicates: [] }),
    assertClaim: () => {
      calls.push('assertClaim');
    },
    createComment: () => {
      calls.push('create');
      return {};
    },
    updateComment: () => {
      calls.push('update');
      return {};
    },
  });
  assert.equal(result.outcome, 'duplicate');
  assert.deepEqual(calls, []);
});

// configuredTrustedMarkerAuthors() in live-status-digest.mts builds its cached
// set from new Set(resolveTrustedMarkerActors({ envValue, config }).actors),
// reading .github/idd/config.json the same way trustCollaboratorMarkers() does.
// These cases lock the env -> config ladder against synthetic config objects via
// the shared resolver, in isolation from the module's real-config read. The
// module's own configuredTrustedMarkerAuthors() is now exercised directly in the
// "Direct-import coverage" tests below, which #1120 made possible by guarding the
// CLI behind `import.meta.main` (originally `isCliExecution()`; see #1447).
function configuredTrustedMarkerSet(
  envValue: string,
  config: { trustedMarkerActors?: unknown } | null,
): Set<string> {
  return new Set(resolveTrustedMarkerActors({ envValue, config }).actors);
}

test('configured trusted-marker authors fall back to config.json trustedMarkerActors', () => {
  // No env var, but config supplies trustedMarkerActors -> use config
  // (the env -> config fallback this script previously lacked).
  const authors = configuredTrustedMarkerSet('', {
    trustedMarkerActors: ['Config-Bot', 'another-bot'],
  });
  assert.deepEqual([...authors].sort(), ['another-bot', 'config-bot']);
});

test('configured trusted-marker authors keep env winning over config', () => {
  // Env still wins when both are present (unchanged precedence).
  const authors = configuredTrustedMarkerSet('env-bot', {
    trustedMarkerActors: ['config-bot'],
  });
  assert.deepEqual([...authors], ['env-bot']);
});

test('configured trusted-marker authors are empty with neither env nor config', () => {
  assert.deepEqual([...configuredTrustedMarkerSet('', null)], []);
  assert.deepEqual(
    [...configuredTrustedMarkerSet('', { trustedMarkerActors: [] })],
    [],
  );
});

// --- Direct-import coverage of the CLI module's trusted-marker-author logic.
// These exercise paths that could not be unit-tested before #1120, because
// importing live-status-digest.mts parsed process.argv and called
// process.exit, aborting the test process. They stay hermetic (no `gh`
// subprocess) by seeding the cached current-viewer login.

function withEnv(
  vars: Record<string, string | undefined>,
  body: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('configuredTrustedMarkerAuthors resolves the env actor and caches it', () => {
  withEnv({ IDD_TRUSTED_MARKER_ACTORS: 'alpha-bot' }, () => {
    __resetTrustedMarkerCachesForTest();
    assert.deepEqual([...configuredTrustedMarkerAuthors()], ['alpha-bot']);

    // The set is cached: a later env change is ignored until the cache resets.
    process.env.IDD_TRUSTED_MARKER_ACTORS = 'beta-bot';
    assert.deepEqual([...configuredTrustedMarkerAuthors()], ['alpha-bot']);

    // After a reset the new env value is resolved.
    __resetTrustedMarkerCachesForTest();
    assert.deepEqual([...configuredTrustedMarkerAuthors()], ['beta-bot']);
  });
  __resetTrustedMarkerCachesForTest();
});

test('trustCollaboratorMarkers gates on the env flag (config has no override)', () => {
  withEnv({ IDD_TRUST_COLLABORATOR_MARKERS: 'true' }, () => {
    assert.equal(trustCollaboratorMarkers(), true);
  });
  withEnv({ IDD_TRUST_COLLABORATOR_MARKERS: undefined }, () => {
    assert.equal(trustCollaboratorMarkers(), false);
  });
});

test('isTrustedMarkerAuthor matches a configured author without touching gh', () => {
  withEnv(
    {
      IDD_TRUSTED_MARKER_ACTORS: 'configured-bot',
      IDD_TRUST_COLLABORATOR_MARKERS: undefined,
    },
    () => {
      // Seed an empty viewer login so the viewer branch never matches and no
      // `gh api user` subprocess runs.
      __resetTrustedMarkerCachesForTest({ currentViewerLogin: '' });

      // Configured-author match (case-insensitive).
      assert.equal(isTrustedMarkerAuthor('o', 'r', 'configured-bot'), true);
      assert.equal(isTrustedMarkerAuthor('o', 'r', 'Configured-Bot'), true);

      // Empty login fails closed.
      assert.equal(isTrustedMarkerAuthor('o', 'r', ''), false);

      // Not configured + collaborator-trust gate off -> false, without
      // consulting the collaborator permission API.
      assert.equal(isTrustedMarkerAuthor('o', 'r', 'random-bot'), false);
    },
  );
  __resetTrustedMarkerCachesForTest();
});

test('isTrustedMarkerAuthor matches the seeded current viewer login', () => {
  __resetTrustedMarkerCachesForTest({ currentViewerLogin: 'me-the-viewer' });
  assert.equal(isTrustedMarkerAuthor('o', 'r', 'me-the-viewer'), true);
  // Case-insensitive against the normalized viewer login.
  assert.equal(isTrustedMarkerAuthor('o', 'r', 'Me-The-Viewer'), true);
  __resetTrustedMarkerCachesForTest();
});

// --- #1437: PR-target mode was silently rejecting an issue-only
// forced-handoff successor's claim, because `prFirstCommitAt` was never
// computed or threaded into `summarizeClaimValidation` -- the Part B (#1058)
// allowance defaulted closed. `resolvePrFirstCommitAt` is the shared,
// extracted date computation (also used by `pre-merge-readiness.mts` and
// `advisory-convergence.mts`); the scenarios below exercise it directly and
// then prove the claim-resolution contract this file's `readActiveClaim` now
// participates in, entirely via injected fixtures -- no live network.

test('resolvePrFirstCommitAt: empty commit list resolves to null', () => {
  assert.equal(resolvePrFirstCommitAt([]), null);
});

test('resolvePrFirstCommitAt: a single commit resolves to its committer date', () => {
  assert.equal(
    resolvePrFirstCommitAt([
      { commit: { committer: { date: '2026-06-10T00:00:00Z' } } },
    ]),
    '2026-06-10T00:00:00Z',
  );
});

test('resolvePrFirstCommitAt: picks the earliest commit regardless of array order', () => {
  const commits = [
    { commit: { committer: { date: '2026-06-12T00:00:00Z' } } },
    { commit: { committer: { date: '2026-06-10T00:00:00Z' } } },
    { commit: { committer: { date: '2026-06-11T00:00:00Z' } } },
  ];
  assert.equal(resolvePrFirstCommitAt(commits), '2026-06-10T00:00:00Z');
});

test('resolvePrFirstCommitAt: falls back to the author date when committer date is absent', () => {
  assert.equal(
    resolvePrFirstCommitAt([
      { commit: { author: { date: '2026-06-09T00:00:00Z' } } },
    ]),
    '2026-06-09T00:00:00Z',
  );
});

test('resolvePrFirstCommitAt: skips unparseable dates instead of letting them win the minimum', () => {
  const commits = [
    { commit: { committer: { date: 'not-a-date' } } },
    { commit: { committer: { date: '2026-06-10T00:00:00Z' } } },
  ];
  assert.equal(resolvePrFirstCommitAt(commits), '2026-06-10T00:00:00Z');
});

const PR_TARGET_TRUSTED = 'kurone-kito';
const PR_TARGET_OLD_AGENT_ID = 'claude-old';
const PR_TARGET_OLD_CLAIM_ID = 'claim-old';
const PR_TARGET_NEW_AGENT_ID = 'claude-successor';
const PR_TARGET_NEW_CLAIM_ID = 'claim-successor';
const PR_TARGET_PR_FIRST_COMMIT_AT = '2026-06-10T00:00:00Z';

function prTargetClaimComment() {
  return {
    author: { login: PR_TARGET_TRUSTED },
    body: `<!-- claimed-by: ${PR_TARGET_OLD_AGENT_ID} ${PR_TARGET_OLD_CLAIM_ID} supersedes: none 2026-06-01T00:00:00Z branch: issue/1435-test -->\n\n_${PR_TARGET_OLD_AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
    createdAt: '2026-06-01T00:00:00Z',
  };
}

function prTargetForcedHandoffComment({
  contextScope = 'issue-only',
  linkedPr,
  createdAt = '2026-06-05T00:00:00Z',
}: {
  contextScope?: string;
  linkedPr?: string;
  createdAt?: string;
} = {}) {
  const payload = {
    'old-agent-id': PR_TARGET_OLD_AGENT_ID,
    'old-claim-id': PR_TARGET_OLD_CLAIM_ID,
    'new-agent-id': PR_TARGET_NEW_AGENT_ID,
    'new-claim-id': PR_TARGET_NEW_CLAIM_ID,
    branch: 'issue/1435-test',
    'forced-by': PR_TARGET_TRUSTED,
    reason: 'operator-approved-recovery',
    timestamp: createdAt,
    'context-scope': contextScope,
    ...(linkedPr ? { 'linked-pr': linkedPr } : {}),
  };
  return {
    author: { login: PR_TARGET_TRUSTED },
    body: `<!-- forced-handoff: ${JSON.stringify(payload)} -->\n\nForced handoff approved by ${PR_TARGET_TRUSTED}.`,
    createdAt,
  };
}

function summarizePrTargetClaim(options: {
  handoffComment: ReturnType<typeof prTargetForcedHandoffComment>;
  expectedLinkedPrs: string[];
  prFirstCommitAt?: string | null;
}) {
  return summarizeClaimValidation(
    [prTargetClaimComment(), options.handoffComment],
    {
      trustedMarkerLogins: [PR_TARGET_TRUSTED],
      forcedHandoffEnabled: true,
      expectedLinkedPrs: options.expectedLinkedPrs,
      prFirstCommitAt: options.prFirstCommitAt ?? null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === PR_TARGET_TRUSTED,
    },
  );
}

test('PR-target + issue-only handoff predating the PR resolves to the successor', () => {
  const summary = summarizePrTargetClaim({
    handoffComment: prTargetForcedHandoffComment(),
    expectedLinkedPrs: ['1435'],
    prFirstCommitAt: PR_TARGET_PR_FIRST_COMMIT_AT,
  });
  assert.equal(summary.activeClaimPresent, true);
  assert.equal(summary.activeClaim?.claimId, PR_TARGET_NEW_CLAIM_ID);
  assert.equal(summary.activeClaim?.agentId, PR_TARGET_NEW_AGENT_ID);
});

test('PR-target + issue-only handoff NOT predating the PR stays rejected', () => {
  const summary = summarizePrTargetClaim({
    // Handoff at 2026-06-11 is AFTER PR_TARGET_PR_FIRST_COMMIT_AT
    // (2026-06-10), so Part B does not apply -- the pre-handoff claim stays
    // active, matching today's (pre-fix) behavior for this specific input.
    handoffComment: prTargetForcedHandoffComment({
      createdAt: '2026-06-11T00:00:00Z',
    }),
    expectedLinkedPrs: ['1435'],
    prFirstCommitAt: PR_TARGET_PR_FIRST_COMMIT_AT,
  });
  assert.equal(summary.activeClaimPresent, true);
  assert.equal(summary.activeClaim?.claimId, PR_TARGET_OLD_CLAIM_ID);
  assert.equal(summary.activeClaim?.agentId, PR_TARGET_OLD_AGENT_ID);
});

test('PR-target + issue-plus-pr handoff resolves via the linked-PR match, unaffected by prFirstCommitAt', () => {
  const summary = summarizePrTargetClaim({
    handoffComment: prTargetForcedHandoffComment({
      contextScope: 'issue-plus-pr',
      linkedPr: '1435',
      createdAt: '2026-06-01T12:00:00Z',
    }),
    expectedLinkedPrs: ['1435'],
    // Deliberately null: `issue-plus-pr` accepts via the linked-PR match,
    // a path independent of the Part B predates-PR rule, so this proves
    // acceptance here does not come from prFirstCommitAt.
    prFirstCommitAt: null,
  });
  assert.equal(summary.activeClaimPresent, true);
  assert.equal(summary.activeClaim?.claimId, PR_TARGET_NEW_CLAIM_ID);
});

test('issue-target mode (no expectedLinkedPrs) honors the handoff unconditionally, unaffected by prFirstCommitAt', () => {
  const summary = summarizeClaimValidation(
    [prTargetClaimComment(), prTargetForcedHandoffComment()],
    {
      trustedMarkerLogins: [PR_TARGET_TRUSTED],
      forcedHandoffEnabled: true,
      expectedLinkedPrs: [],
      prFirstCommitAt: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === PR_TARGET_TRUSTED,
    },
  );
  assert.equal(summary.activeClaimPresent, true);
  assert.equal(summary.activeClaim?.claimId, PR_TARGET_NEW_CLAIM_ID);
});

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('--help marks every unconditionally-required digest field as required (#2492)', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/live-status-digest.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  for (const flag of [
    '--phase <text>',
    '--claim <text>',
    '--branch <text>',
    '--open-blockers <text>',
    '--next-action <text>',
    '--authoritative-by <text>',
  ]) {
    const line = output
      .split('\n')
      .find((candidate) => candidate.includes(flag));
    assert.ok(line, `--help is missing a line for ${flag}`);
    assert.match(line, /\(required\)$/);
  }
  assert.match(
    output,
    /--claim-issue <number>\s+issue carrying the active claim, required for apply mode/,
  );
});
