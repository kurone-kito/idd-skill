import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeExitCode,
  isTrustedAuthor,
  resolveTrustedActors,
} from '../src/scripts/minimize-superseded-markers.mts';

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
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(binDir, 'gh'), 0o755);

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
        env: {
          ...process.env,
          PATH: binDir,
          IDD_TRUSTED_MARKER_ACTORS: '',
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.trustedMarkerActorsSource, 'config');
    assert.deepEqual(report.trustedMarkerActors, ['kurone-kito']);
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

test('an explicit empty --trusted-marker-logins value is accepted, unlike --subject-ids', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  try {
    // Stub gh to fail deterministically and offline: a per-item failure
    // (exit 1) proves the empty string reached resolveTrustedActors()
    // instead of being rejected at parse time (which would be exit 2 with
    // the "requires a value" message, before any gh call happens at all).
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(binDir, 'gh'), 0o755);

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
        env: {
          ...process.env,
          PATH: binDir,
          IDD_TRUSTED_MARKER_ACTORS: '',
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.trustedMarkerActorsSource, 'none');
    assert.deepEqual(report.trustedMarkerActors, []);
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
  try {
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env node
const value = (process.argv.find((a) => a.startsWith('id=')) ?? '').slice(3);
const message = \`Could not resolve to a node with the global id of '\${value}'\`;
process.stdout.write(JSON.stringify({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message }] }));
process.stderr.write(\`gh: \${message}\\n\`);
process.exit(1);
`,
    );
    chmodSync(join(binDir, 'gh'), 0o755);

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
        env: {
          ...process.env,
          // Prepend the stub dir so the bare `gh` lookup resolves to the
          // stub, not a real gh binary, while keeping the rest of PATH
          // (matching the other CLI-stub tests in this repo) so the gh
          // stub's #!/usr/bin/env node shebang can still find `node`.
          // Conditional concatenation avoids a trailing `:` (and the
          // implicit current-directory PATH entry it creates on POSIX)
          // when PATH is unset.
          PATH: process.env.PATH ? `${binDir}:${process.env.PATH}` : binDir,
          IDD_TRUSTED_MARKER_ACTORS: '',
        },
        encoding: 'utf8',
      },
    );
  } finally {
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
