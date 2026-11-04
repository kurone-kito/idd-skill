import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLayeredLocalPolicy } from '../src/scripts/idd-config.mts';
import {
  buildEffectiveConfigKeyReport,
  buildEffectiveConfigReport,
} from '../src/scripts/idd-effective-config.mts';
import { POLICY_DEFAULTS } from '../src/scripts/policy-helpers.mts';
import { fixtureEnv, stubExecutable } from './test-utils.mts';

const SCRIPT = fileURLToPath(
  new URL('../scripts/idd-effective-config.mjs', import.meta.url),
);

// A repository with a local policy file and a throwaway user-global home, so
// the outcome never depends on the operator's own configuration.
function fixture(options: {
  local: string | null;
  global: string | null;
  checkout?: string;
}): { cwd: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'idd-effective-config-'));
  const cwd = join(root, options.checkout ?? 'checkout');
  mkdirSync(cwd, { recursive: true });
  if (options.local !== null) {
    mkdirSync(join(cwd, '.github', 'idd'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'idd', 'config.json'), options.local);
  }
  const configHome = join(root, 'config');
  if (options.global !== null) {
    mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
    writeFileSync(join(configHome, 'idd-skill', 'config.json'), options.global);
  }
  return {
    cwd,
    env: { XDG_CONFIG_HOME: configHome },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the full report names the layer each value came from (#3820)', () => {
  const f = fixture({
    local: '{"reviewPolicy":"repo-choice"}',
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    const report = buildEffectiveConfigReport(
      loaded,
      '.github/idd/config.json',
    );
    assert.equal(report.repository.policyExists, true);
    assert.equal(report.repository.policyDiagnostic, null);
    assert.equal(report.userGlobalContributed, true);
    assert.equal(report.selectedOverrideIndex, null);
    assert.deepEqual(report.config, {
      reviewPolicy: 'repo-choice',
      threadResolutionPolicy: 'global-thread',
    });
    assert.equal(report.sourceMap.reviewPolicy, 'repository-local');
    assert.equal(report.sourceMap.threadResolutionPolicy, 'user-global');
  } finally {
    f.cleanup();
  }
});

test('--key prints one value and the layer that supplied it (#3820)', () => {
  const f = fixture({
    local: '{"reviewPolicy":"repo-choice"}',
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.deepEqual(
      buildEffectiveConfigKeyReport(loaded, 'threadResolutionPolicy'),
      {
        key: 'threadResolutionPolicy',
        found: true,
        value: 'global-thread',
        source: 'user-global',
        sources: ['user-global'],
      },
    );
    assert.deepEqual(buildEffectiveConfigKeyReport(loaded, 'missing.path'), {
      key: 'missing.path',
      found: false,
      value: null,
      source: null,
      sources: [],
    });
  } finally {
    f.cleanup();
  }
});

test('--no-user-global skips the user-global layers entirely (#3820)', () => {
  const f = fixture({
    local: null,
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const withGlobal = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.deepEqual(withGlobal.config, {
      threadResolutionPolicy: 'global-thread',
    });
    const withoutGlobal = loadLayeredLocalPolicy({
      cwd: f.cwd,
      env: f.env,
      noUserGlobal: true,
    });
    assert.equal(withoutGlobal.config, null);
    assert.equal(withoutGlobal.userGlobalContributed, false);
  } finally {
    f.cleanup();
  }
});

// #3820: the source map is keyed by leaf, so an object-valued key reports the
// one layer its leaves share, and `sources` lists every layer beneath it.
test('an object-valued key reports the single layer its leaves share (#3820)', () => {
  const f = fixture({
    local: '{"critiqueLoop":{"delegate":{"command":"repo-review"}}}',
    global: null,
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.deepEqual(
      buildEffectiveConfigKeyReport(loaded, 'critiqueLoop.delegate'),
      {
        key: 'critiqueLoop.delegate',
        found: true,
        value: { command: 'repo-review' },
        source: 'repository-local',
        sources: ['repository-local'],
      },
    );
  } finally {
    f.cleanup();
  }
});

// #3820: the flag follows the leaves that came from the user-global layers. A
// user-global file whose only field a repository file filters out did not
// contribute, even though the file exists.
test('userGlobalContributed is false when a repository file filters out every user-global field (#3820)', () => {
  const f = fixture({
    local: '{"reviewPolicy":"repo-choice"}',
    global: '{"trustedMarkerActors":["global-login"]}',
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.equal(loaded.userGlobalContributed, false);
    assert.deepEqual(loaded.config, { reviewPolicy: 'repo-choice' });
  } finally {
    f.cleanup();
  }
});

test('the CLI reports a canonical default with source "default" (#3820)', () => {
  const f = fixture({ local: null, global: null });
  try {
    const out = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--key', 'issueScope'], {
        cwd: resolve(f.cwd),
        env: { ...process.env, ...f.env, GITHUB_ACTIONS: '' },
        encoding: 'utf8',
      }),
    );
    assert.deepEqual(out, {
      key: 'issueScope',
      found: true,
      value: POLICY_DEFAULTS.issueScope,
      source: 'default',
      sources: ['default'],
    });
  } finally {
    f.cleanup();
  }
});

test('the CLI prints the JSON report and honors --key and --no-user-global (#3820)', () => {
  const f = fixture({
    local: null,
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const run = (args: string[]): unknown =>
      JSON.parse(
        execFileSync(process.execPath, [SCRIPT, ...args], {
          cwd: resolve(f.cwd),
          env: { ...process.env, ...f.env, GITHUB_ACTIONS: '' },
          encoding: 'utf8',
        }),
      );
    // The CLI passes the canonical defaults, so the config also carries them.
    const full = run([]) as {
      config: Record<string, unknown>;
      userGlobalContributed: boolean;
    };
    assert.equal(full.config.threadResolutionPolicy, 'global-thread');
    assert.equal(full.userGlobalContributed, true);
    assert.deepEqual(run(['--key', 'threadResolutionPolicy']), {
      key: 'threadResolutionPolicy',
      found: true,
      value: 'global-thread',
      source: 'user-global',
      sources: ['user-global'],
    });
    const bare = run(['--no-user-global']) as {
      config: Record<string, unknown>;
    };
    assert.equal(bare.config.threadResolutionPolicy, undefined);
    assert.equal(bare.config.issueScope, POLICY_DEFAULTS.issueScope);
  } finally {
    f.cleanup();
  }
});

// --- #4958: --trusted-auto-decide -------------------------------------------

const POLICY_SCHEMA_TEXT = readFileSync(
  new URL('../schemas/policy.schema.json', import.meta.url),
  'utf8',
);

function encoded(value: unknown): string {
  return Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  ).toString('base64');
}

/** A minimal policy document that passes the canonical schema. */
function validPolicy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = JSON.parse(
    readFileSync(
      new URL('../fixtures/schemas/policy.valid.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  return { ...base, ...overrides };
}

/** A stubbed `gh` answer: printed stdout, or an HTTP failure on stderr. */
type GhAnswer = { stdout: string } | { status: number };

/**
 * Responses keyed by the `repos/...` path, plus `@<ref>` when the call
 * carries a `ref=` field. The stub matches those two arguments only, so an
 * inserted `--hostname` or a reordered flag cannot change the match.
 */
function trustedResponses(options: {
  config: GhAnswer;
  schema?: GhAnswer;
  defaultBranch?: string;
}): Record<string, GhAnswer> {
  return {
    'repos/o/r': { stdout: options.defaultBranch ?? 'main' },
    'repos/o/r/contents/.github/idd/config.json@main': options.config,
    'repos/o/r/contents/schemas/policy.schema.json@main': options.schema ?? {
      stdout: encoded(POLICY_SCHEMA_TEXT),
    },
  };
}

function buildStubGh(
  responses: Record<string, GhAnswer>,
  callLogPath: string,
): string {
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(args) + '\\n');
const responses = ${JSON.stringify(responses)};
const path = args.find((arg) => arg.startsWith('repos/')) || '';
const refArg = args.find((arg) => arg.startsWith('ref='));
const key = refArg ? path + '@' + refArg.slice(4) : path;
const answer = responses[key];
if (answer === undefined) {
  process.stderr.write('gh: unexpected call ' + JSON.stringify(args) + ' (HTTP 500)\\n');
  process.exit(1);
}
if (answer.status !== undefined) {
  process.stderr.write('gh: stubbed failure (HTTP ' + answer.status + ')\\n');
  process.exit(1);
}
process.stdout.write(answer.stdout + '\\n');
`;
}

interface TrustedCliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[][];
}

function runTrustedCli(
  args: string[],
  options: { cwd: string; responses: Record<string, GhAnswer> },
): TrustedCliRun {
  const logRoot = mkdtempSync(join(tmpdir(), 'idd-effective-config-gh-log-'));
  const callLogPath = join(logRoot, 'calls.ndjson');
  writeFileSync(callLogPath, '');
  const restore = stubExecutable(
    'gh',
    buildStubGh(options.responses, callLogPath),
  );
  try {
    // fixtureEnv() drops a hook-exported GIT_DIR and the ambient git config,
    // which could otherwise point the origin lookup at the host repository.
    // The ceiling keeps git from finding a repository above the fixture, so a
    // plain directory stays unresolvable wherever the temp directory lives.
    const env: NodeJS.ProcessEnv = {
      ...fixtureEnv(),
      GITHUB_ACTIONS: '',
      GIT_CEILING_DIRECTORIES: dirname(options.cwd),
    };
    delete env.GH_HOST;
    delete env.GITHUB_SERVER_URL;
    delete env.IDD_HELPER_ERROR_ENVELOPE;
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = readFileSync(callLogPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
    };
  } finally {
    restore();
    rmSync(logRoot, { recursive: true, force: true });
  }
}

/** A git checkout whose `origin` is `o/r` on GitHub, or no remote at all. */
function gitCheckout(options: {
  origin: string | null;
  localPolicy?: unknown;
}): { cwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'idd-effective-config-git-'));
  const env = fixtureEnv();
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore', env });
  if (options.origin !== null) {
    execFileSync(
      'git',
      ['-C', root, 'remote', 'add', 'origin', options.origin],
      { stdio: 'ignore', env },
    );
  }
  if (options.localPolicy !== undefined) {
    mkdirSync(join(root, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'idd', 'config.json'),
      JSON.stringify(options.localPolicy),
    );
  }
  return {
    cwd: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const EVERY_CLASS = [
  'decisionIssue',
  'runtimeQuestion',
  'authoringChoice',
  'worktreeRemnant',
  'b1Leftover',
];

function classes(
  verdict: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return Object.fromEntries(
    EVERY_CLASS.map((cls) => [cls, overrides[cls] ?? verdict]),
  );
}

test('--trusted-auto-decide prints an enabled class with the label, caps, and quiet window (#4958)', () => {
  const f = fixture({ local: null, global: null });
  try {
    const run = runTrustedCli(
      [
        '--trusted-auto-decide',
        '--base-ref',
        'main',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: f.cwd,
        responses: trustedResponses({
          config: {
            stdout: encoded(
              validPolicy({
                dangerouslyAutoDecide: true,
                autoDecide: { decisionIssue: { enabled: true } },
              }),
            ),
          },
        }),
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master: 'enabled',
      classes: classes('class-off', { decisionIssue: 'enabled' }),
      confirmationLabelName: 'status:needs-confirmation',
      maxPendingConfirmations: 10,
      maxDecisionsPerClaim: 3,
      quietWindow: 'PT2H',
    });
    // A supplied base name never reads the default branch.
    assert.equal(
      run.calls.some((call) => call.includes('repos/o/r')),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('--trusted-auto-decide reads the live default branch and reports master-off for an absent trusted document (#4958)', () => {
  const f = fixture({ local: null, global: null });
  try {
    const run = runTrustedCli(
      ['--trusted-auto-decide', '--owner', 'o', '--repo', 'r'],
      {
        cwd: f.cwd,
        responses: trustedResponses({ config: { status: 404 } }),
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master: 'disabled',
      masterReason: 'config-absent',
      classes: classes('master-off'),
      confirmationLabelName: 'status:needs-confirmation',
    });
    assert.equal(
      run.calls.some((call) => call.includes('repos/o/r')),
      true,
    );
  } finally {
    f.cleanup();
  }
});

test('--trusted-auto-decide reports class-off and lets the trusted base win over the checkout policy (#4958)', () => {
  // The checkout's own policy switches a class on; the trusted base does not.
  const checkout = gitCheckout({
    origin: 'https://github.com/o/r.git',
    localPolicy: validPolicy({
      dangerouslyAutoDecide: true,
      autoDecide: { runtimeQuestion: { enabled: true } },
    }),
  });
  try {
    const run = runTrustedCli(['--trusted-auto-decide', '--base-ref', 'main'], {
      cwd: checkout.cwd,
      responses: trustedResponses({
        config: {
          stdout: encoded(
            validPolicy({
              dangerouslyAutoDecide: true,
              autoDecide: { confirmationLabelName: 'status:auto-confirm' },
            }),
          ),
        },
      }),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master: 'enabled',
      classes: classes('class-off'),
      confirmationLabelName: 'status:auto-confirm',
    });
  } finally {
    checkout.cleanup();
  }
});

test('--trusted-auto-decide reads the --owner/--repo repository, not a fork origin (#4958)', () => {
  // In a fork checkout, origin names the fork, whose branches the fork owner
  // controls. Explicit flags must win, so only o/r is ever read. The fork's
  // owner and name both differ from the flags, so taking either one from
  // origin is caught.
  const fork = gitCheckout({ origin: 'https://github.com/fork/fork-r.git' });
  try {
    const run = runTrustedCli(
      [
        '--trusted-auto-decide',
        '--base-ref',
        'main',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: fork.cwd,
        responses: trustedResponses({
          config: {
            stdout: encoded(
              validPolicy({
                dangerouslyAutoDecide: true,
                autoDecide: { decisionIssue: { enabled: true } },
              }),
            ),
          },
        }),
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(report.status, 'readable');
    assert.deepEqual(
      report.classes,
      classes('class-off', { decisionIssue: 'enabled' }),
    );
    const repositoryPaths = run.calls
      .flat()
      .filter((arg) => arg.startsWith('repos/'));
    assert.ok(repositoryPaths.length > 0);
    assert.ok(
      repositoryPaths.every((arg) => arg.startsWith('repos/o/r/')),
      repositoryPaths.join(', '),
    );
  } finally {
    fork.cleanup();
  }
});

test('--trusted-auto-decide prints an unreadable report and exits 1 when the trusted document fails its schema (#4958)', () => {
  const f = fixture({ local: null, global: null });
  try {
    const run = runTrustedCli(
      [
        '--trusted-auto-decide',
        '--base-ref',
        'main',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: f.cwd,
        responses: trustedResponses({
          config: {
            stdout: encoded(
              validPolicy({
                dangerouslyAutoDecide: true,
                autoDecide: { decisionIssue: { enabled: 'yes' } },
              }),
            ),
          },
        }),
      },
    );
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(report.status, 'unreadable');
    assert.equal(report.master, 'unreadable');
    assert.deepEqual(report.classes, classes('unreadable'));
    assert.equal(report.confirmationLabelName, undefined);
    assert.match(
      String(report.error),
      /\$\.autoDecide\.decisionIssue\.enabled/,
    );
  } finally {
    f.cleanup();
  }
});

test('--trusted-auto-decide exits 1 when the trusted document cannot be read (#4958)', () => {
  const f = fixture({ local: null, global: null });
  try {
    const run = runTrustedCli(
      [
        '--trusted-auto-decide',
        '--base-ref',
        'main',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: f.cwd,
        responses: trustedResponses({ config: { status: 500 } }),
      },
    );
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(report.status, 'unreadable');
    assert.deepEqual(report.classes, classes('unreadable'));
  } finally {
    f.cleanup();
  }
});

test('--trusted-auto-decide rejects local-layer flags and an unresolvable repository before any read (#4958)', () => {
  const f = fixture({ local: null, global: null });
  const noRemote = gitCheckout({ origin: null });
  const nonGithub = gitCheckout({ origin: 'https://gitlab.com/o/r.git' });
  const responses = trustedResponses({ config: { status: 404 } });
  const rejected: Array<[string[], string, RegExp]> = [
    [
      [
        '--trusted-auto-decide',
        '--key',
        'dangerouslyAutoDecide',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      f.cwd,
      /--key cannot be combined with --trusted-auto-decide/,
    ],
    [
      ['--trusted-auto-decide', '--key', '', '--owner', 'o', '--repo', 'r'],
      f.cwd,
      /--key cannot be combined with --trusted-auto-decide/,
    ],
    [
      [
        '--trusted-auto-decide',
        '--no-user-global',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      f.cwd,
      /--no-user-global cannot be combined with --trusted-auto-decide/,
    ],
    [
      ['--trusted-auto-decide', '--owner', 'o'],
      f.cwd,
      /--owner and --repo must be given together/,
    ],
    [
      ['--trusted-auto-decide', '--repo', 'r'],
      f.cwd,
      /--owner and --repo must be given together/,
    ],
    [
      ['--owner', 'o', '--repo', 'r'],
      f.cwd,
      /accepted only with --trusted-auto-decide/,
    ],
    [['--owner', 'o'], f.cwd, /accepted only with --trusted-auto-decide/],
    [['--repo', 'r'], f.cwd, /accepted only with --trusted-auto-decide/],
    [
      [
        '--trusted-auto-decide',
        '--base-ref',
        '',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      f.cwd,
      /--base-ref must name the pull request base branch/,
    ],
    [
      ['--base-ref', 'main', '--owner', 'o', '--repo', 'r'],
      f.cwd,
      /accepted only with --trusted-auto-decide/,
    ],
    [
      ['--trusted-auto-decide'],
      noRemote.cwd,
      /cannot resolve the repository from this checkout/,
    ],
    [
      ['--trusted-auto-decide'],
      nonGithub.cwd,
      /cannot resolve the repository from this checkout/,
    ],
    [
      ['--trusted-auto-decide'],
      f.cwd,
      /cannot resolve the repository from this checkout/,
    ],
  ];
  try {
    for (const [args, cwd, message] of rejected) {
      const run = runTrustedCli(args, { cwd, responses });
      assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
      assert.equal(run.stdout, '', args.join(' '));
      assert.match(run.stderr, message, args.join(' '));
      assert.deepEqual(run.calls, [], `${args.join(' ')} must read nothing`);
    }
  } finally {
    f.cleanup();
    noRemote.cleanup();
    nonGithub.cleanup();
  }
});

test('--help lists the --trusted-auto-decide mode (#4958)', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--help'], {
    encoding: 'utf8',
  });
  assert.match(
    out,
    /--trusted-auto-decide \[--base-ref <name>\] \[--owner <owner> --repo <repo>\]/,
  );
  assert.match(out, /never authority/);
});
