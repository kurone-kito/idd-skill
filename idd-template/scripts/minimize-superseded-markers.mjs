#!/usr/bin/env node
// idd-generated-from: src/scripts/minimize-superseded-markers.mts
//
// The scripts/minimize-superseded-markers.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Deliberately NOT importing the shared config-loader module (see #1208's
// PR discussion): docs/idd-helper-scripts.md documents that this helper
// "stays self-contained so the template copy works without
// protocol-helpers.mjs" — the curated idd-template/scripts/ mirror
// carries only this one file, so any cross-file import (even a small one)
// breaks the template copy with ERR_MODULE_NOT_FOUND. This applies
// regardless of extension, so keep this local copy in both the .mts
// source and its generated .mjs/template-mirror artifacts.
function loadIddConfig() {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
  } catch {
    return null;
  }
}
const ALLOWED_CLASSIFIERS = new Set(['OUTDATED', 'RESOLVED']);
const ALLOWED_FORMATS = new Set(['json', 'table']);
const MINIMIZABLE_TYPENAMES = new Set([
  'IssueComment',
  'PullRequestReview',
  'PullRequestReviewComment',
]);
// GitHub's GraphQL node(id:) query returns this message (independent of
// subject type) whenever an id cannot be resolved — including, but NOT
// limited to, a REST numeric id passed where a GraphQL global node id is
// required. The same text also covers a syntactically valid node id whose
// object was deleted or is inaccessible, so this pattern alone cannot
// distinguish "wrong id shape" from "right shape, gone object": pair it with
// REST_SHAPED_SUBJECT_ID_PATTERN below before assuming the former. Shared by
// probeSubject's error path and --help so the guidance never drifts between
// the two surfaces.
const UNRESOLVABLE_NODE_ID_PATTERN = /could not resolve to a node/i;
// REST numeric ids (issue comment / PR review / PR review comment) are
// always bare positive integers with no leading zero; GraphQL global node
// ids never are. Gating the enhanced guidance on this shape keeps it from
// misfiring on a GraphQL-shaped id that legitimately failed to resolve
// (deleted or inaccessible), where the raw gh error remains the accurate
// reason. `[1-9]\d*` (rather than `\d+`) excludes "0" and leading-zero forms
// like "0001", which no real REST id ever takes.
const REST_SHAPED_SUBJECT_ID_PATTERN = /^[1-9]\d*$/;
const NODE_ID_CONVERSION_COMMANDS = [
  "  issue comment:     gh api repos/{owner}/{repo}/issues/comments/{comment_id} -q '.node_id'",
  "  PR review:         gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id} -q '.node_id'",
  "  PR review comment: gh api repos/{owner}/{repo}/pulls/comments/{comment_id} -q '.node_id'",
].join('\n');
if (import.meta.main) {
  let args;
  try {
    args = parseMinimizeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!ALLOWED_CLASSIFIERS.has(args.classifier)) {
    console.error(
      `error: --classifier must be one of ${[...ALLOWED_CLASSIFIERS].join(', ')} (got "${args.classifier}")`,
    );
    process.exit(2);
  }
  if (!ALLOWED_FORMATS.has(args.format)) {
    console.error(
      `error: --format must be one of ${[...ALLOWED_FORMATS].join(', ')} (got "${args.format}")`,
    );
    process.exit(2);
  }
  if (args.subjectIds.length === 0) {
    console.error('error: --subject-ids must contain at least one ID');
    process.exit(2);
  }
  const { actors: trustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
      config: loadIddConfig(),
    });
  const trustedSet = new Set(trustedActors);
  if (trustedSet.size === 0 && !args.allowUntrusted) {
    console.error(
      'error: no trusted marker logins supplied. Pass --trusted-marker-logins, set IDD_TRUSTED_MARKER_ACTORS, or list trustedMarkerActors in .github/idd/config.json; or pass --allow-untrusted to explicitly opt out of the author gate.',
    );
    process.exit(2);
  }
  const report = runMinimize({
    subjectIds: args.subjectIds,
    classifier: args.classifier,
    trustedSet,
    apply: args.apply,
    allowUntrusted: args.allowUntrusted,
  });
  report.trustedMarkerActors = [...trustedSet].sort();
  report.trustedMarkerActorsSource = trustedMarkerActorsSource;
  if (args.format === 'table') {
    printTable(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  const exitCode = computeExitCode(report);
  process.exit(exitCode);
}
export function runMinimize({
  subjectIds,
  classifier,
  trustedSet,
  apply,
  allowUntrusted,
}) {
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    classifier,
    counts: {
      eligible: 0,
      alreadyMinimized: 0,
      cannotMinimize: 0,
      untrusted: 0,
      unsupportedType: 0,
      applied: 0,
      failed: 0,
    },
    items: [],
  };
  for (const subjectId of subjectIds) {
    const probe = probeSubject(subjectId);
    if (!probe.ok) {
      report.items.push({ subjectId, status: 'failed', reason: probe.reason });
      report.counts.failed += 1;
      continue;
    }
    const { author, isMinimized, viewerCanMinimize, url, typename } =
      probe.node;
    if (!MINIMIZABLE_TYPENAMES.has(String(typename))) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'skipped',
        reason: 'unsupported-type',
      });
      report.counts.unsupportedType += 1;
      continue;
    }
    if (isMinimized) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'skipped',
        reason: 'already-minimized',
      });
      report.counts.alreadyMinimized += 1;
      continue;
    }
    if (!viewerCanMinimize) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'skipped',
        reason: 'viewer-cannot-minimize',
      });
      report.counts.cannotMinimize += 1;
      continue;
    }
    if (!allowUntrusted && !isTrustedAuthor(author, trustedSet)) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'skipped',
        reason: 'untrusted-author',
        author,
      });
      report.counts.untrusted += 1;
      continue;
    }
    report.counts.eligible += 1;
    if (!apply) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'would-apply',
        author,
      });
      continue;
    }
    const mutation = applyMinimize(subjectId, classifier);
    if (mutation.ok) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'applied',
        author,
      });
      report.counts.applied += 1;
    } else {
      report.items.push({
        subjectId,
        url,
        typename,
        status: 'failed',
        reason: mutation.reason,
      });
      report.counts.failed += 1;
    }
  }
  return report;
}
// cspell:ignore Wpaqs
// probeSubject requires a GraphQL global node id (e.g.
// IC_kwDOSWpaqs8AAAABIk9VAg) — REST responses instead surface a numeric id
// (e.g. 4870591746). A bare integer is never auto-converted here: it could
// belong to an issue comment, a PR review, or a PR review comment, each
// served by a different REST endpoint, so guessing which one risks querying
// the wrong resource. Point the caller at the exact conversion command
// instead.
function unresolvableNodeIdReason(subjectId) {
  return (
    `unresolvable-node-id: "${subjectId}" is not a GraphQL node ID. ` +
    "probeSubject queries GitHub's GraphQL node(id: $id) API, which " +
    'requires a GraphQL global node ID (e.g. IC_kwDOSWpaqs8AAAABIk9VAg), ' +
    'not a REST numeric ID (e.g. 4870591746). Convert the REST ID to its ' +
    `node ID first, using the command for the subject type:\n${NODE_ID_CONVERSION_COMMANDS}`
  );
}
// Both conditions must hold: the subject id must itself look REST-shaped
// (see REST_SHAPED_SUBJECT_ID_PATTERN above), not just the error text —
// otherwise a valid-but-deleted/inaccessible GraphQL node id would be
// misreported as "not a GraphQL node ID".
function isUnresolvableRestShapedId(subjectId, errorText) {
  return (
    REST_SHAPED_SUBJECT_ID_PATTERN.test(subjectId) &&
    UNRESOLVABLE_NODE_ID_PATTERN.test(errorText)
  );
}
export function probeSubject(subjectId) {
  const result = runGh([
    'api',
    'graphql',
    '-f',
    `query=query($id:ID!){
        node(id:$id){
          __typename
          ... on IssueComment{id url isMinimized minimizedReason viewerCanMinimize author{login}}
          ... on PullRequestReview{id url isMinimized minimizedReason viewerCanMinimize author{login}}
          ... on PullRequestReviewComment{id url isMinimized minimizedReason viewerCanMinimize author{login}}
        }
      }`,
    '-f',
    `id=${subjectId}`,
  ]);
  if (!result.ok) {
    if (isUnresolvableRestShapedId(subjectId, result.stderr)) {
      return { ok: false, reason: unresolvableNodeIdReason(subjectId) };
    }
    return {
      ok: false,
      reason: `gh-graphql-error: ${result.stderr.slice(0, 200)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      reason: `gh-graphql-parse: ${error.message}`,
    };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const joinedErrors = parsed.errors
      .map((e) => String(e.message ?? ''))
      .filter(Boolean)
      .join('; ');
    if (isUnresolvableRestShapedId(subjectId, joinedErrors)) {
      return { ok: false, reason: unresolvableNodeIdReason(subjectId) };
    }
    return {
      ok: false,
      reason: `gh-graphql-errors: ${joinedErrors.slice(0, 200)}`,
    };
  }
  const node = parsed?.data?.node;
  if (!node) {
    return { ok: false, reason: 'node-missing' };
  }
  return {
    ok: true,
    node: {
      typename: node.__typename,
      url: node.url,
      isMinimized: node.isMinimized,
      viewerCanMinimize: node.viewerCanMinimize,
      author: node.author?.login,
    },
  };
}
export function applyMinimize(subjectId, classifier) {
  const result = runGh([
    'api',
    'graphql',
    '-f',
    `query=mutation($id:ID!,$classifier:ReportedContentClassifiers!){
      minimizeComment(input:{subjectId:$id,classifier:$classifier}){
        minimizedComment{
          __typename
          ... on IssueComment{id isMinimized minimizedReason}
          ... on PullRequestReview{id isMinimized minimizedReason}
          ... on PullRequestReviewComment{id isMinimized minimizedReason}
        }
      }
    }`,
    '-f',
    `id=${subjectId}`,
    '-f',
    `classifier=${classifier}`,
  ]);
  if (!result.ok) {
    return {
      ok: false,
      reason: `mutation-error: ${result.stderr.slice(0, 200)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, reason: `mutation-parse: ${error.message}` };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    return {
      ok: false,
      reason: `mutation-graphql-errors: ${parsed.errors
        .map((e) => String(e.message ?? ''))
        .filter(Boolean)
        .join('; ')
        .slice(0, 200)}`,
    };
  }
  const minimized = parsed?.data?.minimizeComment?.minimizedComment;
  if (minimized?.isMinimized !== true) {
    return {
      ok: false,
      reason: `mutation-no-confirmation: minimizedComment.isMinimized was not true`,
    };
  }
  return { ok: true };
}
export function normalizeTrustedMarkerLogins(logins) {
  return [
    ...new Set(
      (Array.isArray(logins) ? logins : [])
        .map((login) =>
          String(login ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}
// Local flag > env > config ladder mirroring the shared
// resolveTrustedMarkerActors() contract. This helper stays
// self-contained because the template mirror ships without
// protocol-helpers.mjs.
export function resolveTrustedActors({
  flagValue = '',
  envValue = '',
  config = null,
} = {}) {
  const fromFlag = normalizeTrustedMarkerLogins(splitLoginCsv(flagValue));
  if (fromFlag.length > 0) {
    return { actors: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(splitLoginCsv(envValue));
  if (fromEnv.length > 0) {
    return { actors: fromEnv, source: 'env' };
  }
  const configActors = config?.trustedMarkerActors;
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(configActors) ? configActors : [],
  );
  if (fromConfig.length > 0) {
    return { actors: fromConfig, source: 'config' };
  }
  return { actors: [], source: 'none' };
}
function splitLoginCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((login) => login.trim())
    .filter((login) => login.length > 0);
}
export function isTrustedAuthor(author, trustedSet) {
  if (!author) {
    return false;
  }
  return trustedSet.has(String(author).toLowerCase());
}
export function computeExitCode(report) {
  if (report.counts.failed > 0) {
    return 1;
  }
  return 0;
}
function printTable(report) {
  console.log(`mode: ${report.mode}  classifier: ${report.classifier}`);
  const c = report.counts;
  console.log(
    `counts: eligible=${c.eligible} applied=${c.applied} failed=${c.failed} already=${c.alreadyMinimized} blocked=${c.cannotMinimize} untrusted=${c.untrusted} unsupported=${c.unsupportedType}`,
  );
  for (const item of report.items) {
    const url = item.url ?? '(no url)';
    const reason = item.reason ?? '';
    console.log(`  [${item.status}] ${item.subjectId}  ${url}  ${reason}`);
  }
}
function runGh(argv) {
  try {
    const stdout = execFileSync('gh', argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    const e = error;
    return {
      ok: false,
      stderr: String(e.stderr?.toString?.() ?? e.message ?? 'unknown error'),
    };
  }
}
// Calls node:util's parseArgs directly rather than the shared
// src/scripts/cli-args.mts wrapper: cli-args.mts is a `./`-relative
// import, which would break this file's self-contained invariant (see the
// loadIddConfig() comment above) — node:util is a built-in, so it does
// not. This file has zero integer flags, so it needs none of the
// wrapper's extra canonical-integer / single-dash-disambiguation helpers.
// See kurone-kito/idd-skill#1486 for the full disposition writeup.
//
// Narrow, deliberate behavior deltas from the previous hand-rolled
// for/switch loop (none is exercised by tests/minimize-superseded-markers.test.mts,
// and docs/idd-helper-scripts.md does not name any of their exact wording —
// the same class of accepted delta already shipped for this file's
// if (!value)-cohort siblings idd-doctor.mts / verify-workshop-integrity.mts
// in kurone-kito/idd-skill#1467). All still exit 2 via the unchanged
// try/catch in the import.meta.main entrypoint above (which calls this
// function), same as the behavior they replace:
//   - A value-taking flag with genuinely nothing after it (end of argv)
//     now throws parseArgs' own "Option '--x <value>' argument missing"
//     instead of this file's old per-flag `--x requires a value` text.
//     (The *empty-string* case -- `--x ''` -- is unaffected: the explicit
//     post-parse check below still throws the exact original message for
//     that case, which is the behavior kurone-kito/idd-skill#1451 was
//     actually concerned with.)
//   - An unknown flag or unexpected bare argument now surfaces parseArgs'
//     own "Unknown option '--x'" / "Unexpected argument 'x'..." text
//     instead of this file's old uniform `unknown argument: <token>`.
//   - A dash-shaped value passed to a string flag (e.g.
//     `--subject-ids --apply`) is now rejected up front ("argument is
//     ambiguous", exit 2) where the old loop silently accepted it as a
//     literal string value -- previously this often still failed, but
//     later and indirectly, once the bogus value's `gh` probe lookup
//     failed (a per-item failure, exit 1 via computeExitCode).
//   - `--apply=<value>` (or any other boolean flag with `=`) now throws
//     "does not take an argument" instead of falling through to
//     `unknown argument: --apply=<value>`.
//   - Conversely, `--subject-ids=<value>` (or `=` on any other string
//     flag) is now silently *accepted* as an alternate value syntax; the
//     old loop's exact `arg === '--subject-ids'` comparison never matched
//     the `=`-joined form, so it fell through to
//     `unknown argument: --subject-ids=<value>`. The empty-string form
//     (`--subject-ids=`) is unaffected either way -- it still hits the
//     post-parse check below exactly like `--subject-ids ''` does.
//   - A bare trailing `--` (the POSIX end-of-options marker) is now
//     silently accepted as a no-op, where the old loop's exact-match
//     fallthrough rejected it as `unknown argument: --`. Not expected to
//     matter in practice: this helper is only ever invoked from fixed,
//     known argument lists (CI workflows, documented manual commands),
//     never arbitrary/untrusted argv.
function parseMinimizeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      apply: { type: 'boolean' },
      'allow-untrusted': { type: 'boolean' },
      'subject-ids': { type: 'string' },
      classifier: { type: 'string', default: 'OUTDATED' },
      // '--trusted-marker-logins' is the one flag whose empty string is a
      // meaningful, accepted value (an explicit empty override in
      // resolveTrustedActors()'s flag > env > config ladder) -- unlike
      // the three flags checked below, it gets no post-parse empty-string
      // rejection; parseArgs' own "argument missing" error already covers
      // the genuinely-absent case.
      'trusted-marker-logins': { type: 'string', default: '' },
      format: { type: 'string', default: 'json' },
    },
    strict: true,
  });
  // parseArgs accepts an explicit empty string for every string flag (only
  // a genuinely missing value throws), but --subject-ids/--classifier/
  // --format never treated '' as meaningful -- reproduce that rejection
  // explicitly, matching the original `if (!value)` guards' exact message.
  for (const flag of ['subject-ids', 'classifier', 'format']) {
    if (values[flag] === '') {
      throw new Error(`--${flag} requires a value`);
    }
  }
  return {
    subjectIds: (values['subject-ids'] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    classifier: values.classifier ?? 'OUTDATED',
    trustedMarkerLogins: values['trusted-marker-logins'] ?? '',
    apply: values.apply ?? false,
    allowUntrusted: values['allow-untrusted'] ?? false,
    format: values.format ?? 'json',
    help: values.help ?? false,
  };
}
function printUsage() {
  console.log(`Usage: minimize-superseded-markers --subject-ids <id1,id2,...> [--classifier OUTDATED|RESOLVED] [--trusted-marker-logins login1,login2] [--allow-untrusted] [--apply] [--format json|table]

The trusted-author gate is mandatory by default: supply trusted logins
via --trusted-marker-logins, IDD_TRUSTED_MARKER_ACTORS, or the
trustedMarkerActors list in .github/idd/config.json (flag > env >
config precedence) so the helper rejects markers from untrusted GitHub
actors. Use --allow-untrusted only when you intentionally want to
minimize markers regardless of author, and the caller has already
verified the subject IDs are operationally safe to hide.

--subject-ids must be GraphQL global node IDs (e.g.
IC_kwDOSWpaqs8AAAABIk9VAg), not REST numeric IDs (e.g. 4870591746).
Convert a REST ID to its node ID first, using the command for the
subject type:
${NODE_ID_CONVERSION_COMMANDS}`);
}
