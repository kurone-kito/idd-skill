import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTopLevelSection, readText } from './test-utils.mts';

const ADAPTER_FILES = ['CLAUDE.md', 'GEMINI.md'] as const;
const SHARED_TOP_LEVEL_SECTIONS = [
  '## Minimum requirements',
  '## Project standards',
  '## Key workflow rules',
  '## For IDD work',
];

test('AGENTS.md is the canonical guide: it carries every shared top-level section plus the full Branch strategy, Commit rules, and Codex issue-authoring route', () => {
  const agents = readText('AGENTS.md');
  for (const marker of [
    ...SHARED_TOP_LEVEL_SECTIONS,
    '## Branch strategy',
    '## Commit rules',
    '## Dogfood: token-cost events',
    '## Issue-authoring skill (dogfooded)',
    '## Codex issue-authoring route',
  ]) {
    assert.ok(
      agents.includes(marker),
      `AGENTS.md must keep the canonical section: ${marker}`,
    );
  }
});

test('AGENTS.md Project standards keeps the Helper sources rule', () => {
  const section = extractTopLevelSection(
    readText('AGENTS.md'),
    'AGENTS.md',
    '## Project standards',
  );
  assert.match(
    section,
    /\*\*Helper sources\*\*: the helper migration to TypeScript is complete/,
    'AGENTS.md must keep the Helper sources rule',
  );
  assert.ok(
    section.includes(
      'See [docs/typescript-sources.md](docs/typescript-sources.md).',
    ),
    'AGENTS.md must keep the Helper sources doc pointer',
  );
});

test('CLAUDE.md and GEMINI.md import AGENTS.md via a standalone @AGENTS.md line and do not restate its shared sections', () => {
  for (const file of ADAPTER_FILES) {
    const text = readText(file);
    assert.match(
      text,
      /^@AGENTS\.md$/m,
      `${file} must contain a standalone @AGENTS.md import line`,
    );
    for (const marker of SHARED_TOP_LEVEL_SECTIONS) {
      assert.ok(
        !text.includes(marker),
        `${file} must not restate "${marker}" -- it arrives via the @AGENTS.md import`,
      );
    }
  }
});

test('CLAUDE.md and GEMINI.md stay short adapters', () => {
  for (const file of ADAPTER_FILES) {
    const lineCount = readText(file).split('\n').length;
    assert.ok(
      lineCount < 40,
      `${file} should stay a short adapter (got ${lineCount} lines) -- long content belongs in AGENTS.md`,
    );
  }
});

test('CLAUDE.md carries a Claude-scoped delta and does not name Antigravity', () => {
  const claude = readText('CLAUDE.md');
  assert.match(claude, /Claude Code/, 'CLAUDE.md must name Claude Code');
  assert.match(
    claude,
    /In Claude Code specifically,[^.]*--vendor claude/,
    'CLAUDE.md must keep --vendor claude explicitly scoped to Claude Code (dual-loading safety), not a bare override',
  );
  assert.match(
    claude,
    /\.claude\/skills\/issue-authoring\//,
    'CLAUDE.md must keep the .claude/skills/ auto-discovery note',
  );
  assert.ok(
    !claude.includes('Antigravity'),
    'CLAUDE.md must not name Antigravity',
  );
});

test('GEMINI.md carries an Antigravity-scoped delta and does not name Claude or the .claude/skills/ detail', () => {
  const gemini = readText('GEMINI.md');
  assert.match(gemini, /Antigravity/, 'GEMINI.md must name Antigravity');
  assert.match(
    gemini,
    /vendor/i,
    'GEMINI.md must keep its token-cost vendor-skip note',
  );
  assert.ok(!gemini.includes('Claude'), 'GEMINI.md must not name Claude');
  assert.ok(
    !gemini.includes('.claude/skills/'),
    'GEMINI.md must not carry the Claude-only .claude/skills/ detail',
  );
});

test('.github/copilot-instructions.md stays a thin adapter and keeps the Commit rules pointer heading', () => {
  const copilot = readText('.github/copilot-instructions.md');
  assert.ok(
    !copilot.includes('canonical, fully detailed'),
    'copilot-instructions.md must no longer claim to be the canonical, fully detailed guide',
  );
  assert.match(
    copilot,
    /^## Commit rules$/m,
    'copilot-instructions.md must keep a Commit rules heading for the CONTRIBUTING*.md #commit-rules fragment',
  );
  assert.match(
    copilot,
    /AGENTS\.md#commit-rules/,
    'copilot-instructions.md Commit rules section must point at AGENTS.md#commit-rules',
  );
  for (const marker of SHARED_TOP_LEVEL_SECTIONS) {
    assert.ok(
      !copilot.includes(marker),
      `copilot-instructions.md must not restate "${marker}"`,
    );
  }
});
