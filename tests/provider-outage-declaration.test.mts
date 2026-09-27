import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthorityEvidence } from '../src/scripts/external-check-waiver.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import {
  composeGateTrustedMarkerLogins,
  parseProviderOutageAdvancedComment,
  parseProviderOutageDeclarationComment,
  renderProviderOutageAdvancedComment,
  renderProviderOutageDeclarationComment,
} from '../src/scripts/protocol-helpers.mts';
import {
  type CommentLike,
  evaluateProviderOutageRelief,
  listProviderOutageAdvancements,
  parseArgs,
  renderText,
  resolveProviderOutageDeclaration,
  runProviderOutageDeclaration,
  trustedLoginsForProviderOutageAdvancements,
} from '../src/scripts/provider-outage-declaration.mts';

const NOW = new Date('2026-09-01T06:00:00Z');

function authorizedActor(): AuthorityEvidence {
  return {
    actor: 'kurone-kito',
    policy: 'owners-and-maintainers-only',
    known: true,
    authorized: true,
    isOwner: true,
    permission: 'admin',
    roleName: 'admin',
    error: '',
  };
}

function unauthorizedActor(): AuthorityEvidence {
  return {
    actor: 'mallory',
    policy: 'owners-and-maintainers-only',
    known: true,
    authorized: false,
    isOwner: false,
    permission: 'write',
    roleName: '',
    error: '',
  };
}

function declarationComment(overrides: {
  actor?: string;
  service?: string;
  startedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  authorLogin?: string;
  lastEditedAt?: string | null;
}): CommentLike {
  const body = renderProviderOutageDeclarationComment({
    actor: overrides.actor ?? 'kurone-kito',
    service: overrides.service ?? 'idd-advisory-convergence',
    startedAt: overrides.startedAt ?? '2026-09-01T05:00:00Z',
    expiresAt: overrides.expiresAt ?? '2026-09-02T05:00:00Z',
  });
  return {
    body,
    created_at:
      overrides.createdAt ?? overrides.startedAt ?? '2026-09-01T05:00:00Z',
    author: {
      login: overrides.authorLogin ?? overrides.actor ?? 'kurone-kito',
    },
    // #3249: minimized shape by default (genuinely unedited); pass
    // `lastEditedAt` to build an edited-comment fixture instead.
    last_edited_at:
      overrides.lastEditedAt === undefined ? null : overrides.lastEditedAt,
  };
}

const basePolicy = normalizePolicyConfig({
  providerOutage: { maxValidity: 'PT24H' },
});

test('renderProviderOutageDeclarationComment / parseProviderOutageDeclarationComment round-trip', () => {
  const body = renderProviderOutageDeclarationComment({
    actor: 'kurone-kito',
    service: 'idd-advisory-convergence',
    startedAt: '2026-09-01T05:00:00Z',
    expiresAt: '2026-09-02T05:00:00Z',
  });
  const parsed = parseProviderOutageDeclarationComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.ok(parsed);
  assert.equal(parsed?.actor, 'kurone-kito');
  assert.equal(parsed?.service, 'idd-advisory-convergence');
  assert.equal(parsed?.startedAt, '2026-09-01T05:00:00Z');
  assert.equal(parsed?.expiresAt, '2026-09-02T05:00:00Z');
  assert.equal(parsed?.createdAt, '2026-09-01T05:00:01Z');
});

test('renderProviderOutageDeclarationComment truncates a millisecond-precision timestamp instead of rejecting it (#2592)', () => {
  const body = renderProviderOutageDeclarationComment({
    actor: 'kurone-kito',
    service: 'idd-advisory-convergence',
    startedAt: '2026-09-01T05:00:00.123Z',
    expiresAt: '2026-09-02T05:00:00Z',
  });
  const parsed = parseProviderOutageDeclarationComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.equal(parsed?.startedAt, '2026-09-01T05:00:00Z');
});

test('renderProviderOutageDeclarationComment rejects a non-UTC-offset timestamp', () => {
  assert.throws(
    () =>
      renderProviderOutageDeclarationComment({
        actor: 'kurone-kito',
        service: 'idd-advisory-convergence',
        startedAt: '2026-09-01T05:00:00.123+09:00',
        expiresAt: '2026-09-02T05:00:00Z',
      }),
    /invalid provider outage declaration payload/,
  );
});

test('renderProviderOutageAdvancedComment truncates a millisecond-precision timestamp instead of rejecting it (#2592)', () => {
  const body = renderProviderOutageAdvancedComment({
    actor: 'kurone-kito',
    prNumber: 2345,
    headSha: 'a'.repeat(40),
    declaredAt: '2026-09-01T05:00:00.000Z',
  });
  const parsed = parseProviderOutageAdvancedComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.equal(parsed?.declaredAt, '2026-09-01T05:00:00Z');
});

test('renderProviderOutageAdvancedComment rejects a non-UTC-offset timestamp', () => {
  assert.throws(
    () =>
      renderProviderOutageAdvancedComment({
        actor: 'kurone-kito',
        prNumber: 2345,
        headSha: 'a'.repeat(40),
        declaredAt: '2026-09-01T05:00:00.123+09:00',
      }),
    /invalid provider outage advancement payload/,
  );
});

test('renderProviderOutageAdvancedComment / parseProviderOutageAdvancedComment round-trip', () => {
  const body = renderProviderOutageAdvancedComment({
    actor: 'kurone-kito',
    prNumber: 2345,
    headSha: 'a'.repeat(40),
    declaredAt: '2026-09-01T05:00:00Z',
  });
  const parsed = parseProviderOutageAdvancedComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.ok(parsed);
  assert.equal(parsed?.prNumber, 2345);
  assert.equal(parsed?.headSha, 'a'.repeat(40));
  assert.equal(parsed?.declaredAt, '2026-09-01T05:00:00Z');
});

// --- resolveProviderOutageDeclaration: the 7 acceptance-criteria cases ---

test('resolveProviderOutageDeclaration: absent-target case yields no relief with a machine-readable reason', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: false,
    comments: [],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /declarationTarget is not configured/);
  assert.equal(result.declaration, null);
});

test('resolveProviderOutageDeclaration: absent-declaration case (no matching comments)', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /no provider outage declaration found/);
});

test('resolveProviderOutageDeclaration: active case', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T05:00:00Z',
        expiresAt: '2026-09-02T05:00:00Z',
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, true);
  assert.equal(result.reason, '');
  assert.equal(result.declaration?.service, 'idd-advisory-convergence');
});

// #3249: an edited (or edit-state-unresolved) declaration must not relieve
// the gate, even from an otherwise-authorized actor whose declaration is
// otherwise fully valid.
test('resolveProviderOutageDeclaration: an edited declaration does not relieve the gate', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T05:00:00Z',
        expiresAt: '2026-09-02T05:00:00Z',
        lastEditedAt: '2026-09-01T05:30:00Z',
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.equal(result.edited.length, 1);
  assert.match(result.reason, /edited after posting/);
});

test('resolveProviderOutageDeclaration: an edit-state-unresolved declaration does not relieve the gate either', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      {
        ...declarationComment({
          startedAt: '2026-09-01T05:00:00Z',
          expiresAt: '2026-09-02T05:00:00Z',
        }),
        last_edited_at: undefined,
      },
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.equal(result.edited.length, 1);
});

test('resolveProviderOutageDeclaration: expired case', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-08-30T05:00:00Z',
        expiresAt: '2026-08-31T05:00:00Z',
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /expired/);
  assert.equal(result.expired.length, 1);
});

test('resolveProviderOutageDeclaration: a future-dated declaration is not active yet (#2320 review, Codex)', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T07:00:00Z', // after NOW (06:00:00Z)
        expiresAt: '2026-09-02T05:00:00Z',
        createdAt: '2026-09-01T05:59:00Z',
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /has not started yet/);
  assert.equal(result.notYetStarted.length, 1);
  assert.equal(result.valid.length, 0);
});

test('resolveProviderOutageDeclaration: becomes active once its own startedAt is reached (#2320 review, Codex)', () => {
  const comments = [
    declarationComment({
      startedAt: '2026-09-01T07:00:00Z',
      expiresAt: '2026-09-02T05:00:00Z',
      createdAt: '2026-09-01T05:59:00Z',
    }),
  ];
  const beforeStart = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments,
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: new Date('2026-09-01T06:59:59Z'),
  });
  const atStart = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments,
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: new Date('2026-09-01T07:00:00Z'),
  });
  assert.equal(beforeStart.active, false);
  assert.equal(atStart.active, true);
});

// #2353 (Codex review on PR #2370, round 5): `startedAt` is authored at
// `--declare` time, before the `--apply` confirmation that actually posts
// the GitHub comment `createdAt` records. A caller replaying a past `now`
// (e.g. `--now`) between those two moments must not see the declaration as
// active -- at that replayed moment, the comment recording it did not yet
// exist on GitHub, even though the declaration's own self-reported window
// had already opened.
test('resolveProviderOutageDeclaration: a declaration whose startedAt has passed but whose comment was not yet posted is not active (#2353 review, Codex, round 5)', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T05:00:00Z', // before NOW (06:00:00Z)
        expiresAt: '2026-09-02T05:00:00Z',
        createdAt: '2026-09-01T06:30:00Z', // posted after NOW
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /not yet posted/);
  assert.equal(result.notYetPosted.length, 1);
  assert.equal(result.valid.length, 0);
});

test('resolveProviderOutageDeclaration: becomes active once its own comment is posted, even with an earlier startedAt (#2353 review, Codex, round 5)', () => {
  const comments = [
    declarationComment({
      startedAt: '2026-09-01T05:00:00Z',
      expiresAt: '2026-09-02T05:00:00Z',
      createdAt: '2026-09-01T06:30:00Z',
    }),
  ];
  const beforePosted = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments,
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: new Date('2026-09-01T06:29:59Z'),
  });
  const atPosted = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments,
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: new Date('2026-09-01T06:30:00Z'),
  });
  assert.equal(beforePosted.active, false);
  assert.equal(atPosted.active, true);
});

// A `createdAt` that fails to parse (the schema-documented `'none'`
// sentinel `parseProviderOutageDeclarationComment` falls back to) must
// never withhold an otherwise-valid declaration -- mirrors
// `resolveDeclarationActiveSince`'s (pre-merge-readiness.mts) identical
// fallback-to-`startedAt`-alone convention for the same sentinel.
test('resolveProviderOutageDeclaration: an unparseable createdAt never withholds an otherwise-valid declaration', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      {
        body: renderProviderOutageDeclarationComment({
          actor: 'kurone-kito',
          service: 'idd-advisory-convergence',
          startedAt: '2026-09-01T05:00:00Z',
          expiresAt: '2026-09-02T05:00:00Z',
        }),
        created_at: undefined,
        author: { login: 'kurone-kito' },
        last_edited_at: null,
      },
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, true);
  assert.equal(result.declaration?.createdAt, 'none');
});

test('resolveProviderOutageDeclaration: malformed case', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      {
        body: '<!-- idd-provider-outage-declaration: kurone-kito service:x started:not-a-date expires:also-not-a-date -->',
        created_at: '2026-09-01T05:00:00Z',
        author: { login: 'kurone-kito' },
      },
    ],
    service: 'x',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.equal(result.malformed.length, 1);
});

test('resolveProviderOutageDeclaration: untrusted-actor case (authority not proven)', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({ actor: 'mallory', authorLogin: 'mallory' }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: unauthorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /not authorized/);
  assert.equal(result.unauthorized.length, 1);
});

test('resolveProviderOutageDeclaration: wrong-service case', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [declarationComment({ service: 'some-other-service' })],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.match(result.reason, /some-other-service/);
  assert.equal(result.wrongService.length, 1);
});

test('resolveProviderOutageDeclaration: exceeds maxValidity is rejected even from an authorized actor within its own expiry window', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-09-05T00:00:00Z', // 4 days, exceeds PT24H maxValidity
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, false);
  assert.equal(result.exceedsMaxValidity.length, 1);
});

test('resolveProviderOutageDeclaration: accepts no provider-health verdict input and an absent/unknown verdict never invalidates an otherwise-valid declaration', () => {
  // The function signature itself carries no verdict field; this proves at
  // the call site that reaching `active: true` never required one, and that
  // passing an unrelated "unknown verdict"-shaped extra field alongside the
  // real input does not change the outcome.
  const input = {
    declarationTargetConfigured: true,
    comments: [declarationComment({})],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  };
  const plain = resolveProviderOutageDeclaration(input);
  const inputWithExtraneousVerdict: Record<string, unknown> = {
    ...input,
    providerHealthVerdict: 'unknown',
  };
  const withExtraneousVerdict = resolveProviderOutageDeclaration(
    inputWithExtraneousVerdict as Parameters<
      typeof resolveProviderOutageDeclaration
    >[0],
  );
  assert.equal(plain.active, true);
  assert.deepEqual(withExtraneousVerdict, plain);
});

test('resolveProviderOutageDeclaration: picks the most recently created valid declaration when several exist', () => {
  const result = resolveProviderOutageDeclaration({
    declarationTargetConfigured: true,
    comments: [
      declarationComment({
        startedAt: '2026-09-01T04:00:00Z',
        expiresAt: '2026-09-01T20:00:00Z',
        createdAt: '2026-09-01T04:00:00Z',
      }),
      declarationComment({
        startedAt: '2026-09-01T05:30:00Z',
        expiresAt: '2026-09-01T22:00:00Z',
        createdAt: '2026-09-01T05:30:00Z',
      }),
    ],
    service: 'idd-advisory-convergence',
    policy: basePolicy,
    authorityOf: authorizedActor,
    now: NOW,
  });
  assert.equal(result.active, true);
  assert.equal(result.declaration?.startedAt, '2026-09-01T05:30:00Z');
  assert.equal(result.valid.length, 2);
});

// --- evaluateProviderOutageRelief ---

const waivable = [{ selector: 'idd-advisory-convergence', matchMode: 'exact' }];

test('evaluateProviderOutageRelief: relieves a waivable selector when the declaration is active and the PR terminal state is proven', () => {
  const result = evaluateProviderOutageRelief({
    declarationActive: true,
    prTerminalUnavailable: true,
    requestedSelector: 'idd-advisory-convergence',
    waivableSelectors: waivable,
  });
  assert.equal(result.relieved, true);
});

test('evaluateProviderOutageRelief: an active declaration alone does not relieve a PR whose own terminal state is unproven', () => {
  const result = evaluateProviderOutageRelief({
    declarationActive: true,
    prTerminalUnavailable: false,
    requestedSelector: 'idd-advisory-convergence',
    waivableSelectors: waivable,
  });
  assert.equal(result.relieved, false);
  assert.match(result.reason, /terminal advisory-unavailable state/);
});

test('evaluateProviderOutageRelief: no relief when the declaration is not active, even with a proven terminal state', () => {
  const result = evaluateProviderOutageRelief({
    declarationActive: false,
    prTerminalUnavailable: true,
    requestedSelector: 'idd-advisory-convergence',
    waivableSelectors: waivable,
  });
  assert.equal(result.relieved, false);
});

test("evaluateProviderOutageRelief: cannot relieve any selector outside ciGate.externalChecks.waivable, regardless of that check's own failing or pending conclusion", () => {
  const result = evaluateProviderOutageRelief({
    declarationActive: true,
    prTerminalUnavailable: true,
    requestedSelector: 'some-unrelated-check',
    waivableSelectors: waivable,
  });
  assert.equal(result.relieved, false);
  assert.match(result.reason, /not configured as a waivable/);
});

test('evaluateProviderOutageRelief: honors glob match mode on the waivable selector', () => {
  const result = evaluateProviderOutageRelief({
    declarationActive: true,
    prTerminalUnavailable: true,
    requestedSelector: 'idd-advisory-convergence',
    waivableSelectors: [{ selector: 'idd-*', matchMode: 'glob' }],
  });
  assert.equal(result.relieved, true);
});

// --- listProviderOutageAdvancements ---

test('listProviderOutageAdvancements: lists HEAD-pinned entries, one per push even for the same PR number', () => {
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  const comments: CommentLike[] = [
    {
      body: renderProviderOutageAdvancedComment({
        actor: 'kurone-kito',
        prNumber: 2345,
        headSha: shaA,
        declaredAt: '2026-09-01T05:00:00Z',
      }),
      created_at: '2026-09-01T05:01:00Z',
      author: { login: 'kurone-kito' },
      last_edited_at: null,
    },
    {
      body: renderProviderOutageAdvancedComment({
        actor: 'kurone-kito',
        prNumber: 2345,
        headSha: shaB,
        declaredAt: '2026-09-01T05:00:00Z',
      }),
      created_at: '2026-09-01T05:10:00Z',
      author: { login: 'kurone-kito' },
      last_edited_at: null,
    },
  ];
  const list = listProviderOutageAdvancements(comments, {
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((entry) => entry.headSha),
    [shaA, shaB],
  );
  assert.deepEqual(
    list.map((entry) => entry.prNumber),
    [2345, 2345],
  );
});

test('listProviderOutageAdvancements: excludes an entry from an untrusted author', () => {
  const comments: CommentLike[] = [
    {
      body: renderProviderOutageAdvancedComment({
        actor: 'mallory',
        prNumber: 2345,
        headSha: 'c'.repeat(40),
        declaredAt: '2026-09-01T05:00:00Z',
      }),
      created_at: '2026-09-01T05:01:00Z',
      author: { login: 'mallory' },
    },
  ];
  const list = listProviderOutageAdvancements(comments, {
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(list.length, 0);
});

// #3249: an edited (or edit-state-unresolved) advancement marker must never
// be trusted either, even from a trusted login.
test('listProviderOutageAdvancements: excludes an edited or edit-state-unresolved entry, minimized shape still honored', () => {
  const sha = 'd'.repeat(40);
  const edited: CommentLike = {
    body: renderProviderOutageAdvancedComment({
      actor: 'kurone-kito',
      prNumber: 2345,
      headSha: sha,
      declaredAt: '2026-09-01T05:00:00Z',
    }),
    created_at: '2026-09-01T05:01:00Z',
    author: { login: 'kurone-kito' },
    last_edited_at: '2026-09-01T05:30:00Z',
  };
  assert.equal(
    listProviderOutageAdvancements([edited], {
      trustedMarkerLogins: ['kurone-kito'],
    }).length,
    0,
  );

  const unknownEditState: CommentLike = {
    body: renderProviderOutageAdvancedComment({
      actor: 'kurone-kito',
      prNumber: 2345,
      headSha: sha,
      declaredAt: '2026-09-01T05:00:00Z',
    }),
    created_at: '2026-09-01T05:01:00Z',
    author: { login: 'kurone-kito' },
  };
  assert.equal(
    listProviderOutageAdvancements([unknownEditState], {
      trustedMarkerLogins: ['kurone-kito'],
    }).length,
    0,
  );

  const unedited: CommentLike = { ...edited, last_edited_at: null };
  assert.equal(
    listProviderOutageAdvancements([unedited], {
      trustedMarkerLogins: ['kurone-kito'],
    }).length,
    1,
  );
});

// --- CLI arg parsing ---

test('parseArgs: defaults to resolve mode and requires --service', () => {
  assert.throws(() => parseArgs([]), /missing required --service/);
});

test('parseArgs: --declare requires exactly one of --expires or --expires-in', () => {
  assert.throws(
    () => parseArgs(['--declare', '--service', 'x']),
    /exactly one of --expires or --expires-in/,
  );
  const parsed = parseArgs([
    '--declare',
    '--service',
    'x',
    '--expires-in',
    'PT1H',
  ]);
  assert.equal(parsed.mode, 'declare');
});

test('parseArgs: --record-advanced requires --pr and a well-formed --head-sha', () => {
  assert.throws(
    () => parseArgs(['--record-advanced']),
    /missing required --pr/,
  );
  assert.throws(
    () =>
      parseArgs(['--record-advanced', '--pr', '2345', '--head-sha', 'nope']),
    /invalid required --head-sha/,
  );
  const parsed = parseArgs([
    '--record-advanced',
    '--pr',
    '2345',
    '--head-sha',
    'a'.repeat(40),
  ]);
  assert.equal(parsed.mode, 'record-advanced');
  assert.equal(parsed.prNumber, 2345);
  assert.equal(parsed.headSha, 'a'.repeat(40));
});

test('parseArgs: --declare, --record-advanced, and --list-advanced are mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['--declare', '--list-advanced', '--service', 'x']),
    /mutually exclusive/,
  );
});

test('renderText: renders a genuinely different, non-JSON one-line-per-field form (#2320 review, CodeRabbit)', () => {
  const rendered = renderText({
    active: true,
    reason: '',
    declaration: { actor: 'kurone-kito', service: 'idd-advisory-convergence' },
  });
  assert.equal(
    rendered,
    'active: true\nreason: \ndeclaration: {"actor":"kurone-kito","service":"idd-advisory-convergence"}',
  );
  assert.notEqual(rendered, JSON.stringify({ active: true }));
});

test('parseArgs: --help skips the required-flag checks', () => {
  const parsed = parseArgs(['--help']);
  assert.equal(parsed.help, true);
});

function advancedBy(login: string): CommentLike {
  return {
    body: renderProviderOutageAdvancedComment({
      actor: login,
      prNumber: 2345,
      headSha: 'a'.repeat(40),
      declaredAt: '2026-09-01T05:00:00Z',
    }),
    created_at: '2026-09-01T05:01:00Z',
    author: { login },
    last_edited_at: null,
  };
}

test('list-advanced refuses an empty trusted-marker set instead of listing every author', async () => {
  const args = parseArgs([
    '--list-advanced',
    '--repo',
    'acme/widgets',
    '--target-issue',
    '9',
  ]);
  const previousActors = process.env.IDD_TRUSTED_MARKER_ACTORS;
  const previousCollaborators = process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  delete process.env.IDD_TRUSTED_MARKER_ACTORS;
  delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  try {
    await assert.rejects(
      () =>
        runProviderOutageDeclaration({
          args,
          comments: [advancedBy('stranger')],
          viewerLogin: '',
          trustConfig: {},
        }),
      /empty trusted-marker set/,
    );
  } finally {
    if (previousActors === undefined) {
      delete process.env.IDD_TRUSTED_MARKER_ACTORS;
    } else {
      process.env.IDD_TRUSTED_MARKER_ACTORS = previousActors;
    }
    if (previousCollaborators === undefined) {
      delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
    } else {
      process.env.IDD_TRUST_COLLABORATOR_MARKERS = previousCollaborators;
    }
  }
});

test('list-advanced: a repository owner absent from trustedMarkerActors and not the viewer is not trusted', () => {
  const logins = trustedLoginsForProviderOutageAdvancements({
    viewerLogin: 'someone-else',
    config: { trustedMarkerActors: ['listed-bot'] },
  });
  const list = listProviderOutageAdvancements([advancedBy('repo-owner')], {
    trustedMarkerLogins: logins,
  });
  assert.equal(list.length, 0);
});

test('list-advanced: the same marker is trusted once the repository owner is listed', () => {
  const logins = trustedLoginsForProviderOutageAdvancements({
    viewerLogin: 'someone-else',
    config: { trustedMarkerActors: ['repo-owner'] },
  });
  const list = listProviderOutageAdvancements([advancedBy('repo-owner')], {
    trustedMarkerLogins: logins,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]?.prNumber, 2345);
});

test('provider-outage advancement trust matches the gate trusted-marker composition', () => {
  const config = { trustedMarkerActors: ['listed-bot'] };
  assert.deepEqual(
    trustedLoginsForProviderOutageAdvancements({
      viewerLogin: 'viewer',
      config,
      collaboratorMarkerLogins: ['collab-writer'],
    }),
    composeGateTrustedMarkerLogins({
      viewerLogin: 'viewer',
      config,
      collaboratorMarkerLogins: ['collab-writer'],
    }),
  );
});
