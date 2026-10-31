import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import {
  parseClaimComment,
  parseReleaseComment,
} from '../src/scripts/marker-helpers.mts';
import {
  applyMinimize,
  computeExitCode,
  isTrustedAuthor,
  parseTakeoverMarker,
  probeSubject,
  probeSubjects,
  resolveGhHostnameArgs,
  resolveTrustedActors,
  runMinimize,
} from '../src/scripts/minimize-superseded-markers.mts';
import { stubExecutable } from './test-utils.mts';

/**
 * Save/restore `GH_HOST` and `GITHUB_SERVER_URL` around a test body,
 * mirroring `tests/gh-exec.test.mts`'s `withGhHostEnv` -- `probeSubject` /
 * `applyMinimize` read `process.env` implicitly (via
 * `resolveGhHostnameArgs`'s default parameter), so a test exercising that
 * default path must mutate and restore the real environment rather than
 * passing an explicit `env` object. CI itself defines
 * `GITHUB_SERVER_URL=https://github.com` in the runner environment
 * (#1962), so both variables are cleared first regardless of overrides.
 */
function withGhHostEnv(
  overrides: { GH_HOST?: string; GITHUB_SERVER_URL?: string },
  run: () => void,
): void {
  const savedGhHost = process.env.GH_HOST;
  const savedServerUrl = process.env.GITHUB_SERVER_URL;
  delete process.env.GH_HOST;
  delete process.env.GITHUB_SERVER_URL;
  if (overrides.GH_HOST !== undefined) {
    process.env.GH_HOST = overrides.GH_HOST;
  }
  if (overrides.GITHUB_SERVER_URL !== undefined) {
    process.env.GITHUB_SERVER_URL = overrides.GITHUB_SERVER_URL;
  }
  try {
    run();
  } finally {
    if (savedGhHost === undefined) {
      delete process.env.GH_HOST;
    } else {
      process.env.GH_HOST = savedGhHost;
    }
    if (savedServerUrl === undefined) {
      delete process.env.GITHUB_SERVER_URL;
    } else {
      process.env.GITHUB_SERVER_URL = savedServerUrl;
    }
  }
}

// computeExitCode only reads counts.failed; the partial reports are
// widened structurally instead of fabricating unused report fields.
type MinimizeReport = Parameters<typeof computeExitCode>[0];

test('computeExitCode returns 0 when no failures', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 2,
        applied: 2,
        failed: 0,
        alreadyMinimized: 0,
        cannotMinimize: 0,
        untrusted: 0,
      },
    } as MinimizeReport),
    0,
  );
});

test('computeExitCode returns 1 when any item failed', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 2,
        applied: 1,
        failed: 1,
        alreadyMinimized: 0,
        cannotMinimize: 0,
        untrusted: 0,
      },
    } as MinimizeReport),
    1,
  );
});

test('computeExitCode returns 0 even when all candidates were skipped', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 0,
        applied: 0,
        failed: 0,
        alreadyMinimized: 1,
        cannotMinimize: 1,
        untrusted: 1,
      },
    } as MinimizeReport),
    0,
  );
});

test('isTrustedAuthor matches case-insensitively', () => {
  const trusted = new Set(['kurone-kito', 'copilot']);
  assert.equal(isTrustedAuthor('kurone-kito', trusted), true);
  assert.equal(isTrustedAuthor('Kurone-Kito', trusted), true);
  assert.equal(isTrustedAuthor('CoPilot', trusted), true);
});

test('isTrustedAuthor rejects unknown logins', () => {
  const trusted = new Set(['kurone-kito']);
  assert.equal(isTrustedAuthor('random-user', trusted), false);
  assert.equal(isTrustedAuthor('', trusted), false);
  assert.equal(isTrustedAuthor(null, trusted), false);
  assert.equal(isTrustedAuthor(undefined, trusted), false);
});

test('isTrustedAuthor returns false when trusted set is empty', () => {
  const trusted = new Set<string>();
  assert.equal(isTrustedAuthor('kurone-kito', trusted), false);
});

test('resolveTrustedActors follows flag > env > config precedence', () => {
  const config = { trustedMarkerActors: ['config-actor'] };
  assert.deepEqual(
    resolveTrustedActors({
      flagValue: 'Flag-Actor',
      envValue: 'env-actor',
      config,
    }),
    { actors: ['flag-actor'], source: 'flag' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: 'Env-Actor', config }),
    { actors: ['env-actor'], source: 'env' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: '', config }),
    { actors: ['config-actor'], source: 'config' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: '', config: null }),
    { actors: [], source: 'none' },
  );
});

test('config-only resolution passes the author gate end to end', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  try {
    mkdirSync(join(sandbox, '.github/idd'), { recursive: true });
    writeFileSync(
      join(sandbox, '.github/idd/config.json'),
      JSON.stringify({ trustedMarkerActors: ['kurone-kito'] }),
    );
    // Stub gh so the run is deterministic and offline: probe failures
    // surface as per-item failures (exit 1), never the author-gate
    // configuration error (exit 2).
    const restore = stubExecutable('gh', 'process.exit(1);\n');
    try {
      const script = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'scripts',
        'minimize-superseded-markers.mjs',
      );
      const result = spawnSync(
        process.execPath,
        [script, '--subject-ids', 'IC_test', '--format', 'json'],
        {
          cwd: sandbox,
          env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.trustedMarkerActorsSource, 'config');
      assert.deepEqual(report.trustedMarkerActors, ['kurone-kito']);
    } finally {
      restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// These two tests demonstrate the one deliberate parseArgs-migration
// asymmetry kurone-kito/idd-skill#1451/#1486 were concerned with: parseArgs
// itself accepts an explicit empty string for every string flag (only a
// genuinely missing value throws), so --subject-ids/--classifier/--format
// need an explicit post-parse check to keep rejecting '', while
// --trusted-marker-logins deliberately keeps accepting '' as a meaningful
// value (see resolveTrustedActors()'s flag > env > config ladder).
test('an explicit empty --subject-ids value is rejected at parse time', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [script, '--subject-ids', '', '--allow-untrusted'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'error: --subject-ids requires a value');
});

// #1722: an omitted --subject-ids is a DIFFERENT code path than the empty
// value case above (values['subject-ids'] defaults to '' via parseArgs'
// own declared default, then splits/filters to an empty array, then hits
// the post-parse length check below -- not the requires-a-value branch),
// and produces a different, still flag-named message. This is the
// write-path helper's own required-flag case named in #1722's acceptance
// criteria (one missing-required-flag case per covered helper, asserted on
// the flag name).
test('an omitted --subject-ids is rejected by name, distinctly from the empty-value case', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const result = spawnSync(process.execPath, [script, '--allow-untrusted'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'error: --subject-ids must contain at least one ID',
  );
});

test('an explicit empty --trusted-marker-logins value is accepted, unlike --subject-ids', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  try {
    // Stub gh to fail deterministically and offline: a per-item failure
    // (exit 1) proves the empty string reached resolveTrustedActors()
    // instead of being rejected at parse time (which would be exit 2 with
    // the "requires a value" message, before any gh call happens at all).
    const restore = stubExecutable('gh', 'process.exit(1);\n');
    try {
      const script = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'scripts',
        'minimize-superseded-markers.mjs',
      );
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--subject-ids',
          'IC_test',
          '--trusted-marker-logins',
          '',
          '--allow-untrusted',
          '--format',
          'json',
        ],
        {
          cwd: sandbox,
          env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.trustedMarkerActorsSource, 'none');
      assert.deepEqual(report.trustedMarkerActors, []);
    } finally {
      restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// #3316: a pnpm-forwarded leading `--` (e.g. `pnpm run idd:minimize-
// superseded-markers -- --help`) used to crash with `error: Unexpected
// argument '--help'. This command does not take positional arguments` --
// node:util's parseArgs (strict: true, allowPositionals defaulted false)
// treated the leading `--` as its own end-of-options terminator and then
// rejected everything after it as a stray positional. parseMinimizeArgs()
// runs fully -- including the internal parseArgs() call where the crash
// happened -- before the `args.help` check, so `--help` genuinely
// exercises the fix rather than bypassing it via an early return. Assert
// concrete expected values, not just parity between the two invocations,
// so a future regression that broke both forms identically would still
// be caught.
test('a leading -- (pnpm-forwarded) before --help no longer crashes, matching the no-separator form exactly (#3316)', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const withSeparator = spawnSync(process.execPath, [script, '--', '--help'], {
    encoding: 'utf8',
  });
  const withoutSeparator = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(withSeparator.status, 0);
  assert.equal(withSeparator.stderr, '');
  assert.match(withSeparator.stdout, /^Usage: minimize-superseded-markers/);

  assert.equal(withSeparator.status, withoutSeparator.status);
  assert.equal(withSeparator.stdout, withoutSeparator.stdout);
  assert.equal(withSeparator.stderr, withoutSeparator.stderr);
});

// #3316: a leading `--` ahead of value-taking string flags and a boolean
// flag together, carried all the way through to the gh-backed business
// logic (probeSubject()'s `gh api graphql` call, stubbed here to fail
// deterministically and offline) -- not just an early parse-time
// validation error. This proves parseArgs() actually consumed
// `--subject-ids`'s value and `--trusted-marker-logins`'s empty value and
// `--allow-untrusted`'s boolean after the guard strips the leading `--`,
// the same way `an explicit empty --trusted-marker-logins value is
// accepted` above proves it for the no-separator form.
test('a leading -- ahead of multiple flags reaches the same gh-backed business logic as the no-separator form (#3316)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  try {
    const restore = stubExecutable('gh', 'process.exit(1);\n');
    try {
      const script = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'scripts',
        'minimize-superseded-markers.mjs',
      );
      const flagArgs = [
        '--subject-ids',
        'IC_test',
        '--trusted-marker-logins',
        '',
        '--allow-untrusted',
        '--format',
        'json',
      ];
      const spawnOpts = {
        cwd: sandbox,
        env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
        encoding: 'utf8' as const,
      };
      const withSeparator = spawnSync(
        process.execPath,
        [script, '--', ...flagArgs],
        spawnOpts,
      );
      const withoutSeparator = spawnSync(
        process.execPath,
        [script, ...flagArgs],
        spawnOpts,
      );

      assert.equal(withSeparator.status, 1, withSeparator.stderr);
      const report = JSON.parse(withSeparator.stdout);
      assert.equal(report.trustedMarkerActorsSource, 'none');
      assert.deepEqual(report.trustedMarkerActors, []);

      assert.equal(withSeparator.status, withoutSeparator.status);
      assert.equal(withSeparator.stdout, withoutSeparator.stdout);
      assert.equal(withSeparator.stderr, withoutSeparator.stderr);
    } finally {
      restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// cspell:ignore Wpaqs
// Shared by the three "unresolvable node id" tests below, so each test only
// supplies its --subject-ids value and assertions instead of repeating the
// sandbox/gh-stub/spawnSync setup. Stubs gh to reproduce the exact
// stdout/stderr/exit-code shape observed from a live
// `gh api graphql -f id=<value>` call when the id cannot be resolved: gh
// exits non-zero and writes "Could not resolve to a node with the global id
// of '<id>'" to stderr, mirroring the response body in stdout.
function runMinimizeAgainstUnresolvableId(
  subjectIds: string,
): SpawnSyncReturns<string> {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  const restore = stubExecutable(
    'gh',
    `const ids = process.argv.filter((a) => a.startsWith('ids[]=')).map((a) => a.slice('ids[]='.length));
const legacy = (process.argv.find((a) => a.startsWith('id=')) ?? '').slice(3);
const values = ids.length > 0 ? ids : [legacy];
const message = values.map((value) => \`Could not resolve to a node with the global id of '\${value}'\`).join('; ');
process.stdout.write(JSON.stringify({ data: { nodes: values.map(() => null) }, errors: [{ type: 'NOT_FOUND', message }] }));
process.stderr.write(\`gh: \${message}\\n\`);
process.exit(1);
`,
  );
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    return spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        subjectIds,
        '--allow-untrusted',
        '--format',
        'json',
      ],
      {
        cwd: sandbox,
        env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
        encoding: 'utf8',
      },
    );
  } finally {
    restore();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('a REST-shaped --subject-ids value gets a GraphQL-node-ID explanation, not a raw gh passthrough', () => {
  const result = runMinimizeAgainstUnresolvableId('4870591746');

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.items.length, 1);
  const [item] = report.items;
  assert.equal(item.subjectId, '4870591746');
  assert.equal(item.status, 'failed');
  assert.match(item.reason, /^unresolvable-node-id:/);
  assert.match(item.reason, /GraphQL global node ID/);
  assert.match(item.reason, /IC_kwDOSWpaqs8AAAABIk9VAg/);
  assert.match(
    item.reason,
    /repos\/\{owner\}\/\{repo\}\/issues\/comments\/\{comment_id\} -q '\.node_id'/,
  );
  assert.match(
    item.reason,
    /repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}\/reviews\/\{review_id\} -q '\.node_id'/,
  );
  assert.match(
    item.reason,
    /repos\/\{owner\}\/\{repo\}\/pulls\/comments\/\{comment_id\} -q '\.node_id'/,
  );
});

test('a GraphQL-shaped --subject-ids value that fails to resolve keeps the raw gh passthrough', () => {
  // Same "could not resolve to a node" gh signature as the REST-shaped case
  // above, but for a syntactically valid (deleted/inaccessible) GraphQL node
  // id — the enhanced guidance must NOT fire here, since the id is not a
  // REST id in disguise; the raw gh error is still accurate.
  const result = runMinimizeAgainstUnresolvableId(
    'IC_kwDOSWpaqs8AAAABDeadBeef',
  );

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.items.length, 1);
  const [item] = report.items;
  assert.equal(item.subjectId, 'IC_kwDOSWpaqs8AAAABDeadBeef');
  assert.equal(item.status, 'failed');
  assert.match(item.reason, /^gh-graphql-error:/);
  assert.match(
    item.reason,
    /Could not resolve to a node with the global id of 'IC_kwDOSWpaqs8AAAABDeadBeef'/,
  );
});

test('a zero / leading-zero --subject-ids value keeps the raw gh passthrough (not REST-shaped)', () => {
  // "0" and "0001" are digit strings but not real REST id shapes (GitHub
  // REST ids are always positive integers with no leading zero), so
  // REST_SHAPED_SUBJECT_ID_PATTERN (/^[1-9]\d*$/) must reject them too.
  const result = runMinimizeAgainstUnresolvableId('0,0001');

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.items.length, 2);
  for (const item of report.items) {
    assert.equal(item.status, 'failed');
    assert.match(item.reason, /^gh-graphql-error:/);
  }
});

// --- #2754: GHES-hostname routing (caught by chatgpt-codex-connector
// review on PR #2788) -----------------------------------------------------

test('resolveGhHostnameArgs returns [] with no GH_HOST / GITHUB_SERVER_URL signal', () => {
  assert.deepEqual(resolveGhHostnameArgs({}), []);
});

test('resolveGhHostnameArgs returns [] when GH_HOST is set, even alongside a GHES GITHUB_SERVER_URL', () => {
  // gh already reads GH_HOST itself; a --hostname override here would be
  // redundant at best and could disagree with an operator's explicit
  // choice at worst -- mirrors gh-exec.mts's resolveGhApiHostname (#1962).
  assert.deepEqual(
    resolveGhHostnameArgs({
      GH_HOST: 'ghes.example.com',
      GITHUB_SERVER_URL: 'https://other-ghes.example.com',
    }),
    [],
  );
});

test('resolveGhHostnameArgs returns [] for GITHUB_SERVER_URL=https://github.com (no behavior change on github.com)', () => {
  assert.deepEqual(
    resolveGhHostnameArgs({ GITHUB_SERVER_URL: 'https://github.com' }),
    [],
  );
});

test('resolveGhHostnameArgs returns [] for an empty GITHUB_SERVER_URL', () => {
  assert.deepEqual(resolveGhHostnameArgs({ GITHUB_SERVER_URL: '' }), []);
});

test('resolveGhHostnameArgs strips scheme and trailing slash for a GHES GITHUB_SERVER_URL', () => {
  assert.deepEqual(
    resolveGhHostnameArgs({ GITHUB_SERVER_URL: 'https://ghes.example.com/' }),
    ['--hostname', 'ghes.example.com'],
  );
});

test('resolveGhHostnameArgs lowercases a mixed-case GHES host and tolerates http scheme', () => {
  assert.deepEqual(
    resolveGhHostnameArgs({ GITHUB_SERVER_URL: 'http://GHES.Example.com' }),
    ['--hostname', 'ghes.example.com'],
  );
});

test('probeSubject passes --hostname through to gh on a GHES GITHUB_SERVER_URL with GH_HOST unset', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com' }, () => {
    const restore = stubExecutable(
      'gh',
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === '--hostname' && args[2] === 'ghes.example.com' && args[3] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { node: { __typename: 'IssueComment', url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } } } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
    );
    try {
      const result = probeSubject('IC_test');
      assert.deepEqual(result, {
        ok: true,
        node: {
          typename: 'IssueComment',
          url: 'u',
          isMinimized: false,
          viewerCanMinimize: true,
          author: 'kurone-kito',
        },
      });
    } finally {
      restore();
    }
  });
});

test('probeSubject omits --hostname on plain github.com (GH_HOST and GITHUB_SERVER_URL both unset)', () => {
  withGhHostEnv({}, () => {
    const restore = stubExecutable(
      'gh',
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { node: { __typename: 'IssueComment', url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } } } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
    );
    try {
      const result = probeSubject('IC_test');
      assert.equal(result.ok, true);
    } finally {
      restore();
    }
  });
});

test('applyMinimize passes --hostname through to gh on a GHES GITHUB_SERVER_URL with GH_HOST unset', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com' }, () => {
    const restore = stubExecutable(
      'gh',
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === '--hostname' && args[2] === 'ghes.example.com' && args[3] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { minimizeComment: { minimizedComment: { __typename: 'IssueComment', isMinimized: true } } } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
    );
    try {
      const result = applyMinimize('IC_test', 'OUTDATED');
      assert.deepEqual(result, { ok: true });
    } finally {
      restore();
    }
  });
});

// --- #2754: runMinimize's optional overall deadlineMs budget --------------
// (chatgpt-codex-connector review on PR #2788) -- probeSubject/applyMinimize
// each bound a SINGLE gh call, but chaining several subjects through
// runMinimize had no cap on the pass as a whole.

/** Stub `gh` so every `graphql` probe call for any subject id resolves
 * instantly and eligibly (not minimized, viewer can minimize, trusted
 * author) -- isolates the deadline bookkeeping in `runMinimize` itself from
 * probe/mutation timing, which `probeSubject`'s own tests already cover. */
function withInstantEligibleProbeGhStub(): () => void {
  return stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const fValues = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-f') fValues.push(args[i + 1]);
}
const idEntry = fValues.find((v) => v.indexOf('id=') === 0);
const id = idEntry ? idEntry.slice('id='.length) : '';
const ids = fValues.filter((v) => v.indexOf('ids[]=') === 0).map((v) => v.slice('ids[]='.length));
if (args[0] === 'api' && args[1] === 'graphql') {
  const requested = ids.length > 0 ? ids : [id];
  const nodes = requested.map((nodeId) => ({ __typename: 'IssueComment', id: nodeId, url: 'https://github.com/o/r/issues/1#issuecomment-' + nodeId, isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } }));
  process.stdout.write(JSON.stringify({ data: { nodes } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
}

test('runMinimize always finishes the first candidate even when deadlineMs is already 0, then marks the rest deadline-exceeded', () => {
  const restore = withInstantEligibleProbeGhStub();
  try {
    const report = runMinimize({
      subjectIds: ['IC_a', 'IC_b', 'IC_c'],
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
      deadlineMs: 0,
    });
    // The first candidate is always attempted regardless of the deadline
    // (probed here, reported eligible/would-apply in dry-run mode) --
    // never zero candidates processed just because the budget is already
    // exhausted at entry.
    assert.deepEqual(
      report.items.map((item) => ({
        subjectId: item.subjectId,
        status: item.status,
        reason: item.reason,
      })),
      [
        { subjectId: 'IC_a', status: 'would-apply', reason: undefined },
        {
          subjectId: 'IC_b',
          status: 'skipped',
          reason: 'deadline-exceeded',
        },
        {
          subjectId: 'IC_c',
          status: 'skipped',
          reason: 'deadline-exceeded',
        },
      ],
    );
    assert.equal(report.counts.eligible, 1);
    assert.equal(report.counts.deadlineSkipped, 2);
    // No count bucket double-charges a deadline-skipped subject as a
    // transport failure.
    assert.equal(report.counts.failed, 0);
  } finally {
    restore();
  }
});

test('runMinimize processes every subject normally when deadlineMs is omitted (pre-existing unbounded behavior)', () => {
  const restore = withInstantEligibleProbeGhStub();
  try {
    const report = runMinimize({
      subjectIds: ['IC_a', 'IC_b', 'IC_c'],
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
    });
    assert.equal(report.items.length, 3);
    assert.ok(report.items.every((item) => item.status === 'would-apply'));
    assert.equal(report.counts.eligible, 3);
    assert.equal(report.counts.deadlineSkipped, 0);
  } finally {
    restore();
  }
});

/**
 * Stub `gh` for an `apply: true` deadline test where the mutation call
 * itself must never happen (#2754, chatgpt-codex-connector review round 2
 * on PR #2788): answers a plain probe (`graphql` with no `classifier=`
 * `-f` value) the same way {@link withInstantEligibleProbeGhStub} does,
 * but FAILS LOUDLY on any call that carries `classifier=` -- proving a
 * skipped-before-mutate candidate never reaches `applyMinimize`'s own `gh`
 * call, not just that the reported status happens to read `skipped`.
 */
function withProbeOnlyGhStub(): () => void {
  return stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const fValues = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-f') fValues.push(args[i + 1]);
}
const idEntry = fValues.find((v) => v.indexOf('id=') === 0);
const classifierEntry = fValues.find((v) => v.indexOf('classifier=') === 0);
const id = idEntry ? idEntry.slice('id='.length) : '';
const ids = fValues.filter((v) => v.indexOf('ids[]=') === 0).map((v) => v.slice('ids[]='.length));
if (args[0] === 'api' && args[1] === 'graphql' && !classifierEntry) {
  const requested = ids.length > 0 ? ids : [id];
  const nodes = requested.map((nodeId) => ({ __typename: 'IssueComment', id: nodeId, url: 'https://github.com/o/r/issues/1#issuecomment-' + nodeId, isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } }));
  process.stdout.write(JSON.stringify({ data: { nodes } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation (mutation attempted after deadline): ' + args.join(' '));
process.exit(1);
`,
  );
}

test('runMinimize never reaches applyMinimize for a candidate whose OWN probe already exhausted the deadline (#2754, chatgpt-codex-connector review round 2)', () => {
  // deadlineMs: 0 means the budget is exhausted the instant ANY wall-clock
  // time has passed -- true by the time the (real, subprocess-spawning)
  // probe call for this single candidate returns. The entry check exempts
  // the very first candidate (so the probe itself is always allowed to
  // run), but the SEPARATE pre-mutate check must still catch it here,
  // since without that second check this candidate -- already probed
  // eligible -- would proceed straight to a real mutation call.
  const restore = withProbeOnlyGhStub();
  try {
    const report = runMinimize({
      subjectIds: ['IC_a'],
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: true,
      allowUntrusted: false,
      deadlineMs: 0,
    });
    assert.deepEqual(
      report.items.map((item) => ({
        subjectId: item.subjectId,
        status: item.status,
        reason: item.reason,
      })),
      [{ subjectId: 'IC_a', status: 'skipped', reason: 'deadline-exceeded' }],
    );
    assert.equal(report.counts.eligible, 1);
    assert.equal(report.counts.deadlineSkipped, 1);
    assert.equal(report.counts.applied, 0);
    assert.equal(report.counts.failed, 0);
  } finally {
    restore();
  }
});

test('runMinimize passes the deadline to gh and reports a timeout failure (#2754, chatgpt-codex-connector review round 5)', () => {
  // The stub's probe response sleeps a full real second (via a blocking
  // Atomics.wait, portable to Windows unlike execSync('sleep 1')) before
  // answering -- a correctly-threaded ~150ms remainder passed all the way
  // down to execFileSync's own `timeout` option must kill that call long
  // before the sleep completes, proving runMinimize no longer leaves each
  // candidate's own probe bound to the flat 30s GH_TIMEOUT_MS default
  // regardless of how little of `deadlineMs` is actually left.
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
const response = JSON.stringify({ data: { nodes: [{ __typename: 'IssueComment', id: 'IC_a', url: 'https://github.com/o/r/issues/1#issuecomment-1', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } }] } });
if (args[0] === 'api' && args[1] === 'graphql') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  process.stdout.write(response);
  process.exit(0);
}
// A wrong gh invocation returns an eligible result, so the assertions below
// fail instead of mistaking an early stub exit for the expected timeout.
process.stdout.write(response);
process.exit(0);
`,
  );
  try {
    const report = runMinimize({
      subjectIds: ['IC_a'],
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
      deadlineMs: 150,
    });
    // A timed-out probe surfaces as a transport failure -- not a clean
    // eligible/would-apply result. The stub's non-GraphQL fallback returns an
    // eligible node, keeping a command-shape mistake distinguishable from a
    // timeout without depending on a marker written before the 150ms deadline.
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0]?.status, 'failed');
    const reason = report.items[0]?.reason ?? '';
    assert.match(reason, /^gh-graphql-error: /);
    assert.notEqual(reason, 'gh-graphql-error: ');
    assert.match(reason, /ETIMEDOUT|signal/i);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.eligible, 0);
    assert.equal(report.counts.applied, 0);
  } finally {
    restore();
  }
});

// --- #2957: runGh's stderr fallback must not discard e.message on an ---
// --- empty-but-defined e.stderr (a bare gh timeout with nothing --------
// --- captured) --------------------------------------------------------
//
// Before the fix, runGh's catch handler built its fallback as
// `String(e.stderr?.toString?.() ?? e.message ?? 'unknown error')`. `??`
// only falls through on null/undefined, but execFileSync's own timeout
// kill throws with `e.stderr === ''` (defined, not nullish) and a
// diagnostic e.message (e.g. "... ETIMEDOUT") -- so the `??` chain
// stopped at the empty string and silently dropped e.message, leaving
// probeSubject's `gh-graphql-error: ` reason with nothing useful after
// the colon.
test('probeSubject keeps e.message in its failure reason when gh is killed by timeout before writing stderr (#2957)', () => {
  withGhHostEnv({}, () => {
    // Sleeps far longer than the timeoutMs below and writes nothing to
    // stdout/stderr before the timeout kills it -- reproduces
    // execFileSync's defined-but-empty e.stderr timeout shape (same
    // Atomics.wait technique, and the same ~7x safety margin, as the
    // #2754 timeout test above).
    const restore = stubExecutable(
      'gh',
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
process.exit(1);
`,
    );
    try {
      const result = probeSubject('IC_test', 150);
      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.match(result.reason, /^gh-graphql-error: /);
      // The pre-fix behavior collapsed to exactly this string once
      // e.stderr's empty value short-circuited past e.message.
      assert.notEqual(result.reason, 'gh-graphql-error: ');
      assert.match(result.reason, /ETIMEDOUT|signal/i);
    } finally {
      restore();
    }
  });
});

// A generous (or omitted) deadlineMs still reaching a real, successful
// applyMinimize mutation is already covered end-to-end by
// tests/post-idd-marker.test.mts's hide-step integration tests, which
// invoke this same runMinimize call site with deadlineMs:
// HIDE_STEP_DEADLINE_MS (45s, never exhausted in-test) and assert the
// mutation actually ran via readMutatedSubjectIds.

// --- --deadline-ms CLI flag (#2896 review, Codex, round 8) ---
//
// The CLI entry point previously always called runMinimize() without a
// deadlineMs, so a subprocess caller (the only invocation path available
// to the issue-authoring contract's own sweep instructions, which cannot
// import runMinimize directly) had no way to bound a sweep over a large
// candidate list. These tests cover the new --deadline-ms flag's
// parse-time validation and its actual end-to-end wiring into
// runMinimize's own deadline enforcement.

test('a non-numeric --deadline-ms is rejected at parse time', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--subject-ids',
      'IC_a',
      '--allow-untrusted',
      '--deadline-ms',
      'notanumber',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'error: --deadline-ms must be a non-negative integer (milliseconds)',
  );
});

test('an explicit empty --deadline-ms value is rejected with the same "requires a value" shape as the other flags (#2896 review, Copilot, round 9)', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [script, '--subject-ids', 'IC_a', '--allow-untrusted', '--deadline-ms='],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'error: --deadline-ms requires a value');
});

test('--deadline-ms 0 is accepted, not rejected (a deliberate, well-defined degenerate value)', () => {
  // 0 is not an edge case to reject: runMinimize() gives it a specific
  // meaning of its own (see the "actually bounding the pass end-to-end"
  // test below, and runMinimize's own review-round-2 test) -- the budget
  // reads exhausted at every checkpoint except the first candidate's own
  // probe. Parse-time validation must accept it, matching that contract.
  const restore = withProbeOnlyGhStub();
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        'IC_a',
        '--allow-untrusted',
        '--deadline-ms',
        '0',
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.counts.deadlineSkipped, 0);
  } finally {
    restore();
  }
});

test('a negative --deadline-ms is rejected', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  // The `=`-joined form, not a separate `--deadline-ms -5` pair: a
  // dash-shaped bare value after a string flag is ambiguous to parseArgs
  // itself (it could be the next flag), so it throws its own "argument
  // is ambiguous" error before this file's own validation ever runs --
  // matching this file's own documented parseArgs-migration deltas. The
  // `=` form is parseArgs' own escape hatch and reaches this file's
  // --deadline-ms validation as intended.
  const result = spawnSync(
    process.execPath,
    [script, '--subject-ids', 'IC_a', '--allow-untrusted', '--deadline-ms=-5'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(
    result.stderr.trim(),
    'error: --deadline-ms must be a non-negative integer (milliseconds)',
  );
});

test('a leading-zero --deadline-ms (e.g. "007") is rejected as malformed', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--subject-ids',
      'IC_a',
      '--allow-untrusted',
      '--deadline-ms',
      '007',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(
    result.stderr.trim(),
    'error: --deadline-ms must be a non-negative integer (milliseconds)',
  );
});

test('an omitted --deadline-ms keeps the pre-existing unbounded behavior (no rejection, no deadline-skipped items)', () => {
  const restore = withProbeOnlyGhStub();
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        'IC_a',
        '--allow-untrusted',
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.counts.deadlineSkipped, 0);
    assert.equal(report.counts.eligible, 1);
  } finally {
    restore();
  }
});

test('--deadline-ms is threaded through the CLI into runMinimize, actually bounding the pass end-to-end', () => {
  // deadlineMs: 0 means the budget reads exhausted the instant any
  // wall-clock time has passed -- true by the time the first (real,
  // subprocess-spawning) probe call returns, proving this flag reaches
  // runMinimize's own deadline enforcement, not merely that it parses.
  // 0 is deliberately used rather than a small positive value: it is the
  // one value for which the FIRST candidate's own probe still gets the
  // un-throttled default timeout (falls back to `undefined` rather than a
  // near-zero timeoutMs that would itself kill the real subprocess call),
  // so the probe genuinely completes and the deadline is only caught at
  // the pre-apply checkpoint -- exactly mirroring runMinimize's own
  // review-round-2 test. withProbeOnlyGhStub fails loudly on any mutation
  // call, so a bug that let this candidate through the deadline check
  // would surface as a hard subprocess failure here, not a
  // silently-wrong report.
  const restore = withProbeOnlyGhStub();
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        'IC_a',
        '--allow-untrusted',
        '--apply',
        '--deadline-ms',
        '0',
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.items.map(
        (item: { subjectId: string; status: string; reason?: string }) => ({
          subjectId: item.subjectId,
          status: item.status,
          reason: item.reason,
        }),
      ),
      [{ subjectId: 'IC_a', status: 'skipped', reason: 'deadline-exceeded' }],
    );
    assert.equal(report.counts.deadlineSkipped, 1);
    assert.equal(report.counts.applied, 0);
  } finally {
    restore();
  }
});

test('printTable includes deadlineSkipped in --format table output, matching the --format json shape (#2962)', () => {
  // Same deadline-triggering setup as the --format json sibling test
  // above (deadlineMs: 0, withProbeOnlyGhStub, a single candidate) --
  // this test only swaps --format to prove the table view surfaces
  // deadlineSkipped too, not only the JSON view. Asserting the FULL
  // counts line (not just a substring) pins column order and proves no
  // regression to the other columns, per the issue's own acceptance
  // criteria.
  const restore = withProbeOnlyGhStub();
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        'IC_a',
        '--allow-untrusted',
        '--apply',
        '--deadline-ms',
        '0',
        '--format',
        'table',
      ],
      { encoding: 'utf8' },
    );
    const countsLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('counts:'));
    assert.equal(
      countsLine,
      'counts: eligible=1 applied=0 failed=0 already=0 blocked=0 untrusted=0 unsupported=0 deadlineSkipped=1',
    );
  } finally {
    restore();
  }
});

test('printTable prints deadlineSkipped=0 even when --deadline-ms is omitted, matching the --format json shape (#2962)', () => {
  // runMinimize() unconditionally seeds counts.deadlineSkipped = 0
  // regardless of whether --deadline-ms was ever passed (see the
  // "an omitted --deadline-ms keeps the pre-existing unbounded
  // behavior" test above for the --format json equivalent of this same
  // fact). printTable must therefore print "deadlineSkipped=0" on this
  // ordinary run too, not only on a deadline-triggering one -- a
  // `> 0`-guarded implementation would pass the test above but wrongly
  // omit this line, silently diverging from --format json again for the
  // common all-zero case. withProbeOnlyGhStub mirrors the stub choice of
  // the "an omitted --deadline-ms keeps the pre-existing unbounded
  // behavior" --format json sibling test above for this same
  // no-apply/no-deadline scenario.
  const restore = withProbeOnlyGhStub();
  try {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--subject-ids',
        'IC_a',
        '--allow-untrusted',
        '--format',
        'table',
      ],
      { encoding: 'utf8' },
    );
    const countsLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('counts:'));
    assert.equal(
      countsLine,
      'counts: eligible=1 applied=0 failed=0 already=0 blocked=0 untrusted=0 unsupported=0 deadlineSkipped=0',
    );
  } finally {
    restore();
  }
});

test('runMinimize batches deduplicated ids into nodes requests of at most 100 (#3593)', () => {
  const logFile = join(tmpdir(), `idd-probe-batches-${process.pid}.log`);
  rmSync(logFile, { force: true });
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const ids = args.filter((a) => a.startsWith('ids[]=')).map((a) => a.slice('ids[]='.length));
fs.appendFileSync(${JSON.stringify(logFile)}, ids.join(',') + '\\n');
if (ids.includes('IC_bad')) {
  fs.writeSync(2, "gh: Could not resolve to a node with the global id of 'IC_bad'\\n");
  process.exit(1);
}
const nodes = ids.map((id) => ({ __typename: 'IssueComment', id, url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } }));
process.stdout.write(JSON.stringify({ data: { nodes } }));
`,
  );
  try {
    const subjectIds = Array.from({ length: 100 }, (_, index) => `IC_${index}`);
    subjectIds.splice(1, 0, 'IC_0');
    subjectIds.push('IC_bad');
    const report = runMinimize({
      subjectIds,
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
    });
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.split(',').length, 100);
    assert.equal(lines[1], 'IC_bad');
    assert.equal(report.items.length, 101);
    assert.equal(
      report.items.filter((item) => item.status === 'would-apply').length,
      100,
    );
    assert.equal(report.items.at(-1)?.subjectId, 'IC_bad');
    assert.equal(report.items.at(-1)?.status, 'failed');
    assert.match(report.items.at(-1)?.reason ?? '', /^gh-graphql-error:/);
    assert.equal(
      report.items.filter((item) => item.subjectId === 'IC_0').length,
      1,
    );
  } finally {
    restore();
    rmSync(logFile, { force: true });
  }
});

test('runMinimize does not widen an exhausted deadline into a 100-id probe (#3593)', () => {
  const logFile = join(tmpdir(), `idd-probe-exhausted-${process.pid}.log`);
  rmSync(logFile, { force: true });
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const ids = process.argv.filter((a) => a.startsWith('ids[]=')).map((a) => a.slice('ids[]='.length));
fs.appendFileSync(${JSON.stringify(logFile)}, ids.join(',') + '\\n');
const nodes = ids.map((id) => ({ __typename: 'IssueComment', id, url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } }));
process.stdout.write(JSON.stringify({ data: { nodes } }));
`,
  );
  try {
    const subjectIds = Array.from({ length: 101 }, (_, index) => `IC_${index}`);
    const report = runMinimize({
      subjectIds,
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
      deadlineMs: 0,
    });
    assert.equal(readFileSync(logFile, 'utf8').trim(), 'IC_0');
    assert.equal(report.items[0]?.status, 'would-apply');
    assert.equal(report.counts.deadlineSkipped, 100);
  } finally {
    restore();
    rmSync(logFile, { force: true });
  }
});

test('probeSubjects keeps a matching node and rejects a null, a mismatched id, and a path-scoped REST failure (#3593)', () => {
  const restore = stubExecutable(
    'gh',
    `const ids = process.argv.filter((a) => a.startsWith('ids[]=')).map((a) => a.slice('ids[]='.length));
const nodes = ids.map((id) => {
  if (id === 'IC_missing') return null;
  if (id === 'IC_mismatch') return { __typename: 'IssueComment', id: 'IC_other', url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } };
  return { __typename: 'IssueComment', id, url: 'u', isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } };
});
const errors = ids.includes('4870591746') ? [{ message: "Could not resolve to a node with the global id of '4870591746'", path: ['nodes', ids.indexOf('4870591746')] }] : [];
process.stdout.write(JSON.stringify({ data: { nodes }, errors }));
`,
  );
  try {
    const result = probeSubjects([
      'IC_ok',
      'IC_missing',
      'IC_mismatch',
      '4870591746',
    ]);
    assert.equal(result[0]?.ok, true);
    assert.equal(result[1]?.ok, false);
    if (!result[1]?.ok) {
      assert.equal(result[1].reason, 'node-missing');
    }
    assert.equal(result[2]?.ok, false);
    if (!result[2]?.ok) {
      assert.equal(result[2].reason, 'node-id-mismatch');
    }
    assert.equal(result[3]?.ok, false);
    if (!result[3]?.ok) {
      assert.match(result[3].reason, /^unresolvable-node-id:/);
    }
  } finally {
    restore();
  }
});

test('runMinimize reports an unsupported node as unsupported-type when its id is selected (#3593)', () => {
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
const query = args.find((arg) => arg.startsWith('query=')) ?? '';
const nodesBody = query.split('nodes(ids:$ids){')[1]?.split('... on ')[0] ?? '';
const selectsId = /\\bid\\b/.test(nodesBody);
const ids = args.filter((arg) => arg.startsWith('ids[]=')).map((arg) => arg.slice('ids[]='.length));
const nodes = ids.map((id) => selectsId ? { __typename: 'Issue', id } : { __typename: 'Issue' });
process.stdout.write(JSON.stringify({ data: { nodes } }));
`,
  );
  try {
    const report = runMinimize({
      subjectIds: ['ISSUE_1'],
      classifier: 'OUTDATED',
      trustedSet: new Set(['kurone-kito']),
      apply: false,
      allowUntrusted: false,
    });
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0]?.status, 'skipped');
    assert.equal(report.items[0]?.reason, 'unsupported-type');
    assert.equal(report.items[0]?.typename, 'Issue');
    assert.equal(report.counts.unsupportedType, 1);
    assert.equal(report.counts.failed, 0);
  } finally {
    restore();
  }
});

const TAKEOVER_TIMESTAMP = '2026-10-28T12:00:00Z';
const TAKEOVER_PRIOR_ID = 'prior-claim-123';
const TAKEOVER_ACTIVE_ID = 'active-claim-456';

function takeoverClaimBody(
  agentId: string,
  claimId: string,
  supersedes: string,
): string {
  return (
    '<!-- claimed-by: ' +
    agentId +
    ' ' +
    claimId +
    ' supersedes: ' +
    supersedes +
    ' ' +
    TAKEOVER_TIMESTAMP +
    ' branch: issue/42-task -->\n\n_' +
    agentId +
    ': issue claim — IDD automation marker. Do not edit._'
  );
}

function takeoverReleaseBody(agentId: string, claimId: string): string {
  return (
    '<!-- unclaimed-by: ' +
    agentId +
    ' ' +
    claimId +
    ' ' +
    TAKEOVER_TIMESTAMP +
    ' -->\n\n_' +
    agentId +
    ': issue claim released — IDD automation marker. Do not edit._'
  );
}

function takeoverIssueComment(
  nodeId: string,
  body: string,
  login = 'kurone-kito',
): Record<string, unknown> {
  return {
    id: 9000 + nodeId.length,
    node_id: nodeId,
    html_url: 'https://github.com/owner/repo/issues/42#issuecomment-' + nodeId,
    body,
    user: { login },
  };
}

function makeTakeoverGhStub(pages: unknown[][]): string {
  return [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'const pages = ' + JSON.stringify(pages) + ';',
    'const tracePath = process.env.IDD_TEST_GH_TRACE;',
    'const record = (value) => { if (tracePath) fs.appendFileSync(tracePath, JSON.stringify(value) + String.fromCharCode(10)); };',
    'if (args[0] === "api" && args.includes("--paginate")) {',
    '  record({ type: "rest", args });',
    '  if (process.env.IDD_TEST_GH_FAIL === "1") { fs.writeSync(2, "simulated comment listing failure"); process.exit(1); }',
    '  if (process.env.IDD_TEST_GH_BAD_LISTING === "1") { process.stdout.write(JSON.stringify({ html_url: "https://example.test/comment", body: "incomplete" }) + String.fromCharCode(10)); process.exit(0); }',
    '  if (process.env.IDD_TEST_GH_BAD_LISTING === "missing-user") { process.stdout.write(JSON.stringify({ node_id: "IC_missing_user", html_url: "https://example.test/comment", body: "incomplete" }) + String.fromCharCode(10)); process.exit(0); }',
    '  if (process.env.IDD_TEST_GH_BAD_LISTING === "null-user") { process.stdout.write(JSON.stringify({ node_id: "IC_null_user", html_url: "https://example.test/comment", body: "incomplete", user: null }) + String.fromCharCode(10)); process.exit(0); }',
    '  if (process.env.IDD_TEST_GH_BAD_LISTING === "missing-login") { process.stdout.write(JSON.stringify({ node_id: "IC_missing_login", html_url: "https://example.test/comment", body: "incomplete", user: {} }) + String.fromCharCode(10)); process.exit(0); }',
    '  process.stdout.write(pages.flat().map((row) => JSON.stringify(row) + String.fromCharCode(10)).join(""));',
    '  process.exit(0);',
    '}',
    'if (args[0] === "api" && args.includes("graphql")) {',
    '  const fields = [];',
    '  for (let i = 0; i < args.length; i += 1) if (args[i] === "-f") fields.push(args[i + 1]);',
    '  const ids = fields.filter((value) => value.startsWith("ids[]=")).map((value) => value.slice(6));',
    '  const mutation = fields.find((value) => value.startsWith("query=mutation"));',
    '  if (mutation) {',
    '    const id = fields.find((value) => value.startsWith("id="))?.slice(3) ?? "";',
    '    record({ type: "mutation", id });',
    '    process.stdout.write(JSON.stringify({ data: { minimizeComment: { minimizedComment: { __typename: "IssueComment", id, isMinimized: true, minimizedReason: "OUTDATED" } } } }));',
    '    process.exit(0);',
    '  }',
    '  record({ type: "graphql", ids });',
    '  const nodes = ids.map((id) => ({ __typename: "IssueComment", id, url: "https://github.com/owner/repo/issues/42#issuecomment-" + id, isMinimized: false, viewerCanMinimize: true, author: { login: "kurone-kito" } }));',
    '  process.stdout.write(JSON.stringify({ data: { nodes } }));',
    '  process.exit(0);',
    '}',
    'fs.writeSync(2, "unexpected gh invocation: " + args.join(" "));',
    'process.exit(1);',
  ].join('\n');
}

function runTakeoverCli(
  args: string[],
  tracePath: string,
  extraEnv: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): SpawnSyncReturns<string> {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'minimize-superseded-markers.mjs',
  );
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      IDD_TEST_GH_TRACE: tracePath,
    },
  });
}

function readGhTrace(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('takeover marker matcher stays in parity with the live claim and release parsers', () => {
  const fixtures = [
    takeoverClaimBody('codex', TAKEOVER_PRIOR_ID, 'none'),
    takeoverClaimBody('codex', TAKEOVER_ACTIVE_ID, TAKEOVER_PRIOR_ID),
    takeoverReleaseBody('codex', TAKEOVER_PRIOR_ID),
    takeoverClaimBody('codex', TAKEOVER_PRIOR_ID, 'none') + '\nextra',
    'prefix ' + takeoverClaimBody('codex', TAKEOVER_PRIOR_ID, 'none'),
    takeoverClaimBody('codex', TAKEOVER_PRIOR_ID, 'none').replace(
      TAKEOVER_TIMESTAMP,
      '2026-02-30T12:00:00Z',
    ),
  ];

  for (const body of fixtures) {
    const liveClaim = parseClaimComment(body, TAKEOVER_TIMESTAMP);
    const liveRelease = parseReleaseComment(body);
    const expected =
      liveClaim !== null
        ? { markerKind: 'claimed-by' as const, claimId: liveClaim.claimId }
        : liveRelease !== null
          ? {
              markerKind: 'unclaimed-by' as const,
              claimId: liveRelease.claimId,
            }
          : null;
    assert.deepEqual(parseTakeoverMarker(body), expected, body);
  }
});

test('takeover selector paginates, selects exact trusted markers, and reports non-selected matches', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-'));
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const pages = [
    [
      takeoverIssueComment(
        'IC_selected_claim',
        takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none'),
      ),
      takeoverIssueComment(
        'IC_active_heartbeat',
        takeoverClaimBody('kurone-kito', TAKEOVER_ACTIVE_ID, TAKEOVER_PRIOR_ID),
      ),
      takeoverIssueComment(
        'IC_untrusted',
        takeoverClaimBody('unknown-user', TAKEOVER_PRIOR_ID, 'none'),
        'unknown-user',
      ),
      takeoverIssueComment(
        'IC_appended',
        takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none') +
          '\nextra ' +
          TAKEOVER_PRIOR_ID,
      ),
      takeoverIssueComment(
        'IC_not_first',
        'prose ' +
          TAKEOVER_PRIOR_ID +
          '\n' +
          takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none'),
      ),
      takeoverIssueComment(
        'IC_hold_one',
        '<!-- idd-hold: codex active ' +
          TAKEOVER_TIMESTAMP +
          ' --> ' +
          TAKEOVER_PRIOR_ID,
      ),
      takeoverIssueComment(
        'IC_hold_two',
        '<!-- idd-hold: codex active ' +
          TAKEOVER_TIMESTAMP +
          ' --> ' +
          TAKEOVER_PRIOR_ID,
      ),
      takeoverIssueComment(
        'IC_nonce',
        '<!-- activation-nonce: codex active nonce ' +
          TAKEOVER_TIMESTAMP +
          ' --> ' +
          TAKEOVER_PRIOR_ID,
      ),
      takeoverIssueComment(
        'IC_digest',
        'live-status digest ' + TAKEOVER_PRIOR_ID,
      ),
      takeoverIssueComment('IC_prose', 'ordinary prose ' + TAKEOVER_PRIOR_ID),
      takeoverIssueComment('IC_unrelated', 'does not name the displaced claim'),
    ],
    [
      takeoverIssueComment(
        'IC_selected_heartbeat',
        takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none').replace(
          TAKEOVER_TIMESTAMP,
          '2026-10-29T12:00:00Z',
        ),
      ),
      takeoverIssueComment(
        'IC_selected_release',
        takeoverReleaseBody('kurone-kito', TAKEOVER_PRIOR_ID),
      ),
    ],
  ];
  const restore = stubExecutable('gh', makeTakeoverGhStub(pages));
  try {
    const result = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        'kurone-kito',
        '--format',
        'json',
      ],
      tracePath,
      {
        GH_HOST: '',
        GITHUB_SERVER_URL: 'https://ghes.example.com/',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      counts: { selected: number };
      items: Array<{
        subjectId: string;
        url: string;
        status: string;
        reason?: string;
        markerKind?: string;
        claimId?: string;
      }>;
    };
    assert.equal(report.counts.selected, 3);
    const selected = report.items.filter(
      (item) => item.status === 'would-apply',
    );
    assert.deepEqual(
      selected.map(({ subjectId, markerKind, claimId }) => ({
        subjectId,
        markerKind,
        claimId,
      })),
      [
        {
          subjectId: 'IC_selected_claim',
          markerKind: 'claimed-by',
          claimId: TAKEOVER_PRIOR_ID,
        },
        {
          subjectId: 'IC_selected_heartbeat',
          markerKind: 'claimed-by',
          claimId: TAKEOVER_PRIOR_ID,
        },
        {
          subjectId: 'IC_selected_release',
          markerKind: 'unclaimed-by',
          claimId: TAKEOVER_PRIOR_ID,
        },
      ],
    );
    assert.ok(selected.every((item) => item.url.includes('#issuecomment-')));
    const rejected = new Map(
      report.items
        .filter((item) => item.status === 'not-selected')
        .map((item) => [item.subjectId, item.reason]),
    );
    assert.equal(rejected.get('IC_active_heartbeat'), 'claim-id-mismatch');
    assert.equal(rejected.get('IC_untrusted'), 'untrusted-author');
    for (const nodeId of [
      'IC_appended',
      'IC_not_first',
      'IC_hold_one',
      'IC_hold_two',
      'IC_nonce',
      'IC_digest',
      'IC_prose',
    ]) {
      assert.equal(rejected.get(nodeId), 'grammar');
    }
    assert.equal(
      report.items.some((item) => item.subjectId === 'IC_unrelated'),
      false,
    );

    const calls = readGhTrace(tracePath);
    const rest = calls.find((call) => call.type === 'rest');
    assert.ok(rest);
    const restArgs = rest.args as string[];
    assert.ok(restArgs.includes('--paginate'));
    const jqIndex = restArgs.indexOf('--jq');
    assert.notEqual(jqIndex, -1);
    assert.equal(restArgs[jqIndex + 1], '.[]');
    assert.equal(restArgs.includes('--slurp'), false);
    assert.ok(restArgs.includes('--method'));
    assert.ok(restArgs.includes('GET'));
    assert.ok(restArgs.includes('-F'));
    assert.ok(restArgs.includes('per_page=100'));
    const hostnameIndex = restArgs.indexOf('--hostname');
    assert.notEqual(hostnameIndex, -1);
    assert.equal(restArgs[hostnameIndex + 1], 'ghes.example.com');
    const graphql = calls.find((call) => call.type === 'graphql');
    assert.ok(graphql);
    assert.deepEqual(graphql.ids, [
      'IC_selected_claim',
      'IC_selected_heartbeat',
      'IC_selected_release',
    ]);
    assert.equal(
      calls.some((call) => call.type === 'mutation'),
      false,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover empty selection exits 0 and performs no GraphQL request or mutation', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-empty-'));
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const pages = [
    [takeoverIssueComment('IC_unrelated_empty', 'ordinary comment')],
  ];
  const restore = stubExecutable('gh', makeTakeoverGhStub(pages));
  try {
    const result = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      tracePath,
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      counts: { selected: number; applied: number };
      items: unknown[];
    };
    assert.equal(report.counts.selected, 0);
    assert.equal(report.counts.applied, 0);
    assert.deepEqual(report.items, []);
    const calls = readGhTrace(tracePath);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.type, 'rest');
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover table output appends selected count and marker details', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-table-'));
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const pages = [
    [
      takeoverIssueComment(
        'IC_table_selected',
        takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none'),
      ),
    ],
  ];
  const restore = stubExecutable('gh', makeTakeoverGhStub(pages));
  try {
    const result = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        'kurone-kito',
        '--format',
        'table',
      ],
      tracePath,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /counts: .*deadlineSkipped=0 selected=1/);
    assert.match(result.stdout, /claimed-by {2}claimId=prior-claim-123/);
    assert.match(
      result.stdout,
      /https:\/\/github\.com\/owner\/repo\/issues\/42#issuecomment-IC_table_selected/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover apply mode minimizes exactly the selected GraphQL node IDs', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-apply-'));
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const pages = [
    [
      takeoverIssueComment(
        'IC_apply_selected',
        takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none'),
      ),
      takeoverIssueComment(
        'IC_apply_rejected',
        takeoverClaimBody('kurone-kito', TAKEOVER_ACTIVE_ID, TAKEOVER_PRIOR_ID),
      ),
    ],
  ];
  const restore = stubExecutable('gh', makeTakeoverGhStub(pages));
  try {
    const result = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      tracePath,
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      counts: { selected: number; applied: number };
    };
    assert.equal(report.counts.selected, 1);
    assert.equal(report.counts.applied, 1);
    const calls = readGhTrace(tracePath);
    const probe = calls.find((call) => call.type === 'graphql');
    assert.deepEqual(probe?.ids, ['IC_apply_selected']);
    assert.deepEqual(
      calls.filter((call) => call.type === 'mutation').map((call) => call.id),
      ['IC_apply_selected'],
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover listing failure or incomplete rows stop before any GraphQL probe or mutation', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-fail-'));
  const restore = stubExecutable(
    'gh',
    makeTakeoverGhStub([
      [
        takeoverIssueComment(
          'IC_never_used',
          takeoverClaimBody('kurone-kito', TAKEOVER_PRIOR_ID, 'none'),
        ),
      ],
    ]),
  );
  try {
    for (const scenario of [
      {
        env: { IDD_TEST_GH_FAIL: '1' },
        message: /simulated comment listing failure/,
      },
      {
        env: {
          IDD_TEST_GH_BAD_LISTING: '1',
          IDD_HELPER_ERROR_ENVELOPE: '1',
        },
        message: /"kind":"internal"/,
      },
      {
        env: {
          IDD_TEST_GH_BAD_LISTING: 'missing-user',
          IDD_HELPER_ERROR_ENVELOPE: '1',
        },
        message: /"kind":"internal".*user\.login/,
      },
      {
        env: {
          IDD_TEST_GH_BAD_LISTING: 'null-user',
          IDD_HELPER_ERROR_ENVELOPE: '1',
        },
        message: /"kind":"internal".*user\.login/,
      },
      {
        env: {
          IDD_TEST_GH_BAD_LISTING: 'missing-login',
          IDD_HELPER_ERROR_ENVELOPE: '1',
        },
        message: /"kind":"internal".*user\.login/,
      },
    ]) {
      const tracePath = join(tempRoot, 'trace-' + Math.random() + '.jsonl');
      const result = runTakeoverCli(
        [
          '--issue',
          '42',
          '--repo',
          'owner/repo',
          '--prior-claim-id',
          TAKEOVER_PRIOR_ID,
          '--active-claim-id',
          TAKEOVER_ACTIVE_ID,
          '--trusted-marker-logins',
          'kurone-kito',
          '--apply',
        ],
        tracePath,
        scenario.env,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, scenario.message);
      const calls = readGhTrace(tracePath);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.type, 'rest');
    }
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover argument errors and missing trusted actors make no GitHub request', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-minimize-takeover-args-'));
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const restore = stubExecutable(
    'gh',
    'const fs = require("node:fs"); if (process.env.IDD_TEST_GH_TRACE) fs.appendFileSync(process.env.IDD_TEST_GH_TRACE, "called\\\\n"); process.exit(1);',
  );
  try {
    const valid = [
      '--issue',
      '42',
      '--repo',
      'owner/repo',
      '--prior-claim-id',
      TAKEOVER_PRIOR_ID,
      '--active-claim-id',
      TAKEOVER_ACTIVE_ID,
      '--trusted-marker-logins',
      'kurone-kito',
    ];
    const invalidInputs = [
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
      ],
      [...valid.slice(0, 2), '--repo', 'owner', ...valid.slice(4)],
      ['--issue', '0', ...valid.slice(2)],
      [...valid.slice(0, 4), '--prior-claim-id', 'none', ...valid.slice(6)],
      [
        ...valid.slice(0, 6),
        '--active-claim-id',
        TAKEOVER_PRIOR_ID,
        ...valid.slice(8),
      ],
      [
        ...valid.slice(0, 6),
        '--prior-claim-id',
        'has whitespace',
        ...valid.slice(6),
      ],
      [...valid, '--allow-untrusted'],
      [...valid, '--classifier', 'RESOLVED'],
      [...valid, '--deadline-ms', '1'],
      ['--subject-ids', 'IC_existing', ...valid],
      ['--issue', '42', '--repo', 'owner/repo'],
      [...valid.slice(0, 2), '--repo', 'owner/.', ...valid.slice(4)],
      [...valid.slice(0, 2), '--repo', 'owner/..', ...valid.slice(4)],
    ];
    for (const args of invalidInputs) {
      const result = runTakeoverCli(args, tracePath);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(tracePath), false);
    }

    const noTrustedRoot = join(tempRoot, 'no-trusted-config');
    mkdirSync(noTrustedRoot);
    const noTrusted = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        '',
      ],
      tracePath,
      {
        IDD_TRUSTED_MARKER_ACTORS: '',
        IDD_HELPER_ERROR_ENVELOPE: '',
      },
      noTrustedRoot,
    );
    assert.equal(noTrusted.status, 2, noTrusted.stderr);
    assert.match(noTrusted.stderr, /no trusted marker logins supplied/);
    assert.equal(existsSync(tracePath), false);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('takeover listing handles responses larger than the default pipe buffer', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-minimize-takeover-large-listing-'),
  );
  const tracePath = join(tempRoot, 'gh-trace.jsonl');
  const comments = Array.from({ length: 24 }, (_, index) =>
    takeoverIssueComment(`IC_large_${index}`, 'x'.repeat(50_000)),
  );
  const restore = stubExecutable('gh', makeTakeoverGhStub([comments]));
  try {
    const result = runTakeoverCli(
      [
        '--issue',
        '42',
        '--repo',
        'owner/repo',
        '--prior-claim-id',
        TAKEOVER_PRIOR_ID,
        '--active-claim-id',
        TAKEOVER_ACTIVE_ID,
        '--trusted-marker-logins',
        'kurone-kito',
      ],
      tracePath,
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      counts: { selected: number };
    };
    assert.equal(report.counts.selected, 0);
    assert.deepEqual(
      readGhTrace(tracePath).map((call) => call.type),
      ['rest'],
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
