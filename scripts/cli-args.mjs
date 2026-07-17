// idd-generated-from: src/scripts/cli-args.mts
//
// The scripts/cli-args.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared node:util parseArgs wrapper (#1446). Owns the tail every
// hand-rolled CLI parser in this repository re-implements: strict flag
// parsing, the repo's established error-message shape, and canonical
// positive/non-negative integer coercion with both contracts (throw /
// resolve-to-null) that exist across the existing parsers.
//
// Design invariants a caller MUST follow (see #1446's settled review):
//
// 1. **Flag-spec keys stay the dashed literal** (e.g. a spec entry shaped
//    like --pr: { type: 'string' }), never a bare key (pr: {...}).
//    `tests/flag-name-matrix.test.mts` scans each helper's own *compiled*
//    .mjs source text for each canonical flag written as a quoted string
//    literal -- the only net under ~30 parsers with no parse-level tests.
//    A bare-key spec would still parse correctly at runtime but silently
//    vanish from that guard. This wrapper strips the leading `--` only
//    internally, right before calling `util.parseArgs` -- never at the
//    caller's spec-declaration site. (This module's own comments avoid
//    writing example flag names inside matching quote marks, on purpose:
//    doing so would let a comment mask a real rename of that same flag
//    in a file the guard scans -- see #1446's PR description.)
// 2. **Define each spec object locally, inside the helper's own .mts
//    file** -- never centralize specs into this module or any other
//    shared constants file. The quoted dashed literal must physically
//    remain in the migrated helper's own generated .mjs for the guard
//    above to keep working; a spec that only lives here would move the
//    literal out of the file the guard actually scans.
//
// Error-message shape (#1446 design lever #2 -- a free choice, since no
// doc or instruction file depends on the exact current text): this
// wrapper re-wraps Node's native parseArgs errors into the repository's
// existing hand-rolled idiom (`unknown argument: --x` / `missing value
// for argument: --x`) rather than surfacing Node's own text
// (`ERR_PARSE_ARGS_UNKNOWN_OPTION` / "Unknown option '--x'", etc.). This
// keeps CLI stderr output consistent across migrated and not-yet-migrated
// helpers instead of splitting the fleet into two different error styles.
//
// Comma-split list-flag and enum-validation helpers (named in #1446's
// proposed change as capabilities the wrapper should eventually own) are
// deliberately NOT included in this first version: none of this issue's
// three pilot call sites need them (`advisory-convergence.mts`'s
// `--trusted-marker-logins` stays a raw string at the parseArgs layer --
// splitting happens later in `resolveTrustedMarkerActors`), so adding them
// now would mean tests are their only caller. Left for whichever of
// #1450/#1451 first needs them.
import { parseArgs as nodeParseArgs } from 'node:util';

const NODE_OPTION_KEY_PATTERN = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
/**
 * Node's native `util.parseArgs` (`strict: true`) throws
 * `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` ("... argument is ambiguous") for
 * `--flag VALUE` whenever VALUE starts with a single dash and could
 * plausibly be another option -- even plainly-numeric values like `-3`
 * (Node's own error message suggests the fix: `--flag=-XYZ`). The
 * pre-migration hand-rolled parsers never had this ambiguity:
 * `requireValue()` only ever rejected a value that itself starts with
 * `--` (a long flag), always accepting a single-dash-prefixed token as the
 * literal value. Rewriting `--flag VALUE` to `--flag=VALUE` up front for
 * every declared `string`-type flag (whenever VALUE is present and does
 * not itself start with `--`) restores that established contract without
 * weakening the genuine flag-shaped-value guard: a VALUE that starts with
 * `--` (i.e. looks like another long option) is deliberately left
 * untouched, so `['--owner', '--assert']` still reaches `util.parseArgs`
 * unmodified and still throws.
 */
function disambiguateSingleDashValues(argv, spec) {
  const stringFlags = new Set(
    Object.entries(spec)
      .filter(([, flagSpec]) => flagSpec.type === 'string')
      .map(([dashedKey]) => dashedKey),
  );
  const rewritten = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (
      stringFlags.has(token) &&
      typeof next === 'string' &&
      next.startsWith('-') &&
      !next.startsWith('--')
    ) {
      rewritten.push(`${token}=${next}`);
      index += 1;
      continue;
    }
    rewritten.push(token);
  }
  return rewritten;
}
/** Extract the offending flag token from a parseArgs error message. The
 * message shape differs by error code (see the empirical cases this
 * pattern was built against): `"Unknown option '--bogus'"`, `"Option
 * '--pr <value>' argument missing"`, `"Option '--owner' argument is
 * ambiguous...."`, `"Option '--assert' does not take an argument"`, and
 * `"Unexpected argument 'stray'. ..."` (no leading dash, for a positional).
 * A single quoted-run capture handles all five: for the `--flag <value>`
 * shape it stops at the space before `<value>`, and for the rest it stops
 * at the closing quote. */
function extractFlagToken(message) {
  return /'(-{0,2}[\w-]+)/.exec(message)?.[1] ?? '<unknown>';
}
/**
 * Re-shape a `util.parseArgs` error into this repository's existing
 * hand-rolled error idiom (see module header for why). Rethrows any error
 * shape this function does not recognize unchanged, rather than risk
 * swallowing information about an error class this wrapper was not built
 * against.
 */
function toRepoShapedError(error) {
  if (!(error instanceof Error) || typeof error.code !== 'string') {
    throw error;
  }
  const err = error;
  const token = extractFlagToken(err.message);
  switch (err.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return new Error(`unknown argument: ${token}`);
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return new Error(
        err.message.includes('does not take an argument')
          ? `unexpected value for argument: ${token}`
          : `missing value for argument: ${token}`,
      );
    default:
      return err;
  }
}
/**
 * Parse `argv` against a declarative flag spec, using `util.parseArgs`
 * under `strict: true` / `allowPositionals: false`. Throws an `Error`
 * shaped in this repository's existing idiom (never Node's native
 * `ERR_PARSE_ARGS_*` text) on an unknown flag, a missing or ambiguous
 * value, an unexpected value on a boolean flag, or a stray positional.
 */
export function parseCliArgs(argv, spec) {
  const nodeOptions = {};
  for (const [dashedKey, flagSpec] of Object.entries(spec)) {
    if (!NODE_OPTION_KEY_PATTERN.test(dashedKey)) {
      throw new Error(
        `cli-args: flag spec key must be a dashed long-option literal (e.g. '--pr'), got: ${dashedKey}`,
      );
    }
    nodeOptions[dashedKey.slice(2)] = flagSpec;
  }
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: disambiguateSingleDashValues(argv, spec),
      options: nodeOptions,
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw toRepoShapedError(error);
  }
  return {
    values: parsed.values,
    positionals: parsed.positionals,
    help: Boolean(parsed.values.help),
  };
}
/** The repository's established canonical-integer token shape, generalized
 * with an inclusive `min` bound: `min: 1` (the default) reproduces the
 * established `/^[1-9]\d*$/` positive-integer guard exactly (see
 * `branch-name.mts`'s pre-migration `parsePositiveInteger`); `min: 0`
 * additionally accepts the single token `"0"`, needed for
 * `ci-wait-policy.mts`'s non-negative `--rerun-count`. Never falls back to
 * `Number.parseInt`'s lenient truncation (`"3.5"` -> 3, `"5abc"` -> 5) --
 * the whole token must match before it is parsed. */
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
function parseCanonicalIntegerToken(token, min) {
  if (typeof token !== 'string' || !CANONICAL_INTEGER_PATTERN.test(token)) {
    return null;
  }
  const value = Number.parseInt(token, 10);
  return value >= min ? value : null;
}
/**
 * Parse a canonical integer token, throwing this repository's shaped error
 * when `token` is missing or invalid. Use for flags whose existing
 * contract is to fail the whole command on a bad value (e.g.
 * `ci-wait-policy.mts`'s `--rerun-count`).
 */
export function parseCanonicalIntegerOrThrow(token, flagName, min = 1) {
  const value = parseCanonicalIntegerToken(token, min);
  if (value === null) {
    throw new Error(`invalid value for argument: ${flagName}`);
  }
  return value;
}
/**
 * Parse a canonical integer token, resolving to `null` when `token` is
 * missing or invalid rather than throwing. Use for flags whose existing
 * contract fails closed at the *caller* instead of at parse time (e.g.
 * `advisory-convergence.mts`'s `--pr` / `--claim-issue`:
 * "an invalid --pr resolves to null (fails closed at the caller)").
 */
export function parseCanonicalIntegerOrNull(token, min = 1) {
  return parseCanonicalIntegerToken(token, min);
}
