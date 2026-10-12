import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluatePayloadPolicyCoverage,
  PAYLOAD_PLACEHOLDER_FIELDS,
  payloadPolicyCoverageWarnings,
} from '../src/scripts/payload-placeholders.mts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Digits are allowed after the first letter, so {{PHASE_2}} is scanned too.
const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

const repositoryLocal = {
  active: true,
  tier: 'repository-local' as const,
  instructionsRoot: '/checkout',
  reason: 'repository-instruction-files',
};
const payloadServed = {
  active: true,
  tier: 'user-global-override' as const,
  instructionsRoot: '/payload',
  reason: 'user-global-override-match',
};
const minimalImport = {
  active: true,
  tier: 'repository-local' as const,
  instructionsRoot: '/payload',
  reason: 'repository-policy-minimal-import',
};

const completePolicy = {
  markerPrefix: 'idd-skill',
  trustedMarkerActors: ['kurone-kito'],
  commands: {
    'install-deps': 'pnpm install',
    'fix-validate': 'pnpm run fix',
    'pre-push-validate': 'pnpm run check',
    'post-fix-validate': 'pnpm run post',
  },
};

// #3822: every uppercase placeholder in the shared payload must have a mapping,
// so a new placeholder cannot reach onboarding without its source field.
test('every placeholder in the installed payload has a mapped source (#3822)', () => {
  const files = [
    ...filesUnder(join(REPO_ROOT, 'idd-template', '.github', 'instructions')),
    ...filesUnder(join(REPO_ROOT, 'idd-template', 'docs')),
  ].filter((path) => /\.(md|mdx|json|txt)$/.test(path));
  const unmapped = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(PLACEHOLDER)) {
      const name = match[0].slice(2, -2);
      if (!Object.hasOwn(PAYLOAD_PLACEHOLDER_FIELDS, name)) {
        unmapped.add(`${name} in ${file}`);
      }
    }
  }
  assert.deepEqual([...unmapped], []);
});

test('a payload-served repository is warned when its policy lacks pre-push-validate (#3822)', () => {
  const policy = {
    ...completePolicy,
    commands: { ...completePolicy.commands, 'pre-push-validate': undefined },
  };
  const warnings = evaluatePayloadPolicyCoverage({
    activation: payloadServed,
    policy,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /commands\.pre-push-validate/);
  assert.match(warnings[0] ?? '', /\{\{PRE_PUSH_VALIDATE_COMMANDS\}\}/);
});

test('a complete payload-served policy produces no warnings (#3822)', () => {
  assert.deepEqual(
    evaluatePayloadPolicyCoverage({
      activation: payloadServed,
      policy: completePolicy,
    }),
    [],
  );
});

test('a repository that serves its own instructions is never checked (#3822)', () => {
  assert.deepEqual(
    evaluatePayloadPolicyCoverage({
      activation: repositoryLocal,
      policy: null,
    }),
    [],
  );
});

test('an empty trusted-actor list does not satisfy the first-entry placeholder (#3822)', () => {
  const warnings = evaluatePayloadPolicyCoverage({
    activation: payloadServed,
    policy: { ...completePolicy, trustedMarkerActors: [] },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /trustedMarkerActors/);
});

test('a policy-only repository that serves the payload is warned, not just the user-global tier (#3822)', () => {
  const warnings = evaluatePayloadPolicyCoverage({
    activation: minimalImport,
    policy: { ...completePolicy, commands: { 'pre-push-validate': 'x' } },
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /commands\.install-deps/);
  assert.match(warnings.join('\n'), /commands\.fix-validate/);
});

test('an inactive activation or a missing installed payload root is never checked (#3822)', () => {
  assert.deepEqual(
    evaluatePayloadPolicyCoverage({
      activation: { ...payloadServed, active: false },
      policy: null,
    }),
    [],
  );
  assert.deepEqual(
    evaluatePayloadPolicyCoverage({
      activation: { ...payloadServed, instructionsRoot: null },
      policy: null,
    }),
    [],
  );
});

/**
 * A scratch home holding an installed payload, and a repository that has only
 * a policy file, so activation takes the `repository-policy-minimal-import`
 * path. The cleanup removes both.
 */
function policyOnlyRepository(policy: unknown): {
  cwd: string;
  home: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'idd-payload-coverage-'));
  const home = join(base, 'home');
  mkdirSync(
    join(
      home,
      '.local',
      'share',
      'idd-skill',
      'current',
      '.github',
      'instructions',
    ),
    { recursive: true },
  );
  writeFileSync(
    join(
      home,
      '.local',
      'share',
      'idd-skill',
      'current',
      '.github',
      'instructions',
      'idd-overview-core.instructions.md',
    ),
    '# payload\n',
  );
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.github', 'idd'), { recursive: true });
  execFileSync('git', ['init', '--quiet', cwd]);
  writeFileSync(
    join(cwd, '.github', 'idd', 'config.json'),
    `${JSON.stringify(policy)}\n`,
  );
  return {
    cwd,
    home,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('the doctor warns through the real activation for a policy-only repository (#3822)', (t) => {
  const { cwd, home, cleanup } = policyOnlyRepository({
    markerPrefix: 'idd-skill',
    trustedMarkerActors: ['kurone-kito'],
    commands: {
      'pre-push-validate': 'pnpm run check',
      'fix-validate': 'pnpm run fix',
      'post-fix-validate': 'pnpm run post',
    },
  });
  t.after(cleanup);
  const warnings = payloadPolicyCoverageWarnings(cwd, {
    env: { HOME: home },
    homedir: home,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /\{\{INSTALL_DEPS_COMMAND\}\}/);
});

test('the doctor is silent through the real activation when the policy is complete (#3822)', (t) => {
  const { cwd, home, cleanup } = policyOnlyRepository(completePolicy);
  t.after(cleanup);
  assert.deepEqual(
    payloadPolicyCoverageWarnings(cwd, { env: { HOME: home }, homedir: home }),
    [],
  );
});

test('the doctor check is silent for this repository, which serves its own instructions (#3822)', () => {
  assert.deepEqual(payloadPolicyCoverageWarnings(REPO_ROOT), []);
});
