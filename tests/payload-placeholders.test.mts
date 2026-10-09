import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluatePayloadPolicyCoverage,
  PAYLOAD_PLACEHOLDER_FIELDS,
  payloadPolicyCoverageWarnings,
} from '../src/scripts/payload-placeholders.mts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;

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
  reason: 'user-global-payload',
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

test('the doctor check is silent for this repository, which serves its own instructions (#3822)', () => {
  assert.deepEqual(payloadPolicyCoverageWarnings(REPO_ROOT), []);
});
