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

test('marker-prefix-consistency detects a wrong-prefix marker that is also missing its value', () => {
  // A mandatory `:` in the scan regex would let a malformed, valueless,
  // wrong-prefix marker evade detection entirely — but it is still
  // evidence of a prefix leak and must be flagged.
  const body = childBody({
    extraMarkers: '<!-- other-roadmap-id -->',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: 'idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'marker-prefix-consistency',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /other-roadmap-id/);
});

test('markerPrefix normalization trims accidental whitespace', () => {
  const body = childBody();
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: '  idd-skill  ',
  });
  assert.equal(report.markerPrefix, 'idd-skill');
  assert.equal(findingResult(report, 'marker-prefix-consistency'), 'pass');
  assert.equal(findingResult(report, 'suitability-marker'), 'pass');
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

test('dependency-marker-rule fails when a child blocked-by marker is missing its value', () => {
  // A blocked-by marker with no `: <roadmap-id>` value looks present to the
  // author but is invisible to Discover's extractBlockedByRoadmapMarkers,
  // silently defeating the intended dependency.
  const body = childBody({ extraMarkers: '<!-- idd-skill-blocked-by -->' });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'dependency-marker-rule',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /malformed/);
});

test('dependency-marker-rule fails when a child blocked-by marker has an empty value', () => {
  const body = childBody({ extraMarkers: '<!-- idd-skill-blocked-by: -->' });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'dependency-marker-rule',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /malformed/);
});

test('dependency-marker-rule passes when a child blocked-by marker has a real value', () => {
  const body = childBody({
    extraMarkers: '<!-- idd-skill-blocked-by: some-roadmap -->',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  assert.equal(findingResult(report, 'dependency-marker-rule'), 'pass');
});

test('dependency-marker-rule fails when a roadmap blocked-by marker is missing its value', () => {
  const body = roadmapBody().replace(
    '## Success criteria',
    '<!-- idd-skill-blocked-by -->\n\n## Success criteria',
  );
  const report = auditAuthoredIssue(body, { shape: 'roadmap' });
  const finding = report.findings.find(
    (entry) => entry.id === 'dependency-marker-rule',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(
    finding?.detail ?? '',
    /blocked-by marker is present but malformed/,
  );
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

test('effort-visible-line-agreement fails when a well-formed marker is accompanied by a valueless one', () => {
  // A well-formed effort marker plus an extra valueless one must still
  // fail: parseEffortMarker silently ignores the valueless occurrence and
  // resolves a coherent value from the good one, so without an explicit
  // occurrence-count check this could pass by coincidence of which
  // occurrence lastParagraphBeforeMarker happens to land on.
  const body = orphanBody({ effort: 'M' }).replace(
    '<!-- idd-skill-effort: M -->',
    '<!-- idd-skill-effort: M -->\n\n<!-- idd-skill-effort: -->',
  );
  const report = auditAuthoredIssue(body, { shape: 'orphan' });
  const finding = report.findings.find(
    (entry) => entry.id === 'effort-visible-line-agreement',
  );
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /found 2/);
});

// --- prose-dependency (advisory, warning-severity only) ---

test('prose-dependency warns on coordination language with an unencoded reference', () => {
  const body = childBody({
    extraMarkers:
      'Before merging this, confirm PR #1391 already lands the base change.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.result, 'pass');
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
  assert.equal(report.passed, true);
});

test('prose-dependency does not warn on a plain breadcrumb reference', () => {
  const body = childBody({ extraMarkers: 'Refs #1391 for background.' });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.result, 'pass');
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a cross-repo shorthand reference', () => {
  // Regression test for a real false-positive risk: `owner/repo#123` is a
  // cross-repo reference that cannot be encoded via this repository's local
  // `Blocked by` / `Depends on` markers, so the bare-`#` alternative must not
  // match the trailing `#123` merely because it is preceded by a word
  // character (the repo-name slug) rather than treating it as a local
  // reference.
  const body = childBody({
    extraMarkers:
      'Before starting this, confirm kurone-kito/other-repo#123 has shipped.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn when the reference already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers: 'Blocked by #1391\n\nOnce #1391 merges, this can start.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn when the reference already has a Depends on encoding', () => {
  const body = childBody({
    extraMarkers: 'Depends on #1391\n\nOnce #1391 merges, this can start.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a roadmap-parent breadcrumb sharing a paragraph with unrelated coordination language', () => {
  // Regression test for a real false-positive risk found while designing
  // this check: "Part of ... roadmap (#N)" is a common breadcrumb phrasing
  // in this repository's own issues, and the same long paragraph may
  // separately use a coordination word like "before" for something
  // unrelated later on. Paragraph-level scoping would conflate the two;
  // sentence-level scoping must not.
  const body = childBody({
    extraMarkers:
      'Part of the field-report batch-6 roadmap (#1386). The other ' +
      'session held before confirming the fix, unrelated to this reference.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a breadcrumb in one list item sharing a tight list with an unrelated coordination-language item', () => {
  // Regression test for a real false-positive risk: splitIntoSentences()
  // collapses all internal newlines to spaces before splitting on
  // terminal punctuation, so a tight Markdown list (items with no blank
  // line between them) with no periods at all would otherwise be treated
  // as one giant "sentence" spanning every bullet -- reintroducing the
  // exact same-paragraph conflation the roadmap-parent-breadcrumb test
  // above already guards against, just via list items instead of a long
  // prose paragraph.
  const body = childBody({
    extraMarkers:
      '- Part of roadmap #1386\n' +
      '- Before starting, confirm PR #1391 already lands the base change',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /#1391/);
  assert.doesNotMatch(finding.detail, /#1386/);
});

test('prose-dependency recognizes a full GitHub issue/PR URL reference', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency still recognizes a full GitHub issue/PR URL reference when currentRepo matches', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency still recognizes a local URL wrapped in a Markdown link', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391) has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo full GitHub issue/PR URL reference when currentRepo is known', () => {
  // Regression test for a real false-positive risk: the encodings this
  // check recommends (`Blocked by #N` / `Depends on #N`) are inherently
  // local, so flagging a cross-repo URL reference gives actively wrong
  // advice, not just a nuisance false positive. Filtering requires an
  // explicit currentRepo (see the sibling "unknown repo" test below for
  // the unchanged default when it is absent).
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/other-repo/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a cross-repo URL wrapped in a Markdown link whose label repeats the same #N', () => {
  // Regression test for a real false-positive risk found by review on this
  // same PR: a cross-repo reference is often presented as a normal Markdown
  // link whose label repeats the issue number, e.g.
  // `[PR #1391](https://github.com/owner/other-repo/pull/1391)`. The URL is
  // correctly skipped as cross-repo, but without treating the whole link as
  // one match, the label's own bare `#1391` text would be independently
  // caught by the bare-# alternative and (wrongly) treated as local,
  // contradicting the guarantee the sibling test above establishes.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391) has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency still warns on a cross-repo URL reference when currentRepo is unknown', () => {
  // Preserves the pre-#1399-fix default (flag every full-URL reference)
  // when the caller cannot supply repo context, since a bare owner/repo
  // cannot be inferred from the body text alone.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/other-repo/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency currentRepo comparison is case-insensitive', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/Kurone-Kito/IDD-Skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
});

test('prose-dependency leaves passed and the exit code unchanged even when it warns', () => {
  const body = childBody({
    extraMarkers: 'This requires #1391 merged first.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.equal(finding?.result, 'pass');
  assert.equal(report.passed, true);
});

test('prose-dependency ignores a coordination word and reference that only appear inside a fenced example', () => {
  const body = childBody({
    extraMarkers: [
      'For reference, phrasing to avoid looks like:',
      '',
      '```markdown',
      'Before doing X, verify PR #1391 already does Y.',
      '```',
    ].join('\n'),
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: trailing Markdown-link content (#1468) ---

test('prose-dependency recognizes a Markdown link whose target has a trailing URL fragment', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391#issuecomment-123) has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo Markdown link with a trailing URL fragment when currentRepo is known', () => {
  // Regression test for the exact label-leak false positive this issue's
  // Background describes: without trailing-content support, this link
  // would fail the Markdown-link alternative and let its label's bare
  // `#1391` leak through to the bare-`#` alternative, wrongly flagging a
  // cross-repo reference as local.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391#issuecomment-123) has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a cross-repo Markdown link whose fragment contains a dot', () => {
  // Regression test for a review finding on this same PR (#1469): a
  // fragment charset restricted to [\w-]+ rejects a fragment containing a
  // `.` (e.g. a heading-anchor-style fragment), which fails the whole
  // Markdown-link alternative and reintroduces the exact label-leak this
  // shape exists to prevent -- the same failure mode as not tolerating a
  // fragment at all, just triggered by an overly narrow charset instead.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #12](https://github.com/kurone-kito/other-repo/pull/12#foo.bar) has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a cross-repo Markdown link with a non-ASCII fragment', () => {
  // Regression test for a review finding on this same PR (#1469): a
  // fragment charset restricted to ASCII \w rejects a non-ASCII fragment
  // (realistic for this repository, whose docs/issues carry Japanese
  // content routinely), with the same label-leak failure mode as above.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391#背景) has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency recognizes a Markdown link whose target has a trailing slash', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391/) has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo Markdown link with a trailing slash when currentRepo is known', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391/) has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency recognizes a Markdown link whose target has a double-quoted title', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 "Merge base change") has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency recognizes a Markdown link whose target has a single-quoted title', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      "[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 'Merge base change') has merged.",
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo Markdown link with a quoted title when currentRepo is known', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391 "Merge base change") has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a Markdown link with a trailing URL fragment when the number already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers:
      'Blocked by #1391\n\nBefore this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391#issuecomment-123) has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a Markdown link with a quoted title when the number already has a task-list encoding', () => {
  const body = childBody({
    extraMarkers:
      '- [ ] #1391\n\nBefore this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 "Merge base change") has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: owner/repo#N shorthand (#1468) ---

test('prose-dependency flags an owner/repo#N shorthand naming currentRepo', () => {
  const body = childBody({
    extraMarkers:
      'Before starting, confirm kurone-kito/idd-skill#4321 has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#4321/);
});

test('prose-dependency does not warn on an owner/repo#N shorthand naming a different repo', () => {
  const body = childBody({
    extraMarkers:
      'Before starting, confirm kurone-kito/other-repo#4321 has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on an owner/repo#N shorthand when currentRepo is unknown', () => {
  // No behavior change from before this issue: this shorthand was never
  // recognized at all pre-#1468, so the default without currentRepo stays
  // "excluded" — the opposite default from the full-URL alternatives,
  // which stay flagged-by-default when currentRepo is unknown.
  const body = childBody({
    extraMarkers:
      'Before starting, confirm kurone-kito/idd-skill#4321 has shipped.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency owner/repo#N shorthand currentRepo comparison is case-insensitive', () => {
  const body = childBody({
    extraMarkers:
      'Before starting, confirm Kurone-Kito/IDD-Skill#4321 has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#4321/);
});

test('prose-dependency does not warn on an owner/repo#N shorthand when the number already has a Depends on encoding', () => {
  const body = childBody({
    extraMarkers:
      'Depends on #4321\n\nBefore starting, confirm ' +
      'kurone-kito/idd-skill#4321 has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not misparse a three-segment slash path ending in #N as an owner/repo#N shorthand', () => {
  // Regression test for the new alternative's own false-positive risk: a
  // greedy owner/repo#N match starting mid-path (e.g. the "b/c#123" tail of
  // "a/b/c#123") would misread an unrelated multi-segment path as a
  // shorthand reference. The shared (?<![\w/]) lookbehind must reject
  // starting the match right after another `/`.
  const body = childBody({
    extraMarkers: 'Before starting, see a/b/c#4321 for details.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: reference-style Markdown links (#1472) ---

test('prose-dependency recognizes a reference-style Markdown link target', () => {
  const body = childBody({
    extraMarkers:
      'Before starting, [PR #1391][upstream] must land.\n\n' +
      '[upstream]: https://github.com/kurone-kito/idd-skill/pull/1391',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo reference-style Markdown link when currentRepo is known', () => {
  // Regression test for the exact scenario #1472 describes: without
  // resolving the reference-style link to its definition's URL, the
  // label's own bare `#1391` leaks through to the bare-`#` alternative and
  // gets wrongly flagged as local even though the definition targets
  // another repository.
  const body = childBody({
    extraMarkers:
      'Before starting, [PR #1391][upstream] must land.\n\n' +
      '[upstream]: https://github.com/acme/other-repo/pull/1391',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency still warns on a cross-repo reference-style Markdown link when currentRepo is unknown', () => {
  // Preserves the same default polarity as the full-URL and Markdown-link
  // alternatives: without repo context, a reference-style link is still
  // flagged by default.
  const body = childBody({
    extraMarkers:
      'Before starting, [PR #1391][upstream] must land.\n\n' +
      '[upstream]: https://github.com/acme/other-repo/pull/1391',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a reference-style Markdown link when the number already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers:
      'Blocked by #1391\n\nBefore starting, [PR #1391][upstream] must land.\n\n' +
      '[upstream]: https://github.com/kurone-kito/idd-skill/pull/1391',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency resolves a reference-style link whose definition uses an angle-bracket destination', () => {
  // Regression test for a real review finding on this same PR (Copilot):
  // CommonMark (section 6.6) allows a reference definition's destination
  // to be wrapped in angle brackets (`[ref]: <https://...>`). Without
  // stripping the brackets before rewriting, the usage would become
  // `[text](<https://...>)`, which the Markdown-link alternative does not
  // recognize, silently leaving the reference-style link unresolved and
  // re-leaking the label's bare `#N` -- the same failure mode this item
  // exists to prevent, just for this one destination-encoding shape.
  const body = childBody({
    extraMarkers:
      'Before starting, [PR #1391][upstream] must land.\n\n' +
      '[upstream]: <https://github.com/acme/other-repo/pull/1391>',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not resolve a reference-style link whose ref has no matching definition', () => {
  // A dangling ref (no matching `[ref]: target` definition anywhere in
  // the body) is left as literal text -- it falls through to the bare-`#`
  // alternative like any other unrecognized bracket shape, the same
  // fallback that already applies to every other unmatched shape.
  const body = childBody({
    extraMarkers: 'Before starting, [PR #1391][missing-ref] must land.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency resolves a reference-style link whose ref label differs in case and whitespace from its definition', () => {
  // CommonMark compares reference labels case-insensitively after
  // trimming and collapsing internal whitespace (normalizeLinkReferenceLabel).
  // Every other reference-style test uses an identical single-word label
  // on both sides, which would still resolve-and-flag correctly (via the
  // bare-`#` fallback) even if label normalization were entirely broken --
  // not a discriminating test. A *cross-repo* definition with currentRepo
  // known is: if normalization fails to match "Upstream  PR" to "upstream
  // pr", the usage is left unresolved, falls through to the bare-`#`
  // alternative (which has no owner/repo of its own and is therefore
  // always treated as local, unlike the resolved Markdown-link form),
  // and gets wrongly flagged -- only correct label resolution lets the
  // cross-repo exclusion apply.
  const body = childBody({
    extraMarkers:
      'Before starting, [PR #1391][Upstream  PR] must land.\n\n' +
      '[upstream pr]: https://github.com/acme/other-repo/pull/1391',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: nested list item parent-scope loss (#1472) ---

test('prose-dependency recognizes a nested list item reference alongside its parent bullet coordination language', () => {
  const body = childBody({
    extraMarkers: '- Before starting this work:\n  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a nested list item reference when the number already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers:
      'Blocked by #1391\n\n- Before starting this work:\n  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency still separates top-level sibling list items sharing a tight list with a nested child', () => {
  // Regression guard: the nested-scoping fix above must not regress the
  // original tight-list sentence-conflation fix for TOP-LEVEL siblings --
  // a nested child's own reference must not leak into an unrelated
  // top-level sibling bullet's block.
  const body = childBody({
    extraMarkers:
      '- Part of roadmap #1386\n' +
      '- Before starting this work:\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /#1391/);
  assert.doesNotMatch(finding.detail, /#1386/);
});

test('prose-dependency recognizes a tab-indented nested child as deeper than its space-indented parent', () => {
  // Regression test for a real review finding on this same PR (Codex):
  // CommonMark expands a tab to the next column that is a multiple of 4
  // when it participates in block structure, so a tab-indented marker
  // (raw length 1) can still be a deeper nested child than a 2-space
  // parent (raw length 2) once expanded (column 4 vs. column 2). A raw
  // character-count comparison would undercount the tab and wrongly
  // treat this as a same-or-shallower marker, starting a new block and
  // losing the parent's coordination language -- the same failure mode
  // the nested-scoping fix above exists to prevent.
  const body = childBody({
    extraMarkers: '  - Before starting this work:\n\t- PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

// --- prose-dependency: every nested sibling under one parent, not just
// the first (#1474) ---

test('prose-dependency recognizes a reference in the second nested child under one parent, not only the first', () => {
  // Regression test for the exact gap #1474 tracks: the pre-#1474
  // single-most-recently-seen-marker comparison kept only the FIRST
  // child merged with the parent's block -- once that first child was
  // processed, the comparison value became the child's own (deeper)
  // indentation, so the second same-depth child compared against that
  // instead of the parent and started a fresh block, losing the
  // parent's coordination language exactly like every child did before
  // #1472 shipped.
  const body = childBody({
    extraMarkers:
      '- Before starting this work:\n' +
      '  - Gather context\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency recognizes a reference in the third nested child under one parent', () => {
  // Generalizes the second-child case above to a third sibling, proving
  // the indentation-ancestry stack scopes every child at a given depth
  // with the parent -- not merely the first two.
  const body = childBody({
    extraMarkers:
      '- Before starting this work:\n' +
      '  - Gather context\n' +
      '  - Draft the plan\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency recognizes a reference nested under a non-first branch of a multi-level list', () => {
  // Multi-level nesting (grandparent / two sibling parent branches /
  // child), reference in a child under the SECOND (non-first) branch.
  // Under the pre-#1474 single-most-recently-seen-marker comparison,
  // once the first branch's own child was processed, the comparison
  // value sat at that child's depth; the second branch's marker (same
  // depth as the first branch) started a fresh block with nothing
  // carried over, so the grandparent's coordination language never
  // reached the second branch's own child -- the reference was silently
  // never flagged. The indentation-ancestry stack fixes this: every
  // node still open above the current one (grandparent, and this
  // branch) prefixes the leaf block, regardless of what an earlier
  // sibling branch already consumed.
  const body = childBody({
    extraMarkers:
      '- Before this release:\n' +
      '  - First branch: nothing notable here\n' +
      '  - Second branch:\n' +
      '    - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not merge plain prose directly followed by a list item with no blank line', () => {
  // Regression guard for the preamble-flush rule the #1474 rework
  // introduces: lines seen before any list marker opens must still be
  // flushed as their OWN block the moment the first marker appears
  // (matching pre-#1474 behavior), not merged into the first list
  // item's block. No terminal punctuation is used deliberately -- an
  // incorrect merge of the preamble into the following list item's
  // block would put the keyword and the reference in the same
  // sentence (nothing else would split them apart), which would wrongly
  // flag it.
  const body = childBody({
    extraMarkers: 'Confirm before merging\n- PR #1391 is an unrelated bullet',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: continuation-line and loose-list ancestor
// scoping gaps (#1476) ---

test('prose-dependency attributes a continuation line to its true ancestor, not the deepest open child', () => {
  // Regression test for the exact gap #1476 tracks: a continuation line
  // (no list marker of its own) resuming at an ancestor's own
  // indentation -- after a deeper child has already opened -- was
  // always glued to whatever child happened to be deepest-open at that
  // point, regardless of the continuation's own indentation. Here
  // "Before starting, confirm scope" sits at the SAME 2-space
  // indentation as the two children's own markers, which is also where
  // continuation text belonging to the (0-indent) parent's own body
  // would land; the fix walks the ancestry stack to find the deepest
  // node whose indent is still strictly less than the continuation's
  // own, so the coordination language lands on the parent -- reaching
  // the later sibling "PR #1391" -- not on "Gather context" alone.
  const body = childBody({
    extraMarkers:
      '- Parent task\n' +
      '  - Gather context\n' +
      '  Before starting, confirm scope\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency preserves ancestor scope across a loose list blank line between sibling items', () => {
  // Regression test for the second gap #1476 tracks: checkProseOnlyDependency
  // split text into paragraphs on every blank line, so a loose list
  // (blank line between sibling items, ordinary valid CommonMark) lost
  // the earlier paragraph's still-open ancestor ("Before starting:")
  // the moment splitIntoListItemBlocks ran on the second item's
  // paragraph independently. splitIntoParagraphs now bridges exactly
  // one blank line between two loose-list chunks before
  // splitIntoListItemBlocks ever runs, so this behaves the same as the
  // already-passing tight-list case above.
  const body = childBody({
    extraMarkers:
      '- Before starting:\n' +
      '  - Gather context\n' +
      '\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency preserves ancestor scope across a loose list spanning three sibling items', () => {
  // Generalizes the loose-list fix to a THIRD sibling (blank line
  // before both the second and third items), mirroring the existing
  // tight-list third-child test above -- proves the merge in
  // splitIntoParagraphs folds left-to-right against the running
  // accumulator rather than only handling a single pairwise merge.
  const body = childBody({
    extraMarkers:
      '- Before starting this work:\n' +
      '  - Gather context\n' +
      '\n' +
      '  - Draft the plan\n' +
      '\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not graft a deeper-indented unrelated item onto a keyword-bearing item across a loose-list blank line', () => {
  // Regression guard for a false positive the loose-list merge must
  // not introduce: bridging is only safe when the right chunk's first
  // marker is no deeper than whatever is still open at the end of the
  // left chunk (a genuine sibling/ancestor continuation). Without that
  // indentation guard, this RIGHT chunk -- indented deeper than the
  // left chunk's only (0-indent) item -- would be grafted on as a
  // fresh CHILD instead of staying a wholly separate, unrelated
  // bullet. Because the left item has no terminal punctuation, the
  // flattened block would become one "sentence" that spuriously pairs
  // the left item's own coordination language ("before") with the
  // right item's unrelated reference.
  const body = childBody({
    extraMarkers:
      '- Before merging confirm CI is green\n' +
      '\n' +
      '  - Unrelated aside mentioning PR #1391, no coordination language here',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not bridge two blank lines between list items as one loose list', () => {
  // Guard: the loose-list merge is scoped to EXACTLY one blank line
  // (matching the issue's own "a loose list (blank line between
  // sibling items)" framing) -- two or more blank lines is a harder
  // paragraph break and is not bridged, keeping today's behavior for
  // that stronger separator.
  const body = childBody({
    extraMarkers:
      '- Before starting this work:\n' +
      '  - Gather context\n' +
      '\n\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not bridge a blank line between plain prose and a following unrelated list item', () => {
  // Guard: the loose-list merge requires the left chunk to contain a
  // list-item marker; a chunk of plain prose (no marker at all) is
  // never a bridge candidate, so a coordination keyword in ordinary
  // prose does not reach across a blank line into an unrelated
  // following bullet's reference either.
  const body = childBody({
    extraMarkers:
      'Confirm before merging this section\n' +
      '\n' +
      '- PR #1391 is an unrelated bullet',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency bridges a loose-list blank line to a shallower open ancestor, not just the same depth', () => {
  // Regression test for a CodeRabbit review nitpick on this PR: every
  // other loose-list positive test above resumes at exactly the same
  // depth as the left chunk's tail node (rightHeadIndent === leftTailIndent),
  // never exercising the genuinely-shallower branch of the
  // `rightHeadIndent <= leftTailIndent` guard in
  // isBridgeableLooseListBoundary. Here the left chunk ends three levels
  // deep ("Sub-detail" at indent 4), and the item after the blank line
  // resumes at "Gather context"'s own (shallower, indent-2) level --
  // strictly less than 4, not equal to it. The bridge must still fire so
  // "Before starting:" (the root) reaches "PR #1391".
  const body = childBody({
    extraMarkers:
      '- Before starting:\n' +
      '  - Gather context\n' +
      '    - Sub-detail\n' +
      '\n' +
      '  - PR #1391 must land',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

// --- prose-dependency: empty-string currentRepo (#1472) ---

test('prose-dependency treats an empty-string currentRepo as unknown', () => {
  // Regression test for the exact bug #1472 describes: `currentRepo !==
  // undefined` is true for `''`, so a local full-URL reference was
  // silently excluded (misread as cross-repo) instead of flagged by the
  // "unknown repo" default.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child', currentRepo: '' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency treats a whitespace-only currentRepo as unknown', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: '   ',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency trims a currentRepo with incidental leading/trailing whitespace before comparing', () => {
  // normalizeCurrentRepo's non-empty branch returns the trimmed value, not
  // the original string. A *local* URL reference is the discriminating
  // case: an explicit currentRepo that matches the reference's owner/repo
  // is still flagged by design (see the AuditOptions.currentRepo JSDoc),
  // so if trimming were broken -- comparing the padded string as-is --
  // the padded value would never equal the unpadded local repo, the
  // reference would be wrongly treated as cross-repo, and this would
  // silently NOT warn instead.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: '  kurone-kito/idd-skill  ',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn with an empty-string currentRepo when the number already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers:
      'Blocked by #1391\n\nBefore this can start, confirm ' +
      'https://github.com/kurone-kito/idd-skill/pull/1391 has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child', currentRepo: '' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

// --- prose-dependency: escaped quotes in a Markdown link title (#1472) ---

test('prose-dependency recognizes a Markdown link whose quoted title contains an escaped double quote', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 "reviewed \\"API\\"") has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency recognizes a Markdown link whose quoted title contains an escaped single quote', () => {
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      "[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 'reviewed \\'API\\'') has merged.",
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.detail ?? '', /#1391/);
});

test('prose-dependency does not warn on a cross-repo Markdown link with an escaped-quote title when currentRepo is known', () => {
  // Regression test for the exact label-leak #1472 describes: without
  // tolerating the escaped quote, the title sub-pattern closes early, the
  // whole Markdown-link alternative fails, and the label's own bare
  // `#1391` leaks through to the bare-`#` alternative and gets wrongly
  // flagged as local even though the link targets another repository.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/other-repo/pull/1391 "reviewed \\"API\\"") has shipped.',
  });
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    currentRepo: 'kurone-kito/idd-skill',
  });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not warn on a Markdown link with an escaped-quote title when the number already has a Blocked by encoding', () => {
  const body = childBody({
    extraMarkers:
      'Blocked by #1391\n\nBefore this can start, confirm ' +
      '[PR #1391](https://github.com/kurone-kito/idd-skill/pull/1391 "reviewed \\"API\\"") has merged.',
  });
  const report = auditAuthoredIssue(body, { shape: 'child' });
  const finding = report.findings.find(
    (entry) => entry.id === 'prose-dependency',
  );
  assert.ok(finding, 'prose-dependency finding should be present');
  assert.equal(finding.severity, undefined);
});

test('prose-dependency does not exhibit catastrophic backtracking on an adversarial escaped-quote-like run', () => {
  // Regression test for a real exponential-backtracking vulnerability
  // CodeQL caught in this PR's first draft of the escaped-quote fix: an
  // earlier version of the title sub-pattern let its "any non-quote,
  // non-newline character" alternative also match a bare backslash,
  // overlapping with the "backslash + any character" escape alternative.
  // That overlap gives the engine a combinatorially large (Fibonacci-many)
  // number of ways to partition a long run of backslashes before
  // concluding no match is possible, once no real closing quote/paren
  // follows -- an unbounded-length adversarial title is plausible input
  // (e.g. a pasted issue body). The fixed pattern excludes a literal
  // backslash from that character class, making the two alternatives
  // non-overlapping, so this must stay linear-time regardless of run
  // length.
  const body = childBody({
    extraMarkers:
      'Before this can start, confirm ' +
      `[x](https://github.com/o/r/pull/1 "${'\\!'.repeat(5000)}`,
  });
  const start = Date.now();
  auditAuthoredIssue(body, { shape: 'child' });
  const elapsedMs = Date.now() - start;
  assert.ok(
    elapsedMs < 2000,
    `expected linear-time evaluation, took ${elapsedMs}ms`,
  );
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
