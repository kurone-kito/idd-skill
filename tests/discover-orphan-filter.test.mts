import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDraftCarrierOutput,
  buildOrphanClaimState,
  classifyIssue,
  extractBlockedByReferences,
  fetchOpenIssues,
  filterOrphanIssues,
  getOrphanFirstPolicy,
  loadPolicy,
  resolveClaimStateNow,
} from '../src/scripts/discover-orphan-filter.mts';
import { classifyIssue as classifyGraphIssue } from '../src/scripts/discover-roadmap-graph.mts';
import {
  NOW_FLAG_USAGE_MESSAGE,
  renderForcedHandoffComment,
} from '../src/scripts/marker-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import { GH_SEARCH_RESULT_CAP } from '../src/scripts/provider-adapter-github.mts';
import { SUITABILITY_REJECTION_PREFIX } from '../src/scripts/supersession-detection.mts';
import { spawnHelperBinWithEnvelope, stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const existingFooPath = resolve(process.cwd(), 'src/scripts/foo.mts');

/**
 * Stub `gh` on PATH for the policy-load failure tests (#1721). `runCli()`
 * loads the policy before it resolves owner/repo, so these tests throw
 * before any `gh` call and the `repo view` answer below is not reached
 * today. It answers only the combined `repo view --json owner,name` request
 * and fails every other call loudly, so a change that did reach it with a
 * different shape could not pass silently. Returns a cleanup callback that
 * restores PATH; callers must invoke it (ideally in a `finally`) even when
 * the assertion throws.
 */
function stubGhRepoView(): () => void {
  return stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  if (args.join(" ") !== "repo view --json owner,name") {
    process.stderr.write("unexpected repo view argv: " + args.join(" ") + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ owner: { login: "kurone-kito" }, name: "idd-skill" }) + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
}

test('extractBlockedByReferences parses visible blocker lines', () => {
  const body = `
Blocked by #12
notes
  Blocked by #34 because dependency
blocked by #56
`;
  assert.deepEqual(extractBlockedByReferences(body), [12, 34, 56]);
});

test('extractBlockedByReferences tolerates a colon between the keyword and the ref (#1311)', () => {
  const body = '- Blocked by: #123 (context) — more text';
  assert.deepEqual(extractBlockedByReferences(body), [123]);
});

test('getOrphanFirstPolicy reads commands row and falls back to none', () => {
  assert.equal(
    getOrphanFirstPolicy({
      commands: { 'orphan-first-policy': 'maintainer-approved' },
    }),
    'maintainer-approved',
  );
  assert.equal(
    getOrphanFirstPolicy({ orphanFirstPolicy: 'public-disabled' }),
    'public-disabled',
  );
  assert.equal(getOrphanFirstPolicy({}), 'none');
});

test('classifyIssue rejects roadmap and blocked marker issues', () => {
  const roadmap = classifyIssue(
    {
      number: 1,
      title: 'roadmap',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-roadmap-id: x -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 2,
      title: 'blocked',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-blocked-by: x -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('#3284 review fix: classifyIssue keeps a cross-repository-only Blocked-by non-selectable', () => {
  // A cross-repository token resolves to nothing in `blockedRefs`, so
  // before this fix the issue read as having no dependencies at all and
  // was wrongly classified `orphan` -- the exact false-selectable outcome
  // the dependency-grammar's fail-safe contract exists to prevent.
  const result = classifyIssue(
    {
      number: 3,
      title: 'cross-repo blocked',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by other/repo#5',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      currentRepo: 'kurone-kito/idd-skill',
    },
  );
  assert.equal(result.orphan, false);
  assert.equal(result.reason, 'unresolvable_reference');
  assert.deepEqual(result.details, [
    { reference: 'other/repo#5', reason: 'cross_repository_reference' },
  ]);
});

test('classifyIssue ignores roadmap-id/blocked-by markers only quoted inside code (#3281)', () => {
  const roadmapQuoted = classifyIssue(
    {
      number: 1,
      title: 'quoted roadmap-id',
      state: 'OPEN',
      labels: [],
      body: ['Example:', '```', '<!-- idd-skill-roadmap-id: x -->', '```'].join(
        '\n',
      ),
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(roadmapQuoted.orphan, true);
  assert.equal(roadmapQuoted.reason, 'orphan');

  const blockedQuoted = classifyIssue(
    {
      number: 2,
      title: 'quoted blocked-by',
      state: 'OPEN',
      labels: [],
      body: 'Example: `<!-- idd-skill-blocked-by: x -->`',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(blockedQuoted.orphan, true);
  assert.equal(blockedQuoted.reason, 'orphan');
});

test('classifyIssue agrees with discover-roadmap-graph.mts that a label-only issue is not a roadmap (#3286)', () => {
  const labelOnlyIssue = {
    number: 6,
    title: 'label-only, no marker',
    state: 'OPEN',
    labels: [{ name: 'roadmap' }],
    body: 'No roadmap-id marker here.',
  };

  // The orphan filter's own marker-only rule already treats this as an
  // ordinary orphan candidate, not a roadmap...
  const orphanResult = classifyIssue(labelOnlyIssue, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.equal(orphanResult.orphan, true);
  assert.equal(orphanResult.reason, 'orphan');

  // ...and discover-roadmap-graph.mts's classifyIssue agrees: no marker
  // means execution, never roadmap, even though the label is present
  // (#3286 Groom-hearing maintainer decision -- the marker is the sole
  // roadmap identity).
  assert.equal(classifyGraphIssue(labelOnlyIssue).kind, 'execution');
});

test('classifyIssue excludes the configured providerOutage.declarationTarget by number (#2800)', () => {
  const declarationIssue = {
    number: 42,
    title: 'Provider outage coordination',
    state: 'OPEN',
    labels: [],
    body: 'No markers, no labels -- a permanent coordination issue.',
  };
  const excluded = classifyIssue(declarationIssue, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    providerOutageDeclarationTarget: 42,
  });
  assert.equal(excluded.orphan, false);
  assert.equal(excluded.reason, 'provider_outage_target');

  // A different issue number is unaffected by the same configured target.
  const other = classifyIssue(
    { ...declarationIssue, number: 43 },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      providerOutageDeclarationTarget: 42,
    },
  );
  assert.equal(other.reason, 'orphan');
});

test('classifyIssue leaves the target issue as a normal orphan when providerOutageDeclarationTarget is absent', () => {
  const declarationIssue = {
    number: 42,
    title: 'Provider outage coordination',
    state: 'OPEN',
    labels: [],
    body: 'No markers, no labels -- a permanent coordination issue.',
  };
  const result = classifyIssue(declarationIssue, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue accepts marker forms without colon', () => {
  const roadmap = classifyIssue(
    {
      number: 3,
      title: 'roadmap marker without payload',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-roadmap-id -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 4,
      title: 'blocked marker without payload',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-blocked-by -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('classifyIssue supports custom marker prefix', () => {
  const roadmap = classifyIssue(
    {
      number: 5,
      title: 'custom roadmap marker',
      state: 'OPEN',
      labels: [],
      body: '<!-- custom-roadmap-id: phase-a -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      markerPrefix: 'custom',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 6,
      title: 'custom blocked marker',
      state: 'OPEN',
      labels: [],
      body: '<!-- custom-blocked-by: phase-a -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      markerPrefix: 'custom',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('filterOrphanIssues excludes blocked labels and open blockers', async () => {
  const issues = [
    {
      number: 10,
      title: 'candidate',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #20',
      url: 'https://example.com/10',
    },
    {
      number: 11,
      title: 'human blocked',
      state: 'OPEN',
      labels: [{ name: 'status:blocked-by-human' }],
      body: '',
      url: 'https://example.com/11',
    },
    {
      number: 12,
      title: 'orphan',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.com/12',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[20, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 12);
  assert.equal(result.filtered.blocked_by_open_reference.length, 1);
  assert.equal(result.filtered.blocked_label.length, 1);
});

test('#4493 excludes markerless roadmap leaves before orphan-only checks', async () => {
  const triageLookups: number[] = [];
  const result = await filterOrphanIssues(
    [
      {
        number: 4401,
        title: 'markerless roadmap leaf',
        state: 'OPEN',
        labels: [],
        body: 'No roadmap marker is present.',
        url: 'https://example.com/4401',
      },
      {
        number: 4402,
        title: 'independent orphan',
        state: 'OPEN',
        labels: [],
        body: '',
        url: 'https://example.com/4402',
      },
    ],
    {
      excludeIssueNumbers: [4401],
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      fetchCommentsByIssueNumber: (issueNumber) => {
        triageLookups.push(issueNumber);
        return [];
      },
      trustedMarkerLogins: ['trusted'],
    },
  );

  assert.deepEqual(
    result.orphans.map((issue) => issue.number),
    [4402],
  );
  assert.deepEqual(
    result.filtered.excluded_roadmap_leaf.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      reason: issue.reason,
      url: issue.url,
    })),
    [
      {
        number: 4401,
        title: 'markerless roadmap leaf',
        state: 'OPEN',
        reason: 'excluded_roadmap_leaf',
        url: 'https://example.com/4401',
      },
    ],
  );
  assert.equal(result.counts.filtered.excluded_roadmap_leaf, 1);
  assert.deepEqual(triageLookups, [4402]);
});

test('#2767: filterOrphanIssues demotes a runtime-observation-precondition candidate via fetchUserContentEditorsByIssueNumber and warns', async () => {
  const issues = [
    {
      number: 30,
      title: 'demoted candidate',
      state: 'OPEN',
      labels: [],
      body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.\n\n## Acceptance criteria\n- `node --test tests/foo.test.mts` passes\n\n## Candidate files\n- `src/scripts/foo.mts`',
      url: 'https://example.com/30',
      user: { login: 'alice' },
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => ['alice'],
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: (path) => path === existingFooPath,
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 30);
  assert.equal(result.filtered.runtime_observation_precondition.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(
    (result.warnings[0] as { reason: string }).reason,
    'runtime_observation_precondition_demoted',
  );
});

test('#2767: filterOrphanIssues never demotes when fetchUserContentEditorsByIssueNumber is not supplied (byte-stable default)', async () => {
  const issues = [
    {
      number: 31,
      title: 'still filtered',
      state: 'OPEN',
      labels: [],
      body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.',
      url: 'https://example.com/31',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.runtime_observation_precondition.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('#2767: filterOrphanIssues degrades to the plain (filtered) result when fetchUserContentEditorsByIssueNumber throws', async () => {
  const issues = [
    {
      number: 32,
      title: 'still filtered after a throwing fetch',
      state: 'OPEN',
      labels: [],
      body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.\n\n## Acceptance criteria\n- `node --test tests/foo.test.mts` passes\n\n## Candidate files\n- `src/scripts/foo.mts`',
      url: 'https://example.com/32',
      user: { login: 'alice' },
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => {
      throw new Error('gh api graphql ... failed: rate limited (HTTP 429)');
    },
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: (path) => path === existingFooPath,
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.runtime_observation_precondition.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('#2767: filterOrphanIssues skips fetchUserContentEditorsByIssueNumber entirely when a local structural signal is already false (Codex review, PR #2840, round 15)', async () => {
  let fetchCalls = 0;
  const issues = [
    {
      number: 33,
      title: 'no Acceptance criteria or Candidate files section at all',
      state: 'OPEN',
      labels: [],
      body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.',
      url: 'https://example.com/33',
      user: { login: 'alice' },
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => {
      fetchCalls += 1;
      return ['alice'];
    },
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: () => false,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.runtime_observation_precondition.length, 1);
  assert.equal(result.warnings.length, 0);
});

// #2767 (CodeRabbit review, PR #2840): a fixture that builds an
// `OrphanIssueInput` by hand (every test above) bypasses `fetchOpenIssues`/
// `normalizeIssue` entirely, which is exactly how the live CLI's `user`
// field silently never reached the `trustedEditor` signal -- this test goes
// through the real function instead.
test('#2767: fetchOpenIssues carries the provider user field through to the normalized issue', () => {
  const port = createFakeProviderAdapter({
    workItems: {
      33: {
        number: 33,
        title: 'demotable candidate',
        body: 'body',
        state: 'open',
        user: { login: 'alice' },
      },
    },
  });
  const [issue] = fetchOpenIssues(port);
  assert.deepEqual(issue?.user, { login: 'alice' });
});

test('#2767: filterOrphanIssues demotes a runtime-observation-precondition candidate reached through fetchOpenIssues (not a hand-built fixture)', async () => {
  const port = createFakeProviderAdapter({
    workItems: {
      34: {
        number: 34,
        title: 'demoted candidate via fetchOpenIssues',
        body:
          'Do this only after the prior fix has merged and is confirmed to ' +
          'take effect in production.\n\n## Acceptance criteria\n- `node --test tests/foo.test.mts` passes\n\n## Candidate files\n- `src/scripts/foo.mts`',
        state: 'open',
        user: { login: 'alice' },
      },
    },
  });
  const issues = fetchOpenIssues(port);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => ['alice'],
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: (path) => path === existingFooPath,
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 34);
  assert.equal(result.warnings.length, 1);
  assert.equal(
    (result.warnings[0] as { reason: string }).reason,
    'runtime_observation_precondition_demoted',
  );
});

// #2767 (CodeRabbit review, PR #2840): the demotion warning must not be
// emitted for a candidate that does not survive to the final `orphans`
// partition -- verified against both removal paths below.
test('#2767: filterOrphanIssues suppresses the demotion warning when the candidate is later excluded by the triage-verdict filter', async () => {
  const issues = [
    {
      number: 35,
      title: 'demoted then triage-verdict-rejected',
      state: 'OPEN',
      labels: [],
      body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.\n\n## Acceptance criteria\n- `node --test tests/foo.test.mts` passes\n\n## Candidate files\n- `src/scripts/foo.mts`',
      url: 'https://example.com/35',
      user: { login: 'alice' },
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];

  const rejectionComment = {
    body: `${SUITABILITY_REJECTION_PREFIX} — Check 2 (Coherence): reason.\n\n<!-- idd-skill-triage-verdict: unclear -->`,
    created_at: '2026-06-01T00:00:00Z',
    user: { login: 'alice' },
  };

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => ['alice'],
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: (path) => path === existingFooPath,
    fetchCommentsByIssueNumber: () => [rejectionComment],
    fetchTimelineByIssueNumber: () => [],
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.triage_verdict_rejected.length, 1);
  assert.equal(
    result.warnings.length,
    0,
    'no demotion warning for a candidate excluded by the triage-verdict filter',
  );
});

test('#2767: filterOrphanIssues suppresses the demotion warning when the candidate is routed to routed_to_human', async () => {
  const issues = [
    {
      number: 36,
      title: 'demoted then routed below the autopilot floor',
      state: 'OPEN',
      labels: [],
      body:
        'Do this only after the prior fix has merged and is confirmed to ' +
        'take effect in production.\n\n## Acceptance criteria\n- `node --test tests/foo.test.mts` passes\n\n## Candidate files\n- `src/scripts/foo.mts`\n\n<!-- idd-skill-autopilot-suitability: 1 -->',
      url: 'https://example.com/36',
      user: { login: 'alice' },
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchUserContentEditorsByIssueNumber: () => ['alice'],
    isTrustedCollaborator: () => false,
    trustedMarkerLogins: ['alice'],
    existsAt: (path) => path === existingFooPath,
    autopilot: true,
    autopilotSuitabilityFloor: 3,
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.routed_to_human.length, 1);
  assert.equal(
    result.warnings.length,
    0,
    'no demotion warning for a candidate routed to routed_to_human',
  );
});

test('filterOrphanIssues excludes providerOutage.declarationTarget end-to-end (#2800)', async () => {
  const issues = [
    {
      number: 50,
      title: 'Provider outage coordination',
      state: 'OPEN',
      labels: [],
      body: 'No markers, no labels -- a permanent coordination issue.',
      url: 'https://example.com/50',
    },
    {
      number: 51,
      title: 'ordinary orphan',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.com/51',
    },
  ];

  const configured = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    providerOutageDeclarationTarget: 50,
  });
  assert.equal(configured.orphans.length, 1);
  assert.equal(configured.orphans[0].number, 51);
  assert.equal(configured.filtered.provider_outage_target.length, 1);
  assert.equal(configured.filtered.provider_outage_target[0].number, 50);

  // Absent config: behavior is unchanged from today -- both are orphans.
  const unconfigured = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.equal(unconfigured.orphans.length, 2);
  assert.equal(unconfigured.filtered.provider_outage_target.length, 0);
});

test('filterOrphanIssues resolves configured blocked-label names (#1273)', async () => {
  const issues = [
    {
      number: 30,
      title: 'custom human-gate label',
      state: 'OPEN',
      labels: [{ name: 'triage:human-gate' }],
      body: '',
      url: 'https://example.com/30',
    },
    {
      number: 31,
      title: 'stock status:blocked-by-human label no longer blocks',
      state: 'OPEN',
      labels: [{ name: 'status:blocked-by-human' }],
      body: '',
      url: 'https://example.com/31',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    blockedByHumanLabelName: 'triage:human-gate',
  });

  // The configured label name blocks #30...
  assert.equal(result.filtered.blocked_label.length, 1);
  assert.equal(result.filtered.blocked_label[0].number, 30);
  // ...while the stock default no longer matches once overridden, so #31 is
  // an orphan (the override replaces, not adds to, the default).
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 31);
});

// #4109: an open issue carrying the authoring-only label is filtered as
// blocked_label, the same bucket as needs-decision.
test('filterOrphanIssues excludes an authoring-only labelled issue as blocked_label (#4109)', async () => {
  const issues = [
    {
      number: 40,
      title: 'authoring-only deliverable',
      state: 'OPEN',
      labels: [{ name: 'status:authoring-only' }],
      body: '',
      url: 'https://example.com/40',
    },
    {
      number: 41,
      title: 'unlabelled orphan stays',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.com/41',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.filtered.blocked_label.length, 1);
  assert.equal(result.filtered.blocked_label[0].number, 40);
  assert.deepEqual(
    result.orphans.map((issue) => issue.number),
    [41],
  );
});

// Non-default override: a dropped forwarding site would fall back to the
// default name and fail this assertion.
test('filterOrphanIssues resolves a configured authoring-only label name (#4109)', async () => {
  const issues = [
    {
      number: 42,
      title: 'custom authoring-only label',
      state: 'OPEN',
      labels: [{ name: 'triage:authoring-only' }],
      body: '',
      url: 'https://example.com/42',
    },
    {
      number: 43,
      title: 'stock label no longer blocks',
      state: 'OPEN',
      labels: [{ name: 'status:authoring-only' }],
      body: '',
      url: 'https://example.com/43',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    authoringOnlyLabelName: 'triage:authoring-only',
  });

  assert.equal(result.filtered.blocked_label.length, 1);
  assert.equal(result.filtered.blocked_label[0].number, 42);
  assert.deepEqual(
    result.orphans.map((issue) => issue.number),
    [43],
  );
});

// #4257: a draft carrier is an authoring-only issue whose body carries the
// carrier marker outside code. Each case below builds its fixtures from this
// marker, so the release-state bucket is the only thing under test.
const CARRIER_MARKER = '<!-- idd-skill-draft-carrier: v1 -->';

function carrierIssue(
  number: number,
  body: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    number,
    title: `carrier ${number}`,
    state: 'OPEN',
    labels: [{ name: 'status:authoring-only' }],
    body: `${CARRIER_MARKER}\n\n${body}`,
    url: `https://example.com/${number}`,
    ...overrides,
  };
}

test('draft carriers: ready when no blocker is named or the only blocker is closed (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(50, '## Release condition\n\nNo blocker.'),
      carrierIssue(51, '## Release condition\n\nBlocked by #52'),
    ],
    {
      issueStateByNumber: new Map([[52, 'CLOSED']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.deepEqual(
    result.draftCarriers.ready.map((entry) => entry.number),
    [50, 51],
  );
  assert.deepEqual(result.draftCarriers.waiting, []);
  assert.deepEqual(result.draftCarriers.held, []);
});

test('draft carriers: an open blocker waits with reason open, and an unresolvable or cross-repository one waits too (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(53, 'Blocked by #54'),
      carrierIssue(55, 'Blocked by #56\nBlocked by other/repo#7'),
    ],
    {
      issueStateByNumber: new Map([[54, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      currentRepo: 'kurone-kito/idd-skill',
    },
  );
  assert.deepEqual(result.draftCarriers.waiting, [
    {
      number: 53,
      title: 'carrier 53',
      url: 'https://example.com/53',
      blockers: [{ reference: 54, reason: 'open' }],
    },
    {
      number: 55,
      title: 'carrier 55',
      url: 'https://example.com/55',
      blockers: [
        { reference: 56, reason: 'issue-not-found-or-inaccessible' },
        { reference: 'other/repo#7', reason: 'cross_repository_reference' },
      ],
    },
  ]);
});

test('draft carriers: a carrier that also carries the authoring label is held, stale only past the authoring stale age (#4257)', async () => {
  const labeledAt = '2026-10-14T00:00:00Z';
  const held = carrierIssue(60, 'No blocker.', {
    labels: [{ name: 'status:authoring-only' }, { name: 'status:authoring' }],
    labelEvents: [
      {
        event: 'labeled',
        label: { name: 'status:authoring' },
        created_at: labeledAt,
      },
    ],
  });
  const options = {
    issueStateByNumber: new Map<number, string>(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    authoringStaleAgeMs: 4 * 60 * 60 * 1000,
  };
  const fresh = await filterOrphanIssues([held], {
    ...options,
    now: '2026-10-14T01:00:00Z',
  });
  const stale = await filterOrphanIssues([held], {
    ...options,
    now: '2026-10-14T05:00:00Z',
  });
  assert.deepEqual(fresh.draftCarriers.held, [
    {
      number: 60,
      title: 'carrier 60',
      url: 'https://example.com/60',
      heldSince: labeledAt,
      stale: false,
    },
  ]);
  assert.equal(stale.draftCarriers.held[0]?.stale, true);
  // The authoring-only label blocks the carrier before the authoring-label
  // branch runs, so a held carrier never gets the stale-authoring warning.
  assert.equal(stale.filtered.blocked_label[0]?.number, 60);
  assert.deepEqual(stale.warnings, []);
});

test('draft carriers: a held carrier with no labeled event reports no heldSince and is not stale (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(63, 'No blocker.', {
        labels: [
          { name: 'status:authoring-only' },
          { name: 'status:authoring' },
        ],
      }),
    ],
    {
      issueStateByNumber: new Map<number, string>(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      now: '2026-10-14T05:00:00Z',
    },
  );
  assert.deepEqual(result.draftCarriers.held, [
    {
      number: 63,
      title: 'carrier 63',
      url: 'https://example.com/63',
      heldSince: null,
      stale: false,
    },
  ]);
});

test('draft carriers: an A0-O label-event read that throws keeps the carrier and reports no heldSince (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(64, 'No blocker.', {
        labels: [
          { name: 'status:authoring-only' },
          { name: 'status:authoring' },
        ],
      }),
    ],
    {
      issueStateByNumber: new Map<number, string>(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      fetchLabelEventsByIssueNumber: () => {
        throw new Error('timeline unavailable');
      },
      now: '2026-10-14T05:00:00Z',
    },
  );
  assert.equal(result.draftCarriers.held[0]?.number, 64);
  assert.equal(result.draftCarriers.held[0]?.heldSince, null);
  assert.equal(result.draftCarriers.held[0]?.stale, false);
});

test('draft carriers: an authoring-only issue without the marker, a marker without the label, and a marker only inside code are in no bucket (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      {
        number: 70,
        title: 'authoring-only, no marker',
        state: 'OPEN',
        labels: [{ name: 'status:authoring-only' }],
        body: 'Plain body.',
        url: 'https://example.com/70',
      },
      {
        number: 71,
        title: 'marker, no label',
        state: 'OPEN',
        labels: [],
        body: CARRIER_MARKER,
        url: 'https://example.com/71',
      },
      {
        number: 72,
        title: 'marker in a fence',
        state: 'OPEN',
        labels: [{ name: 'status:authoring-only' }],
        body: ['```', CARRIER_MARKER, '```'].join('\n'),
        url: 'https://example.com/72',
      },
      {
        number: 73,
        title: 'marker in a code span',
        state: 'OPEN',
        labels: [{ name: 'status:authoring-only' }],
        body: ['Example: `', CARRIER_MARKER, '`'].join(''),
        url: 'https://example.com/73',
      },
    ],
    {
      issueStateByNumber: new Map<number, string>(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.deepEqual(result.draftCarriers, { held: [], ready: [], waiting: [] });
});

test('draft carriers: a carrier that is also the outage or journal target is still filed as blocked_label (#4257)', async () => {
  const result = await filterOrphanIssues(
    [carrierIssue(150, 'No blocker.'), carrierIssue(151, 'No blocker.')],
    {
      issueStateByNumber: new Map<number, string>(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      providerOutageDeclarationTarget: 150,
      authoringJournalTarget: 151,
    },
  );
  assert.deepEqual(
    result.filtered.blocked_label.map((entry) => entry.number),
    [150, 151],
  );
  assert.deepEqual(result.filtered.provider_outage_target, []);
  assert.deepEqual(result.filtered.authoring_journal_target, []);
  assert.deepEqual(
    result.draftCarriers.ready.map((entry) => entry.number),
    [150, 151],
  );
});

test('draft carriers: a Blocked by line inside a fenced draft does not block the carrier (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(
        80,
        '## Release condition\n\nNo blocker.\n\n## Drafts\n\n```md\nBlocked by #81\n```\n',
      ),
    ],
    {
      issueStateByNumber: new Map([[81, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.deepEqual(
    result.draftCarriers.ready.map((entry) => entry.number),
    [80],
  );
  assert.deepEqual(result.draftCarriers.waiting, []);
});

test('draft carriers: counts equal the bucket lengths, and carriers stay out of orphans and the top-level unresolvable (#4257)', async () => {
  const result = await filterOrphanIssues(
    [
      carrierIssue(90, 'No blocker.'),
      carrierIssue(91, 'Blocked by #92'),
      carrierIssue(93, 'Blocked by #94'),
      carrierIssue(95, 'Blocked by #96', {
        labels: [
          { name: 'status:authoring-only' },
          { name: 'status:authoring' },
        ],
      }),
    ],
    {
      issueStateByNumber: new Map([[92, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.counts.draftCarriersHeld, 1);
  assert.equal(result.counts.draftCarriersReady, 1);
  assert.equal(result.counts.draftCarriersWaiting, 2);
  assert.equal(
    result.draftCarriers.held.length,
    result.counts.draftCarriersHeld,
  );
  assert.equal(
    result.draftCarriers.ready.length,
    result.counts.draftCarriersReady,
  );
  assert.equal(
    result.draftCarriers.waiting.length,
    result.counts.draftCarriersWaiting,
  );
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.unresolvable, []);
  assert.deepEqual(
    result.filtered.blocked_label.map((entry) => entry.number),
    [90, 91, 93, 95],
  );
});

// The `--draft-carriers` listing (#4257). The fake search ignores its label
// argument, so these cases prove the classifier alone keeps non-carriers out.
function loadDraftPolicy(): {
  policy: ReturnType<typeof loadPolicy>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'idd-draft-carriers-policy-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, '{}');
  return {
    policy: loadPolicy(policyPath),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function searchRow(number: number, body: string, labels: string[]) {
  return {
    number,
    title: `row ${number}`,
    body,
    state: 'open',
    labels: labels.map((name) => ({ name })),
    url: `https://example.com/${number}`,
  };
}

test('--draft-carriers listing keeps only carriers and prints the documented fields (#4257)', () => {
  const { policy, cleanup } = loadDraftPolicy();
  try {
    const port = createFakeProviderAdapter({
      searchResults: [
        searchRow(100, `${CARRIER_MARKER}\n\nNo blocker.`, [
          'status:authoring-only',
        ]),
        searchRow(101, 'Plain authoring-only issue.', [
          'status:authoring-only',
        ]),
        searchRow(102, CARRIER_MARKER, []),
      ],
    });
    const output = buildDraftCarrierOutput(port, {
      owner: 'kurone-kito',
      repo: 'idd-skill',
      policy,
      now: '2026-10-14T01:00:00Z',
    });
    assert.deepEqual(Object.keys(output).sort(), [
      'counts',
      'draftCarriers',
      'policy',
      'repository',
    ]);
    assert.deepEqual(output.repository, {
      owner: 'kurone-kito',
      repo: 'idd-skill',
    });
    assert.equal(output.policy.authoringOnlyLabelName, 'status:authoring-only');
    assert.deepEqual(output.draftCarriers, {
      held: [],
      ready: [
        {
          number: 100,
          title: 'row 100',
          url: 'https://example.com/100',
        },
      ],
      waiting: [],
    });
    assert.deepEqual(output.counts, {
      draftCarriersHeld: 0,
      draftCarriersReady: 1,
      draftCarriersWaiting: 0,
    });
  } finally {
    cleanup();
  }
});

test('--draft-carriers listing fails closed when the search reaches the result cap (#4257)', () => {
  const { policy, cleanup } = loadDraftPolicy();
  try {
    const port = createFakeProviderAdapter({
      searchResults: Array.from({ length: GH_SEARCH_RESULT_CAP }, (_, index) =>
        searchRow(index + 1, 'Plain body.', []),
      ),
    });
    assert.throws(
      () =>
        buildDraftCarrierOutput(port, {
          owner: 'kurone-kito',
          repo: 'idd-skill',
          policy,
          now: '2026-10-14T01:00:00Z',
        }),
      /result cap/,
    );
  } finally {
    cleanup();
  }
});

test('--draft-carriers fails closed when a held carrier timeline cannot be read (#4257)', () => {
  const { policy, cleanup } = loadDraftPolicy();
  try {
    const port = createFakeProviderAdapter({
      searchResults: [
        searchRow(120, `${CARRIER_MARKER}\n\nNo blocker.`, [
          'status:authoring-only',
          'status:authoring',
        ]),
      ],
    });
    const unreadable = {
      ...port,
      getWorkItemTimeline: () => {
        throw new Error('timeline unavailable');
      },
    };
    assert.throws(
      () =>
        buildDraftCarrierOutput(unreadable, {
          owner: 'kurone-kito',
          repo: 'idd-skill',
          policy,
          now: '2026-10-14T05:00:00Z',
        }),
      /timeline unavailable/,
    );
  } finally {
    cleanup();
  }
});

test('--draft-carriers resolves blockers and held events through the port (#4257)', () => {
  const { policy, cleanup } = loadDraftPolicy();
  try {
    const port = createFakeProviderAdapter({
      issueStates: { 130: 'OPEN', 131: 'CLOSED' },
      timelines: {
        132: [
          {
            event: 'labeled',
            label: { name: 'status:authoring' },
            created_at: '2026-10-14T00:00:00Z',
          },
        ],
      },
      searchResults: [
        searchRow(132, `${CARRIER_MARKER}\n\nNo blocker.`, [
          'status:authoring-only',
          'status:authoring',
        ]),
        searchRow(133, `${CARRIER_MARKER}\n\nBlocked by #130`, [
          'status:authoring-only',
        ]),
        searchRow(134, `${CARRIER_MARKER}\n\nBlocked by #131`, [
          'status:authoring-only',
        ]),
      ],
    });
    const output = buildDraftCarrierOutput(port, {
      owner: 'kurone-kito',
      repo: 'idd-skill',
      policy,
      now: '2026-10-14T05:00:00Z',
    });
    assert.deepEqual(output.draftCarriers, {
      held: [
        {
          number: 132,
          title: 'row 132',
          url: 'https://example.com/132',
          heldSince: '2026-10-14T00:00:00Z',
          stale: true,
        },
      ],
      ready: [
        {
          number: 134,
          title: 'row 134',
          url: 'https://example.com/134',
        },
      ],
      waiting: [
        {
          number: 133,
          title: 'row 133',
          url: 'https://example.com/133',
          blockers: [{ reference: 130, reason: 'open' }],
        },
      ],
    });
  } finally {
    cleanup();
  }
});

test('draft carriers: a carrier that also names a roadmap or blocked-by marker is still filed as blocked_label (#4257)', async () => {
  // audit-authored-issue rejects such a carrier, but every carrier must land in
  // filtered.blocked_label. A marker is not a Blocked by line, so the listing
  // still reads it as ready.
  const result = await filterOrphanIssues(
    [
      carrierIssue(140, '<!-- idd-skill-blocked-by: #1 -->\n\nNo blocker.'),
      carrierIssue(141, '<!-- idd-skill-roadmap-id: 1 -->\n\nNo blocker.'),
    ],
    {
      issueStateByNumber: new Map<number, string>(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.deepEqual(
    result.filtered.blocked_label.map((entry) => entry.number),
    [140, 141],
  );
  assert.deepEqual(result.filtered.blocked_by_marker, []);
  assert.deepEqual(result.filtered.roadmap_marker, []);
  assert.deepEqual(
    result.draftCarriers.ready.map((entry) => entry.number),
    [140, 141],
  );
});

test('--draft-carriers makes one label-filtered search, prints the listing, and reads no hint cache (#4257)', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-draft-carriers-cli-'));
  const workspace = join(root, 'workspace');
  const cacheRoot = join(root, 'cache');
  const argvLog = join(root, 'argv.jsonl');
  const rows = [
    searchRow(110, `${CARRIER_MARKER}\n\nNo blocker.`, [
      'status:authoring-only',
    ]),
    searchRow(111, 'Plain authoring-only issue.', ['status:authoring-only']),
  ];
  // The read cache is enabled here, so a hint read or write would create files
  // under XDG_CACHE_HOME; the listing must leave that directory absent.
  mkdirSync(join(workspace, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(workspace, '.github', 'idd', 'config.json'),
    JSON.stringify({ githubApi: { readCache: { enabled: true } } }),
  );
  const restore = stubExecutable(
    'gh',
    `const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'search' && args[1] === 'issues') {
  process.stdout.write(JSON.stringify(${JSON.stringify(rows)}) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  try {
    const result = spawnHelperBinWithEnvelope(
      'idd-discover-orphan-filter.mjs',
      ['--owner', 'kurone-kito', '--repo', 'idd-skill', '--draft-carriers'],
      { cwd: workspace },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), [
      'counts',
      'draftCarriers',
      'policy',
      'repository',
    ]);
    assert.deepEqual(
      output.draftCarriers.ready.map(
        (entry: { number: number }) => entry.number,
      ),
      [110],
    );
    const calls = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.deepEqual(calls[0]?.slice(0, 2), ['search', 'issues']);
    assert.equal(
      calls[0]?.[calls[0].indexOf('--label') + 1],
      'status:authoring-only',
    );
    assert.equal(existsSync(cacheRoot), false);
  } finally {
    restore();
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('--draft-carriers fails closed when the label search prints no JSON array (#4257)', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-draft-carriers-search-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'search' && args[1] === 'issues') {
  // Exit 0 with no output: the failure shape a non-strict read would take
  // for zero hits (#3624).
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  try {
    const result = spawnHelperBinWithEnvelope(
      'idd-discover-orphan-filter.mjs',
      ['--owner', 'kurone-kito', '--repo', 'idd-skill', '--draft-carriers'],
      { cwd: workspace },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gh search issues returned no JSON array/);
    assert.equal(result.stdout.includes('draftCarriers'), false);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--help documents --draft-carriers, which help-text-flags does not cover for this helper (#4257)', () => {
  const result = spawnHelperBinWithEnvelope('idd-discover-orphan-filter.mjs', [
    '--help',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes('discover-orphan-filter.mjs --draft-carriers'),
    result.stdout,
  );
});

test('--draft-carriers rejects the flags that select the orphan path, a cache mode, or a malformed --now (#4257)', () => {
  for (const extra of [
    ['--autopilot'],
    ['--with-claim-state'],
    ['--current-claim-id', 'abc'],
    ['--current-claim-id'],
    ['--pr', '3'],
    ['--no-cache'],
    ['--refresh-cache'],
    ['--purge-cache'],
    ['--exclude-issue', '4401'],
    ['--now', 'not-a-date'],
  ]) {
    const result = spawnHelperBinWithEnvelope(
      'idd-discover-orphan-filter.mjs',
      [
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
        '--draft-carriers',
        ...extra,
      ],
    );
    assert.notEqual(result.status, 0, `${extra.join(' ')}: ${result.stderr}`);
    assert.equal(
      result.envelope?.kind,
      'usage',
      `${extra.join(' ')}: ${result.stderr}`,
    );
  }
});

test('filterOrphanIssues excludes custom authoring label and warns when stale', async () => {
  const issues = [
    {
      number: 21,
      title: 'being drafted',
      state: 'OPEN',
      labels: [{ name: 'status:drafting' }],
      labelEvents: [
        {
          event: 'labeled',
          label: { name: 'status:drafting' },
          created_at: '2026-05-15T07:00:00Z',
        },
      ],
      body: '',
      url: 'https://example.com/21',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    authoringLabelName: 'status:drafting',
    authoringStaleAgeMs: 4 * 60 * 60 * 1000,
    now: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.authoring_label.length, 1);
  assert.equal(result.filtered.authoring_label[0].details, 'status:drafting');
  // #2767: `warnings[]` is now a union with `StructuralEvidenceDemotionWarning`
  // (which carries no `status` field); this fixture only ever produces the
  // authoring-label warning shape.
  assert.equal((result.warnings[0] as { status: string }).status, 'stale');
  assert.match(
    result.warnings[0].message,
    /Issue #21 has carried the authoring label for 5h/,
  );
});

test('filterOrphanIssues keeps closed-blocker issues as orphan candidates', async () => {
  const issues = [
    {
      number: 30,
      title: 'blocked by closed issue',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #31',
      url: 'https://example.com/30',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[31, 'CLOSED']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].reason, 'references_non_blocking');
});

test('filterOrphanIssues keeps the references_non_blocking reason legible when a closed-blocker issue is routed to a human for an unrelated sub-floor score (#2932)', async () => {
  const issues = [
    {
      number: 32,
      title: 'blocked by closed issue but below the autopilot floor',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #33\n\n<!-- idd-skill-autopilot-suitability: 2 -->',
      url: 'https://example.com/32',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[33, 'CLOSED']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilot: true,
    autopilotSuitabilityFloor: 3,
  });

  // The now-resolved blocking reference makes this orphan-eligible, but
  // its sub-floor autopilot score (independently) routes it to a human --
  // the two mechanisms are unrelated, and the reason string must not read
  // as "still blocked" once it lands in routed_to_human.
  assert.equal(result.orphans.length, 0);
  assert.equal(result.routed_to_human.length, 1);
  assert.equal(result.routed_to_human[0].reason, 'references_non_blocking');
});

test('filterOrphanIssues reports unresolvable and circular references', async () => {
  const issues = [
    {
      number: 40,
      title: 'missing ref',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #99',
      url: 'https://example.com/40',
    },
    {
      number: 41,
      title: 'cycle a',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #42',
      url: 'https://example.com/41',
    },
    {
      number: 42,
      title: 'cycle b',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #41',
      url: 'https://example.com/42',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([
      [41, 'OPEN'],
      [42, 'OPEN'],
    ]),
    fetchIssueStateByNumber: (number) =>
      number === 99 ? 'UNRESOLVABLE' : 'UNRESOLVABLE',
  });

  assert.equal(result.filtered.unresolvable_reference.length, 1);
  assert.equal(result.filtered.blocked_by_open_reference.length, 2);
  assert.equal(result.unresolvable.length, 1);
  assert.deepEqual(result.unresolvable[0], {
    issue: 40,
    reason: 'issue-not-found-or-inaccessible',
    reference: 99,
  });
});

test('classifyIssue handles lowercase state casing', async () => {
  const issue = {
    number: 50,
    title: 'blocked by open issue with lowercase state',
    state: 'open',
    labels: [],
    body: 'Blocked by #51',
    url: 'https://example.com/50',
  };

  const result = await filterOrphanIssues([issue], {
    issueStateByNumber: new Map([[51, 'open']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(
    result.orphans.length,
    0,
    'Issue should not be orphan when blocked by open reference',
  );
  assert.equal(
    result.filtered.blocked_by_open_reference.length,
    1,
    'Should classify as blocked_by_open_reference',
  );
});

test('classifyIssue supports custom marker prefix in filtering', async () => {
  const issue = {
    number: 60,
    title: 'issue with custom marker',
    state: 'OPEN',
    labels: [],
    body: '<!-- my-org-idd-blocked-by: gap-123 -->',
    url: 'https://example.com/60',
  };

  const result = await filterOrphanIssues([issue], {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    markerPrefix: 'my-org-idd',
  });

  assert.equal(
    result.orphans.length,
    0,
    'Issue should not be orphan when has custom-prefix blocked marker',
  );
  assert.equal(
    result.filtered.blocked_by_marker.length,
    1,
    'Should detect custom marker',
  );
});

test('filterOrphanIssues handles pagination with PR-heavy pages', async () => {
  const mockFetchIssueStateByNumber = (number: number) => {
    return number === 100 ? 'CLOSED' : 'UNRESOLVABLE';
  };

  const issues = [
    {
      number: 70,
      title: 'issue on pr-heavy page',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #100',
      url: 'https://example.com/70',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[100, 'CLOSED']]),
    fetchIssueStateByNumber: mockFetchIssueStateByNumber,
  });

  assert.equal(
    result.orphans.length,
    1,
    'Issue should be orphan when blocker is closed',
  );
  assert.equal(result.orphans[0].reason, 'references_non_blocking');
});

test('filterOrphanIssues ranks orphans by autopilot-suitability and routes below-floor to humans (autopilot)', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 3, title: 'mid', state: 'OPEN', body: `task\n${m(3)}` },
    { number: 4, title: 'unscored', state: 'OPEN', body: 'task with no score' },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilot: true,
  });

  // High first; unscored kept (floor baseline), below-floor routed out.
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [2, 3, 4],
  );
  assert.deepEqual(
    result.routed_to_human.map((o) => o.number),
    [1],
  );
  assert.equal(result.counts.routed_to_human, 1);
  assert.equal(
    result.orphans.find((o) => o.number === 2)?.autopilotSuitability,
    5,
  );
  assert.equal(
    result.orphans.find((o) => o.number === 4)?.autopilotSuitability,
    null,
  );
});

test('filterOrphanIssues keeps below-floor orphans selectable in attended (default) mode', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    // autopilot omitted -> attended: nothing routed out; below-floor ranked last.
  });

  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [2, 1],
  );
  assert.deepEqual(result.routed_to_human, []);
});

test('filterOrphanIssues tie-breaks equal scores by lowest issue number', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 20, title: 'twenty', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 7, title: 'seven', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 13, title: 'thirteen', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [7, 13, 20],
  );
});

test('filterOrphanIssues applies the effort hint as a soft tie-breaker within a score band', async () => {
  const s = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const e = (hint: string) => `<!-- idd-skill-effort: ${hint} -->`;
  // All four share score 4; effort orders the band: S (7, 20) before the
  // no-hint neutral (13) before L (4), with 7 < 20 broken by number.
  const issues = [
    {
      number: 20,
      title: 'twenty',
      state: 'OPEN',
      body: `t\n${s(4)}\n${e('S')}`,
    },
    { number: 7, title: 'seven', state: 'OPEN', body: `t\n${s(4)}\n${e('S')}` },
    { number: 13, title: 'thirteen', state: 'OPEN', body: `t\n${s(4)}` },
    { number: 4, title: 'four', state: 'OPEN', body: `t\n${s(4)}\n${e('L')}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [7, 20, 13, 4],
  );
  // The parsed hint is emitted per orphan for the cheap A4 Step 2 read.
  assert.equal(result.orphans.find((o) => o.number === 7)?.effort, 'S');
  assert.equal(result.orphans.find((o) => o.number === 13)?.effort, null);
  assert.equal(result.orphans.find((o) => o.number === 4)?.effort, 'L');
});

test('filterOrphanIssues leaves orphans unrouted when suitability is disabled', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilotSuitabilityEnabled: false,
  });

  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [1, 2],
  );
  assert.deepEqual(result.routed_to_human, []);
});

// ---------------------------------------------------------------------------
// --with-claim-state annotation (#1395), mirroring
// discover-roadmap-graph.test.mts's claim-state block against
// filterOrphanIssues's own `claimState` option.
// ---------------------------------------------------------------------------

const CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIM_HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CLAIM_NOW = '2026-06-25T12:00:00Z';

// A claim posted recently relative to CLAIM_NOW is non-stale (and within the
// heartbeat interval); one posted well over the 24h stale age earlier is
// both stale AND heartbeat-overdue (24h > 12h, so stale implies overdue).
const FRESH_CLAIM_AT = '2026-06-25T06:00:00Z';
const STALE_CLAIM_AT = '2026-06-20T06:00:00Z';

function claimComment(
  agentId: string,
  claimId: string,
  createdAt: string,
  { author = 'kurone-kito', branch = 'issue/701-task' } = {},
) {
  return {
    body: `<!-- claimed-by: ${agentId} ${claimId} supersedes: none ${createdAt} branch: ${branch} -->`,
    createdAt,
    author: { login: author },
    lastEditedAt: null,
  };
}

function buildClaimState(
  commentsByIssue: Map<number, unknown[]>,
  {
    currentClaimId = '',
    currentSessionAgentId = null,
    currentSessionWorktreePath = null,
    currentSessionBranch = null,
    currentSessionOwnsClaimEvidence = false,
    trustedActors = ['kurone-kito'],
    staleAgeMs = CLAIM_STALE_AGE_MS,
    heartbeatIntervalMs = CLAIM_HEARTBEAT_INTERVAL_MS,
  }: {
    currentClaimId?: string;
    currentSessionAgentId?: string | null;
    currentSessionWorktreePath?: string | null;
    currentSessionBranch?: string | null;
    currentSessionOwnsClaimEvidence?: boolean;
    trustedActors?: string[];
    staleAgeMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
) {
  const trusted = new Set(trustedActors.map((value) => value.toLowerCase()));
  const seen: number[] = [];
  return {
    seen,
    resolution: {
      loadComments: (issueNumber: number) => {
        seen.push(issueNumber);
        return commentsByIssue.get(issueNumber) ?? [];
      },
      isTrustedAuthor: (login: string) =>
        trusted.has(String(login ?? '').toLowerCase()),
      staleAgeMs,
      heartbeatIntervalMs,
      nowIso: CLAIM_NOW,
      currentClaimId,
      currentSessionAgentId,
      currentSessionWorktreePath,
      currentSessionBranch,
      currentSessionOwnsClaimEvidence,
    },
  };
}

// Two open orphan candidates, no blockers.
function claimOrphanIssues() {
  return [
    { number: 701, title: 'leaf 701', state: 'OPEN', labels: [], body: '' },
    { number: 702, title: 'leaf 702', state: 'OPEN', labels: [], body: '' },
  ];
}

test('without --with-claim-state, orphans carry no claim fields and fetch no comments', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { seen } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    // claimState intentionally omitted (default path).
  });

  for (const orphan of result.orphans) {
    const record = orphan as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(record, 'activeClaim'), false);
    assert.equal(Object.hasOwn(record, 'claimEligible'), false);
  }
  // No comment fetch happened — the loader was never invoked.
  assert.deepEqual(seen, []);
});

test('a present non-stale claim marks the orphan claimEligible:false', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution, seen } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: false,
    claimId: 'claim-701',
    agentId: 'agent-a',
    heartbeatOverdue: false,
  });
  assert.equal(leaf701?.claimEligible, false);
  // Both open orphan candidates are probed.
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [701, 702],
  );
});

test('a stale claim is takeover-eligible: present:true, stale:true, claimEligible:true', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', STALE_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: true,
    claimId: 'claim-701',
    agentId: 'agent-a',
    heartbeatOverdue: true,
  });
  assert.equal(leaf701?.claimEligible, true);
});

test('an unclaimed orphan is eligible: present:false, claimEligible:true', async () => {
  const issues = claimOrphanIssues();
  // 702 has no comments at all.
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf702 = byNumber.get(702);
  assert.deepEqual(leaf702?.activeClaim, {
    present: false,
    stale: false,
    claimId: null,
    agentId: null,
    heartbeatOverdue: false,
  });
  assert.equal(leaf702?.claimEligible, true);
});

test('an untrusted-author claim does not block the orphan', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [
      701,
      [
        claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT, {
          author: 'random-passerby',
        }),
      ],
    ],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  assert.equal(byNumber.get(701)?.activeClaim?.present, false);
  assert.equal(byNumber.get(701)?.claimEligible, true);
});

test('--current-claim-id sets ownedByCurrentSession on the matching claim', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue, {
    currentClaimId: 'claim-701',
    currentSessionAgentId: 'agent-a',
    currentSessionOwnsClaimEvidence: true,
  });

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  assert.equal(byNumber.get(701)?.activeClaim?.ownedByCurrentSession, true);
  // 702 is unclaimed, so ownedByCurrentSession is still emitted, as false.
  assert.equal(byNumber.get(702)?.activeClaim?.ownedByCurrentSession, false);
});

test('claim-state annotation survives the autopilot floor routing split', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 701, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 702, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilot: true,
    claimState: resolution,
  });

  // #701 is routed below the floor, but still carries the annotation.
  assert.deepEqual(
    result.routed_to_human.map((o) => o.number),
    [701],
  );
  assert.equal(result.routed_to_human[0]?.claimEligible, false);
  assert.equal(result.orphans[0]?.number, 702);
  assert.equal(result.orphans[0]?.claimEligible, true);
});

// ---------------------------------------------------------------------------
// activeClaim.heartbeatOverdue diagnostic annotation (#1433), mirroring
// discover-roadmap-graph.test.mts's own heartbeatOverdue block against
// filterOrphanIssues's `claimState` option.
//
// Purely additive and purely diagnostic: every case below re-asserts
// claimEligible unchanged from what the pre-#1433 stale-only rule would have
// produced, proving heartbeatOverdue never leaks into the takeover gate.
// ---------------------------------------------------------------------------

// Exactly at the 12h heartbeat-interval boundary, but well inside the 24h
// stale window.
const HEARTBEAT_OVERDUE_NOT_STALE_AT = '2026-06-25T00:00:00Z';
// Just under the 12h boundary.
const HEARTBEAT_WITHIN_WINDOW_AT = '2026-06-25T00:01:00Z';

test('heartbeatOverdue:true at the 12h boundary while remaining non-stale and claim-eligible unchanged', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [
      701,
      [claimComment('agent-a', 'claim-701', HEARTBEAT_OVERDUE_NOT_STALE_AT)],
    ],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const leaf701 = new Map(result.orphans.map((o) => [o.number, o])).get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: false,
    claimId: 'claim-701',
    agentId: 'agent-a',
    heartbeatOverdue: true,
  });
  // The diagnostic never becomes a gate: still eligible/blocking exactly as
  // a non-stale claim always was, pre-#1433.
  assert.equal(leaf701?.claimEligible, false);
});

test('heartbeatOverdue:false just inside the 12h window', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', HEARTBEAT_WITHIN_WINDOW_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const leaf701 = new Map(result.orphans.map((o) => [o.number, o])).get(701);
  assert.equal(leaf701?.activeClaim?.heartbeatOverdue, false);
  assert.equal(leaf701?.claimEligible, false);
});

test('heartbeatOverdue:false when no active claim is present', async () => {
  const issues = claimOrphanIssues();
  // 702 has no comments at all.
  const { resolution } = buildClaimState(new Map());

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const leaf702 = new Map(result.orphans.map((o) => [o.number, o])).get(702);
  assert.equal(leaf702?.activeClaim?.present, false);
  assert.equal(leaf702?.activeClaim?.heartbeatOverdue, false);
  assert.equal(leaf702?.claimEligible, true);
});

test('heartbeatOverdue:false when a later trusted heartbeat repost refreshes the clock', async () => {
  const issues = claimOrphanIssues();
  // The ORIGINAL claim is old enough to be both stale and heartbeat-overdue
  // on its own, but a later, same agent/claim/branch heartbeat repost
  // refreshes resolveActiveClaim's folded createdAt to a recent instant —
  // the exact same fold the pre-existing `stale` computation already relies
  // on, reused here with no new scan.
  const commentsByIssue = new Map<number, unknown[]>([
    [
      701,
      [
        claimComment('agent-a', 'claim-701', STALE_CLAIM_AT),
        claimComment('agent-a', 'claim-701', '2026-06-25T09:00:00Z'),
      ],
    ],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const leaf701 = new Map(result.orphans.map((o) => [o.number, o])).get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: false,
    claimId: 'claim-701',
    agentId: 'agent-a',
    heartbeatOverdue: false,
  });
  assert.equal(leaf701?.claimEligible, false);
});

test('filterOrphanIssues excludes an open non-epic Depends-on reference (#1536)', async () => {
  const issues = [
    {
      number: 70,
      title: 'candidate with an open dependency',
      state: 'OPEN',
      labels: [],
      body: 'Depends on #71',
      url: 'https://example.com/70',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[71, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.open_dependency_reference.length, 1);
  assert.equal(result.filtered.open_dependency_reference[0].number, 70);
});

test('filterOrphanIssues excludes an open non-epic task-list dependency reference (#1536)', async () => {
  const issues = [
    {
      number: 72,
      title: 'candidate with an open task-list dependency',
      state: 'OPEN',
      labels: [],
      body: '- [ ] #73',
      url: 'https://example.com/72',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[73, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.open_dependency_reference.length, 1);
  assert.equal(result.filtered.open_dependency_reference[0].number, 72);
});

test('filterOrphanIssues exempts an open Depends-on reference to a parent epic by title (#1536)', async () => {
  const issues = [
    {
      number: 80,
      title: 'candidate depending on a roadmap',
      state: 'OPEN',
      labels: [],
      body: 'Depends on #81',
      url: 'https://example.com/80',
    },
    {
      number: 81,
      title: 'roadmap: parent',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.com/81',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[81, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.filtered.open_dependency_reference.length, 0);
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [80, 81],
  );
  assert.equal(
    result.orphans.find((o) => o.number === 80)?.reason,
    'references_non_blocking',
  );
});

test('filterOrphanIssues exempts an open Depends-on reference to a configured roadmap label (#1536)', async () => {
  const issues = [
    {
      number: 90,
      title: 'candidate depending on an epic',
      state: 'OPEN',
      labels: [],
      body: 'Depends on #91',
      url: 'https://example.com/90',
    },
    {
      // Title deliberately does NOT start with "roadmap" so this exercises
      // only the configured-label path, not the independent title heuristic.
      number: 91,
      title: 'parent epic',
      state: 'OPEN',
      labels: [{ name: 'epic' }],
      body: '',
      url: 'https://example.com/91',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[91, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    roadmapLabelName: 'epic',
  });

  assert.equal(result.filtered.open_dependency_reference.length, 0);
  assert.equal(
    result.orphans.find((o) => o.number === 90)?.reason,
    'references_non_blocking',
  );
});

test('filterOrphanIssues treats an unresolvable Depends-on reference as blocking (#1536)', async () => {
  const issues = [
    {
      number: 92,
      title: 'candidate with a missing dependency',
      state: 'OPEN',
      labels: [],
      body: 'Depends on #999',
      url: 'https://example.com/92',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.unresolvable_reference.length, 1);
  assert.deepEqual(result.unresolvable, [
    {
      issue: 92,
      reference: 999,
      reason: 'issue-not-found-or-inaccessible',
    },
  ]);
});

test('filterOrphanIssues keeps a closed Depends-on reference as an orphan candidate (#1536)', async () => {
  const issues = [
    {
      number: 93,
      title: 'candidate with a closed dependency',
      state: 'OPEN',
      labels: [],
      body: 'Depends on #94',
      url: 'https://example.com/93',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[94, 'CLOSED']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].reason, 'references_non_blocking');
});

test('classifyIssue routes runtime/production-observation prose to runtime_observation_precondition (#2467)', () => {
  const cases = [
    'Do this only after the prior fix has merged and is confirmed to take effect in production.',
    'Start once the previous change has been observed live for a day.',
    'This requires runtime-observation of the fix before starting the next issue.',
    'This requires runtime observation of the fix before starting the next issue.',
  ];

  for (const body of cases) {
    const result = classifyIssue(
      { number: 100, title: 't', state: 'OPEN', labels: [], body },
      {
        issueStateByNumber: new Map(),
        fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      },
    );
    assert.equal(result.reason, 'runtime_observation_precondition', body);
  }
});

// --- #2767: structural-evidence demotion ------------------------------------

const ALL_STRUCTURAL_SIGNALS = {
  verificationCommand: true,
  candidateFilesExist: true,
  trustedEditor: true,
};

test('#2767: classifyIssue demotes a runtime-observation-precondition hit to a warned orphan when all structural signals hold', () => {
  const issue = {
    number: 100,
    title: 't',
    state: 'OPEN',
    labels: [],
    body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.',
  };
  const baseOptions = {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  };

  const withoutEvidence = classifyIssue(issue, baseOptions);
  assert.equal(withoutEvidence.orphan, false);
  assert.equal(withoutEvidence.reason, 'runtime_observation_precondition');

  const withEvidence = classifyIssue(issue, {
    ...baseOptions,
    structuralEvidence: ALL_STRUCTURAL_SIGNALS,
  });
  assert.equal(withEvidence.orphan, true);
  assert.equal(withEvidence.reason, 'orphan');
  assert.equal(
    withEvidence.warning,
    'runtime_observation_precondition_demoted',
  );
});

test('#2767: classifyIssue keeps filtering when any one structural signal is false', () => {
  const issue = {
    number: 100,
    title: 't',
    state: 'OPEN',
    labels: [],
    body: 'Do this only after the prior fix has merged and is confirmed to take effect in production.',
  };
  const baseOptions = {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  };
  for (const key of Object.keys(
    ALL_STRUCTURAL_SIGNALS,
  ) as (keyof typeof ALL_STRUCTURAL_SIGNALS)[]) {
    const result = classifyIssue(issue, {
      ...baseOptions,
      structuralEvidence: { ...ALL_STRUCTURAL_SIGNALS, [key]: false },
    });
    assert.equal(result.orphan, false, `expected filter with ${key}: false`);
    assert.equal(result.reason, 'runtime_observation_precondition');
  }
});

test('classifyIssue keeps a runtime-observation precondition blocking even once every numbered reference has closed (#2467)', () => {
  const result = classifyIssue(
    {
      number: 101,
      title: 't',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #94. Also confirm this is observed live before starting.',
    },
    {
      issueStateByNumber: new Map([[94, 'CLOSED']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test("classifyIssue does not trip runtime-observation prose quoted as a term, matching this feature's own motivating issue (#2467)", () => {
  const result = classifyIssue(
    {
      number: 102,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'No match exists for "confirm(ed) in production" / "observed live" / ' +
        '"runtime-observation" or any prose-blocker-class concept anywhere ' +
        'in idd-discover.instructions.md or docs/*.md.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue does not trip runtime-observation prose negated in the same clause (#2467)', () => {
  const result = classifyIssue(
    {
      number: 103,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'This can start immediately; it does not need to be confirmed in ' +
        'production first.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue does not trip runtime-observation prose inside a code region (#2467)', () => {
  const fenced = classifyIssue(
    {
      number: 104,
      title: 't',
      state: 'OPEN',
      labels: [],
      body: 'See the example:\n\n```\nconfirmed in production\n```\n',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(fenced.reason, 'orphan');

  const inline = classifyIssue(
    {
      number: 105,
      title: 't',
      state: 'OPEN',
      labels: [],
      body: 'The trigger phrase is `confirmed in production` in our docs.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(inline.reason, 'orphan');
});

test('classifyIssue does not trip runtime-observation prose quoted with trailing sentence punctuation inside the quotes (#2529 review)', () => {
  const result = classifyIssue(
    {
      number: 107,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'No match exists for "confirmed in production." or "observed ' +
        'live." or "runtime-observation." anywhere in the docs.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue does not trip runtime-observation prose negated after the matched phrase (#2529 review)', () => {
  const result = classifyIssue(
    {
      number: 108,
      title: 't',
      state: 'OPEN',
      labels: [],
      body: 'Runtime observation is not required before starting this issue.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue does not trip a trigger phrase opening a longer quote attributed to a different, cited issue by number (#2746)', () => {
  const result = classifyIssue(
    {
      number: 109,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Issue #2743 asserted in its Background: "confirmed in ' +
        'production: the deploy pipeline paused for six hours" -- ' +
        'describing a specific event that later turned out to be ' +
        'unrelated.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue still trips a quoted precondition with no cited-issue-number attribution nearby (#2746)', () => {
  const result = classifyIssue(
    {
      number: 110,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'The team said: "we need this confirmed in production before ' +
        'shipping."',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when the colon does not directly introduce the quote (CodeRabbit review, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 111,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Issue #2743: prior history. The requirement is "confirmed in ' +
        'production before shipping, per the runbook."',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when an unrelated colon follows the cited issue reference across a sentence break (Copilot/Codex review, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 112,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'See #42 for rollout details. Acceptance gate: "confirmed in ' +
        'production before shipping, per the runbook."',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue does not trip when the genuine attribution is the LAST reference before an unrelated earlier one (Copilot/Codex review round 2, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 113,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'See #1. Issue #2 asserted: "confirmed in production: the ' +
        'deploy pipeline paused for six hours" -- describing an ' +
        'unrelated event.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue still trips when the citing issue re-adopts the quoted prerequisite as its own requirement (Codex review round 2, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 114,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Per issue #42: "confirmed in production before shipping" ' +
        'remains required for this change too.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still detects re-adoption when the quoted excerpt contains a contraction (Copilot review round 3, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 115,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Per issue #42: "it\'s confirmed in production before shipping" ' +
        'remains required for this change too.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when the re-adopted requirement is phrased as "remains blocked" (Codex review round 3, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 116,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Per issue #42: "confirmed in production before shipping" ' +
        'remains blocked for this change.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when a question mark ends the unrelated sentence containing the earlier reference (Codex review round 3, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 117,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Did issue #42 ship? Acceptance gate: "confirmed in production ' +
        'before shipping, per the runbook."',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue does not trip when a soft-wrap newline sits between the introducing colon and the quote (Codex review round 3, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 118,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Issue #2743 asserted in its Background:\n"confirmed in ' +
        'production: the deploy pipeline paused for six hours" -- ' +
        'describing a specific event.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue still trips when the re-adoption cue precedes the citation instead of following the quote (Codex review round 4, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 119,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'This change still requires issue #42\'s gate: "confirmed in ' +
        'production before shipping".',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips a re-adoption cue past a quote longer than the old 300-char search bound (Codex review round 4, PR #2760)', () => {
  const longExcerpt = `confirmed in production ${'x'.repeat(320)} end of excerpt`;
  const result = classifyIssue(
    {
      number: 120,
      title: 't',
      state: 'OPEN',
      labels: [],
      body: `Per issue #42: "${longExcerpt}" remains required.`,
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when an unrelated apostrophe of a different quote family sits inside the excerpt (Codex review round 5, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 121,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Per issue #42: "confirmed in production according to the ' +
        "operators' long excerpt describing the outage window in " +
        'detail here" remains required.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when the candidate cites its own issue number (Codex review round 5, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 122,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Issue #122 acceptance criterion: "confirmed in production ' +
        'before shipping"',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when the re-adoption cue is "shall" (Codex review round 5, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 123,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Per issue #42: "confirmed in production before shipping" ' +
        'shall remain the acceptance gate.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue does not trip when a soft-wrap newline sits between the cited reference and its colon (Codex review round 5, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 124,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'Issue #42 asserted in its\nBackground: "confirmed in ' +
        'production: the deploy pipeline paused for six hours" -- ' +
        'describing a specific event.',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'orphan');
});

test('classifyIssue still trips when a blank line (a real paragraph break) separates an unrelated reference from the quote (Codex review round 5, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 125,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        'See #42.\n\nAcceptance gate: "confirmed in production before ' +
        'shipping, per the runbook."',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when an internal plural possessive in a single-quoted excerpt sits before the real closer (Copilot/Codex review round 6, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 126,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        "Per issue #42: 'confirmed in production according to the " +
        "operators' detailed report describing the incident timeline " +
        "in full' remains required.",
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('classifyIssue still trips when separate Markdown bullets without a blank line connect an unrelated reference to a live gate (Codex review round 6, PR #2760)', () => {
  const result = classifyIssue(
    {
      number: 127,
      title: 't',
      state: 'OPEN',
      labels: [],
      body:
        '- Related issue #42\n- Acceptance gate: "confirmed in ' +
        'production before shipping"',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.reason, 'runtime_observation_precondition');
});

test('filterOrphanIssues buckets a runtime-observation precondition under filtered.runtime_observation_precondition (#2467)', async () => {
  const issues = [
    {
      number: 106,
      title: 'gated follow-up',
      state: 'OPEN',
      labels: [],
      body: 'Start only after the fix is confirmed in production.',
      url: 'https://example.com/106',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.runtime_observation_precondition.length, 1);
  assert.equal(result.filtered.runtime_observation_precondition[0].number, 106);
});

// #1721: discover-orphan-filter was one of three helpers that silently
// swallowed every --policy load failure into `{}` (fail-open), including
// an explicitly-supplied path. It now routes through idd-config.mts's
// loadPolicyConfig, which fails closed for both the explicit and the
// default (malformed, non-ENOENT) path.

test('CLI path fails when an explicit --policy file is invalid', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-orphan-filter-policy-'),
  );
  const policyPath = join(tempRoot, 'bad-policy.json');
  const restore = stubGhRepoView();
  try {
    writeFileSync(policyPath, '{not-json');

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(REPO_ROOT, 'scripts/discover-orphan-filter.mjs'),
            '--policy',
            policyPath,
          ],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env },
            // #3434: suppress the duplicate raw-stderr relay execFileSync
            // performs when no `stdio` override is given.
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      /failed to load policy from .*bad-policy\.json/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI path fails when the default-path config exists but is malformed (not silently treated as absent)', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-orphan-filter-default-policy-'),
  );
  const restore = stubGhRepoView();
  try {
    mkdirSync(join(tempRoot, '.github', 'idd'), { recursive: true });
    writeFileSync(join(tempRoot, '.github', 'idd', 'config.json'), '{not-json');

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [join(REPO_ROOT, 'scripts/discover-orphan-filter.mjs')],
          {
            cwd: tempRoot,
            encoding: 'utf8',
            env: { ...process.env },
            // #3434: suppress the duplicate raw-stderr relay execFileSync
            // performs when no `stdio` override is given.
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      /failed to load policy from .*config\.json/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #3675: the forced-handoff mode reaches the claim-state annotation through
// loadPolicy and buildOrphanClaimState, so a handoff successor is reported.
// ---------------------------------------------------------------------------

function loadPolicyFromConfig(config: unknown) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-orphan-filter-fh-policy-'));
  try {
    const policyPath = join(tempRoot, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(config));
    return loadPolicy(policyPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('loadPolicy carries the normalized forced-handoff mode (#3675)', () => {
  assert.equal(
    loadPolicyFromConfig({ forcedHandoff: { mode: 'human-gated' } })
      .forcedHandoff.mode,
    'human-gated',
  );
  assert.equal(
    loadPolicyFromConfig({ forcedHandoffMode: 'human-gated' }).forcedHandoff
      .mode,
    'human-gated',
  );
  assert.equal(loadPolicyFromConfig({}).forcedHandoff.mode, 'disabled');
});

test('a human-gated policy makes the annotation follow a handoff successor (#3675)', async () => {
  const handoffAt = '2026-06-25T10:00:00Z';
  const comments = new Map<number, unknown[]>([
    [
      701,
      [
        claimComment('agent-a', 'claim-701', '2026-06-24T09:00:00Z'),
        {
          body: renderForcedHandoffComment({
            oldAgentId: 'agent-a',
            oldClaimId: 'claim-701',
            newAgentId: 'agent-b',
            newClaimId: 'claim-701-new',
            branch: 'issue/701-task',
            forcedBy: 'kurone-kito',
            reason: 'operator-approved-recovery',
            timestamp: handoffAt,
            contextScope: 'issue-only',
          }),
          createdAt: handoffAt,
          author: { login: 'kurone-kito' },
          lastEditedAt: null,
        },
      ],
    ],
  ]);
  const { resolution: base } = buildClaimState(comments);

  for (const [config, expectedClaimId, expectedStale] of [
    [{ forcedHandoff: { mode: 'human-gated' } }, 'claim-701-new', false],
    [{}, 'claim-701', true],
  ] as const) {
    const policy = loadPolicyFromConfig(config);
    const resolution = {
      ...buildOrphanClaimState(createFakeProviderAdapter({}), policy, ''),
      // Keep the wired mode; replace only the network, clock, and local
      // worktree inputs.
      loadComments: base.loadComments,
      isTrustedAuthor: base.isTrustedAuthor,
      nowIso: CLAIM_NOW,
      inspectLocalWorktree: () => ({
        status: 'absent' as const,
        paths: [],
        reason: null,
      }),
    };

    const result = await filterOrphanIssues(claimOrphanIssues(), {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      claimState: resolution,
    });

    const orphan701 = new Map(result.orphans.map((o) => [o.number, o])).get(
      701,
    );
    assert.equal(orphan701?.activeClaim?.claimId, expectedClaimId);
    assert.equal(orphan701?.activeClaim?.stale, expectedStale);
  }
});

// ---------------------------------------------------------------------------
// #3675: --now sets the claim-state annotation's clock.
// ---------------------------------------------------------------------------

test('resolveClaimStateNow returns the normalized clock only with --with-claim-state (#3675)', () => {
  assert.equal(
    resolveClaimStateNow({
      withClaimState: true,
      now: '2026-06-25T21:00:00+09:00',
    }),
    '2026-06-25T12:00:00Z',
  );
  // Not used without the annotation, and never validated there.
  assert.equal(
    resolveClaimStateNow({ withClaimState: false, now: 'not a date' }),
    undefined,
  );
  // An empty value is "not provided".
  assert.equal(
    resolveClaimStateNow({ withClaimState: true, now: '' }),
    undefined,
  );
});

test('resolveClaimStateNow rejects a malformed --now as a usage error (#3675)', () => {
  for (const now of ['Sep 27 2026', '2026-09-27', '2026-02-30T00:00:00Z']) {
    assert.throws(() => resolveClaimStateNow({ withClaimState: true, now }), {
      message: NOW_FLAG_USAGE_MESSAGE,
    });
  }
});

test('--now moves stale for the claim annotation (#3675)', async () => {
  const comments = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', '2026-06-24T12:00:00Z')]],
  ]);
  const { resolution: base } = buildClaimState(comments);
  const policy = loadPolicyFromConfig({});

  for (const [now, expectedStale] of [
    ['2026-06-25T11:00:00Z', false],
    ['2026-06-25T13:00:00Z', true],
  ] as const) {
    const claimState = buildOrphanClaimState(
      createFakeProviderAdapter({}),
      policy,
      '',
      resolveClaimStateNow({ withClaimState: true, now }),
    );
    assert.equal(claimState.nowIso, now);

    const result = await filterOrphanIssues(claimOrphanIssues(), {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      claimState: {
        ...claimState,
        loadComments: base.loadComments,
        isTrustedAuthor: base.isTrustedAuthor,
        inspectLocalWorktree: () => ({
          status: 'absent' as const,
          paths: [],
          reason: null,
        }),
      },
    });

    const orphan701 = new Map(result.orphans.map((o) => [o.number, o])).get(
      701,
    );
    assert.equal(orphan701?.activeClaim?.stale, expectedStale, now);
  }
});

test('CLI: a malformed or missing --now is a usage error before any gh call (#3675)', () => {
  // Every gh invocation fails loudly, so a pass proves the check ran before
  // the repository lookup or any read.
  const restore = stubExecutable(
    'gh',
    `process.stderr.write("unexpected gh invocation: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`,
  );
  try {
    for (const [args, message] of [
      [
        ['--with-claim-state', '--now', 'Sep 27 2026'],
        /--now must be an ISO 8601 date-time/u,
      ],
      // A flag in the value position is not swallowed as the clock.
      [['--now', '--with-claim-state'], /missing value for argument: --now/u],
      [['--with-claim-state', '--now'], /missing value for argument: --now/u],
    ] as const) {
      const result = spawnHelperBinWithEnvelope(
        'idd-discover-orphan-filter.mjs',
        args,
      );
      const label = `${args.join(' ')}: ${JSON.stringify(result)}`;
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, message, label);
      assert.doesNotMatch(result.stderr, /unexpected gh invocation/u, label);
      // The helper's usage-error shape, like an invalid --pr.
      assert.equal(result.envelope?.kind, 'usage', label);
      assert.equal(result.envelope?.exitCode, 1, label);
    }
  } finally {
    restore();
  }
});

test('#4493: --exclude-issue validates before GitHub reads and accepts repeats', () => {
  const restore = stubExecutable(
    'gh',
    `process.stderr.write("unexpected gh invocation: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`,
  );
  try {
    for (const [args, message] of [
      [['--exclude-issue'], /missing value for argument: --exclude-issue/u],
      [
        ['--exclude-issue', '--autopilot'],
        /missing value for argument: --exclude-issue/u,
      ],
      [['--exclude-issue', 'nope'], /invalid --exclude-issue value: nope/u],
      [['--exclude-issue', '0'], /invalid --exclude-issue value: 0/u],
      [['--exclude-issue', '1x'], /invalid --exclude-issue value: 1x/u],
      [
        ['--exclude-issue', '9007199254740992'],
        /invalid --exclude-issue value: 9007199254740992/u,
      ],
    ] as const) {
      const result = spawnHelperBinWithEnvelope(
        'idd-discover-orphan-filter.mjs',
        args,
      );
      const label = `${args.join(' ')}: ${JSON.stringify(result)}`;
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, message, label);
      assert.doesNotMatch(result.stderr, /unexpected gh invocation/u, label);
      assert.equal(result.envelope?.kind, 'usage', label);
    }
  } finally {
    restore();
  }
});

test('#4493: hint-cache keys include distinct and empty exclusion sets', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-roadmap-leaf-exclusion-cache-'));
  const workspace = join(root, 'workspace');
  const cacheHome = join(root, 'cache');
  const issues = [
    {
      number: 4401,
      title: 'markerless roadmap leaf',
      state: 'open',
      labels: [],
      body: 'No roadmap marker is present.',
      url: 'https://example.com/4401',
      html_url: 'https://example.com/4401',
    },
    {
      number: 4402,
      title: 'independent orphan',
      state: 'open',
      labels: [],
      body: '',
      url: 'https://example.com/4402',
      html_url: 'https://example.com/4402',
    },
  ];
  mkdirSync(join(workspace, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(workspace, '.github', 'idd', 'config.json'),
    JSON.stringify({ githubApi: { readCache: { enabled: true } } }),
  );
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api') {
  const path = args[1] || '';
  if (path.startsWith('repos/kurone-kito/idd-skill/issues?state=open')) {
    process.stdout.write(JSON.stringify(${JSON.stringify(issues)}) + '\\n');
    process.exit(0);
  }
  process.stdout.write('[]\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  const savedGhToken = process.env.GH_TOKEN;
  process.env.XDG_CACHE_HOME = cacheHome;
  process.env.GH_TOKEN = 'idd-test-cache-token';
  try {
    const run = (extraArgs: string[]) => {
      const result = spawnHelperBinWithEnvelope(
        'idd-discover-orphan-filter.mjs',
        ['--owner', 'kurone-kito', '--repo', 'idd-skill', ...extraArgs],
        { cwd: workspace },
      );
      assert.equal(result.status, 0, JSON.stringify(result));
      return JSON.parse(result.stdout) as {
        orphans: { number: number }[];
        filtered: { excluded_roadmap_leaf: { number: number }[] };
        cache: { mode: string; source: string; complete: boolean };
      };
    };

    const first = run(['--exclude-issue', '4401', '--exclude-issue', '4401']);
    assert.deepEqual(first.cache, {
      mode: 'hint',
      source: 'live',
      ageMs: 0,
      maxAgeMs: 300000,
      complete: true,
      enumerations: 1,
      exhaustionRefresh: false,
    });
    assert.deepEqual(
      first.orphans.map((issue) => issue.number),
      [4402],
    );
    assert.deepEqual(
      first.filtered.excluded_roadmap_leaf.map((issue) => issue.number),
      [4401],
    );

    const second = run(['--exclude-issue', '4402']);
    assert.equal(second.cache.source, 'live');
    assert.deepEqual(
      second.orphans.map((issue) => issue.number),
      [4401],
    );
    assert.deepEqual(
      second.filtered.excluded_roadmap_leaf.map((issue) => issue.number),
      [4402],
    );

    const empty = run([]);
    assert.equal(empty.cache.source, 'live');
    assert.deepEqual(
      empty.orphans.map((issue) => issue.number).sort((a, b) => a - b),
      [4401, 4402],
    );
    assert.deepEqual(empty.filtered.excluded_roadmap_leaf, []);

    const emptyRepeat = run([]);
    assert.equal(emptyRepeat.cache.source, 'hint');
    assert.deepEqual(emptyRepeat.orphans, empty.orphans);
  } finally {
    restore();
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
    if (savedGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = savedGhToken;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #2243: triage-verdict marker exclusion (fetchCommentsByIssueNumber /
// fetchTimelineByIssueNumber / trustedMarkerLogins), covering the four
// acceptance-criteria scenarios: marker present and current (skip), marker
// present but stale relative to a later body edit (do not skip), no marker
// / never-triaged (do not skip), and an untrusted/forged marker comment (do not
// skip -- same #1887 trust boundary).
// ---------------------------------------------------------------------------

function triageVerdictIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 901,
    title: 'candidate 901',
    state: 'OPEN',
    labels: [],
    body: '',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function triageVerdictRejectionComment(
  outcome: string,
  createdAt: string,
  { author = 'kurone-kito' } = {},
) {
  return {
    body: `${SUITABILITY_REJECTION_PREFIX} — Check 2 (Coherence): reason.\n\n<!-- idd-skill-triage-verdict: ${outcome} -->`,
    created_at: createdAt,
    user: { login: author },
  };
}

test('without trustedMarkerLogins, the comments fetcher is never invoked and nothing is excluded (byte-stable default)', async () => {
  const issues = [triageVerdictIssue()];
  let called = false;
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    // A real spy fetcher is supplied, but trustedMarkerLogins is omitted --
    // if the guard were broken, `called` would flip to true below.
    fetchCommentsByIssueNumber: () => {
      called = true;
      return [];
    },
    trustedMarkerLogins: undefined,
  });
  assert.equal(called, false);
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

test('a current trusted triage-verdict marker excludes the candidate', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: (issueNumber) =>
      issueNumber === 901
        ? [triageVerdictRejectionComment('duplicate', '2026-08-10T00:00:00Z')]
        : [],
    fetchTimelineByIssueNumber: () => [],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.triage_verdict_rejected.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected[0]?.number, 901);
  assert.equal(
    result.filtered.triage_verdict_rejected[0]?.details,
    'duplicate',
  );
});

test('a stale marker (issue edited after the rejection) does not exclude the candidate', async () => {
  const issues = [triageVerdictIssue({ createdAt: '2026-08-01T00:00:00Z' })];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-05T00:00:00Z'),
    ],
    // A body edit landed AFTER the rejection comment -- the marker is stale.
    fetchTimelineByIssueNumber: () => [
      {
        event: 'edited',
        created_at: '2026-08-12T00:00:00Z',
        changes: { body: {} },
      },
    ],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

test('no marker (never-triaged) does not exclude the candidate', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [],
    fetchTimelineByIssueNumber: () => [],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

test("an untrusted actor's marker-bearing comment does not exclude the candidate (#1887 trust boundary)", async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-10T00:00:00Z', {
        author: 'random-untrusted-user',
      }),
    ],
    fetchTimelineByIssueNumber: () => [],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

test('a throwing comments fetcher fails open: the candidate stays selectable (CodeRabbit review, PR #2557)', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => {
      throw new Error('transient GitHub API failure');
    },
    fetchTimelineByIssueNumber: () => [],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

test('a throwing timeline fetcher fails open: the candidate stays selectable (CodeRabbit review, PR #2557)', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-10T00:00:00Z'),
    ],
    fetchTimelineByIssueNumber: () => {
      throw new Error('transient GitHub API failure');
    },
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

// #2762: parity coverage for the same anchor extension already tested in
// discover-readiness-check.test.mts -- this file's triage-verdict call
// site takes the identical two-fetcher shape.

test('a stale marker becomes ready again via userContentEdits when the REST timeline has no edited event (#2738 fixture, #2762)', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-05T00:00:00Z'),
    ],
    fetchTimelineByIssueNumber: () => [
      { event: 'commented', created_at: '2026-08-06T00:00:00Z' },
      { event: 'labeled', created_at: '2026-08-07T00:00:00Z' },
    ],
    fetchUserContentEditsByIssueNumber: () => ['2026-08-12T00:00:00Z'],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

// E2 critique (PR #2836): the positive case above only proves a LATER
// userContentEdits signal clears staleness -- also prove the negative:
// an EARLIER one must not, end to end through this file's own pipeline.

test('a userContentEdits timestamp before the rejection leaves the marker current (negative case, #2762)', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-10T00:00:00Z'),
    ],
    fetchTimelineByIssueNumber: () => [],
    // The body edit landed BEFORE the rejection -- the marker is still
    // current.
    fetchUserContentEditsByIssueNumber: () => ['2026-08-05T00:00:00Z'],
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.triage_verdict_rejected.length, 1);
  assert.equal(
    result.filtered.triage_verdict_rejected[0]?.details,
    'duplicate',
  );
});

test('a throwing userContentEdits fetcher fails open: the candidate stays selectable, never falling back to createdAt (#2762)', async () => {
  const issues = [triageVerdictIssue()];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    fetchCommentsByIssueNumber: () => [
      triageVerdictRejectionComment('duplicate', '2026-08-10T00:00:00Z'),
    ],
    fetchTimelineByIssueNumber: () => [],
    fetchUserContentEditsByIssueNumber: () => {
      throw new Error('transient GitHub GraphQL failure');
    },
    trustedMarkerLogins: ['kurone-kito'],
  });
  assert.equal(result.orphans.length, 1);
  assert.equal(result.filtered.triage_verdict_rejected.length, 0);
});

// #4065: a defer-source follow-up is blocked while its single Refs origin
// issue is open, the origin rule A3's readiness check already applies.
const DEFER_MARKER =
  '<!-- idd-skill-authoring-defer-source: review-fix-loop-cutoff -->';

function deferFollowUp(body: string) {
  return {
    number: 4059,
    title: 'follow-up deferred from #4019',
    state: 'OPEN',
    labels: [],
    body,
    url: 'https://example.com/4059',
  };
}

test('#4065: classifyIssue blocks a defer-source follow-up while its Refs origin is open', () => {
  const verdict = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n`),
    {
      issueStateByNumber: new Map([[4019, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(verdict.orphan, false);
  assert.equal(verdict.reason, 'blocked_by_defer_source_origin');
  assert.equal(verdict.details, 'open:#4019');
});

test('#4065: classifyIssue reports a missing and an ambiguous Refs line as blocked', () => {
  const options = {
    issueStateByNumber: new Map<number, string>(),
    fetchIssueStateByNumber: () => 'CLOSED',
  };
  const missing = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nNo origin named.\n`),
    options,
  );
  assert.equal(missing.reason, 'blocked_by_defer_source_origin');
  assert.equal(missing.details, 'missing_refs_line');

  const ambiguous = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n\nRefs #4020\n`),
    options,
  );
  assert.equal(ambiguous.reason, 'blocked_by_defer_source_origin');
  assert.equal(ambiguous.details, 'ambiguous_refs_line');
});

test('#4065: classifyIssue reports an unresolvable origin with its bare number', () => {
  const verdict = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n`),
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(verdict.reason, 'blocked_by_defer_source_origin');
  assert.equal(verdict.details, 'unresolvable:#4019');
  assert.equal((verdict as { originNumber?: number }).originNumber, 4019);
});

test('#4065: a closed origin keeps the defer-source follow-up an orphan', () => {
  const verdict = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n`),
    {
      issueStateByNumber: new Map([[4019, 'CLOSED']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(verdict.orphan, true);
  assert.equal(verdict.reason, 'orphan');
});

test('#4065: a body without a defer-source marker is unchanged by an open Refs origin', () => {
  const verdict = classifyIssue(deferFollowUp('Refs #4019\n'), {
    issueStateByNumber: new Map([[4019, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.equal(verdict.orphan, true);
  assert.equal(verdict.reason, 'orphan');
});

test('#4065: an open Blocked by reference keeps precedence over the defer-source origin', () => {
  const verdict = classifyIssue(
    deferFollowUp(`${DEFER_MARKER}\n\nBlocked by #20\n\nRefs #4019\n`),
    {
      issueStateByNumber: new Map([
        [20, 'OPEN'],
        [4019, 'OPEN'],
      ]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(verdict.reason, 'blocked_by_open_reference');
});

test('#4065: filterOrphanIssues lists the blocked and unresolvable origins and zeroes the new key', async () => {
  const result = await filterOrphanIssues(
    [
      deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n`),
      {
        number: 4060,
        title: 'plain orphan',
        state: 'OPEN',
        labels: [],
        body: 'No references.',
        url: 'https://example.com/4060',
      },
    ],
    {
      issueStateByNumber: new Map([[4019, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.filtered.blocked_by_defer_source_origin.length, 1);
  assert.equal(
    result.filtered.blocked_by_defer_source_origin[0].details,
    'open:#4019',
  );
  assert.equal(result.counts.filtered.blocked_by_defer_source_origin, 1);
  assert.deepEqual(
    result.orphans.map((orphan) => orphan.number),
    [4060],
  );
  assert.deepEqual(result.unresolvable, []);
});

test('#4065: filterOrphanIssues reports an unresolvable defer-source origin as a top-level unresolvable entry', async () => {
  const result = await filterOrphanIssues(
    [deferFollowUp(`${DEFER_MARKER}\n\nRefs #4019\n`)],
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(result.filtered.blocked_by_defer_source_origin.length, 1);
  assert.deepEqual(result.unresolvable, [
    { issue: 4059, reference: 4019, reason: 'issue-not-found-or-inaccessible' },
  ]);
});

// #4065 review fix: both defer-source values reach the same origin states.
for (const value of ['review-fix-loop-cutoff', 'review-needs-decision']) {
  const marker = `<!-- idd-skill-authoring-defer-source: ${value} -->`;
  test(`#4065: the ${value} marker is blocked on each origin state`, () => {
    const withOrigin = (body: string) => deferFollowUp(`${marker}\n\n${body}`);
    const open = classifyIssue(withOrigin('Refs #4019\n'), {
      issueStateByNumber: new Map([[4019, 'OPEN']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    });
    assert.equal(open.reason, 'blocked_by_defer_source_origin');
    assert.equal(open.details, 'open:#4019');

    const missing = classifyIssue(withOrigin('No origin named.\n'), {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'CLOSED',
    });
    assert.equal(missing.details, 'missing_refs_line');

    const ambiguous = classifyIssue(withOrigin('Refs #4019\n\nRefs #4020\n'), {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'CLOSED',
    });
    assert.equal(ambiguous.details, 'ambiguous_refs_line');

    const unresolvable = classifyIssue(withOrigin('Refs #4019\n'), {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    });
    assert.equal(unresolvable.details, 'unresolvable:#4019');
    assert.equal(
      (unresolvable as { originNumber?: number }).originNumber,
      4019,
    );

    const closed = classifyIssue(withOrigin('Refs #4019\n'), {
      issueStateByNumber: new Map([[4019, 'CLOSED']]),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    });
    assert.equal(closed.reason, 'orphan');
  });
}

// #4065 review fix (Codex P2): colliding authoring and needs-decision labels
// keep a review-needs-decision follow-up blocked even with a closed origin.
test('#4065: a colliding authoring and needs-decision label blocks a review-needs-decision follow-up', () => {
  const body = `<!-- idd-skill-authoring-defer-source: review-needs-decision -->\n\nRefs #4019\n`;
  const closedOrigin = {
    issueStateByNumber: new Map([[4019, 'CLOSED']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  };

  const colliding = classifyIssue(deferFollowUp(body), {
    ...closedOrigin,
    authoringLabelName: 'status:needs-decision',
    needsDecisionLabelName: 'status:needs-decision',
  });
  assert.equal(colliding.reason, 'blocked_by_defer_source_origin');
  assert.equal(
    colliding.details,
    'needs_decision_label_conflicts_with_authoring_label',
  );

  const distinct = classifyIssue(deferFollowUp(body), {
    ...closedOrigin,
    authoringLabelName: 'status:authoring',
    needsDecisionLabelName: 'status:needs-decision',
  });
  assert.equal(distinct.orphan, true);
});

test('classifyIssue excludes the configured authoring journal by number (#4115)', () => {
  const journal = {
    number: 2674,
    title: 'Issue-authoring durable journal',
    state: 'OPEN',
    labels: [],
    body: 'No markers, no labels -- a durable journal, not work.',
  };
  const excluded = classifyIssue(journal, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    authoringJournalTarget: 2674,
  });
  assert.equal(excluded.orphan, false);
  assert.equal(excluded.reason, 'authoring_journal_target');

  const other = classifyIssue(
    { ...journal, number: 2675 },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      authoringJournalTarget: 2674,
    },
  );
  assert.equal(other.orphan, true);
});

test('filterOrphanIssues buckets the journal apart from the outage target (#4115)', async () => {
  const issue = (number: number, title: string) => ({
    number,
    title,
    state: 'OPEN',
    labels: [],
    body: '',
    url: `https://example.com/${number}`,
  });
  const result = await filterOrphanIssues(
    [
      issue(2674, 'authoring journal'),
      issue(158, 'provider outage target'),
      issue(51, 'ordinary orphan'),
    ],
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      providerOutageDeclarationTarget: 158,
      authoringJournalTarget: 2674,
    },
  );
  assert.deepEqual(
    result.orphans.map((orphan) => orphan.number),
    [51],
  );
  assert.deepEqual(
    result.filtered.authoring_journal_target.map((entry) => entry.number),
    [2674],
  );
  assert.deepEqual(
    result.filtered.provider_outage_target.map((entry) => entry.number),
    [158],
  );
});

test('filterOrphanIssues gives the outage reason precedence on a shared number (#4115)', async () => {
  const result = await filterOrphanIssues(
    [
      {
        number: 9,
        title: 'shared',
        state: 'OPEN',
        labels: [],
        body: '',
        url: 'https://example.com/9',
      },
    ],
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      providerOutageDeclarationTarget: 9,
      authoringJournalTarget: 9,
    },
  );
  assert.equal(result.filtered.provider_outage_target.length, 1);
  assert.equal(result.filtered.authoring_journal_target.length, 0);
});

test('loadPolicy carries the raw journal reference, or null when absent (#4115)', () => {
  const withJournal = loadPolicyFromConfig({
    issueAuthoring: { journalIssue: 'kurone-kito/idd-skill#2674' },
  });
  assert.equal(
    withJournal.authoringJournalReference,
    'kurone-kito/idd-skill#2674',
  );
  const absent = loadPolicyFromConfig({});
  assert.equal(absent.authoringJournalReference, null);
});

test('filterOrphanIssues routes effort L orphans only under autopilot with effortLPolicy refuse (#4199)', async () => {
  const score5 = '<!-- idd-skill-autopilot-suitability: 5 -->';
  const issues = [
    {
      number: 1,
      title: 'large',
      state: 'OPEN',
      body: `task\n${score5}\n<!-- idd-skill-effort: L -->`,
    },
    {
      number: 2,
      title: 'small',
      state: 'OPEN',
      body: `task\n${score5}\n<!-- idd-skill-effort: S -->`,
    },
    // Unscored: effort L still routes, because effort is a separate axis.
    {
      number: 3,
      title: 'unscored large',
      state: 'OPEN',
      body: 'task\n<!-- idd-skill-effort: L -->',
    },
  ];
  const base = {
    issueStateByNumber: new Map<number, string>(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
  };

  const refused = await filterOrphanIssues(issues, {
    ...base,
    autopilot: true,
    effortLPolicy: 'refuse',
  });
  assert.deepEqual(
    refused.routed_to_human.map((o) => o.number),
    [1, 3],
  );
  assert.deepEqual(
    refused.orphans.map((o) => o.number),
    [2],
  );
  assert.equal(refused.counts.routed_to_human, 2);

  // The score kill-switch does not switch off effort L routing.
  const scoreDisabled = await filterOrphanIssues(issues, {
    ...base,
    autopilot: true,
    autopilotSuitabilityEnabled: false,
    effortLPolicy: 'refuse',
  });
  assert.deepEqual(
    scoreDisabled.routed_to_human.map((o) => o.number),
    [1, 3],
  );
  assert.deepEqual(
    scoreDisabled.orphans.map((o) => o.number),
    [2],
  );

  const attended = await filterOrphanIssues(issues, {
    ...base,
    autopilot: false,
    effortLPolicy: 'refuse',
  });
  assert.deepEqual(attended.routed_to_human, []);
  assert.deepEqual(attended.orphans.map((o) => o.number).sort(), [1, 2, 3]);

  const allowed = await filterOrphanIssues(issues, {
    ...base,
    autopilot: true,
    effortLPolicy: 'allow',
  });
  assert.deepEqual(allowed.routed_to_human, []);
  assert.deepEqual(allowed.orphans.map((o) => o.number).sort(), [1, 2, 3]);
});

test('loadPolicy sets effortLPolicy refuse only for autopilotSuitability.effortL refuse (#4199)', () => {
  assert.equal(
    loadPolicyFromConfig({ autopilotSuitability: { effortL: 'refuse' } })
      .effortLPolicy,
    'refuse',
  );
  assert.equal(
    loadPolicyFromConfig({ autopilotSuitability: { effortL: 'allow' } })
      .effortLPolicy,
    'allow',
  );
  assert.equal(loadPolicyFromConfig({}).effortLPolicy, 'allow');
});

test('CLI: effortLPolicy refuse routes effort L orphans through produceOutput under --autopilot (#4199)', () => {
  // The unit tests above call filterOrphanIssues directly, so the
  // produceOutput wiring is only reached through the real CLI. The gh stub
  // serves the open-issue list and answers the per-issue reads with no data;
  // any other gh call fails loudly.
  const issues = [
    {
      number: 1,
      title: 'large',
      state: 'open',
      body: 'task\n<!-- idd-skill-autopilot-suitability: 5 -->\n<!-- idd-skill-effort: L -->',
      labels: [],
      html_url: 'https://github.com/kurone-kito/idd-skill/issues/1',
      user: { login: 'kurone-kito' },
      created_at: '2026-01-01T00:00:00Z',
      milestone: null,
    },
    {
      number: 2,
      title: 'small',
      state: 'open',
      body: 'task\n<!-- idd-skill-autopilot-suitability: 5 -->\n<!-- idd-skill-effort: S -->',
      labels: [],
      html_url: 'https://github.com/kurone-kito/idd-skill/issues/2',
      user: { login: 'kurone-kito' },
      created_at: '2026-01-01T00:00:00Z',
      milestone: null,
    },
  ];
  const script = `const ISSUES = ${JSON.stringify(issues)};
const args = process.argv.slice(2);
if (args[0] === "api") {
  const path = args[1] || "";
  if (path.startsWith("repos/kurone-kito/idd-skill/issues?state=open")) {
    process.stdout.write(JSON.stringify(ISSUES) + "\\n");
    process.exit(0);
  }
  if (/^repos\\/kurone-kito\\/idd-skill\\/issues\\/\\d+\\/(comments|timeline|events)/.test(path)) {
    process.stdout.write("[]\\n");
    process.exit(0);
  }
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
  const dir = mkdtempSync(join(tmpdir(), 'idd-orphan-effort-l-'));
  const restore = stubExecutable('gh', script);
  try {
    const refusePolicy = join(dir, 'refuse.json');
    writeFileSync(
      refusePolicy,
      JSON.stringify({ autopilotSuitability: { effortL: 'refuse' } }),
    );
    const refused = spawnHelperBinWithEnvelope(
      'idd-discover-orphan-filter.mjs',
      [
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
        '--policy',
        refusePolicy,
        '--autopilot',
        '--no-cache',
      ],
    );
    assert.equal(refused.status, 0, JSON.stringify(refused));
    const refusedOutput = JSON.parse(refused.stdout);
    assert.deepEqual(
      refusedOutput.routed_to_human.map((o: { number: number }) => o.number),
      [1],
    );
    assert.deepEqual(
      refusedOutput.orphans.map((o: { number: number }) => o.number),
      [2],
    );

    // Without the opt-in key, the same run keeps both orphans, ranked by
    // score and then effort (S before L).
    const defaultPolicy = join(dir, 'default.json');
    writeFileSync(defaultPolicy, '{}');
    const defaulted = spawnHelperBinWithEnvelope(
      'idd-discover-orphan-filter.mjs',
      [
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
        '--policy',
        defaultPolicy,
        '--autopilot',
        '--no-cache',
      ],
    );
    assert.equal(defaulted.status, 0, JSON.stringify(defaulted));
    const defaultOutput = JSON.parse(defaulted.stdout);
    assert.deepEqual(defaultOutput.routed_to_human, []);
    assert.deepEqual(
      defaultOutput.orphans.map((o: { number: number }) => o.number),
      [2, 1],
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
