import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { fixtureEnv, normalizeWhitespace, readText } from './test-utils.mts';

// #3671: F2 and F3 guard `git reset --hard` against an untracked or ignored file
// that shadows a path the PR head tracks. The guard is shell text in the
// instruction files, so this test extracts that text and runs it against
// scratch repositories. The old per-path loop is kept below only to show the
// gap the pipeline closes.

const SKIP = process.platform === 'win32' ? 'needs bash and xargs' : false;

const F2_FILES = [
  'idd-template/.github/instructions/idd-pre-merge.instructions.md',
  '.github/instructions/idd-pre-merge.instructions.md',
];
const F3_FILES = [
  'idd-template/.github/instructions/idd-merge.instructions.md',
  '.github/instructions/idd-merge.instructions.md',
];

/** The F2/F3 loop before #3671: a per-path loop that never matches a C-quoted path. */
const OLD_LOOP =
  'git ls-tree --full-tree -r --name-only "$PR_HEAD_SHA" | ' +
  'while IFS= read -r path; do ' +
  'git ls-files -o --exclude-standard -- ":(top)$path"; done';

/** The F2 shadow-path pipeline, read out of an instruction file. */
function extractPipeline(relativePath: string): string {
  const text = normalizeWhitespace(readText(relativePath));
  const matches = [...text.matchAll(/`(git ls-tree -r -z [^`]*)`/g)];
  assert.equal(
    matches.length,
    1,
    `${relativePath} must carry exactly one shadow-path pipeline`,
  );
  return matches[0][1];
}

/** The ignored-path variant the instruction asks for: the same pipeline with `-o -i`. */
function withIgnored(pipeline: string): string {
  const variant = pipeline.replace(
    ' -o --exclude-standard',
    ' -o -i --exclude-standard',
  );
  assert.notEqual(
    variant,
    pipeline,
    'the pipeline must contain -o --exclude-standard',
  );
  return variant;
}

/**
 * `fixtureEnv()` plus the pathspec switches it leaves alone: an exported
 * `GIT_LITERAL_PATHSPECS` or `GIT_GLOB_PATHSPECS` would change what the
 * pipeline under test does, so a caller's environment must not reach it.
 */
function scratchEnv(): NodeJS.ProcessEnv {
  const env = fixtureEnv();
  for (const name of [
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ]) {
    delete env[name];
  }
  return env;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: scratchEnv(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

interface ShadowRepoOptions {
  /** Files the head commit tracks and the checked-out commit then removes. */
  trackedAtHead: string[];
  /** Paths force-added at the head although `.gitignore` ignores them. */
  forceAdd?: string[];
  /** Files left untracked in the working tree, shadowing a head path. */
  untracked: string[];
}

/**
 * A scratch repository: `core.quotePath` pinned to `true`, signing off, a head
 * commit tracking `trackedAtHead` (plus `d/keep.txt`, tracked in both commits),
 * a second commit that removes `trackedAtHead`, and `untracked` written
 * afterwards. Returns the head SHA a reset would target.
 */
function makeShadowRepo(options: ShadowRepoOptions): {
  root: string;
  headSha: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'shadow-path-check-'));
  try {
    return buildShadowRepo(root, options);
  } catch (error) {
    // The caller never receives `cleanup` when setup throws.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function buildShadowRepo(
  root: string,
  options: ShadowRepoOptions,
): { root: string; headSha: string; cleanup: () => void } {
  const write = (relPath: string) => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${relPath}\n`);
  };
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'shadow@example.invalid']);
  git(root, ['config', 'user.name', 'shadow']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'tag.gpgsign', 'false']);
  git(root, ['config', 'core.quotePath', 'true']);
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  write('d/keep.txt');
  for (const path of options.trackedAtHead) {
    write(path);
  }
  git(root, ['add', '-A']);
  for (const path of options.forceAdd ?? []) {
    git(root, ['add', '-f', '--', path]);
  }
  git(root, ['commit', '-q', '-m', 'head']);
  const headSha = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['rm', '-q', '--', ...options.trackedAtHead]);
  git(root, ['commit', '-q', '-m', 'checked out']);
  for (const path of options.untracked) {
    write(path);
  }
  return {
    root,
    headSha,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Run `command` with bash (pipefail on unless told otherwise); NUL-split stdout. */
function run(
  command: string,
  cwd: string,
  headSha: string,
  { pipefail = true }: { pipefail?: boolean } = {},
): { status: number | null; paths: string[] } {
  const result = spawnSync(
    'bash',
    [...(pipefail ? ['-o', 'pipefail'] : []), '-c', command],
    {
      cwd,
      env: { ...scratchEnv(), PR_HEAD_SHA: headSha },
      encoding: 'utf8',
    },
  );
  assert.equal(result.error, undefined, 'bash must be available');
  return {
    status: result.status,
    paths: (result.stdout ?? '').split('\0').filter((path) => path.length > 0),
  };
}

/** The old loop prints newline-separated, possibly C-quoted, paths. */
function runOldLoop(cwd: string, headSha: string): string[] {
  return run(OLD_LOOP, cwd, headSha).paths.flatMap((chunk) =>
    chunk.split('\n').filter((line) => line.length > 0),
  );
}

/** Each case runs from the repository root and from a subdirectory. */
function fromRootAndSubdirectory(root: string): string[] {
  return [root, join(root, 'd')];
}

const PIPELINE = extractPipeline(F2_FILES[0]);

test('the F2 shadow-path pipeline reports a non-ASCII untracked shadow that the old loop missed (#3671)', {
  skip: SKIP,
}, () => {
  const repo = makeShadowRepo({
    trackedAtHead: ['d/日本語.txt'],
    untracked: ['d/日本語.txt'],
  });
  try {
    // The old loop sees nothing: ls-tree C-quotes the path under
    // core.quotePath=true and ":(top)$path" never matches that form.
    assert.deepEqual(runOldLoop(repo.root, repo.headSha), []);
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      const result = run(PIPELINE, cwd, repo.headSha);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, ['d/日本語.txt'], cwd);
    }
  } finally {
    repo.cleanup();
  }
});

test('the F2 shadow-path pipeline reports an ASCII untracked shadow from the root and a subdirectory (#3671)', {
  skip: SKIP,
}, () => {
  const repo = makeShadowRepo({
    trackedAtHead: ['d/ascii.txt'],
    untracked: ['d/ascii.txt'],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      const result = run(PIPELINE, cwd, repo.headSha);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, ['d/ascii.txt'], cwd);
    }
  } finally {
    repo.cleanup();
  }
});

test('an ignored shadow needs the -o -i run, and the pipeline prints it from the root and a subdirectory (#3671)', {
  skip: SKIP,
}, () => {
  const repo = makeShadowRepo({
    trackedAtHead: ['d/ignored.log'],
    forceAdd: ['d/ignored.log'],
    untracked: ['d/ignored.log'],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      // The plain run does not list an ignored file, so the second run is
      // what catches it.
      assert.deepEqual(run(PIPELINE, cwd, repo.headSha).paths, [], cwd);
      const ignored = run(withIgnored(PIPELINE), cwd, repo.headSha);
      assert.equal(ignored.status, 0, cwd);
      assert.deepEqual(ignored.paths, ['d/ignored.log'], cwd);
    }
  } finally {
    repo.cleanup();
  }
});

test('glob characters in a tracked path are literal: no false hold, and a real shadow is still reported (#3671)', {
  skip: SKIP,
}, () => {
  // `a[1].txt` is tracked at the head and `a1.txt` is a different, untracked
  // file. The old loop read the path as a glob and held on `a1.txt`.
  const falseHold = makeShadowRepo({
    trackedAtHead: ['a[1].txt'],
    untracked: ['a1.txt'],
  });
  try {
    assert.deepEqual(runOldLoop(falseHold.root, falseHold.headSha), ['a1.txt']);
    for (const cwd of fromRootAndSubdirectory(falseHold.root)) {
      const result = run(PIPELINE, cwd, falseHold.headSha);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, [], cwd);
    }
  } finally {
    falseHold.cleanup();
  }

  const real = makeShadowRepo({
    trackedAtHead: ['a[1].txt'],
    untracked: ['a[1].txt'],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(real.root)) {
      assert.deepEqual(
        run(PIPELINE, cwd, real.headSha).paths,
        ['a[1].txt'],
        cwd,
      );
    }
  } finally {
    real.cleanup();
  }
});

test('a tracked path containing a newline is reported as one path (#3671)', {
  skip: SKIP,
}, () => {
  const repo = makeShadowRepo({
    trackedAtHead: ['x\ny.txt'],
    untracked: ['x\ny.txt'],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      const result = run(PIPELINE, cwd, repo.headSha);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, ['x\ny.txt'], cwd);
    }
  } finally {
    repo.cleanup();
  }
});

test('a clean tree and a path tracked in both commits print nothing and exit 0 (#3671)', {
  skip: SKIP,
}, () => {
  // `d/keep.txt` is tracked at the head and in the checked-out commit, so it
  // is not a shadow.
  const repo = makeShadowRepo({
    trackedAtHead: ['d/gone.txt'],
    untracked: [],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      for (const command of [PIPELINE, withIgnored(PIPELINE)]) {
        const result = run(command, cwd, repo.headSha);
        assert.equal(result.status, 0, cwd);
        assert.deepEqual(result.paths, [], cwd);
      }
    }
  } finally {
    repo.cleanup();
  }
});

test('an empty head tree on a clean tree and a leading-dash tracked path are handled literally (#3671)', {
  skip: SKIP,
}, () => {
  // The pipeline has no `xargs -r` (BSD/macOS xargs may reject it, and BSD
  // already skips the command on empty input). With nothing to look up, GNU
  // xargs runs `git ls-files` once with no paths, which lists untracked files:
  // a clean tree prints nothing either way, and any difference on an empty tree
  // is a hold, never a false pass.
  const empty = makeShadowRepo({
    trackedAtHead: ['d/gone.txt'],
    untracked: [],
  });
  try {
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    for (const cwd of fromRootAndSubdirectory(empty.root)) {
      const result = run(PIPELINE, cwd, emptyTree);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, [], cwd);
    }
  } finally {
    empty.cleanup();
  }

  // The trailing `--` keeps a path that starts with `-` from being read as an
  // option, which would exit non-zero and hold on a clean tree.
  const dash = makeShadowRepo({
    trackedAtHead: ['-dash.txt'],
    untracked: ['-dash.txt'],
  });
  try {
    for (const cwd of fromRootAndSubdirectory(dash.root)) {
      const result = run(PIPELINE, cwd, dash.headSha);
      assert.equal(result.status, 0, cwd);
      assert.deepEqual(result.paths, ['-dash.txt'], cwd);
    }
  } finally {
    dash.cleanup();
  }
});

test('a bad SHA fails closed under pipefail, and would pass silently without it (#3671)', {
  skip: SKIP,
}, () => {
  const repo = makeShadowRepo({ trackedAtHead: ['d/gone.txt'], untracked: [] });
  try {
    for (const cwd of fromRootAndSubdirectory(repo.root)) {
      const closed = run(PIPELINE, cwd, 'deadbeef');
      assert.notEqual(closed.status, 0, cwd);
      assert.deepEqual(closed.paths, [], cwd);

      // Without pipefail the failed `git ls-tree` is invisible: the pipeline
      // exits 0 and a clean tree prints nothing, which "any output holds"
      // would read as a pass.
      const open = run(PIPELINE, cwd, 'deadbeef', { pipefail: false });
      assert.equal(open.status, 0, cwd);
      assert.deepEqual(open.paths, [], cwd);
    }
  } finally {
    repo.cleanup();
  }
});

test('F2 carries the shadow-path pipeline and F3 refers to it, in the templates and the live copies (#3671)', () => {
  for (const file of F2_FILES) {
    const text = normalizeWhitespace(readText(file));
    extractPipeline(file);
    // Portable across GNU and BSD/macOS xargs: no GNU-only -r flag.
    assert.equal(
      /xargs(?=\s)[^`]*?\s-[A-Za-z0-9]*r\b|xargs[^`]*--no-run-if-empty/.test(
        text,
      ),
      false,
      file,
    );
    assert.match(
      text,
      /Under `set -o pipefail`, run `git ls-tree -r -z /,
      file,
    );
    assert.match(
      text,
      /and again with `-o -i`; any output or failure holds\./,
      file,
    );
    assert.equal(text.includes('for paths in'), false, file);
    assert.equal(text.includes(':(top)'), false, file);
  }
  for (const file of F3_FILES) {
    const text = normalizeWhitespace(readText(file));
    assert.match(
      text,
      /Run F2's shadow-path check against `\$\{PR_HEAD_SHA_F3\}`; any output or failure holds\./,
      file,
    );
    assert.equal(text.includes('for paths in'), false, file);
    assert.equal(text.includes(':(top)'), false, file);
  }
});
