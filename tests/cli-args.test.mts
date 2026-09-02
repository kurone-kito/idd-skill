import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractShapedCliParseErrorMessage,
  parseCanonicalIntegerOrNull,
  parseCanonicalIntegerOrThrow,
  parseCliArgs,
  requireFlag,
  stripLeadingArgumentSeparator,
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

test('parseCliArgs: a stray positional containing a space or comma is reported verbatim, not truncated', () => {
  // Third Copilot follow-up on #1446: the positional fallback previously
  // split on whitespace/commas (a carry-over from the flag-form path,
  // which needs that trimming to drop a trailing "<value>" from the same
  // quoted span -- a positional's quoted span has no such suffix to trim).
  assert.throws(() => parseCliArgs(['hello, world'], SAMPLE_SPEC), {
    message: 'unknown argument: hello, world',
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

// --- Declared-alias reservation (#1961) --------------------------------------
// A value token that itself exactly matches one of the spec's own declared
// short option forms must never be silently swallowed as a preceding string
// flag's literal value -- reserve it so the caller gets a clear parse error
// instead. Long option forms already can't hit this: a value starting with
// -- is excluded from the ambiguity rewrite entirely (see the "rejects a
// flag-shaped value" test above), so this section covers the short-form gap
// #1961 reported (found on rerun-advisory-convergence.mts's --check-name,
// reproduced generically here via SAMPLE_SPEC's --help/-h).

test('parseCliArgs: a declared short alias (the help flag) after a string flag is reserved, not swallowed as its value', () => {
  assert.throws(() => parseCliArgs(['--owner', '-h'], SAMPLE_SPEC), {
    message: 'missing value for argument: --owner',
  });
});

test('parseCliArgs: the reservation also covers a declared short alias for another STRING flag, not just a boolean one', () => {
  // The reservation is not help-specific: --pr's own short alias (-p) must
  // be just as reserved as --help's when it appears as another flag's
  // candidate value.
  assert.throws(() => parseCliArgs(['--owner', '-p'], SAMPLE_SPEC), {
    message: 'missing value for argument: --owner',
  });
});

test('parseCliArgs: the short-alias-as-flag two-token path also reserves a declared alias for its value', () => {
  // Mirrors the '-p', '-3' passthrough test above, but with a reserved
  // alias in the value position instead of an ordinary negative number:
  // the token-itself-is-a-short-alias branch must apply the same
  // reservation as the long-flag-token branch tested just above.
  assert.throws(() => parseCliArgs(['-p', '-h'], SAMPLE_SPEC), {
    message: 'missing value for argument: -p',
  });
});

test('parseCliArgs: an UNDECLARED single-dash token is still accepted as a literal value (reservation is scoped to real aliases only)', () => {
  // No flag in SAMPLE_SPEC declares -x as a short form, so it must keep
  // flowing through as an ordinary value -- same established contract as
  // the -3 negative-number case, just spelled with a letter.
  const { values } = parseCliArgs(['--owner', '-x'], SAMPLE_SPEC);
  assert.equal(values.owner, '-x');
});

test('parseCliArgs: standalone -h still resolves to help once nothing precedes it to swallow it', () => {
  // The reservation only changes the two-token ambiguous-value path above;
  // it must not regress -h's ordinary standalone recognition.
  const result = parseCliArgs(['-h'], SAMPLE_SPEC);
  assert.equal(result.help, true);
});

test('parseCliArgs: the exact #1961 reproduction shape (a --title/--number/--help spec mirroring branch-name.mts)', () => {
  // node bin/idd-branch-name.mjs --title -h --number 5 used to print
  // issue/5-h (exit 0) instead of showing help or failing -- --title had
  // no short alias of its own, but -h (declared for --help) was still
  // silently swallowed as --title's literal value. This spec mirrors
  // branch-name.mts's real flags to keep the regression traceable to the
  // reported command.
  const REPRO_SPEC = {
    '--number': { type: 'string' },
    '--title': { type: 'string' },
    '--help': { type: 'boolean', short: 'h' },
  } as const;
  assert.throws(
    () => parseCliArgs(['--title', '-h', '--number', '5'], REPRO_SPEC),
    { message: 'missing value for argument: --title' },
  );
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

// --- Leading `--` stripping (#1921) -----------------------------------------
// pnpm forwards a literal `--` through `pnpm run <script> -- <flags>`
// without stripping it (unlike npm, which strips its own separator first),
// so every migrated helper crashed with "unknown argument: --help" under
// that invocation form. parseCliArgs must strip exactly one leading `--`
// before Node ever sees argv.

test('parseCliArgs: a single leading -- is stripped, parsing identically to the bare form', () => {
  const withSeparator = parseCliArgs(['--', '--help'], SAMPLE_SPEC);
  const bare = parseCliArgs(['--help'], SAMPLE_SPEC);
  assert.deepEqual(withSeparator, bare);
});

test('parseCliArgs: a leading -- still resolves a following flag to its value', () => {
  const { values } = parseCliArgs(['--', '--pr', '7'], SAMPLE_SPEC);
  assert.equal(values.pr, '7');
});

test('parseCliArgs: a doubled leading -- -- still throws (the strip never repeats)', () => {
  // Only ONE leading `--` is ever stripped -- the resulting post-strip
  // argv[0] is checked once, not looped, so a second literal `--` at
  // position 0 remains a hard error rather than being silently consumed
  // as Node's own end-of-options terminator.
  assert.throws(() => parseCliArgs(['--', '--', '--help'], SAMPLE_SPEC), {
    message: 'unknown argument: --',
  });
});

test('parseCliArgs: a bare doubled -- -- (no trailing flag) still throws, not silently accepted', () => {
  // Without the explicit post-strip guard, stripping the first `--` would
  // leave a lone trailing `--` for Node to consume as its own terminator
  // with zero positionals -- silently succeeding instead of erroring, and
  // contradicting the established "a second literal -- stays an error"
  // contract (verified against this repository's current, unpatched
  // behavior for this exact input, which already throws this way).
  assert.throws(() => parseCliArgs(['--', '--'], SAMPLE_SPEC), {
    message: 'unknown argument: --',
  });
});

test('parseCliArgs: a -- appearing anywhere other than index 0 keeps its current behavior', () => {
  // A trailing (non-leading) `--` is consumed by Node as the end-of-options
  // terminator with no positionals following it, so it parses successfully
  // -- this must stay unchanged by the leading-only strip above.
  const { values } = parseCliArgs(['--pr', '7', '--'], SAMPLE_SPEC);
  assert.equal(values.pr, '7');
});

// --- stripLeadingArgumentSeparator (#2465) -----------------------------------
// The five custom parsers excluded from the parseCliArgs wrapper above (see
// post-idd-marker.mts, emit-marker.mts, discover-orphan-filter.mts,
// discover-roadmap-graph.mts, idd-onboard.mts) each call this directly, so
// it needs its own direct coverage independent of parseCliArgs's tests.

test('stripLeadingArgumentSeparator: strips exactly one leading --', () => {
  assert.deepEqual(stripLeadingArgumentSeparator(['--', '--help']), ['--help']);
});

test('stripLeadingArgumentSeparator: is a no-op when there is no leading --', () => {
  const argv = ['--pr', '7'];
  assert.deepEqual(stripLeadingArgumentSeparator(argv), argv);
});

test('stripLeadingArgumentSeparator: a doubled leading -- -- still throws (the strip never repeats)', () => {
  assert.throws(() => stripLeadingArgumentSeparator(['--', '--', '--help']), {
    message: 'unknown argument: --',
  });
});

test('stripLeadingArgumentSeparator: a -- appearing anywhere other than index 0 is left untouched', () => {
  const argv = ['--pr', '7', '--'];
  assert.deepEqual(stripLeadingArgumentSeparator(argv), argv);
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

// --- requireFlag (#1722) -----------------------------------------------------

test('requireFlag: returns a present, non-empty string value unchanged', () => {
  assert.equal(requireFlag('claude-417b737f', '--agent-id'), 'claude-417b737f');
});

test('requireFlag: throws "--flag is required" on undefined', () => {
  assert.throws(() => requireFlag(undefined, '--timestamp'), {
    message: '--timestamp is required',
  });
});

test('requireFlag: throws "--flag is required" on an empty string', () => {
  assert.throws(() => requireFlag('', '--branch'), {
    message: '--branch is required',
  });
});

test('requireFlag: accepts the numeric-string "0" (checks === \'\', not truthiness)', () => {
  // A bare `!value` truthiness check would reject '0' as if the flag were
  // missing -- e.g. --total-item-count '0' (emit-marker.mts /
  // post-idd-marker.mts's watermark type is a legitimate, present value.
  assert.equal(requireFlag('0', '--total-item-count'), '0');
});

test('requireFlag: throws "--flag is required" on a non-string value (e.g. a boolean)', () => {
  assert.throws(() => requireFlag(true, '--head-sha'), {
    message: '--head-sha is required',
  });
  assert.throws(() => requireFlag(null, '--head-sha'), {
    message: '--head-sha is required',
  });
});

// --- extractShapedCliParseErrorMessage (#1922) -------------------------------
// bin/run-helper.mts intercepts a shaped parse error across the child-process
// boundary by recognizing it in captured stderr text -- it never sees the
// original Error object, only Node's default uncaught-exception rendering
// (a source-line preview, then `Error: {message}`, then stack frames, then a
// trailing `Node.js vX.Y.Z` line). These fixtures mirror that exact shape.

const REAL_UNCAUGHT_STDERR_UNKNOWN_ARGUMENT = `file:///repo/scripts/cli-args.mjs:214
      return new Error(\`unknown argument: \${token}\`);
             ^

Error: unknown argument: --bogus-flag
    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:214:14)
    at parseCliArgs (file:///repo/scripts/cli-args.mjs:273:11)
    at parseArgs (file:///repo/scripts/branch-name.mjs:119:28)
    at runCli (file:///repo/scripts/branch-name.mjs:105:16)
    at file:///repo/scripts/branch-name.mjs:52:3
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)

Node.js v22.22.2
`;

test('extractShapedCliParseErrorMessage: extracts "unknown argument: " from real Node uncaught-exception stderr text', () => {
  assert.equal(
    extractShapedCliParseErrorMessage(REAL_UNCAUGHT_STDERR_UNKNOWN_ARGUMENT),
    'unknown argument: --bogus-flag',
  );
});

test('extractShapedCliParseErrorMessage: extracts "missing value for argument: "', () => {
  const stderrText = [
    'Error: missing value for argument: --pr',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:214:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'missing value for argument: --pr',
  );
});

test('extractShapedCliParseErrorMessage: extracts "unexpected value for argument: "', () => {
  const stderrText = [
    'Error: unexpected value for argument: --assert',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:214:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unexpected value for argument: --assert',
  );
});

test('extractShapedCliParseErrorMessage: returns null for an unrelated error class (stack trace must stay intact)', () => {
  const stderrText = [
    'Error: --number is required and must be a positive integer',
    '    at runCli (file:///repo/scripts/branch-name.mjs:111:11)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(extractShapedCliParseErrorMessage(stderrText), null);
});

test('extractShapedCliParseErrorMessage: returns null for text with no "Error: " line at all', () => {
  assert.equal(extractShapedCliParseErrorMessage(''), null);
  assert.equal(
    extractShapedCliParseErrorMessage('some warning to stderr\n'),
    null,
  );
});

test('extractShapedCliParseErrorMessage: a 4th, unrecognized shaped-looking prefix (e.g. "invalid value for argument: ") is NOT matched', () => {
  // parseCanonicalIntegerOrThrow's "invalid value for argument: " shape is
  // deliberately out of scope for this issue (#1922 scopes to the three
  // toRepoShapedError() forms only) -- confirms the extractor doesn't
  // over-match a shape it was never told to recognize.
  const stderrText = [
    'Error: invalid value for argument: --pr',
    '    at parseCanonicalIntegerOrThrow (file:///repo/scripts/cli-args.mjs:1:1)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(extractShapedCliParseErrorMessage(stderrText), null);
});

test('extractShapedCliParseErrorMessage: scans every "Error: " line, not just the first, and returns the first shaped match', () => {
  // A script that logs its own non-fatal "Error: ..." diagnostic to stderr
  // before a later shaped crash must not have that earlier line mask the
  // real one.
  const stderrText = [
    'Error: config not found, using defaults',
    'Error: unknown argument: --typo',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:214:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: --typo',
  );
});

test('extractShapedCliParseErrorMessage: preserves an embedded newline in the offending token instead of truncating at the first line (chatgpt-codex-connector review finding)', () => {
  // A stray positional argument whose own value contains a literal
  // newline (e.g. `node bin/idd-branch-name.mjs $'foo\nbar'`) makes
  // toRepoShapedError() throw `Error: unknown argument: foo\nbar` -- a
  // real Error whose .message already preserves the full verbatim token.
  // Node's default uncaught-exception rendering then prints that message
  // across two lines with no blank line or stack-frame marker between
  // them before the stack trace begins, exactly like this fixture.
  const stderrText = [
    'Error: unknown argument: foo',
    'bar',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:229:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: foo\nbar',
  );
});

test('extractShapedCliParseErrorMessage: an embedded blank line inside the message is preserved too, not mistaken for the trailing Node.js-version blank line', () => {
  const stderrText = [
    'Error: unknown argument: foo',
    '',
    'bar',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:229:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: foo\n\nbar',
  );
});

test('extractShapedCliParseErrorMessage: recognizes and cleans a CRLF-terminated shaped line (Copilot review finding on the line-based rewrite)', () => {
  // A plain `split('\n')` (rather than `split(/\r?\n/)`) leaves a
  // trailing "\r" on every line under CRLF stderr (e.g. Windows). That is
  // not merely cosmetic: the un-anchored (non-multiline) `$` in
  // ERROR_LINE_PATTERN cannot match before a leftover "\r", so the
  // "Error: " line fails to match the pattern at all and the whole
  // shaped error goes undetected -- verified as a real miss (returned
  // null), not just a message with a stray "\r" appended.
  const stderrText = [
    'Error: unknown argument: --x\r',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:229:14)\r',
    '\r',
    'Node.js v22.22.2\r',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: --x',
  );
});

test('extractShapedCliParseErrorMessage: recognizes the bracketed zero-stack form (NODE_OPTIONS=--stack-trace-limit=0, chatgpt-codex-connector review finding)', () => {
  // Verified empirically: `NODE_OPTIONS='--stack-trace-limit=0' node
  // bin/idd-branch-name.mjs --bogus` prints `[Error: unknown argument:
  // --bogus]` -- a single bracketed line with no "Error: " prefix line
  // and no stack frames at all, which the ordinary line-scan above never
  // matches.
  const stderrText = '[Error: unknown argument: --bogus]\n\nNode.js v22.22.2\n';
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: --bogus',
  );
});

test('extractShapedCliParseErrorMessage: the bracketed zero-stack form still rejects an unrelated message', () => {
  const stderrText =
    '[Error: --number is required and must be a positive integer]\n\nNode.js v22.22.2\n';
  assert.equal(extractShapedCliParseErrorMessage(stderrText), null);
});

test('extractShapedCliParseErrorMessage: documented boundary -- a positional argument whose value itself contains a line that looks like a stack frame truncates at that line (chatgpt-codex-connector review finding, rejected: adversarial input, not a defect)', () => {
  // Single-channel stderr-text inference cannot fully distinguish a
  // message-embedded line that happens to look like "    at bar" (or
  // another "Error: " line) from a real stack frame boundary -- this is
  // architecturally inherent to scanning already-rendered text across the
  // subprocess boundary, not an oversight. The exit code and the shaped
  // classification (first line, prefix) both stay correct; only the
  // cosmetic tail of an adversarially-crafted token is affected. Verified
  // directly: `node bin/idd-branch-name.mjs $'foo\n    at bar'` prints
  // "unknown argument: foo" (correct prefix, correct exit code),
  // truncating before "    at bar" rather than including it.
  const stderrText = [
    'Error: unknown argument: foo',
    '    at bar',
    '    at toRepoShapedError (file:///repo/scripts/cli-args.mjs:229:14)',
    '',
    'Node.js v22.22.2',
  ].join('\n');
  assert.equal(
    extractShapedCliParseErrorMessage(stderrText),
    'unknown argument: foo',
  );
});
