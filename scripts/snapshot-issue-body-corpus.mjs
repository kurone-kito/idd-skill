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
import { normalizeMarkerPrefix } from './audit-authored-issue.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { evaluateA4Viability } from './discover-viability-gate.mjs';
import { ghGraphql } from './gh-exec.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import { parseClaimComment } from './marker-helpers.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';
import {
  filterTrustedClaimFamilyEvents,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mjs';
import { evaluateSuitabilityLocal } from './suitability-triage.mjs';

// Resolve the repository root by walking up to the nearest package.json
// (mirrors update-fixtures.mts's identical resolveRepoRoot), so the corpus
// directory resolves identically whether this runs as the emitted
// scripts/snapshot-issue-body-corpus.mjs (one level deep under scripts/)
// or the .mts source under Node type stripping (two levels deep under
// src/scripts/).
function resolveRepoRoot(fromDir) {
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
};
function printHelp() {
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
                        least one well-formed claimed-by marker comment
                        authored by a configured trusted marker actor,
                        and was closed by at least one merged pull
                        request. A "negative" issue is refused unless it
                        carries the configured needs-decision or
                        blocked-by-human label AND the current A4/A4.5
                        helpers still rate it non-ready (a bare
                        not-planned closure is not by itself sufficient
                        -- see negativeRefusalReason's own doc comment).
  --note <text>         optional free-text "note" stored on every entry
                        added by this call (default: "").
  --refresh              re-fetch every existing merged/negative entry
                        (skips category: synthetic, which has no live
                        source) and rewrite body/title/labels/fetchedAt
                        for any entry whose recomputed bodySha256, title,
                        or labels changed -- "expected" is left
                        untouched in every case (including a title-only
                        change, even though title feeds
                        computeExpectedVerdict), so a changed entry
                        needs --update-expected before
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
export function computeExpectedVerdict(entry) {
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
      markerPrefix: normalizeMarkerPrefix(config?.markerPrefix),
    },
  );
  const triage = {};
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
export function bodySha256(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
/** Canonical JSON serialization for every corpus file (2-space indent,
 * trailing newline) -- matches update-fixtures.mts's own convention. */
function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function entryPath(id) {
  return join(CORPUS_DIR, `${id}.json`);
}
function readIndex() {
  if (!existsSync(INDEX_PATH)) {
    return [];
  }
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}
function writeIndex(index) {
  const sorted = [...index].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(INDEX_PATH, serializeJson(sorted));
}
function upsertIndexEntry(index, row) {
  const next = index.filter((existing) => existing.id !== row.id);
  next.push(row);
  return next;
}
function readEntry(id) {
  return JSON.parse(readFileSync(entryPath(id), 'utf8'));
}
function writeEntry(entry) {
  if (!existsSync(CORPUS_DIR)) {
    mkdirSync(CORPUS_DIR, { recursive: true });
  }
  writeFileSync(entryPath(entry.id), serializeJson(entry));
}
/** Returns whether an issue has an unedited trusted claimed-by marker. */
export function hasTrustedClaimMarker(comments, isTrustedLogin) {
  return filterTrustedClaimFamilyEvents([...comments], isTrustedLogin).some(
    (comment) => parseClaimComment(comment.body, comment.createdAt) !== null,
  );
}
// #3368 Copilot review round 3: `labels`/`comments` are fetched as a
// single un-paginated page each (no cursor follow-up) -- a known,
// fails-safe limitation, not silent bad data: an issue with its
// configured selection-rule label or trusted claimed-by marker beyond
// this page is wrongly REFUSED, never wrongly ADDED. 100 comfortably
// covers this repository's own real corpus entries (the largest observed
// during authoring had well under 100 of either); a repository with a
// more heavily-discussed or more heavily-labeled issue history may need
// real cursor pagination here as a follow-up.
const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      body
      state
      stateReason
      labels(first: 100) { nodes { name } }
      closedByPullRequestsReferences(first: 10) { nodes { state } }
      comments(first: 100) { nodes { author { login } body createdAt lastEditedAt } }
    }
  }
}`;
function fetchIssue(owner, repo, number, isTrustedLogin) {
  const result = ghGraphql(ISSUE_QUERY, { owner, repo, number });
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
  const hasTrustedClaim = hasTrustedClaimMarker(issue.comments.nodes, (login) =>
    isTrustedLogin(login),
  );
  return {
    number: issue.number,
    title: issue.title,
    // #3368 Copilot review round 2: a GitHub issue body can be empty/null;
    // every evaluator this tool feeds it to (evaluateA4Viability,
    // evaluateSuitabilityLocal) already normalizes a missing body to `''`
    // internally, but this fetch boundary previously passed the raw
    // GraphQL value straight through as if `body: string` (the compile-
    // time type) always held -- coerce it explicitly here instead.
    body: String(issue.body ?? ''),
    state: issue.state,
    stateReason: issue.stateReason,
    labels: issue.labels.nodes.map((label) => label.name),
    hasMergedClosingPr,
    hasTrustedClaim,
  };
}
function buildTrustedLoginChecker() {
  const { config } = loadPolicyConfig();
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: config,
  });
  const trustedSet = new Set(actors.map((login) => login.toLowerCase()));
  return (login) => trustedSet.has(login.toLowerCase());
}
/** This repository's configured `blockedByHumanLabelName` /
 * `needsDecisionLabelName` (POLICY_DEFAULTS fallback when unconfigured) --
 * read once per CLI invocation and passed to `negativeRefusalReason`. */
function resolveLabelsPolicy() {
  const { config } = loadPolicyConfig();
  return normalizePolicyConfig(config).labels;
}
/**
 * Refusal reason for a `category: merged` candidate, or `null` when it
 * passes the Selection rule in the issue's own "Proposed change" section:
 * closed as completed, at least one trusted `claimed-by` marker comment,
 * closed by at least one merged pull request. Exported (#3368 Copilot
 * review round 4) for direct unit testing alongside its `negative`
 * sibling below.
 */
export function mergedRefusalReason(issue) {
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
 * the freshly computed verdict). Exported (#3368 Copilot review round 4):
 * the frozen corpus test only ever checks a stored entry's own current
 * verdict, never the selection GUARD itself, so a regression in this
 * function's own accept/refuse logic could pass the suite unnoticed --
 * tests/issue-body-corpus.test.mts now exercises this function directly
 * with synthetic accept/refuse cases.
 */
export function negativeRefusalReason(issue, expected, labelsPolicy) {
  // #3368 Copilot review round 5: the issue's own selection rule reads
  // "carried [the configured label], OR was closed as not planned AFTER
  // AN A4.5 REJECTION" -- a bare `stateReason === 'NOT_PLANNED'` proves
  // only that the issue was closed without shipping, never that the
  // closure specifically followed a suitability-style rejection (this
  // repository's own real history shows NOT_PLANNED closures for
  // unrelated reasons too: resolved-by-reference/superseded, or no
  // recorded reasoning at all). No machine-parseable "A4.5 rejection"
  // marker convention exists in this repository to verify that causal
  // link mechanically (unlike the well-formed `claimed-by` grammar
  // `parseClaimComment` checks above) -- accepting NOT_PLANNED alone
  // risked vendoring an issue that was never actually rejected for
  // suitability reasons. Require the configured label instead, the
  // narrower and mechanically verifiable half of the selection rule; a
  // maintainer/curator who has independently confirmed a specific
  // NOT_PLANNED closure genuinely followed an A4.5-style rejection may
  // still document that verification in the entry's own `note` when
  // adding it by hand outside this refusal check.
  const hasNegativeLabel =
    issue.labels.includes(labelsPolicy.blockedByHumanLabelName) ||
    issue.labels.includes(labelsPolicy.needsDecisionLabelName);
  if (!hasNegativeLabel) {
    return (
      `carries neither "${labelsPolicy.blockedByHumanLabelName}" nor ` +
      `"${labelsPolicy.needsDecisionLabelName}"`
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
// #3368 Copilot review round 4: `Number.isSafeInteger` alone still admits
// a value well above what `ISSUE_QUERY`'s `$number: Int!` GraphQL variable
// can carry -- GraphQL's signed 32-bit `Int` maximum, far below JS's own
// safe-integer ceiling. A value in that gap (e.g. 2147483648) would pass
// the safe-integer check and then fail later inside `ghGraphql` with an
// opaque GraphQL variable-coercion error instead of a clear, up-front
// rejection.
const GRAPHQL_INT_MAX = 2_147_483_647;
/**
 * Splits `--add`'s raw comma-separated value into tokens, throwing on an
 * empty overall value or an empty individual token (a leading/trailing/
 * doubled comma, e.g. `--add ""`, `--add "1,"`, or `--add "1,,2"`).
 *
 * #3368 Copilot review round 2: the previous `.split(',').map(trim)
 * .filter(Boolean)` silently dropped empty tokens instead of rejecting
 * them, so an empty or comma-terminated value could make `runAdd` write
 * zero entries and exit successfully -- a typo silently looking like a
 * no-op success rather than the advertised `<n>[,<n>...]` contract being
 * violated. Each surviving token is still separately validated against
 * `CANONICAL_POSITIVE_INTEGER_PATTERN` by `runAdd` itself.
 */
export function parseAddTokens(raw) {
  const trimmedWhole = raw.trim();
  if (trimmedWhole === '') {
    throw new Error('--add: value must not be empty');
  }
  const tokens = trimmedWhole.split(',').map((token) => token.trim());
  const emptyIndex = tokens.indexOf('');
  if (emptyIndex !== -1) {
    throw new Error(
      `--add: empty issue number token in "${raw}" (position ${emptyIndex + 1}) -- check for a leading, trailing, or doubled comma`,
    );
  }
  return tokens;
}
function runAdd(owner, repo, ids, category, note) {
  if (category !== 'merged' && category !== 'negative') {
    throw new Error(
      `--category must be "merged" or "negative", got: ${category}`,
    );
  }
  const numbers = [];
  for (const rawId of ids) {
    const trimmed = rawId.trim();
    if (!CANONICAL_POSITIVE_INTEGER_PATTERN.test(trimmed)) {
      throw new Error(`--add: not a positive integer issue number: ${rawId}`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    // #3368 Copilot review round 3: the whole-token regex above rejects a
    // syntax typo but still accepts an arbitrarily long digit string;
    // Number.parseInt silently rounds a value past Number.MAX_SAFE_INTEGER
    // before it reaches the GraphQL `Int` variable, so a typo like
    // `--add 9007199254740993` could address a different issue number (or
    // fail later with an opaque GraphQL error) instead of being rejected
    // up front.
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `--add: issue number exceeds the safe integer range: ${rawId}`,
      );
    }
    if (parsed > GRAPHQL_INT_MAX) {
      throw new Error(
        `--add: issue number exceeds the GraphQL Int range (max ${GRAPHQL_INT_MAX}): ${rawId}`,
      );
    }
    numbers.push(parsed);
  }
  const isTrustedLogin = buildTrustedLoginChecker();
  const labelsPolicy = resolveLabelsPolicy();
  // #3368 Copilot review: fetch, validate, and refusal-check every id
  // FIRST, writing nothing until the whole batch clears -- a mid-batch
  // fetch/selection failure previously left earlier entry files on disk
  // with index.json unchanged, the exact file/index-drift state
  // tests/issue-body-corpus.test.mts's own consistency check rejects.
  const entries = [];
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
    `snapshot-issue-body-corpus --add — wrote ${written.length} ${written.length === 1 ? 'entry' : 'entries'}: ${written.join(', ')}\n`,
  );
}
function existingEntryIds() {
  if (!existsSync(CORPUS_DIR)) {
    return [];
  }
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}
/** Order-insensitive label-set equality, so a GraphQL response returning
 * the same labels in a different order is never mistaken for a change. */
function labelsEqual(a, b) {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return (
    sortedA.length === sortedB.length &&
    sortedA.every((label, index) => label === sortedB[index])
  );
}
function runRefresh(owner, repo) {
  const isTrustedLogin = buildTrustedLoginChecker();
  const changed = [];
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
    // #3368 Copilot review round 2: computeExpectedVerdict's input is
    // title+body (labels are vendored metadata only, not currently
    // consumed by either evaluator) -- keying the skip decision on
    // bodySha256 alone missed a title-only edit, silently leaving the
    // snapshot evaluating a stale title against the current helpers.
    // Labels are still refreshed alongside a genuine change so the
    // vendored metadata doesn't drift independently of body/title.
    const titleChanged = issue.title !== existing.title;
    const labelsChanged = !labelsEqual(issue.labels, existing.labels);
    if (freshSha === existing.bodySha256 && !titleChanged && !labelsChanged) {
      continue;
    }
    const updated = {
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
      : `snapshot-issue-body-corpus --refresh — body/title/labels changed for ${changed.length} ${changed.length === 1 ? 'entry' : 'entries'} (run --update-expected before tests/issue-body-corpus.test.mts passes again if the body or title changed): ${changed.join(', ')}\n`,
  );
}
function runUpdateExpected() {
  const ids = existingEntryIds();
  for (const id of ids) {
    const existing = readEntry(id);
    const updated = {
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
    `snapshot-issue-body-corpus --update-expected — recomputed "expected" for ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}. GUARDRAIL: review the emitted git diff before committing -- this blesses whatever the current helpers emit.\n`,
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
  const add = values.add;
  const category = values.category;
  const note = values.note;
  const refresh = values.refresh;
  const updateExpected = values['update-expected'];
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
    runAdd(owner, repo, parseAddTokens(add), category, note);
  } else if (refresh) {
    const { owner, repo } = resolveCurrentGithubRepository();
    runRefresh(owner, repo);
  } else {
    runUpdateExpected();
  }
}
