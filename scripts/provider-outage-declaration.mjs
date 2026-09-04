#!/usr/bin/env node
// idd-generated-from: src/scripts/provider-outage-declaration.mts
//
// The scripts/provider-outage-declaration.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// #2320: a repository-scoped, time-boxed outage-relief declaration that
// substitutes for repeatedly posting one external-check-waiver per pull
// request per HEAD during a proven, sustained provider outage. Read from a
// configured issue (`providerOutage.declarationTarget`) so no repository
// file has to change while the outage is in progress.
//
// Scope boundary: this helper only resolves declaration validity and
// evaluates whether a specific waivable selector is relieved for a pull
// request whose OWN terminal advisory-unavailable state the caller has
// already independently proven (`prTerminalUnavailable`). It never
// evaluates CI conclusions, branch freshness, claim state, or unresolved
// threads -- those stay exactly where they already live
// (pre-merge-readiness.mts / advisory-wait-state.mts).
import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import {
  buildTrustedMarkerLogins,
  matchCheckSelector,
  normalizeAuthorityEvidence,
  resolveActorLogin,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mjs';
import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
import {
  parsePaginatedGhNdjson,
  parseProviderOutageAdvancedComment,
  parseProviderOutageDeclarationComment,
  renderProviderOutageAdvancedComment,
  renderProviderOutageDeclarationComment,
  toSecondPrecisionIso,
} from './protocol-helpers.mjs';
import { makeReadlinePrompt } from './readline-prompt.mjs';

const DECLARATION_MARKER_START = /^<!--\s*idd-provider-outage-declaration:/i;
const ADVANCED_MARKER_START = /^<!--\s*idd-provider-outage-advanced:/i;
function commentAuthorLogin(comment) {
  return String(comment?.author?.login ?? comment?.user?.login ?? '')
    .trim()
    .toLowerCase();
}
function latestByCreatedAt(entries) {
  if (entries.length === 0) return null;
  return [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[
    entries.length - 1
  ];
}
/**
 * Resolve whether an active, valid outage declaration exists for `service`.
 *
 * Deliberately decoupled from any provider-health classifier: this function
 * accepts no verdict input at all -- only the declaration marker's own
 * fields (actor, service, timestamps), the actor's live GitHub authority
 * (`authorityOf`), and `now`. An absent or `unknown` provider-health verdict
 * therefore can never invalidate an otherwise-valid declaration, because
 * there is no parameter here for one to invalidate through.
 *
 * Validity is recomputed from scratch on every call ("live on every read"):
 * nothing is cached, and an expired declaration silently reverts `active`
 * to `false` with no cleanup step required.
 */
export function resolveProviderOutageDeclaration(input) {
  const empty = (reason) => ({
    active: false,
    reason,
    declaration: null,
    valid: [],
    expired: [],
    exceedsMaxValidity: [],
    notYetStarted: [],
    notYetPosted: [],
    wrongService: [],
    unauthorized: [],
    malformed: [],
  });
  if (!input.declarationTargetConfigured) {
    return empty(
      'declaration path disabled: providerOutage.declarationTarget is not configured',
    );
  }
  const service = String(input.service ?? '').trim();
  if (!service) {
    return empty('requested service is empty');
  }
  const now = input.now instanceof Date ? input.now : new Date();
  const nowMs = now.getTime();
  const maxValidityMs =
    parseIsoDurationToMs(
      input.policy?.providerOutage?.maxValidity ?? 'PT24H',
    ) ??
    parseIsoDurationToMs('PT24H') ??
    0;
  const authorityPolicy =
    input.policy?.ciGate?.externalCheckWaivers?.authorityPolicy ??
    'owners-and-maintainers-only';
  const valid = [];
  const expired = [];
  const exceedsMaxValidity = [];
  const notYetStarted = [];
  const notYetPosted = [];
  const wrongService = [];
  const unauthorized = [];
  const malformed = [];
  let shapedCount = 0;
  for (const comment of input.comments ?? []) {
    const body = String(comment?.body ?? '');
    if (!DECLARATION_MARKER_START.test(body)) continue;
    shapedCount += 1;
    const authorLogin = commentAuthorLogin(comment);
    const createdAt = String(comment?.created_at ?? '');
    const parsed = parseProviderOutageDeclarationComment(body, createdAt);
    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }
    if (parsed.service.toLowerCase() !== service.toLowerCase()) {
      wrongService.push(parsed);
      continue;
    }
    const authority = input.authorityOf(authorLogin);
    if (!authority.known || !authority.authorized) {
      unauthorized.push({
        authorLogin,
        service: parsed.service,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }
    const startedMs = Date.parse(parsed.startedAt);
    const expiresMs = Date.parse(parsed.expiresAt);
    if (
      !Number.isFinite(startedMs) ||
      !Number.isFinite(expiresMs) ||
      expiresMs <= startedMs
    ) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }
    if (expiresMs - startedMs > maxValidityMs) {
      exceedsMaxValidity.push(parsed);
      continue;
    }
    if (nowMs >= expiresMs) {
      expired.push(parsed);
      continue;
    }
    // #2320 review (Codex): ordering and window-length alone do not prove
    // the window has actually opened -- a declaration authored with a
    // future `startedAt` must stay inactive until that moment, not read as
    // valid the instant it is posted.
    if (nowMs < startedMs) {
      notYetStarted.push(parsed);
      continue;
    }
    // #2353 (Codex review on PR #2370, round 5): `startedAt` is the
    // declaration's own self-reported field, authored at `--declare` time
    // -- BEFORE the `--apply` confirmation that actually posts the GitHub
    // comment `parsed.createdAt` records. A caller replaying a past `now`
    // (e.g. `--now`) could see `nowMs >= startedMs` even though, at that
    // replayed moment, the comment recording the declaration did not yet
    // exist on GitHub -- a live-time caller can never hit this, since
    // `createdAt` is necessarily in the past by the time the comment is
    // fetched at all. Skips the check when `createdAt` is the
    // schema-documented `'none'` sentinel (unparseable), matching
    // `resolveDeclarationActiveSince`'s (pre-merge-readiness.mts) same
    // fallback-to-`startedAt`-alone convention.
    const createdAtMs = Date.parse(parsed.createdAt);
    if (Number.isFinite(createdAtMs) && nowMs < createdAtMs) {
      notYetPosted.push(parsed);
      continue;
    }
    valid.push(parsed);
  }
  const declaration = latestByCreatedAt(valid);
  if (declaration) {
    return {
      active: true,
      reason: '',
      declaration,
      valid,
      expired,
      exceedsMaxValidity,
      notYetStarted,
      notYetPosted,
      wrongService,
      unauthorized,
      malformed,
    };
  }
  let reason = `no provider outage declaration found for service "${service}"`;
  if (shapedCount === 0) {
    reason = `no provider outage declaration found for service "${service}"`;
  } else if (expired.length > 0) {
    const latest = latestByCreatedAt(expired);
    reason = `declaration expired at ${latest?.expiresAt}`;
  } else if (notYetStarted.length > 0) {
    const latest = latestByCreatedAt(notYetStarted);
    reason = `declaration has not started yet (starts at ${latest?.startedAt})`;
  } else if (notYetPosted.length > 0) {
    const latest = latestByCreatedAt(notYetPosted);
    reason = `declaration comment was not yet posted as of the evaluated moment (posted at ${latest?.createdAt})`;
  } else if (exceedsMaxValidity.length > 0) {
    reason = `declaration expiry exceeds configured providerOutage.maxValidity`;
  } else if (unauthorized.length > 0) {
    const latest = unauthorized[unauthorized.length - 1];
    reason = `${latest.authorLogin} is not authorized to author a provider outage declaration under ${authorityPolicy}`;
  } else if (wrongService.length > 0) {
    const latest = latestByCreatedAt(wrongService);
    reason = `declaration is for service "${latest?.service}", not "${service}"`;
  } else if (malformed.length > 0) {
    reason = 'provider outage declaration marker is malformed';
  }
  return {
    active: false,
    reason,
    declaration: null,
    valid,
    expired,
    exceedsMaxValidity,
    notYetStarted,
    notYetPosted,
    wrongService,
    unauthorized,
    malformed,
  };
}
/**
 * Evaluate whether a single waivable selector is relieved for one pull
 * request under an active outage declaration.
 *
 * Non-bypassing by construction: an active declaration alone is never
 * sufficient. `prTerminalUnavailable` -- proof of THIS pull request's own
 * terminal advisory-unavailable state, established independently (the same
 * per-pull-request proof an external-check-waiver's precondition already
 * requires) -- must also hold, and `requestedSelector` must match a
 * configured `ciGate.externalChecks.waivable` entry. Nothing here relieves
 * a CI conclusion, branch freshness, claim state, or unresolved threads --
 * those gates are untouched and evaluated elsewhere.
 */
export function evaluateProviderOutageRelief(input) {
  if (!input.declarationActive) {
    return { relieved: false, reason: 'no active provider outage declaration' };
  }
  if (!input.prTerminalUnavailable) {
    return {
      relieved: false,
      reason:
        "pull request's own terminal advisory-unavailable state is not independently proven",
    };
  }
  const selector = String(input.requestedSelector ?? '').trim();
  if (!selector) {
    return { relieved: false, reason: 'requested check selector is empty' };
  }
  const matches = (input.waivableSelectors ?? []).some((entry) =>
    matchCheckSelector(
      selector,
      entry.selector,
      entry.matchMode === 'glob' ? 'glob' : 'exact',
    ),
  );
  if (!matches) {
    return {
      relieved: false,
      reason: `${selector} is not configured as a waivable external check (ciGate.externalChecks.waivable)`,
    };
  }
  return { relieved: true, reason: '' };
}
/**
 * List every pull request advanced under an active outage declaration, from
 * `idd-provider-outage-advanced` markers on the declaration-target issue.
 * HEAD-pinned: each entry carries the exact `headSha` recorded at the time
 * it was advanced, so a later push to the same pull request produces a
 * distinct entry rather than overwriting the earlier one -- a post-recovery
 * sweep re-requests review per recorded HEAD, not merely per pull request
 * number.
 */
export function listProviderOutageAdvancements(comments, options = {}) {
  const trustedSet = new Set(
    (options.trustedMarkerLogins ?? []).map((login) =>
      String(login ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  const results = [];
  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? '');
    if (!ADVANCED_MARKER_START.test(body)) continue;
    const authorLogin = commentAuthorLogin(comment);
    if (trustedSet.size > 0 && !trustedSet.has(authorLogin)) continue;
    const parsed = parseProviderOutageAdvancedComment(
      body,
      String(comment?.created_at ?? ''),
    );
    if (parsed) {
      results.push(parsed);
    }
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const PROVIDER_OUTAGE_DECLARATION_FLAG_SPEC = {
  '--declare': { type: 'boolean', default: false },
  '--record-advanced': { type: 'boolean', default: false },
  '--list-advanced': { type: 'boolean', default: false },
  '--service': { type: 'string', default: '' },
  '--expires': { type: 'string', default: '' },
  '--expires-in': { type: 'string', default: '' },
  '--pr': { type: 'string', default: '' },
  '--head-sha': { type: 'string', default: '' },
  '--target-issue': { type: 'string', default: '' },
  '--actor': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--apply': { type: 'boolean', default: false },
  '--yes': { type: 'boolean', default: false },
  '--format': { type: 'string', default: 'json' },
  '--help': { type: 'boolean', short: 'h' },
};
function parsePositiveIntegerFlag(value, flag) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    PROVIDER_OUTAGE_DECLARATION_FLAG_SPEC,
  );
  const format = values.format.trim();
  if (format !== 'json' && format !== 'text') {
    throw new Error(`unsupported --format value: ${format}`);
  }
  const modeFlags = [
    values.declare,
    values['record-advanced'],
    values['list-advanced'],
  ].filter(Boolean);
  if (modeFlags.length > 1) {
    throw new Error(
      '--declare, --record-advanced, and --list-advanced are mutually exclusive',
    );
  }
  const mode = values.declare
    ? 'declare'
    : values['record-advanced']
      ? 'record-advanced'
      : values['list-advanced']
        ? 'list-advanced'
        : 'resolve';
  const parsed = {
    mode,
    service: values.service.trim(),
    expiresAt: values.expires.trim(),
    expiresIn: values['expires-in'].trim(),
    prNumber:
      values.pr === undefined || values.pr === ''
        ? 0
        : parsePositiveIntegerFlag(values.pr, '--pr'),
    headSha: values['head-sha'].trim().toLowerCase(),
    targetIssue:
      values['target-issue'] === undefined || values['target-issue'] === ''
        ? 0
        : parsePositiveIntegerFlag(values['target-issue'], '--target-issue'),
    actor: values.actor.trim(),
    repo:
      combineOwnerRepoFlags({
        owner: values.owner.trim(),
        repo: values.repo.trim(),
      }) ?? '',
    owner: values.owner.trim(),
    apply: values.apply,
    yes: values.yes,
    format,
    help,
  };
  if (!parsed.help) {
    if (mode === 'resolve' || mode === 'declare') {
      if (!parsed.service) {
        throw new Error('missing required --service <name> argument');
      }
    }
    if (mode === 'declare') {
      const hasExpiresAt = Boolean(parsed.expiresAt);
      const hasExpiresIn = Boolean(parsed.expiresIn);
      if (hasExpiresAt === hasExpiresIn) {
        throw new Error('specify exactly one of --expires or --expires-in');
      }
    }
    if (mode === 'record-advanced') {
      if (!parsed.prNumber) {
        throw new Error('missing required --pr <number> argument');
      }
      if (!/^[0-9a-f]{40}$/.test(parsed.headSha)) {
        throw new Error(
          'missing or invalid required --head-sha <40-hex> argument',
        );
      }
    }
  }
  return parsed;
}
function resolveExpiryAt({ expiresAt, expiresIn, now }) {
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error(`invalid --expires value: ${expiresAt}`);
    }
    return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const durationMs = parseIsoDurationToMs(expiresIn);
  if (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0) {
    throw new Error(`invalid --expires-in value: ${expiresIn}`);
  }
  return new Date(now.getTime() + (durationMs ?? 0))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
function parseOwnerRepo(value) {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid --repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}
function fetchIssueComments({ owner, repo, issueNumber }) {
  // #2320 review (Codex): plain `gh api --paginate` without `--jq` emits one
  // JSON array per page, concatenated -- `JSON.parse` on that text throws
  // once the declaration-target issue's comments span more than one page.
  // `--jq '.[]'` flattens every page's array into one NDJSON stream first,
  // matching external-check-waiver.mts's own paginated reads.
  try {
    const payload = ghText(
      [
        'api',
        '--paginate',
        '--jq',
        '.[]',
        `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      ],
      { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS },
    );
    return parsePaginatedGhNdjson(payload);
  } catch {
    throw new Error(
      `could not read issue #${issueNumber} comments to resolve the provider outage declaration`,
    );
  }
}
function postComment({ owner, repo, issueNumber, body }) {
  const payload = ghText([
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    '--method',
    'POST',
    '-f',
    `body=${body}`,
  ]);
  try {
    return JSON.parse(payload || '{}');
  } catch {
    return {};
  }
}
export async function runProviderOutageDeclaration(options = {}) {
  const args = options.args ?? parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return { exitCode: 0 };
  }
  const repository =
    args.repo ||
    ghText([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
  const { owner, name } = parseOwnerRepo(repository);
  const rawConfig = readJsonFile('.github/idd/config.json');
  const policy = normalizePolicyConfig(rawConfig);
  const targetIssue =
    args.targetIssue || policy.providerOutage.declarationTarget;
  const now = options.now instanceof Date ? options.now : new Date();
  const authorityOf =
    options.authorityOf ??
    ((actorLogin) =>
      normalizeAuthorityEvidence(
        resolveCollaboratorAuthority({ owner, repo: name, actor: actorLogin }),
        actorLogin,
        owner,
        policy.ciGate.externalCheckWaivers.authorityPolicy,
      ));
  if (args.mode === 'resolve') {
    const comments =
      options.comments ??
      (targetIssue
        ? fetchIssueComments({ owner, repo: name, issueNumber: targetIssue })
        : []);
    const result = resolveProviderOutageDeclaration({
      declarationTargetConfigured: Boolean(targetIssue),
      comments,
      service: args.service,
      policy,
      authorityOf,
      now,
    });
    render(result, args.format);
    return { exitCode: 0, result };
  }
  if (args.mode === 'list-advanced') {
    if (!targetIssue) {
      throw new Error(
        'providerOutage.declarationTarget is not configured and --target-issue was not given',
      );
    }
    const comments =
      options.comments ??
      fetchIssueComments({ owner, repo: name, issueNumber: targetIssue });
    const trustedMarkerLogins = buildTrustedMarkerLogins({
      owner,
      repo: name,
      rawConfig,
      viewerLogin: '',
      issueComments: comments,
    });
    const result = listProviderOutageAdvancements(comments, {
      trustedMarkerLogins: [...trustedMarkerLogins],
    });
    render(result, args.format);
    return { exitCode: 0, result };
  }
  // --declare and --record-advanced both mutate; both require --apply.
  if (!targetIssue) {
    throw new Error(
      'providerOutage.declarationTarget is not configured and --target-issue was not given',
    );
  }
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const actor = resolveActorLogin(undefined, args.actor, viewerLogin);
  if (!actor) {
    throw new Error(
      'could not determine current GitHub user; ensure gh is authenticated',
    );
  }
  // #2320 review (Copilot): without this check, `--actor` can name an
  // identity other than the authenticated `gh` user while `--apply` still
  // posts under that claimed identity, bypassing the authority check this
  // helper exists to enforce -- external-check-waiver.mts rejects the same
  // mismatch for the same reason.
  if (args.apply && args.actor && actor !== viewerLogin && viewerLogin) {
    throw new Error(
      `--actor ${args.actor} does not match the authenticated user ${viewerLogin}; omit --actor to use the authenticated identity`,
    );
  }
  let body;
  if (args.mode === 'declare') {
    const authority = authorityOf(actor);
    if (!authority.known || !authority.authorized) {
      throw new Error(
        `provider outage declaration blocked: ${actor} is not authorized under ${policy.ciGate.externalCheckWaivers.authorityPolicy}`,
      );
    }
    const expiresAt = resolveExpiryAt({
      expiresAt: args.expiresAt,
      expiresIn: args.expiresIn,
      now,
    });
    // #2320 review (Codex): the read-side maxValidity check in
    // resolveProviderOutageDeclaration only rejects an already-posted
    // overlong declaration; without this, `--declare --apply` can still
    // post one that resolveProviderOutageDeclaration will always reject
    // as `exceedsMaxValidity` and can therefore never legitimately relieve
    // anything.
    const startedAtIso = toSecondPrecisionIso(now);
    const maxValidityMs =
      parseIsoDurationToMs(policy.providerOutage.maxValidity) ??
      parseIsoDurationToMs('PT24H') ??
      0;
    if (
      new Date(expiresAt).getTime() - new Date(startedAtIso).getTime() >
      maxValidityMs
    ) {
      throw new Error(
        `provider outage declaration blocked: requested window exceeds configured providerOutage.maxValidity (${policy.providerOutage.maxValidity})`,
      );
    }
    body = renderProviderOutageDeclarationComment({
      actor,
      service: args.service,
      startedAt: startedAtIso,
      expiresAt,
    });
  } else {
    // --record-advanced: require an active declaration for the named
    // service to exist first -- this marker is evidence of an advancement
    // already granted elsewhere, not a second authority gate. `declaredAt`
    // pins the record to the active declaration's own `startedAt` (#2320
    // review, Codex), not the advancement moment, so a later declaration
    // supersedes without invalidating an earlier advancement's record.
    const comments =
      options.comments ??
      fetchIssueComments({ owner, repo: name, issueNumber: targetIssue });
    const resolution = resolveProviderOutageDeclaration({
      declarationTargetConfigured: true,
      comments,
      service: args.service,
      policy,
      authorityOf,
      now,
    });
    if (!resolution.active || !resolution.declaration) {
      throw new Error(
        `record-advanced blocked: no active provider outage declaration (${resolution.reason})`,
      );
    }
    body = renderProviderOutageAdvancedComment({
      actor,
      prNumber: args.prNumber,
      headSha: args.headSha,
      declaredAt: resolution.declaration.startedAt,
    });
  }
  if (!args.apply) {
    process.stdout.write(`${body}\n`);
    return { exitCode: 0, result: { mode: args.mode, apply: false, body } };
  }
  const isTTY =
    options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!args.yes && !isTTY) {
    throw new Error(
      'operator interaction is required; rerun in a TTY or pass --yes after reviewing the marker body',
    );
  }
  if (!args.yes) {
    process.stdout.write(`${body}\n`);
    const ask = options.prompt ?? makeReadlinePrompt();
    const answer = await ask(`Post this to issue #${targetIssue}? [y/N] `);
    ask.close?.();
    if (
      String(answer ?? '')
        .trim()
        .toLowerCase() !== 'y'
    ) {
      process.stdout.write('Aborted. No changes made.\n');
      return { exitCode: 0, result: { mode: args.mode, apply: false, body } };
    }
  }
  const poster = options.postComment ?? postComment;
  const posted = poster({ owner, repo: name, issueNumber: targetIssue, body });
  const result = {
    mode: args.mode,
    apply: true,
    body,
    commentUrl: String(posted.html_url ?? posted.url ?? ''),
  };
  render(result, args.format);
  return { exitCode: 0, result };
}
/**
 * #2320 review (CodeRabbit): the `text` branch previously called
 * `JSON.stringify(value)` too, so `--format text` never produced anything
 * but compact JSON despite the documented `json|text` contract. Render one
 * `key: value` line per top-level field instead, JSON-stringifying only a
 * nested object/array value.
 */
export function renderText(value) {
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  return Object.entries(value)
    .map(([key, entry]) => {
      const rendered =
        entry !== null && typeof entry === 'object'
          ? JSON.stringify(entry)
          : String(entry);
      return `${key}: ${rendered}`;
    })
    .join('\n');
}
function render(value, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderText(value)}\n`);
}
function printUsage() {
  process.stdout.write(`usage: node scripts/provider-outage-declaration.mjs --service <name> [options]

Modes (default: resolve declaration validity for --service):
  --declare                         author a new declaration (requires authority + --apply)
  --record-advanced                 record a pull request advanced under the active declaration
  --list-advanced                   list pull requests recorded as advanced

Options:
  --service <name>                  affected service name (required for resolve/declare)
  --expires <iso8601>                declaration expiry (--declare, exactly one of --expires/--expires-in)
  --expires-in <duration>            declaration expiry as an ISO-8601 duration from now
  --pr <number>                     pull request number (--record-advanced)
  --head-sha <40-hex>                pull request HEAD SHA (--record-advanced)
  --target-issue <number>           override providerOutage.declarationTarget
  --actor <login>                   override the GitHub actor used for authority evaluation
  --repo <owner/name>               repository override, combined form
  --owner <owner>                   repository override, split form (use
                                     with --repo <name>, the bare
                                     repository name -- not both --owner
                                     and a combined --repo together)
  --apply                           post the canonical marker comment after validation
  --yes                             skip the interactive apply confirmation
  --format <json|text>              output format (default: json)
  --help                            show this message
`);
}
export async function main(argv = process.argv.slice(2)) {
  const result = await runProviderOutageDeclaration({ args: parseArgs(argv) });
  process.exit(result.exitCode);
}
if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}
