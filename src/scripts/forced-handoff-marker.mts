#!/usr/bin/env node
// idd-generated-from: src/scripts/forced-handoff-marker.mts
//
// The scripts/forced-handoff-marker.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
  resolveTrustedCollaboratorMarkerLogins,
} from './collaborator-permission.mts';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import type { ClaimValidationSummary } from './protocol-helpers.mts';
import {
  parsePaginatedGhNdjson,
  readClaimStaleAgeMs,
  renderForcedHandoffComment,
  summarizeClaimValidationForWriteGate,
  unionTrustedMarkerActorSources,
} from './protocol-helpers.mts';
import { fetchLastEditedAtByNodeId } from './provider-adapter-github.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
  node_id?: string | null;
  lastEditedAt?: string | null;
}

/** Linked-PR row returned by `gh pr list --json number,headRefName`. */
interface LinkedPrPayload {
  number?: number | string | null;
  headRefName?: string | null;
}

/** Active claim resolved from the trusted claim-marker stream. */
type ActiveClaim = ClaimValidationSummary['activeClaim'];

/** Trusted-marker login collection accepted by the claim resolver. */
type TrustedMarkerLoginsInput =
  | unknown[]
  | Set<string>
  | string
  | null
  | undefined;

/** Options accepted by {@link planHandoff}. */
interface PlanHandoffOptions {
  newAgentId?: string;
  newClaimId?: string;
  prNumber?: number;
  forcedBy?: string;
  reason?: string;
  timestamp?: string;
  trustedMarkerLogins?: TrustedMarkerLoginsInput;
  isAuthorizedForcedHandoff?: (forcedBy: string) => boolean;
  /** Configured `claimTiming.staleAge` window (#3270), e.g. via
   * {@link readClaimStaleAgeMs}. Threaded into {@link resolveHelperActiveClaim}
   * so a takeover claim inside that window resolves as active instead of
   * being silently evaluated against the hardcoded 24h default. REQUIRED
   * (Copilot review, PR #3370): `resolveHelperActiveClaim` is a
   * claim-owning write-gate resolver, so every caller -- including
   * `force-handoff.mts`'s interactive facade and `external-check-waiver.mts`,
   * not just this file's own CLI -- must resolve and pass it explicitly, the
   * same requirement `resolveActiveClaimForWriteGate` /
   * `summarizeClaimValidationForWriteGate` already enforce for the other
   * seven write-gate callers. A caller that deliberately wants the
   * distributed 24h default passes {@link DEFAULT_STALE_AGE_MS} explicitly. */
  staleAgeMs: number;
}

/** Successor identifiers generated for a forced handoff. */
interface SuccessorIds {
  newAgentId: string;
  newClaimId: string;
}

/** Structured execution plan returned by {@link planHandoff}. */
interface HandoffPlan {
  activeClaim: ActiveClaim;
  branch: string;
  contextScope: string;
  prReferences: string[];
  markerBody: string | null;
  successorIds: SuccessorIds;
}

/** Parsed CLI arguments. */
interface ForcedHandoffMarkerArgs {
  format: string;
  trustedMarkerLogins: string;
  issueNumber?: number;
  prNumber?: number;
  newAgentId?: string;
  newClaimId?: string;
  forcedBy?: string;
  reason?: string;
  timestamp?: string;
  repo?: string;
  plan?: boolean;
  help?: boolean;
}

export function generateSuccessorIds(baseAgentId: unknown): SuccessorIds {
  return {
    newAgentId: String(baseAgentId || 'idd-agent'),
    newClaimId: `claim-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
  };
}

export function planHandoff(
  issueComments: IssueCommentPayload[],
  linkedPrs: LinkedPrPayload[] | null | undefined,
  options: PlanHandoffOptions,
): HandoffPlan {
  const {
    newAgentId,
    newClaimId,
    prNumber,
    forcedBy,
    reason,
    timestamp,
    trustedMarkerLogins,
    isAuthorizedForcedHandoff,
    staleAgeMs,
  } = options;

  const resolveOpts = {
    isAuthorizedForcedHandoff:
      typeof isAuthorizedForcedHandoff === 'function'
        ? isAuthorizedForcedHandoff
        : () => false,
    staleAgeMs,
  };

  // First pass: resolve without PR filter to obtain the claim branch.
  const firstPassClaim = resolveHelperActiveClaim(
    issueComments,
    trustedMarkerLogins ?? [],
    resolveOpts,
  );

  if (!firstPassClaim) {
    throw new Error('issue has no active trusted claim');
  }

  const matchingPrs = (linkedPrs ?? []).filter(
    (pr) => String(pr.headRefName ?? '') === firstPassClaim.branch,
  );
  const contextScope = matchingPrs.length > 0 ? 'issue-plus-pr' : 'issue-only';
  const prReferences = matchingPrs.map((pr) => String(pr.number));

  if (prNumber !== undefined) {
    const prRef = String(prNumber);
    if (!prReferences.includes(prRef)) {
      throw new Error(
        `PR #${prNumber} does not match any open PR on claim branch ${firstPassClaim.branch}` +
          (prReferences.length > 0
            ? `; expected one of: ${prReferences.join(', ')}`
            : ''),
      );
    }
  }

  // Second pass: when an open PR is part of the plan, re-resolve with an
  // expectedLinkedPrs filter so that prior issue-only forced-handoff markers
  // are correctly rejected for PR-scoped claim replay.
  let activeClaim = firstPassClaim;
  if (contextScope === 'issue-plus-pr') {
    const expectedLinkedPrs =
      prNumber !== undefined ? [String(prNumber)] : prReferences;
    const filteredClaim = resolveHelperActiveClaim(
      issueComments,
      trustedMarkerLogins ?? [],
      { ...resolveOpts, expectedLinkedPrs },
    );
    if (filteredClaim) {
      activeClaim = filteredClaim;
    }
  }

  const generated = generateSuccessorIds(activeClaim.agentId);
  const successorIds = {
    newAgentId: newAgentId ?? generated.newAgentId,
    newClaimId: newClaimId ?? generated.newClaimId,
  };

  let markerBody: string | null = null;
  if (forcedBy && reason) {
    // Validate the approving actor before rendering the marker body so that
    // plan output cannot preview a marker that claim resolution would reject.
    // Reuse the fail-closed-defaulted callback so a missing authorizer is
    // unauthorized here exactly as it is during claim resolution.
    const authorized = resolveOpts.isAuthorizedForcedHandoff(forcedBy);
    if (authorized) {
      const resolvedLinkedPr =
        prNumber !== undefined ? String(prNumber) : prReferences[0];
      const payload = {
        oldAgentId: activeClaim.agentId,
        oldClaimId: activeClaim.claimId,
        newAgentId: successorIds.newAgentId,
        newClaimId: successorIds.newClaimId,
        branch: activeClaim.branch,
        ...(contextScope === 'issue-plus-pr' && resolvedLinkedPr
          ? { linkedPr: resolvedLinkedPr }
          : {}),
        forcedBy,
        reason,
        timestamp: timestamp ?? currentIsoTimestamp(),
        contextScope,
      };
      markerBody = renderForcedHandoffComment(payload);
    }
  }

  return {
    activeClaim,
    branch: activeClaim.branch,
    contextScope,
    prReferences,
    markerBody,
    successorIds,
  };
}

export function main(argv: string[] = process.argv.slice(2)): HelperCliResult {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return 0;
  }

  if (!args.issueNumber) {
    throw markCliUsageError(
      new Error('missing required --issue <number> argument'),
    );
  }
  if (!args.forcedBy) {
    throw markCliUsageError(
      new Error('missing required --forced-by <actor> argument'),
    );
  }
  if (!args.reason) {
    throw markCliUsageError(
      new Error('missing required --reason <text> argument'),
    );
  }

  if (args.plan) {
    const repoRef =
      args.repo ??
      ghText([
        'repo',
        'view',
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
      ]);
    const { owner, name } = parseOwnerRepo(repoRef);
    const issueComments = resolveIssueCommentEditStates(
      ghJson(
        [
          'api',
          '--paginate',
          `repos/${owner}/${name}/issues/${args.issueNumber}/comments`,
        ],
        true,
      ) as IssueCommentPayload[],
    );
    const viewerLogin = safeGhText([
      'api',
      'user',
      '--jq',
      '.login',
    ]).toLowerCase();
    const permissionCache: CollaboratorPermissionCache = new Map();
    const { logins: trustedMarkerLogins, sources: trustedMarkerActorsSources } =
      buildTrustedMarkerLogins(
        owner,
        name,
        viewerLogin,
        args.trustedMarkerLogins,
        issueComments,
        permissionCache,
      );
    const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
    const staleAgeMs = readClaimStaleAgeMs(loadIddConfig());

    const tempClaim = resolveHelperActiveClaim(
      issueComments,
      trustedMarkerLogins,
      {
        isAuthorizedForcedHandoff: (forcedBy) =>
          isAuthorizedForcedHandoffActor(
            owner,
            name,
            forcedBy,
            forcedHandoffAuthorityPolicy,
            permissionCache,
          ),
        staleAgeMs,
      },
    );

    let linkedPrs: LinkedPrPayload[] = [];
    if (tempClaim) {
      linkedPrs = ghJson([
        'pr',
        'list',
        '--repo',
        `${owner}/${name}`,
        '--head',
        tempClaim.branch,
        '--state',
        'open',
        '--json',
        'number,headRefName',
      ]) as LinkedPrPayload[];
    }

    const modeEnabled = readForcedHandoffMode() === 'human-gated';
    const plan = planHandoff(issueComments, linkedPrs, {
      newAgentId: args.newAgentId,
      newClaimId: args.newClaimId,
      prNumber: args.prNumber,
      forcedBy: modeEnabled ? args.forcedBy : undefined,
      reason: modeEnabled ? args.reason : undefined,
      timestamp: args.timestamp,
      trustedMarkerLogins,
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(
          owner,
          name,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          permissionCache,
        ),
      staleAgeMs,
    });

    console.log(
      JSON.stringify(
        {
          repository: `${owner}/${name}`,
          issueNumber: args.issueNumber,
          modeEnabled,
          trustedMarkerActors: [...trustedMarkerLogins].sort(),
          trustedMarkerActorsSources,
          ...plan,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!args.newAgentId) {
    throw markCliUsageError(
      new Error('missing required --new-agent-id <id> argument'),
    );
  }
  if (!args.newClaimId) {
    throw markCliUsageError(
      new Error('missing required --new-claim-id <id> argument'),
    );
  }

  const repoRef =
    args.repo ??
    ghText([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
  const { owner, name } = parseOwnerRepo(repoRef);
  if (readForcedHandoffMode() !== 'human-gated') {
    throw new Error(
      'forced-handoff mode is not human-gated; marker generation is disabled',
    );
  }
  const issueComments = resolveIssueCommentEditStates(
    ghJson(
      [
        'api',
        '--paginate',
        `repos/${owner}/${name}/issues/${args.issueNumber}/comments`,
      ],
      true,
    ) as IssueCommentPayload[],
  );
  const viewerLogin = safeGhText([
    'api',
    'user',
    '--jq',
    '.login',
  ]).toLowerCase();
  const permissionCache: CollaboratorPermissionCache = new Map();
  const { logins: trustedMarkerLogins, sources: trustedMarkerActorsSources } =
    buildTrustedMarkerLogins(
      owner,
      name,
      viewerLogin,
      args.trustedMarkerLogins,
      issueComments,
      permissionCache,
    );
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const activeClaim = resolveHelperActiveClaim(
    issueComments,
    trustedMarkerLogins,
    {
      expectedLinkedPrs: args.prNumber
        ? [
            String(args.prNumber),
            `https://github.com/${owner}/${name}/pull/${args.prNumber}`,
          ]
        : [],
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(
          owner,
          name,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          permissionCache,
        ),
      staleAgeMs: readClaimStaleAgeMs(loadIddConfig()),
    },
  );

  if (!activeClaim) {
    throw new Error(`issue #${args.issueNumber} has no active trusted claim`);
  }

  if (
    !isAuthorizedForcedHandoffActor(
      owner,
      name,
      args.forcedBy,
      forcedHandoffAuthorityPolicy,
      permissionCache,
    )
  ) {
    throw new Error(
      `--forced-by actor ${args.forcedBy} is not authorized under ${forcedHandoffAuthorityPolicy}`,
    );
  }

  let linkedPr = '';
  if (args.prNumber) {
    const pr = ghJson([
      'pr',
      'view',
      String(args.prNumber),
      '-R',
      `${owner}/${name}`,
      '--json',
      'headRefName,url',
      '--jq',
      '.',
    ]) as { headRefName?: unknown };
    const headRefName = String(pr.headRefName ?? '');
    if (headRefName !== activeClaim.branch) {
      throw new Error(
        `PR #${args.prNumber} head branch ${headRefName} does not match active claim branch ${activeClaim.branch}`,
      );
    }
    linkedPr = String(args.prNumber);
  }

  const payload = {
    oldAgentId: activeClaim.agentId,
    oldClaimId: activeClaim.claimId,
    newAgentId: args.newAgentId,
    newClaimId: args.newClaimId,
    branch: activeClaim.branch,
    ...(linkedPr ? { linkedPr } : {}),
    forcedBy: args.forcedBy,
    reason: args.reason,
    timestamp: args.timestamp ?? currentIsoTimestamp(),
    contextScope: linkedPr ? 'issue-plus-pr' : 'issue-only',
  };

  const commentBody = renderForcedHandoffComment(payload);
  if (args.format === 'json') {
    console.log(
      JSON.stringify(
        {
          repository: `${owner}/${name}`,
          issueNumber: args.issueNumber,
          trustedMarkerActors: [...trustedMarkerLogins].sort(),
          trustedMarkerActorsSources,
          activeClaim,
          payload,
          commentBody,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(commentBody);
  }
  return 0;
}

export function resolveHelperActiveClaim(
  issueComments: IssueCommentPayload[],
  trustedMarkerLogins: TrustedMarkerLoginsInput,
  options: {
    expectedLinkedPrs?: string[];
    isAuthorizedForcedHandoff?: (forcedBy: string) => boolean;
    /** Configured `claimTiming.staleAge` window (#3270), e.g. via
     * {@link readClaimStaleAgeMs}. REQUIRED (Copilot review, PR #3370):
     * this is a claim-owning write-gate resolver, so every caller --
     * `force-handoff.mts`'s interactive facade and
     * `external-check-waiver.mts` included -- must resolve and pass it
     * explicitly, the same requirement the other seven write-gate callers
     * already meet. A caller that deliberately wants the distributed 24h
     * default passes {@link DEFAULT_STALE_AGE_MS} explicitly. */
    staleAgeMs: number;
  },
): ActiveClaim | null {
  const trustedSources = Array.isArray(trustedMarkerLogins)
    ? trustedMarkerLogins
    : trustedMarkerLogins instanceof Set
      ? [...trustedMarkerLogins]
      : splitCsv(trustedMarkerLogins);
  const trustedLogins = new Set(
    trustedSources
      .map((login) =>
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const summary = summarizeClaimValidationForWriteGate(
    issueComments.map(normalizeIssueComment),
    {
      trustedMarkerLogins: [...trustedLogins],
      forcedHandoffEnabled: true,
      expectedLinkedPrs: options.expectedLinkedPrs ?? [],
      isAuthorizedForcedHandoff:
        typeof options.isAuthorizedForcedHandoff === 'function'
          ? options.isAuthorizedForcedHandoff
          : () => false,
      staleAgeMs: options.staleAgeMs,
    },
  );

  return summary.activeClaimPresent ? summary.activeClaim : null;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const FORCED_HANDOFF_MARKER_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--pr': { type: 'string' },
  '--new-agent-id': { type: 'string' },
  '--new-claim-id': { type: 'string' },
  '--forced-by': { type: 'string' },
  '--reason': { type: 'string' },
  '--timestamp': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--repo': { type: 'string' },
  '--format': { type: 'string', default: 'text' },
  '--plan': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

export function parseArgs(argv: string[]): ForcedHandoffMarkerArgs {
  const { values, help } = parseCliArgs(argv, FORCED_HANDOFF_MARKER_FLAG_SPEC);

  const format = values.format as string;
  if (format !== 'text' && format !== 'json') {
    throw markCliUsageError(new Error(`unsupported --format value: ${format}`));
  }

  return {
    format,
    trustedMarkerLogins: values['trusted-marker-logins'] as string,
    // parsePositiveInteger keeps its existing throw-on-invalid contract
    // unchanged; only called when the flag is actually present, so an
    // absent --issue/--pr still resolves to undefined (this file's own
    // "not requested" sentinel -- see the `!== undefined` checks
    // elsewhere in this module) rather than throwing.
    issueNumber:
      values.issue === undefined
        ? undefined
        : parsePositiveInteger(values.issue as string, '--issue'),
    prNumber:
      values.pr === undefined
        ? undefined
        : parsePositiveInteger(values.pr as string, '--pr'),
    newAgentId: values['new-agent-id'] as string | undefined,
    newClaimId: values['new-claim-id'] as string | undefined,
    forcedBy: values['forced-by'] as string | undefined,
    reason: values.reason as string | undefined,
    timestamp: values.timestamp as string | undefined,
    repo: values.repo as string | undefined,
    plan: values.plan as boolean,
    help,
  };
}

export function buildTrustedMarkerLogins(
  owner: string,
  repo: string,
  viewerLogin: string,
  cliLogins: string,
  issueComments: IssueCommentPayload[],
  cache?: CollaboratorPermissionCache,
): { logins: Set<string>; sources: string[] } {
  // Parse the config once and share it between the actor union and the
  // collaborator-trust toggle.
  const config = loadIddConfig();
  const sources: string[] = [];
  if (String(viewerLogin ?? '').trim()) {
    sources.push('viewer');
  }
  const flagActors = splitCsv(cliLogins);
  if (flagActors.length > 0) {
    sources.push('flag');
  }
  const union = unionTrustedMarkerActorSources({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config,
    extraActors: [viewerLogin, ...flagActors],
  });
  sources.push(...union.sources);
  const trusted = new Set(union.actors);
  if (!readCollaboratorTrustEnabled(config)) {
    return { logins: trusted, sources };
  }

  // #1693 parity (kurone-kito/idd-skill#3340): delegate the
  // collaborator-widening step to resolveTrustedCollaboratorMarkerLogins
  // (marker-authors-first, collaborator-permission.mts) -- the same
  // migration force-handoff.mts already made -- instead of
  // permission-checking every unique issue-comment author. Checking
  // every commenter over-trusted an ordinary write+ collaborator who
  // never posted an operational marker.
  const collaboratorLogins = resolveTrustedCollaboratorMarkerLogins(
    owner,
    repo,
    issueComments,
    { cache },
  );
  let collaboratorAdded = false;
  for (const login of collaboratorLogins) {
    if (!trusted.has(login)) {
      trusted.add(login);
      collaboratorAdded = true;
    }
  }
  if (collaboratorAdded) {
    sources.push('collaborators');
  }
  return { logins: trusted, sources };
}

function normalizeIssueComment(comment: IssueCommentPayload): {
  body: string;
  createdAt: string;
  author: { login: string };
  lastEditedAt?: string | null;
} {
  return {
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: {
      login: comment.user?.login ?? '',
    },
    lastEditedAt: comment.lastEditedAt,
  };
}

function resolveIssueCommentEditStates(
  comments: IssueCommentPayload[],
): IssueCommentPayload[] {
  const nodeIds = comments.map((comment) => String(comment.node_id ?? ''));
  if (nodeIds.some((nodeId) => nodeId === '')) {
    throw new Error(
      'forced-handoff-marker: issue comment is missing node_id, cannot resolve edit state',
    );
  }
  const lastEditedAtByNodeId = fetchLastEditedAtByNodeId(ghText, nodeIds);
  return comments.map((comment) => {
    const nodeId = String(comment.node_id ?? '');
    if (!lastEditedAtByNodeId.has(nodeId)) {
      throw new Error(
        `forced-handoff-marker: missing edit-state resolution for comment ${nodeId}`,
      );
    }
    return { ...comment, lastEditedAt: lastEditedAtByNodeId.get(nodeId) };
  });
}

function splitCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

export function parsePositiveInteger(value: unknown, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw markCliUsageError(new Error(`invalid ${flag} value: ${value}`));
  }
  return Number(raw);
}

function parseOwnerRepo(value: unknown): { owner: string; name: string } {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw markCliUsageError(
      new Error(`invalid --repo value: ${value} (expected owner/name)`),
    );
  }
  return {
    owner: match[1],
    name: match[2],
  };
}

function ghJson(args: string[], slurp = false): unknown {
  const finalArgs = [...args];
  if (slurp) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    finalArgs.splice(1, 0, '--jq', '.[]');
    return parsePaginatedGhNdjson(
      ghText(finalArgs, { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS }),
    );
  }
  return JSON.parse(ghText(finalArgs));
}

function readCollaboratorTrustEnabled(config: unknown = null): boolean {
  try {
    return resolveCollaboratorMarkerTrust(
      config ?? JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}

export function currentIsoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function printUsage(): void {
  console.log(`usage: node scripts/forced-handoff-marker.mjs --issue <number> [options]

Options:
  --plan                           derive live PR context and emit a structured execution plan;
                                   --new-agent-id and --new-claim-id become optional (auto-generated)
  --pr <number>                    optional PR number for issue-plus-pr context
  --new-agent-id <id>              successor session agent id (required without --plan)
  --new-claim-id <id>              successor claim id (required without --plan)
  --forced-by <actor>              approving human actor recorded in the marker
  --reason <text>                  why the prior session is considered unavailable
  --timestamp <ISO8601>            override the marker payload timestamp (default: current UTC)
  --trusted-marker-logins <csv>    additional trusted marker authors for claim reconstruction
  --repo <owner/name>              repository override
  --format <text|json>             output format for marker mode (default: text)
  --help                           show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS        comma-separated trusted bot/app logins
                                   (combined with config.json trustedMarkerActors)
  IDD_TRUST_COLLABORATOR_MARKERS   set true to trust Write/Maintain/Admin collaborators
`);
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('forced-handoff-marker', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}
