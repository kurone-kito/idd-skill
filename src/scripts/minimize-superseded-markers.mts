#!/usr/bin/env node
// idd-generated-from: src/scripts/minimize-superseded-markers.mts
//
// The scripts/minimize-superseded-markers.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Deliberately NOT importing the shared config-loader module (see #1208's
// PR discussion): docs/idd-helper-scripts.md documents that this helper
// "stays self-contained so the template copy works without
// protocol-helpers.mjs" — the curated idd-template/scripts/ mirror
// carries only this one file, so any cross-file import (even a small one)
// breaks the template copy with ERR_MODULE_NOT_FOUND. This applies
// regardless of extension, so keep this local copy in both the .mts
// source and its generated .mjs/template-mirror artifacts.
function loadIddConfig(): unknown {
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
// subject type) when the id cannot be resolved — including the common case
// of a REST numeric id passed where a GraphQL global node id is required.
// Shared by probeSubject's error path and --help so the guidance never
// drifts between the two surfaces.
const UNRESOLVABLE_NODE_ID_PATTERN = /could not resolve to a node/i;
const NODE_ID_CONVERSION_COMMANDS = [
  "  issue comment:     gh api repos/{owner}/{repo}/issues/comments/{comment_id} -q '.node_id'",
  "  PR review:         gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id} -q '.node_id'",
  "  PR review comment: gh api repos/{owner}/{repo}/pulls/comments/{comment_id} -q '.node_id'",
].join('\n');

interface ProbeNode {
  typename: unknown;
  url: unknown;
  isMinimized: unknown;
  viewerCanMinimize: unknown;
  author: unknown;
}

type ProbeResult =
  | { ok: true; node: ProbeNode }
  | { ok: false; reason: string };
type MutationResult = { ok: true } | { ok: false; reason: string };
type GhResult = { ok: true; stdout: string } | { ok: false; stderr: string };

interface ReportItem {
  subjectId: string;
  url?: unknown;
  typename?: unknown;
  status: string;
  reason?: string;
  author?: unknown;
}

interface MinimizeReport {
  mode: string;
  classifier: string;
  counts: {
    eligible: number;
    alreadyMinimized: number;
    cannotMinimize: number;
    untrusted: number;
    unsupportedType: number;
    applied: number;
    failed: number;
  };
  items: ReportItem[];
  trustedMarkerActors?: string[];
  trustedMarkerActorsSource?: string;
}

interface MinimizeArgs {
  subjectIds: string[];
  classifier: string;
  trustedMarkerLogins: string;
  apply: boolean;
  allowUntrusted: boolean;
  format: string;
  help: boolean;
}

if (isMainModule(import.meta.url)) {
  let args: MinimizeArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
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
}: {
  subjectIds: string[];
  classifier: string;
  trustedSet: Set<string>;
  apply: boolean;
  allowUntrusted: boolean;
}): MinimizeReport {
  const report: MinimizeReport = {
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
function unresolvableNodeIdReason(subjectId: string): string {
  return (
    `unresolvable-node-id: "${subjectId}" is not a GraphQL node ID. ` +
    "probeSubject queries GitHub's GraphQL node(id: $id) API, which " +
    'requires a GraphQL global node ID (e.g. IC_kwDOSWpaqs8AAAABIk9VAg), ' +
    'not a REST numeric ID (e.g. 4870591746). Convert the REST ID to its ' +
    `node ID first, using the command for the subject type:\n${NODE_ID_CONVERSION_COMMANDS}`
  );
}

export function probeSubject(subjectId: string): ProbeResult {
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
    if (UNRESOLVABLE_NODE_ID_PATTERN.test(result.stderr)) {
      return { ok: false, reason: unresolvableNodeIdReason(subjectId) };
    }
    return {
      ok: false,
      reason: `gh-graphql-error: ${result.stderr.slice(0, 200)}`,
    };
  }
  let parsed: {
    errors?: { message?: unknown }[];
    data?: {
      node?: {
        __typename?: unknown;
        url?: unknown;
        isMinimized?: unknown;
        viewerCanMinimize?: unknown;
        author?: { login?: unknown };
      };
    };
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      reason: `gh-graphql-parse: ${(error as Error).message}`,
    };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const joinedErrors = parsed.errors
      .map((e) => String(e.message ?? ''))
      .filter(Boolean)
      .join('; ');
    if (UNRESOLVABLE_NODE_ID_PATTERN.test(joinedErrors)) {
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

export function applyMinimize(
  subjectId: string,
  classifier: string,
): MutationResult {
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
  let parsed: {
    errors?: { message?: unknown }[];
    data?: {
      minimizeComment?: { minimizedComment?: { isMinimized?: unknown } };
    };
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, reason: `mutation-parse: ${(error as Error).message}` };
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

export function normalizeTrustedMarkerLogins(logins: unknown): string[] {
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
}: {
  flagValue?: string;
  envValue?: string;
  config?: unknown;
} = {}): { actors: string[]; source: string } {
  const fromFlag = normalizeTrustedMarkerLogins(splitLoginCsv(flagValue));
  if (fromFlag.length > 0) {
    return { actors: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(splitLoginCsv(envValue));
  if (fromEnv.length > 0) {
    return { actors: fromEnv, source: 'env' };
  }
  const configActors = (config as { trustedMarkerActors?: unknown } | null)
    ?.trustedMarkerActors;
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(configActors) ? configActors : [],
  );
  if (fromConfig.length > 0) {
    return { actors: fromConfig, source: 'config' };
  }
  return { actors: [], source: 'none' };
}

function splitLoginCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((login) => login.trim())
    .filter((login) => login.length > 0);
}

export function isTrustedAuthor(
  author: unknown,
  trustedSet: Set<string>,
): boolean {
  if (!author) {
    return false;
  }
  return trustedSet.has(String(author).toLowerCase());
}

export function computeExitCode(report: MinimizeReport): number {
  if (report.counts.failed > 0) {
    return 1;
  }
  return 0;
}

function printTable(report: MinimizeReport): void {
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

function runGh(argv: string[]): GhResult {
  try {
    const stdout = execFileSync('gh', argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    const e = error as {
      stderr?: { toString?: () => string };
      message?: unknown;
    };
    return {
      ok: false,
      stderr: String(e.stderr?.toString?.() ?? e.message ?? 'unknown error'),
    };
  }
}

function parseArgs(argv: string[]): MinimizeArgs {
  const args: MinimizeArgs = {
    subjectIds: [],
    classifier: 'OUTDATED',
    trustedMarkerLogins: '',
    apply: false,
    allowUntrusted: false,
    format: 'json',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--allow-untrusted') {
      args.allowUntrusted = true;
      continue;
    }
    if (arg === '--subject-ids') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--subject-ids requires a value');
      }
      args.subjectIds = value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      index += 1;
      continue;
    }
    if (arg === '--classifier') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--classifier requires a value');
      }
      args.classifier = value;
      index += 1;
      continue;
    }
    if (arg === '--trusted-marker-logins') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--trusted-marker-logins requires a value');
      }
      args.trustedMarkerLogins = value;
      index += 1;
      continue;
    }
    if (arg === '--format') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--format requires a value');
      }
      args.format = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function printUsage(): void {
  console.log(
    `Usage: minimize-superseded-markers --subject-ids <id1,id2,...> [--classifier OUTDATED|RESOLVED] [--trusted-marker-logins login1,login2] [--allow-untrusted] [--apply] [--format json|table]

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
${NODE_ID_CONVERSION_COMMANDS}`,
  );
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      new URL(metaUrl).pathname === entry ||
      new URL(metaUrl).pathname.endsWith(entry)
    );
  } catch {
    return false;
  }
}
