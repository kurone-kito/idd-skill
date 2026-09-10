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
// winning `authoring-owner` ownership generation marker's recorded
// `body-sha256` -- normally a `mode=acquire` marker, but a stale-hold
// `bootstrap` or interrupted-set `resume` can legitimately win a
// generation too (contract.md; see `findWinningAcquire`'s own doc
// comment). That comparison previously relied entirely on a releasing
// session's own manual judgment; this helper performs and verifies it
// mechanically instead.
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
//
// Generation-boundary caveat: `mode=release-complete` is anchor-only
// (contract.md). For `target === anchor` -- the single-target hold shape
// this helper is built for (a review-fix-loop-cutoff follow-up is always
// orphan-shaped, never a set member) -- the target's own comment log
// carries every generation boundary directly and the replay below is
// exact. A non-anchor child in a multi-target set never carries its own
// `release-complete`, so this helper (which reads only the named
// `--issue`'s own log, never an anchor's) cannot see a child's true
// generation boundary; every generation-opening marker (acquire,
// bootstrap, or resume) on such a child reads as one still-open
// generation. That is the fail-closed direction -- a
// legitimately re-acquired child compares against the first
// generation's digest and reports `mismatch`, never a false `pass` --
// so it is an accepted limitation, not a defect. Fetching the anchor's
// own log to resolve it is out of scope for kurone-kito/idd-skill#2891.

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
  id: number;
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
  evidence: string;
}

export interface AuthoringOwnerProvenanceMarkerEvidence {
  author: string;
  createdAt: string;
  mode: string;
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

interface OwnerMarkerEvent {
  comment: AuthoringOwnerProvenanceComment;
  parsed: ParsedAuthoringOwnerMarker;
}

function normalizeMarkerPrefix(prefix: unknown): string {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_MARKER_PREFIX;
}

/**
 * Replay `target`'s own trusted `authoring-owner` marker log in
 * chronological order (ties broken by comment `id`, ascending — the
 * deterministic order contract.md's replay rule requires) and return the
 * generation-opening marker that won the log's last generation, or
 * `null` if none exists.
 *
 * A generation opens at the first `acquire`, `bootstrap`, or `resume`
 * marker (`GENERATION_OPENER_MODES` below) when no generation is
 * currently open; contract.md: "the first valid acquisition, bootstrap,
 * or resume marker by GitHub comment order wins", so a second
 * generation-opening marker while a generation is already open is a
 * same-generation race — a losing racer or a duplicate — and never
 * overrides the winner. Whichever mode wins, its own `body-sha256` field
 * is the digest this comparison uses (kurone-kito/idd-skill#2901 review,
 * chatgpt-codex-connector round 3: the earlier form recognized only
 * `acquire` as a generation opener, so a legitimate `bootstrap`/`resume`
 * winner could be silently displaced by a later competing `acquire`).
 *
 * A generation closes only on a `mode=release-complete` that
 * `isValidReleaseComplete` (below) accepts as a genuine closure of the
 * currently open generation — a stale, malformed, or unrelated
 * completion never closes it (kurone-kito/idd-skill#2901 review,
 * chatgpt-codex-connector rounds 2-3: closing on any release-complete
 * for the target, unchecked, could let an unrelated or incomplete
 * completion evict a still-legitimate winner). `release` /
 * `release-guard` alone never close a generation either, since
 * contract.md allows a new acquisition to start "only once the anchor
 * completion is reconciled" — a generation-opening marker after
 * `release` but before `release-complete` is still a same-generation
 * race, not a fresh generation. See this file's header comment for the
 * anchor-only `release-complete` caveat this replay accepts for a
 * non-anchor child target.
 */
const GENERATION_OPENER_MODES = new Set(['acquire', 'bootstrap', 'resume']);

function findWinningAcquire(
  comments: readonly AuthoringOwnerProvenanceComment[],
  target: string,
  markerPrefix: string,
  trustedMarkerLogins: readonly string[],
): OwnerMarkerEvent | null {
  const trusted = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const events: OwnerMarkerEvent[] = [];
  for (const comment of comments) {
    if (!trusted.has(String(comment.authorLogin ?? '').toLowerCase())) {
      continue;
    }
    const parsed = parseAuthoringOwnerComment(comment.body, markerPrefix);
    if (!parsed || parsed.target !== target) {
      continue;
    }
    events.push({ comment, parsed });
  }
  events.sort((a, b) => {
    if (a.comment.createdAt !== b.comment.createdAt) {
      return a.comment.createdAt < b.comment.createdAt ? -1 : 1;
    }
    return a.comment.id - b.comment.id;
  });

  let winner: OwnerMarkerEvent | null = null;
  let generationOpen = false;
  for (const event of events) {
    if (GENERATION_OPENER_MODES.has(event.parsed.mode)) {
      if (!generationOpen) {
        winner = event;
        generationOpen = true;
      }
      // else: same-generation race -- the first generation-opening
      // marker (acquire, bootstrap, or resume) keeps ownership.
    } else if (
      event.parsed.mode === 'release-complete' &&
      winner &&
      isValidReleaseComplete(event.parsed, winner.parsed)
    ) {
      generationOpen = false;
    }
  }
  return winner;
}

/**
 * True when `completion` (a `mode=release-complete` event) is a valid
 * closure of the generation `winner` opened. contract.md requires all of:
 * - **anchor-only** ("release-complete is valid only on the set
 *   anchor"): `completion.target === completion.anchor` -- a
 *   release-complete recorded on a non-anchor child's own comment
 *   thread (this replay only ever reads the named target's own log, so
 *   `completion.target` is always this issue) can never legitimately
 *   close a generation here.
 * - **required snapshot digest** ("carries the required canonical set
 *   snapshot digest"): `completion.snapshotSha256 !== 'none'` --
 *   `'none'` is release-guard's own sentinel, not a valid completion.
 * - **retains the winning generation's identity** ("retains the
 *   anchor's current owner, set, anchor, and session, and sets
 *   supersedes to that owner token"): owner/set/session/anchor match
 *   `winner`'s, and `supersedes` equals `winner`'s own owner token.
 *
 * A release-complete failing any of these is stale, malformed, or for
 * an unrelated generation, and is ignored rather than closing the
 * current one (#2901 review, chatgpt-codex-connector rounds 2-3).
 */
function isValidReleaseComplete(
  completion: ParsedAuthoringOwnerMarker,
  winner: ParsedAuthoringOwnerMarker,
): boolean {
  return (
    completion.target === completion.anchor &&
    completion.snapshotSha256 !== 'none' &&
    completion.owner === winner.owner &&
    completion.set === winner.set &&
    completion.session === winner.session &&
    completion.anchor === winner.anchor &&
    completion.supersedes === winner.owner
  );
}

/**
 * Compute the sha256 of `input.liveBody` (exact UTF-8 content, matching how
 * the `authoring-owner` marker's `body-sha256` field is documented to be
 * computed — contract.md's "Per-target ownership" section) and compare it
 * against `input.target`'s own trusted winning generation marker (see
 * `findWinningAcquire`).
 *
 * `verdict` is `not-found` when no generation marker won for
 * `input.target`; `pass`/`mismatch` otherwise based on exact digest
 * equality. This never fails open on ambiguity: a missing marker is
 * `not-found`, not `pass`.
 */
export function evaluateAuthoringOwnerProvenance(
  input: AuthoringOwnerProvenanceInput,
): AuthoringOwnerProvenanceResult {
  const computedBodySha256 = createHash('sha256')
    .update(input.liveBody, 'utf8')
    .digest('hex');
  const winner = findWinningAcquire(
    input.comments ?? [],
    input.target,
    input.markerPrefix,
    input.trustedMarkerLogins ?? [],
  );

  if (!winner) {
    return {
      verdict: 'not-found',
      target: input.target,
      computedBodySha256,
      recordedBodySha256: null,
      marker: null,
      checks: [
        {
          id: 'generation_marker_found',
          name: 'A trusted acquire/bootstrap/resume marker won a generation for target',
          result: 'fail',
          evidence: `No trusted acquire/bootstrap/resume authoring-owner marker for target ${input.target} won an open generation in the replayed log.`,
        },
        {
          id: 'body_sha256_match',
          name: "Live body sha256 matches the winning marker's recorded digest",
          result: 'fail',
          evidence: 'No generation marker to compare against.',
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
      mode: winner.parsed.mode,
      owner: winner.parsed.owner,
      set: winner.parsed.set,
      session: winner.parsed.session,
      bodySha256: winner.parsed.bodySha256,
    },
    checks: [
      {
        id: 'generation_marker_found',
        name: 'A trusted acquire/bootstrap/resume marker won a generation for target',
        result: 'pass',
        evidence: `Winning mode=${winner.parsed.mode} marker posted by ${winner.comment.authorLogin} at ${winner.comment.createdAt} (owner=${winner.parsed.owner}).`,
      },
      {
        id: 'body_sha256_match',
        name: "Live body sha256 matches the winning marker's recorded digest",
        result: matches ? 'pass' : 'fail',
        evidence: matches
          ? `computed ${computedBodySha256} matches recorded ${recordedBodySha256}.`
          : `computed ${computedBodySha256} does not match recorded ${recordedBodySha256}.`,
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
  const owner = ((values.owner as string | undefined) ?? '').trim();
  const repo = ((values.repo as string | undefined) ?? '').trim();
  // Copilot review finding on PR #2901: exactly one of --owner/--repo would
  // mix a caller-supplied repo with resolveCurrentGithubRepository()'s
  // current-directory repo, potentially targeting the wrong repository for
  // the issue lookup. Mirrors suitability-close-execute.mts's own
  // --owner/--repo pairing guard: require both or neither.
  if ((owner === '') !== (repo === '')) {
    throw new Error(
      'authoring-owner-provenance: --owner and --repo must be provided together or not at all',
    );
  }
  return {
    issue: issueToken === undefined ? null : Number.parseInt(issueToken, 10),
    owner,
    repo,
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
  node scripts/authoring-owner-provenance.mjs --issue <number> [--owner <owner> --repo <repo>] [--policy <path>] [--marker-prefix <prefix>] [--gh-token <token>] [--trusted-marker-logins <login1,login2>] [--verbose]

Mechanically compares a live issue body's sha256 against that same issue's
own trusted winning ownership-generation authoring-owner marker's recorded
body-sha256 (kurone-kito/idd-skill#2891). Read-only: never posts, labels, or
mutates anything. --owner and --repo must be given together or not at all.

The comparison replays this issue's own authoring-owner marker log to find
the acquire/bootstrap/resume marker that won its last generation (a
same-generation race between two competing generation-opening markers
resolves to the first one -- contract.md: choose the winner by
deterministic comment order); a generation closes only on a
mode=release-complete that retains that generation's exact
owner/set/session/anchor, supersedes that same owner token, is itself
anchor-scoped (target === anchor), and carries a real snapshot digest (not
the release-guard sentinel "none"). Caveat: release-complete is
anchor-only, so for a non-anchor child target in a multi-target set this
replay cannot see the child's true generation boundary and treats every
generation-opening marker on it as one still-open generation -- fail-closed
(mismatch, never a false pass), not a security gap; a review-fix-loop-cutoff
follow-up (the case this helper exists for) is always a single-target
orphan, never a set member.

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 2891, "title": "...", "url": "..."},
  "target": "owner/repo#2891",
  "verdict": "pass|mismatch|not-found",
  "computedBodySha256": "<64-hex>",
  "recordedBodySha256": "<64-hex-or-the-literal-string-none>|null",
  "marker": {"author": "...", "createdAt": "...", "mode": "acquire|bootstrap|resume", "owner": "...", "set": "...", "session": "...", "bodySha256": "<64-hex-or-the-literal-string-none>"} | null,
  "checks": [{"id":"generation_marker_found","name":"...","result":"pass|fail"}, {"id":"body_sha256_match","name":"...","result":"pass|fail"}]
}

"not-found" means no trusted acquire/bootstrap/resume authoring-owner
marker won a generation for this issue's own target -- never treated as a
pass. "mismatch" means the live body has changed since the winning
marker's own snapshot, including when its body-sha256 is the
malformed-but-shape-valid sentinel "none" -- it can never equal a real
64-hex computed digest, so this stays fail-closed rather than silently
passing.

--verbose adds an "evidence" string to each checks[] entry (the computed
and recorded digests, or the winning marker's author/timestamp); omitted by
default to keep default output terse.
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
      id: comment.id,
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
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
          id: check.id,
          name: check.name,
          result: check.result,
        })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
