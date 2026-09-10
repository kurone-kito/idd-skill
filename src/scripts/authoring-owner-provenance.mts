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
// `mode=acquire` owner marker's recorded `body-sha256` -- specifically
// the target's *first* trusted `mode=acquire` marker (the Stage 1
// acquire), never a later one. contract.md is explicit that this digest
// is "hashed from the fresh read taken immediately before that marker
// was posted, so it already reflects the published body" -- that
// property holds only for the very first acquire, since every acquire
// (including a legitimate re-acquisition after a full release cycle)
// hashes whatever body is live *at its own posting time*, not the
// originally published one. Anchoring on "whichever generation currently
// owns the target" instead of the first acquire would make the check
// tautological for any edit landing before a later re-acquisition
// (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector round 4 --
// see `findStageOneAcquire`'s own doc comment). That comparison
// previously relied entirely on a releasing session's own manual
// judgment; this helper performs and verifies it mechanically instead.
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
// Two accepted limitations, both fail-closed (never a false `pass`), not
// defects: (1) a marker whose own `anchor` differs from its own `target`
// declares itself a multi-target set's non-anchor child, out of scope
// for this single-target-orphan helper (kurone-kito/idd-skill#2901
// review, Copilot round 5). (2) a trusted actor who *deletes* the true
// Stage 1 acquire comment outright (rather than editing it) leaves no
// trace in any API response this helper can read -- detectable tampering
// (an edit) fails closed (`findStageOneAcquire`'s pre-pass), but
// undetectable tampering (a deletion) cannot be caught by a live
// comment-log reader at all (kurone-kito/idd-skill#2901 review round 6,
// chatgpt-codex-connector). contract.md's own remedy for that case is a
// durable record the *authoring session itself* persists in its hold
// state, not an artifact this read-only helper can independently fetch;
// kurone-kito/idd-skill#2891's acceptance criteria scope this helper to
// comparing the live body against the marker's own recorded digest, not
// to designing that separate durable-record mechanism.

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
  updatedAt: string;
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
 * True when two `owner/repo#number` issue-reference strings name the same
 * issue. GitHub owner and repository names are case-insensitive (the
 * canonical casing an API response reports need not match the casing a
 * marker author typed or a URL preserved), so every comparison against a
 * `target` or `anchor` field in this replay must fold case rather than
 * compare bytes -- a byte comparison would let a marker that differs only
 * by capitalization fall through to `not-found` even though it names the
 * same issue (kurone-kito/idd-skill#2901 review, Copilot round 4).
 */
function sameIssueRef(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Matches a real 64-lowercase-hex sha256 digest, excluding the
 * shape-valid-but-malformed sentinel `none` that a marker's own
 * `body-sha256`/`snapshot-sha256` field can legitimately carry for other
 * modes (`release-guard`'s `body-sha256=none`, for example) but never for
 * a genuine Stage 1 `mode=acquire` marker, whose entire purpose is
 * recording the published body's digest.
 */
const REAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * True when `event` is a genuine, unedited Stage 1 `mode=acquire` marker
 * for `target` -- every condition contract.md attaches to a valid
 * acquisition, checked explicitly rather than assumed:
 *
 * - `mode === 'acquire'`: every other mode (`bootstrap`, `resume`,
 *   `heartbeat`, `release`, `release-complete`, ...) presupposes a prior
 *   acquire, so a well-formed history never opens with one of them.
 * - `supersedes === 'none'`: contract.md requires this for `acquire` (and
 *   `bootstrap`) specifically -- only `resume` names a prior owner token
 *   (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector round 5).
 * - `bodySha256` is a real 64-hex digest, never the shape-valid sentinel
 *   `none` -- a Stage 1 acquire's whole purpose is recording the
 *   published body's digest, so `none` here is malformed, not merely
 *   unlucky.
 * - the marker's own `anchor` names the same issue as `target`: per
 *   contract.md, "the anchor's own marker uses its target as the
 *   anchor" -- a marker with a different anchor is a multi-target set's
 *   non-anchor child, out of scope for this helper's single-target
 *   orphan design (kurone-kito/idd-skill#2891's own acceptance
 *   criteria; kurone-kito/idd-skill#2901 review, Copilot round 5).
 *
 * The append-only edit check (contract.md: owner comments "must not be
 * edited or deleted") lives in `findStageOneAcquire`'s own pre-pass, not
 * here -- it must run over every trusted marker-shaped comment before
 * target filtering, not just the one this function receives (see that
 * function's doc comment).
 *
 * Returns `null` when valid, or a short human-readable reason string
 * when not (surfaced in the `acquire_marker_found` check's evidence).
 */
function invalidStageOneAcquireReason(
  event: OwnerMarkerEvent,
  target: string,
): string | null {
  const { parsed } = event;
  if (parsed.mode !== 'acquire') {
    return `first trusted marker has mode=${parsed.mode}, not acquire`;
  }
  if (parsed.supersedes !== 'none') {
    return `acquire marker has supersedes=${parsed.supersedes} (acquire requires none)`;
  }
  if (!REAL_DIGEST_PATTERN.test(parsed.bodySha256)) {
    return `acquire marker's body-sha256 is not a real digest (got ${parsed.bodySha256})`;
  }
  if (!sameIssueRef(parsed.anchor, target)) {
    return `acquire marker's anchor (${parsed.anchor}) differs from its target -- a multi-target set's non-anchor child is out of scope for this helper`;
  }
  return null;
}

/**
 * True when `comment.body` looks like it once was (or currently attempts
 * to be) an `authoring-owner` marker -- either it still opens with the
 * canonical `<!--` HTML-comment-first byte, or it at least still contains
 * the `<marker-prefix>-authoring-owner:` token somewhere (an edit that
 * broke the opener but left the token recognizable). Used only to decide
 * whether an *edited* comment is suspicious enough to fail closed, not to
 * parse it -- a comment failing this check is confidently unrelated to
 * ownership (kurone-kito/idd-skill#2901 review, Copilot round 6).
 */
function looksLikeOwnerMarker(body: string, markerPrefix: string): boolean {
  return (
    body.startsWith('<!--') || body.includes(`${markerPrefix}-authoring-owner:`)
  );
}

/**
 * Find `target`'s own first trusted `authoring-owner` marker in
 * deterministic comment order (`createdAt`, ties broken by comment `id`
 * ascending) and validate it as a genuine Stage 1 `mode=acquire` marker
 * (see `invalidStageOneAcquireReason`).
 *
 * This is deliberately narrower than "whichever marker currently owns
 * the target": contract.md's provenance-check clause and
 * kurone-kito/idd-skill#2891's own acceptance criteria both name "a
 * named target's `mode=acquire` owner marker" -- singular, tied to
 * Stage 1 publication, not a general ownership-resolution query. Only
 * the target's *first* trusted marker can carry that property:
 *
 * - A later `mode=acquire` (a legitimate re-acquisition after a full
 *   release cycle) hashes whatever body is live at *its own* posting
 *   time, not the originally published one -- comparing against it
 *   would make this check pass trivially for a body edited between the
 *   original acquire and the re-acquisition, defeating the point of the
 *   check (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector
 *   round 4: the earlier "winning ownership generation" replay design
 *   picked exactly this kind of later marker).
 * - A same-generation race (two competing `mode=acquire` markers before
 *   any release) still resolves to the first one, matching contract.md's
 *   general "first valid marker by GitHub comment order wins" rule and
 *   this helper's own round-1/round-3 regression tests.
 *
 * Before selecting a first marker at all, a pre-pass rejects the whole
 * log if ANY trusted, owner-marker-shaped comment (`looksLikeOwnerMarker`)
 * was edited (`updatedAt !== createdAt`) -- not just the comment that
 * would otherwise be selected. An editor who edits the true Stage 1
 * acquire into something that no longer parses, or retargets it to a
 * different issue, would otherwise make it silently vanish from the
 * target-matching candidates below, letting a later (legitimate-looking)
 * acquire become `events[0]` unchallenged (kurone-kito/idd-skill#2901
 * review, Copilot round 6: the round-5 `updatedAt` check only inspected
 * the marker this function was about to select, which the edited marker
 * itself is no longer once tampering breaks its parse or its target).
 * This is deliberately over-broad in one direction: an edited `heartbeat`
 * (or any other owner-marker-shaped comment, for any target) also trips
 * it, even though only the eventual Stage 1 acquire matters semantically
 * -- accepted, since contract.md's append-only rule covers "owner
 * comments" generically, and failing closed on any detected edit is the
 * safe direction.
 *
 * Undetectable tampering -- a trusted actor deleting the true Stage 1
 * acquire outright, rather than editing it -- is out of scope: a deleted
 * comment is absent from every API response, so no comment-log reader
 * can see it happened (kurone-kito/idd-skill#2901 review round 6,
 * chatgpt-codex-connector; accepted limitation, same footing as the
 * non-anchor-child limitation above -- see this file's header comment).
 *
 * Returns `{ event: null, rejectReason }` (never a false `pass`) when
 * the log is rejected by the pre-pass or the first marker fails
 * validation, `{ event: null, rejectReason: null }` when no trusted
 * marker exists at all, or `{ event, rejectReason: null }` on success.
 */
function findStageOneAcquire(
  comments: readonly AuthoringOwnerProvenanceComment[],
  target: string,
  markerPrefix: string,
  trustedMarkerLogins: readonly string[],
): { event: OwnerMarkerEvent | null; rejectReason: string | null } {
  const trusted = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const trustedComments = comments.filter((comment) =>
    trusted.has(String(comment.authorLogin ?? '').toLowerCase()),
  );

  for (const comment of trustedComments) {
    if (
      comment.updatedAt !== comment.createdAt &&
      looksLikeOwnerMarker(comment.body, markerPrefix)
    ) {
      return {
        event: null,
        rejectReason:
          `trusted comment #${comment.id} looks like an authoring-owner ` +
          `marker and was edited after posting (createdAt=${comment.createdAt}, ` +
          `updatedAt=${comment.updatedAt}) -- owner comments must be append-only`,
      };
    }
  }

  const events: OwnerMarkerEvent[] = [];
  for (const comment of trustedComments) {
    const parsed = parseAuthoringOwnerComment(comment.body, markerPrefix);
    if (!parsed || !sameIssueRef(parsed.target, target)) {
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

  const first = events[0];
  if (!first) {
    return { event: null, rejectReason: null };
  }
  const rejectReason = invalidStageOneAcquireReason(first, target);
  if (rejectReason) {
    return { event: null, rejectReason };
  }
  return { event: first, rejectReason: null };
}

/**
 * Compute the sha256 of `input.liveBody` (exact UTF-8 content, matching how
 * the `authoring-owner` marker's `body-sha256` field is documented to be
 * computed — contract.md's "Per-target ownership" section) and compare it
 * against `input.target`'s own first trusted `mode=acquire` marker (see
 * `findStageOneAcquire`) -- the Stage 1 acquire, never a later
 * re-acquisition.
 *
 * `verdict` is `not-found` when no trusted marker log for `input.target`
 * opens with a `mode=acquire` marker; `pass`/`mismatch` otherwise based
 * on exact digest equality. This never fails open on ambiguity: a
 * missing or non-acquire-first marker is `not-found`, not `pass`.
 */
export function evaluateAuthoringOwnerProvenance(
  input: AuthoringOwnerProvenanceInput,
): AuthoringOwnerProvenanceResult {
  const computedBodySha256 = createHash('sha256')
    .update(input.liveBody, 'utf8')
    .digest('hex');
  const { event: acquire, rejectReason } = findStageOneAcquire(
    input.comments ?? [],
    input.target,
    input.markerPrefix,
    input.trustedMarkerLogins ?? [],
  );

  if (!acquire) {
    return {
      verdict: 'not-found',
      target: input.target,
      computedBodySha256,
      recordedBodySha256: null,
      marker: null,
      checks: [
        {
          id: 'acquire_marker_found',
          name: "Target's marker log opens with a valid trusted mode=acquire marker",
          result: 'fail',
          evidence: rejectReason
            ? `Target ${input.target}'s first trusted authoring-owner marker is not a valid Stage 1 acquire: ${rejectReason}.`
            : `No trusted authoring-owner marker log for target ${input.target} opens with a mode=acquire marker.`,
        },
        {
          id: 'body_sha256_match',
          name: "Live body sha256 matches the Stage 1 acquire marker's recorded digest",
          result: 'fail',
          evidence: 'No Stage 1 acquire marker to compare against.',
        },
      ],
    };
  }

  const recordedBodySha256 = acquire.parsed.bodySha256;
  const matches = recordedBodySha256 === computedBodySha256;
  return {
    verdict: matches ? 'pass' : 'mismatch',
    target: input.target,
    computedBodySha256,
    recordedBodySha256,
    marker: {
      author: acquire.comment.authorLogin,
      createdAt: acquire.comment.createdAt,
      mode: acquire.parsed.mode,
      owner: acquire.parsed.owner,
      set: acquire.parsed.set,
      session: acquire.parsed.session,
      bodySha256: acquire.parsed.bodySha256,
    },
    checks: [
      {
        id: 'acquire_marker_found',
        name: "Target's marker log opens with a valid trusted mode=acquire marker",
        result: 'pass',
        evidence: `Valid Stage 1 mode=acquire marker posted by ${acquire.comment.authorLogin} at ${acquire.comment.createdAt} (owner=${acquire.parsed.owner}).`,
      },
      {
        id: 'body_sha256_match',
        name: "Live body sha256 matches the Stage 1 acquire marker's recorded digest",
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
  // `Number.parseInt` accepts trailing garbage ("2891junk" -> 2891), so a
  // typo'd --issue would silently target the wrong issue instead of
  // failing loudly (kurone-kito/idd-skill#2901 review, Copilot round 5).
  // Require the whole token to be digits, matching
  // suitability-close-execute.mts's own --issue parsing.
  const issue =
    issueToken !== undefined && /^\d+$/.test(issueToken)
      ? Number(issueToken)
      : null;
  return {
    issue,
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
own Stage 1 mode=acquire authoring-owner marker's recorded body-sha256
(kurone-kito/idd-skill#2891). Read-only: never posts, labels, or mutates
anything. --owner and --repo must be given together or not at all.

The comparison anchors on this issue's own trusted authoring-owner marker
log's *first* marker, in deterministic comment order (createdAt, ties
broken by comment id ascending) -- contract.md and this issue's own
acceptance criteria both name "a named target's mode=acquire owner
marker", singular, tied to Stage 1 publication. That first marker must
itself be mode=acquire: only it is guaranteed to have hashed the body as
published, since every later marker (a same-generation racer, a
bootstrap/resume recovery, or a legitimate re-acquisition after a full
release cycle) hashes whatever body is live at its own posting time, not
the originally published one -- comparing against a later acquire would
make this check pass trivially for a body edited before that later
marker (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector round
4). target comparisons fold case, since GitHub owner/repo names are
case-insensitive.

The first marker must also pass every validity condition contract.md
attaches to a genuine Stage 1 acquire, or this reports not-found rather
than accepting an invalid marker's own digest (kurone-kito/idd-skill#2901
review round 5): mode=acquire itself (every other mode -- bootstrap,
resume, heartbeat, release, ... -- presupposes a prior acquire, so a
well-formed history never opens with one); supersedes=none (contract.md
requires this specifically for acquire); a real 64-hex body-sha256, never
the shape-valid sentinel "none"; and its own anchor names the same issue
as its own target (a mismatch declares the marker a multi-target set's
non-anchor child, out of scope for this single-target-orphan helper).
--verbose surfaces which condition failed in the acquire_marker_found
check's evidence.

Before selecting a marker at all, this also rejects the whole log (with
not-found) if ANY trusted, owner-marker-shaped comment was edited after
posting (its updatedAt differs from its createdAt) -- not just the one
that would otherwise be selected, so an editor cannot make the true
Stage 1 acquire vanish from consideration by editing it into something
unparseable or retargeting it, letting a later acquire silently win
instead (kurone-kito/idd-skill#2901 review round 6, Copilot). This is
deliberately over-broad in one direction (an edited heartbeat, for
example, also trips it) since contract.md's append-only rule covers
owner comments generically. A trusted actor who deletes the true Stage 1
acquire outright, rather than editing it, is an accepted limitation: a
deleted comment leaves no trace in any API response this helper can read
(kurone-kito/idd-skill#2901 review round 6, chatgpt-codex-connector).

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 2891, "title": "...", "url": "..."},
  "target": "owner/repo#2891",
  "verdict": "pass|mismatch|not-found",
  "computedBodySha256": "<64-hex>",
  "recordedBodySha256": "<64-hex>|null",
  "marker": {"author": "...", "createdAt": "...", "mode": "acquire", "owner": "...", "set": "...", "session": "...", "bodySha256": "<64-hex>"} | null,
  "checks": [{"id":"acquire_marker_found","name":"...","result":"pass|fail"}, {"id":"body_sha256_match","name":"...","result":"pass|fail"}]
}

"not-found" means this issue's own trusted authoring-owner marker log does
not open with a valid mode=acquire marker for this target -- never
treated as a pass. "mismatch" means a valid Stage 1 acquire marker exists
but the live body has changed since its own snapshot.

--verbose adds an "evidence" string to each checks[] entry (the computed
and recorded digests, or the acquire marker's author/timestamp); omitted
by default to keep default output terse.
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
  // Fetch the (potentially slow, paginated) comment log BEFORE the issue
  // body, and hash the body immediately after fetching it below -- the
  // whole point of this check is a fresh read taken as close as possible
  // to the comparison, so the body fetch must be the last network call
  // before hashing, not the first (kurone-kito/idd-skill#2901 review,
  // chatgpt-codex-connector round 5: fetching the body first left a
  // window, spanning the comment fetch, during which a live edit would
  // go undetected).
  const comments: AuthoringOwnerProvenanceComment[] = port
    .listWorkItemComments(issueNumber)
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }));
  const rawIssue = port.getWorkItem(issueNumber);
  if (!rawIssue) {
    throw new Error(`issue #${issueNumber} not found`);
  }

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
