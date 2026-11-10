// Issue #4138: a work session that finds the diff larger than the issue's
// effort estimate used to return the issue to authoring and release its claim.
// Issue #5093 made a count over a coherent S or M estimate advisory drift: one
// evidence-backed plan reassessment, then the same claim continues. The
// release-and-split route below now needs a reason other than the number (or
// unusable effort evidence), and it never asks a human or applies the
// needs-decision label.
//
// The count itself is measured with the shipped authoring-time rule (#4130's
// `effort-candidate-file-limit` check and its threshold table), which still
// fails authoring admission unchanged. The standard work instructions delegate
// to the shared helper documentation; Lite keeps the sequence in its
// self-contained file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditAuthoredIssue,
  EFFORT_CANDIDATE_FILE_LIMITS,
} from '../src/scripts/audit-authored-issue.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK_PHASE_PATHS = [
  'idd-template/.github/instructions/idd-work.instructions.md',
  '.github/instructions/idd-work.instructions.md',
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** The B3 `**Scope overrun**` paragraph, unwrapped onto one line. */
function scopeOverrunRoute(relativePath: string): string {
  const text = readRepoFile(relativePath);
  const start = text.indexOf('**Scope overrun**');
  assert.notEqual(start, -1, `${relativePath} names the overrun route`);
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

/** The verified, body-safe report route for advisory drift in a work file. */
function scopeCorrectionRoute(relativePath: string): string {
  const text = readRepoFile(relativePath).replace(/\s+/gu, ' ');
  const start =
    [
      text.indexOf('**Read-only S-to-M correction and advisory drift**'),
      text.indexOf('**S-to-M correction and advisory drift**'),
    ].find((position) => position >= 0) ?? -1;
  const end = text.indexOf('**Scope overrun**', start);
  assert.notEqual(start, -1, `${relativePath} has the correction cue`);
  assert.notEqual(end, -1, `${relativePath} retains the overrun route`);
  return text.slice(start, end);
}

/** The shared B3 overrun route referenced by the standard work files. */
function scopeAssessmentOutcomes(): string {
  const text = readRepoFile('docs/idd-helper-scripts.md').replace(/\s+/gu, ' ');
  const start = text.indexOf('### B3 scope assessment outcomes');
  const end = text.indexOf('## Dead-export audit', start);
  assert.notEqual(start, -1, 'the shared B3 outcomes are documented');
  assert.notEqual(end, -1, 'the shared B3 outcomes have a section boundary');
  return text.slice(start, end);
}

/**
 * An issue body whose `## Candidate files` lists the diff's changed
 * files, so the shipped threshold rule measures the real scope against
 * the author's effort estimate.
 */
function issueWithChangedFiles(
  effort: string | null,
  changedFiles: number,
  extraLines: readonly string[] = [],
): string {
  const paths = Array.from(
    { length: changedFiles },
    (_, index) => `- \`src/scripts/changed-${index + 1}.mts\``,
  );
  return [
    '# Add a sample feature',
    '',
    '## Background',
    '',
    'Context.',
    '',
    ...extraLines,
    '## Proposed change',
    '',
    'Implement the task.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] tests pass',
    '',
    '## Candidate files',
    '',
    ...paths,
    '',
    '---',
    '',
    '_Autopilot suitability: 5 / 5 -- higher is more autopilot-suitable;',
    'below the configured floor is human-oriented._',
    '',
    '<!-- idd-skill-autopilot-suitability: 5 -->',
    ...(effort === null
      ? []
      : [
          '',
          `_Effort: ${effort} -- author-estimated size; a soft autopilot`,
          'selection tie-breaker only._',
          '',
          `<!-- idd-skill-effort: ${effort} -->`,
        ]),
  ].join('\n');
}

function thresholdFinding(
  effort: string | null,
  changedFiles: number,
  extraLines: readonly string[] = [],
) {
  const finding = auditAuthoredIssue(
    issueWithChangedFiles(effort, changedFiles, extraLines),
    { shape: 'child' },
  ).findings.find((entry) => entry.id === 'effort-candidate-file-limit');
  assert.ok(finding, 'the threshold rule runs on the fixture');
  return finding;
}

function isOverrun(effort: string | null, changedFiles: number): boolean {
  return thresholdFinding(effort, changedFiles).result === 'fail';
}

// Wording that would turn the overrun back into a human question. The one
// allowed mention of the label is the sentence that forbids a count alone from
// applying it.
const QUESTION_PATTERNS = [/needs-decision/i, /\bask\b/i, /\?/] as const;

const PROHIBITION = 'Never add needs-decision or ask a human';

/** Full and Lite word the "a number alone" rule differently; both must say it. */
const NUMBER_ALONE_FULL =
  'a number alone never causes a release, held split, needs-decision label, or count waiver';
const NUMBER_ALONE_SHARED =
  'A number alone never causes a release, held split, needs-decision label, or human count waiver.';
const NUMBER_ALONE_LITE =
  'a number alone never releases, splits, labels needs-decision, or needs a waiver';

/** The shared B3 no-advisory route, in the order the worker follows. */
const ORDERED_STEPS = [
  NUMBER_ALONE_SHARED,
  'When the helper returns no advisory disposition',
  'retain-and-stop rule above',
  'profile-selected',
  '`audit-authored-issue --shape child --stdin --marker-prefix {markerPrefix}`',
  'fails `effort-candidate-file-limit` on the issue body',
  '`## Candidate files` set to canonical changed paths',
  'stop coding without pushing',
  'Comment the reason, the estimate, candidate files, changed files, and split proposal',
  'release per the Abort rule (`unclaimed-by`)',
  'run `lost-claim-cleanup`',
  'With the companion, hand it the proposal as a held split draft',
  'held roadmap whose children record `Split out of #<n>`',
  'comments the link',
  'If refused, the comment stands',
  PROHIBITION,
] as const;

test('a diff over the effort estimate fails authoring admission; one within it does not', () => {
  const limitM = EFFORT_CANDIDATE_FILE_LIMITS.M;
  assert.equal(isOverrun('M', limitM + 1), true);
  assert.equal(isOverrun('M', limitM), false);
  const limitS = EFFORT_CANDIDATE_FILE_LIMITS.S;
  assert.equal(isOverrun('S', limitS + 1), true);
  assert.equal(isOverrun('S', limitS), false);
});

test('an issue within its estimate whose changed files exceed it fails the same audit, which is measurement only at runtime', () => {
  // The issue's own candidate list passes the check...
  assert.equal(isOverrun('M', 3), false);
  // ...but the same issue with the canonical changed files in place of its
  // candidate files fails it. The helper reads that failure as advisory drift.
  assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
});

test('an over-limit orphan fails the orphan shape as well, and the helper still audits the child shape (#4434)', () => {
  // The motivating overrun (#4064) was an orphan issue. Since #4434 the
  // orphan shape checks the same count, so this overrun fails under either
  // shape. The helper keeps --shape child because that shape does not add the
  // orphan-only section requirement, so a legacy S or M orphan with no section
  // passes the effort-limit finding. The child shape's
  // candidate-files-not-empty finding still reports the missing section, but
  // the scope step does not read that finding.
  const body = issueWithChangedFiles('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1);
  const findingFor = (shape: 'orphan' | 'child') =>
    auditAuthoredIssue(body, { shape }).findings.find(
      (entry) => entry.id === 'effort-candidate-file-limit',
    );
  assert.equal(findingFor('orphan')?.result, 'fail');
  assert.match(findingFor('orphan')?.detail ?? '', /exceeds the limit of 8/);
  assert.equal(findingFor('child')?.result, 'fail');
  assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
});

test('L and a missing effort hint are never checked, so they never receive a numerical verdict', () => {
  const over = EFFORT_CANDIDATE_FILE_LIMITS.M + 10;
  for (const effort of ['L', null]) {
    const finding = thresholdFinding(effort, over);
    assert.equal(finding.result, 'pass', String(effort));
    assert.match(finding.detail, /^not applicable:/, String(effort));
  }
});

test('a split child over the limit is exempt from authoring admission, so the exemption is not broadened', () => {
  const finding = thresholdFinding('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1, [
    'Split out of #1',
    '',
  ]);
  assert.equal(finding.result, 'pass');
  assert.match(finding.detail, /Split out of #<n> provenance line exempts it/);
});

test('the authoring contract keeps its threshold table and calls it admission policy, not runtime authority', () => {
  for (const relativePath of [
    'skills/issue-authoring/references/contract.md',
    '.claude/skills/issue-authoring/references/contract.md',
  ]) {
    const text = readRepoFile(relativePath).replace(/\s+/gu, ' ');
    const raw = readRepoFile(relativePath);
    assert.match(raw, /\| `S`\s+\| 3\s+\|/u, `${relativePath} keeps S`);
    assert.match(raw, /\| `M`\s+\| 8\s+\|/u, `${relativePath} keeps M`);
    assert.match(
      text,
      /authoring-time admission policy, and the fresh-discovery `L` routing below is a planning policy/u,
    );
    assert.match(text, /Neither is runtime authority/u);
    assert.match(
      text,
      /blob\/main\/idd-template\/docs\/idd-design-rationale\.md#b3--scope-overrun-returns-to-authoring/u,
      'the contract links the synchronized rationale source, not the root docs copy',
    );
    assert.match(text, /advisory drift that measures breadth, not intent/u);
    assert.match(
      text,
      /never a release, held split, `needs-decision` label, or count waiver on its own/u,
    );
  }
});

test('the rationale cites the incidents, limits the count, and reconciles the landed post-push work', () => {
  const text = readRepoFile(
    'idd-template/docs/idd-design-rationale.md',
  ).replace(/\s+/gu, ' ');
  const start = text.indexOf('**Count drift is advisory evidence');
  const end = text.indexOf('### C1 — Search sibling code', start);
  assert.notEqual(start, -1, 'the advisory-drift rationale exists');
  assert.notEqual(end, -1, 'the rationale has a section boundary');
  const section = text.slice(start, end);
  for (const cited of [
    'kurone-kito/idd-skill#4138',
    'kurone-kito/idd-skill#4064',
    'kurone-kito/idd-skill#3824',
    'kurone-kito/idd-skill#5030',
    'kurone-kito/idd-skill#5086',
    'kurone-kito/idd-skill#4932',
    'kurone-kito/idd-skill#5104',
  ]) {
    assert.ok(section.includes(cited), cited);
  }
  assert.match(
    section,
    /measures breadth\. It does not measure semantic intent/u,
  );
  assert.match(section, /planning proxy becomes execution authority/u);
  assert.match(section, /count stays a measurement, not a verdict/u);
  assert.match(section, /before global recurrence prevention can be claimed/u);
  assert.match(section, /still wait at F2 for that decision/u);
  assert.match(section, /still fails admission/u);
  assert.doesNotMatch(
    text,
    /so do M failures and more than eight actual paths/u,
    'the S-to-M history no longer routes counts above eight to the old stop',
  );
  assert.match(section, /no per-edit polling, and no new service/u);
});

for (const relativePath of WORK_PHASE_PATHS) {
  test(`${relativePath}: advisory drift states the reassessment criteria and never a count-only stop`, () => {
    const route = scopeCorrectionRoute(relativePath);
    assert.ok(route.includes('`assessment.correctionApplied: true`'));
    assert.ok(route.includes('`assessment.disposition: "advisory-drift"`'));
    assert.ok(route.includes('even above eight'));
    assert.ok(route.includes('no effort-L marker is written or assigned'));
    assert.ok(route.includes('one evidence-backed plan reassessment'));
    assert.ok(route.includes('one cohesive way to meet the accepted intent'));
    assert.ok(route.includes('needs no new authority or unresolved decision'));
    assert.ok(route.includes('feasible validation plan'));
    assert.ok(route.includes('continue the same claim'));
    assert.ok(route.includes('required after `correctionApplied: true`'));
  });

  test(`${relativePath}: scope overrun is reason-based and delegates to the shared B3 outcomes`, () => {
    const route = scopeOverrunRoute(relativePath);
    assert.ok(route.includes(NUMBER_ALONE_FULL));
    assert.ok(route.includes('unplanned follow-up work route above'));
    assert.ok(route.includes('blocker keeps its existing handling'));
    assert.ok(route.includes('returns no advisory disposition'));
    assert.ok(route.includes('unverified follows the retain-and-stop rule'));
    assert.ok(route.includes('scope assessment routes'));
    assert.ok(route.includes('#b3-scope-assessment-outcomes'));
    assert.ok(route.includes('stop without pushing'));
  });

  test(`${relativePath}: the release is the Abort rule's unclaimed-by for the current claim id`, () => {
    assert.ok(scopeAssessmentOutcomes().includes('the Abort rule'));
    // The Abort rule the route cites revalidates ownership, updates the
    // digest, and posts unclaimed-by for the same (current) claim id.
    const appendixPath = relativePath.replace(
      'idd-work.instructions.md',
      'idd-overview-appendix.instructions.md',
    );
    const appendix = readRepoFile(appendixPath).replace(/\s+/g, ' ');
    const abort = appendix.slice(appendix.indexOf('## Abort'));
    assert.match(abort, /^## Abort On abort, re-validate ownership first\./);
    assert.match(
      abort,
      /update the digest before posting `unclaimed-by`.*then post an `unclaimed-by` comment for that same `\{claim-id\}`/,
    );
  });

  test(`${relativePath}: without the companion, the fallback comment is posted, the claim is released, and no question is asked`, () => {
    const route = scopeAssessmentOutcomes();
    // The fallback proposal rides on the same evidence comment, before the
    // release that both branches share.
    assert.ok(
      route.indexOf('and split proposal') <
        route.indexOf('release per the Abort rule'),
    );
    assert.ok(route.includes(PROHIBITION));
    const withoutAllowed = route
      .replace(PROHIBITION, '')
      .replace(NUMBER_ALONE_SHARED, '');
    for (const pattern of QUESTION_PATTERNS) {
      assert.doesNotMatch(withoutAllowed, pattern);
    }
  });
}

test('the shared B3 no-advisory route preserves its ordered release and handoff', () => {
  // The fixture diff (M, one file over the limit) fails the audit.
  assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
  const route = scopeAssessmentOutcomes();
  const positions = ORDERED_STEPS.map((step) => route.indexOf(step));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, ORDERED_STEPS[index]);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the shared route keeps the trigger, stop, comment, release and handoff ordered',
  );
});

test('the shared B3 outcomes make advisory drift a plan reassessment and keep every blocking case', () => {
  const route = scopeAssessmentOutcomes();
  const steps = [
    'A count over the S/M estimate is advisory drift',
    'measures breadth, not semantic intent, complexity, safety, or the ability to finish',
    'helper success does not prove any of those',
    '`assessment.disposition: "advisory-drift"`',
    'one evidence-backed plan reassessment',
    'one cohesive way to meet the accepted intent',
    'needs no new authority or unresolved decision',
    'feasible validation plan',
    'Count generated companions, tests and supporting docs by their purpose',
    NUMBER_ALONE_SHARED,
    'A genuinely new independent deliverable follows the unplanned follow-up work boundary',
    'An unresolved design, ownership, security, resource, or validation blocker keeps its existing handling',
    'the effort evidence is unusable',
    'reassessment finds one of the reasons above',
    'with evidence of that reason',
  ];
  const positions = steps.map((step) => route.indexOf(step));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, steps[index]);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the advisory reassessment comes before the reason-based stop',
  );
});

test('the helper reference keeps the instructions-only E12 count advisory and the F2 reconciliation explicit', () => {
  const text = readRepoFile('docs/idd-helper-scripts.md').replace(/\s+/gu, ' ');
  assert.doesNotMatch(text, /stop without pushing when either count fails/u);
  assert.match(
    text,
    /A count over the limit is advisory drift, not a stop: it measures breadth, not intent/u,
  );
  assert.match(
    text,
    /stop without pushing only for a reason other than the number/u,
  );
  assert.match(
    text,
    /F2\/F3 readiness \(`pre-merge-readiness`, issue `#4676`\) runs its own scope audit and still blocks on a count-only failure without an accepted decision; this step does not waive it/u,
  );
  assert.match(
    text,
    /no issue-body write, marker, or effort-L assignment, whatever the count \(nine and twelve paths included\)/u,
  );
  assert.match(text, /neither the finding ID nor its prose decides/u);
});

// The lite work file is self-contained and has no Abort rule to cite, so its
// route restates the release itself. It must still run the same steps, in the
// same order, and end with the same prohibition as the standard file.
const LITE_WORK_PATHS = [
  'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
  '.github/instructions/lite/idd-work-lite.instructions.md',
] as const;

const CORRECTION_ORDERED_STEPS = [
  '`assessment.correctionApplied: true`',
  '`assessment.disposition: "advisory-drift"`',
  '(even above eight)',
  'reassess once',
  'one cohesive way to meet the accepted intent',
  'no new authority or unresolved decision',
  'feasible validation plan',
  'raw-body SHA-256',
  'assessment SHA-256',
  'unique attempt ID',
  'complete `idd-agent-authored` suffix',
  'returned comment ID, author and exact body',
  'uncertain POST by its attempt ID',
  'Do not apply or push from B3',
  'keep the verified assessment SHA through C self-review and D1 synchronization',
  '`--expected-scope-sha256 <assessment-sha256>`',
  "If D2's scope check differs, return to B3",
] as const;

for (const relativePath of WORK_PHASE_PATHS) {
  test(`${relativePath}: advisory drift points to the shared report procedure`, () => {
    const route = scopeCorrectionRoute(relativePath);
    const cue = route.slice(0, route.indexOf(':'));
    assert.ok(
      Buffer.byteLength(cue, 'utf8') <= 80,
      'the cue stays under 80 bytes',
    );
    assert.ok(route.includes('[read-only report procedure]'));
    assert.ok(route.includes('#b3-scope-assessment-outcomes'));
    assert.match(route, /without editing the issue body/u);
  });
}

test('the shared B3 report carries its assessment to post-review D2', () => {
  const text = readRepoFile('docs/idd-helper-scripts.md').replace(/\s+/gu, ' ');
  const start = text.indexOf('B3 posts a report with the estimate');
  const end = text.indexOf('## Dead-export audit', start);
  assert.notEqual(start, -1, 'the shared report procedure is documented');
  assert.notEqual(end, -1, 'the report procedure has a section boundary');
  const route = text.slice(start, end);
  const steps = [
    'the reassessment verdict',
    'raw-body and assessment SHA values',
    'unique attempt ID',
    'complete `idd-agent-authored` suffix',
    'returned comment ID, author and exact body',
    'reconcile an uncertain POST by attempt ID',
    'If reporting remains unverified, stop and retain the claim',
    'Keep the verified assessment SHA for normal D2',
    'B3 ends without `--apply` or a push',
    'continue through C self-review and D1 synchronization',
    'pass the SHA with `--expected-scope-sha256` to the normal D2',
    "If D2's fresh scope differs, stop",
  ];
  const positions = steps.map((step) => route.indexOf(step));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, steps[index]);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the shared report, verification, reconciliation and apply stay ordered',
  );
  assert.match(route, /assessment\.correctionApplied: true/u);
  assert.match(route, /Do not edit or roll back the issue body/u);
  assert.doesNotMatch(route, /gh issue edit|PATCH \/repos\//u);
});

for (const relativePath of LITE_WORK_PATHS) {
  test(`${relativePath}: advisory drift verifies the report before guarded apply`, () => {
    const route = scopeCorrectionRoute(relativePath);
    const cue = route.slice(0, route.indexOf(':'));
    assert.ok(
      Buffer.byteLength(cue, 'utf8') <= 80,
      'the cue stays under 80 bytes',
    );
    const positions = CORRECTION_ORDERED_STEPS.map((step) =>
      route.indexOf(step),
    );
    for (const [index, position] of positions.entries()) {
      assert.notEqual(position, -1, CORRECTION_ORDERED_STEPS[index]);
    }
    assert.deepEqual(
      [...positions].sort((left, right) => left - right),
      positions,
      'report verification and D2 apply stay after C and D1',
    );
    assert.match(route, /Do not edit (?:or roll back )?the issue body/u);
    assert.match(route, /reconcile an uncertain POST by its attempt ID/u);
    assert.match(route, /If unverified, retain the claim and stop/u);
    assert.match(
      route,
      /Never inherit the report across a claim change or resume/u,
    );
    assert.doesNotMatch(route, /gh issue edit|PATCH \/repos\//u);
  });
}

const LITE_ORDERED_STEPS = [
  '(helper runtime only)',
  NUMBER_ALONE_LITE,
  'Independent deliverables use the follow-up route above',
  'design, ownership, security, resource, or validation blockers keep theirs',
  'such a reason (with evidence) makes the issue itself need a split',
  'fails `effort-candidate-file-limit` with no advisory disposition',
  'stop coding without pushing',
  'Comment the reason, estimate, candidate files, changed files, and a split proposal',
  'revalidate ownership',
  'still uses your current `{claim-id}`',
  'update the digest',
  'post `unclaimed-by` for that same `{claim-id}`',
  'run `lost-claim-cleanup`',
  'With the companion, hand it that proposal as a held split draft',
  'held roadmap whose children record `Split out of #<n>`',
  'comments its link',
  'if refused, the comment stands',
  PROHIBITION,
] as const;

for (const relativePath of LITE_WORK_PATHS) {
  test(`${relativePath}: the lite overrun route is reason-based, runs each step in order, and never asks a human`, () => {
    const route = scopeOverrunRoute(relativePath);
    assert.equal(
      route.includes('Abort rule'),
      false,
      'lite cites no Abort rule',
    );
    const positions = LITE_ORDERED_STEPS.map((step) => route.indexOf(step));
    for (const [index, position] of positions.entries()) {
      assert.notEqual(position, -1, LITE_ORDERED_STEPS[index]);
    }
    assert.deepEqual(
      [...positions].sort((left, right) => left - right),
      positions,
      'the route steps must appear in the documented order',
    );
    const withoutAllowed = route
      .replace(PROHIBITION, '')
      .replace(NUMBER_ALONE_LITE, '');
    for (const pattern of QUESTION_PATTERNS) {
      assert.doesNotMatch(withoutAllowed, pattern);
    }
  });
}

test('standing split never applies to a count alone in either work file', () => {
  for (const relativePath of [...WORK_PHASE_PATHS, ...LITE_WORK_PATHS]) {
    const text = readRepoFile(relativePath).replace(/\s+/gu, ' ');
    const start = text.indexOf('**Standing split**');
    assert.notEqual(start, -1, relativePath);
    assert.match(
      text.slice(start, start + 260),
      /never(?: for)? (?:a )?count alone|never for a count alone/u,
      relativePath,
    );
  }
});
