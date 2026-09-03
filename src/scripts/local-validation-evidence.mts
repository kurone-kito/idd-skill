#!/usr/bin/env node
// idd-generated-from: src/scripts/local-validation-evidence.mts
//
// The scripts/local-validation-evidence.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// #2323: record local `pre-push-validate` (or another configured command
// set) output as first-class, HEAD-pinned, expiring evidence, so a queue
// caused by an Actions outage recovers on a rerun rather than a re-review,
// and so nothing merges later on evidence that no longer describes the
// code.
//
// Scope boundary, restated from the issue: this helper resolves evidence
// marker validity and reports it as an informational, additive field. It
// never derives CI-check "passing" state, never removes a required-check
// blocker, and never itself decides merge-readiness -- those stay exactly
// where they already live (pre-merge-readiness.mts / protocol-helpers.mts's
// `computePreMergeReadinessBlockers`, which never reads this helper's
// output at all).

import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import {
  type AuthorityEvidence,
  buildTrustedMarkerLogins,
  normalizeAuthorityEvidence,
  resolveActorLogin,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mts';
import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  type ParsedLocalValidationEvidence,
  parseLocalValidationEvidenceComment,
  parsePaginatedGhNdjson,
  renderLocalValidationEvidenceComment,
} from './protocol-helpers.mts';
import { resolveProviderOutageDeclaration } from './provider-outage-declaration.mts';

/** Normalized policy object returned by {@link normalizePolicyConfig}. */
type NormalizedPolicy = ReturnType<typeof normalizePolicyConfig>;

/** One issue/PR comment, in the shape the GitHub REST list endpoint returns. */
export interface CommentLike {
  id?: string | number | null;
  html_url?: string | null;
  url?: string | null;
  body?: string | null;
  created_at?: string | null;
  user?: { login?: string | null } | null;
  author?: { login?: string | null } | null;
}

/** Result of {@link resolveLocalValidationEvidence}. */
export interface LocalValidationEvidenceResolution {
  present: boolean;
  reason: string;
  evidence: ParsedLocalValidationEvidence | null;
  valid: ParsedLocalValidationEvidence[];
  wrongHead: ParsedLocalValidationEvidence[];
  untrusted: { authorLogin: string; headSha: string }[];
  expired: ParsedLocalValidationEvidence[];
  partialCoverage: ParsedLocalValidationEvidence[];
  outcomeFail: ParsedLocalValidationEvidence[];
  malformed: { authorLogin: string; bodyPreview: string }[];
  outageDeclarationActive: boolean;
}

const EVIDENCE_MARKER_START = /^<!--\s*idd-local-validation-evidence:/i;

function commentAuthorLogin(comment: CommentLike | null | undefined): string {
  return String(comment?.author?.login ?? comment?.user?.login ?? '')
    .trim()
    .toLowerCase();
}

function latestByCreatedAt<T extends { createdAt: string }>(
  entries: T[],
): T | null {
  if (entries.length === 0) return null;
  return [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[
    entries.length - 1
  ];
}

function coversAll(covers: string[], requiredCheckNames: string[]): boolean {
  // #2355 review (Copilot): an empty requiredCheckNames list (e.g. the CLI
  // default when --required-checks is omitted) must never satisfy every()'s
  // vacuous truth -- that would report `present: true` for evidence that
  // was never actually checked against anything.
  if (requiredCheckNames.length === 0) {
    return false;
  }
  const coveredSet = new Set(covers.map((entry) => entry.trim()));
  return requiredCheckNames.every((name) => coveredSet.has(name.trim()));
}

/**
 * Resolve whether HEAD-pinned, actor-trusted, unexpired local validation
 * evidence exists for `prHeadSha` that covers every name in
 * `requiredCheckNames`.
 *
 * Never sufficient on its own by construction: the caller must also prove
 * `outageDeclarationActive` (an active `idd-provider-outage-declaration` for
 * service `ci-actions`, per {@link resolveProviderOutageDeclaration}) --
 * evidence recorded outside a declared outage never reports `present: true`,
 * matching the issue's "only while an outage relief declaration ... is
 * active" acceptance criterion. `present: true` is informational only: it
 * is never read by `computePreMergeReadinessBlockers`
 * (protocol-helpers.mts), which has no reference to this field at all, so
 * no required-check blocker can ever be removed by this resolution.
 */
export function resolveLocalValidationEvidence(input: {
  comments: CommentLike[] | null | undefined;
  prHeadSha: string;
  requiredCheckNames: string[];
  trustedMarkerLogins: string[];
  outageDeclarationActive: boolean;
  policy: NormalizedPolicy;
  now?: Date;
}): LocalValidationEvidenceResolution {
  const prHeadSha = String(input.prHeadSha ?? '').toLowerCase();
  const requiredCheckNames = (input.requiredCheckNames ?? [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  const trustedSet = new Set(
    (input.trustedMarkerLogins ?? []).map((login) =>
      String(login ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  const now = input.now instanceof Date ? input.now : new Date();
  const nowMs = now.getTime();
  const maxAgeMs =
    parseIsoDurationToMs(
      input.policy?.localValidationEvidence?.maxAge ?? 'PT4H',
    ) ??
    parseIsoDurationToMs('PT4H') ??
    0;

  const valid: ParsedLocalValidationEvidence[] = [];
  const wrongHead: ParsedLocalValidationEvidence[] = [];
  const untrusted: LocalValidationEvidenceResolution['untrusted'] = [];
  const expired: ParsedLocalValidationEvidence[] = [];
  const partialCoverage: ParsedLocalValidationEvidence[] = [];
  const outcomeFail: ParsedLocalValidationEvidence[] = [];
  const malformed: LocalValidationEvidenceResolution['malformed'] = [];
  let shapedCount = 0;

  for (const comment of input.comments ?? []) {
    const body = String(comment?.body ?? '');
    if (!EVIDENCE_MARKER_START.test(body)) continue;
    shapedCount += 1;

    const authorLogin = commentAuthorLogin(comment);
    const createdAt = String(comment?.created_at ?? '');
    const parsed = parseLocalValidationEvidenceComment(body, createdAt);
    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }

    if (!/^[0-9a-f]{40}$/.test(prHeadSha) || parsed.headSha !== prHeadSha) {
      wrongHead.push(parsed);
      continue;
    }
    if (!trustedSet.has(authorLogin)) {
      untrusted.push({ authorLogin, headSha: parsed.headSha });
      continue;
    }
    const createdAtMs = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > maxAgeMs) {
      expired.push(parsed);
      continue;
    }
    if (parsed.outcome !== 'pass') {
      outcomeFail.push(parsed);
      continue;
    }
    if (!coversAll(parsed.covers, requiredCheckNames)) {
      partialCoverage.push(parsed);
      continue;
    }

    valid.push(parsed);
  }

  const evidence = latestByCreatedAt(valid);
  const outageDeclarationActive = Boolean(input.outageDeclarationActive);

  if (evidence && outageDeclarationActive) {
    return {
      present: true,
      reason: '',
      evidence,
      valid,
      wrongHead,
      untrusted,
      expired,
      partialCoverage,
      outcomeFail,
      malformed,
      outageDeclarationActive,
    };
  }

  let reason = `no local validation evidence found for HEAD ${prHeadSha || '(unknown)'}`;
  if (evidence && !outageDeclarationActive) {
    reason =
      'valid local validation evidence exists, but no active provider outage declaration for service "ci-actions" -- evidence relieves nothing outside a declared outage';
  } else if (shapedCount === 0) {
    reason = `no local validation evidence found for HEAD ${prHeadSha || '(unknown)'}`;
  } else if (outcomeFail.length > 0) {
    reason = 'latest local validation evidence recorded a failing outcome';
  } else if (partialCoverage.length > 0) {
    if (requiredCheckNames.length === 0) {
      reason =
        'no required check names were given to resolve coverage against (pass --required-checks)';
    } else {
      // #2355 review (Copilot, CodeRabbit): mirror coversAll()'s own
      // trimming exactly, or a check name differing only by surrounding
      // whitespace reports as missing here while coversAll (correctly)
      // already treated it as covered.
      const coveredSet = new Set(
        partialCoverage[partialCoverage.length - 1].covers.map((entry) =>
          entry.trim(),
        ),
      );
      const missing = requiredCheckNames.filter(
        (name) => !coveredSet.has(name.trim()),
      );
      reason = `local validation evidence covers only a subset of the required checks (missing: ${missing.join(', ')})`;
    }
  } else if (expired.length > 0) {
    reason = `local validation evidence is older than the configured localValidationEvidence.maxAge`;
  } else if (untrusted.length > 0) {
    const latest = untrusted[untrusted.length - 1];
    reason = `${latest.authorLogin} is not a trusted marker actor`;
  } else if (wrongHead.length > 0) {
    reason = `local validation evidence is bound to a different HEAD than ${prHeadSha || '(unknown)'}`;
  } else if (malformed.length > 0) {
    reason = 'local validation evidence marker is malformed';
  }

  return {
    present: false,
    reason,
    evidence: null,
    valid,
    wrongHead,
    untrusted,
    expired,
    partialCoverage,
    outcomeFail,
    malformed,
    outageDeclarationActive,
  };
}

/** Result of {@link evaluateLocalValidationEvidenceRecovery}. */
export interface LocalValidationEvidenceRecoveryEvaluation {
  needsRevalidation: boolean;
  reason: string;
}

/**
 * On recovery (the outage that made the evidence's declaration active is
 * over), decide whether a pull request queued on an evidence record still
 * describes its current HEAD. A HEAD that advanced past the recorded
 * `evidence.headSha` must be re-validated, never merged on the stale
 * record -- this function only ever answers "needs revalidation", never
 * "clear to merge".
 */
export function evaluateLocalValidationEvidenceRecovery(input: {
  evidence: { headSha: string } | null | undefined;
  livePrHeadSha: string;
}): LocalValidationEvidenceRecoveryEvaluation {
  const recordedHeadSha = String(input.evidence?.headSha ?? '').toLowerCase();
  const liveHeadSha = String(input.livePrHeadSha ?? '').toLowerCase();
  if (!recordedHeadSha) {
    return { needsRevalidation: true, reason: 'no evidence record found' };
  }
  if (recordedHeadSha !== liveHeadSha) {
    return {
      needsRevalidation: true,
      reason: `HEAD advanced from ${recordedHeadSha} to ${liveHeadSha || '(unknown)'} past the recorded evidence`,
    };
  }
  return { needsRevalidation: false, reason: '' };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface LocalValidationEvidenceArgs {
  mode: 'resolve' | 'record';
  prNumber: number;
  headSha: string;
  commandSet: string;
  covers: string[];
  outcome: string;
  requiredCheckNames: string[];
  service: string;
  targetIssue: number;
  actor: string;
  repo: string;
  owner: string;
  apply: boolean;
  format: string;
  help: boolean;
}

const LOCAL_VALIDATION_EVIDENCE_FLAG_SPEC = {
  '--record': { type: 'boolean', default: false },
  '--pr': { type: 'string', default: '' },
  '--head-sha': { type: 'string', default: '' },
  '--command-set': { type: 'string', default: 'pre-push-validate' },
  '--covers': { type: 'string', default: '' },
  '--outcome': { type: 'string', default: '' },
  '--required-checks': { type: 'string', default: '' },
  '--service': { type: 'string', default: 'ci-actions' },
  '--target-issue': { type: 'string', default: '' },
  '--actor': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--apply': { type: 'boolean', default: false },
  '--format': { type: 'string', default: 'json' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function parsePositiveIntegerFlag(value: unknown, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): LocalValidationEvidenceArgs {
  const { values, help } = parseCliArgs(
    argv,
    LOCAL_VALIDATION_EVIDENCE_FLAG_SPEC,
  );
  const format = (values.format as string).trim();
  if (format !== 'json' && format !== 'text') {
    throw new Error(`unsupported --format value: ${format}`);
  }
  const mode: LocalValidationEvidenceArgs['mode'] = values.record
    ? 'record'
    : 'resolve';

  const parsed: LocalValidationEvidenceArgs = {
    mode,
    prNumber:
      values.pr === undefined || values.pr === ''
        ? 0
        : parsePositiveIntegerFlag(values.pr as string, '--pr'),
    headSha: (values['head-sha'] as string).trim().toLowerCase(),
    commandSet: (values['command-set'] as string).trim(),
    covers: splitCommaList(values.covers as string),
    outcome: (values.outcome as string).trim().toLowerCase(),
    requiredCheckNames: splitCommaList(values['required-checks'] as string),
    service: (values.service as string).trim(),
    targetIssue:
      values['target-issue'] === undefined || values['target-issue'] === ''
        ? 0
        : parsePositiveIntegerFlag(
            values['target-issue'] as string,
            '--target-issue',
          ),
    actor: (values.actor as string).trim(),
    repo:
      combineOwnerRepoFlags({
        owner: (values.owner as string).trim(),
        repo: (values.repo as string).trim(),
      }) ?? '',
    owner: (values.owner as string).trim(),
    apply: values.apply as boolean,
    format,
    help,
  };

  if (!parsed.help) {
    if (!parsed.prNumber) {
      throw new Error('missing required --pr <number> argument');
    }
    if (!/^[0-9a-f]{40}$/.test(parsed.headSha)) {
      throw new Error(
        'missing or invalid required --head-sha <40-hex> argument',
      );
    }
    if (mode === 'record') {
      if (parsed.covers.length === 0) {
        throw new Error(
          'missing required --covers <comma-separated-check-names>',
        );
      }
      if (parsed.outcome !== 'pass' && parsed.outcome !== 'fail') {
        throw new Error('missing or invalid required --outcome <pass|fail>');
      }
    }
  }

  return parsed;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function parseOwnerRepo(value: unknown): { owner: string; name: string } {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid --repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}

function fetchPrComments({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}): CommentLike[] {
  try {
    const payload = ghText(
      [
        'api',
        '--paginate',
        '--jq',
        '.[]',
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      ],
      { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS },
    );
    return parsePaginatedGhNdjson(payload) as CommentLike[];
  } catch {
    throw new Error(
      `could not read pull request #${prNumber} comments to resolve local validation evidence`,
    );
  }
}

function postComment({
  owner,
  repo,
  prNumber,
  body,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): { html_url?: string; url?: string } {
  const payload = ghText([
    'api',
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    '--method',
    'POST',
    '-f',
    `body=${body}`,
  ]);
  try {
    return JSON.parse(payload || '{}');
  } catch {
    return {};
  }
}

export async function runLocalValidationEvidence(
  options: {
    args?: LocalValidationEvidenceArgs;
    now?: Date;
    comments?: CommentLike[];
    trustedMarkerLogins?: string[];
    postComment?: typeof postComment;
  } = {},
): Promise<{ exitCode: number; result?: unknown }> {
  const args = options.args ?? parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return { exitCode: 0 };
  }

  const repository =
    args.repo ||
    ghText([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
  const { owner, name } = parseOwnerRepo(repository);
  const rawConfig = readJsonFile('.github/idd/config.json');
  const policy = normalizePolicyConfig(rawConfig);
  const now = options.now instanceof Date ? options.now : new Date();

  const comments =
    options.comments ??
    fetchPrComments({ owner, repo: name, prNumber: args.prNumber });

  if (args.mode === 'resolve') {
    const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
      .trim()
      .toLowerCase();
    const trustedMarkerLogins = options.trustedMarkerLogins ?? [
      ...buildTrustedMarkerLogins({
        owner,
        repo: name,
        rawConfig,
        viewerLogin,
        issueComments: comments,
      }),
    ];
    const targetIssue =
      args.targetIssue || policy.providerOutage.declarationTarget;
    const declarationComments = targetIssue
      ? fetchPrComments({ owner, repo: name, prNumber: targetIssue })
      : [];
    const authorityOf = (actorLogin: string): AuthorityEvidence =>
      normalizeAuthorityEvidence(
        resolveCollaboratorAuthority({ owner, repo: name, actor: actorLogin }),
        actorLogin,
        owner,
        policy.ciGate.externalCheckWaivers.authorityPolicy,
      );
    const outageDeclaration = resolveProviderOutageDeclaration({
      declarationTargetConfigured: Boolean(targetIssue),
      comments: declarationComments,
      service: args.service,
      policy,
      authorityOf,
      now,
    });
    const result = resolveLocalValidationEvidence({
      comments,
      prHeadSha: args.headSha,
      requiredCheckNames: args.requiredCheckNames,
      trustedMarkerLogins,
      outageDeclarationActive: outageDeclaration.active,
      policy,
      now,
    });
    render(result, args.format);
    return { exitCode: 0, result };
  }

  // --record: without --apply this is a dry-run that only prints the
  // rendered marker body; --apply is required only to post it to GitHub.
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const actor = resolveActorLogin(undefined, args.actor, viewerLogin);
  if (!actor) {
    throw new Error(
      'could not determine current GitHub user; ensure gh is authenticated',
    );
  }
  if (args.apply && args.actor && actor !== viewerLogin && viewerLogin) {
    throw new Error(
      `--actor ${args.actor} does not match the authenticated user ${viewerLogin}; omit --actor to use the authenticated identity`,
    );
  }

  const body = renderLocalValidationEvidenceComment({
    actor,
    headSha: args.headSha,
    commandSet: args.commandSet,
    covers: args.covers,
    outcome: args.outcome,
  });

  if (!args.apply) {
    process.stdout.write(`${body}\n`);
    return { exitCode: 0, result: { mode: args.mode, apply: false, body } };
  }

  const poster = options.postComment ?? postComment;
  const posted = poster({ owner, repo: name, prNumber: args.prNumber, body });
  const result = {
    mode: args.mode,
    apply: true,
    body,
    commentUrl: String(posted.html_url ?? posted.url ?? ''),
  };
  render(result, args.format);
  return { exitCode: 0, result };
}

export function renderText(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => {
      const rendered =
        entry !== null && typeof entry === 'object'
          ? JSON.stringify(entry)
          : String(entry);
      return `${key}: ${rendered}`;
    })
    .join('\n');
}

function render(value: unknown, format: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderText(value)}\n`);
}

function printUsage(): void {
  process.stdout.write(`usage: node scripts/local-validation-evidence.mjs --pr <number> --head-sha <40-hex> [options]

Modes (default: resolve evidence validity for --pr/--head-sha):
  --record                          render (or, with --apply, post) a new evidence marker

Options:
  --pr <number>                     pull request number (required)
  --head-sha <40-hex>                pull request HEAD SHA (required)
  --command-set <name>               local command set that ran (--record, default: pre-push-validate)
  --covers <names>                   comma-separated required check names this run covers (--record)
  --outcome <pass|fail>              local validation outcome (--record)
  --required-checks <names>          comma-separated required check names to resolve coverage against (default mode)
  --service <name>                   outage-declaration service to require active (default: ci-actions)
  --target-issue <number>           override providerOutage.declarationTarget
  --actor <login>                   override the GitHub actor used for --record
  --repo <owner/name>               repository override, combined form
  --owner <owner>                   repository override, split form (use
                                     with --repo <name>, the bare
                                     repository name -- not both --owner
                                     and a combined --repo together)
  --apply                           post the canonical marker comment after validation (--record)
  --format <json|text>              output format (default: json)
  --help                            show this message
`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const result = await runLocalValidationEvidence({ args: parseArgs(argv) });
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
