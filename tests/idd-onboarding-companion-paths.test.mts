import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readText } from './test-utils.mts';

// The companion gh-api/curl shell lists and the Option B local-copy
// example moved from ONBOARDING.md into template-distribution.md's
// "Remote fetch examples" / "Local-copy installs" sections (#2283); the
// generated companion inventory block and the Step 1B/2 prose stayed in
// ONBOARDING.md.
const ONBOARDING = readText('idd-template/ONBOARDING.md');
const TEMPLATE_DISTRIBUTION = readText(
  'idd-template/docs/onboarding/template-distribution.md',
);

function extractShellList(id: string): string {
  const marker = `<!-- audit:shell-list id=${id} -->`;
  const markerIndex = TEMPLATE_DISTRIBUTION.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing shell-list marker: ${id}`);
  const fenceStart = TEMPLATE_DISTRIBUTION.indexOf('```sh', markerIndex);
  assert.notEqual(fenceStart, -1, `missing shell block: ${id}`);
  const fenceEnd = TEMPLATE_DISTRIBUTION.indexOf('\n```', fenceStart);
  assert.notEqual(fenceEnd, -1, `unterminated shell block: ${id}`);
  return TEMPLATE_DISTRIBUTION.slice(fenceStart, fenceEnd);
}

function assertNativeDestination(shell: string, label: string): void {
  assert.match(
    shell,
    /SKILL_DEST="\$\{DEST\}\/\.agents\/skills\/issue-authoring"/u,
    `${label} must show the Codex native destination example`,
  );
  assert.match(
    shell,
    /\$\{SKILL_DEST\}\/\$\{FILE\}/u,
    `${label} must write every source file through SKILL_DEST`,
  );
  assert.doesNotMatch(
    shell,
    /\$\{DEST\}\/skills\/issue-authoring/u,
    `${label} must not fall back to target skills/issue-authoring`,
  );
}

test('remote companion fetches keep canonical source paths separate from the native destination', () => {
  const ghApi = extractShellList('issue-authoring-companion-gh-api-loop');
  const curl = extractShellList('issue-authoring-companion-curl-loop');

  for (const [label, shell] of [
    ['gh api', ghApi],
    ['curl', curl],
  ] as const) {
    assertNativeDestination(shell, label);
  }
  assert.match(
    ghApi,
    /contents\/skills\/issue-authoring\/\$\{FILE\}/u,
    'gh api must request the canonical source bundle',
  );
  assert.match(
    curl,
    /BASE="https:\/\/raw\.githubusercontent\.com\/kurone-kito\/idd-skill\/main\/skills\/issue-authoring"/u,
    'curl must fetch from the canonical source bundle',
  );
});

test('local companion copy uses the selected native destination', () => {
  const localCopyStart = TEMPLATE_DISTRIBUTION.indexOf(
    '## Local-copy installs',
  );
  const boundary = TEMPLATE_DISTRIBUTION.indexOf(
    '## Maintenance checklist',
    localCopyStart,
  );
  assert.notEqual(localCopyStart, -1, 'missing local-copy section');
  assert.notEqual(boundary, -1, 'missing maintenance checklist section');
  const localCopy = TEMPLATE_DISTRIBUTION.slice(localCopyStart, boundary);

  assert.match(localCopy, /SOURCE="skills\/issue-authoring"/u);
  assert.match(localCopy, /TARGET_REPO=/u);
  assert.match(
    localCopy,
    /SKILL_DEST="\$\{TARGET_REPO\}\/\.agents\/skills\/issue-authoring"/u,
  );
  assert.match(localCopy, /cp -R "\$\{SOURCE\}\/\." "\$\{SKILL_DEST\}\/"/u);
  assert.doesNotMatch(
    localCopy,
    /\$\{TARGET_REPO\}\/skills\/issue-authoring/u,
    'local copy must not assume target skills/issue-authoring is native',
  );
});

test('companion policy and source-repository routing distinguish source from destination', () => {
  const policy = readText('idd-template/docs/onboarding/policy-decisions.md');
  const verification = readText(
    'idd-template/docs/onboarding/agent-entry-and-verification.md',
  );
  const agents = readText('AGENTS.md');

  assert.match(policy, /selected destination alongside/iu);
  assert.match(policy, /\*\*Native destination\*\*:/u);
  assert.match(policy, /canonical source path and the installed destination/iu);
  assert.match(
    ONBOARDING,
    /issue-authoring companion status[\s\S]*selected native destination/iu,
  );
  assert.match(verification, /source-versus-\s*destination contract/iu);
  assert.match(verification, /\.agents\/skills\/issue-authoring\/SKILL\.md/u);
  assert.match(verification, /native destination[\s\S]*contains `SKILL\.md`/iu);
  assert.doesNotMatch(
    verification,
    /`skills\/issue-authoring\/SKILL\.md`[\s\S]*`skills\/issue-authoring\/references\//u,
  );
  assert.match(agents, /## Codex issue-authoring route/u);
  assert.match(agents, /canonical issue-authoring bundle/u);
  assert.match(agents, /\.claude\/skills\/issue-authoring\//u);
  assert.match(agents, /\.agents\/skills\/issue-authoring\//u);
});

test('the generated companion inventory remains canonical-source-only', () => {
  const startMarker =
    '<!-- audit:generated id=issue-authoring-companion-files -->';
  const endMarker = '<!-- /audit:generated -->';
  const start = ONBOARDING.indexOf(startMarker);
  assert.notEqual(start, -1, 'missing companion generated block');
  const end = ONBOARDING.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'unterminated companion generated block');
  const inventory = ONBOARDING.slice(start, end);

  for (const path of [
    'skills/issue-authoring/SKILL.md',
    'skills/issue-authoring/references/contract.md',
    'skills/issue-authoring/references/draft-patterns.md',
    'skills/issue-authoring/references/workflow-boundary.md',
  ]) {
    assert.ok(
      inventory.includes(path),
      `missing canonical source path: ${path}`,
    );
  }
  assert.doesNotMatch(inventory, /\.(?:agents|claude|opencode)\/skills/u);
});
