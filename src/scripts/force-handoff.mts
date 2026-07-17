#!/usr/bin/env node
// idd-generated-from: src/scripts/force-handoff.mts
//
// The scripts/force-handoff.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { planHandoff } from './forced-handoff-marker.mts';
import { ghText, safeGhText } from './gh-exec.mts';
import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
  author?: GhAuthorPayload | null;
}

/** Linked-PR row returned by `gh pr list --json number,headRefName`. */
interface LinkedPrPayload {
  number?: number | string | null;
  headRefName?: string | null;
}

/** Posted-comment payload fields consumed by this helper. */
interface PostedCommentPayload {
  html_url?: string | null;
  url?: string | null;
}

/** Interactive prompt function with an optional readline close hook. */
type PromptFn = ((question: string) => Promise<string>) & {
  close?: () => void;
};

/** Options accepted by {@link runHandoff}. */
interface RunHandoffOptions {
  isTTY?: boolean;
  prompt?: PromptFn;
  repo?: string;
  forcedBy?: string;
  reason?: string;
  trustedMarkerLogins?: string[] | Set<string>;
  isAuthorizedForcedHandoff?: (actor: string) => boolean;
  fetchIssueComments?: (
    issueNumber: number,
  ) => Promise<IssueCommentPayload[]> | IssueCommentPayload[];
  fetchLinkedPrs?: (
    branch: string,
  ) => Promise<LinkedPrPayload[]> | LinkedPrPayload[];
  postComment?: (
    issueNumber: number,
    body: string,
  ) => Promise<PostedCommentPayload> | PostedCommentPayload;
  mode?: string;
}

/** Result returned by {@link runHandoff}. */
interface RunHandoffResult {
  posted: boolean;
  commentUrl?: string;
  successorIds?: { newAgentId: string; newClaimId: string };
  contextScope?: string;
}

export const NON_TTY_ERROR =
  'operator interaction is required; run idd-force-handoff in an interactive TTY';

export async function runHandoff(
  options: RunHandoffOptions = {},
): Promise<RunHandoffResult> {
  const {
    isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptFn,
    repo,
    forcedBy: givenForcedBy,
    reason = 'operator-approved-recovery',
    trustedMarkerLogins: givenTrustedLogins,
    isAuthorizedForcedHandoff: givenAuthPredicate,
    fetchIssueComments,
    fetchLinkedPrs,
    postComment,
    mode,
  } = options;

  if (!isTTY) {
    throw new Error(NON_TTY_ERROR);
  }

  if ((mode ?? readForcedHandoffMode()) !== 'human-gated') {
    throw new Error(
      "forced-handoff mode is not human-gated; idd-force-handoff is only available when forcedHandoff.mode is 'human-gated'",
    );
  }

  const ask = promptFn ?? makeReadlinePrompt();

  const rawIssue = await ask('Issue number: ');
  const issueNumber = parsePositiveInteger(rawIssue, '--issue');

  const repoRef =
    repo ??
    ghText([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
  const { owner, name } = parseOwnerRepo(repoRef);

  const forcedBy =
    givenForcedBy ??
    safeGhText(['api', 'user', '--jq', '.login']).toLowerCase();
  if (!forcedBy) {
    throw new Error(
      'could not determine current GitHub user; ensure gh is authenticated',
    );
  }

  const issueComments = fetchIssueComments
    ? await fetchIssueComments(issueNumber)
    : (ghJson(
        [
          'api',
          '--paginate',
          `repos/${owner}/${name}/issues/${issueNumber}/comments`,
        ],
        true,
      ) as IssueCommentPayload[]);

  const trustedMarkerLogins =
    givenTrustedLogins ??
    buildTrustedMarkerLogins(owner, name, forcedBy, issueComments);

  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const permissionCache: CollaboratorPermissionCache = new Map();
  const isAuthorizedForcedHandoff =
    givenAuthPredicate ??
    ((actor: string) =>
      isAuthorizedForcedHandoffActor(
        owner,
        name,
        actor,
        forcedHandoffAuthorityPolicy,
        permissionCache,
      ));

  const resolveOpts = {
    trustedMarkerLogins,
    isAuthorizedForcedHandoff,
    forcedBy,
    reason,
  };

  const firstPass = planHandoff(issueComments, [], resolveOpts);

  const linkedPrs = fetchLinkedPrs
    ? await fetchLinkedPrs(firstPass.branch)
    : (ghJson([
        'pr',
        'list',
        '--repo',
        `${owner}/${name}`,
        '--head',
        firstPass.branch,
        '--state',
        'open',
        '--json',
        'number,headRefName',
      ]) as LinkedPrPayload[]);

  let plan = planHandoff(issueComments, linkedPrs, resolveOpts);

  let resolvedPrNumber: number | undefined;
  if (plan.contextScope === 'issue-plus-pr') {
    const prList = plan.prReferences.join(', ');
    const rawPr = await ask(`Open PR on branch (${prList}). Enter PR number: `);
    const prNumber = parsePositiveInteger(rawPr, '--pr');
    plan = planHandoff(issueComments, linkedPrs, { ...resolveOpts, prNumber });
    resolvedPrNumber = prNumber;
  }

  if (!plan.markerBody) {
    throw new Error(
      'cannot generate forced-handoff marker: check that forced-handoff mode is human-gated and the actor is authorized',
    );
  }

  const { newAgentId, newClaimId } = plan.successorIds;
  const lines = [
    '',
    `Forced-handoff plan for issue #${issueNumber}:`,
    `  Context:   ${plan.contextScope}`,
    `  Branch:    ${plan.branch}`,
    `  Old claim: ${plan.activeClaim.agentId} / ${plan.activeClaim.claimId}`,
    `  Successor: ${newAgentId} / ${newClaimId}`,
    ...(resolvedPrNumber ? [`  PR:        #${resolvedPrNumber}`] : []),
    '',
    'Marker preview:',
    plan.markerBody,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  const confirm = await ask('Confirm forced handoff? [y/N] ');
  ask.close?.();
  if (confirm.trim().toLowerCase() !== 'y') {
    process.stdout.write('Aborted. No changes made.\n');
    return { posted: false };
  }

  const result = postComment
    ? await postComment(issueNumber, plan.markerBody)
    : (ghJson([
        'api',
        `repos/${owner}/${name}/issues/${issueNumber}/comments`,
        '--method',
        'POST',
        '-f',
        `body=${plan.markerBody}`,
      ]) as PostedCommentPayload);

  const commentUrl = String(result.html_url ?? result.url ?? '');
  process.stdout.write(
    [
      '',
      `Forced handoff posted: ${commentUrl}`,
      `  Successor agent-id:  ${newAgentId}`,
      `  Successor claim-id:  ${newClaimId}`,
      '',
    ].join('\n'),
  );

  return {
    posted: true,
    commentUrl,
    successorIds: { newAgentId, newClaimId },
    contextScope: plan.contextScope,
  };
}

export function main(): void {
  runHandoff().catch((err: unknown) => {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

function makeReadlinePrompt(): PromptFn {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: PromptFn = (question) =>
    new Promise((resolve) =>
      rl.question(question, (answer) => {
        resolve(answer);
      }),
    );
  ask.close = () => rl.close();
  return ask;
}

function parsePositiveInteger(value: unknown, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return Number(raw);
}

function parseOwnerRepo(value: unknown): { owner: string; name: string } {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}

function ghJson(args: string[], slurp = false): unknown {
  const finalArgs = [...args];
  if (slurp) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    finalArgs.splice(1, 0, '--jq', '.[]');
    return parsePaginatedGhNdjson(
      execFileSync('gh', finalArgs, { encoding: 'utf8' }),
    );
  }
  return JSON.parse(execFileSync('gh', finalArgs, { encoding: 'utf8' }));
}

function buildTrustedMarkerLogins(
  owner: string,
  repo: string,
  viewerLogin: string,
  issueComments: IssueCommentPayload[],
): Set<string> {
  const configuredActors = readTrustedMarkerActorsFromConfig();
  const configured = [
    viewerLogin,
    ...configuredActors,
    ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
  ];
  const trusted = new Set(
    configured.filter(Boolean).map((l) => l.toLowerCase()),
  );

  if (!readCollaboratorTrustEnabled()) {
    return trusted;
  }

  const permissionCache = new Map<string, string>();
  const uniqueLogins = new Set(
    issueComments
      .map((comment) =>
        String(
          comment.user?.login ?? comment.author?.login ?? '',
        ).toLowerCase(),
      )
      .filter(Boolean),
  );
  for (const login of uniqueLogins) {
    if (trusted.has(login)) {
      continue;
    }
    const permission =
      permissionCache.get(login) ??
      safeGhText([
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ]).toLowerCase();
    permissionCache.set(login, permission);
    if (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    ) {
      trusted.add(login);
    }
  }
  return trusted;
}

function readTrustedMarkerActorsFromConfig(): string[] {
  try {
    const config = JSON.parse(
      readFileSync('.github/idd/config.json', 'utf8'),
    ) as { trustedMarkerActors?: unknown };
    const actors = config?.trustedMarkerActors;
    if (Array.isArray(actors)) {
      return actors.map(String).filter(Boolean);
    }
  } catch {
    // config absent or unreadable
  }
  return [];
}

function readCollaboratorTrustEnabled(): boolean {
  try {
    const config = JSON.parse(
      readFileSync('.github/idd/config.json', 'utf8'),
    ) as {
      markerTrust?: { allowCollaboratorMarkers?: unknown } | null;
      markerTrustAllowCollaboratorMarkers?: unknown;
      allowCollaboratorMarkers?: unknown;
    };
    const nested = config?.markerTrust?.allowCollaboratorMarkers;
    const topLevel =
      config?.markerTrustAllowCollaboratorMarkers ??
      config?.allowCollaboratorMarkers;
    const value = nested ?? topLevel;
    if (typeof value === 'boolean') {
      return value;
    }
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function splitCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  main();
}
