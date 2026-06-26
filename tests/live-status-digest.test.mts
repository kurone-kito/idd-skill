import assert from 'node:assert/strict';
import { test } from 'node:test';
// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind isCliExecution(); previously the import parsed
// process.argv and called process.exit, aborting the test process.
import {
  __resetTrustedMarkerCachesForTest,
  configuredTrustedMarkerAuthors,
  isTrustedMarkerAuthor,
  trustCollaboratorMarkers,
} from '../src/scripts/live-status-digest.mts';
import {
  applyDigestUpsert,
  findLiveStatusDigestComments,
  LIVE_STATUS_DIGEST_MARKER,
  planLiveStatusDigestUpsert,
  renderLiveStatusDigest,
  resolveTrustedMarkerActors,
} from '../src/scripts/protocol-helpers.mts';

const fields = {
  phase: 'B2 planned',
  claim: 'codex-cli / claim-1',
  branch: 'issue/198-live-status-digest-helper',
  lastChecked: '2026-05-10T16:20:00Z',
  openBlockers: 'none',
  nextAction: 'B3 implement',
  authoritativeBy: 'verified claim claim-1',
};

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
// CLI behind isCliExecution().
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
