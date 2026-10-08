import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HELPER_RUNTIME_KEYS,
  HELPER_RUNTIME_LAUNCHERS,
} from '../src/scripts/policy-helpers.mts';

// #3830: the template workflows cannot import the TypeScript validator, so
// each one repeats the helperRuntime key list and the launcher values inside
// a jq program. This test keeps those copies equal to the exported constants
// and runs each program against a few configurations. Everything it needs is
// defined in this file, so no helper leaks into src/ (audit-dead-exports).

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, 'idd-template', '.github', 'workflows');
const WORKFLOW_FILES = [
  'post-merge-cleanup.yml',
  'idd-advisory-convergence.yml',
  'idd-advisory-convergence-comment.yml',
];

interface HelperRuntimeBlock {
  program: string;
  keys: string[];
  launchers: string[];
  hasLauncherClause: boolean;
}

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8');
}

function quotedStrings(list: string): string[] {
  return [...list.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
}

// Each validation block is `jq -r '<program>' "$CANDIDATE"`. A program that
// does not read `.helperRuntime` belongs to some other jq call and is skipped.
function extractBlocks(text: string): HelperRuntimeBlock[] {
  const blocks: HelperRuntimeBlock[] = [];
  for (const match of text.matchAll(/jq -r '([\s\S]*?)' "\$CANDIDATE"/g)) {
    const program = match[1] ?? '';
    if (!program.includes('(.helperRuntime) as $hr')) {
      continue;
    }
    const keys = program.match(
      /\(\(\$hr \| keys\) - \[([^\]]*)\]\) as \$extra/,
    );
    const launchers = program.match(
      /\(\[([^\]]*)\] \| index\(\$launcher_value\)\)/,
    );
    blocks.push({
      program,
      keys: keys ? quotedStrings(keys[1] ?? '') : [],
      launchers: launchers ? quotedStrings(launchers[1] ?? '') : [],
      hasLauncherClause:
        /\(\$hr \| has\("launcher"\)\)/.test(program) &&
        /\$keys_ok and \$profile_ok and \$spec_ok and \$launcher_ok\) then/.test(
          program,
        ),
    });
  }
  return blocks;
}

function problems(blocks: HelperRuntimeBlock[]): string[] {
  const wantKeys = JSON.stringify([...HELPER_RUNTIME_KEYS].sort());
  const wantLaunchers = JSON.stringify([...HELPER_RUNTIME_LAUNCHERS].sort());
  const found: string[] = [];
  if (blocks.length === 0) {
    found.push('no helperRuntime validation block found');
  }
  blocks.forEach((block, index) => {
    if (JSON.stringify([...block.keys].sort()) !== wantKeys) {
      found.push(
        `block ${index}: key list ${JSON.stringify(block.keys)} differs from ${wantKeys}`,
      );
    }
    if (JSON.stringify([...block.launchers].sort()) !== wantLaunchers) {
      found.push(
        `block ${index}: launcher list ${JSON.stringify(block.launchers)} differs from ${wantLaunchers}`,
      );
    }
    if (!block.hasLauncherClause) {
      found.push(`block ${index}: no launcher clause`);
    }
  });
  return found;
}

test('every helperRuntime jq block lists the exported keys and launcher values (idd-skill#3830)', () => {
  for (const name of WORKFLOW_FILES) {
    assert.deepEqual(problems(extractBlocks(readWorkflow(name))), [], name);
  }
});

test('the drift guard reports each kind of mutation of a workflow copy (idd-skill#3830)', () => {
  const original = readWorkflow('idd-advisory-convergence.yml');
  const mutations: Array<{ name: string; text: string }> = [
    {
      name: 'launcher removed from a key list',
      text: original.replace(
        '["profile","packageSpec","launcher"]',
        '["profile","packageSpec"]',
      ),
    },
    {
      name: 'one launcher value removed from an enum list',
      text: original.replace(
        '(["auto","npx","pnpm-dlx"] | index($launcher_value))',
        '(["auto","npx"] | index($launcher_value))',
      ),
    },
    {
      name: 'launcher clause removed from a block',
      text: original.replace(
        '$spec_ok and $launcher_ok) then',
        '$spec_ok) then',
      ),
    },
  ];
  for (const { name, text } of mutations) {
    assert.notEqual(
      text,
      original,
      `${name}: the mutation must change the text`,
    );
    assert.notDeepEqual(problems(extractBlocks(text)), [], name);
  }
});

test('the helperRuntime jq programs resolve the launcher setting and reject unknown values (idd-skill#3830)', (t) => {
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (jq.error !== undefined || jq.status !== 0) {
    t.skip('jq is not on PATH, so the workflow jq programs were not run');
    return;
  }
  const configs: Array<{ label: string; config: unknown; resolves: boolean }> =
    [
      {
        label: 'profile only',
        config: { helperRuntime: { profile: 'ephemeral-npx' } },
        resolves: true,
      },
      {
        label: 'launcher pnpm-dlx',
        config: {
          helperRuntime: { profile: 'ephemeral-npx', launcher: 'pnpm-dlx' },
        },
        resolves: true,
      },
      {
        label: 'launcher bogus',
        config: {
          helperRuntime: { profile: 'ephemeral-npx', launcher: 'bogus' },
        },
        resolves: false,
      },
      {
        label: 'unknown extra key',
        config: {
          helperRuntime: { profile: 'ephemeral-npx', mystery: true },
        },
        resolves: false,
      },
    ];
  const dir = mkdtempSync(join(tmpdir(), 'idd-launcher-jq-'));
  try {
    for (const name of WORKFLOW_FILES) {
      for (const block of extractBlocks(readWorkflow(name))) {
        for (const { label, config, resolves } of configs) {
          const file = join(dir, `${label.replace(/\W+/g, '-')}.json`);
          writeFileSync(file, JSON.stringify(config));
          const run = spawnSync('jq', ['-r', block.program, file], {
            encoding: 'utf8',
          });
          assert.equal(
            run.status,
            0,
            `${name}: jq failed for ${label}: ${run.stderr}`,
          );
          const output = run.stdout.replace(/\n$/, '');
          if (resolves) {
            assert.equal(
              output.split('\t')[0],
              'ephemeral-npx',
              `${name}: ${label} must resolve to the profile`,
            );
          } else {
            assert.equal(output, '', `${name}: ${label} must not resolve`);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
