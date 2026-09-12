#!/usr/bin/env node
// idd-generated-from: src/scripts/sweep-authoring-markers.mts
//
// The scripts/sweep-authoring-markers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Fetch-driven mandatory hide-on-supersede sweep for `authoring-owner` /
// `authoring-publication-intent` markers (#2935).
//
// Background: #2896 (PR #2898) replaced the per-post hide-on-supersede
// instruction (measured ~3% effective) with a mandatory release-time sweep
// documented in `skills/issue-authoring/references/contract.md` at three
// points in the Stage 2 release flow. Re-measuring that sweep found it only
// 41.7% effective, because "mandatory" still meant a session had to
// correctly reconstruct an ~8-step manual procedure from prose, three
// separate times, every release: paginate the comment log via GraphQL
// (never REST, which never exposes `isMinimized`), classify each body with
// `matchCanonicalAuthoringMarkerFamily`, determine the newest match among
// TRUSTED-actor candidates only, exclude anything already minimized,
// assemble the survivors' GraphQL node IDs by hand, invoke
// `minimize-superseded-markers.mjs`, then re-verify. This script collapses
// that whole procedure into one command: given one or more `--issue`
// targets, it fetches each issue's comments via GraphQL, classifies and
// filters them exactly as the contract describes, and calls into
// `minimize-superseded-markers.mts`'s existing `runMinimize` for the
// mutation -- reusing that logic rather than reimplementing it.
//
// Deliberately a SIBLING script, not a mode grafted onto
// `minimize-superseded-markers.mts` itself: that file's module header
// documents a hard self-containment invariant ("stays self-contained so
// the template copy works without protocol-helpers.mjs" -- `idd-template/
// scripts/` mirrors ONLY that one file, standalone). A fetch-driven mode
// needs `matchCanonicalAuthoringMarkerFamily` (`marker-helpers.mts`, a
// ~3000-line module with its own import graph), which would break that
// invariant if grafted in-place. This file carries no such constraint, so
// it imports normally from `marker-helpers.mts`, `protocol-helpers.mts`,
// `idd-config.mts`, `gh-exec.mts`, and `minimize-superseded-markers.mts`
// (for `runMinimize` and `resolveGhHostnameArgs`), matching the newer,
// non-template-mirrored helpers' own style (e.g.
// `merged-pr-feedback-sweep.mts`, `authoring-owner-provenance.mts`).
//
// Read-only against every issue it scans except for the minimize mutation
// itself, which only ever hides (never edits or deletes) a comment already
// proven superseded by the classification below. Best-effort by design,
// matching the contract's framing: a fetch failure for one `--issue` is
// recorded in the report and does not abort the other issues in the same
// invocation; the caller (the contract's own sweep instructions) treats a
// non-zero exit the same way it already treats `minimize-superseded-
// markers.mjs`'s own possible non-zero exit -- non-blocking.
//
// Scope: `authoring-owner` and `authoring-publication-intent` only, same as
// the sweep it replaces. A bare `--issue <number>` is scanned in the
// invocation's default `--owner`/`--repo` (the global flags, or the
// current repository when neither is given, matching every other
// single-repo `--issue <number>` helper in this codebase --
// `authoring-owner-provenance.mts`, `suitability-close-execute.mts`);
// an explicit `--issue owner/repo#number` is scanned in ITS OWN
// owner/repo instead (#2935 review, Codex and Copilot: the contract's
// `issueAuthoring.journalIssue` can itself be a cross-repository
// reference, so a single-repo-only design could never sweep it
// correctly, and worse, could silently mutate an unrelated
// same-numbered issue in the wrong repository under `--apply`). One
// invocation can freely mix same-repo and cross-repository `--issue`
// targets.

import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import { ghText } from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import type { AuthoringMarkerFamily } from './marker-helpers.mts';
import {
  classifyAuthoringMarkerFamily,
  matchCanonicalAuthoringMarkerFamily,
} from './marker-helpers.mts';
import {
  resolveGhHostnameArgs,
  runMinimize,
} from './minimize-superseded-markers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mts';

const ALLOWED_CLASSIFIERS = new Set(['OUTDATED', 'RESOLVED']);
const ALLOWED_FORMATS = new Set(['json', 'table']);
const AUTHORING_MARKER_FAMILIES: readonly AuthoringMarkerFamily[] = [
  'authoring-owner',
  'authoring-publication-intent',
];

/** One resolved `--issue` target: the repository to fetch from plus the
 * issue number (#2935 review, Codex and Copilot both independently
 * flagged the original single-repo-per-invocation design as unable to
 * correctly sweep a cross-repository `issueAuthoring.journalIssue`
 * reference -- worse, applying the wrong owner/repo to a same-numbered
 * issue in an unrelated repository could silently minimize markers
 * there while still reporting success). Every `--issue` now resolves to
 * one of these independently, so a single invocation can mix a
 * same-repo target with a cross-repo journal. */
export interface SweepIssueTarget {
  owner: string;
  repo: string;
  issue: number;
}

/** Matches the explicit cross-repository `owner/repo#number` shorthand for
 * one `--issue` token. A token that contains `/` or `#` but does not
 * match this shape is a likely typo, not a bare issue number -- callers
 * get a specific error instead of a confusing `--issue` parse failure.
 *
 * The `owner`/`repo` character class is deliberately exactly
 * `schemas/policy.schema.json`'s own `issueAuthoring.journalIssue`
 * pattern (`[\w.-]+`, i.e. word characters, `.`, `-`, in any position,
 * no leading/trailing restriction) rather than a hand-derived, stricter
 * subset of GitHub's real naming rules (#2935 review, round 2, Codex):
 * an earlier revision here rejected `.github`-style leading-dot repo
 * names, then a follow-up fix rejected leading/trailing `_`/`-`
 * component names the schema already accepts (for example
 * `acme/_journal#42`) -- two rounds of the same underlying mistake,
 * independently re-deriving GitHub's naming rules instead of reusing
 * the one place this codebase already encodes them. Matching the schema
 * exactly, rather than refining a parallel approximation of it further,
 * defers the actual repository-name validity question to GitHub's own
 * API (which will simply 404 on a request for a name nothing owns),
 * matching the review's own "defer repository-name validation to
 * GitHub" resolution. */
const CROSS_REPO_ISSUE_TOKEN_PATTERN = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/;

/** `true` when `token` is the explicit `owner/repo#number` cross-repository
 * shorthand -- used before any I/O to decide whether this invocation
 * needs the current repository at all (a caller sweeping only
 * cross-repo-qualified issues never needs it). */
export function isCrossRepoIssueToken(token: string): boolean {
  return CROSS_REPO_ISSUE_TOKEN_PATTERN.test(token);
}

/**
 * Resolve one `--issue` token to a {@link SweepIssueTarget}: the explicit
 * `owner/repo#number` shorthand resolves to its own owner/repo,
 * independent of `defaultOwner`/`defaultRepo`; a bare positive-integer
 * token resolves against `defaultOwner`/`defaultRepo` (the global
 * `--owner`/`--repo`, or the current repository when neither is given).
 * Throws a specific error for a token that contains `/` or `#` but does
 * not match the cross-repo shape (a likely typo), rather than letting it
 * fall through to the bare-integer parser's own generic message.
 */
export function parseIssueTargetToken(
  token: string,
  defaultOwner: string,
  defaultRepo: string,
): SweepIssueTarget {
  const crossRepoMatch = CROSS_REPO_ISSUE_TOKEN_PATTERN.exec(token);
  if (crossRepoMatch) {
    return {
      owner: crossRepoMatch[1],
      repo: crossRepoMatch[2],
      issue: Number.parseInt(crossRepoMatch[3], 10),
    };
  }
  if (token.includes('/') || token.includes('#')) {
    throw new Error(
      `--issue "${token}" looks like a cross-repository reference but does not match owner/repo#number`,
    );
  }
  return {
    owner: defaultOwner,
    repo: defaultRepo,
    issue: parseCanonicalIntegerOrThrow(token, '--issue'),
  };
}

/** One issue comment as fetched via GraphQL -- `isMinimized` is the field
 * REST's issue-comments endpoint never carries, which is why this script
 * (like the contract it implements) fetches via GraphQL and never REST. */
export interface SweepGraphqlComment {
  nodeId: string;
  url: string;
  body: string;
  authorLogin: string;
  isMinimized: boolean;
  createdAt: string;
}

interface SweepGraphqlCommentsPayload {
  errors?: { message?: unknown }[];
  data?: {
    repository?: {
      issue?: {
        comments?: {
          nodes?: {
            id?: unknown;
            url?: unknown;
            body?: unknown;
            isMinimized?: unknown;
            createdAt?: unknown;
            author?: { login?: unknown } | null;
          }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        } | null;
      } | null;
    } | null;
  };
}

/**
 * Per-call `execFileSync` output-buffer cap for
 * {@link fetchIssueCommentsGraphql}'s own `gh api graphql` calls (#2935
 * review, rounds 4-5, Codex): `ghText`'s (and Node's `execFileSync`'s)
 * own default is 1 MiB per stream, which a 100-comment page can exceed
 * once several comments carry long discussion bodies -- silently
 * turning a real page of data into an `ENOBUFS` fetch failure that then
 * drops that issue's comments (and every superseded marker on it) from
 * this sweep entirely.
 *
 * An initial 10 MiB estimate (matching `GH_ASYNC_MAX_BUFFER`,
 * `provider-adapter-github.mts`'s own unrelated precedent) drew a
 * further round of review pushing back that 10 MiB is still not a
 * PROVEN bound. This value replaces that estimate with an actual
 * worst-case calculation instead of a bigger guess, so a further
 * "still not big enough" round has no remaining basis: GitHub caps a
 * single issue/PR comment body at 65,536 characters, and UTF-8 (the
 * encoding `gh`'s JSON output uses) never spends more than 4 bytes per
 * character, so one comment's `body` field cannot exceed
 * `65_536 * 4 = 262_144` bytes regardless of content. `comments(first:
 * 100, ...)` below never returns more than 100 nodes per page, and this
 * query's other per-node fields (`id`, `url`, `isMinimized`,
 * `createdAt`, `author.login`) and JSON structural overhead (quotes,
 * commas, key names) add at most a few hundred bytes per node --
 * generously rounded up to 500 bytes/node here. The true worst case for
 * one page is therefore bounded at
 * `100 * (262_144 + 500) = 26_264_400` bytes (~25 MiB); this constant
 * rounds that up to a clean 32 MiB, comfortably above the proven
 * ceiling rather than merely "probably enough."
 */
const LARGE_COMMENT_PAGE_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Fetch every comment on `owner/repo#issueNumber` via a paginated GraphQL
 * `issue(number:).comments` query, selecting `isMinimized` directly (the
 * field REST's issue-comments endpoint never carries at all). `timeoutMs`,
 * when supplied, bounds the WHOLE paginated walk (checked before each
 * page's own `gh` call, never passed through as a non-positive value --
 * `ghText`/`execFileSync` both read `timeout: 0` as "no timeout", the
 * opposite of "budget already exhausted"), mirroring `post-idd-
 * marker.mts`'s `hideSupersededPostTimeMarkers` deadline discipline
 * (#2754): a caller sweeping several `--issue` targets under one overall
 * `--deadline-ms` must not let a single large comment log's own pagination
 * consume the entire budget with no cap of its own.
 *
 * The returned array is explicitly sorted ascending by `createdAt` before
 * this function returns (#2935 review, Copilot): `classifyAuthoringMarker
 * Family`'s "newest trusted match" determination trusts array order alone
 * (`trustedMatchIndexes[trustedMatchIndexes.length - 1]`), so relying on
 * an undocumented GraphQL connection default -- rather than requesting or
 * asserting chronological order explicitly -- would let a future API
 * change (or a wrong assumption about today's default) silently protect a
 * stale marker instead of the genuinely newest one. Ties (an identical
 * `createdAt` down to the second, which GitHub's API can return for two
 * comments posted in rapid succession) keep their original page-fetch
 * order via a stable sort, since `Array.prototype.sort` is guaranteed
 * stable in this codebase's supported Node.js range.
 */
export function fetchIssueCommentsGraphql(
  owner: string,
  repo: string,
  issueNumber: number,
  timeoutMs: number | undefined,
): SweepGraphqlComment[] {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      comments(first:100,after:$cursor){
        nodes { id url body isMinimized createdAt author { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  const out: SweepGraphqlComment[] = [];
  let cursor: string | null = null;
  const startedAt = Date.now();
  const label = `${owner}/${repo}#${issueNumber}`;
  while (true) {
    let perCallTimeout: number | undefined;
    if (timeoutMs !== undefined) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(
          `sweep-authoring-markers: deadline exceeded while paginating ${label}`,
        );
      }
      perCallTimeout = remaining;
    }
    const args = [
      'api',
      'graphql',
      ...resolveGhHostnameArgs(),
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${issueNumber}`,
      ...(cursor ? ['-f', `cursor=${cursor}`] : []),
    ];
    const raw = ghText(args, {
      ...(perCallTimeout !== undefined ? { timeout: perCallTimeout } : {}),
      maxBuffer: LARGE_COMMENT_PAGE_MAX_BUFFER,
    });
    let parsed: SweepGraphqlCommentsPayload;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (error) {
      throw new Error(
        `sweep-authoring-markers: gh-graphql-parse: ${(error as Error).message}`,
      );
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(
        `sweep-authoring-markers: gh-graphql-errors: ${parsed.errors
          .map((e) => String(e.message ?? ''))
          .filter(Boolean)
          .join('; ')}`,
      );
    }
    const issue = parsed.data?.repository?.issue;
    if (issue == null) {
      throw new Error(
        `sweep-authoring-markers: ${label} is not an issue or does not exist`,
      );
    }
    const connection = issue.comments;
    if (connection == null) {
      throw new Error(
        `sweep-authoring-markers: ${label} returned a null comments connection`,
      );
    }
    for (const node of connection.nodes ?? []) {
      out.push({
        nodeId: String(node.id ?? ''),
        url: String(node.url ?? ''),
        body: String(node.body ?? ''),
        authorLogin: String(node.author?.login ?? ''),
        isMinimized: Boolean(node.isMinimized),
        createdAt: String(node.createdAt ?? ''),
      });
    }
    const pageInfo = connection.pageInfo;
    if (!pageInfo?.hasNextPage) {
      break;
    }
    if (!pageInfo.endCursor) {
      throw new Error(
        `sweep-authoring-markers: page reported hasNextPage without endCursor for ${label}`,
      );
    }
    cursor = pageInfo.endCursor;
  }
  // #2935 review (Copilot): sort ascending by createdAt explicitly rather
  // than trusting the GraphQL connection's undocumented default order --
  // see this function's own doc comment above for why "newest" detection
  // downstream depends on this.
  out.sort((a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
      return 0;
    }
    return aMs - bMs;
  });
  return out;
}

/** Per-family counters for one sweep report (#2935). `scanned` counts every
 * byte-exact canonical match regardless of trust (mirrors `classify
 * AuthoringMarkerFamily`'s `matchIndexes`); `untrusted` and
 * `protectedNewest` explain why a scanned candidate was never submitted
 * for minimization; `alreadyMinimized` is the pre-mutation-snapshot count
 * (a candidate GitHub already reports minimized before this sweep ran);
 * `minimized`/`raceAlreadyMinimized`/`deadlineSkipped`/`failed` are
 * derived from `runMinimize`'s own post-mutation report, keyed back to
 * this family via each candidate's own node id. `minimized` counts both a
 * real `status: "applied"` (an `--apply` run) and a `status: "would-
 * apply"` (a dry run, `--apply` omitted) -- `report.mode` already
 * disambiguates real from hypothetical, so this field answers "how many
 * would be minimized" either way. `raceAlreadyMinimized` is distinct from
 * `alreadyMinimized`: it means the PRE-fetch snapshot said not-yet-
 * minimized, but `runMinimize`'s own live re-probe found it already
 * minimized by the time the mutation ran (another sweep or the
 * opportunistic per-post step won the race) -- both mean the comment is
 * minimized now, so a caller tallying "cleared" should sum the two.
 * `skippedOther` is every other `runMinimize` skip reason this sweep can
 * still legitimately hit despite its own pre-filter already excluding
 * untrusted/already-minimized candidates before submission -- a live
 * re-probe disagreeing with the pre-fetch snapshot (`viewer-cannot-
 * minimize`, `unsupported-type`) or a genuine race where the author
 * became untrusted between fetch and mutation (`untrusted-author`).
 * `computeSweepExitCode` does NOT treat `skippedOther` as a failure,
 * matching `runMinimize`'s own `computeExitCode`, which returns `0` for
 * every one of these skip reasons -- only `failed` does. */
export interface AuthoringMarkerSweepFamilyCounts {
  scanned: number;
  untrusted: number;
  protectedNewest: number;
  alreadyMinimized: number;
  eligible: number;
  minimized: number;
  raceAlreadyMinimized: number;
  deadlineSkipped: number;
  skippedOther: number;
  failed: number;
}

function emptyFamilyCounts(): AuthoringMarkerSweepFamilyCounts {
  return {
    scanned: 0,
    untrusted: 0,
    protectedNewest: 0,
    alreadyMinimized: 0,
    eligible: 0,
    minimized: 0,
    raceAlreadyMinimized: 0,
    deadlineSkipped: 0,
    skippedOther: 0,
    failed: 0,
  };
}

export interface AuthoringMarkerSweepIssueResult {
  owner: string;
  repo: string;
  issue: number;
  commentCount: number;
  nonCanonical: number;
  error?: string;
}

/** One minimize candidate's outcome, tagged with the family it belonged to
 * (#2935 review): the contract's "Make every sweep attempt's outcome
 * visible" section feeds `authoring-marker-minimization-backlog` the
 * sweep's own post-mutation result "keyed by subject id" -- this array,
 * not `minimize-superseded-markers.mjs`'s own `items[]`, is now that
 * primary source, since this command's report is the one a caller
 * actually sees. Present only for a subject actually submitted to
 * `runMinimize` (never for a `deadline-exceeded`-before-submission
 * skip, which the corresponding family count still reports). */
export interface AuthoringMarkerSweepItem {
  subjectId: string;
  family: AuthoringMarkerFamily;
  url?: unknown;
  status: string;
  reason?: string;
  author?: unknown;
}

export interface AuthoringMarkerSweepReport {
  mode: 'apply' | 'dry-run';
  classifier: string;
  markerPrefix: string;
  trustedMarkerActors: string[];
  trustedMarkerActorsSource: string;
  issues: AuthoringMarkerSweepIssueResult[];
  families: Record<AuthoringMarkerFamily, AuthoringMarkerSweepFamilyCounts>;
  items: AuthoringMarkerSweepItem[];
}

/** Injectable dependencies (#2935): a test supplies a fake `fetchIssueComments`
 * returning a synthetic comment set (no `gh` call at all) while leaving
 * `minimize` as the real, separately-tested `runMinimize` -- exercising
 * this file's own fetch-classify-filter-mutate orchestration end to end
 * without needing a live GitHub connection for the fetch half, and a
 * `stubExecutable('gh', ...)` fake for the mutation half's own `gh` calls
 * (the same convention `tests/minimize-superseded-markers.test.mts`
 * already uses). */
export interface AuthoringMarkerSweepDeps {
  fetchIssueComments: (
    owner: string,
    repo: string,
    issueNumber: number,
    timeoutMs: number | undefined,
  ) => SweepGraphqlComment[];
  minimize: typeof runMinimize;
}

const DEFAULT_DEPS: AuthoringMarkerSweepDeps = {
  fetchIssueComments: fetchIssueCommentsGraphql,
  minimize: runMinimize,
};

export interface AuthoringMarkerSweepOptions {
  /** Each target's own owner/repo/issue (#2935 review): a bare `--issue`
   * number and an explicit cross-repository `owner/repo#number` reference
   * can both appear in the same invocation, so there is no single
   * invocation-wide owner/repo any more -- see {@link SweepIssueTarget}. */
  issues: readonly SweepIssueTarget[];
  markerPrefix: string;
  classifier: string;
  trustedSet: ReadonlySet<string>;
  apply: boolean;
  /** Overall wall-clock budget (ms) for the ENTIRE sweep -- every issue's
   * fetch plus the final minimize pass -- mirroring `post-idd-
   * marker.mts`'s `hideSupersededPostTimeMarkers` (#2754): the clock
   * starts at this function's own entry, before any network call, not at
   * `runMinimize`'s. `undefined` keeps the pre-existing unbounded
   * behavior. */
  deadlineMs?: number;
}

/**
 * Run the fetch-driven hide-on-supersede sweep across `options.issues`
 * (#2935): for each issue, fetch its comments via GraphQL, classify every
 * comment against both authoring marker families
 * (`classifyAuthoringMarkerFamily`), collect the eligible (trusted,
 * non-newest, not-yet-minimized) candidates' node ids, then submit the
 * FULL cross-issue candidate set to `runMinimize` in one mutation pass.
 * `deps` defaults to the real GraphQL fetch and the real `runMinimize`;
 * tests override either or both. Never throws on a single issue's fetch
 * failure -- that issue's `error` field records it and the sweep continues
 * with the remaining issues, matching the contract's best-effort framing.
 */
export function runAuthoringMarkerSweep(
  options: AuthoringMarkerSweepOptions,
  deps: AuthoringMarkerSweepDeps = DEFAULT_DEPS,
): AuthoringMarkerSweepReport {
  const startedAt = Date.now();
  const remaining = (): number | undefined =>
    options.deadlineMs === undefined
      ? undefined
      : options.deadlineMs - (Date.now() - startedAt);

  const families: Record<
    AuthoringMarkerFamily,
    AuthoringMarkerSweepFamilyCounts
  > = {
    'authoring-owner': emptyFamilyCounts(),
    'authoring-publication-intent': emptyFamilyCounts(),
  };
  const issues: AuthoringMarkerSweepIssueResult[] = [];
  const subjectFamilies = new Map<string, AuthoringMarkerFamily>();

  for (const target of options.issues) {
    const budget = remaining();
    if (budget !== undefined && budget <= 0) {
      issues.push({
        owner: target.owner,
        repo: target.repo,
        issue: target.issue,
        commentCount: 0,
        nonCanonical: 0,
        error: 'deadline-exceeded',
      });
      continue;
    }
    let comments: SweepGraphqlComment[];
    try {
      comments = deps.fetchIssueComments(
        target.owner,
        target.repo,
        target.issue,
        budget,
      );
    } catch (error) {
      issues.push({
        owner: target.owner,
        repo: target.repo,
        issue: target.issue,
        commentCount: 0,
        nonCanonical: 0,
        error: (error as Error).message,
      });
      continue;
    }

    let nonCanonical = 0;
    const candidates = comments.map((comment) => ({
      body: comment.body,
      author: comment.authorLogin,
      isMinimized: comment.isMinimized,
    }));
    for (const comment of comments) {
      if (
        matchCanonicalAuthoringMarkerFamily(
          comment.body,
          options.markerPrefix,
        ) === null
      ) {
        nonCanonical += 1;
      }
    }
    issues.push({
      owner: target.owner,
      repo: target.repo,
      issue: target.issue,
      commentCount: comments.length,
      nonCanonical,
    });

    for (const family of AUTHORING_MARKER_FAMILIES) {
      const classification = classifyAuthoringMarkerFamily(
        candidates,
        options.markerPrefix,
        family,
        options.trustedSet,
      );
      const counts = families[family];
      counts.scanned += classification.matchIndexes.length;
      counts.untrusted += classification.untrustedIndexes.length;
      counts.protectedNewest +=
        classification.newestTrustedIndex === null ? 0 : 1;
      counts.alreadyMinimized += classification.alreadyMinimizedIndexes.length;
      counts.eligible += classification.eligibleIndexes.length;
      for (const index of classification.eligibleIndexes) {
        const nodeId = comments[index].nodeId;
        if (nodeId) {
          subjectFamilies.set(nodeId, family);
        }
      }
    }
  }

  const items: AuthoringMarkerSweepItem[] = [];
  const subjectIds = [...subjectFamilies.keys()];
  if (subjectIds.length > 0) {
    // Bail BEFORE the mutation stage once the budget is already spent
    // (#2935 review, mirroring `post-idd-marker.mts`'s
    // `hideSupersededPostTimeMarkers`, lines "const mutationPassR =
    // remaining(); if (mutationPassR <= 0) return;"): `runMinimize`'s own
    // deadline handling still attempts its index-0 candidate's probe
    // unconditionally (the documented exemption that guarantees forward
    // progress for a STANDALONE `minimize-superseded-markers.mjs` call),
    // which would otherwise cost this sweep one full un-throttled
    // `GH_TIMEOUT_MS` probe call for no benefit once the caller's own
    // overall budget is already exhausted. Every eligible candidate is
    // reported `deadlineSkipped` instead, matching what `runMinimize`
    // itself would report for every candidate past the first if it ran.
    const mutationBudget = remaining();
    if (mutationBudget !== undefined && mutationBudget <= 0) {
      for (const [subjectId, family] of subjectFamilies) {
        families[family].deadlineSkipped += 1;
        items.push({
          subjectId,
          family,
          status: 'skipped',
          reason: 'deadline-exceeded',
        });
      }
    } else {
      const minimizeReport = deps.minimize({
        subjectIds,
        classifier: options.classifier,
        trustedSet: new Set(options.trustedSet),
        apply: options.apply,
        allowUntrusted: false,
        deadlineMs: mutationBudget,
      });
      for (const item of minimizeReport.items) {
        const family = subjectFamilies.get(item.subjectId);
        if (!family) {
          continue;
        }
        items.push({
          subjectId: item.subjectId,
          family,
          url: item.url,
          status: item.status,
          reason: item.reason,
          author: item.author,
        });
        const counts = families[family];
        // `status: 'failed'` is the ONLY outcome this sweep treats as a
        // real failure (#2935 review) -- every other skip reason
        // (`viewer-cannot-minimize`, `unsupported-type`, `untrusted-
        // author`) is a live re-probe legitimately disagreeing with this
        // sweep's own pre-fetch snapshot, not a defect, and `runMinimize`'s
        // own `computeExitCode` already returns 0 for all of them. An
        // earlier revision folded every unrecognized status into `failed`,
        // which would have made `computeSweepExitCode` report a spurious
        // failure for a case `runMinimize` itself considers clean.
        if (item.status === 'applied' || item.status === 'would-apply') {
          counts.minimized += 1;
        } else if (
          item.status === 'skipped' &&
          item.reason === 'already-minimized'
        ) {
          counts.raceAlreadyMinimized += 1;
        } else if (
          item.status === 'skipped' &&
          item.reason === 'deadline-exceeded'
        ) {
          counts.deadlineSkipped += 1;
        } else if (item.status === 'failed') {
          counts.failed += 1;
        } else {
          counts.skippedOther += 1;
        }
      }
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    classifier: options.classifier,
    markerPrefix: options.markerPrefix,
    trustedMarkerActors: [...options.trustedSet].sort(),
    trustedMarkerActorsSource: '',
    issues,
    families,
    items,
  };
}

/** `0` when every issue fetched cleanly (no `deadline-exceeded`-before-
 * fetch and no fetch error) and no family reports a `failed` candidate;
 * `1` otherwise -- mirrors `minimize-superseded-markers.mts`'s own
 * `computeExitCode` for the mutation half (fail only on a real `status:
 * "failed"`, never on `skippedOther` or an empty/all-skipped result), and
 * additionally fails on a fetch-stage problem `runMinimize` has no
 * equivalent for: an issue this sweep never got to scan at all (a `gh`
 * error, a non-issue number, or the overall deadline already spent before
 * its own turn) is deliberately treated as a real failure here, distinct
 * from a per-candidate `deadlineSkipped` inside an issue that WAS
 * scanned. */
export function computeSweepExitCode(
  report: AuthoringMarkerSweepReport,
): number {
  if (report.issues.some((issue) => issue.error !== undefined)) {
    return 1;
  }
  if (Object.values(report.families).some((counts) => counts.failed > 0)) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface SweepCliArgs {
  /** Raw `--issue` tokens, not yet resolved: resolving a bare number
   * against the right default owner/repo needs `resolveCurrentGithub
   * Repository()`, an I/O call this pure parse step must not make (only
   * `main()` below, after validating everything else, decides whether
   * that call is even needed). */
  issueTokens: string[];
  owner: string;
  repo: string;
  markerPrefix: string;
  classifier: string;
  trustedMarkerLogins: string;
  apply: boolean;
  format: string;
  deadlineMs?: number;
  help: boolean;
}

// Flag-spec keys stay the dashed literal (tests/flag-name-matrix.test.mts
// scans this file's compiled .mjs source for each canonical flag written
// as a quoted string literal -- see cli-args.mts's module header).
const SWEEP_AUTHORING_MARKERS_FLAG_SPEC = {
  '--issue': { type: 'string', multiple: true },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--marker-prefix': { type: 'string', default: '' },
  '--classifier': { type: 'string', default: 'OUTDATED' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--apply': { type: 'boolean' },
  '--format': { type: 'string', default: 'json' },
  '--deadline-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function parseArgs(argv: string[]): SweepCliArgs {
  const { values, help } = parseCliArgs(
    argv,
    SWEEP_AUTHORING_MARKERS_FLAG_SPEC,
  );

  const issueTokens = (values.issue as string[] | undefined) ?? [];

  const owner = ((values.owner as string) ?? '').trim();
  const repo = ((values.repo as string) ?? '').trim();
  // #2935 review (Codex and Copilot both, independently): exactly one of
  // --owner/--repo would mix a caller-supplied repo with
  // resolveCurrentGithubRepository()'s current-directory repo for every
  // bare-number --issue, potentially sweeping (and, under --apply,
  // mutating) an unrelated same-numbered issue in the wrong repository.
  // Mirrors authoring-owner-provenance.mts's and suitability-close-
  // execute.mts's own --owner/--repo pairing guard: require both or
  // neither.
  if ((owner === '') !== (repo === '')) {
    throw new Error(
      'sweep-authoring-markers: --owner and --repo must be provided together or not at all',
    );
  }

  let deadlineMs: number | undefined;
  if (values['deadline-ms'] !== undefined) {
    if (values['deadline-ms'] === '') {
      throw new Error('--deadline-ms requires a value');
    }
    if (!/^(?:0|[1-9]\d*)$/.test(values['deadline-ms'] as string)) {
      throw new Error(
        '--deadline-ms must be a non-negative integer (milliseconds)',
      );
    }
    deadlineMs = Number.parseInt(values['deadline-ms'] as string, 10);
  }

  return {
    issueTokens,
    owner,
    repo,
    markerPrefix: (values['marker-prefix'] as string) ?? '',
    classifier: (values.classifier as string) ?? 'OUTDATED',
    trustedMarkerLogins: (values['trusted-marker-logins'] as string) ?? '',
    apply: Boolean(values.apply),
    format: (values.format as string) ?? 'json',
    deadlineMs,
    help,
  };
}

/**
 * Resolve the marker prefix from an explicit `--marker-prefix` flag or
 * `.github/idd/config.json`'s top-level `markerPrefix`, in that order.
 * Returns `''` -- never a hardcoded fallback -- when neither source
 * resolves one (#2935 review, Codex): the issue-authoring contract's own
 * "prefix-first" rule requires asking rather than guessing when the
 * prefix is not discoverable, and explicitly forbids ever defaulting to
 * this SOURCE repository's own `idd-skill` prefix in an installed
 * bundle. An installed skill or npx profile invoked in a target
 * repository with no `markerPrefix` configured yet must be told the
 * already-resolved prefix explicitly via `--marker-prefix`; silently
 * assuming `idd-skill` there would classify every real marker as
 * non-canonical and let an `--apply` run report success while
 * minimizing nothing. The caller (`main`, below) turns an empty result
 * into a hard, actionable CLI error before any fetch begins.
 */
export function normalizeMarkerPrefix(
  flagValue: string,
  config: unknown,
): string {
  const trimmedFlag = flagValue.trim();
  if (trimmedFlag.length > 0) {
    return trimmedFlag;
  }
  const configValue = (config as { markerPrefix?: unknown } | null)
    ?.markerPrefix;
  return typeof configValue === 'string' ? configValue.trim() : '';
}

function printTable(report: AuthoringMarkerSweepReport): void {
  console.log(
    `mode: ${report.mode}  classifier: ${report.classifier}  marker-prefix: ${report.markerPrefix}`,
  );
  for (const issue of report.issues) {
    const suffix = issue.error ? `  error: ${issue.error}` : '';
    console.log(
      `  issue ${issue.owner}/${issue.repo}#${issue.issue}: comments=${issue.commentCount} nonCanonical=${issue.nonCanonical}${suffix}`,
    );
  }
  for (const family of AUTHORING_MARKER_FAMILIES) {
    const c = report.families[family];
    console.log(
      `${family}: scanned=${c.scanned} untrusted=${c.untrusted} protectedNewest=${c.protectedNewest} alreadyMinimized=${c.alreadyMinimized} eligible=${c.eligible} minimized=${c.minimized} raceAlreadyMinimized=${c.raceAlreadyMinimized} deadlineSkipped=${c.deadlineSkipped} skippedOther=${c.skippedOther} failed=${c.failed}`,
    );
  }
  for (const item of report.items) {
    const url = item.url ?? '(no url)';
    const reason = item.reason ?? '';
    console.log(
      `  [${item.status}] ${item.family} ${item.subjectId}  ${url}  ${reason}`,
    );
  }
}

function printUsage(): void {
  console.log(
    `Usage: sweep-authoring-markers --issue <number|owner/repo#number> [--issue ...] [--owner <owner>] [--repo <repo>] [--marker-prefix <prefix>] [--classifier OUTDATED|RESOLVED] --trusted-marker-logins <login1,login2> [--apply] [--format json|table] [--deadline-ms <milliseconds>]

Fetch-driven hide-on-supersede sweep for authoring-owner /
authoring-publication-intent markers (#2935): fetches each --issue's
comments via GraphQL (selecting isMinimized, which REST never carries),
classifies every comment with matchCanonicalAuthoringMarkerFamily, keeps
only the single newest byte-exact canonical match per family among
TRUSTED-actor authors, and minimizes (classifier OUTDATED by default)
every other eligible, not-yet-minimized candidate in one mutation pass --
reusing minimize-superseded-markers.mts's own runMinimize.

Pass one --issue per target to sweep (the per-target preflight and the
anchor-before-release-complete sweep points each pass one; the closing
sweep passes every target plus the anchor and the journal issue in the
same invocation). A bare --issue <number> is scanned in --owner/--repo
(defaulting to the current repository); an explicit --issue
<owner/repo#number> is scanned in ITS OWN owner/repo instead, so one
invocation can mix a same-repo target with a cross-repository
issueAuthoring.journalIssue (#2935 review, Codex and Copilot). --owner
and --repo must be given together or not at all -- supplying only one
would otherwise silently mix a caller-supplied repo with the current
directory's repo for every bare-number --issue.

The trusted-author gate is mandatory, matching minimize-superseded-
markers.mjs: supply --trusted-marker-logins, IDD_TRUSTED_MARKER_ACTORS, or
the trustedMarkerActors list in .github/idd/config.json (flag > env >
config precedence). There is no --allow-untrusted escape hatch here --
unlike a direct minimize-superseded-markers.mjs call, this sweep's own
"newest" determination depends on the trust filter to decide which
comment is the live marker to protect from minimization.

--marker-prefix defaults to the top-level markerPrefix field in
.github/idd/config.json. Required when neither is available (#2935
review, Codex): this command never guesses a prefix, per the
issue-authoring contract's "prefix-first" rule -- an installed skill or
npx profile running in a target with no configured markerPrefix yet
must pass the already-resolved prefix explicitly.

--deadline-ms bounds the WHOLE sweep (every --issue's own GraphQL
pagination plus the final minimize pass), not just the mutation --
omit it to keep the default unbounded behavior. Best-effort: a single
--issue's fetch failure is recorded in the report and does not abort the
other issues in the same invocation.`,
  );
}

if (import.meta.main) {
  let args: SweepCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!ALLOWED_CLASSIFIERS.has(args.classifier)) {
    console.error(
      `error: --classifier must be one of ${[...ALLOWED_CLASSIFIERS].join(', ')} (got "${args.classifier}")`,
    );
    process.exit(2);
  }

  if (!ALLOWED_FORMATS.has(args.format)) {
    console.error(
      `error: --format must be one of ${[...ALLOWED_FORMATS].join(', ')} (got "${args.format}")`,
    );
    process.exit(2);
  }

  if (args.issueTokens.length === 0) {
    console.error('error: --issue must be supplied at least once');
    process.exit(2);
  }

  const config = loadIddConfig();
  const { actors: trustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
      config,
    });
  if (trustedActors.length === 0) {
    console.error(
      'error: no trusted marker logins supplied. Pass --trusted-marker-logins, set IDD_TRUSTED_MARKER_ACTORS, or list trustedMarkerActors in .github/idd/config.json.',
    );
    process.exit(2);
  }

  // Only resolve the current repository when at least one --issue token
  // actually needs it as a default (#2935 review): an invocation sweeping
  // only explicit owner/repo#number cross-repository targets never needs
  // it, and skipping the extra `gh repo view` call in that case is free.
  const explicitRepoGiven = Boolean(args.owner && args.repo);
  const needsCurrentRepo =
    !explicitRepoGiven &&
    args.issueTokens.some((token) => !isCrossRepoIssueToken(token));
  const currentRepo = needsCurrentRepo
    ? resolveCurrentGithubRepository()
    : null;
  const defaultOwner = args.owner || currentRepo?.owner || '';
  const defaultRepo = args.repo || currentRepo?.repo || '';
  const markerPrefix = normalizeMarkerPrefix(args.markerPrefix, config);
  if (markerPrefix.length === 0) {
    console.error(
      'error: no marker prefix resolved. Pass --marker-prefix <prefix>, or set the top-level markerPrefix field in .github/idd/config.json -- this command never guesses a prefix (see the issue-authoring contract\'s "prefix-first" rule).',
    );
    process.exit(2);
  }

  let issues: SweepIssueTarget[];
  try {
    issues = args.issueTokens.map((token) =>
      parseIssueTargetToken(token, defaultOwner, defaultRepo),
    );
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  }

  const report = runAuthoringMarkerSweep({
    issues,
    markerPrefix,
    classifier: args.classifier,
    trustedSet: new Set(trustedActors),
    apply: args.apply,
    deadlineMs: args.deadlineMs,
  });
  report.trustedMarkerActorsSource = trustedMarkerActorsSource;

  if (args.format === 'table') {
    printTable(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(computeSweepExitCode(report));
}
