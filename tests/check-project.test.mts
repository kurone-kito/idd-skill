import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type CheckGroup,
  defaultCheckGroups,
  runCheckGroups,
  selectCheckGroups,
} from '../src/scripts/check-project.mts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// A scratch directory whose name contains a space, so every fixture run also
// proves the process invocation survives a space in the path.
function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'check project fixture '));
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function silentLog(): (line: string) => void {
  return () => undefined;
}

test('all groups passing runs every group in order and exits 0', (t) => {
  const dir = scratchDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'order.log');
  const record = writeScript(
    dir,
    'record.mjs',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');\n`,
  );
  const step = (label: string) => ({
    label,
    command: process.execPath,
    args: [record, label],
  });
  const groups: CheckGroup[] = [
    { id: 'a', commands: [step('a1'), step('a2')] },
    { id: 'b', commands: [step('b1')] },
    { id: 'c', commands: [step('c1')] },
  ];

  const outcome = runCheckGroups(groups, { log: silentLog() });

  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'a1',
    'a2',
    'b1',
    'c1',
  ]);
  assert.deepEqual(
    outcome.results.map((result) => result.status),
    ['passed', 'passed', 'passed'],
  );
});

test('a failing group exits nonzero and the later independent groups still run', (t) => {
  const dir = scratchDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'order.log');
  const record = writeScript(
    dir,
    'record.mjs',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');\n`,
  );
  const failing = writeScript(dir, 'fail.mjs', 'process.exit(3);\n');
  const groups: CheckGroup[] = [
    {
      id: 'lint',
      commands: [
        { label: 'broken', command: process.execPath, args: [failing] },
      ],
    },
    {
      id: 'test',
      commands: [
        { label: 'suite', command: process.execPath, args: [record, 'test'] },
      ],
    },
  ];

  const outcome = runCheckGroups(groups, { log: silentLog() });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.results[0]?.status, 'failed');
  assert.deepEqual(outcome.results[0]?.failedLabels, ['broken']);
  assert.equal(outcome.results[1]?.status, 'passed');
  assert.equal(readFileSync(log, 'utf8').trim(), 'test');
});

test('an unavailable prerequisite skips its group with the reason and exits nonzero', (t) => {
  const dir = scratchDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'order.log');
  const record = writeScript(
    dir,
    'record.mjs',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');\n`,
  );
  const groups: CheckGroup[] = [
    {
      id: 'typecheck',
      prerequisite: () => 'pnpm entry point unavailable',
      commands: [
        { label: 'tsc', command: process.execPath, args: [record, 'tsc'] },
      ],
    },
    {
      id: 'build:check',
      commands: [
        {
          label: 'artifacts',
          command: process.execPath,
          args: [record, 'build'],
        },
      ],
    },
  ];

  const outcome = runCheckGroups(groups, { log: silentLog() });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.results[0]?.status, 'skipped');
  assert.equal(outcome.results[0]?.reason, 'pnpm entry point unavailable');
  assert.equal(outcome.results[1]?.status, 'passed');
  assert.equal(readFileSync(log, 'utf8').trim(), 'build');
});

test('the summary names each group with its status, its skip reason, and its failed checks', () => {
  const lines: string[] = [];
  const groups: CheckGroup[] = [
    {
      id: 'lint',
      commands: [
        {
          label: 'biome',
          command: process.execPath,
          args: ['-e', 'process.exit(2)'],
        },
      ],
    },
    {
      id: 'typecheck',
      prerequisite: () => 'pnpm entry point unavailable',
      commands: [],
    },
    {
      id: 'audit',
      commands: [
        {
          label: 'docs',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      ],
    },
  ];

  const outcome = runCheckGroups(groups, {
    log: (line) => {
      lines.push(line);
    },
  });

  assert.equal(outcome.exitCode, 1);
  const summaryStart = lines.indexOf('summary:');
  assert.notEqual(summaryStart, -1);
  assert.deepEqual(lines.slice(summaryStart + 1), [
    '  lint: failed (biome)',
    '  typecheck: skipped (pnpm entry point unavailable)',
    '  audit: passed',
  ]);
});

test('a spawn failure is a failure, never a pass', () => {
  const groups: CheckGroup[] = [
    {
      id: 'lint',
      commands: [
        {
          label: 'missing',
          command: join(tmpdir(), 'check-project-no-such-binary'),
          args: [],
        },
      ],
    },
  ];

  const outcome = runCheckGroups(groups, { log: silentLog() });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.results[0]?.status, 'failed');
});

test('a command terminated by a signal is a failure, never a pass', (t) => {
  const dir = scratchDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const killer = writeScript(
    dir,
    'terminate.mjs',
    'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 5000);\n',
  );
  const groups: CheckGroup[] = [
    {
      id: 'audit',
      commands: [
        { label: 'signalled', command: process.execPath, args: [killer] },
      ],
    },
  ];

  const outcome = runCheckGroups(groups, { log: silentLog() });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.results[0]?.status, 'failed');
});

test('the default groups run in the fixed order, each exactly once', () => {
  const groups = defaultCheckGroups('/fixture/pnpm.cjs');
  assert.deepEqual(
    groups.map((group) => group.id),
    ['lint', 'typecheck', 'build:check', 'test', 'audit'],
  );
});

test('the build:check group runs the canonical sources, not the generated copies', () => {
  const build = defaultCheckGroups(undefined).find(
    (group) => group.id === 'build:check',
  );
  assert.ok(build);
  for (const command of build.commands) {
    const script = command.args[0] ?? '';
    assert.match(script, /^src\/scripts\/check-[a-z-]+\.mts$/);
  }
});

test('no default command writes, fixes, or applies anything', () => {
  for (const group of defaultCheckGroups('/fixture/pnpm.cjs')) {
    for (const command of group.commands) {
      for (const arg of command.args) {
        assert.doesNotMatch(arg, /^--(write|fix|apply|update)$/);
      }
    }
  }
});

test('no default command reaches the check or lint aliases, so there is no cycle', () => {
  for (const group of defaultCheckGroups('/fixture/pnpm.cjs')) {
    for (const command of group.commands) {
      const scriptRun = command.args.at(-1) ?? '';
      assert.notEqual(scriptRun, 'check');
      assert.notEqual(scriptRun, 'lint');
      assert.notEqual(scriptRun, 'lint:minimum');
    }
  }
});

test('a group that needs pnpm is skipped when npm_execpath is absent', () => {
  const lint = defaultCheckGroups(undefined).find(
    (group) => group.id === 'lint',
  );
  assert.ok(lint?.prerequisite);
  assert.match(lint.prerequisite() ?? '', /npm_execpath/);
});

test('selecting groups keeps the fixed order and rejects unknown names', () => {
  const all = defaultCheckGroups('/fixture/pnpm.cjs');
  const picked = selectCheckGroups(all, ['audit', 'lint']);
  assert.ok(Array.isArray(picked));
  assert.deepEqual(
    picked.map((group) => group.id),
    ['lint', 'audit'],
  );
  const everything = selectCheckGroups(all, []);
  assert.ok(Array.isArray(everything));
  assert.deepEqual(
    everything.map((group) => group.id),
    all.map((group) => group.id),
  );
  assert.match(
    String(selectCheckGroups(all, ['nonesuch'])),
    /unknown group "nonesuch"/,
  );
});

test('a native pnpm executable is spawned directly, never run under node (#3756)', () => {
  const native = defaultCheckGroups('/usr/local/bin/pnpm').find(
    (group) => group.id === 'lint',
  );
  assert.ok(native);
  assert.equal(native.prerequisite?.(), null);
  assert.equal(native.commands[0]?.command, '/usr/local/bin/pnpm');
  assert.equal(native.commands[0]?.args[0], 'exec');
});

test('a Windows pnpm shim is refused with a reason instead of being spawned (#3756)', () => {
  const shim = defaultCheckGroups('C:\\pnpm\\pnpm.cmd').find(
    (group) => group.id === 'typecheck',
  );
  assert.ok(shim);
  assert.match(shim.prerequisite?.() ?? '', /Windows shim/);
});

test('the package scripts wire check, lint:minimum, and lint to the canonical runner (#3756)', () => {
  const scripts = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ).scripts as Record<string, string>;
  assert.equal(scripts.check, 'node src/scripts/check-project.mts');
  assert.equal(scripts['lint:minimum'], 'pnpm run check');
  assert.equal(scripts.lint, 'node src/scripts/check-project.mts lint');
  assert.equal(scripts.test, 'node src/scripts/check-project.mts test');
  assert.equal(scripts.audit, 'node src/scripts/check-project.mts audit');
  // The doctor is a standalone diagnosis, kept outside the aggregate check.
  assert.equal(
    scripts['doctor:github'],
    'node scripts/idd-doctor.mjs --cleanup-backlog-window-days 1',
  );
  for (const group of defaultCheckGroups('/fixture/pnpm.cjs')) {
    for (const command of group.commands) {
      assert.ok(
        !command.args.some((arg) => arg.includes('idd-doctor')),
        `group ${group.id} must not run the doctor`,
      );
    }
  }
  assert.equal(
    scripts['test:scripts'],
    'node --test --import ./tests/isolate-state.mts tests/*.test.mts',
  );
});
