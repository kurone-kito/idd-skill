#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-wait-state.mts
//
// The scripts/advisory-wait-state.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  readAdvisoryPrimaryBotLogin,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mts';
import type { TrustedMarkerActorResolution } from './protocol-helpers.mts';
import {
  buildAdvisoryWaitSummary,
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** PR review payload fields consumed by the advisory-wait summary. */
interface ReviewPayload {
  state?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  commit_id?: string | null;
}

/** Timeline event payload fields consumed by the Copilot coverage check. */
interface TimelineEventPayload {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: GhAuthorPayload | null;
}

/** Parsed CLI arguments. */
interface AdvisoryWaitStateArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  trustedMarkerLogins: string;
  now: string;
}

/**
 * JSON state document printed by this CLI: the advisory-wait gate
 * evidence summary plus the trusted-marker actor provenance fields.
 */
export type AdvisoryWaitStateReport = ReturnType<
  typeof buildAdvisoryWaitSummary
> & {
  trustedMarkerActors: string[];
  trustedMarkerActorsSource: TrustedMarkerActorResolution['source'];
};

const args = parseArgs(process.argv.slice(2));
if (!args.prNumber) {
  throw new Error('missing required --pr <number> argument');
}

const owner =
  args.owner ||
  ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
const repo =
  args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
const repoRef = `${owner}/${repo}`;
const viewerLogin = safeGhText(['api', 'user', '--jq', '.login']).toLowerCase();
const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
  resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: loadIddConfig(),
  });

const prHeadSha = ghText([
  'pr',
  'view',
  String(args.prNumber),
  '-R',
  repoRef,
  '--json',
  'headRefOid',
  '--jq',
  '.headRefOid',
]);

const reviews = ghApiJson(
  `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
  true,
) as ReviewPayload[];
const requestedReviewers = ghApiJson(
  `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
  false,
) as { users?: GhAuthorPayload[] | null };
const timelineEvents = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
  true,
  ['-H', 'Accept: application/vnd.github+json'],
) as TimelineEventPayload[];
const comments = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
  true,
) as IssueCommentPayload[];

const collaboratorTrustEnabled = isTruthy(
  process.env.IDD_TRUST_COLLABORATOR_MARKERS,
);
const trustedMarkerLogins = normalizeTrustedMarkerLogins([
  viewerLogin,
  ...configuredTrustedActors,
  ...(collaboratorTrustEnabled
    ? resolveTrustedCollaboratorMarkerLogins(owner, repo, comments)
    : []),
]);
const advisoryWaitPolicy = readAdvisoryWaitPolicy();
const primaryBotLogin = readAdvisoryPrimaryBotLogin();

const summary = buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews,
    requestedReviewers: requestedReviewers.users ?? [],
    timelineEvents,
    comments: comments.map(normalizeComment),
  },
  {
    now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
    requestCap: advisoryWaitPolicy.requestCap,
    pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
    settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
    pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
    capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
    primaryBotLogin,
    viewerLogin,
    configuredTrustedActors,
    collaboratorTrustEnabled,
    trustedMarkerLogins,
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      ...summary,
      trustedMarkerActors: configuredTrustedActors,
      trustedMarkerActorsSource,
    },
    null,
    2,
  )}\n`,
);

function parseArgs(argv: string[]): AdvisoryWaitStateArgs {
  const parsed: AdvisoryWaitStateArgs = {
    prNumber: null,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    now: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--pr') {
      parsed.prNumber = Number.parseInt(value ?? '', 10);
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
    if (token === '--trusted-marker-logins') {
      parsed.trustedMarkerLogins = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--now <ISO8601>]
`);
}

function normalizeComment(comment: IssueCommentPayload) {
  return {
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
  };
}

function resolveTrustedCollaboratorMarkerLogins(
  owner: string,
  repo: string,
  comments: IssueCommentPayload[],
): string[] {
  const advisoryAuthors = [
    ...new Set(
      comments
        .filter((comment) => advisoryMarkerComment(comment.body ?? ''))
        .map((comment) => comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];

  return advisoryAuthors.filter((login) => {
    const permission = safeGhText([
      'api',
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      '--jq',
      '.permission',
    ]).toLowerCase();

    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}

function advisoryMarkerComment(body: string): boolean {
  const normalized = String(body ?? '');
  return (
    normalized.startsWith('advisory-wait:') ||
    normalized.startsWith('advisory-wait-recovery:') ||
    normalized.startsWith('<!-- advisory-wait:')
  );
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function loadIddConfig(): { trustedMarkerActors?: unknown } | null {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8')) as {
      trustedMarkerActors?: unknown;
    };
  } catch {
    return null;
  }
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function safeGhText(args: string[]): string {
  try {
    return ghText(args);
  } catch {
    return '';
  }
}

function ghApiJson(
  path: string,
  paginate = false,
  extraArgs: string[] = [],
): unknown {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.splice(1, 0, '--paginate', '--jq', '.[]');
    return parsePaginatedGhNdjson(
      execFileSync('gh', args, { encoding: 'utf8' }),
    );
  }
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}
