#!/usr/bin/env node
// idd-generated-from: src/scripts/snapshot-issue-body-corpus.mts
//
// The scripts/snapshot-issue-body-corpus.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// #3288: maintainer/CI-only, opt-in tool that vendors real (and a fixed
// set of synthetic-gap) issue bodies plus their current A4
// (discover-viability-gate.mts) / A4.5 (suitability-triage.mts) verdicts
// into tests/fixtures/issue-body-corpus/, so tests/issue-body-corpus.test.mts
// can catch a lexical-gate edit silently flipping a real issue's verdict --
// something the synthetic fixtures in tests/discover-viability-gate.test.mts
// and tests/suitability-triage.test.mts cannot show. Never run by `pnpm
// test` or CI; the corpus itself is test-only (no runtime path reads it),
// so the live gates keep their verdict authority -- this tool only
// freezes a snapshot of what they currently say.
//
// GUARDRAIL (--update-expected only, mirrors update-fixtures.mts):
// regenerating `expected` blesses whatever the code currently emits, so a
// blind regeneration can silently MASK a real regression. Use it ONLY
// after an intentional gate-behavior change, and REVIEW the emitted `git
// diff` -- list every flipped entry in the PR description (see the test
// file's own header). It is not a substitute for correctness.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { normalizeMarkerPrefix } from './audit-authored-issue.mts';
import { parseCliArgs } from './cli-args.mts';
import { evaluateA4Viability } from './discover-viability-gate.mts';
import { ghGraphql } from './gh-exec.mts';
import { loadPolicyConfig } from './idd-config.mts';
import { parseClaimComment } from './marker-helpers.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mts';
import { evaluateSuitabilityLocal } from './suitability-triage.mts';

/** One `tests/fixtures/issue-body-corpus/<id>.json` entry. */
export interface CorpusEntry {
  id: string;
  category: 'merged' | 'negative' | 'synthetic';
  note: string;
  title: string;
  labels: string[];
  body: string;
  bodySha256: string;
  fetchedAt: string;
  expected: ExpectedVerdict;
}

/** The frozen A4/A4.5 verdict shape stored on each corpus entry. */
export interface ExpectedVerdict {
  viability: { passed: boolean; failedCriteria: string[] };
  triage: Record<string, string>;
}

/** One `index.json` row: `{ id, category, note }` for every corpus entry. */
export interface CorpusIndexEntry {
  id: string;
  category: CorpusEntry['category'];
  note: string;
}

// Resolve the repository root by walking up to the nearest package.json
// (mirrors update-fixtures.mts's identical resolveRepoRoot), so the corpus
// directory resolves identically whether this runs as the emitted
// scripts/snapshot-issue-body-corpus.mjs (one level deep under scripts/)
// or the .mts source under Node type stripping (two levels deep under
// src/scripts/).
function resolveRepoRoot(fromDir: string): string {
  let dir = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}

const REPO_ROOT = resolveRepoRoot(import.meta.dirname);
const CORPUS_DIR = resolve(REPO_ROOT, 'tests/fixtures/issue-body-corpus');
const INDEX_PATH = join(CORPUS_DIR, 'index.json');

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `add:`) -- tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals, and
// tests/help-text-flags.test.mts's declared-vs-documented sweep reads this
// exact block from the .mts source. See cli-args.mts's module header for
// the full invariant.
//
// Declared above the import.meta.main trigger below (not alongside the
// rest of this file's helpers) so a `const` here is never in the temporal
// dead zone when the trigger fires synchronously at module-evaluation time
// (see ci-wait-policy.mts's identical note).
const SNAPSHOT_ISSUE_BODY_CORPUS_FLAG_SPEC = {
  '--add': { type: 'string' },
  '--category': { type: 'string' },
  '--note': { type: 'string', default: '' },
  '--refresh': { type: 'boolean', default: false },
  '--update-expected': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/snapshot-issue-body-corpus.mjs --add <n>[,<n>...] --category merged|negative [--note <text>]
  node scripts/snapshot-issue-body-corpus.mjs --refresh
  node scripts/snapshot-issue-body-corpus.mjs --update-expected
  node scripts/snapshot-issue-body-corpus.mjs --help

Maintains tests/fixtures/issue-body-corpus/: one JSON file per entry plus
index.json, each entry vendoring a real (or synthetic-gap) issue body
alongside its current A4 (discover-viability-gate.mjs) / A4.5
(suitability-triage.mjs, local/offline mode) verdict. Never run by
\`pnpm test\` or CI; the corpus is test-only regression data, read by
tests/issue-body-corpus.test.mts.

  --add <n>[,<n>...]   fetch issue(s) <n> (comma-separated) from the
                        current repository and write/overwrite their
                        corpus entries. Requires --category.
  --category <c>        merged | negative -- selection category for
                        every issue in this --add call. A "merged" issue
                        is refused (no file written, non-zero exit)
                        unless it is closed as completed, carries at
                        least one comment whose body starts with
                        "<!-- claimed-by:" authored by a configured
                        trusted marker actor, and was closed by at least
                        one merged pull request.
  --note <text>         optional free-text "note" stored on every entry
                        added by this call (default: "").
  --refresh              re-fetch every existing merged/negative entry
                        (skips category: synthetic, which has no live
                        source) and rewrite body/title/labels/fetchedAt
                        only for entries whose recomputed bodySha256
                        changed -- "expected" is left untouched, so a
                        changed entry needs --update-expected before
                        tests/issue-body-corpus.test.mts passes again.
                        Prints the changed ids.
  --update-expected      recompute "expected" for every entry (including
                        synthetic) from the CURRENT A4/A4.5 helpers and
                        rewrite unconditionally. GUARDRAIL: see the
                        header comment in this tool's own source -- opt-in
                        only, never run by pnpm test/CI, review the diff.
  --help, -h             show this help
`);
}

/**
 * Computes the frozen `{ viability, triage }` verdict this corpus stores
 * for one entry, from the CURRENT A4 (`evaluateA4Viability`) and A4.5
 * (`evaluateSuitabilityLocal`) helpers -- both pure/offline, no network.
 * Exported so tests/issue-body-corpus.test.mts recomputes with the exact
 * same function `--add`/`--update-expected` use, keeping the tool and the
 * regression test single-sourced (never two independently-drifting
 * copies of this fold).
 *
 * `evaluateSuitabilityLocal` is given this repository's own
 * `.github/idd/config.json`-resolved `blockedByHumanLabelName` /
 * `needsDecisionLabelName` / `markerPrefix` -- the exact same resolution
 * `runLocalCli` (this file's `--body-file`/`--stdin` CLI wrapper) uses --
 * rather than relying on that function's own built-in defaults happening
 * to match this repository's config today (config.json's `markerPrefix`
 * is currently the explicit string `"idd-skill"`, which only coincides
 * with `DEFAULT_MARKER_PREFIX`; a future config change would otherwise
 * silently desync this corpus's frozen verdicts from live CLI behavior).
 * `number`/`labels` are accepted on `evaluateA4Viability`'s input (per
 * this issue's own proposed schema, `evaluateA4Viability({ number,
 * title, body, labels })`) even though neither its `normalizeIssue` nor
 * `evaluateSuitabilityLocal` currently reads them -- kept for schema
 * parity/forward compatibility, not because either evaluator consumes
 * them today.
 *
 * The `# <title>` + blank line + `<body>` join below matches
 * `splitLocalDraftTitleAndBody`'s own H1-then-body contract exactly (its
 * regex consumes the title line and any further leading blank lines from
 * the rest, so the extra blank line here is harmless, not load-bearing) --
 * an incorrect join would silently miscompute every triage verdict.
 */
export function computeExpectedVerdict(entry: {
  number?: number;
  title: string;
  body: string;
  labels?: string[];
}): ExpectedVerdict {
  const viability = evaluateA4Viability({
    number: entry.number ?? 0,
    title: entry.title,
    body: entry.body,
    labels: entry.labels ?? [],
  });
  const { config } = loadPolicyConfig();
  const labelsPolicy = normalizePolicyConfig(config).labels;
  const triageResult = evaluateSuitabilityLocal(
    `# ${entry.title}\n\n${entry.body}`,
    {
      blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
      needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
      markerPrefix: normalizeMarkerPrefix(
        (config as { markerPrefix?: unknown } | null)?.markerPrefix,
      ),
    },
  );
  const triage: Record<string, string> = {};
  for (const check of triageResult.checks) {
    triage[check.id] = check.result;
  }
  return {
    viability: {
      passed: viability.passed,
      failedCriteria: viability.failedCriteria,
    },
    triage,
  };
}

/** sha256 hex digest of the exact, unmodified `body` string. */
export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Canonical JSON serialization for every corpus file (2-space indent,
 * trailing newline) -- matches update-fixtures.mts's own convention. */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function entryPath(id: string): string {
  return join(CORPUS_DIR, `${id}.json`);
}

function readIndex(): CorpusIndexEntry[] {
  if (!existsSync(INDEX_PATH)) {
    return [];
  }
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as CorpusIndexEntry[];
}

function writeIndex(index: CorpusIndexEntry[]): void {
  const sorted = [...index].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(INDEX_PATH, serializeJson(sorted));
}

function upsertIndexEntry(
  index: CorpusIndexEntry[],
  row: CorpusIndexEntry,
): CorpusIndexEntry[] {
  const next = index.filter((existing) => existing.id !== row.id);
  next.push(row);
  return next;
}

function readEntry(id: string): CorpusEntry {
  return JSON.parse(readFileSync(entryPath(id), 'utf8')) as CorpusEntry;
}

function writeEntry(entry: CorpusEntry): void {
  if (!existsSync(CORPUS_DIR)) {
    mkdirSync(CORPUS_DIR, { recursive: true });
  }
  writeFileSync(entryPath(entry.id), serializeJson(entry));
}

/** Raw GraphQL issue shape this tool fetches -- see fetchIssue below. */
interface FetchedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  labels: string[];
  hasMergedClosingPr: boolean;
  hasTrustedClaim: boolean;
}

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      body
      state
      stateReason
      labels(first: 30) { nodes { name } }
      closedByPullRequestsReferences(first: 10) { nodes { state } }
      comments(first: 100) { nodes { author { login } body createdAt } }
    }
  }
}`;

function fetchIssue(
  owner: string,
  repo: string,
  number: number,
  isTrustedLogin: (login: string) => boolean,
): FetchedIssue {
  const result = ghGraphql(ISSUE_QUERY, { owner, repo, number }) as {
    data?: {
      repository?: {
        issue?: {
          number: number;
          title: string;
          body: string;
          state: string;
          stateReason: string | null;
          labels: { nodes: { name: string }[] };
          closedByPullRequestsReferences: { nodes: { state: string }[] };
          comments: {
            nodes: {
              author: { login: string } | null;
              body: string;
              createdAt: string;
            }[];
          };
        } | null;
      } | null;
    };
  };
  const issue = result.data?.repository?.issue;
  if (!issue) {
    throw new Error(`issue #${number} not found in ${owner}/${repo}`);
  }
  const hasMergedClosingPr = issue.closedByPullRequestsReferences.nodes.some(
    (pr) => pr.state === 'MERGED',
  );
  // #3368 Copilot review: a bare `startsWith('<!-- claimed-by:')` check is
  // not equivalent to a valid, well-formed claim marker -- it passes on a
  // trusted actor's malformed body (e.g. a truncated or hand-typed
  // `<!-- claimed-by: garbage`) while this boolean guards the merged-
  // corpus selection rule's authoritative "carries a trusted claimed-by
  // marker" requirement. Use the shared strict parser instead: it requires
  // the full agent-id/claim-id/supersedes/timestamp/branch grammar (and is
  // more permissive than a literal prefix on whitespace/case, matching
  // every genuine marker `emit-marker.mts`/`post-idd-marker.mts` produce).
  // The parser's own `createdAt` echo isn't consumed here -- only whether
  // parsing succeeds at all -- but the comment's real GraphQL `createdAt`
  // is passed through for hygiene rather than an empty placeholder.
  const hasTrustedClaim = issue.comments.nodes.some(
    (comment) =>
      parseClaimComment(comment.body, comment.createdAt) !== null &&
      isTrustedLogin(comment.author?.login ?? ''),
  );
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason,
    labels: issue.labels.nodes.map((label) => label.name),
    hasMergedClosingPr,
    hasTrustedClaim,
  };
}

function buildTrustedLoginChecker(): (login: string) => boolean {
  const { config } = loadPolicyConfig();
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: config as { trustedMarkerActors?: unknown } | null,
  });
  const trustedSet = new Set(actors.map((login) => login.toLowerCase()));
  return (login: string) => trustedSet.has(login.toLowerCase());
}

/** This repository's configured `blockedByHumanLabelName` /
 * `needsDecisionLabelName` (POLICY_DEFAULTS fallback when unconfigured) --
 * read once per CLI invocation and passed to `negativeRefusalReason`. */
function resolveLabelsPolicy(): {
  blockedByHumanLabelName: string;
  needsDecisionLabelName: string;
} {
  const { config } = loadPolicyConfig();
  return normalizePolicyConfig(config).labels;
}

/**
 * Refusal reason for a `category: merged` candidate, or `null` when it
 * passes the Selection rule in the issue's own "Proposed change" section:
 * closed as completed, at least one trusted `claimed-by` marker comment,
 * closed by at least one merged pull request.
 */
function mergedRefusalReason(issue: FetchedIssue): string | null {
  if (issue.state !== 'CLOSED' || issue.stateReason !== 'COMPLETED') {
    return `not closed as completed (state=${issue.state}, stateReason=${issue.stateReason ?? 'null'})`;
  }
  if (!issue.hasTrustedClaim) {
    return 'no trusted claimed-by marker comment found';
  }
  if (!issue.hasMergedClosingPr) {
    return 'no merged closing pull request found';
  }
  return null;
}

/**
 * Refusal reason for a `category: negative` candidate, or `null` when it
 * passes the Selection rule in the issue's own "Proposed change" section:
 * carries `status:needs-decision`/`status:blocked-by-human`, or was closed
 * as not planned after an A4.5 rejection, AND the current A4/A4.5 helpers
 * still rate it non-ready. #3368 Copilot review: before this function
 * existed, `--add --category negative` accepted any fetched issue
 * unconditionally, so a maintainer could vendor an entry that violates
 * this category's own selection rule (nothing checked the label/reason or
 * the freshly computed verdict).
 */
function negativeRefusalReason(
  issue: FetchedIssue,
  expected: ExpectedVerdict,
  labelsPolicy: {
    blockedByHumanLabelName: string;
    needsDecisionLabelName: string;
  },
): string | null {
  const hasNegativeLabel =
    issue.labels.includes(labelsPolicy.blockedByHumanLabelName) ||
    issue.labels.includes(labelsPolicy.needsDecisionLabelName);
  const closedNotPlanned =
    issue.state === 'CLOSED' && issue.stateReason === 'NOT_PLANNED';
  if (!hasNegativeLabel && !closedNotPlanned) {
    return (
      `carries neither "${labelsPolicy.blockedByHumanLabelName}" nor ` +
      `"${labelsPolicy.needsDecisionLabelName}", and was not closed as not planned`
    );
  }
  const rendersReady =
    expected.viability.passed &&
    Object.values(expected.triage).every((result) => result !== 'fail');
  if (rendersReady) {
    return 'the current A4/A4.5 helpers rate this issue ready (violates the negative-category selection rule)';
  }
  return null;
}

// #3368 Copilot review: node:util's parseInt-based coercion accepts a
// numeric PREFIX ("123oops" -> 123), silently vendoring the wrong issue
// body for a typo'd --add token instead of rejecting it. Mirrors
// cli-args.mts's own CANONICAL_INTEGER_PATTERN (positive-only variant):
// the whole trimmed token must match before it is parsed.
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

function runAdd(
  owner: string,
  repo: string,
  ids: string[],
  category: string,
  note: string,
): void {
  if (category !== 'merged' && category !== 'negative') {
    throw new Error(
      `--category must be "merged" or "negative", got: ${category}`,
    );
  }
  const numbers: number[] = [];
  for (const rawId of ids) {
    const trimmed = rawId.trim();
    if (!CANONICAL_POSITIVE_INTEGER_PATTERN.test(trimmed)) {
      throw new Error(`--add: not a positive integer issue number: ${rawId}`);
    }
    numbers.push(Number.parseInt(trimmed, 10));
  }

  const isTrustedLogin = buildTrustedLoginChecker();
  const labelsPolicy = resolveLabelsPolicy();
  // #3368 Copilot review: fetch, validate, and refusal-check every id
  // FIRST, writing nothing until the whole batch clears -- a mid-batch
  // fetch/selection failure previously left earlier entry files on disk
  // with index.json unchanged, the exact file/index-drift state
  // tests/issue-body-corpus.test.mts's own consistency check rejects.
  const entries: CorpusEntry[] = [];
  for (const number of numbers) {
    const issue = fetchIssue(owner, repo, number, isTrustedLogin);
    const expected = computeExpectedVerdict({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    const refusal =
      category === 'merged'
        ? mergedRefusalReason(issue)
        : negativeRefusalReason(issue, expected, labelsPolicy);
    if (refusal) {
      throw new Error(
        `refusing to add issue #${number} as category "${category}": ${refusal}`,
      );
    }
    entries.push({
      id: String(issue.number),
      category,
      note,
      title: issue.title,
      labels: issue.labels,
      body: issue.body,
      bodySha256: bodySha256(issue.body),
      fetchedAt: new Date().toISOString(),
      expected,
    });
  }

  let index = readIndex();
  for (const entry of entries) {
    writeEntry(entry);
    index = upsertIndexEntry(index, {
      id: entry.id,
      category: entry.category,
      note: entry.note,
    });
  }
  writeIndex(index);
  const written = entries.map((entry) => entry.id);
  process.stdout.write(
    `snapshot-issue-body-corpus --add — wrote ${written.length} ${
      written.length === 1 ? 'entry' : 'entries'
    }: ${written.join(', ')}\n`,
  );
}

function existingEntryIds(): string[] {
  if (!existsSync(CORPUS_DIR)) {
    return [];
  }
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

function runRefresh(owner: string, repo: string): void {
  const isTrustedLogin = buildTrustedLoginChecker();
  const changed: string[] = [];
  for (const id of existingEntryIds()) {
    const existing = readEntry(id);
    if (existing.category === 'synthetic') {
      continue;
    }
    const number = Number.parseInt(id, 10);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const issue = fetchIssue(owner, repo, number, isTrustedLogin);
    const freshSha = bodySha256(issue.body);
    if (freshSha === existing.bodySha256) {
      continue;
    }
    const updated: CorpusEntry = {
      ...existing,
      title: issue.title,
      labels: issue.labels,
      body: issue.body,
      bodySha256: freshSha,
      fetchedAt: new Date().toISOString(),
    };
    writeEntry(updated);
    changed.push(id);
  }
  process.stdout.write(
    changed.length === 0
      ? 'snapshot-issue-body-corpus --refresh — no changes (every entry current)\n'
      : `snapshot-issue-body-corpus --refresh — bodySha256 changed for ${changed.length} ${
          changed.length === 1 ? 'entry' : 'entries'
        } (run --update-expected before tests/issue-body-corpus.test.mts passes again): ${changed.join(', ')}\n`,
  );
}

function runUpdateExpected(): void {
  const ids = existingEntryIds();
  for (const id of ids) {
    const existing = readEntry(id);
    const updated: CorpusEntry = {
      ...existing,
      expected: computeExpectedVerdict({
        number: Number.parseInt(id, 10) || 0,
        title: existing.title,
        body: existing.body,
        labels: existing.labels,
      }),
    };
    writeEntry(updated);
  }
  process.stdout.write(
    `snapshot-issue-body-corpus --update-expected — recomputed "expected" for ${ids.length} ${
      ids.length === 1 ? 'entry' : 'entries'
    }. GUARDRAIL: review the emitted git diff before committing -- this blesses whatever the current helpers emit.\n`,
  );
}

if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    SNAPSHOT_ISSUE_BODY_CORPUS_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const add = values.add as string | undefined;
  const category = values.category as string | undefined;
  const note = values.note as string;
  const refresh = values.refresh as boolean;
  const updateExpected = values['update-expected'] as boolean;

  const selectedModeCount = [add !== undefined, refresh, updateExpected].filter(
    Boolean,
  ).length;
  if (selectedModeCount === 0) {
    throw new Error(
      'nothing to do: pass --add <n>[,<n>...] --category <c>, --refresh, or --update-expected (see --help)',
    );
  }
  if (selectedModeCount > 1) {
    throw new Error(
      '--add, --refresh, and --update-expected are mutually exclusive; pass exactly one',
    );
  }

  if (add !== undefined) {
    if (!category) {
      throw new Error('--add requires --category merged|negative');
    }
    const { owner, repo } = resolveCurrentGithubRepository();
    runAdd(
      owner,
      repo,
      add
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean),
      category,
      note,
    );
  } else if (refresh) {
    const { owner, repo } = resolveCurrentGithubRepository();
    runRefresh(owner, repo);
  } else {
    runUpdateExpected();
  }
}
