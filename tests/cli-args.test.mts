import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseCanonicalIntegerOrNull,
  parseCanonicalIntegerOrThrow,
  parseCliArgs,
} from '../src/scripts/cli-args.mts';

const SAMPLE_SPEC = {
  '--pr': { type: 'string', short: 'p' },
  '--owner': { type: 'string' },
  '--policy': { type: 'string', default: '.github/idd/config.json' },
  '--list': { type: 'string', multiple: true },
  '--assert': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

// --- parseCliArgs ------------------------------------------------------------

test('parseCliArgs: rejects an unknown flag with the repo error shape', () => {
  assert.throws(() => parseCliArgs(['--bogus'], SAMPLE_SPEC), {
    message: 'unknown argument: --bogus',
  });
});

test('parseCliArgs: rejects a stray positional the same way as an unknown flag', () => {
  assert.throws(() => parseCliArgs(['stray-positional'], SAMPLE_SPEC), {
    message: 'unknown argument: stray-positional',
  });
});

test('parseCliArgs: rejects a missing value at end of argv', () => {
  assert.throws(() => parseCliArgs(['--pr'], SAMPLE_SPEC), {
    message: 'missing value for argument: --pr',
  });
});

test('parseCliArgs: rejects a flag-shaped value (does not silently swallow the next flag)', () => {
  // This is the exact scenario named in #1446's acceptance criteria: a
  // hand-rolled parser would have assigned owner='--assert' and silently
  // dropped --assert. The wrapper must fail fast instead.
  assert.throws(
    () => parseCliArgs(['--pr', '5', '--owner', '--assert'], SAMPLE_SPEC),
    { message: 'missing value for argument: --owner' },
  );
});

test('parseCliArgs: rejects an unexpected value on a boolean flag', () => {
  assert.throws(() => parseCliArgs(['--assert=true'], SAMPLE_SPEC), {
    message: 'unexpected value for argument: --assert',
  });
});

test('parseCliArgs: accepts --flag=value', () => {
  const { values } = parseCliArgs(['--pr=5'], SAMPLE_SPEC);
  assert.equal(values.pr, '5');
});

test('parseCliArgs: accepts a single-dash-prefixed value (e.g. a negative number) without the ambiguity throw', () => {
  // Node's native util.parseArgs throws "argument is ambiguous" for
  // `--pr -3` because -3 looks like it could be another option. The
  // pre-migration hand-rolled parsers never had this ambiguity -- they
  // only rejected values starting with `--`. This wrapper's single-dash
  // disambiguation preprocessing must restore that contract so the value
  // flows through to the caller's own validation instead of throwing here.
  const { values } = parseCliArgs(['--pr', '-3'], SAMPLE_SPEC);
  assert.equal(values.pr, '-3');
});

test('parseCliArgs: a short alias with a single-dash-prefixed value also avoids the ambiguity throw', () => {
  // Copilot review finding on #1446: the short-option case hits the same
  // Node ambiguity as the long-option case, but `-p=-3` does NOT fix it
  // the way `--pr=-3` does -- Node only special-cases `=` splitting for
  // long options, so `-p=-3` would parse as the literal value `"=-3"`.
  // The preprocessing must rewrite the short-token case onto the long
  // key's `=` form instead of its own short form.
  const { values } = parseCliArgs(['-p', '-3'], SAMPLE_SPEC);
  assert.equal(values.pr, '-3');
});

test('parseCliArgs: a short alias -x=value form is normalized (not left as a literal "=value")', () => {
  // Second Copilot follow-up on #1446: unlike a long option, Node does
  // NOT special-case `=` splitting for a short option at all, so `-p=5`
  // (ordinary input, not just a -3-shaped edge case) parsed to the
  // literal value "=5", not "5", before this fix -- silently wrong, not
  // merely an ambiguity throw.
  assert.equal(parseCliArgs(['-p=5'], SAMPLE_SPEC).values.pr, '5');
  assert.equal(parseCliArgs(['-p=-3'], SAMPLE_SPEC).values.pr, '-3');
});

test('parseCliArgs: a short alias still rejects a flag-shaped value', () => {
  // The reported token echoes exactly what was typed (-p), not the long
  // form -- Node's own error message names the short token here.
  assert.throws(() => parseCliArgs(['-p', '--assert'], SAMPLE_SPEC), {
    message: 'missing value for argument: -p',
  });
});

test('parseCliArgs: repeated non-multiple flags -- last one wins (Node native behavior)', () => {
  const { values } = parseCliArgs(['--pr', '1', '--pr', '2'], SAMPLE_SPEC);
  assert.equal(values.pr, '2');
});

test('parseCliArgs: multiple:true accumulates repeated flags into an array', () => {
  const { values } = parseCliArgs(['--list', 'a', '--list', 'b'], SAMPLE_SPEC);
  assert.deepEqual(values.list, ['a', 'b']);
});

test('parseCliArgs: -h short flag is recognized and surfaced as help', () => {
  const result = parseCliArgs(['-h'], SAMPLE_SPEC);
  assert.equal(result.help, true);
  assert.equal(result.values.help, true);
});

test('parseCliArgs: help is recognized without requiring any other flag', () => {
  const result = parseCliArgs(['--help'], SAMPLE_SPEC);
  assert.equal(result.help, true);
});

test('parseCliArgs: help defaults to false and never calls process.exit itself', () => {
  const result = parseCliArgs(['--pr', '1'], SAMPLE_SPEC);
  assert.equal(result.help, false);
});

test('parseCliArgs: a declared default is applied when the flag is omitted', () => {
  const { values } = parseCliArgs([], SAMPLE_SPEC);
  assert.equal(values.policy, '.github/idd/config.json');
});

test('parseCliArgs: an explicit value overrides the declared default', () => {
  const { values } = parseCliArgs(['--policy', '/tmp/other.json'], SAMPLE_SPEC);
  assert.equal(values.policy, '/tmp/other.json');
});

test('parseCliArgs: positionals is always empty (allowPositionals: false)', () => {
  const { positionals } = parseCliArgs(['--pr', '1'], SAMPLE_SPEC);
  assert.deepEqual(positionals, []);
});

// --- parseCanonicalIntegerOrThrow / parseCanonicalIntegerOrNull -------------
// Both integer contracts named in #1446's acceptance criteria: throw (e.g.
// ci-wait-policy.mts's --rerun-count) and resolve-to-null (e.g.
// advisory-convergence.mts's --pr / --claim-issue).

test('parseCanonicalIntegerOrThrow: parses a canonical positive integer token', () => {
  assert.equal(parseCanonicalIntegerOrThrow('42', '--number'), 42);
});

test('parseCanonicalIntegerOrThrow: throws on "0" with the default min of 1', () => {
  assert.throws(() => parseCanonicalIntegerOrThrow('0', '--number'), {
    message: 'invalid value for argument: --number',
  });
});

test('parseCanonicalIntegerOrThrow: accepts "0" when min is explicitly 0', () => {
  assert.equal(parseCanonicalIntegerOrThrow('0', '--rerun-count', 0), 0);
});

test('parseCanonicalIntegerOrThrow: throws on a negative, decimal, or trailing-garbage token', () => {
  for (const token of ['-3', '3.5', '5abc', 'not-a-number', '007']) {
    assert.throws(
      () => parseCanonicalIntegerOrThrow(token, '--rerun-count', 0),
      { message: 'invalid value for argument: --rerun-count' },
      `expected "${token}" to throw`,
    );
  }
});

test('parseCanonicalIntegerOrThrow: throws when the token is absent', () => {
  assert.throws(() => parseCanonicalIntegerOrThrow(undefined, '--number'), {
    message: 'invalid value for argument: --number',
  });
});

test('parseCanonicalIntegerOrNull: resolves an invalid token to null instead of throwing', () => {
  for (const token of ['0', '-3', '3.5', '5abc', 'not-a-number', undefined]) {
    assert.equal(parseCanonicalIntegerOrNull(token), null);
  }
});

test('parseCanonicalIntegerOrNull: resolves a canonical positive integer token', () => {
  assert.equal(parseCanonicalIntegerOrNull('7'), 7);
});

test('parseCanonicalIntegerOrNull: honors an explicit min of 0', () => {
  assert.equal(parseCanonicalIntegerOrNull('0', 0), 0);
});
