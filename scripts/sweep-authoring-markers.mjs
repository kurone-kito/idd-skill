#!/usr/bin/env node
// idd-generated-from: src/scripts/sweep-authoring-markers.mts
//
// The scripts/sweep-authoring-markers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Fetch-driven mandatory hide-on-supersede sweep for `authoring-owner` /
// `authoring-publication-intent` markers (#2935).
//
// Background: #2896 (PR #2898) replaced the per-post hide-on-supersede
// instruction (measured ~3% effective) with a mandatory release-time sweep
// documented in `skills/issue-authoring/references/contract.md` at three
// points in the Stage 2 release flow. Re-measuring that sweep found it only
// 41.7% effective, because "mandatory" still meant a session had to
// correctly reconstruct an ~8-step manual procedure from prose, three
// separate times, every release: paginate the comment log via GraphQL
// (never REST, which never exposes `isMinimized`), classify each body with
// `matchCanonicalAuthoringMarkerFamily`, determine the newest match among
// TRUSTED-actor candidates only, exclude anything already minimized,
// assemble the survivors' GraphQL node IDs by hand, invoke
// `minimize-superseded-markers.mjs`, then re-verify. This script collapses
// that whole procedure into one command: given one or more `--issue`
// targets, it fetches each issue's comments via GraphQL, classifies and
// filters them exactly as the contract describes, and calls into
// `minimize-superseded-markers.mts`'s existing `runMinimize` for the
// mutation -- reusing that logic rather than reimplementing it.
//
// Deliberately a SIBLING script, not a mode grafted onto
// `minimize-superseded-markers.mts` itself: that file's module header
// documents a hard self-containment invariant ("stays self-contained so
// the template copy works without protocol-helpers.mjs" -- `idd-template/
// scripts/` mirrors ONLY that one file, standalone). A fetch-driven mode
// needs `matchCanonicalAuthoringMarkerFamily` (`marker-helpers.mts`, a
// ~3000-line module with its own import graph), which would break that
// invariant if grafted in-place. This file carries no such constraint, so
// it imports normally from `marker-helpers.mts`, `protocol-helpers.mts`,
// `idd-config.mts`, `gh-exec.mts`, and `minimize-superseded-markers.mts`
// (for `runMinimize` and `resolveGhHostnameArgs`), matching the newer,
// non-template-mirrored helpers' own style (e.g.
// `merged-pr-feedback-sweep.mts`, `authoring-owner-provenance.mts`).
//
// Read-only against every issue it scans except for the minimize mutation
// itself, which only ever hides (never edits or deletes) a comment already
// proven superseded by the classification below. Best-effort by design,
// matching the contract's framing: a fetch failure for one `--issue` is
// recorded in the report and does not abort the other issues in the same
// invocation; the caller (the contract's own sweep instructions) treats a
// non-zero exit the same way it already treats `minimize-superseded-
// markers.mjs`'s own possible non-zero exit -- non-blocking.
//
// Scope: `authoring-owner` and `authoring-publication-intent` only, same as
// the sweep it replaces. Every `--issue` given is scanned in the SAME
// `--owner`/`--repo` (defaulting to the current repository) -- this script
// does not parse a cross-repo `owner/repo#N` shorthand for `--issue`,
// matching every other single-repo `--issue <number>` helper in this
// codebase (`authoring-owner-provenance.mts`, `suitability-close-
// execute.mts`); a caller sweeping a cross-repo journal passes its own
// `--owner`/`--repo` in a separate invocation.
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mjs';
import { ghText } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  classifyAuthoringMarkerFamily,
  matchCanonicalAuthoringMarkerFamily,
} from './marker-helpers.mjs';
import {
  resolveGhHostnameArgs,
  runMinimize,
} from './minimize-superseded-markers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
const ALLOWED_CLASSIFIERS = new Set(['OUTDATED', 'RESOLVED']);
const ALLOWED_FORMATS = new Set(['json', 'table']);
const AUTHORING_MARKER_FAMILIES = [
  'authoring-owner',
  'authoring-publication-intent',
];
/**
 * Fetch every comment on `owner/repo#issueNumber` via a paginated GraphQL
 * `issue(number:).comments` query, selecting `isMinimized` directly (the
 * field REST's issue-comments endpoint never carries at all). `timeoutMs`,
 * when supplied, bounds the WHOLE paginated walk (checked before each
 * page's own `gh` call, never passed through as a non-positive value --
 * `ghText`/`execFileSync` both read `timeout: 0` as "no timeout", the
 * opposite of "budget already exhausted"), mirroring `post-idd-
 * marker.mts`'s `hideSupersededPostTimeMarkers` deadline discipline
 * (#2754): a caller sweeping several `--issue` targets under one overall
 * `--deadline-ms` must not let a single large comment log's own pagination
 * consume the entire budget with no cap of its own.
 */
export function fetchIssueCommentsGraphql(owner, repo, issueNumber, timeoutMs) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      comments(first:100,after:$cursor){
        nodes { id url body isMinimized author { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  const out = [];
  let cursor = null;
  const startedAt = Date.now();
  const label = `${owner}/${repo}#${issueNumber}`;
  while (true) {
    let perCallTimeout;
    if (timeoutMs !== undefined) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(
          `sweep-authoring-markers: deadline exceeded while paginating ${label}`,
        );
      }
      perCallTimeout = remaining;
    }
    const args = [
      'api',
      'graphql',
      ...resolveGhHostnameArgs(),
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${issueNumber}`,
      ...(cursor ? ['-f', `cursor=${cursor}`] : []),
    ];
    const raw = ghText(
      args,
      perCallTimeout !== undefined ? { timeout: perCallTimeout } : {},
    );
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (error) {
      throw new Error(
        `sweep-authoring-markers: gh-graphql-parse: ${error.message}`,
      );
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(
        `sweep-authoring-markers: gh-graphql-errors: ${parsed.errors
          .map((e) => String(e.message ?? ''))
          .filter(Boolean)
          .join('; ')}`,
      );
    }
    const issue = parsed.data?.repository?.issue;
    if (issue == null) {
      throw new Error(
        `sweep-authoring-markers: ${label} is not an issue or does not exist`,
      );
    }
    const connection = issue.comments;
    if (connection == null) {
      throw new Error(
        `sweep-authoring-markers: ${label} returned a null comments connection`,
      );
    }
    for (const node of connection.nodes ?? []) {
      out.push({
        nodeId: String(node.id ?? ''),
        url: String(node.url ?? ''),
        body: String(node.body ?? ''),
        authorLogin: String(node.author?.login ?? ''),
        isMinimized: Boolean(node.isMinimized),
      });
    }
    const pageInfo = connection.pageInfo;
    if (!pageInfo?.hasNextPage) {
      break;
    }
    if (!pageInfo.endCursor) {
      throw new Error(
        `sweep-authoring-markers: page reported hasNextPage without endCursor for ${label}`,
      );
    }
    cursor = pageInfo.endCursor;
  }
  return out;
}
function emptyFamilyCounts() {
  return {
    scanned: 0,
    untrusted: 0,
    protectedNewest: 0,
    alreadyMinimized: 0,
    eligible: 0,
    minimized: 0,
    raceAlreadyMinimized: 0,
    deadlineSkipped: 0,
    skippedOther: 0,
    failed: 0,
  };
}
const DEFAULT_DEPS = {
  fetchIssueComments: fetchIssueCommentsGraphql,
  minimize: runMinimize,
};
/**
 * Run the fetch-driven hide-on-supersede sweep across `options.issues`
 * (#2935): for each issue, fetch its comments via GraphQL, classify every
 * comment against both authoring marker families
 * (`classifyAuthoringMarkerFamily`), collect the eligible (trusted,
 * non-newest, not-yet-minimized) candidates' node ids, then submit the
 * FULL cross-issue candidate set to `runMinimize` in one mutation pass.
 * `deps` defaults to the real GraphQL fetch and the real `runMinimize`;
 * tests override either or both. Never throws on a single issue's fetch
 * failure -- that issue's `error` field records it and the sweep continues
 * with the remaining issues, matching the contract's best-effort framing.
 */
export function runAuthoringMarkerSweep(options, deps = DEFAULT_DEPS) {
  const startedAt = Date.now();
  const remaining = () =>
    options.deadlineMs === undefined
      ? undefined
      : options.deadlineMs - (Date.now() - startedAt);
  const families = {
    'authoring-owner': emptyFamilyCounts(),
    'authoring-publication-intent': emptyFamilyCounts(),
  };
  const issues = [];
  const subjectFamilies = new Map();
  for (const issueNumber of options.issues) {
    const budget = remaining();
    if (budget !== undefined && budget <= 0) {
      issues.push({
        owner: options.owner,
        repo: options.repo,
        issue: issueNumber,
        commentCount: 0,
        nonCanonical: 0,
        error: 'deadline-exceeded',
      });
      continue;
    }
    let comments;
    try {
      comments = deps.fetchIssueComments(
        options.owner,
        options.repo,
        issueNumber,
        budget,
      );
    } catch (error) {
      issues.push({
        owner: options.owner,
        repo: options.repo,
        issue: issueNumber,
        commentCount: 0,
        nonCanonical: 0,
        error: error.message,
      });
      continue;
    }
    let nonCanonical = 0;
    const candidates = comments.map((comment) => ({
      body: comment.body,
      author: comment.authorLogin,
      isMinimized: comment.isMinimized,
    }));
    for (const comment of comments) {
      if (
        matchCanonicalAuthoringMarkerFamily(
          comment.body,
          options.markerPrefix,
        ) === null
      ) {
        nonCanonical += 1;
      }
    }
    issues.push({
      owner: options.owner,
      repo: options.repo,
      issue: issueNumber,
      commentCount: comments.length,
      nonCanonical,
    });
    for (const family of AUTHORING_MARKER_FAMILIES) {
      const classification = classifyAuthoringMarkerFamily(
        candidates,
        options.markerPrefix,
        family,
        options.trustedSet,
      );
      const counts = families[family];
      counts.scanned += classification.matchIndexes.length;
      counts.untrusted += classification.untrustedIndexes.length;
      counts.protectedNewest +=
        classification.newestTrustedIndex === null ? 0 : 1;
      counts.alreadyMinimized += classification.alreadyMinimizedIndexes.length;
      counts.eligible += classification.eligibleIndexes.length;
      for (const index of classification.eligibleIndexes) {
        const nodeId = comments[index].nodeId;
        if (nodeId) {
          subjectFamilies.set(nodeId, family);
        }
      }
    }
  }
  const items = [];
  const subjectIds = [...subjectFamilies.keys()];
  if (subjectIds.length > 0) {
    // Bail BEFORE the mutation stage once the budget is already spent
    // (#2935 review, mirroring `post-idd-marker.mts`'s
    // `hideSupersededPostTimeMarkers`, lines "const mutationPassR =
    // remaining(); if (mutationPassR <= 0) return;"): `runMinimize`'s own
    // deadline handling still attempts its index-0 candidate's probe
    // unconditionally (the documented exemption that guarantees forward
    // progress for a STANDALONE `minimize-superseded-markers.mjs` call),
    // which would otherwise cost this sweep one full un-throttled
    // `GH_TIMEOUT_MS` probe call for no benefit once the caller's own
    // overall budget is already exhausted. Every eligible candidate is
    // reported `deadlineSkipped` instead, matching what `runMinimize`
    // itself would report for every candidate past the first if it ran.
    const mutationBudget = remaining();
    if (mutationBudget !== undefined && mutationBudget <= 0) {
      for (const [subjectId, family] of subjectFamilies) {
        families[family].deadlineSkipped += 1;
        items.push({
          subjectId,
          family,
          status: 'skipped',
          reason: 'deadline-exceeded',
        });
      }
    } else {
      const minimizeReport = deps.minimize({
        subjectIds,
        classifier: options.classifier,
        trustedSet: new Set(options.trustedSet),
        apply: options.apply,
        allowUntrusted: false,
        deadlineMs: mutationBudget,
      });
      for (const item of minimizeReport.items) {
        const family = subjectFamilies.get(item.subjectId);
        if (!family) {
          continue;
        }
        items.push({
          subjectId: item.subjectId,
          family,
          url: item.url,
          status: item.status,
          reason: item.reason,
          author: item.author,
        });
        const counts = families[family];
        // `status: 'failed'` is the ONLY outcome this sweep treats as a
        // real failure (#2935 review) -- every other skip reason
        // (`viewer-cannot-minimize`, `unsupported-type`, `untrusted-
        // author`) is a live re-probe legitimately disagreeing with this
        // sweep's own pre-fetch snapshot, not a defect, and `runMinimize`'s
        // own `computeExitCode` already returns 0 for all of them. An
        // earlier revision folded every unrecognized status into `failed`,
        // which would have made `computeSweepExitCode` report a spurious
        // failure for a case `runMinimize` itself considers clean.
        if (item.status === 'applied' || item.status === 'would-apply') {
          counts.minimized += 1;
        } else if (
          item.status === 'skipped' &&
          item.reason === 'already-minimized'
        ) {
          counts.raceAlreadyMinimized += 1;
        } else if (
          item.status === 'skipped' &&
          item.reason === 'deadline-exceeded'
        ) {
          counts.deadlineSkipped += 1;
        } else if (item.status === 'failed') {
          counts.failed += 1;
        } else {
          counts.skippedOther += 1;
        }
      }
    }
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    classifier: options.classifier,
    markerPrefix: options.markerPrefix,
    trustedMarkerActors: [...options.trustedSet].sort(),
    trustedMarkerActorsSource: '',
    issues,
    families,
    items,
  };
}
/** `0` when every issue fetched cleanly (no `deadline-exceeded`-before-
 * fetch and no fetch error) and no family reports a `failed` candidate;
 * `1` otherwise -- mirrors `minimize-superseded-markers.mts`'s own
 * `computeExitCode` for the mutation half (fail only on a real `status:
 * "failed"`, never on `skippedOther` or an empty/all-skipped result), and
 * additionally fails on a fetch-stage problem `runMinimize` has no
 * equivalent for: an issue this sweep never got to scan at all (a `gh`
 * error, a non-issue number, or the overall deadline already spent before
 * its own turn) is deliberately treated as a real failure here, distinct
 * from a per-candidate `deadlineSkipped` inside an issue that WAS
 * scanned. */
export function computeSweepExitCode(report) {
  if (report.issues.some((issue) => issue.error !== undefined)) {
    return 1;
  }
  if (Object.values(report.families).some((counts) => counts.failed > 0)) {
    return 1;
  }
  return 0;
}
// Flag-spec keys stay the dashed literal (tests/flag-name-matrix.test.mts
// scans this file's compiled .mjs source for each canonical flag written
// as a quoted string literal -- see cli-args.mts's module header).
const SWEEP_AUTHORING_MARKERS_FLAG_SPEC = {
  '--issue': { type: 'string', multiple: true },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--marker-prefix': { type: 'string', default: '' },
  '--classifier': { type: 'string', default: 'OUTDATED' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--apply': { type: 'boolean' },
  '--format': { type: 'string', default: 'json' },
  '--deadline-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    SWEEP_AUTHORING_MARKERS_FLAG_SPEC,
  );
  const issueTokens = values.issue ?? [];
  const issues = issueTokens.map((token) =>
    parseCanonicalIntegerOrThrow(token, '--issue'),
  );
  let deadlineMs;
  if (values['deadline-ms'] !== undefined) {
    if (values['deadline-ms'] === '') {
      throw new Error('--deadline-ms requires a value');
    }
    if (!/^(?:0|[1-9]\d*)$/.test(values['deadline-ms'])) {
      throw new Error(
        '--deadline-ms must be a non-negative integer (milliseconds)',
      );
    }
    deadlineMs = Number.parseInt(values['deadline-ms'], 10);
  }
  return {
    issues,
    owner: values.owner ?? '',
    repo: values.repo ?? '',
    markerPrefix: values['marker-prefix'] ?? '',
    classifier: values.classifier ?? 'OUTDATED',
    trustedMarkerLogins: values['trusted-marker-logins'] ?? '',
    apply: Boolean(values.apply),
    format: values.format ?? 'json',
    deadlineMs,
    help,
  };
}
function normalizeMarkerPrefix(flagValue, config) {
  const trimmedFlag = flagValue.trim();
  if (trimmedFlag.length > 0) {
    return trimmedFlag;
  }
  const configValue = config?.markerPrefix;
  const trimmedConfig =
    typeof configValue === 'string' ? configValue.trim() : '';
  return trimmedConfig.length > 0 ? trimmedConfig : DEFAULT_MARKER_PREFIX;
}
function printTable(report) {
  console.log(
    `mode: ${report.mode}  classifier: ${report.classifier}  marker-prefix: ${report.markerPrefix}`,
  );
  for (const issue of report.issues) {
    const suffix = issue.error ? `  error: ${issue.error}` : '';
    console.log(
      `  issue ${issue.owner}/${issue.repo}#${issue.issue}: comments=${issue.commentCount} nonCanonical=${issue.nonCanonical}${suffix}`,
    );
  }
  for (const family of AUTHORING_MARKER_FAMILIES) {
    const c = report.families[family];
    console.log(
      `${family}: scanned=${c.scanned} untrusted=${c.untrusted} protectedNewest=${c.protectedNewest} alreadyMinimized=${c.alreadyMinimized} eligible=${c.eligible} minimized=${c.minimized} raceAlreadyMinimized=${c.raceAlreadyMinimized} deadlineSkipped=${c.deadlineSkipped} skippedOther=${c.skippedOther} failed=${c.failed}`,
    );
  }
  for (const item of report.items) {
    const url = item.url ?? '(no url)';
    const reason = item.reason ?? '';
    console.log(
      `  [${item.status}] ${item.family} ${item.subjectId}  ${url}  ${reason}`,
    );
  }
}
function printUsage() {
  console.log(`Usage: sweep-authoring-markers --issue <number> [--issue <number> ...] [--owner <owner>] [--repo <repo>] [--marker-prefix <prefix>] [--classifier OUTDATED|RESOLVED] --trusted-marker-logins <login1,login2> [--apply] [--format json|table] [--deadline-ms <milliseconds>]

Fetch-driven hide-on-supersede sweep for authoring-owner /
authoring-publication-intent markers (#2935): fetches each --issue's
comments via GraphQL (selecting isMinimized, which REST never carries),
classifies every comment with matchCanonicalAuthoringMarkerFamily, keeps
only the single newest byte-exact canonical match per family among
TRUSTED-actor authors, and minimizes (classifier OUTDATED by default)
every other eligible, not-yet-minimized candidate in one mutation pass --
reusing minimize-superseded-markers.mts's own runMinimize.

Pass one --issue per target to sweep (the per-target preflight and the
anchor-before-release-complete sweep points each pass one; the closing
sweep passes every target plus the anchor and the journal issue in the
same invocation). Every --issue is scanned in the same --owner/--repo
(defaulting to the current repository); this command does not accept a
cross-repo owner/repo#N shorthand.

The trusted-author gate is mandatory, matching minimize-superseded-
markers.mjs: supply --trusted-marker-logins, IDD_TRUSTED_MARKER_ACTORS, or
the trustedMarkerActors list in .github/idd/config.json (flag > env >
config precedence). There is no --allow-untrusted escape hatch here --
unlike a direct minimize-superseded-markers.mjs call, this sweep's own
"newest" determination depends on the trust filter to decide which
comment is the live marker to protect from minimization.

--marker-prefix defaults to the top-level markerPrefix field in
.github/idd/config.json, or "idd-skill" when neither is set.

--deadline-ms bounds the WHOLE sweep (every --issue's own GraphQL
pagination plus the final minimize pass), not just the mutation --
omit it to keep the default unbounded behavior. Best-effort: a single
--issue's fetch failure is recorded in the report and does not abort the
other issues in the same invocation.`);
}
if (import.meta.main) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
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
  if (args.issues.length === 0) {
    console.error('error: --issue must be supplied at least once');
    process.exit(2);
  }
  const config = loadIddConfig();
  const { actors: trustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
      config,
    });
  if (trustedActors.length === 0) {
    console.error(
      'error: no trusted marker logins supplied. Pass --trusted-marker-logins, set IDD_TRUSTED_MARKER_ACTORS, or list trustedMarkerActors in .github/idd/config.json.',
    );
    process.exit(2);
  }
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const markerPrefix = normalizeMarkerPrefix(args.markerPrefix, config);
  const report = runAuthoringMarkerSweep({
    owner,
    repo,
    issues: args.issues,
    markerPrefix,
    classifier: args.classifier,
    trustedSet: new Set(trustedActors),
    apply: args.apply,
    deadlineMs: args.deadlineMs,
  });
  report.trustedMarkerActorsSource = trustedMarkerActorsSource;
  if (args.format === 'table') {
    printTable(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(computeSweepExitCode(report));
}
