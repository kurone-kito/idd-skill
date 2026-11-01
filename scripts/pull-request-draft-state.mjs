// idd-generated-from: src/scripts/pull-request-draft-state.mts
//
// The scripts/pull-request-draft-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Pull-request draft-state transition core (#4908). The core moves one open
// pull request between draft and ready-for-review and nothing else: it never
// merges, pushes, changes labels, or releases a claim. A dry run is the
// default. Every refusal happens before the transition request, and an
// applied transition counts as done only after a fresh read confirms it.
// Packaging as a command is out of scope here (#4909).
const FULL_SHA = /^[0-9a-f]{40}$/;
function callGh(deps, args) {
  try {
    return deps.gh(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: -1, stdout: '', stderr: message };
  }
}
/** Reads the pull request and parses only the fields this core needs. */
function readPullRequest(deps, request) {
  const result = callGh(deps, [
    'api',
    `repos/${request.owner}/${request.repo}/pulls/${request.number}`,
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      refusal: 'inaccessible',
      detail: `pull request read ended with status ${result.status}: ${result.stderr.trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      refusal: 'read-failed',
      detail: 'pull request read printed malformed JSON',
    };
  }
  const state = parsePullRequestState(parsed);
  if (state === null) {
    return {
      ok: false,
      refusal: 'read-failed',
      detail:
        'pull request read is missing node_id, state, merged, draft, head.sha, or base.repo.full_name',
    };
  }
  return { ok: true, state };
}
function parsePullRequestState(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value;
  const head = record['head'];
  const base = record['base'];
  const baseRepo = base?.['repo'];
  if (
    typeof record['node_id'] !== 'string' ||
    typeof record['state'] !== 'string' ||
    typeof record['merged'] !== 'boolean' ||
    typeof record['draft'] !== 'boolean' ||
    typeof head?.['sha'] !== 'string' ||
    typeof baseRepo?.['full_name'] !== 'string'
  ) {
    return null;
  }
  return {
    nodeId: record['node_id'],
    open: record['state'] === 'open',
    merged: record['merged'],
    isDraft: record['draft'],
    headSha: head['sha'],
    baseRepository: baseRepo['full_name'],
  };
}
/**
 * Refusal for a state that must not be transitioned. `null` when the pull
 * request is open, unmerged, in the configured base repository, and still on
 * the expected head.
 */
function refusalFor(state, request) {
  if (state.merged) {
    return 'merged';
  }
  if (!state.open) {
    return 'closed';
  }
  if (
    state.baseRepository.toLowerCase() !==
    `${request.owner}/${request.repo}`.toLowerCase()
  ) {
    return 'wrong-base-repository';
  }
  if (state.headSha !== request.expectedHeadSha) {
    return 'changed-head';
  }
  return null;
}
function describeRefusal(code, detail) {
  return `${code}: ${detail}`;
}
function refused(request, observed, refusal, detail, mutationSent) {
  return {
    verdict: 'refused',
    target: request.target,
    expectedHeadSha: request.expectedHeadSha,
    observed,
    refusal,
    detail,
    mutationSent,
  };
}
function mutationQuery(target) {
  return target === 'draft'
    ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
    : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
}
/**
 * Evaluates, and when `request.apply` is set performs, one draft or ready
 * transition on a single pull request.
 *
 * Order: validate the request, read the pull request, refuse on any unsafe
 * state, then report a dry run or an already-correct state with no request.
 * An applied transition re-reads immediately before the mutation (a head race
 * is refused there), sends one GraphQL mutation, and verifies with a fresh read.
 */
// audit:ignore-dead-export: the command wrapper that calls this core is the sibling child #4909; until it lands, only the focused tests call it
export function evaluatePullRequestDraftTransition(request, deps) {
  const base = {
    target: request.target,
    expectedHeadSha: request.expectedHeadSha,
  };
  if (request.target !== 'draft' && request.target !== 'ready') {
    return {
      ...base,
      verdict: 'refused',
      observed: null,
      refusal: 'invalid-target',
      detail: describeRefusal(
        'invalid-target',
        'target must be draft or ready',
      ),
      mutationSent: false,
    };
  }
  if (!FULL_SHA.test(request.expectedHeadSha)) {
    return refused(
      request,
      null,
      'invalid-head-sha',
      describeRefusal(
        'invalid-head-sha',
        'expected head must be a full 40-character SHA',
      ),
      false,
    );
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    return refused(
      request,
      null,
      'invalid-number',
      describeRefusal(
        'invalid-number',
        'pull request number must be a positive integer',
      ),
      false,
    );
  }
  const first = readPullRequest(deps, request);
  if (!first.ok) {
    return refused(request, null, first.refusal, first.detail, false);
  }
  const firstRefusal = refusalFor(first.state, request);
  if (firstRefusal !== null) {
    return refused(
      request,
      first.state,
      firstRefusal,
      describeRefusal(firstRefusal, 'refused before any transition request'),
      false,
    );
  }
  const wantDraft = request.target === 'draft';
  const alreadyInTarget = first.state.isDraft === wantDraft;
  if (!request.apply) {
    return {
      ...base,
      verdict: 'dry-run',
      observed: first.state,
      refusal: null,
      detail: alreadyInTarget
        ? `dry run: already ${request.target}; nothing would change`
        : `dry run: would change draft state to ${request.target}`,
      mutationSent: false,
    };
  }
  if (alreadyInTarget) {
    return {
      ...base,
      verdict: 'already-in-target-state',
      observed: first.state,
      refusal: null,
      detail: `already ${request.target}; no transition request sent`,
      mutationSent: false,
    };
  }
  // Head race guard: re-read immediately before the mutation.
  const second = readPullRequest(deps, request);
  if (!second.ok) {
    return refused(request, null, second.refusal, second.detail, false);
  }
  const secondRefusal = refusalFor(second.state, request);
  if (secondRefusal !== null) {
    return refused(
      request,
      second.state,
      secondRefusal,
      describeRefusal(
        secondRefusal,
        'changed between the first read and the transition',
      ),
      false,
    );
  }
  if (second.state.isDraft === wantDraft) {
    return {
      ...base,
      verdict: 'already-in-target-state',
      observed: second.state,
      refusal: null,
      detail: `already ${request.target} at the pre-mutation read; no transition request sent`,
      mutationSent: false,
    };
  }
  const mutation = callGh(deps, [
    'api',
    'graphql',
    '-f',
    `query=${mutationQuery(request.target)}`,
    '-f',
    `id=${second.state.nodeId}`,
  ]);
  const mutationOk = mutation.status === 0;
  // Post-change verification: a fresh read, never the mutation response alone.
  const verify = readPullRequest(deps, request);
  if (!verify.ok) {
    return {
      ...base,
      verdict: 'unverified',
      observed: null,
      refusal: null,
      detail: `post-change read failed (${verify.refusal}): ${verify.detail}`,
      mutationSent: true,
    };
  }
  const verifyRefusal = refusalFor(verify.state, request);
  const matchesTarget =
    verifyRefusal === null && verify.state.isDraft === wantDraft;
  if (matchesTarget) {
    return mutationOk
      ? {
          ...base,
          verdict: 'transitioned',
          observed: verify.state,
          refusal: null,
          detail: `draft state is now ${request.target}; verified by a fresh read`,
          mutationSent: true,
        }
      : {
          ...base,
          verdict: 'unverified',
          observed: verify.state,
          refusal: null,
          detail: `transition request failed (${mutation.stderr.trim()}) but the state already matches; outcome unclear`,
          mutationSent: true,
        };
  }
  if (!mutationOk && verify.state.isDraft === first.state.isDraft) {
    return {
      ...base,
      verdict: 'refused',
      observed: verify.state,
      refusal: 'transition-failed',
      detail: describeRefusal(
        'transition-failed',
        `the transition request failed and the state is unchanged: ${mutation.stderr.trim()}`,
      ),
      mutationSent: true,
    };
  }
  return {
    ...base,
    verdict: 'unverified',
    observed: verify.state,
    refusal: verifyRefusal,
    detail: verifyRefusal
      ? `post-change read shows ${verifyRefusal}; the state is not confirmed as ${request.target}`
      : `post-change read shows isDraft=${verify.state.isDraft}, expected ${wantDraft}`,
    mutationSent: true,
  };
}
