#!/usr/bin/env node
// idd-generated-from: src/scripts/authoring-owner-provenance.mts
//
// The scripts/authoring-owner-provenance.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Mechanical provenance check for the review-fix-loop-cutoff auto-release
// exception's precondition (kurone-kito/idd-skill#2877's contract.md
// bullet, kurone-kito/idd-skill#2891): before honoring that exception, a
// releasing session must recompute a target issue's current body-sha256
// from a fresh read and compare it against that same target's own
// `mode=acquire` `authoring-owner` marker's recorded `body-sha256`. That
// comparison previously relied entirely on a releasing session's own
// manual judgment; this helper performs and verifies it mechanically
// instead.
//
// Read-only evidence collector (docs/idd-helper-scripts.md's "Helper
// contract classes"): it never posts comments, applies labels, or mutates
// anything. A releasing session (or a future automated Stage 2
// release-sequence helper) still decides what to do with the verdict.
//
// Per contract.md's "Per-target ownership" section, a target's own
// `authoring-owner` marker is always posted as a comment on that same
// target issue (never on a different anchor issue), so the live body and
// the marker to compare it against always come from the one `--issue`
// argument.

import { createHash } from 'node:crypto';
import { parseCliArgs } from './cli-args.mts';
import { loadPolicyConfig } from './idd-config.mts';
import type { ParsedAuthoringOwnerMarker } from './marker-helpers.mts';
import { parseAuthoringOwnerComment } from './marker-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';

export interface AuthoringOwnerProvenanceComment {
  authorLogin: string;
  body: string;
  createdAt: string;
}

export interface AuthoringOwnerProvenanceInput {
  target: string;
  liveBody: string;
  comments: AuthoringOwnerProvenanceComment[];
  markerPrefix: string;
  trustedMarkerLogins: string[];
}

export interface AuthoringOwnerProvenanceCheck {
  id: string;
  name: string;
  result: 'pass' | 'fail';
}

export interface AuthoringOwnerProvenanceMarkerEvidence {
  author: string;
  createdAt: string;
  owner: string;
  set: string;
  session: string;
  bodySha256: string;
}

export interface AuthoringOwnerProvenanceResult {
  verdict: 'pass' | 'mismatch' | 'not-found';
  target: string;
  computedBodySha256: string;
  recordedBodySha256: string | null;
  marker: AuthoringOwnerProvenanceMarkerEvidence | null;
  checks: AuthoringOwnerProvenanceCheck[];
}

interface AcquireCandidate {
  comment: AuthoringOwnerProvenanceComment;
  parsed: ParsedAuthoringOwnerMarker;
}

function normalizeMarkerPrefix(prefix: unknown): string {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_MARKER_PREFIX;
}

/**
 * Find every trusted-actor `mode=acquire` `authoring-owner` marker on
 * `comments` whose `target` field exactly equals `target`, sorted ascending
 * by comment `createdAt`. There should normally be exactly one per
 * acquisition generation; a re-acquisition after a full release cycle can
 * legitimately produce more than one over an issue's lifetime, so the
 * caller takes the most recent (last) entry rather than the first.
 */
function findAcquireCandidates(
  comments: readonly AuthoringOwnerProvenanceComment[],
  target: string,
  markerPrefix: string,
  trustedMarkerLogins: readonly string[],
): AcquireCandidate[] {
  const trusted = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const candidates: AcquireCandidate[] = [];
  for (const comment of comments) {
    if (!trusted.has(String(comment.authorLogin ?? '').toLowerCase())) {
      continue;
    }
    const parsed = parseAuthoringOwnerComment(comment.body, markerPrefix);
    if (!parsed || parsed.mode !== 'acquire' || parsed.target !== target) {
      continue;
    }
    candidates.push({ comment, parsed });
  }
  return candidates.sort((a, b) =>
    a.comment.createdAt < b.comment.createdAt
      ? -1
      : a.comment.createdAt > b.comment.createdAt
        ? 1
        : 0,
  );
}

/**
 * Compute the sha256 of `input.liveBody` (exact UTF-8 content, matching how
 * the `authoring-owner` marker's `body-sha256` field is documented to be
 * computed — contract.md's "Per-target ownership" section) and compare it
 * against `input.target`'s own trusted `mode=acquire` marker.
 *
 * `verdict` is `not-found` when no matching trusted acquire marker exists
 * for `input.target`; `pass`/`mismatch` otherwise based on exact digest
 * equality. This never fails open on ambiguity: a missing marker is
 * `not-found`, not `pass`.
 */
export function evaluateAuthoringOwnerProvenance(
  input: AuthoringOwnerProvenanceInput,
): AuthoringOwnerProvenanceResult {
  const computedBodySha256 = createHash('sha256')
    .update(input.liveBody, 'utf8')
    .digest('hex');
  const candidates = findAcquireCandidates(
    input.comments ?? [],
    input.target,
    input.markerPrefix,
    input.trustedMarkerLogins ?? [],
  );
  const winner = candidates.at(-1) ?? null;

  if (!winner) {
    return {
      verdict: 'not-found',
      target: input.target,
      computedBodySha256,
      recordedBodySha256: null,
      marker: null,
      checks: [
        {
          id: 'acquire_marker_found',
          name: 'Trusted mode=acquire owner marker found for target',
          result: 'fail',
        },
        {
          id: 'body_sha256_match',
          name: 'Live body sha256 matches acquire-time recorded digest',
          result: 'fail',
        },
      ],
    };
  }

  const recordedBodySha256 = winner.parsed.bodySha256;
  const matches = recordedBodySha256 === computedBodySha256;
  return {
    verdict: matches ? 'pass' : 'mismatch',
    target: input.target,
    computedBodySha256,
    recordedBodySha256,
    marker: {
      author: winner.comment.authorLogin,
      createdAt: winner.comment.createdAt,
      owner: winner.parsed.owner,
      set: winner.parsed.set,
      session: winner.parsed.session,
      bodySha256: winner.parsed.bodySha256,
    },
    checks: [
      {
        id: 'acquire_marker_found',
        name: 'Trusted mode=acquire owner marker found for target',
        result: 'pass',
      },
      {
        id: 'body_sha256_match',
        name: 'Live body sha256 matches acquire-time recorded digest',
        result: matches ? 'pass' : 'fail',
      },
    ],
  };
}

const AUTHORING_OWNER_PROVENANCE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--marker-prefix': { type: 'string' },
  '--gh-token': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--verbose': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

interface ParsedArgs {
  issue: number | null;
  owner: string;
  repo: string;
  policy: string;
  markerPrefix: string;
  ghToken: string;
  trustedMarkerLogins: string;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(
    argv,
    AUTHORING_OWNER_PROVENANCE_FLAG_SPEC,
  );
  const issueToken = values.issue as string | undefined;
  return {
    issue: issueToken === undefined ? null : Number.parseInt(issueToken, 10),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    policy: (values.policy as string | undefined) ?? '',
    markerPrefix: (values['marker-prefix'] as string | undefined) ?? '',
    ghToken: (values['gh-token'] as string | undefined) ?? '',
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    verbose: values.verbose as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/authoring-owner-provenance.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--policy <path>] [--marker-prefix <prefix>] [--gh-token <token>] [--trusted-marker-logins <login1,login2>] [--verbose]

Mechanically compares a live issue body's sha256 against that same issue's
own trusted mode=acquire authoring-owner marker's recorded body-sha256
(kurone-kito/idd-skill#2891). Read-only: never posts, labels, or mutates
anything.

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 2891, "title": "...", "url": "..."},
  "target": "owner/repo#2891",
  "verdict": "pass|mismatch|not-found",
  "computedBodySha256": "<64-hex>",
  "recordedBodySha256": "<64-hex>|null",
  "marker": {"author": "...", "createdAt": "...", "owner": "...", "set": "...", "session": "..."} | null,
  "checks": [{"id":"acquire_marker_found","name":"...","result":"pass|fail"}, {"id":"body_sha256_match","name":"...","result":"pass|fail"}]
}

"not-found" means no trusted mode=acquire authoring-owner marker exists for
this issue's own target -- never treated as a pass. "mismatch" means the
live body has changed since the acquire-time marker was posted.
`);
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || (args.issue ?? 0) <= 0) {
    throw new Error('--issue is required and must be a positive integer');
  }
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const issueNumber = args.issue ?? 0;
  const rawIssue = port.getWorkItem(issueNumber);
  if (!rawIssue) {
    throw new Error(`issue #${issueNumber} not found`);
  }
  const comments: AuthoringOwnerProvenanceComment[] = port
    .listWorkItemComments(issueNumber)
    .map((comment) => ({
      authorLogin: comment.authorLogin,
      body: comment.body,
      createdAt: comment.createdAt,
    }));

  const policy = loadPolicyConfig(args.policy || undefined);
  const config = policy.config as { markerPrefix?: unknown } | null;
  const markerPrefix = normalizeMarkerPrefix(
    args.markerPrefix || config?.markerPrefix,
  );
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: config as { trustedMarkerActors?: unknown } | null,
  });

  const target = `${owner}/${repo}#${issueNumber}`;
  const result = evaluateAuthoringOwnerProvenance({
    target,
    liveBody: rawIssue.body,
    comments,
    markerPrefix,
    trustedMarkerLogins,
  });

  const output = {
    repository: { owner, repo },
    issue: {
      number: rawIssue.number,
      title: rawIssue.title,
      url: rawIssue.htmlUrl ?? rawIssue.url ?? '',
    },
    target: result.target,
    verdict: result.verdict,
    computedBodySha256: result.computedBodySha256,
    recordedBodySha256: result.recordedBodySha256,
    marker: result.marker,
    checks: result.checks,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
