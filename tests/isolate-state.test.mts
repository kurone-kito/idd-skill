import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Pins `tests/isolate-state.mts` (issue #3725): every case spawns a real Node
// child with the preload, because the guard's whole behavior is what a
// process does when it exits.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD_URL = pathToFileURL(
  join(REPO_ROOT, 'tests', 'isolate-state.mts'),
).href;

/**
 * This file itself may run under the preload, so a child that is meant to
 * get fresh state must not inherit the marker or the state variables.
 */
const STATE_VARIABLES = [
  'IDD_TEST_STATE_ROOT',
  'XDG_STATE_HOME',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
] as const;

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of STATE_VARIABLES) delete env[name];
  return env;
}

let scratch = '';
let scriptCount = 0;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'idd-isolate-state-test-'));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeScript(source: string): string {
  scriptCount += 1;
  const path = join(scratch, `child-${scriptCount}.cjs`);
  writeFileSync(path, source);
  return path;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? scratch,
    env: options.env ?? cleanEnvironment(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Run `source` as a child script with the preload imported by URL. */
function runWithPreload(
  source: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  return runNode(['--import', PRELOAD_URL, writeScript(source)], options);
}

/** The report's file lines, trimmed (a Node warning may share stderr). */
function reportedPaths(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(state|cache)\//.test(line));
}

const WRITE_UNDER_STATE = `
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(process.env.XDG_STATE_HOME, 'idd-skill', 'github-api-load-control', 'scope-a');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'slot-1'), 'x');
`;

test('a file written under an idd-* entry of the state root fails the process and is named (#3725)', () => {
  const result = runWithPreload(WRITE_UNDER_STATE);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /isolate-state: LEAK: 1 file/);
  // Written with `/` literally on purpose: the report uses `/` on every
  // platform, so the expectation must not go through `path.relative`.
  assert.deepEqual(reportedPaths(result.stderr), [
    'state/idd-skill/github-api-load-control/scope-a/slot-1',
  ]);
});

test('a file written under an idd-* entry of the cache root fails the process and is named (#3725)', () => {
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(process.env.XDG_CACHE_HOME, 'idd-skill', 'github-api-read-cache');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'entry.json'), '{}');
`);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(reportedPaths(result.stderr), [
    'cache/idd-skill/github-api-read-cache/entry.json',
  ]);
});

test('writes outside every idd-* entry, such as gh/device-id, do not fail the process (#3725)', () => {
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
for (const root of [process.env.XDG_STATE_HOME, process.env.XDG_CACHE_HOME]) {
  fs.mkdirSync(path.join(root, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gh', 'device-id'), 'id');
}
fs.writeFileSync(path.join(process.env.XDG_STATE_HOME, 'unrelated.txt'), 'x');
`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /LEAK/);
});

test('the preload points the state variables at one throwaway root and removes it on exit (#3725)', () => {
  const result = runWithPreload(`
process.stdout.write(JSON.stringify({
  root: process.env.IDD_TEST_STATE_ROOT,
  state: process.env.XDG_STATE_HOME,
  localAppData: process.env.LOCALAPPDATA,
  cache: process.env.XDG_CACHE_HOME,
}));
`);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout) as {
    root: string;
    state: string;
    localAppData: string;
    cache: string;
  };
  assert.equal(printed.state, printed.localAppData);
  assert.ok(printed.root.length > 0);
  assert.ok(printed.state.startsWith(printed.root), printed.state);
  assert.ok(printed.cache.startsWith(printed.root), printed.cache);
  assert.notEqual(printed.state, printed.cache);
  assert.equal(existsSync(printed.root), false, 'the root is removed on exit');
});

test('an empty IDD_TEST_STATE_ROOT counts as unset (#3725)', () => {
  const result = runWithPreload(
    `process.stdout.write(JSON.stringify({ root: process.env.IDD_TEST_STATE_ROOT, state: process.env.XDG_STATE_HOME }));`,
    { env: { ...cleanEnvironment(), IDD_TEST_STATE_ROOT: '' } },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout) as { root: string; state: string };
  assert.ok(printed.root.length > 0, 'a fresh root replaces the empty marker');
  assert.ok(printed.state.startsWith(printed.root));
});

test('with the marker already set the preload leaves the given variables alone and makes no directory (#3725)', () => {
  const given = join(scratch, 'given');
  const givenRoot = join(given, 'root');
  // Inside the given root's own `state`, where a guard that wrongly ran in
  // this marked child would find the file below and fail the process.
  const givenState = join(givenRoot, 'state');
  const givenLocalAppData = join(given, 'local-app-data');
  const givenCache = join(given, 'cache');
  for (const directory of [
    givenRoot,
    givenState,
    givenLocalAppData,
    givenCache,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  // The child's own temporary directory is fresh and sits outside `given`, so
  // a throwaway root created in it is the only thing that can fill it; the
  // child lists it while it runs, because the exit listener of a wrongly
  // created root would remove it before the parent could look.
  const freshTemp = join(scratch, 'fresh-temp');
  mkdirSync(freshTemp);
  const result = runWithPreload(
    `
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write(JSON.stringify({
  root: process.env.IDD_TEST_STATE_ROOT,
  state: process.env.XDG_STATE_HOME,
  localAppData: process.env.LOCALAPPDATA,
  cache: process.env.XDG_CACHE_HOME,
  // Listed while the child runs: the exit listener would remove a throwaway
  // directory before the parent could look.
  temp: fs.readdirSync(require('node:os').tmpdir()),
}));
const directory = path.join(process.env.XDG_STATE_HOME, 'idd-skill');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'slot'), 'x');
`,
    {
      env: {
        ...cleanEnvironment(),
        IDD_TEST_STATE_ROOT: givenRoot,
        XDG_STATE_HOME: givenState,
        LOCALAPPDATA: givenLocalAppData,
        XDG_CACHE_HOME: givenCache,
        TMPDIR: freshTemp,
        TEMP: freshTemp,
        TMP: freshTemp,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    root: givenRoot,
    state: givenState,
    localAppData: givenLocalAppData,
    cache: givenCache,
    temp: [],
  });
  assert.doesNotMatch(result.stderr, /LEAK/);
  assert.deepEqual(readdirSync(freshTemp), [], 'no throwaway directory made');
  assert.equal(existsSync(givenRoot), true, 'the given root is not removed');
});

/**
 * A script file that spawns a grandchild script with `process.execArgv` from
 * another working directory and exits with the grandchild's status.
 */
function writeSpawner(grandchildCwd: string): string {
  const grandchild = writeScript('process.exit(0);');
  return writeScript(`
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [...process.execArgv, ${JSON.stringify(grandchild)}], {
  cwd: ${JSON.stringify(grandchildCwd)},
  env: process.env,
  encoding: 'utf8',
});
process.stderr.write(result.stderr);
process.exit(result.status === null ? 99 : result.status);
`);
}

test('a relative --import specifier still resolves in a grandchild started from another directory (#3725)', () => {
  const elsewhere = mkdtempSync(join(scratch, 'elsewhere-'));
  const spawner = writeSpawner(elsewhere);
  // Case 6a: the two-argument form. Case 6b: the `--import=` form, which
  // Node 24 and later also add to `execArgv` on their own, so on those
  // versions the whole suite needs it rewritten, not only a hand-typed
  // command.
  for (const importArgs of [
    ['--import', './tests/isolate-state.mts'],
    ['--import=./tests/isolate-state.mts'],
  ]) {
    const result = runNode([...importArgs, spawner], { cwd: REPO_ROOT });
    assert.equal(result.status, 0, `${importArgs.join(' ')}: ${result.stderr}`);
  }
});

test('a ../ --import specifier resolves from a subdirectory working directory (#3725)', () => {
  // The `.\` and `..\` forms are matched too but cannot run on POSIX; they
  // are untested here.
  const elsewhere = mkdtempSync(join(scratch, 'elsewhere-'));
  const spawner = writeSpawner(elsewhere);
  const result = runNode(['--import', '../tests/isolate-state.mts', spawner], {
    cwd: join(REPO_ROOT, 'tests'),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a test that reassigns the state variables cannot hide a leak (#3725)', () => {
  const result = runWithPreload(`
${WRITE_UNDER_STATE}
process.env.IDD_TEST_STATE_ROOT = '';
process.env.XDG_STATE_HOME = '';
process.env.XDG_CACHE_HOME = '';
`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(reportedPaths(result.stderr).length, 1);
});

test('every leaked file is listed, sorted, across both roots and the idd-critique entry (#3725)', () => {
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
function put(root, relative) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}
put(process.env.XDG_STATE_HOME, 'idd-skill/b/slot-2');
put(process.env.XDG_STATE_HOME, 'idd-skill/a/slot-1');
put(process.env.XDG_STATE_HOME, 'idd-critique/events.jsonl');
put(process.env.XDG_CACHE_HOME, 'idd-skill/entry.json');
`);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /isolate-state: LEAK: 4 file/);
  assert.deepEqual(reportedPaths(result.stderr), [
    'cache/idd-skill/entry.json',
    'state/idd-critique/events.jsonl',
    'state/idd-skill/a/slot-1',
    'state/idd-skill/b/slot-2',
  ]);
});

test('a relative TMPDIR still gives an absolute root, so a chdir cannot hide a leak (#3725)', () => {
  mkdirSync(join(scratch, 'reltmp'), { recursive: true });
  const result = runWithPreload(
    `${WRITE_UNDER_STATE}\nprocess.chdir('reltmp');`,
    {
      env: {
        ...cleanEnvironment(),
        TMPDIR: 'reltmp',
        TEMP: 'reltmp',
        TMP: 'reltmp',
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(reportedPaths(result.stderr).length, 1);
});

test('a throwaway root that cannot be removed neither throws nor changes the exit code (#3725)', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0
      ? 'needs POSIX permissions and a non-root user'
      : false,
}, () => {
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
const locked = path.join(process.env.XDG_STATE_HOME, 'other', 'locked');
fs.mkdirSync(locked, { recursive: true });
fs.writeFileSync(path.join(locked, 'file'), 'x');
fs.chmodSync(locked, 0o555);
process.stdout.write(process.env.IDD_TEST_STATE_ROOT);
`);
  const root = result.stdout;
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /EACCES|\n\s+at /);
  } finally {
    // The listener could not remove the locked directory, so the parent does.
    chmodSync(join(root, 'state', 'other', 'locked'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a leak still fails the process when it exits through process.exit with another code (#3725)', () => {
  const result = runWithPreload(`${WRITE_UNDER_STATE}\nprocess.exit(2);`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(reportedPaths(result.stderr).length, 1);
});

test('a state root deleted by the process is not an error and prints no stack trace (#3725)', () => {
  const result = runWithPreload(`
require('node:fs').rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true });
`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /LEAK/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a top-level idd-* file (not a directory) is reported too (#3725)', () => {
  const result = runWithPreload(`
require('node:fs').writeFileSync(require('node:path').join(process.env.XDG_STATE_HOME, 'idd-note'), 'x');
`);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(reportedPaths(result.stderr), ['state/idd-note']);
});

test('a symbolic link under an idd-* entry is reported as the link and not followed (#3725)', {
  skip:
    process.platform === 'win32'
      ? 'creating a symlink needs privileges'
      : false,
}, () => {
  const outside = join(scratch, 'link-target');
  mkdirSync(outside);
  writeFileSync(join(outside, 'payload'), 'keep me');
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(process.env.XDG_STATE_HOME, 'idd-skill');
fs.mkdirSync(directory, { recursive: true });
fs.symlinkSync(${JSON.stringify(outside)}, path.join(directory, 'link'));
`);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(reportedPaths(result.stderr), ['state/idd-skill/link']);
  assert.equal(
    existsSync(join(outside, 'payload')),
    true,
    'removing the root must not remove what a link points at',
  );
});

test('a dangling symbolic link under an idd-* entry is reported (#3725)', {
  skip:
    process.platform === 'win32'
      ? 'creating a symlink needs privileges'
      : false,
}, () => {
  const missing = join(scratch, 'does-not-exist');
  const result = runWithPreload(`
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(process.env.XDG_STATE_HOME, 'idd-skill');
fs.mkdirSync(directory, { recursive: true });
fs.symlinkSync(${JSON.stringify(missing)}, path.join(directory, 'dangling'));
`);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(reportedPaths(result.stderr), ['state/idd-skill/dangling']);
});
