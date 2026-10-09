#!/usr/bin/env node
// idd-generated-from: src/scripts/check-stray-commit-closes.mts
//
// The scripts/check-stray-commit-closes.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Pre-push check for stray closing references (#3939). A commit message that
// names an issue with a closing keyword, outside the deliberate closing set,
// can close that issue when the commit reaches the default branch. The F2
// merge gate applies the same rule once a PR exists; this check applies it
// before the push. It defines no closing-keyword pattern of its own:
// `findStrayCommitCloses` in supersession-detection.mts does the matching.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCliArgs } from './cli-args.mts';
import { ghText } from './gh-exec.mts';
import {
  type ClosingKeywordCommitPayload,
  findStrayCommitCloses,
  type StrayCommitClose,
} from './supersession-detection.mts';

/** Flag spec for `parseCliArgs`. `--closing-issues` is repeated-flag checked
 * separately, because `parseCliArgs` keeps the last value of a repeated
 * non-multiple option instead of rejecting it. */
export const CHECK_STRAY_COMMIT_CLOSES_FLAG_SPEC = {
  '--closing-issues': { type: 'string' },
  '--help': { type: 'boolean' },
} as const;

const CLOSING_ISSUES_FLAG = '--closing-issues';
const LIST_ENV = 'IDD_CLOSING_ISSUES';
const ISSUE_TOKEN_PATTERN = /^[1-9][0-9]*$/;
// The same pattern as `developmentBranch` in schemas/policy.schema.json.
const DEVELOPMENT_BRANCH_PATTERN =
  /^(?!refs\/heads\/)[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
// Records end in NUL. A commit made with porcelain never holds a NUL, so a
// control byte in a body cannot split a record. Plumbing can store a NUL, and
// then the message is read only up to it.
const RECORD_TERMINATOR = '\0';
const UNIT_SEPARATOR = '\x1f';

const USAGE = `usage: node scripts/check-stray-commit-closes.mjs [--closing-issues <n>[,<n>...]]

Refuses a push whose commits name an issue with a closing keyword outside the
deliberate closing set. The set is --closing-issues when given, else the
IDD_CLOSING_ISSUES variable, else the branch's own issue number.

Exit 0 when the range is clean or the check is skipped, 1 for a stray or a
check that cannot run, and 2 for a usage error.
`;

/** A usage error (exit 2): the arguments or the expected list are invalid. */
class UsageError extends Error {}

/** A check that cannot run (exit 1): a read, fetch or lookup failed. */
class CannotRunError extends Error {}

/**
 * Find the strays in `commits` against `expectedIssues`. Each commit is
 * wrapped once as `{sha, commit: {message}}`, the shape
 * `findStrayCommitCloses` reads. Results keep the input order.
 */
export function checkStrayCommits({
  expectedIssues,
  commits,
}: {
  expectedIssues: readonly number[];
  commits: readonly { sha: string; message: string }[];
}): { strays: StrayCommitClose[] } {
  const payloads: ClosingKeywordCommitPayload[] = commits.map(
    ({ sha, message }) => ({ sha, commit: { message } }),
  );
  const strays = findStrayCommitCloses(payloads, expectedIssues);
  return { strays: strays.map(({ sha, issue }) => ({ sha, issue })) };
}

function runGit(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync('git', [...args], { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

function parseIssueList(text: string): number[] {
  if (text === '') {
    throw new UsageError('the closing issue list is empty');
  }
  return text.split(',').map((token) => {
    const value = Number(token);
    if (!ISSUE_TOKEN_PATTERN.test(token) || !Number.isSafeInteger(value)) {
      throw new UsageError(
        `invalid issue number in the closing list: ${JSON.stringify(token)}`,
      );
    }
    return value;
  });
}

function issueNumberOfBranch(branch: string): number | undefined {
  if (!branch.startsWith('issue/')) {
    return undefined;
  }
  const rest = branch.slice('issue/'.length);
  const dash = rest.indexOf('-');
  if (dash < 0) {
    return undefined;
  }
  const token = rest.slice(0, dash);
  const value = Number(token);
  if (!ISSUE_TOKEN_PATTERN.test(token) || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

function readDevelopmentBranch(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join('.github', 'idd', 'config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new CannotRunError(
      `cannot read .github/idd/config.json: ${(error as Error).message}`,
    );
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new CannotRunError('.github/idd/config.json is not valid JSON');
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new CannotRunError('.github/idd/config.json must hold a JSON object');
  }
  if (!Object.hasOwn(config, 'developmentBranch')) {
    return undefined;
  }
  const value = (config as Record<string, unknown>).developmentBranch;
  if (typeof value !== 'string' || !DEVELOPMENT_BRANCH_PATTERN.test(value)) {
    throw new CannotRunError(
      'developmentBranch in .github/idd/config.json is not a valid branch name',
    );
  }
  return value;
}

function readDefaultBranch(): string {
  let name: string;
  try {
    name = ghText([
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]).trim();
  } catch (error) {
    throw new CannotRunError(
      `could not read the default branch: ${(error as Error).message}`,
    );
  }
  if (name === '') {
    throw new CannotRunError('could not read the default branch: empty answer');
  }
  return name;
}

/** Split `git log -z --format=%H%x1f%B` output into commits. */
function parseRange(output: string): { sha: string; message: string }[] {
  const commits: { sha: string; message: string }[] = [];
  for (const rawRecord of output.split(RECORD_TERMINATOR)) {
    const record = rawRecord.replace(/\n+$/, '');
    if (record === '') {
      continue;
    }
    const separator = record.indexOf(UNIT_SEPARATOR);
    if (separator < 0) {
      throw new CannotRunError('could not parse the commit log');
    }
    commits.push({
      sha: record.slice(0, separator),
      message: record.slice(separator + 1),
    });
  }
  return commits;
}

function run(argv: readonly string[]): number {
  const values = parseFlags(argv);
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const listed = listedIssues(values);
  const branch = readCurrentBranch();
  const branchIssue = issueNumberOfBranch(branch);
  if (listed === undefined && branchIssue === undefined) {
    console.log('skipped: branch is not an issue branch');
    return 0;
  }

  let expected: number[];
  if (listed === undefined) {
    expected = [branchIssue as number];
  } else {
    expected = listed;
    if (branchIssue !== undefined && !listed.includes(branchIssue)) {
      throw new UsageError(
        `the closing list must include this branch's issue number ${branchIssue}`,
      );
    }
  }

  const developmentBranch = readDevelopmentBranch();
  const defaultBranch = readDefaultBranch();
  if (developmentBranch !== undefined && developmentBranch !== defaultBranch) {
    console.log(`skipped: non-default development branch ${developmentBranch}`);
    return 0;
  }
  const base = developmentBranch ?? defaultBranch;

  // A shallow clone cuts the range short without an error, so a stray in an
  // older commit would pass. Refuse to scan instead.
  const shallow = runGit(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0) {
    throw new CannotRunError('could not tell whether the clone is shallow');
  }
  if (shallow.stdout.trim() === 'true') {
    throw new CannotRunError(
      'the clone is shallow, so the scanned range would be incomplete; run git fetch --unshallow and retry',
    );
  }

  const fetched = runGit(['fetch', '--quiet', 'origin', base]);
  if (fetched.status !== 0) {
    throw new CannotRunError(
      `could not fetch origin/${base}; check the network and retry`,
    );
  }
  const verified = runGit([
    'rev-parse',
    '--verify',
    '--quiet',
    `origin/${base}`,
  ]);
  if (verified.status !== 0) {
    throw new CannotRunError(`origin/${base} is missing after fetch`);
  }

  const range = runGit([
    'log',
    '-z',
    '--format=%H%x1f%B',
    `origin/${base}..HEAD`,
  ]);
  if (range.status !== 0) {
    throw new CannotRunError(
      `could not list the commits in origin/${base}..HEAD`,
    );
  }
  const commits = parseRange(range.stdout);
  if (commits.length === 0) {
    console.log('no stray closing references in 0 commits');
    return 0;
  }

  const { strays } = checkStrayCommits({ expectedIssues: expected, commits });
  if (strays.length === 0) {
    console.log(`no stray closing references in ${commits.length} commits`);
    return 0;
  }
  for (const { sha, issue } of strays) {
    console.log(`stray closing reference: commit ${sha} names #${issue}`);
  }
  const list = expected.join(',');
  console.log(
    `hint: to keep these closes, set IDD_CLOSING_ISSUES=${list} for this push and pass --closing-issues ${list} to the F2 gate; otherwise reword the commit`,
  );
  return 1;
}

function parseFlags(argv: readonly string[]): Record<string, unknown> {
  const repeated = argv.filter(
    (arg) =>
      arg === CLOSING_ISSUES_FLAG || arg.startsWith(`${CLOSING_ISSUES_FLAG}=`),
  );
  if (repeated.length > 1) {
    throw new UsageError(`${CLOSING_ISSUES_FLAG} may be given only once`);
  }
  try {
    return parseCliArgs(argv, CHECK_STRAY_COMMIT_CLOSES_FLAG_SPEC).values;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** The explicit list: the flag, else the variable (empty is unset). */
function listedIssues(values: Record<string, unknown>): number[] | undefined {
  const flag = values['closing-issues'];
  if (typeof flag === 'string') {
    return parseIssueList(flag);
  }
  const variable = process.env[LIST_ENV];
  if (variable === undefined || variable === '') {
    return undefined;
  }
  return parseIssueList(variable);
}

function readCurrentBranch(): string {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) {
    throw new CannotRunError('could not read the current branch');
  }
  return result.stdout.trim();
}

function main(argv: readonly string[]): number {
  try {
    return run(argv);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`check-stray-commit-closes: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
