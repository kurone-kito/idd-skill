import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyMinimize,
  computeExitCode,
  isTrustedAuthor,
  probeSubject,
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
    `const value = (process.argv.find((a) => a.startsWith('id=')) ?? '').slice(3);
const message = \`Could not resolve to a node with the global id of '\${value}'\`;
process.stdout.write(JSON.stringify({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message }] }));
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
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { node: { __typename: 'IssueComment', url: 'https://github.com/o/r/issues/1#issuecomment-' + id, isMinimized: false, viewerCanMinimize: true, author: { login: 'kurone-kito' } } } }));
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
