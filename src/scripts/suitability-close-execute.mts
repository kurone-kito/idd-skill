#!/usr/bin/env node
// idd-generated-from: src/scripts/suitability-close-execute.mts
//
// The scripts/suitability-close-execute.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// #1485: the gated pre-claim high-confidence duplicate/superseded close
// path. Reuses `#1484`'s detect-only Check 4 evidence collection
// (`collectHighConfidenceDuplicateEvidence` in `suitability-triage.mts`) and
// evaluation kernel (`evaluateHighConfidenceDuplicate` in
// `supersession-detection.mts`) verbatim -- this file introduces NO new
// detection logic, only the gated mutation on top of an already-established
// `tier: 'high-confidence'` verdict.
//
// This helper does NOT post the initial coordination claim itself -- exactly
// like `idd-roadmap-audit-execute.mts` does not post the A1.5 roadmap-audit
// claim -- the caller posts it with the generic `post-idd-marker.mjs --type
// claim --branch suitability-close/<n>-<slug>` path first, then invokes this
// helper to re-validate it, evaluate close-eligibility, and (under --apply)
// post the evidence-bound close comment, close the issue, and release the
// claim, in that order. `--apply` fails closed (no mutation) on any lost /
// stale / non-owned claim, or when the fresh re-evaluation no longer finds a
// high-confidence signal.

import { parseCliArgs } from './cli-args.mts';
import {
  isClaimStaleByAge,
  parseClaimStaleAgeMs,
} from './discover-roadmap-graph.mts';
import { loadPolicyConfig } from './idd-config.mts';
import type { ClaimValidationSummary } from './protocol-helpers.mts';
import {
  renderUnclaimedByMarker,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';
import { collectHighConfidenceDuplicateEvidence } from './suitability-triage.mts';
import {
  type CheckOutcome,
  evaluateHighConfidenceDuplicate,
} from './supersession-detection.mts';

const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MANIFEST_PATH = 'audit/sync-manifest.json';
const DEFAULT_BUNDLE_IDS = ['bundle-review', 'bundle-merge'];

/**
 * Branch pattern for a suitability-close coordination claim on issue
 * `issueNumber`: a logical coordination name (no worktree), mirroring A1.5's
 * `roadmap-audit/<n>-<slug>` shape. Scoped to `issueNumber` so this never
 * matches a claim posted for a different candidate, and its `suitability-
 * close/*` prefix never matches `issue/*`, so the core cwd-vs-claim gate
 * (`idd-overview-core.instructions.md`) naturally excludes it from the
 * worktree-mutation checks that gate applies only to `issue/*` claims.
 */
export function suitabilityCloseBranchPattern(issueNumber: number): RegExp {
  return new RegExp(`^suitability-close/${issueNumber}-`);
}

/** Verdict shape for {@link evaluateSuitabilityCloseClaim} -- mirrors
 * `idd-roadmap-audit-execute.mts`'s `RoadmapClaimVerdict` shape so the two
 * claim-verification surfaces stay recognizably parallel. */
export interface SuitabilityCloseClaimVerdict {
  owned: boolean;
  reason: string;
  stale: boolean;
  activeClaim: ClaimValidationSummary['activeClaim'];
}

/**
 * Re-validate a suitability-close coordination claim on `options.issueNumber`
 * against the live comment stream: the active claim must match the expected
 * claim-id/agent-id (`summarizeClaimValidation`), use the
 * `suitability-close/<issueNumber>-*` coordination branch (a normal
 * `issue/*` implementation claim on the same issue never authorizes this
 * close), and not be stale.
 */
export function evaluateSuitabilityCloseClaim(
  comments: Parameters<typeof summarizeClaimValidation>[0],
  options: {
    issueNumber: number;
    expectedClaimId: string;
    expectedAgentId?: string;
    isTrustedAuthor: (login: string) => boolean;
    nowIso: string;
    staleAgeMs?: number;
  },
): SuitabilityCloseClaimVerdict {
  const summary = summarizeClaimValidation(comments, {
    isTrustedAuthor: options.isTrustedAuthor,
    expectedClaimId: options.expectedClaimId,
    expectedAgentId: options.expectedAgentId,
  });
  if (!summary.matchesExpectedClaim) {
    return {
      owned: false,
      reason: summary.reason,
      stale: false,
      activeClaim: summary.activeClaim,
    };
  }
  if (
    !suitabilityCloseBranchPattern(options.issueNumber).test(
      summary.activeClaim.branch,
    )
  ) {
    return {
      owned: false,
      reason: 'claim-branch-mismatch',
      stale: false,
      activeClaim: summary.activeClaim,
    };
  }
  const stale = isClaimStaleByAge(
    summary.activeClaim.createdAt,
    options.nowIso,
    options.staleAgeMs ?? DEFAULT_CLAIM_STALE_AGE_MS,
  );
  if (stale) {
    return {
      owned: false,
      reason: 'claim-stale',
      stale: true,
      activeClaim: summary.activeClaim,
    };
  }
  return {
    owned: true,
    reason: 'match',
    stale: false,
    activeClaim: summary.activeClaim,
  };
}

/**
 * The pure close-eligibility decision (#1485's own acceptance criteria:
 * "on the strong signal only... on any weaker signal it does not close").
 * Gates on `tier === 'high-confidence'` EXACTLY, never on `pass: false` or
 * `outcome: duplicate` alone -- a weak title/declaration heuristic hit
 * shares the identical `pass: false` shape and MUST NOT authorize a close.
 * `checkOutcome` is `evaluateHighConfidenceDuplicate`'s own return value
 * (`null` when no strong signal fires, matching that kernel's own
 * never-fail-toward-a-false-positive contract). Exported and pure so
 * `tests/*.test.mts` can cover strong-signal-close and no-signal-no-close
 * without shelling out to `gh`.
 */
export function evaluateSuitabilityCloseEligibility(
  checkOutcome: CheckOutcome | null,
): { eligible: boolean; evidence: string | null } {
  if (
    checkOutcome &&
    checkOutcome.pass === false &&
    checkOutcome.tier === 'high-confidence'
  ) {
    return { eligible: true, evidence: checkOutcome.evidence };
  }
  return { eligible: false, evidence: null };
}

/** Render the evidence-bound closing comment. `evidence` is always the
 * machine-derivable string `evaluateHighConfidenceDuplicate` itself already
 * produces (PR number(s) and/or overlapping file path(s)) -- this renderer
 * adds no prose evidence of its own.
 *
 * Copilot review finding on PR #2558: `runSuitabilityCloseExecute` posts
 * this comment BEFORE calling `closeIssue` (evidence-first, matching
 * `idd-roadmap-audit-execute.mts`'s own evidence-then-close order), so the
 * wording below deliberately describes the close as in-progress rather
 * than already complete -- a `closeIssue` failure after this comment posts
 * must never leave a false "already closed" claim on an issue that is
 * still open. */
export function buildSuitabilityCloseComment(evidence: string): string {
  return [
    'A4.5 high-confidence duplicate/superseded close',
    '',
    evidence,
    '',
    '_Closing this candidate autonomously under the `#1485` gated',
    'pre-claim close path: a strong mechanical signal only (closing-PR',
    'reference, same-`## Candidate files` overlap, or an exact',
    'branch-name match), never the weak title/declaration heuristic. If',
    'this close is wrong, reopen the issue -- the close is reversible and',
    'a wrong close is an accepted, recoverable risk._',
  ].join('\n');
}

/**
 * Validate and normalize the apply-time "now" to UTC second-precision ISO
 * (`YYYY-MM-DDTHH:mm:ssZ`), or `null` when unparseable. Mirrors
 * `idd-roadmap-audit-execute.mts`'s own `normalizeApplyNow` (Copilot review
 * finding on PR #2558): `deps.now()`'s production wiring is plain
 * `new Date().toISOString()`, which always carries millisecond precision,
 * but `renderUnclaimedByMarker` accepts only second-precision `…Z` and
 * throws otherwise -- and by the time `releaseClaim` runs, the evidence
 * comment and the close have already landed, so a throw here would leave
 * the issue closed with the coordination claim never released. Normalizing
 * once, fail-closed, before any mutation avoids that partial-completion
 * state entirely; the single normalized value is reused for both claim
 * re-validation and the release-marker timestamp.
 */
export function normalizeApplyNow(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SuitabilityCloseExecuteVerdict {
  protocolVersion: '1';
  mode: 'dry-run' | 'apply';
  issueNumber: number;
  ready: boolean;
  eligible: boolean;
  evidence: string | null;
  claim: SuitabilityCloseClaimVerdict | null;
  closed: boolean;
  result: string;
}

export interface SuitabilityCloseExecuteDeps {
  getIssue: (issueNumber: number) => {
    number: number;
    title: string;
    body: string;
    createdAt: string;
  } | null;
  loadIssueComments: (
    issueNumber: number,
  ) => Parameters<typeof summarizeClaimValidation>[0];
  collectEvidence: (issue: {
    number: number;
    title: string;
    body: string;
    createdAt: string;
  }) => CheckOutcome | null;
  isTrustedAuthor: (login: string) => boolean;
  postCloseComment: (issueNumber: number, body: string) => void;
  closeIssue: (issueNumber: number) => void;
  releaseClaim: (
    issueNumber: number,
    fields: { agentId: string; claimId: string; timestamp: string },
  ) => void;
  now: () => string;
  staleAgeMs?: number;
}

export interface SuitabilityCloseExecuteArgs {
  issue: number | null;
  apply: boolean;
  claimId: string;
  agentId: string;
  owner: string;
  repo: string;
  policy: string;
  now: string;
  help: boolean;
}

/**
 * Evaluate (dry-run) and, when ready and `--apply` is set, execute the
 * `#1485` gated close. Dry-run performs NO mutation. `--apply` re-validates
 * the coordination claim and re-collects evidence immediately before
 * mutating -- both must still hold at that instant, not merely at some
 * earlier check -- then posts the evidence-bound close comment, closes the
 * issue, and releases the claim, in that order. Fails closed (no mutation)
 * on a lost/stale/non-owned claim or a no-longer-eligible fresh evaluation.
 */
export function runSuitabilityCloseExecute(
  args: SuitabilityCloseExecuteArgs,
  deps: SuitabilityCloseExecuteDeps,
): SuitabilityCloseExecuteVerdict {
  // Copilot review finding on PR #2558: `runCli` validates `args.issue !==
  // null` before ever constructing `args`, but that guard lives outside
  // this exported function -- a direct caller (bypassing `runCli`) could
  // still pass `issue: null`. Re-check here instead of trusting the `as
  // number` cast, so a direct call degrades to a clean not-found verdict
  // rather than an unsafe null flowing into `deps.getIssue`.
  // Copilot review finding on PR #2558: Number.isInteger(-1) is true, so
  // the earlier null + integer-ness guard alone still let a negative
  // issue number through to deps.getIssue. Require positive, matching the
  // error message's own "must be a positive integer" contract.
  if (args.issue === null || !Number.isInteger(args.issue) || args.issue <= 0) {
    return {
      protocolVersion: '1',
      mode: args.apply ? 'apply' : 'dry-run',
      issueNumber: Number.NaN,
      ready: false,
      eligible: false,
      evidence: null,
      claim: null,
      closed: false,
      result: '--issue is required and must be a positive integer',
    };
  }
  const issueNumber = args.issue;
  const issue = deps.getIssue(issueNumber);
  if (!issue) {
    return {
      protocolVersion: '1',
      mode: args.apply ? 'apply' : 'dry-run',
      issueNumber,
      ready: false,
      eligible: false,
      evidence: null,
      claim: null,
      closed: false,
      result: `issue #${issueNumber} not found or inaccessible`,
    };
  }

  const checkOutcome = deps.collectEvidence(issue);
  const eligibility = evaluateSuitabilityCloseEligibility(checkOutcome);

  if (!args.apply) {
    return {
      protocolVersion: '1',
      mode: 'dry-run',
      issueNumber,
      ready: eligibility.eligible,
      eligible: eligibility.eligible,
      evidence: eligibility.evidence,
      claim: null,
      closed: false,
      result: eligibility.eligible
        ? 'high-confidence signal found; ready for --apply'
        : 'no high-confidence signal; not ready to close',
    };
  }

  if (!eligibility.eligible) {
    return {
      protocolVersion: '1',
      mode: 'apply',
      issueNumber,
      ready: false,
      eligible: false,
      evidence: null,
      claim: null,
      closed: false,
      result:
        'no high-confidence signal on this fresh re-evaluation; no mutation',
    };
  }

  const rawNow = deps.now();
  const nowIso = normalizeApplyNow(rawNow);
  if (nowIso === null) {
    return {
      protocolVersion: '1',
      mode: 'apply',
      issueNumber,
      ready: true,
      eligible: true,
      evidence: eligibility.evidence,
      claim: null,
      closed: false,
      result: `deps.now() returned an unparseable timestamp (${rawNow}); no mutation`,
    };
  }
  const claim = evaluateSuitabilityCloseClaim(
    deps.loadIssueComments(issueNumber),
    {
      issueNumber,
      expectedClaimId: args.claimId,
      expectedAgentId: args.agentId,
      isTrustedAuthor: deps.isTrustedAuthor,
      nowIso,
      staleAgeMs: deps.staleAgeMs,
    },
  );
  if (!claim.owned) {
    return {
      protocolVersion: '1',
      mode: 'apply',
      issueNumber,
      ready: true,
      eligible: true,
      evidence: eligibility.evidence,
      claim,
      closed: false,
      result: `coordination claim not owned (${claim.reason}); no mutation`,
    };
  }

  const evidence = eligibility.evidence as string;
  deps.postCloseComment(issueNumber, buildSuitabilityCloseComment(evidence));

  // Copilot review finding on PR #2558 (suppressed comment): the claim was
  // validated once, above, before posting the comment -- but the comment
  // POST is itself a network round-trip another session's takeover could
  // race during. Re-validate immediately before the actual close mutation,
  // mirroring idd-roadmap-audit-execute.mts's own re-validate-before-close
  // pattern, so a claim lost in the comment->close gap aborts the close
  // (the claim's rightful new owner still sees the evidence comment, but
  // this session never closes an issue it no longer owns).
  const finalClaim = evaluateSuitabilityCloseClaim(
    deps.loadIssueComments(issueNumber),
    {
      issueNumber,
      expectedClaimId: args.claimId,
      expectedAgentId: args.agentId,
      isTrustedAuthor: deps.isTrustedAuthor,
      nowIso,
      staleAgeMs: deps.staleAgeMs,
    },
  );
  if (!finalClaim.owned) {
    return {
      protocolVersion: '1',
      mode: 'apply',
      issueNumber,
      ready: true,
      eligible: true,
      evidence,
      claim: finalClaim,
      closed: false,
      result: `coordination claim lost between the comment and the close (${finalClaim.reason}); issue left open`,
    };
  }

  deps.closeIssue(issueNumber);
  deps.releaseClaim(issueNumber, {
    agentId: args.agentId,
    claimId: args.claimId,
    timestamp: nowIso,
  });

  return {
    protocolVersion: '1',
    mode: 'apply',
    issueNumber,
    ready: true,
    eligible: true,
    evidence,
    claim: finalClaim,
    closed: true,
    result: 'closed: high-confidence duplicate/superseded, evidence posted',
  };
}

// ---------------------------------------------------------------------------
// Production dependency wiring (live gh)
// ---------------------------------------------------------------------------

function loadIssueComments(
  port: ProviderPort,
  issueNumber: number,
): { body: string; createdAt: string; author: { login: string } }[] {
  return port.listWorkItemComments(issueNumber).map((comment) => ({
    body: comment.body,
    createdAt: comment.createdAt,
    author: { login: comment.authorLogin },
  }));
}

function buildTrustedAuthorPredicate({
  owner,
  viewerLogin,
  rawConfig,
}: {
  owner: string;
  viewerLogin: string;
  rawConfig: { trustedMarkerActors?: unknown } | null;
}): (login: string) => boolean {
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: rawConfig,
  });
  const trusted = new Set(
    [owner, viewerLogin, ...actors]
      .filter(Boolean)
      .map((login) => login.trim().toLowerCase()),
  );
  return (login) =>
    trusted.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
}

function loadPolicy(policyPath: string): unknown {
  if (!policyPath) {
    return null;
  }
  try {
    return loadPolicyConfig(policyPath);
  } catch {
    return null;
  }
}

function createProductionDeps(
  args: SuitabilityCloseExecuteArgs,
): SuitabilityCloseExecuteDeps {
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const rawConfig = loadPolicy(args.policy);
  const { viewerLogin } = port.resolveViewerLoginSafe();
  const isTrustedAuthor = buildTrustedAuthorPredicate({
    owner,
    viewerLogin,
    rawConfig: rawConfig as { trustedMarkerActors?: unknown } | null,
  });
  const staleAgeMs =
    parseClaimStaleAgeMs(
      (rawConfig as { claimTiming?: { staleAge?: unknown } } | null)
        ?.claimTiming?.staleAge,
    ) ?? DEFAULT_CLAIM_STALE_AGE_MS;
  const repoRef = `${owner}/${repo}`;

  return {
    getIssue: (issueNumber) => {
      const item = port.getWorkItem(issueNumber);
      if (!item) {
        return null;
      }
      return {
        number: item.number,
        title: item.title,
        body: item.body,
        createdAt: item.createdAt ?? '',
      };
    },
    loadIssueComments: (issueNumber) => loadIssueComments(port, issueNumber),
    collectEvidence: (issue) => {
      const { highConfidenceDuplicate } =
        collectHighConfidenceDuplicateEvidence(
          owner,
          repo,
          repoRef,
          issue,
          DEFAULT_MANIFEST_PATH,
          DEFAULT_BUNDLE_IDS,
        );
      return evaluateHighConfidenceDuplicate(
        highConfidenceDuplicate,
        issue.number,
      );
    },
    isTrustedAuthor,
    postCloseComment: (issueNumber, body) => {
      port.postWorkItemComment(issueNumber, body);
    },
    closeIssue: (issueNumber) => {
      port.closeWorkItem(issueNumber, 'not_planned');
    },
    releaseClaim: (issueNumber, fields) => {
      port.postWorkItemComment(issueNumber, renderUnclaimedByMarker(fields));
    },
    now: () => args.now || new Date().toISOString(),
    staleAgeMs,
  };
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

const SUITABILITY_CLOSE_EXECUTE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--apply': { type: 'boolean', default: false },
  '--claim-id': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--now': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

export function parseArgs(argv: string[]): SuitabilityCloseExecuteArgs {
  const { values, help } = parseCliArgs(
    argv,
    SUITABILITY_CLOSE_EXECUTE_FLAG_SPEC,
  );
  // Copilot review finding on PR #2558 (suppressed comment): /^\d+$/ alone
  // accepts "0", which would then attempt to load/close issue #0. Require a
  // genuinely positive integer, matching runCli's own --issue validation.
  const issueRaw = values.issue as string | undefined;
  const parsedIssue =
    issueRaw !== undefined && /^\d+$/.test(issueRaw) ? Number(issueRaw) : null;
  const issue = parsedIssue !== null && parsedIssue > 0 ? parsedIssue : null;
  return {
    issue,
    apply: Boolean(values.apply),
    claimId: ((values['claim-id'] as string | undefined) ?? '').trim(),
    agentId: ((values['agent-id'] as string | undefined) ?? '').trim(),
    owner: ((values.owner as string | undefined) ?? '').trim(),
    repo: ((values.repo as string | undefined) ?? '').trim(),
    policy: ((values.policy as string | undefined) ?? '').trim(),
    now: ((values.now as string | undefined) ?? '').trim(),
    help: Boolean(help),
  };
}

function printHelp(): void {
  process.stdout.write(`
Usage:
  node scripts/suitability-close-execute.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>]
  node scripts/suitability-close-execute.mjs --issue <number> --claim-id <claim-id> --agent-id <agent-id> [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>] [--apply]

  #1485: the gated pre-claim high-confidence duplicate/superseded close.
  Default (no --apply): dry-run. Evaluates Check 4's high-confidence tier
  (reusing #1484's detection kernel verbatim) and prints { ready, eligible,
  evidence } without mutating.

  --apply: requires --claim-id and --agent-id (the already-posted
  suitability-close/<issue>-<slug> coordination claim -- this helper does
  NOT post that claim itself). Re-validates the claim and re-collects
  evidence immediately before mutating; posts the evidence-bound close
  comment, closes the issue, and releases the claim, in that order. Fails
  closed (exit 1, no mutation) on any lost/stale/non-owned claim or a
  no-longer-eligible fresh evaluation.

  Never fires on the weak title/declaration heuristic -- only a
  tier: 'high-confidence' verdict from evaluateHighConfidenceDuplicate.
`);
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.issue === null) {
    throw new Error('--issue is required and must be a positive integer');
  }
  if (args.apply && (!args.claimId || !args.agentId)) {
    throw new Error('--apply requires --claim-id and --agent-id');
  }

  const deps = createProductionDeps(args);
  const verdict = runSuitabilityCloseExecute(args, deps);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  const success = args.apply ? verdict.closed : verdict.ready;
  process.exit(success ? 0 : 1);
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error: unknown) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
