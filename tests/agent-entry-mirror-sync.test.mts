import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractSection,
  extractTopLevelSection,
  readText,
} from './test-utils.mts';

const FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;
type EntryFile = (typeof FILES)[number];

const REQUIRED_TOOL_NAMES: Record<EntryFile, readonly string[]> = {
  'CLAUDE.md': ['Claude'],
  'AGENTS.md': ['Codex', 'OpenCode'],
  'GEMINI.md': ['Gemini'],
};

const SHARED_TOP_LEVEL_SECTIONS = [
  '## Minimum requirements',
  '## Project standards',
  '## Key workflow rules',
  '## For IDD work',
];

test('the shared preamble (title + intro) stays textually identical across the three agent entry files', () => {
  const preambles = FILES.map((file) =>
    extractSection(
      readText(file),
      '# Guidelines for AI Agents',
      '**Canonical reference**',
    ),
  );
  assert.equal(
    preambles[1],
    preambles[0],
    'AGENTS.md preamble must match CLAUDE.md',
  );
  assert.equal(
    preambles[2],
    preambles[0],
    'GEMINI.md preamble must match CLAUDE.md',
  );
});

test('shared top-level sections stay textually identical across CLAUDE.md, AGENTS.md, and GEMINI.md', () => {
  for (const marker of SHARED_TOP_LEVEL_SECTIONS) {
    const [claude, agents, gemini] = FILES.map((file) =>
      extractTopLevelSection(readText(file), file, marker),
    );
    assert.equal(
      agents,
      claude,
      `AGENTS.md must keep "${marker}" identical to CLAUDE.md`,
    );
    assert.equal(
      gemini,
      claude,
      `GEMINI.md must keep "${marker}" identical to CLAUDE.md`,
    );
  }
});

test('Project standards keeps the Helper sources rule in every agent entry file', () => {
  for (const file of FILES) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      '## Project standards',
    );
    assert.match(
      section,
      /\*\*Helper sources\*\*: the helper migration to TypeScript is complete/,
      `${file} must keep the Helper sources rule`,
    );
    assert.ok(
      section.includes(
        'See [docs/typescript-sources.md](docs/typescript-sources.md).',
      ),
      `${file} must keep the Helper sources doc pointer`,
    );
  }
});

test('Issue-authoring skill section keeps the canonical-bundle rule identical, with Claude-only content appended only in CLAUDE.md', () => {
  const heading = '## Issue-authoring skill (dogfooded)';
  const claude = extractTopLevelSection(
    readText('CLAUDE.md'),
    'CLAUDE.md',
    heading,
  );
  const agents = extractTopLevelSection(
    readText('AGENTS.md'),
    'AGENTS.md',
    heading,
  );
  const gemini = extractTopLevelSection(
    readText('GEMINI.md'),
    'GEMINI.md',
    heading,
  );

  assert.equal(
    agents,
    gemini,
    'AGENTS.md and GEMINI.md must carry the identical (Claude-free) issue-authoring section',
  );
  assert.ok(
    claude.startsWith(agents),
    'CLAUDE.md must keep the shared canonical-bundle rule as an identical prefix of its issue-authoring section',
  );
  assert.notEqual(
    claude,
    agents,
    'CLAUDE.md must still append the Claude-only auto-discovery sentence',
  );

  for (const [file, section] of [
    ['AGENTS.md', agents],
    ['GEMINI.md', gemini],
  ] as const) {
    assert.ok(
      !section.includes('.claude/skills/'),
      `${file} must not carry the Claude-only .claude/skills/ auto-discovery detail`,
    );
    assert.ok(
      !section.includes('Claude'),
      `${file} must not carry Claude-specific tool naming in the issue-authoring section`,
    );
  }
  assert.ok(
    claude.includes('.claude/skills/issue-authoring/'),
    'CLAUDE.md must keep the .claude/skills/ auto-discovery sentence',
  );
});

test('canonical-reference tool naming stays per-tool and does not cross-contaminate', () => {
  for (const file of FILES) {
    const section = extractSection(
      readText(file),
      '**Canonical reference**',
      '## Minimum requirements',
    );
    const ownNames = REQUIRED_TOOL_NAMES[file];
    const otherNames = FILES.filter((other) => other !== file).flatMap(
      (other) => REQUIRED_TOOL_NAMES[other],
    );
    for (const name of ownNames) {
      assert.ok(
        section.includes(name),
        `${file} canonical-reference paragraph must name ${name}`,
      );
    }
    for (const other of otherNames) {
      assert.ok(
        !section.includes(other),
        `${file} canonical-reference paragraph must not name ${other}`,
      );
    }
  }
});

test('GEMINI.md canonical-reference paragraph names Antigravity; the other entry files do not', () => {
  for (const file of FILES) {
    const section = extractSection(
      readText(file),
      '**Canonical reference**',
      '## Minimum requirements',
    );
    if (file === 'GEMINI.md') {
      assert.ok(
        section.includes('Antigravity'),
        'GEMINI.md canonical-reference paragraph must name Antigravity',
      );
    } else {
      assert.ok(
        !section.includes('Antigravity'),
        `${file} canonical-reference paragraph must not name Antigravity`,
      );
    }
  }
});
