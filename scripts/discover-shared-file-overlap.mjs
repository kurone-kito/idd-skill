#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-shared-file-overlap.mts
//
// The scripts/discover-shared-file-overlap.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Read-only discovery-time evidence helper (#1019): for a set of candidate
// issues, report the high-contention shared files each would touch (parsed
// from its `## Candidate files` section) and whether any of those files
// overlap an actively-claimed or open-PR issue's candidate files. It also
// emits a soft de-prioritization order for A4 Step 2. It is the
// file-contention companion to the #1008 `--with-claim-state` claim-eligibility
// annotation. Evidence-only: it claims nothing and mutates no state.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAutopilotSuitability } from './autopilot-suitability.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mjs';
import { parseIsoDurationToMs } from './policy-helpers.mjs';
import {
  resolveActiveClaim,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
const DEFAULT_MANIFEST_PATH = 'audit/sync-manifest.json';
/** F-phase bundles whose member instruction files concentrate concurrent edits. */
const DEFAULT_BUNDLE_IDS = ['bundle-review', 'bundle-merge'];
/** Append-mostly shared surfaces that are not bundle members. */
const DEFAULT_EXTRA_FILES = [DEFAULT_MANIFEST_PATH];
const DEFAULT_AUTOPILOT_SUITABILITY_FLOOR = 3;
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound on the best-effort open-PR scan (a `gh pr list --limit`). */
const OPEN_PR_SCAN_LIMIT = 500;
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `candidate:`): tests/flag-name-matrix.test.mts scans this file's
// *compiled* .mjs source text for quoted flag literals such as the
// --candidate spec key below. See cli-args.mts's module header for the
// full invariant. (This comment deliberately avoids writing that key
// inside matching quote marks, so it cannot itself satisfy the scan if
// the real key is ever renamed -- see #1446's PR description for why
// that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const DISCOVER_SHARED_FILE_OVERLAP_FLAG_SPEC = {
  '--candidate': { type: 'string', multiple: true },
  '--candidates': { type: 'string', multiple: true },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
  '--manifest': { type: 'string', default: DEFAULT_MANIFEST_PATH },
  '--bundles': { type: 'string' },
  '--check-overlap': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  runCli();
}
/**
 * Normalize a candidate-file path to its contention key. Strips surrounding
 * backticks and a leading `./`, and collapses a `idd-template/<x>` source onto
 * its generated `<x>` mirror so the two count as one contention surface. An
 * instruction file is keyed by its basename (`idd-merge.instructions.md`):
 * those basenames are unique repo-wide and issues cite them in several forms
 * (full source path, mirror path, or bare), so basename keying makes every
 * form compare equal.
 */
export function normalizeContentionPath(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/^`+/, '').replace(/`+$/, '').trim();
  value = value.replace(/^\.\//, '');
  value = value.replace(/^idd-template\//, '');
  const instruction = value.match(/(?:^|\/)([^/]+\.instructions\.md)$/);
  if (instruction) {
    return instruction[1];
  }
  return value;
}
/**
 * Parse the `## Candidate files` section of an issue body into a
 * de-duplicated, normalized path list. The section is advisory, so parsing is
 * lenient: it extracts every backtick-quoted path in the section — including
 * the continuation lines of a multi-line bullet — plus the leading path-like
 * token of any bullet that has no backticks at all. Returns `[]` when the
 * section is absent.
 */
export function parseCandidateFiles(body) {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (!heading) {
      continue;
    }
    const title = heading[2].replace(/[*_`]/g, '').trim().toLowerCase();
    if (start === -1) {
      if (/^candidate files\b/.test(title)) {
        start = index + 1;
      }
      continue;
    }
    end = index;
    break;
  }
  if (start === -1) {
    return [];
  }
  const section = lines.slice(start, end);
  const sectionText = section.join('\n');
  const files = [];
  // Every backtick-quoted path in the section, regardless of line wrapping.
  for (const match of sectionText.matchAll(/`([^`]+)`/g)) {
    const normalized = normalizeContentionPath(match[1]);
    if (looksLikePath(normalized)) {
      files.push(normalized);
    }
  }
  // Bullets that quote no path fall back to a strict leading-token scan.
  for (const line of section) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item || /`[^`]+`/.test(item[1])) {
      continue;
    }
    const token = extractStandaloneToken(item[1]);
    if (token) {
      files.push(token);
    }
  }
  return [...new Set(files)];
}
/** Extract a strict leading path token from a bullet that quotes no path. */
function extractStandaloneToken(itemBody) {
  let text = itemBody.trim();
  text = text.split(/\s+(?:—|–|--)\s+/)[0];
  text = text.split(/\s+\(/)[0];
  const leading = text.split(/[\s,;]+/)[0] ?? '';
  const normalized = normalizeContentionPath(leading);
  return looksLikeStandalonePath(normalized) ? normalized : null;
}
/** A backtick-quoted token only needs a separator or extension. */
function looksLikePath(value) {
  return value.length > 0 && !/\s/.test(value) && /[/.]/.test(value);
}
/**
 * An unquoted bullet token must look unambiguously like a file path: a final
 * extension, a glob, or a trailing directory slash. This rejects prose such
 * as "generated/mirrored" that merely contains a slash.
 */
function looksLikeStandalonePath(value) {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  return (
    /\.[a-z0-9]+$/i.test(value) || value.includes('*') || value.endsWith('/')
  );
}
/**
 * Resolve the high-contention shared-file set from the sync manifest: the
 * union of the named bundles' member files plus any extra append-mostly
 * surfaces. Paths are normalized so a source and its mirror collapse together.
 */
export function resolveHighContentionFiles(options) {
  const bundleIds = new Set(options.bundleIds ?? DEFAULT_BUNDLE_IDS);
  const extraFiles = options.extraFiles ?? DEFAULT_EXTRA_FILES;
  const result = new Set();
  const bundles = options.manifest?.bundleBudgets;
  if (Array.isArray(bundles)) {
    for (const bundle of bundles) {
      const entry = bundle;
      if (!entry || !bundleIds.has(String(entry.id))) {
        continue;
      }
      if (Array.isArray(entry.files)) {
        for (const file of entry.files) {
          result.add(normalizeContentionPath(file));
        }
      }
    }
  }
  for (const file of extraFiles) {
    result.add(normalizeContentionPath(file));
  }
  return result;
}
/**
 * Compute per-candidate high-contention overlap evidence against the active
 * set, plus a soft de-prioritization order for A4 Step 2.
 */
export function analyzeSharedFileOverlap(input) {
  const floor = input.floor ?? DEFAULT_AUTOPILOT_SUITABILITY_FLOOR;
  // When the autopilot-suitability kill switch is off (A4 Step 2 ignores the
  // score and selects by lowest issue number), equalize every effectiveScore so
  // the recommended order is driven by overlap then issue number, not score.
  const suitabilityEnabled = input.suitabilityEnabled !== false;
  const highContention = new Set(input.highContentionFiles);
  const activeTouched = input.activeIssues.map((active) => ({
    number: active.number,
    reason: active.reason,
    files: intersect(active.candidateFiles, highContention),
  }));
  const candidates = input.candidates.map((candidate) => {
    const score = typeof candidate.score === 'number' ? candidate.score : null;
    const highContentionTouched = intersect(
      candidate.candidateFiles,
      highContention,
    );
    const touchedSet = new Set(highContentionTouched);
    const overlaps = [];
    for (const active of activeTouched) {
      if (active.number === candidate.number) {
        continue;
      }
      const shared = active.files.filter((file) => touchedSet.has(file));
      if (shared.length > 0) {
        overlaps.push({
          number: active.number,
          reason: active.reason,
          files: shared.slice().sort(),
        });
      }
    }
    overlaps.sort((left, right) => left.number - right.number);
    return {
      number: candidate.number,
      score,
      effectiveScore: suitabilityEnabled ? (score ?? floor) : 0,
      candidateFiles: candidate.candidateFiles,
      highContentionTouched,
      overlaps,
      overlapFlag: overlaps.length > 0,
    };
  });
  const preSorted = candidates
    .slice()
    .sort(
      (left, right) =>
        right.effectiveScore - left.effectiveScore ||
        left.number - right.number,
    );
  const recommendedOrder = applyOverlapTieBreaker(preSorted).map(
    (candidate) => candidate.number,
  );
  return {
    candidates,
    recommendedOrder,
    summary: {
      candidateCount: candidates.length,
      flaggedCount: candidates.filter((candidate) => candidate.overlapFlag)
        .length,
      activeIssueCount: input.activeIssues.length,
    },
  };
}
/**
 * Soft de-prioritization tie-breaker for A4 Step 2. The input must already be
 * ordered by the existing rules (suitability score descending, then issue
 * number ascending / desync). Within each equal-`effectiveScore` band this
 * stably moves overlap-flagged candidates after the non-overlapping ones; it
 * never crosses a score band and never drops a candidate, so a colliding
 * candidate that is the only ready work keeps its position.
 */
export function applyOverlapTieBreaker(ranked) {
  const out = [];
  for (let index = 0; index < ranked.length; ) {
    let end = index;
    while (
      end < ranked.length &&
      ranked[end].effectiveScore === ranked[index].effectiveScore
    ) {
      end += 1;
    }
    const band = ranked.slice(index, end);
    for (const candidate of band) {
      if (!candidate.overlapFlag) {
        out.push(candidate);
      }
    }
    for (const candidate of band) {
      if (candidate.overlapFlag) {
        out.push(candidate);
      }
    }
    index = end;
  }
  return out;
}
function intersect(files, highContention) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    if (highContention.has(file) && !seen.has(file)) {
      seen.add(file);
      result.push(file);
    }
  }
  return result.sort();
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.candidates.length === 0) {
    throw new Error('at least one --candidate <number> is required');
  }
  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;
  const policy = loadPolicy(args.policy);
  const now = args.now || new Date().toISOString();
  const manifest = loadManifest(args.manifest);
  const highContentionFiles = resolveHighContentionFiles({
    manifest,
    bundleIds: args.bundles ?? DEFAULT_BUNDLE_IDS,
    // Track the manifest actually in use so a custom --manifest is the file
    // reported (and matched) as high-contention, not the hard-coded default.
    extraFiles: [args.manifest],
  });
  const candidates = args.candidates.map((number) => {
    const issue = fetchIssue(repoRef, number);
    return {
      number,
      score: parseAutopilotSuitability(issue.body, policy.markerPrefix),
      candidateFiles: parseCandidateFiles(issue.body),
    };
  });
  let activeIssues = [];
  if (args.checkOverlap) {
    activeIssues = discoverActiveIssues({
      repoRef,
      trustedActors: policy.trustedMarkerActors,
      staleAgeMs: policy.claimStaleAgeMs,
      now,
    });
  }
  const analysis = analyzeSharedFileOverlap({
    candidates,
    activeIssues,
    highContentionFiles,
    floor: policy.autopilotSuitabilityFloor,
    suitabilityEnabled: policy.autopilotSuitabilityEnabled,
  });
  const output = {
    repository: { owner, repo },
    checkedOverlap: args.checkOverlap,
    highContentionFiles: [...highContentionFiles].sort(),
    ...analysis,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
/**
 * Discover the concurrently-active set: every issue closed by an open PR
 * (repo-wide), plus candidate issues that already carry a non-stale claim.
 * Active-by-claim covers every issue with a remote `issue/<n>-*` branch (every
 * IDD claim creates one once pushed), resolved with the standard `claimed-by`
 * claim-state rules — not just the candidate set — so a claim held by another
 * session is detected even though it is outside the unclaimed candidates being
 * ranked. A claim whose branch is not yet pushed is picked up once it appears
 * remotely. Active-by-PR is a best-effort scan of open PRs (bounded by the
 * PR-list page cap). Both stay bounded — no repo-wide comment scan — which is
 * the fetch cost `--check-overlap` gates; the overlap signal is an advisory A4
 * Step 2 tie-breaker, so best-effort coverage is acceptable. Edge cases the
 * advisory signal does not specially resolve: legacy claim-id-less markers and
 * forced-handoff-successor adoption (the default `resolveActiveClaim` path).
 */
function discoverActiveIssues(options) {
  const { repoRef, trustedActors, staleAgeMs, now } = options;
  const active = new Map();
  // Active-by-PR: issues closed by an open PR (best-effort across open PRs,
  // bounded by the PR-list page cap).
  for (const number of fetchOpenPrLinkedIssues(repoRef)) {
    if (!active.has(number)) {
      const body = fetchIssue(repoRef, number).body;
      active.set(number, {
        number,
        reason: 'pr',
        candidateFiles: parseCandidateFiles(body),
      });
    }
  }
  // Active-by-claim: scan the issues that have a *remote* `issue/<n>-*` branch
  // — every IDD claim creates one, published once its branch is pushed — so a
  // non-stale claim held by another session is detected even though it is
  // outside the (unclaimed) candidate set the ranking operates on. Bounded by
  // the number of active issue branches, not a repo-wide comment scan; a claim
  // whose branch is not yet pushed is picked up once it appears remotely. The
  // configured claim stale age drives both the supersession check inside
  // resolveActiveClaim and the non-stale filter here.
  const isTrusted = (login) =>
    trustedActors.some((actor) => actor.toLowerCase() === login.toLowerCase());
  const isStale = (activeCreatedAt, nextCreatedAt) =>
    new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >=
    staleAgeMs;
  for (const number of fetchActiveClaimBranchNumbers(repoRef)) {
    if (active.has(number)) {
      continue;
    }
    const comments = fetchIssueComments(repoRef, number);
    const claim = resolveActiveClaim(comments, {
      isTrustedAuthor: isTrusted,
      isStale,
    });
    if (claim && !isStale(claim.createdAt, now)) {
      const body = fetchIssue(repoRef, number).body;
      active.set(number, {
        number,
        reason: 'claim',
        candidateFiles: parseCandidateFiles(body),
      });
    }
  }
  return [...active.values()].sort((left, right) => left.number - right.number);
}
/** Issue numbers that currently have an `issue/<n>-*` branch on the remote. */
function fetchActiveClaimBranchNumbers(repoRef) {
  const numbers = new Set();
  // `--paginate` follows the Link headers to the end, so a repo with many
  // issue branches does not silently drop branches past the first page.
  const output = ghText(
    [
      'api',
      '--paginate',
      `repos/${repoRef}/git/matching-refs/heads/issue/`,
      '--jq',
      '.[].ref',
    ],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
  for (const line of output.split('\n')) {
    const match = line.match(/^refs\/heads\/issue\/(\d+)-/);
    if (match) {
      numbers.add(Number.parseInt(match[1], 10));
    }
  }
  return [...numbers];
}
function fetchIssue(repoRef, number) {
  // Fail closed: let a fetch failure surface rather than returning an empty
  // body, which would silently suppress this issue's candidate files and emit
  // a false "no overlap" result.
  const body = ghText(
    [
      'issue',
      'view',
      String(number),
      '--repo',
      repoRef,
      '--json',
      'body',
      '--jq',
      '.body',
    ],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
  return { body };
}
/**
 * Map a REST issue-comment payload to the `CommentLike` shape
 * `resolveActiveClaim` consumes. `resolveActiveClaim` reads the author from
 * `author.login`, but the REST comments API returns it under `user.login`, so
 * the login must be mapped across here (matching `discover-roadmap-graph`'s
 * comment loader). Emitting `user` would leave the author empty and silently
 * disable claim detection.
 */
export function toClaimComment(raw) {
  const entry = raw;
  return {
    body: String(entry.body ?? ''),
    createdAt: String(entry.created_at ?? ''),
    author: { login: String(entry.user?.login ?? '') },
  };
}
function fetchIssueComments(repoRef, number) {
  const comments = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = ghJson([
      'api',
      `repos/${repoRef}/issues/${number}/comments?per_page=${pageSize}&page=${page}`,
    ]);
    for (const raw of rawPage) {
      comments.push(toClaimComment(raw));
    }
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return comments;
}
function fetchOpenPrLinkedIssues(repoRef) {
  const numbers = new Set();
  // Best-effort: `gh pr list` caps at --limit, so a repo with more open PRs
  // than the cap drops the overflow. Acceptable for an advisory signal.
  const prs = ghJson([
    'pr',
    'list',
    '--repo',
    repoRef,
    '--state',
    'open',
    '--limit',
    String(OPEN_PR_SCAN_LIMIT),
    '--json',
    'closingIssuesReferences',
  ]);
  for (const pr of prs) {
    const refs = pr.closingIssuesReferences;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const value = Number.parseInt(String(ref.number ?? ''), 10);
        if (Number.isInteger(value) && value > 0) {
          numbers.add(value);
        }
      }
    }
  }
  return [...numbers];
}
function loadManifest(manifestPath) {
  const targetPath = resolve(
    process.cwd(),
    manifestPath || DEFAULT_MANIFEST_PATH,
  );
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (error) {
    // Fail closed: an empty manifest would yield an empty high-contention set,
    // making every candidate look non-overlapping. Surface the load failure.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to load sync manifest at ${targetPath}: ${message}`,
    );
  }
}
function loadPolicy(policyPath) {
  const explicit = policyPath.length > 0;
  const targetPath = explicit
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  let config = null;
  try {
    config = JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (error) {
    // Fail closed on an explicit --policy that cannot be loaded: silently
    // using defaults would drop custom trusted actors / claim timing and let
    // active claims disappear. An absent default config still falls back.
    if (explicit) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to load policy at ${targetPath}: ${message}`);
    }
    config = null;
  }
  const markerPrefix =
    typeof config?.markerPrefix === 'string' && config.markerPrefix.length > 0
      ? config.markerPrefix
      : DEFAULT_MARKER_PREFIX;
  const trusted = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config,
  });
  const floorValue = config?.autopilotSuitability?.floor;
  const autopilotSuitabilityFloor =
    typeof floorValue === 'number' && floorValue >= 1 && floorValue <= 5
      ? floorValue
      : DEFAULT_AUTOPILOT_SUITABILITY_FLOOR;
  const autopilotSuitabilityEnabled =
    config?.autopilotSuitability?.enabled !== false;
  const claimStaleAgeMs =
    parseIsoDurationToMs(config?.claimTiming?.staleAge) ??
    DEFAULT_CLAIM_STALE_AGE_MS;
  return {
    markerPrefix,
    trustedMarkerActors: trusted.actors,
    autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled,
    claimStaleAgeMs,
  };
}
/**
 * Walk `argv` and return every occurrence of the given long-flag literals
 * (e.g. `--candidate`, `--candidates`) in argv order, tagged with which
 * flag matched and its literal string value. `parseCliArgs` has already
 * thrown on anything malformed (a missing value, a flag-shaped value, an
 * unknown flag) by the time this runs, so this is a pure
 * order-reconstruction pass over already-validated input, not a second
 * parse/validation pass. Covers both the `--flag value` and `--flag=value`
 * forms Node's `util.parseArgs` itself accepts for a long option (#1450
 * review follow-up: grouping every `--candidate` occurrence before every
 * `--candidates` occurrence silently reordered interleaved input, e.g.
 * `--candidates 1,2 --candidate 3`).
 */
function collectOrderedOccurrences(argv, flagNames) {
  const occurrences = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const bareFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!flagNames.includes(bareFlag)) {
      continue;
    }
    const value =
      equalsIndex === -1 ? argv[index + 1] : token.slice(equalsIndex + 1);
    occurrences.push({ flag: bareFlag, value });
  }
  return occurrences;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    DISCOVER_SHARED_FILE_OVERLAP_FLAG_SPEC,
  );
  // parsePositiveInt keeps its existing throw-on-invalid contract and
  // message shape unchanged; only the flag-syntax parsing around it (a
  // missing/flag-shaped value, an unknown flag) is now strict. Every
  // --candidate/--candidates occurrence is now accumulated in argv order
  // (not just the last, and not grouped by flag name).
  const candidates = collectOrderedOccurrences(argv, [
    '--candidate',
    '--candidates',
  ]).flatMap((occurrence) => {
    if (occurrence.flag === '--candidate') {
      return [parsePositiveInt(occurrence.value, '--candidate')];
    }
    return occurrence.value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((trimmed) => parsePositiveInt(trimmed, '--candidates'));
  });
  return {
    candidates,
    owner: values.owner,
    repo: values.repo,
    policy: values.policy,
    manifest: values.manifest,
    bundles:
      values.bundles === undefined
        ? null
        : String(values.bundles)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    checkOverlap: values['check-overlap'],
    now: values.now,
    help,
  };
}
function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value ?? ''}`);
  }
  return parsed;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-shared-file-overlap.mjs --candidate <number> [--candidate <number> ...] [--candidates <n1,n2>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--manifest <path>] [--bundles <id1,id2>] [--check-overlap] [--now <ISO8601>] [--help]

Reports, per candidate, the high-contention shared files it would touch (from
its '## Candidate files' section) and — with --check-overlap — whether any
overlap an actively-claimed or open-PR issue. recommendedOrder applies the soft
A4 Step 2 de-prioritization tie-breaker (score desc, then non-overlapping
first within a score band, then issue number); it does NOT apply
discover.selectionDesync — the agent layers the overlap nudge after its own
desync pick. Evidence-only: never a hard gate.

Without --check-overlap no active-set discovery runs (no extra GitHub API
cost); each candidate's high-contention files are still reported.

--check-overlap coverage (best-effort, no repo-wide comment scan): open-PR
overlap scans open PRs (bounded by the gh pr list page cap). Active-claim
overlap scans the issues that have a remote issue/<n>-* branch (every IDD claim
creates one once pushed), paginated to the end and resolved with the configured
claim stale age, so a non-stale claim held by another session is detected even
when it is outside the unclaimed candidate set being ranked. A claim whose
branch is not yet pushed is picked up once it appears remotely.
`);
}
function ghJson(args) {
  const parsed = JSON.parse(runGh(args).trim() || '[]');
  return Array.isArray(parsed) ? parsed : [];
}
function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
