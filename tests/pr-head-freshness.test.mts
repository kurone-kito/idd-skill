import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { fixtureEnv, normalizeWhitespace, readText } from './test-utils.mts';

// #3802: the F2 local check before D3.5/D3.7 must see the exact pull request
// head. The check is shell text in the instruction files, so this test extracts
// its code spans, asserts they occur in order, and runs them against scratch
// repositories whose remote carries the pull request head only under
// `refs/pull/N/head`, the way GitHub does for a fork or a deleted fork.

const SKIP = process.platform === 'win32' ? 'needs bash and xargs' : false;

const F2_FILES = [
  'idd-template/.github/instructions/idd-pre-merge.instructions.md',
  '.github/instructions/idd-pre-merge.instructions.md',
];

const PR_NUMBER = '7';
const BRANCH = 'feature';

/** Code spans of the F2 local check, in the order the instruction runs them. */
const SPANS = [
  [
    'fetch',
    /`(git fetch origin \+refs\/pull\/\{pr-number\}\/head:refs\/remotes\/origin\/pull\/\{pr-number\}\/head)`/g,
  ],
  ['branch', /`(git branch --show-current)`/g],
  ['status', /`(git status --porcelain)`/g],
  ['shadow', /`(git ls-tree -r -z [^`]*)`/g],
  ['head', /`(git rev-parse HEAD)`/g],
  ['ancestry', /`(git merge-base --is-ancestor HEAD "\$PR_HEAD_SHA")`/g],
  ['ffOnly', /`(git merge --ff-only "\$PR_HEAD_SHA")`/g],
] as const;

type SpanName = (typeof SPANS)[number][0];

interface Sequence {
  spans: Record<SpanName, string>;
  offsets: number[];
}

/** Read the seven spans out of an instruction file, each after the previous. */
function extractSequence(relativePath: string): Sequence {
  const text = normalizeWhitespace(readText(relativePath));
  const spans = {} as Record<SpanName, string>;
  const offsets: number[] = [];
  let from = 0;
  for (const [name, pattern] of SPANS) {
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    assert.ok(
      match,
      `${relativePath} must carry the ${name} span after the previous one`,
    );
    spans[name] = match[1];
    offsets.push(match.index);
    from = match.index + match[0].length;
  }
  return { spans, offsets };
}

/** The `-o -i` run the instruction asks for after the plain shadow-path run. */
function withIgnored(pipeline: string): string {
  const variant = pipeline.replace(
    ' -o --exclude-standard',
    ' -o -i --exclude-standard',
  );
  assert.notEqual(
    variant,
    pipeline,
    'the pipeline must carry -o --exclude-standard',
  );
  return variant;
}

/** Exit codes of the harness script below. */
const PROCEEDS = 0;
const FETCH_FAILED = 10;
const WRONG_BRANCH = 11;
const DIRTY = 12;
const SHADOWED = 13;
const FAST_FORWARD_FAILED = 14;
const OTHER_RELATION = 15;
const PR_MOVED = 20;

/**
 * The F2 sequence as the instruction orders it, built from the extracted
 * spans. The fetched-SHA comparison reads the fetched ref, which no span does,
 * so that line belongs to the harness.
 */
function buildScript(spans: Record<SpanName, string>): string {
  const fetch = spans.fetch.replaceAll('{pr-number}', PR_NUMBER);
  return [
    'set -o pipefail',
    `${fetch} || exit ${FETCH_FAILED}`,
    `fetched=$(git rev-parse refs/remotes/origin/pull/${PR_NUMBER}/head) || exit ${FETCH_FAILED}`,
    `[ "$fetched" = "$PR_HEAD_SHA" ] || exit ${PR_MOVED}`,
    `[ "$(${spans.branch})" = "${BRANCH}" ] || exit ${WRONG_BRANCH}`,
    `[ -z "$(${spans.status})" ] || exit ${DIRTY}`,
    `plain=$(${spans.shadow} | tr -d '\\0') || exit ${SHADOWED}`,
    `ignored=$(${withIgnored(spans.shadow)} | tr -d '\\0') || exit ${SHADOWED}`,
    `[ -z "$plain$ignored" ] || exit ${SHADOWED}`,
    `if [ "$(${spans.head})" = "$PR_HEAD_SHA" ]; then exit ${PROCEEDS}; fi`,
    `if ${spans.ancestry}; then`,
    `  ${spans.ffOnly} || exit ${FAST_FORWARD_FAILED}`,
    `  [ "$(${spans.head})" = "$PR_HEAD_SHA" ] && exit ${PROCEEDS}`,
    `  exit ${FAST_FORWARD_FAILED}`,
    'fi',
    `exit ${OTHER_RELATION}`,
  ].join('\n');
}

/** `fixtureEnv()` plus the pathspec switches that would change git's answers. */
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
  return result.stdout.trim();
}

function configure(cwd: string): void {
  git(cwd, ['config', 'user.email', 'freshness@example.invalid']);
  git(cwd, ['config', 'user.name', 'freshness']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  git(cwd, ['config', 'core.quotePath', 'true']);
}

function writeFile(root: string, relativePath: string, text: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

interface Scenario {
  /** Where the local clone's HEAD starts, relative to the pull request head. */
  local: 'equal' | 'behind' | 'ahead' | 'diverged';
  /** Track `x.log` (ignored by `.gitignore`) at the pull request head. */
  headTracksIgnored?: boolean;
  /** Push the head to `refs/pull/N/head`; false makes the fetch fail. */
  pushPullRef?: boolean;
}

interface Sandbox {
  clone: string;
  prHeadSha: string;
  baseSha: string;
  cleanup: () => void;
}

/**
 * A bare remote that carries the base commit on `refs/heads/feature` and the
 * pull request head only on `refs/pull/7/head`, plus a clone over `file://`.
 * The clone starts without the head commit's objects, so only the fetch can
 * bring it in.
 */
function makeSandbox(scenario: Scenario): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'pr-head-freshness-'));
  try {
    return buildSandbox(root, scenario);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function buildSandbox(root: string, scenario: Scenario): Sandbox {
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const clone = join(root, 'clone');
  mkdirSync(work);
  git(root, ['init', '-q', '--bare', '-b', BRANCH, remote]);
  git(work, ['init', '-q', '-b', BRANCH]);
  configure(work);
  writeFile(work, '.gitignore', '*.log\n');
  writeFile(work, 'keep.txt', 'base\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  const baseSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', '-q', remote, `HEAD:refs/heads/${BRANCH}`]);

  writeFile(work, 'head.txt', 'head\n');
  if (scenario.headTracksIgnored) {
    writeFile(work, 'x.log', 'tracked at the head\n');
  }
  git(work, ['add', '-A']);
  if (scenario.headTracksIgnored) {
    git(work, ['add', '-f', '--', 'x.log']);
  }
  git(work, ['commit', '-q', '-m', 'pull request head']);
  const prHeadSha = git(work, ['rev-parse', 'HEAD']);
  if (scenario.pushPullRef !== false) {
    git(work, ['push', '-q', remote, `HEAD:refs/pull/${PR_NUMBER}/head`]);
  }

  git(root, ['clone', '-q', '-b', BRANCH, `file://${remote}`, clone]);
  configure(clone);
  assert.equal(git(clone, ['rev-parse', 'HEAD']), baseSha);
  const hasHeadObjects = (): boolean =>
    spawnSync('git', ['cat-file', '-e', `${prHeadSha}^{commit}`], {
      cwd: clone,
      env: scratchEnv(),
    }).status === 0;
  assert.equal(
    hasHeadObjects(),
    false,
    'the clone must start without the head',
  );

  if (scenario.local === 'equal' || scenario.local === 'ahead') {
    // Reach the head the way the instruction does, then move HEAD there.
    git(clone, [
      'fetch',
      '-q',
      'origin',
      `+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pull/${PR_NUMBER}/head`,
    ]);
    git(clone, ['merge', '-q', '--ff-only', prHeadSha]);
    if (scenario.local === 'ahead') {
      writeFile(clone, 'local.txt', 'unpushed\n');
      git(clone, ['add', '-A']);
      git(clone, ['commit', '-q', '-m', 'unpushed local work']);
    }
    // Forget the fetched ref so the harness's own fetch has to recreate it.
    git(clone, [
      'update-ref',
      '-d',
      `refs/remotes/origin/pull/${PR_NUMBER}/head`,
    ]);
  } else if (scenario.local === 'diverged') {
    writeFile(clone, 'other.txt', 'diverged\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'diverged local work']);
  }
  if (scenario.headTracksIgnored && scenario.local === 'behind') {
    // An ignored file the head tracks: `git status` stays empty, and an
    // ff-only merge would overwrite it.
    writeFile(clone, 'x.log', 'precious local file\n');
  }
  return {
    clone,
    prHeadSha,
    baseSha,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runSequence(
  script: string,
  sandbox: Sandbox,
  prHeadSha: string = sandbox.prHeadSha,
): { status: number | null; head: string } {
  const result = spawnSync('bash', ['-c', script], {
    cwd: sandbox.clone,
    env: { ...scratchEnv(), PR_HEAD_SHA: prHeadSha },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, 'bash must be available');
  return {
    status: result.status,
    head: git(sandbox.clone, ['rev-parse', 'HEAD']),
  };
}

test('the F2 local check keeps its seven spans in order in both copies (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const { spans, offsets } = extractSequence(file);
    assert.equal(offsets.length, SPANS.length, file);
    for (let index = 1; index < offsets.length; index += 1) {
      assert.ok(
        offsets[index] > offsets[index - 1],
        `${file}: span ${index} must follow span ${index - 1}`,
      );
    }
    assert.ok(spans.shadow.includes('--exclude-standard'), file);
    // The instruction never resets the worktree and never keeps the old
    // ancestry-only wording.
    const text = normalizeWhitespace(readText(file));
    assert.ok(!/git reset --hard|reset on pass/.test(text), file);
    assert.ok(text.includes('never run `git reset`'), file);
  }
});

test('equal HEAD proceeds without touching the worktree (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    const sandbox = makeSandbox({ local: 'equal' });
    try {
      const before = git(sandbox.clone, ['rev-parse', 'HEAD']);
      assert.equal(before, sandbox.prHeadSha, file);
      const result = runSequence(script, sandbox);
      assert.equal(result.status, PROCEEDS, file);
      assert.equal(result.head, sandbox.prHeadSha, file);
    } finally {
      sandbox.cleanup();
    }
  }
});

test('a clean branch that is strictly behind advances by fast-forward and then equals the head (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    const sandbox = makeSandbox({ local: 'behind' });
    try {
      assert.notEqual(
        git(sandbox.clone, ['rev-parse', 'HEAD']),
        sandbox.prHeadSha,
        file,
      );
      const result = runSequence(script, sandbox);
      assert.equal(result.status, PROCEEDS, file);
      assert.equal(result.head, sandbox.prHeadSha, file);
      assert.equal(git(sandbox.clone, ['status', '--porcelain']), '', file);
    } finally {
      sandbox.cleanup();
    }
  }
});

test('a behind branch holds when an ignored file that the head tracks would be overwritten (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    const sandbox = makeSandbox({ local: 'behind', headTracksIgnored: true });
    try {
      assert.equal(git(sandbox.clone, ['status', '--porcelain']), '', file);
      const result = runSequence(script, sandbox);
      assert.equal(result.status, SHADOWED, file);
      assert.equal(result.head, sandbox.baseSha, file);
      assert.equal(
        readFileSync(join(sandbox.clone, 'x.log'), 'utf8'),
        'precious local file\n',
        file,
      );
    } finally {
      sandbox.cleanup();
    }
  }
});

test('a branch ahead of the head, or diverged from it, holds and keeps its commits (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    for (const local of ['ahead', 'diverged'] as const) {
      const sandbox = makeSandbox({ local });
      try {
        const before = git(sandbox.clone, ['rev-parse', 'HEAD']);
        const result = runSequence(script, sandbox);
        assert.equal(result.status, OTHER_RELATION, `${file} ${local}`);
        assert.equal(result.head, before, `${file} ${local}`);
      } finally {
        sandbox.cleanup();
      }
    }
  }
});

test('a dirty worktree and another branch each hold (#3802)', {
  skip: SKIP,
}, () => {
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    const dirty = makeSandbox({ local: 'behind' });
    try {
      writeFile(dirty.clone, 'keep.txt', 'edited\n');
      assert.equal(runSequence(script, dirty).status, DIRTY, file);
    } finally {
      dirty.cleanup();
    }
    const other = makeSandbox({ local: 'behind' });
    try {
      git(other.clone, ['switch', '-q', '-c', 'elsewhere']);
      assert.equal(runSequence(script, other).status, WRONG_BRANCH, file);
      git(other.clone, ['switch', '-q', '--detach']);
      assert.equal(runSequence(script, other).status, WRONG_BRANCH, file);
    } finally {
      other.cleanup();
    }
  }
});

test('the harness returns to E1 for a moved head and holds on a failed fetch (#3802)', {
  skip: SKIP,
}, () => {
  // No span reads the fetched ref, so these two cases exercise the harness and
  // the clauses the policy audit pins, not an extractable span.
  for (const file of F2_FILES) {
    const script = buildScript(extractSequence(file).spans);
    const moved = makeSandbox({ local: 'behind' });
    try {
      assert.equal(
        runSequence(script, moved, moved.baseSha).status,
        PR_MOVED,
        file,
      );
      assert.equal(
        moved.baseSha,
        git(moved.clone, ['rev-parse', 'HEAD']),
        file,
      );
    } finally {
      moved.cleanup();
    }
    const failed = makeSandbox({ local: 'behind', pushPullRef: false });
    try {
      assert.equal(runSequence(script, failed).status, FETCH_FAILED, file);
      assert.ok(
        !existsSync(join(failed.clone, 'head.txt')),
        'a failed fetch must not advance the worktree',
      );
    } finally {
      failed.cleanup();
    }
  }
});

test('equality is tested before ancestry, since is-ancestor is non-strict (#3802)', () => {
  for (const file of F2_FILES) {
    const { offsets } = extractSequence(file);
    const head = SPANS.findIndex(([name]) => name === 'head');
    const ancestry = SPANS.findIndex(([name]) => name === 'ancestry');
    const shadow = SPANS.findIndex(([name]) => name === 'shadow');
    const ffOnly = SPANS.findIndex(([name]) => name === 'ffOnly');
    assert.ok(offsets[head] < offsets[ancestry], file);
    assert.ok(offsets[shadow] < offsets[ffOnly], file);
  }
});
