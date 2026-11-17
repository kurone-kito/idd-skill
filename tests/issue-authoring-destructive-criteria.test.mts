import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the "Destructive operations" rule for drafted issues: the contract
// section, the completed-draft critique checklist item, the drafting-pattern
// example, the skill's output checklist bullet, and the repo-root maintenance
// copy's section and checklist item. The generated `.claude`
// mirror is compared byte-for-byte by consistency.test.mts; this file reads the
// canonical bundle and the repo-root maintenance copy.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUNDLE = join(REPO_ROOT, 'skills/issue-authoring');

function readBundle(relativePath: string): string {
  return readFileSync(join(BUNDLE, relativePath), 'utf8');
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

/** Collapse line breaks and runs of spaces so wrapped prose matches. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

const CASE_LABELS = [
  'Ownership',
  'User edits',
  'Overwrite',
  'Links',
  'Recursive removal',
  'Root containment',
];

test('contract has a Destructive operations section with the six cases in order', () => {
  const contract = readBundle('references/contract.md');
  const section = sectionUnder(contract, '### Destructive operations');
  const items = [...section.matchAll(/^(\d+)\. \*\*([^*]+)\.\*\*/gmu)];
  assert.deepEqual(
    items.map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    items.map((match) => match[2]),
    CASE_LABELS,
  );
  assert.match(
    flat(section),
    /or names the guard that makes the case impossible/u,
  );
});

test('critique checklist has an item asking for all six destructive-operation cases', () => {
  const contract = readBundle('references/contract.md');
  const start = contract.indexOf('**Issue-authoring critique checklist.**');
  assert.notEqual(start, -1, 'critique checklist is present');
  const end = contract.indexOf('### Resolver', start);
  assert.notEqual(end, -1, 'checklist ends before the Resolver section');
  const checklist = flat(contract.slice(start, end));
  assert.match(
    checklist,
    /- a draft that deletes, overwrites, recursively removes, records ownership of a file, or writes to a path that could be a link gives each such operation an acceptance criterion for each of the six cases under \[Destructive operations\]\(#destructive-operations\)/u,
  );
});

test('drafting patterns carry a Destructive operations example with six case rows', () => {
  const patterns = readBundle('references/draft-patterns.md');
  const section = sectionUnder(patterns, '## Destructive operations example');
  const block = /```markdown\n([\s\S]*?)```/u.exec(section);
  assert.ok(block, 'the example is a fenced Markdown block');
  const body = block[1];
  assert.match(body, /^## Acceptance criteria$/mu);
  const tableLines = body.split('\n').filter((line) => line.startsWith('|'));
  assert.ok(tableLines.length >= 3, 'the table has a header and rows');
  assert.match(
    tableLines[0],
    /^\| Input +\| Expected verdict +\| Source decision +\|$/u,
  );
  assert.match(tableLines[1], /^\| -+ \| -+ \| -+ \|$/u);
  const rows = tableLines.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
  assert.equal(rows.length, 6, 'the example has exactly six body rows');
  rows.forEach((cells, index) => {
    assert.equal(cells.length, 3, `row ${index + 1} has three cells`);
    assert.match(
      cells[2],
      new RegExp(`Destructive operations case ${index + 1}(?!\\d)`, 'u'),
      `row ${index + 1} names case ${index + 1}`,
    );
  });
});

/** Each bullet of the Output Checklist, flattened and trimmed. */
function checklistBullets(text: string): string[] {
  return sectionUnder(text, '## Output Checklist')
    .split(/\n(?=- )/u)
    .map((bullet) => flat(bullet).trim());
}

/** The Reference inventory paragraph, flattened, from its bold lead-in to the blank line. */
function referenceInventoryParagraph(text: string): string {
  const start = text.indexOf('**Reference inventory.**');
  assert.notEqual(start, -1, 'the Reference inventory paragraph is present');
  const blank = text.indexOf('\n\n', start);
  return flat(text.slice(start, blank === -1 ? text.length : blank));
}

/** The completed-draft critique checklist bullet for the inventory, flattened. */
function critiqueInventoryBullet(text: string): string {
  const start = text.indexOf(
    '\n- a draft that deletes, renames, or moves a repository path or tree includes',
  );
  assert.notEqual(start, -1, 'the critique checklist has the inventory bullet');
  const ends = [
    text.indexOf('\n- ', start + 1),
    text.indexOf('\n\n', start + 1),
  ].filter((index) => index !== -1);
  return flat(text.slice(start, ends.length ? Math.min(...ends) : text.length));
}

// Each statement below is a sentence or clause of the rule. Removing it from
// the paragraph or from the critique bullet fails the test that names it.
const PARAGRAPH_STATEMENTS = [
  'applies on its own, whether or not one of the six cases applies, and it replaces none of them.',
  'A drafted change that deletes, renames, or moves a repository path or tree includes, before publication, an inventory of the repository references to that path and of its executable consumers.',
  'The inventory covers prose documentation that names the path, and links, tests, hooks, workflows, templates, and scripts that read, open, or point at it.',
  'it adds each reference or consumer that must change to Candidate files, and the body names each one that stays valid with the reason it remains valid;',
  'that statement is body prose, not an acceptance criterion.',
  'Like the restating-site search in [Codebase-fidelity validation](#codebase-fidelity-validation),',
  'The completed-draft critique checklist asks the reviewer to check this; `audit-authored-issue` does not.',
];

const CRITIQUE_STATEMENTS = [
  'a draft that deletes, renames, or moves a repository path or tree includes the reference inventory under [Destructive operations](#destructive-operations)',
  'repository references, including prose documentation that names the path, and executable consumers (links, tests, hooks, workflows, templates, and scripts);',
  'the reviewer flags a draft with no inventory, or one where a reference or consumer is neither in Candidate files nor explained as still valid',
];

function repoRootMaintenanceCopy(): string {
  return readFileSync(join(REPO_ROOT, 'docs/issue-authoring-skill.md'), 'utf8');
}

test('the Reference inventory paragraph keeps every statement in the contract and the repo-root copy', () => {
  for (const text of [
    readBundle('references/contract.md'),
    repoRootMaintenanceCopy(),
  ]) {
    const paragraph = referenceInventoryParagraph(text);
    for (const statement of PARAGRAPH_STATEMENTS) {
      assert.ok(
        paragraph.includes(statement),
        `Reference inventory paragraph keeps: ${statement}`,
      );
    }
  }
});

test('the critique checklist inventory bullet keeps every statement in the contract and the repo-root copy', () => {
  for (const text of [
    readBundle('references/contract.md'),
    repoRootMaintenanceCopy(),
  ]) {
    const bullet = critiqueInventoryBullet(text);
    for (const statement of CRITIQUE_STATEMENTS) {
      assert.ok(
        bullet.includes(statement),
        `critique inventory bullet keeps: ${statement}`,
      );
    }
  }
});

test('skill output checklist has a bullet pointing to the Destructive operations section', () => {
  const bullets = checklistBullets(readBundle('SKILL.md')).filter((bullet) =>
    bullet.includes('deletes, overwrites, recursively removes'),
  );
  assert.equal(
    bullets.length,
    1,
    'exactly one bullet names the destructive cases',
  );
  assert.match(
    bullets[0],
    /^- For a draft that deletes, overwrites, recursively removes, records file ownership, or writes through a possible link, .*\(references\/contract\.md#destructive-operations\), or name the guard that makes the case impossible\.$/u,
  );
});

test('skill output checklist has a bullet for the reference inventory on deleted, renamed, or moved paths', () => {
  const bullets = checklistBullets(readBundle('SKILL.md')).filter((bullet) =>
    bullet.includes('deletes, renames, or moves a repository path or tree'),
  );
  assert.equal(
    bullets.length,
    1,
    'exactly one bullet names the deletion trigger',
  );
  assert.match(
    bullets[0],
    /^- For a draft that deletes, renames, or moves a repository path or tree, include the reference inventory under \[Destructive operations\]\(references\/contract\.md#destructive-operations\): /u,
  );
});

test('repo-root maintenance copy names the Destructive operations section, its six cases, and its checklist item', () => {
  const maintenance = readFileSync(
    join(REPO_ROOT, 'docs/issue-authoring-skill.md'),
    'utf8',
  );
  const section = sectionUnder(maintenance, '## Destructive operations');
  const items = [...section.matchAll(/^(\d+)\. \*\*([^*]+)\.\*\*/gmu)];
  assert.deepEqual(
    items.map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    items.map((match) => match[2]),
    CASE_LABELS,
  );
  assert.match(
    flat(maintenance),
    /- a draft that deletes, overwrites, recursively removes, records ownership of a file, or writes to a path that could be a link gives each such operation an acceptance criterion for each of the six cases under \[Destructive operations\]\(#destructive-operations\)/u,
  );
});
