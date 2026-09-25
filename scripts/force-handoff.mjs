#!/usr/bin/env node
// idd-generated-from: src/scripts/force-handoff.mts
//
// The scripts/force-handoff.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
  resolveTrustedCollaboratorMarkerLogins,
} from './collaborator-permission.mjs';
import { planHandoff } from './forced-handoff-marker.mjs';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { renderUnclaimedByMarker } from './marker-helpers.mjs';
import {
  parsePaginatedGhNdjson,
  readClaimStaleAgeMs,
} from './protocol-helpers.mjs';
import { makeReadlinePrompt } from './readline-prompt.mjs';
export const SAME_SUCCESSOR_WARNING =
  'WARNING: successor agent-id is unchanged from the displaced claim; if that session cannot resume, this issue remains effectively unclaimed.';
/** Operator keyword that releases the claim instead of transferring it. */
export const RELEASE_SUCCESSOR_KEYWORD = 'release';
export const NON_TTY_ERROR =
  'operator interaction is required; run idd-force-handoff in an interactive TTY';
export async function runHandoff(options = {}) {
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
    write = (chunk) => {
      process.stdout.write(chunk);
    },
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
    : ghJson(
        [
          'api',
          '--paginate',
          `repos/${owner}/${name}/issues/${issueNumber}/comments`,
        ],
        true,
      );
  const trustedMarkerLogins =
    givenTrustedLogins ??
    buildTrustedMarkerLogins(owner, name, forcedBy, issueComments);
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const permissionCache = new Map();
  const isAuthorizedForcedHandoff =
    givenAuthPredicate ??
    ((actor) =>
      isAuthorizedForcedHandoffActor(
        owner,
        name,
        actor,
        forcedHandoffAuthorityPolicy,
        permissionCache,
      ));
  // #3270 (Copilot review, PR #3370): planHandoff's staleAgeMs is now
  // required -- this interactive facade previously omitted it and silently
  // used the hardcoded 24h default.
  const staleAgeMs = readClaimStaleAgeMs(loadIddConfig());
  const resolveOpts = {
    trustedMarkerLogins,
    isAuthorizedForcedHandoff,
    forcedBy,
    reason,
    staleAgeMs,
  };
  const firstPass = planHandoff(issueComments, [], resolveOpts);
  const linkedPrs = fetchLinkedPrs
    ? await fetchLinkedPrs(firstPass.branch)
    : ghJson([
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
      ]);
  let planOptions = resolveOpts;
  let plan = planHandoff(issueComments, linkedPrs, planOptions);
  let resolvedPrNumber;
  if (plan.contextScope === 'issue-plus-pr') {
    const prList = plan.prReferences.join(', ');
    const rawPr = await ask(`Open PR on branch (${prList}). Enter PR number: `);
    const prNumber = parsePositiveInteger(rawPr, '--pr');
    planOptions = { ...planOptions, prNumber };
    plan = planHandoff(issueComments, linkedPrs, planOptions);
    resolvedPrNumber = prNumber;
  }
  const rawSuccessorAgentId = await ask(
    `Successor agent-id [leave blank to keep \`${plan.activeClaim.agentId}\`, or \`${RELEASE_SUCCESSOR_KEYWORD}\` for no successor]: `,
  );
  const enteredAgentId = rawSuccessorAgentId.trim();
  if (enteredAgentId.toLowerCase() === RELEASE_SUCCESSOR_KEYWORD) {
    if ((mode ?? readForcedHandoffMode()) !== 'human-gated') {
      throw new Error(
        "forced-handoff mode is not human-gated; idd-force-handoff is only available when forcedHandoff.mode is 'human-gated'",
      );
    }
    if (!isAuthorizedForcedHandoff(forcedBy)) {
      throw new Error(
        `forced-by actor ${forcedBy} is not authorized to release this claim`,
      );
    }
    const releaseBody = renderUnclaimedByMarker({
      agentId: plan.activeClaim.agentId,
      claimId: plan.activeClaim.claimId,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    const releaseLines = [
      '',
      `Forced-handoff plan for issue #${issueNumber}:`,
      `  Context:   ${plan.contextScope}`,
      `  Branch:    ${plan.branch}`,
      `  Old claim: ${plan.activeClaim.agentId} / ${plan.activeClaim.claimId}`,
      '  Action:    release -- no successor',
      '',
      'Marker preview:',
      releaseBody,
      '',
    ];
    write(`${releaseLines.join('\n')}\n`);
    const releaseConfirm = await ask('Confirm forced handoff? [y/N] ');
    ask.close?.();
    if (releaseConfirm.trim().toLowerCase() !== 'y') {
      write('Aborted. No changes made.\n');
      return { posted: false };
    }
    const releaseResult = postComment
      ? await postComment(issueNumber, releaseBody)
      : ghJson([
          'api',
          `repos/${owner}/${name}/issues/${issueNumber}/comments`,
          '--method',
          'POST',
          '-f',
          `body=${releaseBody}`,
        ]);
    const releaseUrl = String(
      releaseResult.html_url ?? releaseResult.url ?? '',
    );
    write(
      [
        '',
        `Claim released: ${releaseUrl}`,
        `  Released claim: ${plan.activeClaim.agentId} / ${plan.activeClaim.claimId}`,
        '',
      ].join('\n'),
    );
    return {
      posted: true,
      commentUrl: releaseUrl,
      contextScope: plan.contextScope,
    };
  }
  if (enteredAgentId) {
    planOptions = { ...planOptions, newAgentId: enteredAgentId };
    plan = planHandoff(issueComments, linkedPrs, planOptions);
  }
  if (!plan.markerBody) {
    throw new Error(
      'cannot generate forced-handoff marker: check that forced-handoff mode is human-gated and the actor is authorized',
    );
  }
  const { newAgentId, newClaimId } = plan.successorIds;
  const successorUnchanged = newAgentId === plan.activeClaim.agentId;
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
    ...(successorUnchanged ? [SAME_SUCCESSOR_WARNING, ''] : []),
  ];
  write(`${lines.join('\n')}\n`);
  const confirm = await ask('Confirm forced handoff? [y/N] ');
  ask.close?.();
  if (confirm.trim().toLowerCase() !== 'y') {
    write('Aborted. No changes made.\n');
    return { posted: false };
  }
  const result = postComment
    ? await postComment(issueNumber, plan.markerBody)
    : ghJson([
        'api',
        `repos/${owner}/${name}/issues/${issueNumber}/comments`,
        '--method',
        'POST',
        '-f',
        `body=${plan.markerBody}`,
      ]);
  const commentUrl = String(result.html_url ?? result.url ?? '');
  write(
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
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `help:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --help spec key
// below. See cli-args.mts's module header for the full invariant.
//
// #3346: this tool previously read no CLI flags at all -- any argv (known
// or not) was silently ignored and the interactive TTY flow ran regardless.
// Adding a minimal --help-only parse here is a genuine (narrow) behavior
// addition, not a pure plumbing change: it lets an unrecognized flag report
// a proper "unknown argument" usage error instead of being swallowed, and
// gives `idd-force-handoff --help` a non-interactive exit instead of
// launching the wizard. Zero-argument invocation -- the only documented
// usage -- stays byte-identical.
const FORCE_HANDOFF_FLAG_SPEC = {
  '--help': { type: 'boolean', short: 'h' },
};
function printUsage() {
  process.stdout.write(`Usage: node scripts/force-handoff.mjs

Interactive, TTY-only operator facade for a forced handoff: prompts for
issue/PR context, successor agent-id/claim-id, and confirmation, then posts
the same marker forced-handoff-marker.mjs would render non-interactively.
Takes no flags of its own; run it with no arguments in an interactive
terminal.

Options:
  --help, -h   show this message
`);
}
export async function main() {
  const { help } = parseCliArgs(process.argv.slice(2), FORCE_HANDOFF_FLAG_SPEC);
  if (help) {
    printUsage();
    return 0;
  }
  try {
    await runHandoff();
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    const classified = classifyHelperError(err);
    return { exitCode: 1, ...classified };
  }
}
function parsePositiveInteger(value, flag) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return Number(raw);
}
function parseOwnerRepo(value) {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}
function ghJson(args, slurp = false) {
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
export function buildTrustedMarkerLogins(
  owner,
  repo,
  viewerLogin,
  issueComments,
  cache,
) {
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
  // #1693: marker-authors-first -- only comment authors whose comment is
  // itself operational-marker-shaped are permission-checked, matching
  // pre-merge-readiness.mts / advisory-convergence.mts /
  // advisory-wait-state.mts. Checking every unique comment author (the
  // prior local loop here) over-trusted ordinary commenters.
  for (const login of resolveTrustedCollaboratorMarkerLogins(
    owner,
    repo,
    issueComments,
    { cache },
  )) {
    trusted.add(login);
  }
  return trusted;
}
function readTrustedMarkerActorsFromConfig() {
  try {
    const config = JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
    const actors = config?.trustedMarkerActors;
    if (Array.isArray(actors)) {
      return actors.map(String).filter(Boolean);
    }
  } catch {
    // config absent or unreadable
  }
  return [];
}
function readCollaboratorTrustEnabled() {
  try {
    const config = JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
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
function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}
function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('force-handoff', main);
  } else {
    main().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}
