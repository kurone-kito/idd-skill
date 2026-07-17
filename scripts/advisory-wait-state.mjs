#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-wait-state.mts
//
// The scripts/advisory-wait-state.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import {
  readAdvisoryPrimaryBotLogin,
  readAdvisorySecondaryBotLogin,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mjs';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { ghText, safeGhText } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  buildAdvisoryWaitSummary,
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls main() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const ADVISORY_WAIT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  main();
}
// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const viewerLogin = safeGhText([
    'api',
    'user',
    '--jq',
    '.login',
  ]).toLowerCase();
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: loadIddConfig(),
    });
  const prHeadSha = ghText([
    'pr',
    'view',
    String(args.prNumber),
    '-R',
    repoRef,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]);
  const reviews = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
    true,
  );
  const requestedReviewers = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
    false,
  );
  const timelineEvents = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
    true,
    ['-H', 'Accept: application/vnd.github+json'],
  );
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  );
  const collaboratorTrustEnabled = isTruthy(
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(owner, repo, comments)
      : []),
  ]);
  const advisoryWaitPolicy = readAdvisoryWaitPolicy();
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const secondaryBotLogin = readAdvisorySecondaryBotLogin();
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers: requestedReviewers.users ?? [],
      timelineEvents,
      comments: comments.map(normalizeComment),
    },
    {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      secondaryBotLogin,
      viewerLogin,
      configuredTrustedActors,
      collaboratorTrustEnabled,
      trustedMarkerLogins,
    },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ...summary,
        trustedMarkerActors: configuredTrustedActors,
        trustedMarkerActorsSource,
      },
      null,
      2,
    )}\n`,
  );
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, ADVISORY_WAIT_STATE_FLAG_SPEC);
  return {
    // Resolves to null on an invalid/absent value (fails closed at the
    // caller) -- the established contract this migration must preserve;
    // matches advisory-convergence.mts's --pr.
    prNumber: parseCanonicalIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    trustedMarkerLogins: values['trusted-marker-logins'],
    now: values.now,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--now <ISO8601>]
`);
}
function normalizeComment(comment) {
  return {
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
  };
}
function resolveTrustedCollaboratorMarkerLogins(owner, repo, comments) {
  const advisoryAuthors = [
    ...new Set(
      comments
        .filter((comment) => advisoryMarkerComment(comment.body ?? ''))
        .map((comment) => comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];
  return advisoryAuthors.filter((login) => {
    const permission = safeGhText([
      'api',
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      '--jq',
      '.permission',
    ]).toLowerCase();
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}
function advisoryMarkerComment(body) {
  const normalized = String(body ?? '');
  return (
    normalized.startsWith('advisory-wait:') ||
    normalized.startsWith('advisory-wait-recovery:') ||
    normalized.startsWith('<!-- advisory-wait:')
  );
}
function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}
function ghApiJson(path, paginate = false, extraArgs = []) {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.splice(1, 0, '--paginate', '--jq', '.[]');
    return parsePaginatedGhNdjson(
      execFileSync('gh', args, { encoding: 'utf8' }),
    );
  }
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}
