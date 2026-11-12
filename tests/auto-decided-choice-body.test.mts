import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditAuthoredIssue } from '../src/scripts/audit-authored-issue.mts';

// Guards the auto-decide branch of the issue-authoring bundle (issue #4968): a
// ready target that carries an `## Auto-decided choice` section must pass the
// child lint and the A4/A4.5 triage checks, and every place that routes the two
// interactive cases must name the branch or point to it. The generated
// `.claude` mirror is compared byte-for-byte by consistency.test.mts; this file
// reads the canonical bundle and the repo-root maintenance copy.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const ROUTING_FILES = [
  'skills/issue-authoring/references/contract.md',
  'skills/issue-authoring/SKILL.md',
  'skills/issue-authoring/references/workflow-boundary.md',
  'skills/issue-authoring/references/draft-patterns.md',
  'docs/issue-authoring-skill.md',
] as const;

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** Collapse line breaks and runs of spaces so wrapped prose matches. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

/**
 * Lines under `heading`, up to the next heading of the same or a higher level.
 * Headings inside a fenced code block do not end the section.
 */
function sectionUnder(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `heading "${heading}" is present`);
  const level = /^#+/u.exec(heading)?.[0].length ?? 1;
  const out: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    }
    if (!inFence) {
      const match = /^(#{1,6}) /u.exec(line);
      if (match && match[1].length <= level) {
        break;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/** The example section that `draft-patterns.md` shows, as a Markdown string. */
function autoDecidedChoiceExample(): string {
  const section = sectionUnder(
    read('skills/issue-authoring/references/draft-patterns.md'),
    '## Auto-decided choice example',
  );
  const block = /```markdown\n([\s\S]*?)```/u.exec(section);
  assert.ok(block, 'the example is a fenced Markdown block');
  return block[1].trimEnd();
}

function suitabilityFooter(score: number): string {
  return `---\n\n_Autopilot suitability: ${score} / 5 -- higher is more autopilot-suitable;\nbelow the configured floor is human-oriented._\n\n<!-- idd-skill-autopilot-suitability: ${score} -->`;
}

function effortFooter(hint: string): string {
  return `_Effort: ${hint} -- author-estimated size; a soft autopilot\nselection tie-breaker only._\n\n<!-- idd-skill-effort: ${hint} -->`;
}

/** A ready child body that carries the example section from the patterns file. */
function childBodyWithExample(): string {
  return [
    '# Cap the retries of the sync command',
    '',
    '## Background',
    '',
    'The sync command retries a failed upload without a bound.',
    '',
    '## Proposed change',
    '',
    'Stop retrying after `sync.maxRetries` attempts in `src/sync.mts`.',
    '',
    autoDecidedChoiceExample(),
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/sync.test.mts` passes with a case that stops after `sync.maxRetries` attempts',
    '',
    '## Candidate files',
    '',
    '- `src/sync.mts`',
    '- `tests/sync.test.mts`',
    '',
    suitabilityFooter(4),
    '',
    effortFooter('S'),
  ].join('\n');
}

test('draft-patterns carries an Auto-decided choice example with one complete entry', () => {
  const example = autoDecidedChoiceExample();
  assert.match(example, /^## Auto-decided choice$/mu);
  assert.match(flat(example), /No hearing was asked for/u);
  const entries = example.split(/^### /mu).slice(1);
  assert.equal(entries.length, 1, 'the example shows one entry');
  const entry = flat(entries[0]);
  assert.match(entry, /- Chosen option: /u);
  assert.match(entry, /- Alternatives: .*`Keep today's behavior`/u);
  assert.match(entry, /- Decision ID: `[^`\s;]+`/u);
});

test('a ready child body with the Auto-decided choice section passes the child lint and the triage checks', () => {
  const report = auditAuthoredIssue(childBodyWithExample(), {
    shape: 'child',
    markerPrefix: 'idd-skill',
  });
  assert.equal(report.passed, true);
  for (const finding of report.findings) {
    assert.equal(finding.result, 'pass', `${finding.id}: ${finding.detail}`);
  }
  const triage = report.findings.filter((finding) =>
    finding.id.startsWith('triage-'),
  );
  assert.ok(
    triage.some((finding) => finding.id === 'triage-a45-verifiability'),
    'the A4.5 checks ran',
  );
  assert.ok(
    triage.some((finding) => finding.id === 'triage-a4-autonomous_completion'),
    'the A4 checks ran',
  );
});

test('a needs-decision rewrite of a held body passes the lint the contract mandates', () => {
  const body = [
    '# Cap the retries of the sync command',
    '',
    '## Background',
    '',
    'The sync command retries a failed upload without a bound.',
    '',
    '## Proposed change',
    '',
    'Cap the retries once the open choice below is settled.',
    '',
    '## Decision needed',
    '',
    'Question: which source should the retry cap use?',
    '',
    '- Read the cap from `sync.maxRetries` in `src/sync.mts` (recommended).',
    '- Add a new `--max-retries` flag.',
    "- Keep today's behavior (no cap).",
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/sync.test.mts` passes with a case that covers the settled retry cap',
    '',
    '## Candidate files',
    '',
    '- `src/sync.mts`',
    '- `tests/sync.test.mts`',
    '',
    '<!-- idd-skill-authoring-bucket: needs-decision -->',
    '',
    suitabilityFooter(1),
    '',
    effortFooter('S'),
  ].join('\n');
  const report = auditAuthoredIssue(body, {
    shape: 'child',
    markerPrefix: 'idd-skill',
    expectedAuthoringBucket: 'needs-decision',
    labels: ['status:authoring', 'status:needs-decision'],
  });
  assert.equal(report.passed, true);
  for (const finding of report.findings) {
    assert.equal(finding.result, 'pass', `${finding.id}: ${finding.detail}`);
  }
});

test('every interactive-choice mention names the auto-decide branch or an unchanged route', () => {
  const pattern = /interactive[\s-]+(choice|rule|cases)/giu;
  for (const file of ROUTING_FILES) {
    const text = flat(read(file));
    // A mention inside the branch bullet itself is part of the branch.
    const branchStart = text.indexOf('**Auto-decide branch.**');
    const branchEnd = text.indexOf(
      'If a task cannot be expressed without unresolved human coordination',
    );
    let hits = 0;
    for (const match of text.matchAll(pattern)) {
      hits += 1;
      if (
        branchStart !== -1 &&
        match.index > branchStart &&
        match.index < branchEnd
      ) {
        continue;
      }
      const window = text.slice(
        Math.max(0, match.index - 240),
        match.index + match[0].length + 260,
      );
      assert.match(
        window,
        /auto-decide|unchanged route|other routes stay/iu,
        `${file}: "${match[0]}" at ${match.index} must name the auto-decide branch or an unchanged route near it`,
      );
    }
    assert.ok(hits > 0, `${file} still routes the two interactive cases`);
  }
});

test('the contract states the auto-decide branch and its release checklist item', () => {
  const contract = flat(read('skills/issue-authoring/references/contract.md'));
  for (const phrase of [
    '**Auto-decide branch.**',
    'an operator message in this conversation asks to be consulted before publication',
    'A plain request to author issues is not such a request.',
    'One request covers the current authoring set.',
    "`Keep today's behavior`",
    '`## Auto-decided choice` section with one entry per auto-decided choice',
    'lists each such choice under `constraints` as an agent choice with its evidence',
    '`class=authoringChoice`, `source` set to the target, and `set` set to the target',
    'first posts the void marker for that decision on that confirmation issue',
    'every rewrite touches only the failed choice',
    'the ask counts as one clarification round',
    'authoring-bucket: needs-decision',
    'then edit the body',
    'The target stays held in every case',
    '`standingApprovals.release`',
  ]) {
    assert.ok(contract.includes(phrase), `contract names: ${phrase}`);
  }
  const checklistItem =
    'every `decision` ID listed under `## Auto-decided choice`';
  for (const file of [
    'skills/issue-authoring/references/contract.md',
    'skills/issue-authoring/references/workflow-boundary.md',
    'docs/issue-authoring-skill.md',
  ]) {
    assert.ok(
      flat(read(file)).includes(checklistItem),
      `${file} carries the release checklist item`,
    );
  }
});
