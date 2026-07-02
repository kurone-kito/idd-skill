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

import { parseAutopilotSuitability } from './autopilot-suitability.mts';
import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
  isCliExecution,
} from './gh-exec.mts';
import { parseIsoDurationToMs } from './policy-helpers.mts';
import {
  resolveActiveClaim,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

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

if (isCliExecution(import.meta.url)) {
  runCli();
}

// ---------------------------------------------------------------------------
// Pure core (exported for tests)
// ---------------------------------------------------------------------------

/** One evaluated candidate issue and its overlap evidence. */
export interface OverlapCandidateResult {
  number: number;
  score: number | null;
  effectiveScore: number;
  candidateFiles: string[];
  highContentionTouched: string[];
  overlaps: OverlapHit[];
  overlapFlag: boolean;
}

/** One actively-claimed / open-PR issue that shares a high-contention file. */
export interface OverlapHit {
  number: number;
  reason: 'claim' | 'pr';
  files: string[];
}

/** Candidate issue fed to {@link analyzeSharedFileOverlap}. */
export interface OverlapCandidateInput {
  number: number;
  score?: number | null;
  candidateFiles: string[];
}

/** Concurrently-active issue (claimed or with an open PR) used for overlap. */
export interface ActiveIssueInput {
  number: number;
  reason: 'claim' | 'pr';
  candidateFiles: string[];
}

/** A candidate the soft tie-breaker can reorder. */
export interface RankableCandidate {
  number: number;
  effectiveScore: number;
  overlapFlag: boolean;
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
export function normalizeContentionPath(raw: unknown): string {
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
export function parseCandidateFiles(body: unknown): string[] {
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
  const files: string[] = [];

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
function extractStandaloneToken(itemBody: string): string | null {
  let text = itemBody.trim();
  text = text.split(/\s+(?:—|–|--)\s+/)[0];
  text = text.split(/\s+\(/)[0];
  const leading = text.split(/[\s,;]+/)[0] ?? '';
  const normalized = normalizeContentionPath(leading);
  return looksLikeStandalonePath(normalized) ? normalized : null;
}

/** A backtick-quoted token only needs a separator or extension. */
function looksLikePath(value: string): boolean {
  return value.length > 0 && !/\s/.test(value) && /[/.]/.test(value);
}

/**
 * An unquoted bullet token must look unambiguously like a file path: a final
 * extension, a glob, or a trailing directory slash. This rejects prose such
 * as "generated/mirrored" that merely contains a slash.
 */
function looksLikeStandalonePath(value: string): boolean {
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
export function resolveHighContentionFiles(options: {
  manifest: unknown;
  bundleIds?: string[];
  extraFiles?: string[];
}): Set<string> {
  const bundleIds = new Set(options.bundleIds ?? DEFAULT_BUNDLE_IDS);
  const extraFiles = options.extraFiles ?? DEFAULT_EXTRA_FILES;
  const result = new Set<string>();
  const bundles = (options.manifest as { bundleBudgets?: unknown } | null)
    ?.bundleBudgets;
  if (Array.isArray(bundles)) {
    for (const bundle of bundles) {
      const entry = bundle as { id?: unknown; files?: unknown } | null;
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
export function analyzeSharedFileOverlap(input: {
  candidates: OverlapCandidateInput[];
  activeIssues: ActiveIssueInput[];
  highContentionFiles: Iterable<string>;
  floor?: number;
  suitabilityEnabled?: boolean;
}): {
  candidates: OverlapCandidateResult[];
  recommendedOrder: number[];
  summary: {
    candidateCount: number;
    flaggedCount: number;
    activeIssueCount: number;
  };
} {
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

  const candidates: OverlapCandidateResult[] = input.candidates.map(
    (candidate) => {
      const score =
        typeof candidate.score === 'number' ? candidate.score : null;
      const highContentionTouched = intersect(
        candidate.candidateFiles,
        highContention,
      );
      const touchedSet = new Set(highContentionTouched);
      const overlaps: OverlapHit[] = [];
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
    },
  );

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
export function applyOverlapTieBreaker<T extends RankableCandidate>(
  ranked: T[],
): T[] {
  const out: T[] = [];
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

function intersect(files: string[], highContention: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    if (highContention.has(file) && !seen.has(file)) {
      seen.add(file);
      result.push(file);
    }
  }
  return result.sort();
}

// ---------------------------------------------------------------------------
// CLI glue (not unit-tested; the pure core above is)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  candidates: number[];
  owner: string;
  repo: string;
  policy: string;
  manifest: string;
  bundles: string[] | null;
  checkOverlap: boolean;
  now: string;
  help: boolean;
}

function runCli(): void {
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

  const candidates: OverlapCandidateInput[] = args.candidates.map((number) => {
    const issue = fetchIssue(repoRef, number);
    return {
      number,
      score: parseAutopilotSuitability(issue.body, policy.markerPrefix),
      candidateFiles: parseCandidateFiles(issue.body),
    };
  });

  let activeIssues: ActiveIssueInput[] = [];
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
function discoverActiveIssues(options: {
  repoRef: string;
  trustedActors: string[];
  staleAgeMs: number;
  now: string;
}): ActiveIssueInput[] {
  const { repoRef, trustedActors, staleAgeMs, now } = options;
  const active = new Map<number, ActiveIssueInput>();

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
  const isTrusted = (login: string) =>
    trustedActors.some((actor) => actor.toLowerCase() === login.toLowerCase());
  const isStale = (activeCreatedAt: string, nextCreatedAt: string): boolean =>
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
function fetchActiveClaimBranchNumbers(repoRef: string): number[] {
  const numbers = new Set<number>();
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

interface FetchedIssue {
  body: string;
}

function fetchIssue(repoRef: string, number: number): FetchedIssue {
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
export function toClaimComment(raw: unknown): {
  body: string;
  createdAt: string;
  author: { login: string };
} {
  const entry = raw as {
    body?: unknown;
    created_at?: unknown;
    user?: { login?: unknown } | null;
  };
  return {
    body: String(entry.body ?? ''),
    createdAt: String(entry.created_at ?? ''),
    author: { login: String(entry.user?.login ?? '') },
  };
}

function fetchIssueComments(
  repoRef: string,
  number: number,
): { body: string; createdAt: string; author: { login: string } }[] {
  const comments: ReturnType<typeof toClaimComment>[] = [];
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

function fetchOpenPrLinkedIssues(repoRef: string): number[] {
  const numbers = new Set<number>();
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
    const refs = (pr as { closingIssuesReferences?: unknown })
      .closingIssuesReferences;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const value = Number.parseInt(
          String((ref as { number?: unknown }).number ?? ''),
          10,
        );
        if (Number.isInteger(value) && value > 0) {
          numbers.add(value);
        }
      }
    }
  }
  return [...numbers];
}

function loadManifest(manifestPath: string): unknown {
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

function loadPolicy(policyPath: string): {
  markerPrefix: string;
  trustedMarkerActors: string[];
  autopilotSuitabilityFloor: number;
  autopilotSuitabilityEnabled: boolean;
  claimStaleAgeMs: number;
} {
  const explicit = policyPath.length > 0;
  const targetPath = explicit
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  let config: {
    markerPrefix?: unknown;
    trustedMarkerActors?: unknown;
    autopilotSuitability?: { floor?: unknown; enabled?: unknown } | null;
    claimTiming?: { staleAge?: unknown } | null;
  } | null = null;
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

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    candidates: [],
    owner: '',
    repo: '',
    policy: '',
    manifest: DEFAULT_MANIFEST_PATH,
    bundles: null,
    checkOverlap: false,
    now: '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--candidate') {
      parsed.candidates.push(parsePositiveInt(value, '--candidate'));
      index += 1;
      continue;
    }
    if (token === '--candidates') {
      for (const part of String(value ?? '').split(',')) {
        const trimmed = part.trim();
        if (trimmed) {
          parsed.candidates.push(parsePositiveInt(trimmed, '--candidates'));
        }
      }
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--policy') {
      parsed.policy = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--manifest') {
      parsed.manifest = value ?? DEFAULT_MANIFEST_PATH;
      index += 1;
      continue;
    }
    if (token === '--bundles') {
      parsed.bundles = String(value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (token === '--check-overlap') {
      parsed.checkOverlap = true;
      continue;
    }
    if (token === '--now') {
      parsed.now = value ?? '';
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

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value ?? ''}`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/discover-shared-file-overlap.mjs --candidate <number> [--candidate <number> ...] [--candidates <n1,n2>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--manifest <path>] [--bundles <id1,id2>] [--check-overlap] [--now <ISO8601>]

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

function ghJson(args: string[]): unknown[] {
  const parsed = JSON.parse(runGh(args).trim() || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
