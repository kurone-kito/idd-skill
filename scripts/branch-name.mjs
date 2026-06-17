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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (isCliExecution()) {
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
 */
export function computeBranchSlug(title) {
  const normalized = String(title ?? '')
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
  if (!Number.isInteger(args.number) || (args.number ?? 0) <= 0) {
    throw new Error('--number is required and must be a positive integer');
  }
  if (args.title === null) {
    throw new Error('--title is required');
  }
  process.stdout.write(`${computeBranchName(args.number, args.title)}\n`);
}
function parseArgs(argv) {
  const parsed = { number: null, title: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--number') {
      parsed.number = Number.parseInt(String(requireValue()), 10);
      index += 1;
      continue;
    }
    if (token === '--title') {
      parsed.title = requireValue();
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
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
function isCliExecution() {
  return (
    Boolean(process.argv[1]) &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}
