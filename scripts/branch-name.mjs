#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-name.mts
//
// The scripts/branch-name.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Deterministic, network-free helper for the canonical IDD branch name.
//
// It implements the `issue/<number>-<slug>` slug algorithm defined in
// `.github/instructions/idd-claim.instructions.md` pre-check (e) exactly,
// so parallel sessions converge on a byte-identical branch name and the
// pre-check (e) collision detection can recognize two sessions as working
// the same issue. The written algorithm remains the canonical spec and
// fallback; this helper only removes the hand-tracing error surface.
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { isCliExecution } from './gh-exec.mjs';

// The fixed stop-word set from pre-check (e). Whole-token matches only.
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'in',
  'for',
  'to',
  'with',
  'from',
]);
const MAX_SLUG_LENGTH = 40;
const FALLBACK_SLUG = 'task';
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `number:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --number spec key
// below. See cli-args.mts's module header for the full invariant.
// (Deliberately not written inside matching quote marks in this comment --
// see advisory-convergence.mts's identical note for why.)
//
// Declared here, above the isCliExecution trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see #1177's entry-order TDZ hardening for the same class
// of bug in this file).
const BRANCH_NAME_FLAG_SPEC = {
  '--number': { type: 'string' },
  '--title': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
if (isCliExecution(import.meta.url)) {
  runCli();
}
/**
 * Compute the deterministic slug for an issue title per pre-check (e):
 *
 * 1. lowercase the title;
 * 2. replace every character outside ASCII `a-z`/`0-9` with `-`;
 * 3. split on `-`, drop empty tokens, drop whole-token stop-words;
 * 4. rejoin with single `-`;
 * 5. if longer than 40 chars, cut to 40 — when that cut lands mid-token
 *    and a `-` exists before char 40, trim back to that `-`, else keep
 *    the hard 40-char cut — then strip any trailing `-`;
 * 6. if empty, fall back to `task`.
 *
 * The algorithm is defined over an issue *title string*. Non-string
 * inputs (including `null`/`undefined`) are out of that domain and are
 * treated as empty, so they fall back to `task` rather than producing a
 * coerced slug such as `object-object` or `123`.
 */
export function computeBranchSlug(title) {
  const normalized = (typeof title === 'string' ? title : '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-');
  const tokens = normalized
    .split('-')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  let slug = tokens.join('-');
  if (slug.length > MAX_SLUG_LENGTH) {
    const cut = slug.slice(0, MAX_SLUG_LENGTH);
    // The cut lands mid-token only when the character at the cut boundary
    // and the last kept character are both token characters (not `-`).
    const boundaryChar = slug.charAt(MAX_SLUG_LENGTH);
    const endsMidToken =
      boundaryChar !== '' && boundaryChar !== '-' && !cut.endsWith('-');
    if (endsMidToken) {
      const lastHyphen = cut.lastIndexOf('-');
      slug = lastHyphen >= 0 ? cut.slice(0, lastHyphen) : cut;
    } else {
      slug = cut;
    }
  }
  slug = slug.replace(/-+$/, '');
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}
/**
 * Compute the canonical `issue/<number>-<slug>` branch name. The caller is
 * responsible for passing a positive integer issue number; the CLI
 * validates this before calling.
 */
export function computeBranchName(issueNumber, title) {
  return `issue/${issueNumber}-${computeBranchSlug(title)}`;
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.number === null) {
    throw new Error('--number is required and must be a positive integer');
  }
  if (args.title === null) {
    throw new Error('--title is required');
  }
  process.stdout.write(`${computeBranchName(args.number, args.title)}\n`);
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, BRANCH_NAME_FLAG_SPEC);
  return {
    number: parseCanonicalIntegerOrNull(values.number),
    title: typeof values.title === 'string' ? values.title : null,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/branch-name.mjs --number <issue-number> --title <issue-title>

Prints the canonical IDD branch name \`issue/<number>-<slug>\` for the given
issue number and title, applying the deterministic slug algorithm from
idd-claim.instructions.md pre-check (e). Deterministic and network-free.

Example:
  node scripts/branch-name.mjs --number 42 --title "Add the OAuth login flow"
  => issue/42-add-oauth-login-flow
`);
}
