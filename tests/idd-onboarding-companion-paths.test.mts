import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readText } from './test-utils.mts';

const ONBOARDING = readText('idd-template/ONBOARDING.md');

function extractShellList(id: string): string {
  const marker = `<!-- audit:shell-list id=${id} -->`;
  const markerIndex = ONBOARDING.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing shell-list marker: ${id}`);
  const fenceStart = ONBOARDING.indexOf('```sh', markerIndex);
  assert.notEqual(fenceStart, -1, `missing shell block: ${id}`);
  const fenceEnd = ONBOARDING.indexOf('\n```', fenceStart);
  assert.notEqual(fenceEnd, -1, `unterminated shell block: ${id}`);
  return ONBOARDING.slice(fenceStart, fenceEnd);
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
    assert.match(
      shell,
      /skills\/issue-authoring/u,
      `${label} must fetch from the canonical source bundle`,
    );
    assertNativeDestination(shell, label);
  }
});

test('local companion copy uses the selected native destination', () => {
  const optionBStart = ONBOARDING.indexOf('### Option B — Local copy');
  const boundary = ONBOARDING.indexOf(
    '### Optional companion boundary',
    optionBStart,
  );
  assert.notEqual(optionBStart, -1, 'missing local-copy section');
  assert.notEqual(boundary, -1, 'missing companion boundary section');
  const localCopy = ONBOARDING.slice(optionBStart, boundary);

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
  assert.match(verification, /source-versus-\s*destination contract/iu);
  assert.match(verification, /\.agents\/skills\/issue-authoring\/SKILL\.md/u);
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
  assert.doesNotMatch(inventory, /\.agents\/skills|\.opencode\/skills/u);
});
