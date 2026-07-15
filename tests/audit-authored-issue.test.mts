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

test('marker-prefix-consistency detects a mismatch when markerPrefix contains regex metacharacters', () => {
  // A prefix capture group narrowed to [a-z0-9-] would never match a marker
  // under a `.`/`+`-bearing prefix at all (right or wrong), silently
  // reporting a false pass instead of flagging the mismatch below.
  const body = childBody({
    extraMarkers: '<!-- other.prefix+x-roadmap-id: foo -->',
  }).replace(/idd-skill/g, 'a.b+c');
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: 'a.b+c',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'marker-prefix-consistency',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /other\.prefix\+x-roadmap-id/);
});

test('marker-prefix-consistency passes when a regex-metacharacter markerPrefix matches every marker', () => {
  const body = childBody().replace(/idd-skill/g, 'a.b+c');
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: 'a.b+c',
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

test('required-headings ignores a heading-shaped line inside a fenced code block', () => {
  // A pasted template/example snippet containing "## Proposed change" only
  // inside a fence must not count as satisfying the real requirement.
  const body = [
    '## Background',
    '',
    '```markdown',
    '## Proposed change',
    '```',
    '',
    '## Acceptance criteria',
    '',
    suitabilityFooter(4),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'required-headings',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /Proposed change/);
});

test('required-headings still finds a heading that appears after a closed fence', () => {
  const body = [
    '## Background',
    '',
    '```markdown',
    'example content',
    '```',
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

test('required-headings does not let a literal ``` line inside a 4-backtick fence close it early', () => {
  // Per CommonMark, a closing fence must be at least as long as the
  // opening one, so a 4-backtick block may safely contain a 3-backtick
  // line as literal content. A length-blind fence tracker would treat
  // that inner ``` as a close and then read "## Proposed change" below
  // it as a real heading, even though it is still inside the fence.
  const body = [
    '## Background',
    '',
    '````markdown',
    '```',
    '## Proposed change',
    '```',
    '````',
    '',
    '## Acceptance criteria',
    '',
    suitabilityFooter(4),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'required-headings',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /Proposed change/);
});

test('required-headings tolerates up to 3 leading spaces on an ATX heading', () => {
  // CommonMark allows up to 3 leading spaces before a `##` heading; a
  // column-0-only regex would wrongly report this as missing.
  const body = [
    '   ## Background',
    '',
    '## Proposed change',
    '',
    '  ## Acceptance criteria',
    '',
    suitabilityFooter(4),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  assert.equal(findingResult(report, 'required-headings'), 'pass');
});

test('required-headings does not tolerate 4+ leading spaces on an ATX heading', () => {
  // 4+ leading spaces is an indented code line under CommonMark, not a
  // heading, so this must still fail.
  const body = [
    '## Background',
    '',
    '    ## Proposed change',
    '',
    '## Acceptance criteria',
    '',
    suitabilityFooter(4),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'required-headings',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /Proposed change/);
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

test('dependency-marker-rule ignores a roadmap-id marker that only appears inside a fenced example', () => {
  // A pasted contract-example snippet showing marker syntax must not make
  // an orphan/child draft look like it carries a real roadmap-id marker.
  const body = childBody({
    extraMarkers: [
      'For reference, a roadmap marker looks like:',
      '',
      '```markdown',
      '<!-- idd-skill-roadmap-id: some-roadmap -->',
      '```',
    ].join('\n'),
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'pass');
});

test('dependency-marker-rule still fails when a roadmap issue only has its marker inside a fence', () => {
  // The converse: a roadmap-id marker that exists ONLY inside a fence does
  // not count as the real, required marker for a roadmap issue.
  const body = [
    '## Goal',
    '',
    '## Background',
    '',
    '## Tracks',
    '',
    '## Success criteria',
    '',
    '```markdown',
    '<!-- idd-skill-roadmap-id: some-roadmap -->',
    '```',
    '',
    suitabilityFooter(3),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'roadmap' });
  const finding = report.findings.find(
    (entry) => entry.id === 'dependency-marker-rule',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /found 0/);
});

test('dependency-marker-rule fails when the roadmap-id marker is present but missing its value', () => {
  // A single well-shaped-but-valueless marker (no `: <roadmap-id>`) passes
  // the loose occurrence count but must still fail as malformed, so a
  // roadmap draft is never left with no discoverable roadmap ID.
  const body = roadmapBody({ roadmapIdCount: 0 }).replace(
    '## Success criteria\n\nEverything ships.\n\n',
    '## Success criteria\n\nEverything ships.\n\n<!-- idd-skill-roadmap-id -->\n\n',
  );
  const report = auditAuthoredIssue(body, { shape: 'roadmap' });
  const finding = report.findings.find(
    (entry) => entry.id === 'dependency-marker-rule',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /malformed/);
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

test('suitability-visible-line-agreement is not satisfied by a stray line elsewhere in the body', () => {
  // A visible-line-shaped string earlier in the body (e.g. a pasted
  // example/template) must not satisfy the check for a footer whose own
  // real visible line, immediately before the marker, is missing.
  const body = [
    'Example footer for reference:',
    '',
    '_Autopilot suitability: 2 / 5 -- higher is more autopilot-suitable;',
    'below the configured floor is human-oriented._',
    '',
    orphanBody({ includeEffort: false }).replace(
      '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;\nbelow the configured floor is human-oriented._\n\n',
      '',
    ),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'suitability-visible-line-agreement',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /missing or unparsable/);
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

test('effort-visible-line-agreement is not satisfied by a stray line elsewhere in the body', () => {
  const body = [
    'Example footer for reference:',
    '',
    '_Effort: S -- author-estimated size; a soft autopilot',
    'selection tie-breaker only._',
    '',
    orphanBody({ effort: 'M' }).replace(
      '_Effort: M -- author-estimated size; a soft autopilot\nselection tie-breaker only._\n\n',
      '',
    ),
  ].join('\n');
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'effort-visible-line-agreement',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /missing or unparsable/);
});

test('effort-visible-line-agreement fails on a value-less effort marker instead of passing as absent', () => {
  // parseEffortMarker requires a value token, so a marker missing its
  // value entirely reads as "not present" from that field alone — but it
  // is not genuinely absent, so it must not be waved through as "no
  // effort footer (optional)".
  const body = orphanBody({ includeEffort: false }).replace(
    /(<!-- idd-skill-autopilot-suitability: 4 -->)/,
    '$1\n\n<!-- idd-skill-effort: -->',
  );
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'effort-visible-line-agreement',
  );
  assert.equal(finding?.result, 'fail');
  assert.doesNotMatch(finding?.detail ?? '', /not applicable/);
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
