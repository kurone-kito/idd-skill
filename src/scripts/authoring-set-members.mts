#!/usr/bin/env node
// idd-generated-from: src/scripts/authoring-set-members.mts
//
// The scripts/authoring-set-members.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Read-only enumeration of issues whose trusted authoring-owner markers
// carry one exact `set` value (kurone-kito/idd-skill#3468). The
// review-fix-loop-cutoff sole-member precondition calls this instead of
// asking a session to paginate every issue comment by hand. A search
// response with `incomplete_results`, a duplicate hit that hides a
// distinct issue, an unfinished index-lag window, or any other
// unfinished listing, exits non-zero and never reports `soleMember: true`.

import { fetchProvenanceCommentsGraphql } from './authoring-owner-provenance.mts';
import { parseCliArgs } from './cli-args.mts';
import { ghApiJson } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadPolicyConfig } from './idd-config.mts';
import {
  normalizeMarkerPrefix,
  parseAuthoringOwnerComment,
} from './marker-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mts';

/** GitHub's issue-search API returns at most this many hits. */
export const SEARCH_RESULT_CAP = 1000;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = SEARCH_RESULT_CAP / SEARCH_PAGE_SIZE;

/**
 * How far back the issues API is read after a finished search. GitHub's
 * search index can omit a comment that is already on the issue while
 * still reporting `incomplete_results: false`. Issues updated inside
 * this window are comment-scanned even when search missed them.
 */
export const INDEX_LAG_WINDOW_MS = 60 * 60 * 1000;
/** One full page at this size means a later sibling may have been cut off. */
export const INDEX_LAG_PAGE_SIZE = 100;
export const INDEX_LAG_ISSUE_CAP = 100;

const SET_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface IssueSearchHit {
  number: number;
  pullRequest: boolean;
}

export interface IssueSearchPage {
  totalCount: number;
  incompleteResults: boolean;
  items: IssueSearchHit[];
}

export interface SearchCollection {
  complete: boolean;
  numbers: number[];
  reason: string;
}

export interface SetMemberComment {
  authorLogin: string;
  body: string;
  /**
   * GraphQL `lastEditedAt`. `null` means the body was never edited.
   * A timestamp means the body was edited; that marker cannot prove
   * set membership and fails the listing closed.
   */
  lastEditedAt: string | null;
  issueNumber: number;
}

export interface SetMemberEvaluation {
  complete: boolean;
  soleMember: boolean;
  issues: number[];
  reason: string;
}

export interface IndexLagIssue {
  number: number;
  pullRequest: boolean;
}

export interface IndexLagCollection {
  complete: boolean;
  numbers: number[];
  reason: string;
}

const FLAG_SPEC = {
  '--set': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--marker-prefix': { type: 'string' },
  '--gh-token': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('authoring-set-members', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

/**
 * Parse one `GET /search/issues` payload. Returns null when the page is
 * not a readable search response -- the caller treats that as an
 * unfinished listing.
 */
export function parseIssueSearchPage(payload: unknown): IssueSearchPage | null {
  if (payload == null || typeof payload !== 'object') {
    return null;
  }
  const row = payload as {
    total_count?: unknown;
    incomplete_results?: unknown;
    items?: unknown;
  };
  if (typeof row.incomplete_results !== 'boolean') {
    return null;
  }
  if (
    typeof row.total_count !== 'number' ||
    !Number.isInteger(row.total_count)
  ) {
    return null;
  }
  if (row.total_count < 0 || !Array.isArray(row.items)) {
    return null;
  }
  const items: IssueSearchHit[] = [];
  for (const item of row.items) {
    if (item == null || typeof item !== 'object') {
      return null;
    }
    const number = (item as { number?: unknown }).number;
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      return null;
    }
    items.push({
      number,
      pullRequest: (item as { pull_request?: unknown }).pull_request != null,
    });
  }
  return {
    totalCount: row.total_count,
    incompleteResults: row.incomplete_results,
    items,
  };
}

/**
 * Decide whether a sequence of search pages is a finished listing of
 * every hit. `incomplete_results` on any page, a total above the search
 * cap, a collected item count other than `total_count`, or fewer
 * distinct issue numbers than `total_count` is unfinished. Pull
 * requests are dropped only after those counts match.
 */
export function collectSearchedIssueNumbers(
  pages: readonly IssueSearchPage[],
): SearchCollection {
  const unfinished = (reason: string): SearchCollection => ({
    complete: false,
    numbers: [],
    reason,
  });
  if (pages.length === 0) {
    return unfinished('no search response');
  }
  if (pages.some((page) => page.incompleteResults)) {
    return unfinished('incomplete_results');
  }
  const totalCount = pages[0]?.totalCount;
  if (totalCount === undefined) {
    return unfinished('no search response');
  }
  if (pages.some((page) => page.totalCount !== totalCount)) {
    return unfinished('unstable total_count');
  }
  if (totalCount > SEARCH_RESULT_CAP) {
    return unfinished('search result cap exceeded');
  }
  const rawItems = pages.flatMap((page) => page.items);
  const rawCount = rawItems.length;
  if (rawCount !== totalCount) {
    return unfinished('collected count does not match total_count');
  }
  const uniqueCount = new Set(rawItems.map((item) => item.number)).size;
  if (uniqueCount !== totalCount) {
    return unfinished('unique count does not match total_count');
  }
  const numbers = [
    ...new Set(
      pages.flatMap((page) =>
        page.items
          .filter((item) => !item.pullRequest)
          .map((item) => item.number),
      ),
    ),
  ].sort((left, right) => left - right);
  return { complete: true, numbers, reason: '' };
}

function looksLikeOwnerMarker(body: string, markerPrefix: string): boolean {
  return body
    .toLowerCase()
    .includes(`${markerPrefix.toLowerCase()}-authoring-owner:`);
}

/**
 * Issues whose unedited trusted authoring-owner markers use `set`
 * exactly. Any edited trusted comment that still carries the
 * authoring-owner token fails closed before parsing, including one
 * whose edit removed the set or broke the marker shape. Ignoring that
 * comment could report a sole member while a sibling marker was
 * rewritten. Untrusted comments and unedited markers for a different
 * set do not count. One issue with several markers for the set is
 * still one member.
 */
export function evaluateAuthoringSetMembers(input: {
  set: string;
  markerPrefix: string;
  trustedMarkerLogins: readonly string[];
  comments: readonly SetMemberComment[];
  enumerationComplete: boolean;
}): SetMemberEvaluation {
  if (!input.enumerationComplete) {
    return {
      complete: false,
      soleMember: false,
      issues: [],
      reason: 'enumeration incomplete',
    };
  }
  const trusted = new Set(
    input.trustedMarkerLogins.map((login) => login.trim().toLowerCase()),
  );
  const issues = new Set<number>();
  for (const comment of input.comments) {
    const login = comment.authorLogin.trim().toLowerCase();
    if (!trusted.has(login)) {
      continue;
    }
    if (
      looksLikeOwnerMarker(comment.body, input.markerPrefix) &&
      comment.lastEditedAt !== null
    ) {
      return {
        complete: false,
        soleMember: false,
        issues: [],
        reason: 'edited trusted authoring-owner marker',
      };
    }
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (!parsed || parsed.set !== input.set) {
      continue;
    }
    issues.add(comment.issueNumber);
  }
  const sorted = [...issues].sort((left, right) => left - right);
  return {
    complete: true,
    soleMember: sorted.length === 1,
    issues: sorted,
    reason: '',
  };
}

/**
 * Issues updated inside the index-lag window. A full page, or more
 * items than the cap, is unfinished: stopping there could hide a
 * sibling search has not indexed yet. Pull requests are dropped only
 * after that bound holds.
 */
export function collectIndexLagIssueNumbers(
  items: readonly IndexLagIssue[],
  pageFull: boolean,
): IndexLagCollection {
  if (pageFull || items.length > INDEX_LAG_ISSUE_CAP) {
    return {
      complete: false,
      numbers: [],
      reason: 'index-lag window exceeded',
    };
  }
  const numbers = [
    ...new Set(
      items.filter((item) => !item.pullRequest).map((item) => item.number),
    ),
  ].sort((left, right) => left - right);
  return { complete: true, numbers, reason: '' };
}

function fetchIndexLagIssues(
  owner: string,
  repo: string,
  sinceIso: string,
): { items: IndexLagIssue[]; pageFull: boolean } {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/issues?state=all&since=${encodeURIComponent(sinceIso)}&per_page=${INDEX_LAG_PAGE_SIZE}&page=1`,
  );
  if (!Array.isArray(payload)) {
    throw new Error(
      'authoring-set-members: index-lag issue list is not a readable page',
    );
  }
  const items: IndexLagIssue[] = [];
  for (const item of payload) {
    const record = item as { number?: unknown; pull_request?: unknown };
    if (!Number.isInteger(record.number) || (record.number as number) <= 0) {
      throw new Error(
        'authoring-set-members: index-lag issue list has an unreadable issue number',
      );
    }
    items.push({
      number: record.number as number,
      pullRequest: record.pull_request != null,
    });
  }
  return { items, pageFull: payload.length >= INDEX_LAG_PAGE_SIZE };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/authoring-set-members.mjs --set <id> [--owner <owner> --repo <repo>] [--policy <path>] [--marker-prefix <prefix>] [--trusted-marker-logins <login1,login2>]

Lists every issue in the repository whose unedited trusted authoring-owner
marker carries that exact set. The candidate search is the owner-marker
token, not the set id, so an edited marker that dropped the set is still
fetched and fails closed. Read-only. Exits non-zero when the listing
does not finish, including a search response with incomplete_results, a
duplicate search hit, or an index-lag window that does not finish.
soleMember is true only when exactly one such issue is listed.

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "set": "<id>",
  "complete": true,
  "soleMember": false,
  "issues": [1, 2],
  "reason": ""
}
`);
}

function parseArgs(argv: string[]): {
  set: string;
  owner: string;
  repo: string;
  policy: string;
  markerPrefix: string;
  ghToken: string;
  trustedMarkerLogins: string;
  help: boolean;
} {
  const { values, help } = parseCliArgs(argv, FLAG_SPEC);
  const owner = ((values.owner as string | undefined) ?? '').trim();
  const repo = ((values.repo as string | undefined) ?? '').trim();
  if ((owner === '') !== (repo === '')) {
    throw markCliUsageError(
      new Error(
        'authoring-set-members: --owner and --repo must be provided together or not at all',
      ),
    );
  }
  return {
    set: ((values.set as string | undefined) ?? '').trim(),
    owner,
    repo,
    policy: (values.policy as string | undefined) ?? '',
    markerPrefix: (values['marker-prefix'] as string | undefined) ?? '',
    ghToken: (values['gh-token'] as string | undefined) ?? '',
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    help,
  };
}

function fetchSearchPages(query: string): IssueSearchPage[] {
  const pages: IssueSearchPage[] = [];
  for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
    const payload = ghApiJson(
      `search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`,
    );
    const parsed = parseIssueSearchPage(payload);
    if (!parsed) {
      throw new Error(
        'authoring-set-members: search response is not a readable issue-search page',
      );
    }
    pages.push(parsed);
    const collected = pages.reduce((sum, item) => sum + item.items.length, 0);
    if (
      parsed.incompleteResults ||
      collected >= parsed.totalCount ||
      parsed.items.length < SEARCH_PAGE_SIZE
    ) {
      break;
    }
  }
  return pages;
}

function runCli(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!SET_TOKEN_PATTERN.test(args.set)) {
    throw markCliUsageError(
      new Error(
        '--set is required and must be a single token without whitespace or quotes',
      ),
    );
  }
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  if (!REPO_TOKEN_PATTERN.test(owner) || !REPO_TOKEN_PATTERN.test(repo)) {
    throw new Error(
      'authoring-set-members: could not resolve a repository owner and name',
    );
  }
  const policy = loadPolicyConfig(args.policy || undefined);
  const config = policy.config as {
    markerPrefix?: unknown;
    trustedMarkerActors?: unknown;
  } | null;
  const markerPrefix = normalizeMarkerPrefix(
    args.markerPrefix || config?.markerPrefix,
  );
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config,
  });
  // Search for the owner-marker token, not the set id. An edit that
  // changes or removes the set while leaving the token in place stays
  // in the candidate list, and the edit check below fails closed.
  const query = `repo:${owner}/${repo} is:issue "${markerPrefix}-authoring-owner:"`;
  const search = collectSearchedIssueNumbers(fetchSearchPages(query));
  const fetchedLag = search.complete
    ? fetchIndexLagIssues(
        owner,
        repo,
        new Date(Date.now() - INDEX_LAG_WINDOW_MS).toISOString(),
      )
    : null;
  const lag = fetchedLag
    ? collectIndexLagIssueNumbers(fetchedLag.items, fetchedLag.pageFull)
    : { complete: true, numbers: [], reason: '' };
  const enumerationComplete = search.complete && lag.complete;
  const issueNumbers = enumerationComplete
    ? [...new Set([...search.numbers, ...lag.numbers])].sort(
        (left, right) => left - right,
      )
    : [];
  const comments = issueNumbers.flatMap((issueNumber) =>
    fetchProvenanceCommentsGraphql(owner, repo, issueNumber).map((comment) => ({
      authorLogin: comment.authorLogin,
      body: comment.body,
      lastEditedAt: comment.lastEditedAt,
      issueNumber,
    })),
  );
  const evaluation = evaluateAuthoringSetMembers({
    set: args.set,
    markerPrefix,
    trustedMarkerLogins,
    comments,
    enumerationComplete,
  });
  const reason = !search.complete
    ? search.reason
    : !lag.complete
      ? lag.reason
      : evaluation.reason;
  process.stdout.write(
    `${JSON.stringify(
      {
        repository: { owner, repo },
        set: args.set,
        complete: evaluation.complete,
        soleMember: evaluation.soleMember,
        issues: evaluation.issues,
        reason,
      },
      null,
      2,
    )}\n`,
  );
  return evaluation.complete ? 0 : 1;
}
