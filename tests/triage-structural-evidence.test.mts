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

test('hasVerificationCommandSignal: a command in a LATER Setext-headed section does not count (Codex review, PR #2840)', () => {
  // A Setext-style sibling heading ("Notes\n-----", no leading `#`) must
  // stop the Acceptance criteria section just like an ATX heading does --
  // an ATX-only boundary let this later section's own command leak into
  // the extracted section text and wrongly set verificationCommand: true.
  const body = `## Acceptance criteria\n\n- [ ] Only one thing\n\nNotes\n-----\n\n- \`node --test tests/foo.test.mts\`\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a heading with no space after the # run is not a real ATX heading (Codex review, PR #2840)', () => {
  // CommonMark requires a space/tab (or end of line) after the ATX `#`
  // run -- `##Acceptance criteria` renders as ordinary paragraph text,
  // not a heading, so it must not open a fake Acceptance-criteria
  // section even when followed by content that would otherwise satisfy
  // the signal.
  const body = `##Acceptance criteria\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an example inside a raw HTML block (<pre>) does not count (Codex review, PR #2840 round 5)', () => {
  const body = [
    '<pre>',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '</pre>',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an escaped backtick command span does not count (Codex review, PR #2840 round 5)', () => {
  // CommonMark renders an escaped backtick (`\` + backtick) as a literal
  // character, never a real code-span delimiter.
  const body =
    '## Acceptance criteria\n\n- Run \\`node --test tests/example.test.mts\\` manually\n';
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a real (non-escaped) command span still counts (control)', () => {
  const body =
    '## Acceptance criteria\n\n- Run `node --test tests/example.test.mts`\n';
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a checkbox marker with no whitespace after ] does not render as a real task-list item (Codex review, PR #2840 round 7)', () => {
  const body = `## Acceptance criteria\n\n- [ ]not a task\n- [x]also not\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a heading split across two lines by the interior whitespace gap does not count (Codex review, PR #2840 round 7)', () => {
  // The interior gap between "Acceptance" and "criteria" must stay on one
  // line -- an ATX heading is inherently single-line, so "## Acceptance"
  // and a separate "criteria" line must never combine into one match.
  const body = `## Acceptance\ncriteria\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: case-insensitive heading', () => {
  const body = `## acceptance CRITERIA\n\n- [ ] a\n- [ ] b\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: an example inside a fenced code block does not count (Codex review, PR #2840)', () => {
  const body = [
    'Some prose about the marker syntax:',
    '',
    '```markdown',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '```',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an example inside an HTML comment does not count (Codex review, PR #2840)', () => {
  const body = [
    '<!--',
    '## Acceptance criteria',
    '',
    '- `node --test tests/foo.test.mts` passes',
    '-->',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a real command inside a real inline code span still counts even after masking (control)', () => {
  const body = `## Acceptance criteria\n\n- \`node --test tests/foo.test.mts\` passes\n`;
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

test('candidateFilesExistOnDisk: an absolute path candidate never satisfies the signal, even when existsAt is unconditionally true (CodeRabbit review, PR #2840)', () => {
  const body = `## Candidate files\n\n- \`/etc/passwd\`\n`;
  assert.equal(
    candidateFilesExistOnDisk(body, () => true, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: a Windows-drive-letter absolute path candidate never satisfies the signal, even on a POSIX host (CodeRabbit review, PR #2840)', () => {
  const body = `## Candidate files\n\n- \`C:\\Windows\\System32\\config\`\n`;
  assert.equal(
    candidateFilesExistOnDisk(body, () => true, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: a ../-escaping path candidate never satisfies the signal, even when existsAt is unconditionally true (CodeRabbit review, PR #2840)', () => {
  const body = `## Candidate files\n\n- \`../../etc/passwd\`\n`;
  assert.equal(
    candidateFilesExistOnDisk(body, () => true, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: a Windows-backslash-form ../-escaping path never satisfies the signal, even on a POSIX host (Copilot review, PR #2840)', () => {
  // On a genuinely POSIX host, `path.resolve`/`path.relative` never treat
  // a backslash as a directory separator, so this candidate cannot
  // actually escape repoRoot on the host actually running this test --
  // this exercises `resolveRepoPath`'s own defense-in-depth (the same
  // separator-agnostic check the drive-letter case already required),
  // not a POSIX-host escape.
  const body = '## Candidate files\n\n- `..\\..\\etc\\passwd`\n';
  assert.equal(
    candidateFilesExistOnDisk(body, () => true, '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: an example inside a fenced code block does not count (Codex review, PR #2840)', () => {
  const body = [
    'Some prose about the marker syntax:',
    '',
    '```markdown',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '```',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: an example inside an HTML comment does not count (Codex review, PR #2840)', () => {
  const body = [
    '<!--',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '-->',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: an example inside a raw HTML block (<pre>) does not count (Codex review, PR #2840 round 5)', () => {
  const body = [
    '<pre>',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '</pre>',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: a relative path whose internal ../ segment still normalizes inside repoRoot still resolves and can satisfy the signal', () => {
  const body = `## Candidate files\n\n- \`src/scripts/../scripts/exists.mts\`\n`;
  const existing = new Set(['/repo/src/scripts/exists.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
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
