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

// #1922: the three message-shape prefixes toRepoShapedError() below
// produces. Named here (rather than inlined at each call site) so
// extractShapedCliParseErrorMessage() can recognize the exact same shapes
// from raw text -- across the bin/run-helper.mts subprocess boundary,
// where only the child's captured stderr text is visible, never the
// original Error object -- without either copy silently drifting out of
// sync with the other.
const UNKNOWN_ARGUMENT_PREFIX = 'unknown argument: ';
const MISSING_VALUE_FOR_ARGUMENT_PREFIX = 'missing value for argument: ';
const UNEXPECTED_VALUE_FOR_ARGUMENT_PREFIX = 'unexpected value for argument: ';
const REPO_SHAPED_CLI_PARSE_ERROR_PREFIXES = [
  UNKNOWN_ARGUMENT_PREFIX,
  MISSING_VALUE_FOR_ARGUMENT_PREFIX,
  UNEXPECTED_VALUE_FOR_ARGUMENT_PREFIX,
];
const NODE_OPTION_KEY_PATTERN = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
/**
 * Node's native `util.parseArgs` (`strict: true`) throws
 * `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` ("... argument is ambiguous") for
 * `--flag VALUE` whenever VALUE starts with a single dash and could
 * plausibly be another option -- even plainly-numeric values like `-3`
 * (Node's own error message suggests the fix: `--flag=-XYZ`). This
 * wrapper's own pre-migration pilots (`branch-name.mts`,
 * `ci-wait-policy.mts`) never had this ambiguity: each had a
 * `requireValue()`-style helper that only rejected a value starting with
 * `--` (a long flag), always accepting a single-dash-prefixed token like
 * `-3` as the literal value -- and `branch-name.test.mts`'s existing
 * `'0'`/`'-3'` test requires that exact contract to keep working
 * unchanged after migration. This is not a claim about every hand-rolled
 * parser in the repository: at least one (`review-disposition-verify.mts`)
 * rejects any single-dash-prefixed value, not only a `--`-prefixed one, so
 * a future migration of that file (or a similarly-stricter one) needs its
 * own contract check, not an assumption that this preprocessing is a
 * drop-in behavioral match for every existing parser. Rewriting `--flag
 * VALUE` to `--flag=VALUE` up front for
 * every declared `string`-type flag (whenever VALUE is present and does
 * not itself start with `--`) restores that established contract without
 * weakening the genuine flag-shaped-value guard: a VALUE that starts with
 * `--` (i.e. looks like another long option) is deliberately left
 * untouched, so `['--owner', '--assert']` still reaches `util.parseArgs`
 * unmodified and still throws.
 *
 * A short alias (`short: 'p'`) hits the identical two-token ambiguity for
 * `-p -3`, rewritten the same way onto the long key's `=` form (`['-p',
 * '-3']` becomes `['--pr=-3']`, not `['-p=-3']` -- see the next paragraph
 * for why the short form's own `=` cannot carry it). A short token with no
 * matching long-flag entry in `spec` is left untouched (`util.parseArgs`
 * will report its own unknown-option or missing-value error for it, same
 * as before this preprocessing pass existed for the long-flag case).
 *
 * A short alias also needs a SEPARATE, single-token rewrite Node's own
 * `--flag=value` handling does not cover: unlike a long option, Node does
 * NOT special-case `=` splitting for a short option at all, so `-p=5` (an
 * entirely ordinary invocation, not just a `-3`-shaped edge case) parses
 * to the literal value `"=5"`, not `"5"` (verified empirically) --
 * silently wrong for common input, not merely an ambiguity throw. Every
 * `-<short>=<value>` token whose short letter maps to a declared
 * `string`-type flag is rewritten onto that flag's long `=` form before
 * `util.parseArgs` ever sees it: `-p=5` becomes `--pr=5`, `-p=-3` becomes
 * `--pr=-3`. A short letter with no matching flag entry is left untouched.
 *
 * **Declared-alias reservation (#1961).** The two-token rewrite above is
 * only safe when the following token is a genuinely arbitrary value (a
 * negative number, an unrelated string starting with a dash, and so on).
 * When that token instead exactly matches a short alias the spec itself
 * declares -- for any flag, not only a string-typed one, e.g. a boolean
 * help flag's own short letter -- rewriting it would silently swallow a
 * real flag as another flag's literal value instead of ever reaching
 * `util.parseArgs` as itself. A declared long option form never hits this
 * problem in the first place: it already falls outside the two-token
 * rewrite entirely, since a value starting with `--` is excluded from
 * `isAmbiguousValue` above. So every declared short form is carved out of
 * the rewrite, left exactly as typed; `util.parseArgs` then reports its
 * own ambiguous-value error for it (re-shaped by {@link toRepoShapedError}
 * into this module's usual missing-value idiom), the same clear failure
 * this module already produces when a flag's value is missing outright,
 * rather than resolving to a wrong literal value one flag can never
 * actually mean for another.
 */
// Matches a short option's `=value` form as ONE argv token, e.g. `-p=5`
// or `-p=-3` -- captures the short letter and everything after `=`
// (including an embedded `=` or a leading `-`, so `-p=-3` and `-p==` both
// capture their full intended value).
const SHORT_FLAG_EQUALS_PATTERN = /^-([A-Za-z])=([\s\S]*)$/;
function disambiguateSingleDashValues(argv, spec) {
  const stringFlags = new Set(
    Object.entries(spec)
      .filter(([, flagSpec]) => flagSpec.type === 'string')
      .map(([dashedKey]) => dashedKey),
  );
  const shortToLong = new Map(
    Object.entries(spec)
      .filter(([, flagSpec]) => flagSpec.type === 'string' && flagSpec.short)
      .map(([dashedKey, flagSpec]) => [`-${flagSpec.short}`, dashedKey]),
  );
  // #1961: every declared short alias, regardless of the owning flag's
  // `type` -- unlike `shortToLong` above (string-typed flags only, since
  // that map feeds the `-x=value` single-token rewrite, which only makes
  // sense for a value-taking flag), a boolean flag's short alias (e.g. a
  // help flag) is just as reservable as a string flag's.
  const declaredShortForms = new Set(
    Object.values(spec)
      .filter((flagSpec) => flagSpec.short)
      .map((flagSpec) => `-${flagSpec.short}`),
  );
  const rewritten = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // Single-token case: `-p=VALUE`. Node only special-cases `=` splitting
    // for LONG options; for a short option it keeps the literal `=` as
    // part of the value (`-p=5` parses to `"=5"`, not `"5"` -- verified
    // empirically), which is silently wrong for entirely ordinary input,
    // not just an ambiguity edge case. Rewrite onto the long key's own
    // (correctly `=`-splitting) form before Node ever sees it.
    const shortEquals = SHORT_FLAG_EQUALS_PATTERN.exec(token);
    if (shortEquals) {
      const longKey = shortToLong.get(`-${shortEquals[1]}`);
      if (longKey !== undefined) {
        rewritten.push(`${longKey}=${shortEquals[2]}`);
        continue;
      }
    }
    // Two-token case: `--flag VALUE` / `-p VALUE` where VALUE starts with
    // a single dash and could plausibly be another option. Excludes a
    // VALUE that is itself a declared short alias (#1961 above) -- that
    // token is reserved, never rewritten into another flag's literal
    // value, regardless of which flag precedes it.
    const next = argv[index + 1];
    const isAmbiguousValue =
      typeof next === 'string' &&
      next.startsWith('-') &&
      !next.startsWith('--') &&
      !declaredShortForms.has(next);
    if (stringFlags.has(token) && isAmbiguousValue) {
      rewritten.push(`${token}=${next}`);
      index += 1;
      continue;
    }
    const longKey = shortToLong.get(token);
    if (longKey !== undefined && isAmbiguousValue) {
      rewritten.push(`${longKey}=${next}`);
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
 * A flag with a `short` alias adds a sixth shape for the "missing value"
 * case specifically -- meaning the value is entirely absent (the flag is
 * the last token in argv, so there is nothing left to even look ambiguous
 * -- see the distinct "ambiguous" shape below for a present-but-suspect
 * value): Node reports the **combined** descriptor `"Option '-p, --pr
 * <value>' argument missing"` regardless of which of the two forms the
 * caller actually typed (verified empirically for both) -- the long form
 * is always preferred when both appear together in the quoted span,
 * matching this repository's established `--flag`-only error idiom. The
 * "ambiguous" / "does not take an argument" shapes never combine forms
 * this way; each always echoes exactly the single token the caller typed
 * (also verified empirically, including for a short-typed ambiguous
 * value: `-p --assert` reports only `'-p'`, never the combined pair). */
function extractFlagToken(message) {
  const quoted = /'([^']*)'/.exec(message)?.[1] ?? '';
  if (!quoted.startsWith('-')) {
    // Not a flag-shaped quoted span (the positional-argument case). Node's
    // "Unexpected argument '<token>'. ..." message closes the quote
    // immediately after the exact token -- unlike the flag-missing-value
    // shape, there is no trailing "<value>" (or anything else) sharing
    // the same quoted span to trim off -- so the captured content is
    // already the whole token verbatim. Return it as-is rather than
    // splitting on whitespace/commas, which would truncate a positional
    // that itself contains one of those characters (checked before the
    // flag-form searches below, which otherwise risk matching an embedded
    // hyphen inside an ordinary word, e.g. "stray-positional").
    return quoted || '<unknown>';
  }
  // Flag-shaped: prefer a long form found anywhere in the span -- Node's
  // combined "-p, --pr <value>" missing-value message (a flag declared
  // with a `short` alias) puts the long form second -- else fall back to
  // the leading token (a lone short or long form with no combined pair).
  return (
    /(--[\w-]+)/.exec(quoted)?.[1] ??
    /^(-{1,2}[\w-]+)/.exec(quoted)?.[1] ??
    '<unknown>'
  );
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
      return new Error(`${UNKNOWN_ARGUMENT_PREFIX}${token}`);
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return new Error(
        err.message.includes('does not take an argument')
          ? `${UNEXPECTED_VALUE_FOR_ARGUMENT_PREFIX}${token}`
          : `${MISSING_VALUE_FOR_ARGUMENT_PREFIX}${token}`,
      );
    default:
      return err;
  }
}
/**
 * Recognize Node's default uncaught-exception stderr text for a shaped CLI
 * parse error (#1922) and extract just the one-line message, discarding
 * the source-line preview, stack frames, and trailing `Node.js vX.Y.Z`
 * footer Node prints around it. Scans **every** `Error: ` -prefixed line in
 * the text -- not just the first -- and returns the first whose message
 * starts with one of the three shapes {@link toRepoShapedError} produces,
 * so a script that logs its own unrelated `Error: ...` diagnostic before a
 * later real crash can't mask the shaped line. Returns `null` when no line
 * matches, the safe default: a caller should forward the original text
 * unchanged in that case, exactly as it would for any other error class.
 */
// Node's own stack-frame rendering, always "    at ..." (4+ spaces). Used
// to find where a captured message ends -- see extractShapedCliParseErrorMessage's
// line-scan below.
const STACK_FRAME_LINE_PATTERN = /^\s+at /;
// A line starting a new "Error: " block. Reused both to *find* candidate
// blocks and to know where the *previous* block's message ends (a second
// "Error: " line immediately terminates the one before it, same as a
// stack frame would).
const ERROR_LINE_PATTERN = /^Error: (.*)$/;
// `NODE_OPTIONS=--stack-trace-limit=0` (a supported Node runtime option, not
// an adversarial input) changes Node's uncaught-exception rendering to a
// single bracketed `[Error: message]` line with no stack frames at all
// (chatgpt-codex-connector review finding) -- verified empirically:
// `NODE_OPTIONS='--stack-trace-limit=0' node bin/idd-branch-name.mjs
// --bogus` prints `[Error: unknown argument: --bogus]` with none of the
// usual "Error: "-prefixed / "    at " structure this module otherwise
// relies on. Handled as its own single-line case, not folded into the
// line-scan loop above: a message that itself happens to span multiple
// lines under this zero-stack bracketed form has no unambiguous
// terminator to scan for (no stack frame ever follows to mark the end),
// so that narrower intersection is a disclosed, accepted gap rather than
// something this pattern attempts to solve.
const BRACKETED_ZERO_STACK_ERROR_LINE_PATTERN = /^\[Error: (.*)\]$/;
export function extractShapedCliParseErrorMessage(stderrText) {
  // Line-based, not a single regex: a shaped message can itself contain an
  // embedded newline (e.g. a stray positional argument whose literal value
  // spans multiple lines -- the underlying parseCliArgs() error already
  // preserves that verbatim; this scan must too, rather than truncating at
  // the first line via a `.`-based pattern, which silently drops
  // everything after the first embedded newline). A message block runs
  // from its own "Error: " line up to (but not including) whichever comes
  // first: a stack-frame line, the next "Error: " line, or the end of the
  // text.
  //
  // Split on `/\r?\n/`, not a plain `'\n'` (Copilot review finding): on
  // CRLF stderr (e.g. Windows), a plain `'\n'` split leaves a trailing
  // `\r` on every line, which does more than cosmetically taint the
  // captured message with a stray `\r` -- ERROR_LINE_PATTERN's un-anchored
  // (non-multiline) `$` cannot match before that leftover `\r` at all, so
  // the "Error: " line fails to match this pattern altogether and the
  // whole shaped error goes undetected, silently falling back to the raw
  // stack trace on the one platform (Windows) this repository explicitly
  // supports.
  const lines = stderrText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const bracketed = BRACKETED_ZERO_STACK_ERROR_LINE_PATTERN.exec(
      lines[index],
    );
    if (bracketed !== null && isShapedMessage(bracketed[1])) {
      return bracketed[1];
    }
    const match = ERROR_LINE_PATTERN.exec(lines[index]);
    if (match === null) {
      continue;
    }
    const messageLines = [match[1]];
    let cursor = index + 1;
    while (
      cursor < lines.length &&
      !STACK_FRAME_LINE_PATTERN.test(lines[cursor]) &&
      !ERROR_LINE_PATTERN.test(lines[cursor])
    ) {
      messageLines.push(lines[cursor]);
      cursor += 1;
    }
    const message = messageLines.join('\n');
    if (isShapedMessage(message)) {
      return message;
    }
  }
  return null;
}
function isShapedMessage(message) {
  return REPO_SHAPED_CLI_PARSE_ERROR_PREFIXES.some((prefix) =>
    message.startsWith(prefix),
  );
}
/**
 * Strip a single leading `--` end-of-options marker pnpm forwards through a
 * `pnpm run <script> -- <flags>` alias without consuming it first (#1921),
 * so a pnpm-forwarded invocation parses the same as the equivalent bare
 * form. `parseCliArgs` applies this internally; a hand-rolled parser
 * excluded from that wrapper (#2465) must call this directly on its own
 * `argv` before parsing, since it never goes through `parseCliArgs` at all.
 * Scope is deliberately one token at position 0 only; a `--` anywhere else
 * in argv keeps its current behavior unchanged.
 *
 * A second literal `--` immediately after the stripped one (i.e. argv
 * started `--`, `--`, ...) must still be a hard error, not silently
 * swallowed -- without this guard, stripping once would leave a lone
 * trailing `--` for a caller's own parser to consume as an end-of-options
 * marker with zero positionals, a new silent-success hole. The strip above
 * never repeats -- this is a single explicit check, not a loop.
 */
export function stripLeadingArgumentSeparator(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args[0] === '--') {
    throw new Error(`${UNKNOWN_ARGUMENT_PREFIX}--`);
  }
  return args;
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
  // #1921: Node's `util.parseArgs` treats a pnpm-forwarded leading `--` as
  // the conventional end-of-options marker, rejecting every flag after it
  // as an unexpected positional under `allowPositionals: false` -- see
  // stripLeadingArgumentSeparator's own doc comment for the full rationale.
  const args = stripLeadingArgumentSeparator(argv);
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: disambiguateSingleDashValues(args, spec),
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
/**
 * Validate that a required CLI flag's value is present and non-empty,
 * returning it narrowed to `string`. Throws this repository's established
 * `--flag is required` shape -- the same wording `branch-name.mts`'s
 * `--number`/`--title` checks, `claim-lock.mts`'s `--worktree` check,
 * `verify-install-deps.mts`'s `--key-binary`/`--install-command` checks, and
 * many other hand-rolled parsers across `src/scripts/` already use verbatim
 * -- when `value` is `undefined`, an empty string, or any non-string (e.g. a
 * boolean flag's value passed where a value-flag was expected).
 *
 * Deliberately separate from {@link parseCliArgs}: several write-path
 * helpers (`emit-marker.mts`, `post-idd-marker.mts`) collect a
 * marker-type-dependent, dynamically-keyed field set that `parseCliArgs`'s
 * static, declared spec cannot express -- see each of those files' own
 * `parseArgs` doc comment for the full reasoning behind that exclusion. This
 * function is the narrow, spec-free primitive those hand-rolled parsers can
 * still reuse to report a missing required field BY NAME, instead of
 * deferring to an aggregate downstream guard (a renderer's own payload
 * validation) that only ever reports an unattributed "invalid ... payload"
 * error with no indication of which flag was missing (#1722).
 *
 * Checks `value === ''` explicitly rather than `!value`: several required
 * fields this function guards are numeric-looking strings that are falsy as
 * a *number* but a perfectly valid, present string value -- e.g.
 * `--total-item-count '0'` (emit-marker.mts / post-idd-marker.mts's
 * watermark type). A bare `!value` truthiness check would reject that `'0'`
 * as if the flag were missing.
 */
export function requireFlag(value, flagName) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${flagName} is required`);
  }
  return value;
}
