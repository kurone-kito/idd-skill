import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditAuthoredIssue } from '../src/scripts/audit-authored-issue.mts';

function suitabilityFooter(score: number): string {
  return `---\n\n_Autopilot suitability: ${score} / 5 -- higher is more autopilot-suitable;\nbelow the configured floor is human-oriented._\n\n<!-- idd-skill-autopilot-suitability: ${score} -->`;
}

function effortFooter(hint: string): string {
  return `_Effort: ${hint} -- author-estimated size; a soft autopilot\nselection tie-breaker only._\n\n<!-- idd-skill-effort: ${hint} -->`;
}

function orphanBody({
  score = 4,
  effort = 'M',
  includeEffort = true,
  proposedChange = true,
}: {
  score?: number;
  effort?: string;
  includeEffort?: boolean;
  proposedChange?: boolean;
} = {}): string {
  return [
    '## Background',
    '',
    'Some background text.',
    '',
    ...(proposedChange ? ['## Proposed change', '', 'Do the thing.', ''] : []),
    '## Acceptance criteria',
    '',
    '- [ ] thing works',
    '',
    suitabilityFooter(score),
    ...(includeEffort ? ['', effortFooter(effort)] : []),
  ].join('\n');
}

function roadmapBody({
  score = 3,
  roadmapIdCount = 1,
}: {
  score?: number;
  roadmapIdCount?: number;
} = {}): string {
  const roadmapIdMarkers = Array.from(
    { length: roadmapIdCount },
    () => '<!-- idd-skill-roadmap-id: foo-initiative -->',
  ).join('\n');
  return [
    '## Goal',
    '',
    'Ship the initiative.',
    '',
    '## Background',
    '',
    'Why this exists.',
    '',
    '## Tracks',
    '',
    '- [ ] #100',
    '',
    '## Success criteria',
    '',
    'Everything ships.',
    '',
    roadmapIdMarkers,
    '',
    suitabilityFooter(score),
  ].join('\n');
}

function childBody({
  score = 5,
  extraMarkers = '',
}: {
  score?: number;
  extraMarkers?: string;
} = {}): string {
  return [
    '## Background',
    '',
    'Context for this task.',
    '',
    '## Proposed change',
    '',
    'Implement the task.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] tests pass',
    '',
    extraMarkers,
    '',
    suitabilityFooter(score),
  ].join('\n');
}

function findingResult(
  report: ReturnType<typeof auditAuthoredIssue>,
  id: string,
): 'pass' | 'fail' {
  const finding = report.findings.find((entry) => entry.id === id);
  assert.ok(finding, `expected a finding with id ${id}`);
  return finding.result;
}

// --- Well-formed fixtures (one per shape): every check passes ---

test('a well-formed orphan issue passes every check', () => {
  const report = auditAuthoredIssue(orphanBody(), { shape: 'orphan' });
  assert.equal(report.passed, true);
  for (const finding of report.findings) {
    assert.equal(finding.result, 'pass', `${finding.id}: ${finding.detail}`);
  }
});

test('a well-formed roadmap issue passes every check', () => {
  const report = auditAuthoredIssue(roadmapBody(), { shape: 'roadmap' });
  assert.equal(report.passed, true);
  for (const finding of report.findings) {
    assert.equal(finding.result, 'pass', `${finding.id}: ${finding.detail}`);
  }
});

test('a well-formed child issue passes every check', () => {
  const report = auditAuthoredIssue(childBody(), { shape: 'child' });
  assert.equal(report.passed, true);
  for (const finding of report.findings) {
    assert.equal(finding.result, 'pass', `${finding.id}: ${finding.detail}`);
  }
});

// --- suitability-marker: exactly one, coherent 1-5 ---

test('suitability-marker fails when the marker is missing', () => {
  const body = '## Background\n\n## Proposed change\n\n## Acceptance criteria';
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'suitability-marker'), 'fail');
});

test('suitability-marker fails on a single malformed (out-of-range) value', () => {
  const body = `${orphanBody({ includeEffort: false }).replace(
    '<!-- idd-skill-autopilot-suitability: 4 -->',
    '<!-- idd-skill-autopilot-suitability: 7 -->',
  )}`;
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'suitability-marker'), 'fail');
});

test('suitability-marker fails on duplicate occurrences even when the values agree', () => {
  const body = `${orphanBody({ includeEffort: false })}\n\n<!-- idd-skill-autopilot-suitability: 4 -->`;
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'suitability-marker',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /found 2/);
});

// --- suitability-blocked-by-human: cross-field invariant ---

test('suitability-blocked-by-human fails when score is 1 without the label', () => {
  const body = orphanBody({ score: 1, includeEffort: false });
  const report = auditAuthoredIssue(body, { shape: 'orphan', labels: [] });
  assert.equal(findingResult(report, 'suitability-blocked-by-human'), 'fail');
});

test('suitability-blocked-by-human passes when score is 1 with the label present', () => {
  const body = orphanBody({ score: 1, includeEffort: false });
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    labels: ['status:blocked-by-human'],
  });
  assert.equal(findingResult(report, 'suitability-blocked-by-human'), 'pass');
});

test('suitability-blocked-by-human is not applicable for scores other than 1', () => {
  const report = auditAuthoredIssue(orphanBody({ score: 4 }), {
    shape: 'orphan',
    labels: [],
  });
  assert.equal(findingResult(report, 'suitability-blocked-by-human'), 'pass');
});

// --- marker-prefix-consistency ---

test('marker-prefix-consistency fails when a marker uses the wrong prefix', () => {
  const body = `${childBody({ extraMarkers: '<!-- idd-template-roadmap-id: foo -->' })}`;
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: 'idd-skill',
  });
  assert.equal(findingResult(report, 'marker-prefix-consistency'), 'fail');
});

test('marker-prefix-consistency passes when every marker uses the resolved prefix', () => {
  const report = auditAuthoredIssue(orphanBody(), {
    shape: 'orphan',
    markerPrefix: 'idd-skill',
  });
  assert.equal(findingResult(report, 'marker-prefix-consistency'), 'pass');
});

// --- required-headings ---

test('required-headings fails when a required heading is missing', () => {
  const body = orphanBody({ proposedChange: false });
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'required-headings',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /Proposed change/);
});

test('required-headings passes when an anyOf alternative is used', () => {
  const body = [
    '## Goal',
    '',
    '## Proposed change',
    '',
    '## Acceptance criteria',
    '',
    suitabilityFooter(4),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'required-headings'), 'pass');
});

// --- dependency-marker-rule ---

test('dependency-marker-rule fails when a child issue carries a roadmap-id marker', () => {
  const body = childBody({
    extraMarkers: '<!-- idd-skill-roadmap-id: foo -->',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'fail');
});

test('dependency-marker-rule passes for a child issue with no roadmap-id marker', () => {
  const report = auditAuthoredIssue(childBody(), { shape: 'child' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'pass');
});

test('dependency-marker-rule fails when a roadmap issue is missing its roadmap-id marker', () => {
  const body = roadmapBody({ roadmapIdCount: 0 });
  const report = auditAuthoredIssue(body, { shape: 'roadmap' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'fail');
});

test('dependency-marker-rule fails when a roadmap issue has duplicate roadmap-id markers', () => {
  const body = roadmapBody({ roadmapIdCount: 2 });
  const report = auditAuthoredIssue(body, { shape: 'roadmap' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'fail');
});

test('dependency-marker-rule fails when an orphan issue carries a blocked-by marker', () => {
  const body = orphanBody().replace(
    '## Background',
    '<!-- idd-skill-blocked-by: some-roadmap -->\n\n## Background',
  );
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'fail');
});

// --- suitability-visible-line-agreement ---

test('suitability-visible-line-agreement fails on a visible/hidden mismatch', () => {
  const body = orphanBody({ includeEffort: false }).replace(
    '_Autopilot suitability: 4 / 5',
    '_Autopilot suitability: 5 / 5',
  );
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(
    findingResult(report, 'suitability-visible-line-agreement'),
    'fail',
  );
});

test('suitability-visible-line-agreement passes when the visible line agrees', () => {
  const report = auditAuthoredIssue(orphanBody(), { shape: 'orphan' });
  assert.equal(
    findingResult(report, 'suitability-visible-line-agreement'),
    'pass',
  );
});

// --- effort-visible-line-agreement ---

test('effort-visible-line-agreement is not applicable when no effort footer is present', () => {
  const report = auditAuthoredIssue(orphanBody({ includeEffort: false }), {
    shape: 'orphan',
  });
  assert.equal(findingResult(report, 'effort-visible-line-agreement'), 'pass');
});

test('effort-visible-line-agreement fails on a visible/hidden mismatch', () => {
  const body = orphanBody({ effort: 'M' }).replace('_Effort: M', '_Effort: L');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'effort-visible-line-agreement'), 'fail');
});

test('effort-visible-line-agreement passes when the visible line agrees', () => {
  const report = auditAuthoredIssue(orphanBody({ effort: 'L' }), {
    shape: 'orphan',
  });
  assert.equal(findingResult(report, 'effort-visible-line-agreement'), 'pass');
});

// --- shape / markerPrefix pass-through ---

test('the report echoes the declared shape and resolved markerPrefix', () => {
  const report = auditAuthoredIssue(orphanBody(), {
    shape: 'orphan',
    markerPrefix: 'custom-prefix',
  });
  assert.equal(report.shape, 'orphan');
  assert.equal(report.markerPrefix, 'custom-prefix');
});

test('markerPrefix defaults to idd-skill when not provided', () => {
  const report = auditAuthoredIssue(orphanBody(), { shape: 'orphan' });
  assert.equal(report.markerPrefix, 'idd-skill');
});
