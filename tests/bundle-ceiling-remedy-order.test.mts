import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  globToRegExp,
  stripGeneratedFromBanner,
} from '../src/scripts/consistency-helpers.mts';

// The fixed remedy order for a bundle-ceiling breach (#4128) lives in E12 of
// the review-fix instructions, and PR-submit only points at it.
const REVIEW_FIX_COPIES = [
  'idd-template/.github/instructions/idd-review-fix.instructions.md',
  '.github/instructions/idd-review-fix.instructions.md',
];
const PR_SUBMIT_COPIES = [
  'idd-template/.github/instructions/idd-pr-submit.instructions.md',
  '.github/instructions/idd-pr-submit.instructions.md',
];
const TEMPLATE_FILES = [REVIEW_FIX_COPIES[0], PR_SUBMIT_COPIES[0]];

/** The E12 budget-breach block: from its heading to the push paragraph. */
function budgetBreachBlock(path: string): string {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('**Budget breach.**');
  const end = text.indexOf(
    '**Bounded cross-round batching allowance.**',
    start,
  );
  assert.ok(start >= 0 && end > start, `${path} has the budget-breach block`);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

/** Index of each needle in order; fails when one is missing or out of order. */
function assertInOrder(text: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= 0, `"${needle}" appears after offset ${from}`);
    from = at + needle.length;
  }
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} lists the remedy steps in order, with the 95% split in step 2 (#4128)`, () => {
    const block = budgetBreachBlock(path);
    assertInOrder(block, [
      'above 98% of its `limitBytes`',
      '1. Move each obligation the change removes into `docs/idd-helper-scripts.md`',
      'in the same change; a bare link is not a move.',
      'Skip for lite files.',
      'Do not trim shared, terminology-sensitive text.',
      '2. If the bundle is still above 98%, read its base utilization',
      'If its base utilization was below 95%, raise the limit to about 10% above the new total',
      'PR-description callout. No question is asked.',
      'If its base utilization was at or above 95%, stop and ask once',
      'the bundle name, its utilization at the base ref, its bytes after step 1, and the proposed limit with about 10% headroom.',
      'Never commit the raise.',
      'For a per-file cap, apply step 1.',
      '(`phaseLimitBytes`, or `alwaysLoadedLimitBytes` for an always-loaded file), stop and ask once.',
      'Never raise a per-file cap.',
    ]);
    // The 95% split sits inside step 2, not after the per-file rule.
    const stepTwo = block.slice(
      block.indexOf('2. If the bundle is still above 98%'),
      block.indexOf('For a per-file cap'),
    );
    assert.match(stepTwo, /below 95%/);
    assert.match(stepTwo, /at or above 95%/);
  });
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} routes the E12 push through claimed-push, then pushes normally (#4564)`, () => {
    const block = budgetBreachBlock(path);
    assertInOrder(block.slice(block.indexOf('Then push the feature branch')), [
      'Then push the feature branch',
      '`claimed-push` as D2 does',
      'Under `instructions-only`, follow the E12 fallback in `docs/idd-helper-scripts.md`.',
    ]);
  });
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} keeps the E11 conflict and merge-failure outcomes (#4864, #4973)`, () => {
    const text = readFileSync(path, 'utf8');
    const start = text.indexOf('## E11 ');
    const end = text.indexOf('## E12 ', start);
    assert.ok(start >= 0 && end > start, `${path} has the E11 section`);
    assertInOrder(text.slice(start, end).replace(/\s+/g, ' '), [
      'Continue after a clean resolution;',
      'abort, report, and hold without pushing.',
      '**Merge failure:** a failed or timed-out signed merge follows the wrapper to the next "Commit signing" tier (configured, fallback, unsigned);',
      'if unsigned fails, run `git merge --abort`, report, and hold.',
    ]);
  });
}

/** One section of a file, from its heading to the next heading of the same level. */
function section(path: string, heading: string): string {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(heading);
  const level = heading.slice(0, heading.indexOf(' ') + 1);
  const end = text.indexOf(`\n${level}`, start + heading.length);
  assert.ok(start >= 0, `${path} has the "${heading}" section`);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
}

// Every signing site names its unsigned tier, so a signing failure never
// stops the loop (#4973).
const SIGNING_TIER_SITES: readonly [string, string, readonly string[]][] = [
  [
    'idd-template/.github/instructions/idd-overview-appendix.instructions.md',
    '## Commit signing',
    [
      'Signing is best-effort and never stops the loop:',
      'take the next tier (configured, fallback, unsigned)',
      "`docs/idd-helper-scripts.md`'s Signed-Commit Merge Wrapper;",
      'Record material progress, decisions, hold reasons, and any non-default signing outcome',
    ],
  ],
  [
    'idd-template/.github/instructions/lite/idd-review-fix-lite.instructions.md',
    '## E11 ',
    [
      "the repository's configured signing, then a configured fallback signer",
      'then unsigned.',
      '`git -c commit.gpgsign=false merge --continue` when unsigned',
      'A clean merge reruns at that tier instead, so its `pre-merge-commit` hook runs again',
      '`git merge --no-gpg-sign --no-ff` with the same `-m` subject',
      'Only a failure at the unsigned tier runs `git merge --abort` and stop-and-ask.',
    ],
  ],
  [
    'idd-template/.github/instructions/lite/idd-pr-submit-lite.instructions.md',
    '## D1 ',
    [
      '4. **Before rebasing**, pick the signing tier (a signing failure never stops D1): primary signing, else a wrapper for arbitrary git subcommands, else unsigned.',
      'or `git -c commit.gpgsign=false rebase origin/{development-branch}`.',
      'such as `git -c commit.gpgsign=false rebase --continue`',
      'with none left, abort and restart unsigned (step 7); an unsigned failure holds.',
      'last `git -c commit.gpgsign=false rebase origin/{development-branch}`; a conflict there goes to step 6, any other failure holds.',
      'repeat this D1 rebase (at the tier in use, unsigned last)',
    ],
  ],
  [
    'idd-template/.github/instructions/idd-pr-submit.instructions.md',
    '## D1 ',
    [
      'Signing follows the appendix\'s "Commit signing" tiers, so a signing failure never stops D1.',
      "With no staged content conflict, use this path in place of the wrapper's state-present `--continue`;",
      'except that its unsigned tier is this restart',
      'then `git -c commit.gpgsign=false rebase origin/{development-branch}`.',
    ],
  ],
  [
    'idd-template/docs/idd-helper-scripts.md',
    '## Signed-Commit Merge Wrapper',
    [
      "1. the repository's configured signing;",
      '2. a configured fallback signer, such as the wrapper above;',
      '3. unsigned: `--no-gpg-sign` for a commit or merge,',
      'Its unsigned tier is therefore a restart: `git rebase --abort`,',
      'Skip, without running it, a signer known to be unable to run without a terminal,',
      'Error text is not read.',
      "apply the calling site's conflict rule instead of the next tier.",
      'Release tags keep their own rule: see',
      'The same verification runs after a signed tier that exits nonzero before the 2-minute bound:',
      "Otherwise, on the timeout path only, before moving to the next tier, also compare the index's tree hash",
      "At D1 (`idd-pr-submit.instructions.md`), a rebase with no staged content conflict follows D1's failed-write restart instead of `--continue`;",
      'A merge that stopped with no conflict reruns at the next tier instead: `git merge --abort`, then the original merge command at that tier.',
      '**Signature check.**',
      'a signed commit has a `gpgsig` or `gpgsig-sha256` header there,',
      'Use `git log --format=%G?` only when a verifier is configured:',
    ],
  ],
];

for (const [path, heading, needles] of SIGNING_TIER_SITES) {
  test(`${path} ${heading.trim()} reaches the unsigned signing tier (#4973)`, () => {
    assertInOrder(section(path, heading), needles);
  });
}

// The three sentences that stopped the loop on a signing failure, exactly as
// they were wrapped before #4973. Each forbidden pattern must catch its own
// sentence, so a revert fails `node scripts/audit-docs.mjs --check`.
const OLD_SIGNING_STOP_SENTENCES: Readonly<Record<string, string>> = {
  'e11-merge-failure-signing-hold':
    '- **Merge failure:** run `git merge --abort`, report, and hold on a merge,\n' +
    '  signing, or hook failure; after a timeout, follow the wrapper.\n',
  'lite-e11-signing-failure-stop-and-ask':
    'the signed wrapper for merge and `--continue`. On command/signing/hook failure,\n' +
    'run `git merge --abort` and stop-and-ask. After a wrapper timeout, terminate\n',
  'lite-d1-signing-stop-and-ask-first':
    '4. **Before rebasing**: if primary signing is non-interactive-hostile (GPG\n' +
    '   pinentry or a hardware-touch path) and no fallback wrapper exists for\n' +
    '   arbitrary git subcommands, stop and ask first; replaying even one commit\n' +
    '   re-signs it.\n',
};

// The template file each old sentence lived in; the audit's glob must cover it.
const OLD_SIGNING_STOP_FILES: Readonly<Record<string, string>> = {
  'e11-merge-failure-signing-hold':
    'idd-template/.github/instructions/idd-review-fix.instructions.md',
  'lite-e11-signing-failure-stop-and-ask':
    'idd-template/.github/instructions/lite/idd-review-fix-lite.instructions.md',
  'lite-d1-signing-stop-and-ask-first':
    'idd-template/.github/instructions/lite/idd-pr-submit-lite.instructions.md',
};

interface ForbiddenPatternEntry {
  id: string;
  glob: string;
  pattern: string;
  message: string;
}

function forbiddenPatterns(): ForbiddenPatternEntry[] {
  const manifest = JSON.parse(
    readFileSync('audit/sync-manifest.json', 'utf8'),
  ) as { forbiddenPatterns?: ForbiddenPatternEntry[] };
  return manifest.forbiddenPatterns ?? [];
}

function templateInstructionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? templateInstructionFiles(path) : [path];
  });
}

for (const [id, oldText] of Object.entries(OLD_SIGNING_STOP_SENTENCES)) {
  test(`forbidden pattern ${id} catches its old sentence and nothing current (#4973)`, () => {
    const entry = forbiddenPatterns().find((candidate) => candidate.id === id);
    assert.ok(entry, `audit/sync-manifest.json has forbidden pattern ${id}`);
    assert.equal(entry.glob, 'idd-template/.github/instructions/**');
    assert.match(OLD_SIGNING_STOP_FILES[id] ?? '', globToRegExp(entry.glob));
    // The audit compiles each pattern case-insensitively over a whole file.
    const regex = new RegExp(entry.pattern, 'i');
    assert.match(oldText, regex);
    for (const path of templateInstructionFiles(
      'idd-template/.github/instructions',
    )) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), regex, path);
    }
  });
}

const LITE_REVIEW_FIX =
  'idd-template/.github/instructions/lite/idd-review-fix-lite.instructions.md';

test(`${LITE_REVIEW_FIX} runs post-fix-validate before the claimed-push steps (#4564)`, () => {
  const text = readFileSync(LITE_REVIEW_FIX, 'utf8');
  const start = text.indexOf('## E12 — Lint, test, push');
  const end = text.indexOf('\n## ', start + 1);
  assert.ok(
    start >= 0 && end > start,
    `${LITE_REVIEW_FIX} has the E12 section`,
  );
  assertInOrder(text.slice(start, end).replace(/\s+/g, ' '), [
    '1. Run `post-fix-validate`.',
    'profile-selected `claimed-push`',
    '`pushed: true`.',
    'Under `instructions-only`, verify the active claim, location, and scope,',
    '**pre-push-validate**, then push normally.',
  ]);
});

for (const path of TEMPLATE_FILES) {
  test(`${path} never names the approval key (#4128)`, () => {
    assert.equal(
      readFileSync(path, 'utf8').includes('nearCeilingRaiseApprovals'),
      false,
    );
  });
}

test('the template ships no audit directory (#4128)', () => {
  assert.equal(existsSync('idd-template/audit'), false);
});

for (const path of PR_SUBMIT_COPIES) {
  test(`${path} stays within the 40,000-byte phase cap and points at the order (#4128)`, () => {
    const text = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(stripGeneratedFromBanner(text), 'utf8');
    assert.ok(bytes <= 40000, `${path} is ${bytes} bytes`);
    assert.match(
      text,
      /A budget breach follows `idd-review-fix\.instructions\.md`'s E12 order\./,
    );
  });
}
