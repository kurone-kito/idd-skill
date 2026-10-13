// Issue #4138: a work session that finds the diff larger than the issue's
// effort estimate returns the issue to authoring and releases its claim.
// It never asks a human and never applies the needs-decision label.
//
// The overrun itself is detected with the shipped authoring-time rule
// (#4130's `effort-candidate-file-limit` check and its threshold table).
// The work-phase route that follows it is instruction text, so these
// fixtures assert what that text tells the worker to produce for each
// branch: the overrun comment, the `unclaimed-by` release with the
// current claim id, and no question.

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

// Wording that would turn the overrun back into a human question.
const QUESTION_PATTERNS = [/needs-decision/i, /\bask\b/i, /\?/] as const;

const PROHIBITION = 'Never add needs-decision or ask a human';

/**
 * The route steps, in the order the worker must perform them: the
 * trigger, the stop, the evidence comment (which also carries the
 * fallback proposal), the claim release, then the companion handoff.
 */
const ORDERED_STEPS = [
  '`audit-authored-issue --shape child` fails',
  '`effort-candidate-file-limit` on the issue',
  "`## Candidate files` set to the diff's canonical paths",
  'stop coding without pushing',
  'a release, not a hold',
  'Comment the estimate, candidate files, changed files',
  'without the companion, the split proposal',
  'release with `unclaimed-by` and the current `{claim-id}`',
  'run `lost-claim-cleanup`',
  'With the companion, hand it a held split draft',
  'held roadmap whose children record `Split out of #<n>`',
  'comments its link',
  PROHIBITION,
] as const;

test('a diff over the effort estimate is an overrun; one within it is not', () => {
  const limitM = EFFORT_CANDIDATE_FILE_LIMITS.M;
  assert.equal(isOverrun('M', limitM + 1), true);
  assert.equal(isOverrun('M', limitM), false);
  const limitS = EFFORT_CANDIDATE_FILE_LIMITS.S;
  assert.equal(isOverrun('S', limitS + 1), true);
  assert.equal(isOverrun('S', limitS), false);
});

test('an issue within its estimate whose diff is over it is an overrun through the changed files', () => {
  // The issue's own candidate list passes the check...
  assert.equal(isOverrun('M', 3), false);
  // ...but the same issue with the canonical changed files in place of
  // its candidate files fails it, which is the route's second trigger.
  assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
});

test('an orphan issue is checked only because the route passes --shape child', () => {
  // The motivating overrun (#4064) was an orphan issue. Audited under its
  // own shape the threshold is not applicable, so the route must name
  // the child shape for the check to apply.
  const body = issueWithChangedFiles('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1);
  const asOrphan = auditAuthoredIssue(body, { shape: 'orphan' }).findings.find(
    (entry) => entry.id === 'effort-candidate-file-limit',
  );
  assert.equal(asOrphan?.result, 'pass');
  assert.match(asOrphan?.detail ?? '', /^not applicable:/);
  assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
});

test('L and a missing effort hint are never checked, so they never trigger the route', () => {
  const over = EFFORT_CANDIDATE_FILE_LIMITS.M + 10;
  for (const effort of ['L', null]) {
    const finding = thresholdFinding(effort, over);
    assert.equal(finding.result, 'pass', String(effort));
    assert.match(finding.detail, /^not applicable:/, String(effort));
  }
});

test('a split child over the limit is exempt, so it never triggers the route', () => {
  const finding = thresholdFinding('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1, [
    'Split out of #1',
    '',
  ]);
  assert.equal(finding.result, 'pass');
  assert.match(finding.detail, /Split out of #<n> provenance line exempts it/);
});

for (const relativePath of WORK_PHASE_PATHS) {
  test(`${relativePath}: an overrun produces the evidence comment, then the release, then the handoff`, () => {
    // The fixture diff (M, one file over the limit) is an overrun.
    assert.equal(isOverrun('M', EFFORT_CANDIDATE_FILE_LIMITS.M + 1), true);
    const route = scopeOverrunRoute(relativePath);
    const positions = ORDERED_STEPS.map((step) => route.indexOf(step));
    for (const [index, position] of positions.entries()) {
      assert.notEqual(position, -1, ORDERED_STEPS[index]);
    }
    assert.deepEqual(
      [...positions].sort((left, right) => left - right),
      positions,
      'the route steps must appear in the documented order',
    );
  });

  test(`${relativePath}: the overrun is a release, not a hold`, () => {
    assert.match(scopeOverrunRoute(relativePath), /a release, not a hold/);
  });

  test(`${relativePath}: without the companion, the fallback comment is posted, the claim is released, and no question is asked`, () => {
    const route = scopeOverrunRoute(relativePath);
    // The fallback proposal rides on the same evidence comment, before
    // the release that both branches share.
    assert.ok(
      route.indexOf('without the companion, the split proposal') <
        route.indexOf('release with `unclaimed-by`'),
    );
    assert.ok(route.includes(PROHIBITION));
    const withoutProhibition = route.replace(PROHIBITION, '');
    for (const pattern of QUESTION_PATTERNS) {
      assert.doesNotMatch(withoutProhibition, pattern);
    }
  });
}
