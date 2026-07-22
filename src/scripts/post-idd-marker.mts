#!/usr/bin/env node
// idd-generated-from: src/scripts/post-idd-marker.mts
//
// The scripts/post-idd-marker.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Write-side companion to emit-marker (#1047). IDD operational markers are
// HTML-comment-first, so an agent must POST them as a JSON body — the
// `gh issue comment` / `gh api -f body=` paths silently reject HTML-only
// bodies. This helper renders the canonical body for each operational marker
// type (reusing the single-sourced protocol-helpers renderers so formats are
// not duplicated) and POSTs it via the reliable JSON path.
//
// It is a single-marker render+POST primitive with NO claim/state gating, by
// design (the emit-marker philosophy). The calling phase runs its
// claim-revalidation gate immediately before invoking `--apply`, exactly as the
// manual POST path it replaces already requires.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { ghText } from './gh-exec.mts';
import {
  renderActivationNonceMarker,
  renderAdvisoryRerollMarker,
  renderAdvisoryWaitMarker,
  renderAdvisoryWaitRecoveryMarker,
  renderClaimedByMarker,
  renderCopilotUnavailableMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
  renderUnclaimedByMarker,
} from './protocol-helpers.mts';

export const MARKER_TYPES = [
  'claim',
  'unclaim',
  'activation-nonce',
  'watermark',
  'baseline',
  'advisory',
  'advisory-recovery',
  'advisory-reroll',
  'copilot-unavailable',
] as const;

export type MarkerType = (typeof MARKER_TYPES)[number];

export const TARGET_KINDS = ['issue', 'pr'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Raw `--flag value` field map, keyed by the CLI flag name (kebab-case). */
export type MarkerFields = Record<string, string>;

/** CLI output envelope for both dry-run and `--apply` modes. */
export interface PostIddMarkerResult {
  mode: 'dry-run' | 'apply';
  type: MarkerType;
  target: TargetKind;
  number: number;
  /** Present in dry-run: the byte-exact body that would be POSTed. */
  body?: string;
  /** Present in `--apply`: the created comment id. */
  commentId?: number;
  /** Present in `--apply`: the created comment URL. */
  url?: string;
}

/**
 * Build the canonical ready-to-post body for one operational marker type.
 * Pure and network-free: it dispatches to the single-sourced protocol-helpers
 * renderer for `type`, so the body stays byte-identical to what emit-marker and
 * the written marker formats produce. Throws on an unknown type or an invalid
 * field set (the renderer's own validation).
 */
export function buildMarkerBody(type: string, fields: MarkerFields): string {
  switch (type) {
    case 'claim':
      return renderClaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        supersedes: fields.supersedes,
        timestamp: fields.timestamp,
        branch: fields.branch,
      });
    case 'unclaim':
      return renderUnclaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        timestamp: fields.timestamp,
      });
    case 'activation-nonce':
      return renderActivationNonceMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        nonce: fields.nonce,
        timestamp: fields.timestamp,
      });
    case 'watermark':
      return renderReviewWatermarkMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        headSha: fields['head-sha'],
        maxActivityAt: fields['max-activity-at'],
        totalItemCount: fields['total-item-count'],
        ciCompletedAt: fields['ci-completed-at'],
      });
    case 'baseline':
      return renderReviewBaselineMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        sha: fields.sha,
      });
    case 'advisory':
      return renderAdvisoryWaitMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'advisory-recovery':
      // #1572: --claim-id / --attempt are OPTIONAL here so the shipped
      // AW3-R recovery flow's existing 3-field call keeps working
      // unchanged; passing both binds the marker for recovery-cycle
      // accounting (see renderAdvisoryWaitRecoveryMarker's own doc comment
      // for the fail-closed behavior on a half-bound pair).
      return renderAdvisoryWaitRecoveryMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
        ...(fields['claim-id'] !== undefined
          ? { claimId: fields['claim-id'] }
          : {}),
        ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
      });
    case 'advisory-reroll':
      return renderAdvisoryRerollMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'copilot-unavailable':
      return renderCopilotUnavailableMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        headSha: fields['head-sha'],
        attempt: fields.attempt,
        timestamp: fields.timestamp,
      });
    default:
      throw new Error(
        `--type is required and must be one of: ${MARKER_TYPES.join(', ')}`,
      );
  }
}

/**
 * Map a `review-activity-snapshot` JSON object to the four snapshot-derived
 * `--type watermark` field flags, so `--from-pr` can fill them automatically
 * instead of the agent hand-copying a 40-char HEAD SHA and three timestamps.
 *
 * `ci-completed-at` is taken from `latestPassingCiCompletedAt` — the latest
 * *passing* (or treated-as-passed) CI completion — NOT `latestCiCompletedAt`.
 * That matches the E1 Step 2 `{latest-ci-completed-at}` definition and the
 * pre-merge-readiness currency diff, which compares the watermark CI field
 * against the live `latestPassingCiCompletedAt`; using the all-completed field
 * would post a value that differs from the hand-computed one and trips a false
 * F2 `ci-pass-drift`.
 *
 * The snapshot emits the `none` sentinel string (never `null`) for empty
 * timestamps; both are tolerated and forwarded as `none`. Throws (fail-closed)
 * when `headSha` / `totalItemCount` are absent or malformed so a broken
 * snapshot can never post a bogus watermark. ISO/count shape validation is left
 * to the single-sourced `renderReviewWatermarkMarker` reached via
 * `buildMarkerBody`.
 */
export function watermarkFieldsFromSnapshot(snapshot: unknown): MarkerFields {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const headSha = snap.headSha;
  const totalItemCount = snap.totalItemCount;
  if (typeof headSha !== 'string' || headSha.trim() === '') {
    throw new Error('review-activity-snapshot is missing a usable headSha');
  }
  if (
    typeof totalItemCount !== 'number' ||
    !Number.isInteger(totalItemCount) ||
    totalItemCount < 0
  ) {
    throw new Error(
      'review-activity-snapshot is missing a usable totalItemCount',
    );
  }
  const isoOrNone = (value: unknown): string =>
    typeof value === 'string' && value.trim() !== '' ? value : 'none';
  return {
    'head-sha': headSha,
    'max-activity-at': isoOrNone(snap.maxActivityUpdatedAt),
    'total-item-count': String(totalItemCount),
    'ci-completed-at': isoOrNone(snap.latestPassingCiCompletedAt),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  type: string;
  target: string;
  number: number | null;
  /** `--from-pr <n>`: derive the watermark snapshot fields from PR <n>. */
  fromPr: number | null;
  /**
   * `--expected-head-sha <sha>`: `--from-pr` only. The E1 Step 1 stored
   * `{head-SHA}`. When set, fail closed (no post) if the fresh
   * `--from-pr` snapshot's live HEAD no longer matches it — the branch
   * moved between E1 Step 1 and this Step 2 call.
   */
  expectedHeadSha: string;
  apply: boolean;
  owner: string;
  repo: string;
  /** Forwarded to the `--from-pr` snapshot child (snapshot input, not a field). */
  trustedMarkerLogins: string;
  /** Forwarded to the `--from-pr` snapshot child (snapshot input, not a field). */
  advisoryBotLogins: string;
  help: boolean;
  fields: MarkerFields;
}

/**
 * Parse a whole-token positive integer, failing closed on a suffixed typo
 * (`1047abc`), a non-numeric token, or a non-positive / unsafe magnitude — a
 * mis-parsed target number could POST a marker to the wrong issue/PR.
 */
function parsePositiveIntToken(token: string, label: string): number {
  const parsed = Number.parseInt(token, 10);
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}: ${token}`);
  }
  return parsed;
}

// Excluded from the #1446 cli-args.mts wrapper: `fields` below collects
// per-marker-type keys dynamically (each `--type` accepts a different
// field set) rather than a fixed declared spec. `util.parseArgs`'s
// `strict: true` rejects any option not named in its static spec, and
// `strict: false` would instead coerce every unrecognized flag to `true`
// -- neither matches this file's "accept whatever fields this marker type
// needs" contract.
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    type: '',
    target: '',
    number: null,
    fromPr: null,
    expectedHeadSha: '',
    apply: false,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
    help: false,
    fields: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--apply') {
      args.apply = true;
      continue;
    }
    if (!token.startsWith('--')) {
      // The sole positional argument is the issue/PR number. Match the whole
      // token as a positive integer BEFORE converting: Number.parseInt would
      // silently accept a suffixed typo like `1047abc` / `1047-draft` as 1047
      // and, with --apply, post the marker to the wrong target. Fail closed.
      if (args.number !== null) {
        throw new Error(`unexpected positional argument: ${token}`);
      }
      args.number = parsePositiveIntToken(token, 'invalid issue/PR number');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for argument: ${token}`);
    }
    index += 1;
    if (token === '--type') {
      args.type = value;
    } else if (token === '--target') {
      args.target = value;
    } else if (token === '--from-pr') {
      args.fromPr = parsePositiveIntToken(value, 'invalid --from-pr number');
    } else if (token === '--expected-head-sha') {
      args.expectedHeadSha = value;
    } else if (token === '--owner') {
      args.owner = value;
    } else if (token === '--repo') {
      args.repo = value;
    } else if (token === '--trusted-marker-logins') {
      args.trustedMarkerLogins = value;
    } else if (token === '--advisory-bot-logins') {
      args.advisoryBotLogins = value;
    } else {
      // Any other --flag is a renderer field, stored under its kebab name.
      args.fields[token.slice(2)] = value;
    }
  }
  return args;
}

const USAGE = `usage: node scripts/post-idd-marker.mjs --type <type> --target <issue|pr> <number> [field flags...] [--apply]

Render the canonical HTML-comment-first body for an IDD operational marker
(advisory markers are plain-text per the AW3 protocol) and POST it via the
reliable JSON path. Default mode is dry-run, which prints a JSON envelope whose
\`body\` field is the marker; --apply POSTs it and prints the created comment
id/URL. This helper performs no claim/state gating — the calling phase must run
its claim-revalidation gate before --apply, as the manual POST path it replaces.

  --type <type>        one of: ${MARKER_TYPES.join(', ')}
  --target <issue|pr>  the comment target kind (both use the issues comments API)
  <number>             issue or PR number (positional; required unless --from-pr)
  --from-pr <n>        watermark only: derive --head-sha / --max-activity-at /
                       --total-item-count / --ci-completed-at from the live
                       review-activity-snapshot of PR <n> and post the watermark
                       to PR <n>, so only --agent-id / --claim-id (and --apply)
                       are still needed (always targets the PR; an explicit
                       non-pr --target is rejected). Not network-free.
  --expected-head-sha <sha>  --from-pr only: the E1 Step 1 stored {head-SHA}.
                       Fails closed (posts nothing) if the fresh snapshot's live
                       HEAD no longer matches it, i.e. the branch moved between
                       E1 Step 1 and this Step 2 call.
  --apply              POST the marker (default: dry-run prints it in a JSON envelope)
  --owner <owner>      repo owner (default: gh repo view)
  --repo <repo>        repo name (default: gh repo view)
  -h, --help           show this help

Per-type field flags:
  claim              --agent-id --claim-id --supersedes --timestamp --branch
  unclaim            --agent-id --claim-id --timestamp
  activation-nonce   --agent-id --claim-id --nonce --timestamp
  watermark          --agent-id --claim-id --head-sha --max-activity-at --total-item-count --ci-completed-at
                     (or --agent-id --claim-id --from-pr <n> [--expected-head-sha <sha>])
  baseline           --agent-id --claim-id --sha
  advisory           --agent-id --head-sha --timestamp
  advisory-recovery  --agent-id --head-sha --timestamp [--claim-id --attempt]
  advisory-reroll    --agent-id --head-sha --timestamp
  copilot-unavailable --agent-id --claim-id --head-sha --attempt --timestamp

--claim-id / --attempt on advisory-recovery are OPTIONAL (#1572): passing
both binds the marker to the active claim and an attempt number for
recovery-cycle accounting (advisory-wait-state.mjs); passing neither renders
the legacy 3-field form the shipped AW3-R recovery flow already posts.
Passing only ONE of the two throws (half-bound, ambiguous) -- always pass
both together or neither.
copilot-unavailable is a brand-new terminal marker with no legacy form, so
all five fields are required.

--from-pr forwards optional --trusted-marker-logins / --advisory-bot-logins to
the snapshot child so its counts match the manual review-activity-snapshot path.
--expected-head-sha pins --from-pr to the Step 1 stored HEAD and fails closed
(no post) on drift instead of silently posting a newer HEAD than Step 1 saw.
`;

/**
 * POST the marker body as a JSON document (`{"body": …}`) read from stdin via
 * `gh api --input -`. The JSON path is mandatory because HTML-comment-first
 * bodies are silently dropped by `gh issue comment` / `gh api -f body=`.
 *
 * Both `--target issue` and `--target pr` POST to the same
 * `repos/{owner}/{repo}/issues/{number}/comments` endpoint (a PR is an issue
 * for the comments API); `target` is descriptive-only and never changes routing.
 */
function postMarker(
  owner: string,
  repo: string,
  number: number,
  body: string,
): { id: number; html_url: string } {
  const out = execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${owner}/${repo}/issues/${number}/comments`,
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body }), encoding: 'utf8' },
  );
  return JSON.parse(out) as { id: number; html_url: string };
}

/**
 * Run the sibling read-only `review-activity-snapshot.mjs` for a PR and return
 * its parsed JSON. This is the `--from-pr` half of the "compose the two existing
 * helpers" path; the snapshot stays the single source of the activity/CI metrics
 * and this write-side helper only renders+posts the watermark over them.
 *
 * The sibling is resolved relative to this module (both generated artifacts live
 * in `scripts/`), so it works from any cwd. `--owner` / `--repo` are forwarded
 * to avoid an extra `gh repo view` in the child, and the optional marker-actor
 * lists are forwarded so the child's `totalItemCount` / `maxActivityUpdatedAt`
 * filtering matches the manual `review-activity-snapshot` invocation.
 */
function runReviewActivitySnapshot(
  prNumber: number,
  owner: string,
  repo: string,
  trustedMarkerLogins: string,
  advisoryBotLogins: string,
): unknown {
  const script = resolve(import.meta.dirname, 'review-activity-snapshot.mjs');
  const snapshotArgs = [
    script,
    '--pr',
    String(prNumber),
    '--owner',
    owner,
    '--repo',
    repo,
  ];
  if (trustedMarkerLogins) {
    snapshotArgs.push('--trusted-marker-logins', trustedMarkerLogins);
  }
  if (advisoryBotLogins) {
    snapshotArgs.push('--advisory-bot-logins', advisoryBotLogins);
  }
  const out = execFileSync(process.execPath, snapshotArgs, {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

if (import.meta.main) {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    throw error;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!MARKER_TYPES.includes(args.type as MarkerType)) {
    process.stderr.write(
      `--type is required and must be one of: ${MARKER_TYPES.join(', ')}\n`,
    );
    process.exit(1);
  }
  // --expected-head-sha only guards the --from-pr derivation below; in manual
  // mode the caller already supplies --head-sha directly, so there is nothing
  // to compare it against.
  if (args.expectedHeadSha && args.fromPr === null) {
    process.stderr.write(
      '--expected-head-sha is only valid together with --from-pr\n',
    );
    process.exit(1);
  }

  // `--from-pr <n>` snapshot-derivation mode (watermark only): default the post
  // target to PR <n>, reject the manual snapshot fields as ambiguous, then
  // derive head-sha / max-activity-at / total-item-count / ci-completed-at from
  // the live review-activity-snapshot before the shared render + dry-run/apply
  // path below. owner/repo are resolved here because the snapshot child needs
  // them and the dry-run branch returns before the apply-path resolution.
  if (args.fromPr !== null) {
    if (args.type !== 'watermark') {
      process.stderr.write('--from-pr is only valid for --type watermark\n');
      process.exit(1);
    }
    // --from-pr always posts the watermark to PR <n>. `--target` is
    // descriptive-only (issue/pr both POST to the same /issues/<n>/comments
    // endpoint), but an `issue`-targeted snapshot watermark is incoherent, so
    // fail closed on an explicit non-pr target rather than recording it.
    if (args.target && args.target !== 'pr') {
      process.stderr.write(
        `--from-pr always targets the PR; remove --target ${args.target}\n`,
      );
      process.exit(1);
    }
    args.target = 'pr';
    if (args.number === null) {
      args.number = args.fromPr;
    } else if (args.number !== args.fromPr) {
      process.stderr.write(
        'in --from-pr mode the positional number must be omitted or equal --from-pr\n',
      );
      process.exit(1);
    }
    const derivedFlags = [
      'head-sha',
      'max-activity-at',
      'total-item-count',
      'ci-completed-at',
    ];
    const conflicting = derivedFlags.filter((flag) => flag in args.fields);
    if (conflicting.length > 0) {
      process.stderr.write(
        `--from-pr derives ${derivedFlags.join(' / ')} from the live snapshot; do not also pass: ${conflicting
          .map((flag) => `--${flag}`)
          .join(', ')}\n`,
      );
      process.exit(1);
    }
    // Resolve owner/repo inside the try: in --from-pr mode they are read
    // eagerly (the snapshot child needs them and the dry-run branch returns
    // before the apply-path resolution), so a `gh repo view` failure here is
    // part of "derive from PR" and should report cleanly, not throw a raw stack.
    try {
      args.owner =
        args.owner ||
        ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
      args.repo =
        args.repo ||
        ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
      const snapshot = runReviewActivitySnapshot(
        args.fromPr,
        args.owner,
        args.repo,
        args.trustedMarkerLogins,
        args.advisoryBotLogins,
      );
      Object.assign(args.fields, watermarkFieldsFromSnapshot(snapshot));
    } catch (error) {
      process.stderr.write(
        `failed to derive watermark fields from PR ${args.fromPr}: ${(error as Error).message}\n`,
      );
      process.exit(1);
    }
    // Fail closed (this repository's fail-closed default) when the branch
    // moved between E1 Step 1 (which stored {head-SHA} and must not re-read
    // HEAD through Step 3) and this Step 2 call: posting a watermark keyed to
    // a HEAD newer than the one E1 Step 1 actually snapshotted would silently
    // violate that single-stored-value invariant. Refuse to post; the caller
    // reruns E1 from Step 1 against the moved branch instead.
    const liveHeadSha = args.fields['head-sha'];
    if (
      args.expectedHeadSha &&
      liveHeadSha.toLowerCase() !== args.expectedHeadSha.toLowerCase()
    ) {
      process.stderr.write(
        `refusing to post watermark: PR ${args.fromPr}'s live HEAD (${liveHeadSha}) no longer matches the Step 1 stored --expected-head-sha (${args.expectedHeadSha}); the branch moved between E1 Step 1 and Step 2. Re-run E1 from Step 1 against the new HEAD.\n`,
      );
      process.exit(1);
    }
  }

  if (!TARGET_KINDS.includes(args.target as TargetKind)) {
    process.stderr.write(
      `--target is required and must be one of: ${TARGET_KINDS.join(', ')}\n`,
    );
    process.exit(1);
  }
  if (args.number === null) {
    process.stderr.write('a positional issue/PR <number> is required\n');
    process.exit(1);
  }

  let body: string;
  try {
    body = buildMarkerBody(args.type, args.fields);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    throw error;
  }

  const number = args.number;
  if (!args.apply) {
    const result: PostIddMarkerResult = {
      mode: 'dry-run',
      type: args.type as MarkerType,
      target: args.target as TargetKind,
      number,
      body,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  const posted = postMarker(owner, repo, number, body);
  const result: PostIddMarkerResult = {
    mode: 'apply',
    type: args.type as MarkerType,
    target: args.target as TargetKind,
    number,
    commentId: posted.id,
    url: posted.html_url,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
