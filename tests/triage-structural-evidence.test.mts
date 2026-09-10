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

test('hasVerificationCommandSignal: a list marker and a later, unrelated bracketed paragraph do not combine into a checkbox (Codex review, PR #2840, round 16)', () => {
  // `\s+` between the marker and `[ ]` previously matched across a blank
  // line, so a bare `*` (an empty list item) followed by an unrelated
  // later paragraph starting with `[ ] one` counted as one combined
  // checkbox. `gh api /markdown` confirms GitHub renders these as two
  // separate, unrelated structures (an empty list item, then an ordinary
  // paragraph) -- never a real task-list checkbox. Two such pairs, so a
  // regression back to `\s+` would still show `true` (2+ false matches),
  // not just a weaker single-match false positive.
  const body = [
    '## Acceptance criteria',
    '',
    '*',
    '',
    '[ ] one',
    '',
    '*',
    '',
    '[ ] two',
    '',
  ].join('\n');
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

test('hasVerificationCommandSignal: a wrapped command on an indented list continuation right before a thematic break still counts (Codex review, PR #2840, round 15)', () => {
  // An indented continuation line of a list item (e.g. `- Run:` followed
  // by a two-space-indented command) is not top-level Setext-heading
  // content -- it belongs to the enclosing list item, a different
  // container level -- and a dedented `---` right after it is
  // CommonMark's own thematic break, not a Setext underline over that
  // indented line. `gh api /markdown` confirms this renders as a real
  // list-item continuation (the command stays inside the list item) plus
  // a real `<hr>`. The boundary previously truncated the section right
  // before this line, discarding the command it names.
  const body = [
    '## Acceptance criteria',
    '',
    '- Run:',
    '  `node --test tests/foo.test.mts`',
    '---',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a trailing checklist item followed by a thematic break still counts (control, round 8 behavior preserved by round 15)', () => {
  const body = '## Acceptance criteria\n\n- [ ] one\n- [ ] two\n---\n';
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a genuine 1-3-space-indented Setext heading right after a blank line still ends the section (Codex review, PR #2840, round 16)', () => {
  // Round 15's blanket "zero indentation required" heuristic went the
  // dangerous direction here: a genuine, CommonMark-legal indented Setext
  // heading right after a blank line (not a list-item continuation --
  // there is nothing to continue) was wrongly excluded, letting the
  // section read past it and pick up a later section's own command.
  // `gh api /markdown` confirms " Notes\n -----" renders as a real <h2>
  // heading here.
  const body = [
    '## Acceptance criteria',
    '',
    '- [ ] Only one thing',
    '',
    ' Notes',
    ' -----',
    '',
    '- `node --test tests/foo.test.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a continuation-of-a-continuation before a thematic break still counts (Codex review, PR #2840, round 16)', () => {
  // The round-16 fix's continuation lookbehind must also catch a SECOND
  // indented line whose own preceding line is itself indented (not
  // marker-led), not just a continuation's direct marker-led opener.
  const body = [
    '## Acceptance criteria',
    '',
    '- Run:',
    '  one',
    '  `node --test tests/foo.test.mts`',
    '---',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a genuine multi-line Setext heading does not leak a later real command into the section (Codex review, PR #2840, round 20)', () => {
  // CommonMark lets a Setext heading's own content span several lines --
  // round 16's fix only checked ONE line back, so it wrongly treated the
  // heading's own SECOND content line as a "continuation" just because
  // the FIRST content line above it was also indented. `gh api /markdown`
  // confirms CommonMark forms one heading from both lines together.
  const body = [
    '## Acceptance criteria',
    '',
    '- [ ] Only one thing',
    '',
    ' First line',
    ' Second line',
    ' ---',
    '',
    '- `node --test tests/foo.test.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a multi-line Setext heading whose first line is a real command span does not count (Codex review, PR #2840, round 22)', () => {
  // Round 20 documented a "residual" claiming the extra leaked line
  // (recognized starting at the heading's LAST content line, not its
  // first) was inert prose that could not itself satisfy
  // verificationCommand -- disproven here: a code span inside Setext
  // heading text still renders as a real <code> element (`gh api
  // /markdown` confirms `<h2><code>node --test fake.test.mjs</code><br>
  // Notes</h2>`), so leaving it inside the section wrongly counted a
  // command that belongs to a different, later section entirely.
  const body = [
    '## Acceptance criteria',
    '',
    '- [ ] Only one thing',
    '',
    '`node --test fake.test.mjs`',
    'Notes',
    '---',
    '',
    '- `real/candidate.mts`',
    '',
  ].join('\n');
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

test("hasVerificationCommandSignal: a raw HTML block (<pre>) opened as a list item's own first line does not count (Codex review, PR #2840, round 11)", () => {
  // `- <pre>` previously left the block fully unmasked (findHtmlBlockRanges
  // tested the unstripped "- <pre>" line, which its opener patterns --
  // anchored at the line start -- never matched), so the two fake
  // checkbox lines inside it were counted as real. Verified against
  // GitHub's own renderer (gh api /markdown): the whole <pre> content
  // renders as literal text, never a real checklist.
  const body = [
    '## Acceptance criteria',
    '',
    '- <pre>',
    '  - [ ] one',
    '  - [ ] two',
    '  </pre>',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/exists.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a raw HTML block (<pre>) containing a fake heading, opened as a list item, does not count (Codex review, PR #2840, round 11)', () => {
  // Same fix, a second angle: the fake heading inside the <pre> was
  // already never counted as a real section boundary (it happened to be
  // read as a NEXT_ATX_HEADING_PATTERN match instead, truncating the
  // section early) -- this stays false, but now for the right reason: the
  // whole block is masked, so neither the fake heading nor the fake
  // checkboxes are visible to any signal at all.
  const body = [
    '## Acceptance criteria',
    '',
    '- <pre>',
    '  ## Acceptance criteria',
    '',
    '  - [ ] one',
    '  - [ ] two',
    '  </pre>',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/exists.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: a raw HTML block (<pre>) opened inside a blockquote does not count (Codex review, PR #2840, round 11)', () => {
  const body = [
    '## Acceptance criteria',
    '',
    '> <pre>',
    '> - [ ] one',
    '> - [ ] two',
    '> </pre>',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/exists.mts`',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an Acceptance criteria section after an unclosed raw HTML block opened inside a blockquote still counts (Codex review, PR #2840, round 15)', () => {
  // An unclosed `<pre>` inside a blockquote previously scanned to end of
  // text looking for a real `</pre>`, masking the real Acceptance
  // criteria section that follows once the blockquote itself ends.
  // `gh api /markdown` confirms GitHub closes the block at the
  // blockquote's own end, never leaking past it.
  const body = [
    '> <pre>',
    '> still open',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: fake checkboxes inside a custom tag right after the Acceptance criteria heading do not count (Codex review, PR #2840, round 20)', () => {
  // The Acceptance-criteria heading itself is a complete, one-line block
  // -- it leaves no open paragraph behind, so the custom tag right after
  // it (no blank line between) still freely opens per CommonMark. `gh
  // api /markdown` confirms the fake checkboxes inside it render as
  // literal text, never real checkboxes.
  const body = [
    '## Acceptance criteria',
    '<x-demo>',
    '- [ ] one',
    '- [ ] two',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an Acceptance criteria heading right after a same-line open+close custom tag still counts (Codex review, PR #2840, round 18)', () => {
  // A complete `<span>intro</span>` entirely on one line is an ordinary
  // paragraph, not an HTML block opener (CommonMark's type-7 rule
  // requires the tag be followed only by whitespace to end of line) --
  // the real Acceptance criteria heading right after it (no blank line
  // between) is still a real heading. `gh api /markdown` confirms this.
  const body = [
    '<span>intro</span>',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: an Acceptance criteria section after a fenced example containing an unclosed raw tag still counts (Codex review, PR #2840, round 14)', () => {
  // Same round-14 fenced-bleed fix as candidateFilesExistOnDisk's mirror
  // test above: the unclosed `<pre>` inside the fence previously extended
  // an "HTML block" range through the remainder of the body (no real
  // closing tag anywhere), masking the real checkboxes below it.
  const body = [
    '## Acceptance criteria',
    '',
    'Example:',
    '',
    '```',
    '<pre>',
    'unclosed',
    '```',
    '',
    '- [ ] one',
    '- [ ] two',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test("hasVerificationCommandSignal: a custom-tag HTML block opened as a list item's own first line does not count (Codex review, PR #2840, round 13)", () => {
  // Round 11 fixed the opener-detection *pattern match* for a list-marker
  // prefix but left the custom-tag branch's blank-line-eligibility gate
  // unextended: `- <x-demo>` right after another list item's own text
  // (not a blank line) is still a fresh list item's own first line --
  // CommonMark 5.2 -- with no "previous line" inside that new container
  // for the paragraph-interruption rule to apply to. Verified against
  // GitHub's own renderer (gh api /markdown): the unknown `<x-demo>` tag
  // is sanitized and its content, including the fake checkboxes, renders
  // as literal text, never a real checklist.
  const body = [
    '## Acceptance criteria',
    '',
    '- first item bullet text',
    '- <x-demo>',
    '  - [ ] one',
    '  - [ ] two',
    '  </x-demo>',
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

test('hasVerificationCommandSignal: an ATX heading indented up to 3 spaces is still real (advisor review, round 9)', () => {
  // CommonMark allows up to three leading spaces before an ATX heading's
  // `#` run without demoting it to an indented code block.
  const body = `   ## Acceptance criteria\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: an ATX heading indented 4+ spaces is an indented code block, not a heading (control)', () => {
  const body = `    ## Acceptance criteria\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an ATX heading with a whitespace-preceded closing # sequence is still real (advisor review, round 9)', () => {
  const body = `## Acceptance criteria ##\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a closing # sequence glued directly to the text (no space) is part of the heading text, not a closing sequence (control)', () => {
  // CommonMark requires whitespace before a real closing sequence -- with
  // none, the trailing "##" is ordinary heading text, so "Criteria##" (not
  // "Criteria") is what the pattern must NOT match here.
  const body = `## Acceptance criteria##\n\n- [ ] one\n- [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an ordered-list checkbox item counts the same as a bulleted one (advisor review, round 9)', () => {
  // GFM's task-list extension applies to any list item, ordered or
  // unordered -- "1. [ ] one" is a real, GitHub-rendered checkbox.
  const body = `## Acceptance criteria\n\n1. [ ] one\n2. [ ] two\n`;
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: non-1-numbered ordered markers right after prose do not count (Codex review, PR #2840, round 17)', () => {
  // A non-`1`-numbered ordered marker cannot interrupt an already-open
  // paragraph per CommonMark 5.2, so `prose\n2. [ ] a\n3. [ ] b` renders as
  // one plain paragraph (with hard line breaks), never real checkboxes.
  // `gh api /markdown` confirms this.
  const body = [
    '## Acceptance criteria',
    '',
    'Some prose describing the work.',
    '2. [ ] first',
    '3. [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: bullet markers right after prose still count (control, round 17)', () => {
  // Unlike a non-1 ordered marker, a bullet CAN interrupt a paragraph per
  // CommonMark -- gh api /markdown confirms real checkboxes here.
  const body = [
    '## Acceptance criteria',
    '',
    'Some prose describing the work.',
    '- [ ] first',
    '- [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a 1-numbered ordered marker right after prose still counts (control, round 17)', () => {
  // A `1.`-numbered ordered marker CAN interrupt a paragraph per
  // CommonMark, unlike `2.`/`3.` -- gh api /markdown confirms real
  // checkboxes here.
  const body = [
    '## Acceptance criteria',
    '',
    'Some prose describing the work.',
    '1. [ ] first',
    '2. [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a non-1-numbered checkbox continuing an already-open list still counts (round 17)', () => {
  // The continuation rule: a checkbox line right after ANY other list-item
  // line (not just a blank line) is part of the same already-open list,
  // not a fresh interruption attempt.
  const body = [
    '## Acceptance criteria',
    '',
    '1. [ ] first',
    '2. [ ] second',
    '3. [ ] third',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a non-interrupting ordered line does not seed a continuation for the checkbox after it (Codex review, PR #2840, round 19)', () => {
  // Round 17's own bug: a non-1-numbered ordered line's mere shape
  // (looking list-item-like) was enough to mark it "was a list item" for
  // the NEXT line's continuation check, even though the line itself never
  // actually opened or continued a real list (CommonMark keeps the whole
  // run inside the original paragraph). `gh api /markdown` confirms zero
  // real checkboxes render here -- one plain paragraph with hard breaks.
  const body = [
    '## Acceptance criteria',
    '',
    'Some prose describing the work.',
    '2. ordinary',
    '3. [ ] first',
    '4. [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), false);
});

test('hasVerificationCommandSignal: an indented explanation between two ordered checkboxes does not end the list (Codex review, PR #2840, round 21)', () => {
  // CommonMark keeps an indented continuation line inside the preceding
  // list item's own content, with the list still open for the next
  // marker right after it. `gh api /markdown` confirms both items render
  // as real checkboxes.
  const body = [
    '## Acceptance criteria',
    '',
    '1. [ ] first',
    '   an indented explanation',
    '2. [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: an unindented lazy continuation between two ordered checkboxes does not end the list (Codex review, PR #2840, round 24)', () => {
  // CommonMark's lazy-continuation rule lets a paragraph (list-item
  // content included) continue on a following non-blank line regardless
  // of that line's own indentation -- `gh api /markdown` confirms both
  // items render as real checkboxes even though "lazy continuation"
  // carries zero indentation.
  const body = [
    '## Acceptance criteria',
    '',
    '1. [ ] first',
    'lazy continuation',
    '2. [ ] second',
    '',
  ].join('\n');
  assert.equal(hasVerificationCommandSignal(body), true);
});

test('hasVerificationCommandSignal: a mixed multi-line double-backtick span with real headings inside is real structure, not smuggled content (Codex review, PR #2840 round 9 -- rejected)', () => {
  // Considered a P1 smuggling finding, then rejected after verification
  // against GitHub's own renderer (`gh api /markdown`, mode: gfm): an ATX
  // heading line interrupts an already-open paragraph in CommonMark, so
  // the opening "``" here is closed as its own one-line paragraph before
  // the "## Acceptance criteria" line is ever reached, and the unclosed
  // backtick run reverts to literal text -- the heading, checkboxes, and
  // the later code span all render as real structure, exactly as this
  // signal reports them. `true` is the correct answer, not a bug.
  const body = [
    'Real content.',
    '',
    '``',
    '## Acceptance criteria',
    '- [ ] one',
    '- [ ] two',
    '## Candidate files',
    '- `src/scripts/exists.mts`',
    '``',
    '',
  ].join('\n');
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

test('candidateFilesExistOnDisk: a real Candidate files section after an unclosed raw HTML block opened inside a blockquote still counts (Codex review, PR #2840, round 15)', () => {
  const body = [
    '> <pre>',
    '> still open',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

test('candidateFilesExistOnDisk: a real Candidate files section after a fenced example containing an unclosed raw tag still counts (Codex review, PR #2840, round 14)', () => {
  // `findHtmlBlockRanges` previously scanned the raw text independent of
  // fenced-code ranges: the unclosed `<pre>` inside the fence had no real
  // closing tag anywhere in the body, so it opened a raw-text block that
  // extended through the remainder of the body -- masking this genuine
  // section entirely. `gh api /markdown` confirms GitHub renders the
  // fenced block as a literal code block; the real section after it is
  // real structure.
  const body = [
    'Example:',
    '',
    '```',
    '<pre>',
    'unclosed',
    '```',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/foo.mts`',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/foo.mts']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
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

test('candidateFilesExistOnDisk: resolves a full idd-template instructions path as written, not its mirror (Codex review, PR #2840 round 8)', () => {
  // #2767 round 8: a full path is resolved as raw-written, never
  // normalized-then-mirror-collapsed -- the pre-fix version resolved this
  // against the *mirror* location instead (a false positive when the
  // idd-template source itself does not exist), which is exactly the
  // class of bug the round-8 fix (raw vs. normalized) closes. The
  // idd-template source path itself must exist for this to pass.
  const body = `## Candidate files\n\n- \`idd-template/.github/instructions/idd-suitability.instructions.md\`\n`;
  const existing = new Set([
    '/repo/idd-template/.github/instructions/idd-suitability.instructions.md',
  ]);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

test('candidateFilesExistOnDisk: does not satisfy the signal via the mirror when only the idd-template source path was written', () => {
  // The mirror-only existence case: the body names the idd-template
  // source path, but only the non-idd-template mirror exists on disk --
  // must NOT satisfy the signal, since the path as actually written does
  // not exist.
  const body = `## Candidate files\n\n- \`idd-template/.github/instructions/idd-suitability.instructions.md\`\n`;
  const existing = new Set([
    '/repo/.github/instructions/idd-suitability.instructions.md',
  ]);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    false,
  );
});

test('candidateFilesExistOnDisk: a normalized-only match (contention key, not a real path) does not satisfy the signal (Codex review, PR #2840 round 8)', () => {
  // The exact case Codex reported: `idd-template/package.json` does not
  // exist, but normalizeContentionPath's `idd-template/`-stripping
  // collapses it to the contention key `package.json`, which DOES exist
  // at repo root. Resolving the raw path (not the normalized key) must
  // not be fooled by that coincidence.
  const body = `## Candidate files\n\n- \`idd-template/package.json\`\n`;
  const existing = new Set(['/repo/package.json']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    false,
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

test("candidateFilesExistOnDisk: a later raw spelling sharing an earlier one's contention key still resolves (Codex review, PR #2840 round 9)", () => {
  // parseCandidateFileEntries previously de-duplicated on `normalized`,
  // discarding the second entry here (`package.json`) because its
  // contention key collides with the first (`idd-template/package.json`,
  // which normalizes to the same key but does not exist). The later raw
  // spelling is the one that actually exists on disk, so it must not be
  // silently dropped.
  const body = `## Candidate files\n\n- \`idd-template/package.json\`\n- \`package.json\`\n`;
  const existing = new Set(['/repo/package.json']);
  assert.equal(
    candidateFilesExistOnDisk(body, (p) => existing.has(p), '/repo'),
    true,
  );
});

test('candidateFilesExistOnDisk: a mixed multi-line double-backtick span with a real path inside is real structure, not smuggled content (Codex review, PR #2840 round 9 -- rejected)', () => {
  // Same rejected finding as hasVerificationCommandSignal's mirrored test
  // -- see that test's comment for the full CommonMark rationale, verified
  // against GitHub's own renderer. `true` is correct here too: the file
  // path lives inside a genuine single-backtick inline code span (its own
  // one-line paragraph, following the real "## Candidate files" heading),
  // not inside the outer double-backtick run, which never actually closes.
  const body = [
    'Real content.',
    '',
    '``',
    '## Acceptance criteria',
    '- [ ] one',
    '- [ ] two',
    '## Candidate files',
    '- `src/scripts/exists.mts`',
    '``',
    '',
  ].join('\n');
  const existing = new Set(['/repo/src/scripts/exists.mts']);
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
