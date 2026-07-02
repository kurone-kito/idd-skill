import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractSection,
  normalizeWhitespace,
  readText,
} from './test-utils.mts';

test('customization docs keep npx fallback wording aligned', () => {
  for (const file of [
    'docs/customization.md',
    'idd-template/docs/customization.md',
  ]) {
    const text = readText(file);
    assert.ok(
      text.includes(
        '2. `npx` when available; 3. `true` when unavailable or not relevant',
      ),
      `${file} must keep the fallback matrix aligned with npx-availability wording`,
    );
    assert.match(
      normalizeWhitespace(text),
      /\(2\) use bare `npx <tool>` when `npx` is available; \(3\) replace with `true` when `npx` is unavailable or the check is not relevant to the project\./,
      `${file} must keep detailed fallback guidance aligned with matrix wording`,
    );
    assert.ok(
      text.includes('or the check is not relevant to the project.'),
      `${file} must keep the 'not relevant' branch in detailed fallback guidance`,
    );
    assert.ok(
      !text.includes('`npx` if Node.js is present'),
      `${file} must not regress to Node.js-only detection for npx fallback`,
    );
  }
});

test('onboarding links extracted placeholder guidance and keeps fallback wording there', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  assert.ok(
    onboarding.includes('docs/onboarding/placeholders.md'),
    'ONBOARDING must link to the extracted placeholder reference',
  );
  assert.match(
    onboarding,
    /all seven placeholders:[\s\S]*`{{TRUSTED_MARKER_ACTOR}}`/,
    'ONBOARDING must include the trusted marker actor placeholder in Step 1A',
  );
  assert.match(
    onboarding,
    /perform a global replacement for:[\s\S]*`{{TRUSTED_MARKER_ACTOR}}`/,
    'ONBOARDING Step 4 must replace the trusted marker actor placeholder',
  );
  assert.doesNotMatch(
    onboarding,
    /{{TRUSTED_MARKER_ACTORS}}/,
    'ONBOARDING must not refer to the legacy trusted marker actors placeholder',
  );
  const configText = readText('idd-template/.github/idd/config.json');
  assert.match(
    configText,
    /"trustedMarkerActors": \["{{TRUSTED_MARKER_ACTOR}}"\]/,
    'template config must keep trustedMarkerActors as a real placeholder token',
  );
  assert.doesNotMatch(
    configText,
    /{{TRUSTED_MARKER_ACTORS}}/,
    'template config must not keep the legacy trusted marker actors placeholder',
  );
  assert.match(
    configText,
    /"install-deps": "{{INSTALL_DEPS_COMMAND}}"/,
    'template config must keep install-deps as a placeholder token',
  );
  assert.match(
    configText,
    /"fix-validate": "{{FIX_VALIDATE_COMMANDS}}"/,
    'template config must keep fix-validate as a placeholder token',
  );
  assert.match(
    configText,
    /"pre-push-validate": "{{PRE_PUSH_VALIDATE_COMMANDS}}"/,
    'template config must keep pre-push-validate as a placeholder token',
  );
  assert.match(
    configText,
    /"post-fix-validate": "{{POST_FIX_VALIDATE_COMMANDS}}"/,
    'template config must keep post-fix-validate as a placeholder token',
  );

  const text = readText('idd-template/docs/onboarding/placeholders.md');
  assert.match(
    text,
    /### `{{TRUSTED_MARKER_ACTOR}}`/,
    'placeholder reference must document the trusted marker actor placeholder',
  );
  assert.match(
    text,
    /single[\s\S]*login string first/,
    'placeholder reference must explain the single-login replacement step',
  );
  assert.match(
    text,
    /extra[\s\S]*quoted array entries manually/,
    'placeholder reference must explain how to add more trusted marker actors',
  );
  assert.match(
    text,
    /Only the command placeholders may be set to `true`/,
    'placeholder reference must keep the trusted marker actors placeholder out of the `true` fallback',
  );
  const readme = readText('idd-template/README.md');
  assert.match(
    readme,
    /\| `{{TRUSTED_MARKER_ACTOR}}` +\| Single JSON-escaped trusted marker login/,
    'template README must list the trusted marker actor placeholder',
  );
  const fixValidateSection = extractSection(
    text,
    '### `{{FIX_VALIDATE_COMMANDS}}`',
    '### `{{PRE_PUSH_VALIDATE_COMMANDS}}`',
  );
  assert.match(
    fixValidateSection,
    /Node\.js without a relevant script but with `npx` available:/,
    'placeholder reference must gate fix-validate npx fallback on `npx` availability',
  );
  assert.match(
    fixValidateSection,
    /no relevant auto-fix tooling: `true`/,
    'placeholder reference must scope fix-validate no-op fallback to no-relevant-tooling cases',
  );

  const prePushSection = extractSection(
    text,
    '### `{{PRE_PUSH_VALIDATE_COMMANDS}}`',
    '### `{{POST_FIX_VALIDATE_COMMANDS}}`',
  );
  assert.match(
    prePushSection,
    /Node\.js without a relevant script but with `npx` available:/,
    'placeholder reference must gate pre-push npx fallback on `npx` availability',
  );
  assert.match(
    prePushSection,
    /no relevant verification command: `true`/,
    'placeholder reference must scope pre-push no-op fallback to no-relevant-tooling cases',
  );
});

test('onboarding links extracted policy guidance including credential scope', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  assert.ok(
    onboarding.includes('docs/onboarding/policy-decisions.md'),
    'ONBOARDING must link to the extracted policy reference',
  );

  const policyText = readText(
    'idd-template/docs/onboarding/policy-decisions.md',
  );
  assert.match(
    policyText,
    /### Credential scope/,
    'policy reference must keep credential-scope guidance outside ONBOARDING',
  );
  assert.match(
    policyText,
    /### Critique-loop profile/,
    'policy reference must keep critique-loop guidance outside ONBOARDING',
  );
  assert.match(
    policyText,
    /Review `docs\/permissions\.md` with the operator/,
    'policy reference must point credential decisions at docs/permissions.md',
  );
  assert.match(
    policyText,
    /### Credential Scope/,
    'policy reference template must include a credential-scope section',
  );
  assert.match(
    policyText,
    /### Critique-Loop Profile/,
    'policy reference template must keep critique-loop terminology aligned',
  );
  assert.match(
    policyText,
    /single[\s\S]*GitHub login string first/,
    'policy reference must document the first trusted marker actor replacement step',
  );
  assert.match(
    policyText,
    /extra[\s\S]*quoted array entries manually/,
    'policy reference must document how to add more trusted marker actors',
  );
});

test('onboarding keeps claim timing and CI wait policy in the explicit confirmation path', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  assert.match(
    onboarding,
    /critique-loop profile \(distributed defaults, or a documented\s+repository override\)/,
    'ONBOARDING Step 1B must explicitly confirm the critique-loop profile',
  );
  assert.match(
    onboarding,
    /claim-timing defaults \(`claim-stale-age` and\s+`claim-heartbeat-interval`\)/,
    'ONBOARDING Step 1B must explicitly confirm claim-timing defaults',
  );
  assert.match(
    onboarding,
    /CI wait policy defaults \(`ciWait\.runningTimeout`,\s+`ciWait\.generationTimeout`, `ciWait\.rerunPolicy`\)/,
    'ONBOARDING Step 1B must explicitly confirm CI wait policy defaults',
  );
  assert.match(
    onboarding,
    /issue-author approval gate \(`enabled-by-default` by default, or\s+explicit config opt-out via `skipIssueAuthorApprovalGate: true`\)/,
    'ONBOARDING Step 1B must explicitly confirm keep-default vs opt-out for the issue-author gate',
  );
  assert.match(
    onboarding,
    /critique-loop profile, credential scope, claim-timing defaults, CI wait\s+policy defaults, issue-author approval gate, maintainer approval actor\s+policy, issue-authoring companion status, and helper runtime\s+profile\./,
    'ONBOARDING Step 2 re-check must stay aligned with the Step 1B confirmation list',
  );
  assert.match(
    onboarding,
    /review-thread resolution policy and critique-loop\s+profile are recorded/,
    'ONBOARDING Step 6 must keep critique-loop terminology aligned with Step 1B',
  );
  assert.match(
    onboarding,
    /selected CI wait policy values, merge policy, credential\s+scope, claim timing values, issue-author approval gate decision,/,
    'ONBOARDING Step 6 must keep CI wait policy values in the recorded-policy checklist',
  );
  assert.match(
    onboarding,
    /`\.github\/instructions\/idd-overview-core\.instructions\.md` keeps/,
    'ONBOARDING Step 6 must use the full idd-overview path in the checklist',
  );
});

test('helper runtime guidance uses evidence-based auto-proposals without bare package.json shortcuts', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  assert.match(
    normalizeWhitespace(onboarding),
    /helper runtime profile \(`instructions-only` by default, or an evidence-based helper profile recommendation that still requires explicit operator confirmation`\)/,
    'ONBOARDING Step 1B must allow evidence-based helper profile recommendations without recording them automatically',
  );

  const policyText = readText(
    'idd-template/docs/onboarding/policy-decisions.md',
  );
  assert.doesNotMatch(
    policyText,
    /Keep `instructions-only` unless helper support was explicitly requested\./,
    'policy guidance must not require prior helper opt-in before making a recommendation',
  );
  assert.match(
    normalizeWhitespace(policyText),
    /Auto-propose a helper runtime profile only when repository evidence shows a supported package-manager path or another real Node\.js helper path, but require explicit operator confirmation before recording anything other than `instructions-only`\./,
    'policy guidance must describe evidence-based helper profile proposals and explicit confirmation',
  );

  const placeholders = readText('idd-template/docs/onboarding/placeholders.md');
  assert.doesNotMatch(
    placeholders,
    /`package\.json` → `npm install`/,
    'placeholder guidance must not derive npm install from bare package.json presence',
  );
  assert.match(
    normalizeWhitespace(placeholders),
    /declared `packageManager` metadata or exactly one supported lockfile[\s\S]*bare `package\.json` without those signals → do not infer `npm install` from that alone/,
    'placeholder guidance must use the same package-manager evidence class as helper runtime auto-proposal',
  );

  for (const file of [
    'docs/customization.md',
    'idd-template/docs/customization.md',
  ]) {
    const text = readText(file);
    assert.doesNotMatch(
      text,
      /unless helper support is explicitly requested during onboarding/,
      `${file} must not require prior helper opt-in before making a recommendation`,
    );
    assert.match(
      normalizeWhitespace(text),
      /Auto-propose helper support only when repository evidence shows a real package-manager or Node\.js helper path, keep operator confirmation explicit, prefer `package-manager` when supported package-manager evidence exists, and otherwise prefer `vendored-node` before `ephemeral-npx`\./,
      `${file} must describe evidence-based helper runtime selection order`,
    );
  }

  for (const file of [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ]) {
    const text = readText(file);
    assert.doesNotMatch(
      text,
      /Apply this order only after a maintainer or import flow has explicitly opted into helper support\./,
      `${file} must not gate helper profile proposals on prior opt-in`,
    );
    assert.match(
      normalizeWhitespace(text),
      /Use repository evidence to decide whether helper support should be proposed for operator confirmation\./,
      `${file} must describe evidence-based proposal flow`,
    );
    assert.match(
      normalizeWhitespace(text),
      /If supported `packageManager` metadata or exactly one supported lockfile is present, propose `package-manager`\./,
      `${file} must prefer package-manager only for supported package-manager evidence`,
    );
  }
});

test('onboarding generated import surface includes extracted reference docs', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  const manifest = JSON.parse(readText('audit/sync-manifest.json')) as {
    generatedBlocks: { id: string; paths: string[]; sourceGlobs: string[] }[];
  };
  const coreFilesBlockText = extractSection(
    onboarding,
    '<!-- audit:generated id=idd-template-core-files -->',
    '<!-- /audit:generated -->',
  );

  for (const file of [
    'docs/onboarding/agent-entry-and-verification.md',
    'docs/onboarding/placeholders.md',
    'docs/onboarding/policy-decisions.md',
  ]) {
    assert.ok(
      coreFilesBlockText.includes(file),
      `ONBOARDING must list ${file} in its generated import surface`,
    );
  }

  const coreBlock = manifest.generatedBlocks.find(
    (block) => block.id === 'idd-template-core-files',
  );
  assert.ok(
    coreBlock,
    'sync manifest must define the idd-template core file block',
  );
  for (const file of [
    'idd-template/docs/onboarding/agent-entry-and-verification.md',
    'idd-template/docs/onboarding/placeholders.md',
    'idd-template/docs/onboarding/policy-decisions.md',
  ]) {
    assert.ok(
      coreBlock.paths.includes(file),
      `sync manifest must include ${file} in the core file list`,
    );
  }
  assert.ok(
    coreBlock.sourceGlobs.includes('idd-template/docs/onboarding/*.md'),
    'sync manifest must include the onboarding docs glob in the generated file inputs',
  );
});

test('onboarding links extracted agent-entry and verification guidance', () => {
  const onboarding = readText('idd-template/ONBOARDING.md');
  assert.ok(
    onboarding.includes('docs/onboarding/agent-entry-and-verification.md'),
    'ONBOARDING must link to the extracted agent-entry and verification reference',
  );
  assert.match(
    onboarding,
    /`CLAUDE\.md`, `AGENTS\.md`, and `GEMINI\.md`/,
    'ONBOARDING must keep the root agent entry file list inline',
  );
  assert.match(
    onboarding,
    /explicitly opts out of adding new files/,
    'ONBOARDING must keep the operator opt-out rule inline for agent entry files',
  );
  assert.ok(
    onboarding.includes(
      'If `.github/copilot-instructions.md` existed before onboarding,',
    ),
    'ONBOARDING must keep the Copilot entry-file reminder inline',
  );

  const reference = readText(
    'idd-template/docs/onboarding/agent-entry-and-verification.md',
  );
  assert.match(
    reference,
    /### CLAUDE\.md/,
    'agent-entry reference must keep the CLAUDE.md example outside ONBOARDING',
  );
  assert.match(
    reference,
    /### AGENTS\.md \(for Codex CLI\)/,
    'agent-entry reference must keep the AGENTS.md example outside ONBOARDING',
  );
  assert.match(
    reference,
    /### GEMINI\.md/,
    'agent-entry reference must keep the GEMINI.md example outside ONBOARDING',
  );
  assert.match(
    reference,
    /## Verification details/,
    'agent-entry reference must include the expanded verification guidance',
  );
  assert.match(
    reference,
    /selected critique-loop profile is recorded/,
    'agent-entry reference must keep critique-loop terminology aligned',
  );
  assert.match(
    reference,
    /`\.github\/instructions\/idd-overview-core\.instructions\.md` has/,
    'agent-entry reference must use the full idd-overview path in the checklist',
  );
  assert.match(
    reference,
    /`\.github\/instructions\/idd-discover\.instructions\.md` and\s+`\.github\/instructions\/idd-overview-core\.instructions\.md`/,
    'agent-entry reference must use the full instruction paths in the marker checklist',
  );
});

test('policy reference keeps helper specs pinned and config scope accurate', () => {
  const policyText = readText(
    'idd-template/docs/onboarding/policy-decisions.md',
  );
  assert.match(
    policyText,
    /npx --yes --package <reviewed-helper-spec> \\/,
    'policy reference must use a reviewed helper package spec by default',
  );
  assert.match(
    policyText,
    /Treat\s+`refs\/heads\/main`\s+as a manual opt-in/,
    'policy reference must treat moving branch helper specs as opt-in',
  );
  assert.doesNotMatch(
    policyText,
    /policy fields override the command table values/,
    'policy reference must not claim non-command policy fields override phase behavior',
  );
});

test('overview instructions document the npx-availability gate', () => {
  const live = readText(
    '.github/instructions/idd-overview-core.instructions.md',
  );
  const template = readText(
    'idd-template/.github/instructions/idd-overview-core.instructions.md',
  );

  assert.ok(
    live.includes('`npx <tool>` only when `npx` is available'),
    'live overview must keep the npx-availability gate for Node.js fallback',
  );
  assert.ok(
    template.includes('`npx <tool>` if Node.js and `npx` are available'),
    'template overview must keep the npx-availability gate for Node.js fallback',
  );
  assert.match(
    template,
    /\| \*\*fix-validate\*\* +\| `{{FIX_VALIDATE_COMMANDS}}` +\|/,
    'template overview must keep fix-validate as a placeholder row',
  );
  assert.match(
    template,
    /\| \*\*pre-push-validate\*\* +\| `{{PRE_PUSH_VALIDATE_COMMANDS}}` +\|/,
    'template overview must keep pre-push-validate as a placeholder row',
  );
  assert.match(
    template,
    /\| \*\*post-fix-validate\*\* +\| `{{POST_FIX_VALIDATE_COMMANDS}}` +\|/,
    'template overview must keep post-fix-validate as a placeholder row',
  );
  assert.match(
    template,
    /\| \*\*install-deps\*\* +\| `{{INSTALL_DEPS_COMMAND}}` +\|/,
    'template overview must keep install-deps as a placeholder row',
  );
});

test('ci wait helper docs route non-vendored profiles through the selected command', () => {
  for (const file of [
    '.github/instructions/idd-ci.instructions.md',
    'idd-template/.github/instructions/idd-ci.instructions.md',
  ]) {
    const text = readText(file);
    assert.match(
      text,
      /<profile-selected-ci-wait-policy-command>/,
      `${file} must document the manifest-selected ci-wait helper command`,
    );
    assert.match(
      text,
      /Do not hardcode[\s\S]*node scripts\/ci-wait-policy\.mjs/,
      `${file} must warn against hardcoding vendored helper commands for non-vendored profiles`,
    );
  }

  for (const file of [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ]) {
    const text = readText(file);
    assert.match(
      text,
      /profile-selected `idd:ci-wait-policy` command/,
      `${file} must document the manifest-selected ci-wait helper command`,
    );
    assert.match(
      text,
      /append\s+`--rerun-count <count>` to\s+the selected command/,
      `${file} must describe rerun-count on the selected helper command`,
    );
  }
});
