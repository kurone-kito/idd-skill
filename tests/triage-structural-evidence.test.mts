import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTrustedLoginPredicate,
  candidateFilesExistOnDisk,
  evaluateStructuralEvidence,
  hasAllStructuralSignals,
  hasVerificationCommandSignal,
  isTrustedEditorSignal,
} from '../src/scripts/triage-structural-evidence.mts';

// --- hasVerificationCommandSignal -------------------------------------------

test('hasVerificationCommandSignal: true on a node --test code span in AC', () => {
  const body = `## Acceptance criteria\n\n- Run \`node --test tests/foo.test.mts\` and it passes\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: true on a pnpm run code span in AC', () => {
  const body = `## Acceptance criteria\n\n- \`pnpm run typecheck\` passes\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: true on an npx code span in AC', () => {
  const body = `## Acceptance criteria\n\n- \`npx biome check\` passes\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: true on a node scripts/*.mjs code span in AC', () => {
  const body = `## Acceptance criteria\n\n- \`node scripts/audit-docs.mjs --check\` passes\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: true on two checkbox items with no command', () => {
  const body = `## Acceptance criteria\n\n- [ ] First thing\n- [ ] Second thing\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: false on a single checkbox item', () => {
  const body = `## Acceptance criteria\n\n- [ ] Only one thing\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: false when the section is absent', () => {
  const body = `## Background\n\nSome prose, no AC section at all.\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: false on an unrelated code span in AC', () => {
  const body = `## Acceptance criteria\n\n- Update \`src/scripts/foo.mts\`\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a command in a LATER section does not count', () => {
  const body = `## Acceptance criteria\n\n- [ ] Only one thing\n\n## Candidate files\n\n- \`node --test tests/foo.test.mts\`\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: case-insensitive heading', () => {
  const body = `## acceptance CRITERIA\n\n- [ ] a\n- [ ] b\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

// --- candidateFilesExistOnDisk -----------------------------------------------

test('candidateFilesExistOnDisk: true when at least one listed path exists', () => {
  const body = `## Candidate files\n\n- \`src/scripts/exists.mts\`\n- \`src/scripts/missing.mts\`\n`;
  const existing = new Set(['/repo/src/scripts/exists.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

test('candidateFilesExistOnDisk: false when no listed path exists', () => {
  const body = `## Candidate files\n\n- \`src/scripts/missing.mts\`\n`;
  assert.equal(
    candidateFilesExistOnDisk(body, () => false, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: false when the section is absent', () => {
  const body = `## Background\n\nNo candidate files section here.\n`;
  assert.equal(
    candidateFilesExistOnDisk(body, () => true, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: resolves a bare instructions basename under .github/instructions', () => {
  const body = `## Candidate files\n\n- \`idd-template/.github/instructions/idd-suitability.instructions.md\`\n`;
  const existing = new Set([
    '/repo/.github/instructions/idd-suitability.instructions.md',
  ]);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

test('candidateFilesExistOnDisk: resolves a bare instructions basename under idd-template mirror', () => {
  const body = `## Candidate files\n\n- \`idd-template/.github/instructions/idd-discover.instructions.md\`\n`;
  const existing = new Set([
    '/repo/idd-template/.github/instructions/idd-discover.instructions.md',
  ]);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

// --- isTrustedEditorSignal ---------------------------------------------------

test('isTrustedEditorSignal: true when author and every editor are trusted', () => {
  const trusted = new Set(['alice', 'bob']);
  assert.equal(
    isTrustedEditorSignal('alice', ['bob', 'alice'], (login) =>
      trusted.has(login),
    ),
    true,
  );
});

test('isTrustedEditorSignal: true with no edit history and a trusted author', () => {
  const trusted = new Set(['alice']);
  assert.equal(
    isTrustedEditorSignal('alice', [], (login) => trusted.has(login)),
    true,
  );
});

test('isTrustedEditorSignal: false when the author is untrusted', () => {
  assert.equal(
    isTrustedEditorSignal('mallory', [], () => false),
    false,
  );
});

test('isTrustedEditorSignal: false when any editor is untrusted', () => {
  const trusted = new Set(['alice']);
  assert.equal(
    isTrustedEditorSignal('alice', ['mallory'], (login) => trusted.has(login)),
    false,
  );
});

test('isTrustedEditorSignal: false on a null (deleted/ghost) editor login, even with a permissive predicate', () => {
  assert.equal(
    isTrustedEditorSignal('alice', [null], () => true),
    false,
  );
});

test('isTrustedEditorSignal: false on an empty author', () => {
  assert.equal(
    isTrustedEditorSignal('', [], () => true),
    false,
  );
});

test('isTrustedEditorSignal: is case-insensitive on logins', () => {
  const trusted = new Set(['alice']);
  assert.equal(
    isTrustedEditorSignal('Alice', ['ALICE'], (login) => trusted.has(login)),
    true,
  );
});

// --- buildTrustedLoginPredicate ----------------------------------------------

test('buildTrustedLoginPredicate: static list wins without calling the collaborator check', () => {
  let collaboratorCallCount = 0;
  const predicate = buildTrustedLoginPredicate(['alice'], () => {
    collaboratorCallCount += 1;
    return false;
  });
  assert.equal(predicate('alice'), true);
  assert.equal(collaboratorCallCount, 0);
});

test('buildTrustedLoginPredicate: falls back to the collaborator predicate', () => {
  const predicate = buildTrustedLoginPredicate(
    ['alice'],
    (login) => login === 'bob',
  );
  assert.equal(predicate('bob'), true);
  assert.equal(predicate('mallory'), false);
});

// --- hasAllStructuralSignals --------------------------------------------------

test('hasAllStructuralSignals: true only when all three hold', () => {
  assert.equal(
    hasAllStructuralSignals({
      verificationCommand: true,
      candidateFilesExist: true,
      trustedEditor: true,
    }),
    true,
  );
});

test('hasAllStructuralSignals: false when any one signal is false', () => {
  assert.equal(
    hasAllStructuralSignals({
      verificationCommand: false,
      candidateFilesExist: true,
      trustedEditor: true,
    }),
    false,
  );
  assert.equal(
    hasAllStructuralSignals({
      verificationCommand: true,
      candidateFilesExist: false,
      trustedEditor: true,
    }),
    false,
  );
  assert.equal(
    hasAllStructuralSignals({
      verificationCommand: true,
      candidateFilesExist: true,
      trustedEditor: false,
    }),
    false,
  );
});

test('hasAllStructuralSignals: false on undefined evidence', () => {
  assert.equal(hasAllStructuralSignals(undefined), false);
});

// --- evaluateStructuralEvidence (integration of the three signals) ---------

test('evaluateStructuralEvidence: computes all three signals together', () => {
  const body = [
    '## Acceptance criteria',
    '',
    '- `node --test tests/foo.test.mts` passes',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  const trusted = new Set(['alice']);
  const evidence = evaluateStructuralEvidence({
    body,
    author: 'alice',
    editorLogins: [],
    isTrustedLogin: (login) => trusted.has(login),
    existsAt: (p) => existing.has(p),
    repoRoot: '/repo',
  });
  assert.deepEqual(evidence, {
    verificationCommand: true,
    candidateFilesExist: true,
    trustedEditor: true,
  });
  assert.equal(hasAllStructuralSignals(evidence), true);
});

test('evaluateStructuralEvidence: an untrusted editor alone keeps the overall result false', () => {
  const body = [
    '## Acceptance criteria',
    '',
    '- `node --test tests/foo.test.mts` passes',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  const trusted = new Set(['alice']);
  const evidence = evaluateStructuralEvidence({
    body,
    author: 'alice',
    editorLogins: ['mallory'],
    isTrustedLogin: (login) => trusted.has(login),
    existsAt: (p) => existing.has(p),
    repoRoot: '/repo',
  });
  assert.equal(evidence.trustedEditor, false);
  assert.equal(hasAllStructuralSignals(evidence), false);
});
