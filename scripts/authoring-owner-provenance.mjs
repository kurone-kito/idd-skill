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
//
// Generation-boundary caveat: `mode=release-complete` is anchor-only
// (contract.md). For `target === anchor` -- the single-target hold shape
// this helper is built for (a review-fix-loop-cutoff follow-up is always
// orphan-shaped, never a set member) -- the target's own comment log
// carries every generation boundary directly and the replay below is
// exact. A non-anchor child in a multi-target set never carries its own
// `release-complete`, so this helper (which reads only the named
// `--issue`'s own log, never an anchor's) cannot see a child's true
// generation boundary; every acquire on such a child reads as one
// still-open generation. That is the fail-closed direction -- a
// legitimately re-acquired child compares against the first
// generation's digest and reports `mismatch`, never a false `pass` --
// so it is an accepted limitation, not a defect. Fetching the anchor's
// own log to resolve it is out of scope for kurone-kito/idd-skill#2891.
import { createHash } from 'node:crypto';
import { parseCliArgs } from './cli-args.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import { parseAuthoringOwnerComment } from './marker-helpers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
function normalizeMarkerPrefix(prefix) {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_MARKER_PREFIX;
}
/**
 * Replay `target`'s own trusted `authoring-owner` marker log in
 * chronological order (ties broken by comment `id`, ascending — the
 * deterministic order contract.md's replay rule requires) and return the
 * `mode=acquire` marker that won the log's last generation, or `null` if
 * none exists.
 *
 * A generation opens at an acquire marker when no generation is
 * currently open; the first acquire in an open generation keeps
 * ownership through the whole generation (contract.md: "choose the
 * winner by deterministic comment order"), so a second acquire while a
 * generation is already open is a same-generation race — a losing
 * racer or a duplicate — and never overrides the winner (kurone-kito/idd-skill#2891
 * review: this previously picked the globally-last acquire instead,
 * which could authorize the auto-release exception against a losing
 * racer's edited-body digest). A generation closes only on a
 * `mode=release-complete` that retains the exact owner/set/session/
 * anchor of the currently open generation's winning acquire and
 * supersedes that same owner token (`isMatchingCompletion` below) — a
 * stale or malformed release-complete for a different owner/set never
 * closes it (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector:
 * closing on any release-complete for the target, unchecked, could let
 * an unrelated completion evict a still-legitimate winner). `release` /
 * `release-guard` alone never close a generation either, since
 * contract.md allows a new acquisition to start "only once the anchor
 * completion is reconciled" — an acquire after `release` but before
 * `release-complete` is still a same-generation race, not a fresh
 * generation. See this file's header comment for the anchor-only
 * `release-complete` caveat this replay accepts for a non-anchor child
 * target.
 */
function findWinningAcquire(
  comments,
  target,
  markerPrefix,
  trustedMarkerLogins,
) {
  const trusted = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const events = [];
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
  let winner = null;
  let generationOpen = false;
  for (const event of events) {
    if (event.parsed.mode === 'acquire') {
      if (!generationOpen) {
        winner = event;
        generationOpen = true;
      }
      // else: same-generation race -- the first acquire keeps ownership.
    } else if (
      event.parsed.mode === 'release-complete' &&
      winner &&
      isMatchingCompletion(event.parsed, winner.parsed)
    ) {
      // #2901 review, chatgpt-codex-connector: a release-complete marker
      // closes the CURRENT generation only when it retains that
      // generation's exact owner/set/session/anchor and supersedes that
      // same owner token (contract.md: "It retains the anchor's current
      // owner, set, anchor, and session, and sets supersedes to that
      // owner token"). A stale or malformed release-complete for a
      // different owner/set never closes this generation -- ignoring it
      // (rather than closing on any release-complete for the target) is
      // what keeps a still-open generation's winner from being displaced
      // by an unrelated completion.
      generationOpen = false;
    }
  }
  return winner;
}
/** True when `completion` (a `mode=release-complete` event) retains the
 * exact owner/set/session/anchor of `winningAcquire` and supersedes that
 * same owner token -- the only shape contract.md recognizes as a valid
 * closure of the generation `winningAcquire` opened. */
function isMatchingCompletion(completion, winningAcquire) {
  return (
    completion.owner === winningAcquire.owner &&
    completion.set === winningAcquire.set &&
    completion.session === winningAcquire.session &&
    completion.anchor === winningAcquire.anchor &&
    completion.supersedes === winningAcquire.owner
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
export function evaluateAuthoringOwnerProvenance(input) {
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
          id: 'acquire_marker_found',
          name: 'Trusted mode=acquire owner marker found for target',
          result: 'fail',
          evidence: `No trusted mode=acquire authoring-owner marker for target ${input.target} won an open generation in the replayed log.`,
        },
        {
          id: 'body_sha256_match',
          name: 'Live body sha256 matches acquire-time recorded digest',
          result: 'fail',
          evidence: 'No acquire marker to compare against.',
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
        evidence: `Winning acquire posted by ${winner.comment.authorLogin} at ${winner.comment.createdAt} (owner=${winner.parsed.owner}).`,
      },
      {
        id: 'body_sha256_match',
        name: 'Live body sha256 matches acquire-time recorded digest',
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
};
if (import.meta.main) {
  runCli();
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    AUTHORING_OWNER_PROVENANCE_FLAG_SPEC,
  );
  const issueToken = values.issue;
  const owner = (values.owner ?? '').trim();
  const repo = (values.repo ?? '').trim();
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
    policy: values.policy ?? '',
    markerPrefix: values['marker-prefix'] ?? '',
    ghToken: values['gh-token'] ?? '',
    trustedMarkerLogins: values['trusted-marker-logins'] ?? '',
    verbose: values.verbose,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/authoring-owner-provenance.mjs --issue <number> [--owner <owner> --repo <repo>] [--policy <path>] [--marker-prefix <prefix>] [--gh-token <token>] [--trusted-marker-logins <login1,login2>] [--verbose]

Mechanically compares a live issue body's sha256 against that same issue's
own trusted mode=acquire authoring-owner marker's recorded body-sha256
(kurone-kito/idd-skill#2891). Read-only: never posts, labels, or mutates
anything. --owner and --repo must be given together or not at all.

The comparison replays this issue's own authoring-owner marker log to find
the acquire marker that won its last generation (a same-generation race
between two competing acquires resolves to the first one, per contract.md's
deterministic-comment-order tie-break); a generation closes only on
mode=release-complete. Caveat: release-complete is anchor-only, so for a
non-anchor child target in a multi-target set this replay cannot see the
child's true generation boundary and treats every acquire on it as one
still-open generation -- fail-closed (mismatch, never a false pass), not a
security gap; a review-fix-loop-cutoff follow-up (the case this helper
exists for) is always a single-target orphan, never a set member.

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 2891, "title": "...", "url": "..."},
  "target": "owner/repo#2891",
  "verdict": "pass|mismatch|not-found",
  "computedBodySha256": "<64-hex>",
  "recordedBodySha256": "<64-hex-or-the-literal-string-none>|null",
  "marker": {"author": "...", "createdAt": "...", "owner": "...", "set": "...", "session": "...", "bodySha256": "<64-hex-or-the-literal-string-none>"} | null,
  "checks": [{"id":"acquire_marker_found","name":"...","result":"pass|fail"}, {"id":"body_sha256_match","name":"...","result":"pass|fail"}]
}

"not-found" means no trusted mode=acquire authoring-owner marker exists for
this issue's own target -- never treated as a pass. "mismatch" means the
live body has changed since the acquire-time marker was posted, including
when the winning acquire's own body-sha256 is the malformed-but-shape-valid
sentinel "none" -- it can never equal a real 64-hex computed digest, so
this stays fail-closed rather than silently passing.

--verbose adds an "evidence" string to each checks[] entry (the computed
and recorded digests, or the winning marker's author/timestamp); omitted by
default to keep default output terse.
`);
}
function runCli() {
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
  const comments = port.listWorkItemComments(issueNumber).map((comment) => ({
    id: comment.id,
    authorLogin: comment.authorLogin,
    body: comment.body,
    createdAt: comment.createdAt,
  }));
  const policy = loadPolicyConfig(args.policy || undefined);
  const config = policy.config;
  const markerPrefix = normalizeMarkerPrefix(
    args.markerPrefix || config?.markerPrefix,
  );
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: config,
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
