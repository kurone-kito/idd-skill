// idd-generated-from: src/scripts/b1-leftover-preserve.mts
//
// The scripts/b1-leftover-preserve.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

/**
 * The B1-leftover preservation mode of `claim-issue`
 * (kurone-kito/idd-skill#4970, roadmap #4955).
 *
 * B1 stops a fresh claim when the claim's branch already exists locally or
 * something already sits at the computed worktree path. With the
 * `b1Leftover` auto-decide class switched on, and a confirmation record for
 * each leftover, `claim-issue --preserve-b1-leftovers` saves the leftover and
 * lets the run continue:
 *
 * - a leftover branch is backed up to `refs/idd-b1/<issue>/<commit>`, the ref
 *   is read back, and only then is the branch ref deleted at that commit;
 * - a leftover path is renamed, never copied or removed, into
 *   `<state>/idd-skill/b1-preserved/<issue>-<UTC timestamp>/<basename>`.
 *
 * The module does no I/O of its own. Every git and gh call goes through one
 * runner, and the filesystem, the trusted policy read, and the confirmation
 * record read are injected ports, so tests run against fakes. It imports
 * nothing from `claim-issue.mts`: the caller passes the gate reading and the
 * local worktree inspection as callbacks.
 *
 * One pass lists the leftovers and checks every precondition for every
 * subject before the first mutation. A refused subject refuses them all, so a
 * pair of leftovers is never left half handled. A dry run stops after that
 * pass. An apply run then acts, branch first and path second, and records
 * each completed action in the caller's report before the next one, so a
 * failure still names every backup ref and destination.
 *
 * Open risks, accepted in the issue: the window between the last check and
 * the rename or the ref deletion, which the platform cannot close (inside
 * that window only a writer outside IDD can interfere, because IDD sessions
 * take the clone lock), and the resolution of a state root that is a link
 * (#4957). A rename keeps inodes, so a process that still writes into a moved
 * tree keeps writing into the preserved copy; path mode checks no live use.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type ConfirmationIssueInput,
  type ConfirmationIssueRead,
  matchDecisionRecord,
  readConfirmationIssue,
} from './auto-decision-records.mts';
import {
  readTrustedAutoDecide,
  type TrustedAutoDecideReport,
} from './idd-config.mts';
import { resolveStateBase } from './idd-local-admission.mts';
import {
  type LocalWorktreeInspection,
  type LocalWorktreeRecord,
  parseLocalWorktreeList,
  sanitizedGitEnvironment,
} from './local-worktree-occupancy.mts';
import {
  checkPreservationParents,
  createPreserveDestination,
  ensurePrivateStateDirectory,
  inspectDirectoryPrivacy,
  inspectPreserveDestination,
  isWithinRoot,
  type LstatKind,
  type PreservationParent,
  type PreserveGuardDeps,
} from './preserve-destination.mts';
import { readWindowsAcl, type WindowsAclReader } from './windows-acl.mts';

// ---------------------------------------------------------------------------
// Ports and request
// ---------------------------------------------------------------------------

/** A finished git or gh call. `status` is `null` on no exit code. */
export interface B1CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-call options: the environment and directory a call runs with. */
export interface B1CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** The one process seam for every git and gh call. */
export type B1Runner = (
  file: string,
  args: readonly string[],
  options?: B1CommandOptions,
) => B1CommandResult;

/** What a no-follow `lstat` reports for one path of any kind. */
export interface B1EntryInfo {
  readonly kind: LstatKind;
  /** `dev:ino` of the entry itself; a symlink is identified as the link. */
  readonly identity: string;
  readonly device: string;
  readonly uid: number | null;
}

/** The filesystem and state-root inputs, on top of the shared #4957 guards. */
export interface B1Filesystem extends Omit<PreserveGuardDeps, 'git'> {
  /** No-follow stat of any entry; `null` when absent. Throws on other errors. */
  readonly lstatEntry: (path: string) => B1EntryInfo | null;
  /** The text of a file; `null` when absent. Throws on other errors. */
  readonly readText: (path: string) => string | null;
  readonly rename: (from: string, to: string) => void;
  /** The numeric user id of this process; `null` where the platform has none. */
  readonly currentUid: () => number | null;
}

/** Everything the module reads or writes besides git and gh. */
export interface B1PreservePorts {
  /** The trusted read of #4958, from the repository's default branch. */
  readonly readTrusted: (repository: {
    owner: string;
    repo: string;
  }) => TrustedAutoDecideReport;
  /** The trusted confirmation-record reader of #4962. */
  readonly readConfirmation: (
    input: ConfirmationIssueInput,
  ) => ConfirmationIssueRead;
  readonly fs: B1Filesystem;
}

/** The fresh-claim gate, as the caller read it under the clone lock. */
export interface B1GateReading {
  readonly ok: boolean;
  /** Why the gate could not be read; only when `ok` is `false`. */
  readonly detail: string;
  readonly verdict: string;
  /** The routing's `evidence.released_claim`, when it carries one. */
  readonly releasedClaim: {
    readonly present: boolean;
    readonly branch: string | null;
  };
}

/** The confirmation issue the caller named. */
export interface B1Confirmation {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface B1PreserveRequest {
  readonly mode: 'dry-run' | 'apply';
  readonly issue: number;
  readonly repository: { readonly owner: string; readonly repo: string };
  /** The claim's computed branch, never a free argument. */
  readonly branch: string;
  readonly primary: string;
  /** The computed worktree path, `<primary-parent>/<repo>.<branch with - for />`. */
  readonly path: string;
  readonly defaultBranch: string;
  readonly developmentBranch: string;
  readonly authoringLabel: string;
  /** The repository policy file the record reader takes its trust list from. */
  readonly policyPath: string;
  readonly confirmation: B1Confirmation | null;
  readonly decisions: readonly string[];
  /** Run the fresh-claim gate again and keep the released-claim evidence. */
  readonly readGate: () => B1GateReading;
  /** The scoped local-worktree scan of A5(e), run again. */
  readonly inspectLocalWorktrees: () => LocalWorktreeInspection;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface B1Precondition {
  readonly id: string;
  readonly status: 'met' | 'unmet';
  readonly detail: string;
}

export interface B1SubjectReport {
  readonly kind: 'branch' | 'path';
  /** The branch name, or the path in its canonical form. */
  readonly subject: string;
  /** The decision ID paired with this subject; `null` until it is paired. */
  decision: string | null;
  readonly preconditions: B1Precondition[];
}

export interface B1Action {
  readonly id:
    | 'backup-ref'
    | 'branch-deleted'
    | 'config-section-removed'
    | 'destination-created'
    | 'path-moved';
  readonly subject: string;
  readonly detail: string;
}

/**
 * `no-leftover`: nothing sits in the way, so the flag acted on nothing.
 * `unmet-preconditions`: a precondition is unmet, nothing changed, and the
 * stops of a run without the flag follow. `ready`: a dry run found every
 * precondition met. `preserved`: every subject was preserved. `failed`: an
 * action failed after a state change, or before it.
 */
export type B1Outcome =
  | 'no-leftover'
  | 'unmet-preconditions'
  | 'ready'
  | 'preserved'
  | 'failed';

export interface B1LeftoverReport {
  mode: 'dry-run' | 'apply';
  outcome: B1Outcome;
  common: B1Precondition[];
  subjects: B1SubjectReport[];
  actions: B1Action[];
  backupRefs: string[];
  destinations: { from: string; to: string }[];
  removedConfigSections: string[];
  /** Decision IDs given when no leftover was listed. */
  decisionsUnused: string[];
  failure: string | null;
}

export function newB1LeftoverReport(
  mode: 'dry-run' | 'apply',
): B1LeftoverReport {
  return {
    mode,
    outcome: 'no-leftover',
    common: [],
    subjects: [],
    actions: [],
    backupRefs: [],
    destinations: [],
    removedConfigSections: [],
    decisionsUnused: [],
    failure: null,
  };
}

/** A failed action: what happened, and what the caller does next. */
export interface B1PreserveFailure {
  readonly detail: string;
  readonly nextAction: string;
}

/** The decision ID rule of the confirmation contract: no whitespace, no `;`, no `-->`. */
const DECISION_ID_PATTERN = /^(?:(?!-->)[^\s;]){1,128}$/u;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const PR_LIST_LIMIT = 100;
const DETAIL_LIMIT = 240;

/** True when `value` can be a decision ID. */
export function isDecisionId(value: string): boolean {
  return DECISION_ID_PATTERN.test(value);
}

/** One sentence naming everything the run preserved; `null` when it did nothing. */
export function describeB1Locations(report: B1LeftoverReport): string | null {
  return report.actions.length === 0
    ? null
    : report.actions.map((action) => action.detail).join('; ');
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Why `path` cannot be the worktree path of a claim, judged by its parent
 * alone: it must be a direct child of the primary's parent, and that parent
 * must not be a link. `null` when the parent rules hold. Nothing is read from
 * `path` itself, so a caller can ask this of a path that exists.
 */
export function worktreeParentProblem(
  primary: string,
  path: string,
): string | null {
  const parent = dirname(primary);
  if (dirname(path) !== parent || path === primary) {
    return `${path} is not a direct child of ${parent}`;
  }
  try {
    if (lstatSync(parent).isSymbolicLink()) {
      return `the parent ${parent} is a link`;
    }
  } catch (error) {
    return `the parent ${parent} could not be inspected: ${errorMessage(error)}`;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound untrusted text (git stderr, a thrown message) before it joins a detail. */
function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_LIMIT
    ? `${flat.slice(0, DETAIL_LIMIT)}...`
    : flat;
}

function describeStatus(result: B1CommandResult): string {
  return result.status === null
    ? 'no exit status (timeout, signal, or spawn failure)'
    : `exit code ${result.status}`;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type CheckResult = { ok: boolean; detail: string };

/** Run one check; a throw is an unmet precondition, never a pass. */
function guarded(id: string, check: () => CheckResult): B1Precondition {
  try {
    const result = check();
    return {
      id,
      status: result.ok ? 'met' : 'unmet',
      detail: result.detail,
    };
  } catch (error) {
    return {
      id,
      status: 'unmet',
      detail: `could not be checked: ${shorten(errorMessage(error))}`,
    };
  }
}

const pass = (detail: string): CheckResult => ({ ok: true, detail });
const refuse = (detail: string): CheckResult => ({ ok: false, detail });

function allMet(list: readonly B1Precondition[]): boolean {
  return list.every((entry) => entry.status === 'met');
}

function sameEntry(a: B1EntryInfo, b: B1EntryInfo): boolean {
  return (
    a.kind === b.kind &&
    a.identity === b.identity &&
    a.device === b.device &&
    a.uid === b.uid
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

interface BranchPlan {
  readonly kind: 'branch';
  readonly report: B1SubjectReport;
  readonly branch: string;
  readonly tip: string | null;
  readonly backupRef: string | null;
  /** The keys `git config --get-regexp` found for the branch. */
  readonly configKeys: readonly string[];
}

interface PathPlan {
  readonly kind: 'path';
  readonly report: B1SubjectReport;
  readonly source: string;
  readonly info: B1EntryInfo | null;
  readonly destinationDirectory: string;
  readonly destinationParents: readonly PreservationParent[];
}

interface Context {
  readonly request: B1PreserveRequest;
  readonly ports: B1PreservePorts;
  readonly run: B1Runner;
  readonly report: B1LeftoverReport;
}

function git(
  ctx: Context,
  args: readonly string[],
  options?: B1CommandOptions,
): B1CommandResult {
  return ctx.run('git', ['-C', ctx.request.primary, ...args], options);
}

function branchRef(ctx: Context): string {
  return `refs/heads/${ctx.request.branch}`;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

interface Listing {
  readonly records: LocalWorktreeRecord[];
  readonly branchTip: string | null;
  /** The ref the branch points to when it is a symbolic ref; empty otherwise. */
  readonly branchSymref: string;
  readonly pathEntry: B1EntryInfo | null;
}

/** Read the worktree list, the branch ref, and the path; `null` after an unmet check. */
function list(ctx: Context): Listing | null {
  const { request, report } = ctx;
  let records: LocalWorktreeRecord[] = [];
  const listed = guarded('worktree-list', () => {
    const result = git(ctx, ['worktree', 'list', '--porcelain', '-z']);
    if (result.status !== 0) {
      return refuse(`git worktree list ended with ${describeStatus(result)}`);
    }
    records = parseLocalWorktreeList(result.stdout);
    return pass(`${records.length} registered worktree(s)`);
  });
  let branchTip: string | null = null;
  let branchSymref = '';
  const branchRead = guarded('branch-listing', () => {
    const ref = branchRef(ctx);
    const result = git(ctx, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      ref,
    ]);
    if (result.status !== 0) {
      return refuse(`git for-each-ref ended with ${describeStatus(result)}`);
    }
    const fields = result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.split('\t'))
      .find((entry) => entry[0] === ref);
    if (fields === undefined) {
      return pass(`no local branch ${request.branch}`);
    }
    const oid = (fields[1] ?? '').trim();
    if (!OBJECT_ID_PATTERN.test(oid)) {
      return refuse(`the tip of ${request.branch} is not an object id`);
    }
    branchTip = oid;
    branchSymref = (fields[2] ?? '').trim();
    return pass(`local branch ${request.branch} at ${oid}`);
  });
  let pathEntry: B1EntryInfo | null = null;
  const pathRead = guarded('path-listing', () => {
    pathEntry = ctx.ports.fs.lstatEntry(request.path);
    return pass(
      pathEntry === null
        ? `nothing at ${request.path}`
        : `a ${(pathEntry as B1EntryInfo).kind} at ${request.path}`,
    );
  });
  const reads = [listed, branchRead, pathRead];
  if (!allMet(reads)) {
    report.common.push(...reads.filter((entry) => entry.status === 'unmet'));
    return null;
  }
  return { records, branchTip, branchSymref, pathEntry };
}

// ---------------------------------------------------------------------------
// Common preconditions
// ---------------------------------------------------------------------------

function commonChecks(
  ctx: Context,
  listing: Listing,
): { trusted: TrustedAutoDecideReport | null } {
  const { request, ports, report } = ctx;
  let trusted: TrustedAutoDecideReport | null = null;
  report.common.push(
    guarded('class-enabled', () => {
      trusted = ports.readTrusted(request.repository);
      if (trusted.status !== 'readable') {
        return refuse(
          `the trusted policy read is unreadable: ${shorten(trusted.error ?? 'no detail')}`,
        );
      }
      const verdict = trusted.classes.b1Leftover;
      return verdict === 'enabled'
        ? pass(`the b1Leftover class is enabled at ref ${trusted.ref}`)
        : refuse(`the b1Leftover class is ${verdict} at ref ${trusted.ref}`);
    }),
  );

  let released: B1GateReading['releasedClaim'] = {
    present: false,
    branch: null,
  };
  report.common.push(
    guarded('fresh-claim-gate', () => {
      const gate = request.readGate();
      if (!gate.ok) {
        return refuse(
          `the fresh-claim gate could not be read: ${shorten(gate.detail)}`,
        );
      }
      released = gate.releasedClaim;
      return gate.verdict === 'claimable'
        ? pass('the fresh-claim gate says claimable')
        : refuse(
            `the fresh-claim gate says ${gate.verdict}, so a takeover reuses the branch`,
          );
    }),
  );
  report.common.push(
    guarded('released-claim', () => {
      if (!released.present) {
        return pass('the routing names no released claim');
      }
      if (released.branch === null) {
        return refuse(
          'the routing names a released claim whose branch is not readable',
        );
      }
      return released.branch === request.branch
        ? refuse(
            `${request.branch} is the branch of a released claim, which is inheritable`,
          )
        : pass(`the released claim used ${shorten(released.branch)}`);
    }),
  );
  report.common.push(
    guarded('no-prunable-entry', () => {
      const ref = branchRef(ctx);
      const prunable = listing.records.find(
        (record) =>
          record.prunable &&
          (record.branchRef === ref || resolve(record.path) === request.path),
      );
      return prunable === undefined
        ? pass('no prunable worktree entry is in the way')
        : refuse(`a prunable worktree entry is in the way: ${prunable.path}`);
    }),
  );
  return { trusted };
}

// ---------------------------------------------------------------------------
// Branch preconditions
// ---------------------------------------------------------------------------

type BackupRefState =
  | { kind: 'absent' }
  | { kind: 'present'; oid: string; symref: string }
  | { kind: 'refused'; detail: string };

/**
 * Read the backup ref as a ref, not as a revision: `rev-parse` follows a
 * symbolic ref, so the type comes from `for-each-ref`. A ref that would
 * collide with the backup path (a ref named `refs/idd-b1/<issue>`, or one
 * below the backup ref) is refused here, so the dry run says so too.
 */
function inspectBackupRef(ctx: Context, backupRef: string): BackupRefState {
  const directory = `refs/idd-b1/${ctx.request.issue}`;
  const result = git(ctx, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(symref)',
    directory,
  ]);
  if (result.status !== 0) {
    return {
      kind: 'refused',
      detail: `git for-each-ref ended with ${describeStatus(result)}`,
    };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
  const collision = rows.find(
    ([name]) => name === directory || (name ?? '').startsWith(`${backupRef}/`),
  );
  if (collision !== undefined) {
    return {
      kind: 'refused',
      detail: `${shorten(collision[0] ?? '')} collides with the backup ref path ${backupRef}`,
    };
  }
  const own = rows.find(([name]) => name === backupRef);
  return own === undefined
    ? { kind: 'absent' }
    : {
        kind: 'present',
        oid: (own[1] ?? '').trim(),
        symref: (own[2] ?? '').trim(),
      };
}

function branchPlan(ctx: Context, listing: Listing): BranchPlan {
  const { request, run } = ctx;
  const branch = request.branch;
  const ref = branchRef(ctx);
  const tip = listing.branchTip;
  const preconditions: B1Precondition[] = [];
  const report: B1SubjectReport = {
    kind: 'branch',
    subject: branch,
    decision: null,
    preconditions,
  };

  preconditions.push(
    guarded('branch-tip', () =>
      tip === null
        ? refuse('the branch tip is not readable')
        : pass(`the tip is ${tip}`),
    ),
  );
  preconditions.push(
    guarded('not-symbolic-ref', () =>
      listing.branchSymref === ''
        ? pass(`${branch} is a plain ref`)
        : refuse(
            `${branch} is a symbolic ref to ${shorten(listing.branchSymref)}, and deleting it could remove that target`,
          ),
    ),
  );
  preconditions.push(
    guarded('not-default-or-development', () => {
      if (request.defaultBranch === '' || request.developmentBranch === '') {
        return refuse('the default or development branch name is unknown');
      }
      return branch === request.defaultBranch ||
        branch === request.developmentBranch
        ? refuse(`${branch} is the default or the development branch`)
        : pass('the branch is neither the default nor the development branch');
    }),
  );
  preconditions.push(
    guarded('not-checked-out', () => {
      const exact = listing.records.find((record) => record.branchRef === ref);
      if (exact !== undefined) {
        return refuse(`${branch} is checked out in ${exact.path}`);
      }
      const local = request.inspectLocalWorktrees();
      if (
        local.status !== 'absent' ||
        local.paths.length > 0 ||
        local.reason !== null
      ) {
        return refuse(
          `a worktree holds, or may hold, ${branch} (${local.status}${
            local.paths.length > 0 ? `: ${shorten(local.paths.join(', '))}` : ''
          }${local.reason === null ? '' : `; ${shorten(local.reason)}`})`,
        );
      }
      return pass(
        'no worktree has the branch checked out or is mid-rebase or mid-bisect on it',
      );
    }),
  );

  const configKeys: string[] = [];
  preconditions.push(
    guarded('config-readable', () => {
      // `--local`: the removal below only touches the repository's own
      // configuration, so a key held only by a global or included file must not
      // pass a check that the removal cannot honor.
      const result = git(ctx, [
        'config',
        '--local',
        '--get-regexp',
        `^branch\\.${escapeForRegExp(branch)}\\.`,
      ]);
      if (result.status === 1) {
        return pass(`no branch.${branch} configuration section`);
      }
      if (result.status !== 0) {
        return refuse(`git config ended with ${describeStatus(result)}`);
      }
      for (const line of result.stdout.split(/\r?\n/)) {
        const key = line.split(/\s/, 1)[0] ?? '';
        if (key !== '') configKeys.push(key);
      }
      return pass(
        `the section branch.${branch} holds ${configKeys.length} key(s)`,
      );
    }),
  );
  preconditions.push(
    guarded('not-deletable-with-d', () => {
      if (tip === null) return refuse('the branch tip is not readable');
      const upstream = git(ctx, [
        'rev-parse',
        '--symbolic-full-name',
        `${branch}@{upstream}`,
      ]);
      if (upstream.status === null) {
        return refuse(`git rev-parse ended with ${describeStatus(upstream)}`);
      }
      let reference = 'HEAD';
      if (upstream.status === 0 && upstream.stdout.trim() !== '') {
        const resolved = git(ctx, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${upstream.stdout.trim()}^{commit}`,
        ]);
        if (resolved.status === null || resolved.status > 1) {
          return refuse(`git rev-parse ended with ${describeStatus(resolved)}`);
        }
        // An upstream whose ref is gone falls back to HEAD, as `git branch -d`
        // does.
        if (resolved.status === 0) reference = upstream.stdout.trim();
      }
      const head = git(ctx, [
        'rev-parse',
        '--verify',
        '--quiet',
        'HEAD^{commit}',
      ]);
      if (head.status !== 0) {
        return refuse(`git rev-parse HEAD ended with ${describeStatus(head)}`);
      }
      const merged = git(ctx, ['merge-base', '--is-ancestor', tip, reference]);
      if (merged.status === 0) {
        return refuse(
          `${branch} is merged into ${reference}, so git branch -d deletes it and today's route applies`,
        );
      }
      return merged.status === 1
        ? pass(
            `${branch} is not merged into ${reference}, so git branch -d refuses it`,
          )
        : refuse(`git merge-base ended with ${describeStatus(merged)}`);
    }),
  );
  preconditions.push(
    guarded('no-remote-branch', () => {
      const remotes = git(ctx, ['remote']);
      if (remotes.status !== 0) {
        return refuse(`git remote ended with ${describeStatus(remotes)}`);
      }
      const names = remotes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (names.length === 0) {
        return refuse(
          'no remote is configured, so the branch cannot be proven absent',
        );
      }
      const env = { ...sanitizedGitEnvironment(), GIT_TERMINAL_PROMPT: '0' };
      for (const name of names) {
        if (!REMOTE_NAME_PATTERN.test(name)) {
          return refuse(
            `the remote name ${JSON.stringify(name)} is not usable`,
          );
        }
        const live = git(ctx, ['ls-remote', '--heads', name, ref], { env });
        if (live.status !== 0) {
          return refuse(
            `git ls-remote ${name} ended with ${describeStatus(live)}`,
          );
        }
        const found = live.stdout
          .split(/\r?\n/)
          .some((line) => line.trim().endsWith(`\t${ref}`));
        if (found) return refuse(`${branch} exists on the remote ${name}`);
      }
      return pass(`${branch} is on none of ${names.length} remote(s)`);
    }),
  );
  preconditions.push(
    guarded('no-open-pr', () => {
      const result = run('gh', [
        'pr',
        'list',
        '--repo',
        `${request.repository.owner}/${request.repository.repo}`,
        '--state',
        'open',
        '--head',
        branch,
        '--json',
        'number,headRefName',
        '--limit',
        String(PR_LIST_LIMIT),
      ]);
      if (result.status !== 0) {
        return refuse(`gh pr list ended with ${describeStatus(result)}`);
      }
      const parsed: unknown = JSON.parse(result.stdout || 'null');
      if (!Array.isArray(parsed)) {
        return refuse('gh pr list printed no JSON array');
      }
      if (parsed.length >= PR_LIST_LIMIT) {
        return refuse(`gh pr list reached its limit of ${PR_LIST_LIMIT}`);
      }
      const heads = parsed.filter(
        (row: unknown) =>
          typeof row === 'object' &&
          row !== null &&
          (row as { headRefName?: unknown }).headRefName === branch,
      );
      return heads.length === 0
        ? pass(`no open pull request has ${branch} as its head`)
        : refuse(
            `${heads.length} open pull request(s) have ${branch} as their head`,
          );
    }),
  );
  const backupRef =
    tip !== null && OBJECT_ID_PATTERN.test(tip)
      ? `refs/idd-b1/${request.issue}/${tip}`
      : null;
  preconditions.push(
    guarded('backup-ref-compatible', () => {
      if (backupRef === null || tip === null) {
        return refuse('the backup ref cannot be named without the branch tip');
      }
      const existing = inspectBackupRef(ctx, backupRef);
      if (existing.kind === 'refused') return refuse(existing.detail);
      if (existing.kind === 'absent') {
        return pass(`${backupRef} does not exist yet`);
      }
      if (existing.symref !== '') {
        return refuse(`${backupRef} is a symbolic ref`);
      }
      return existing.oid === tip
        ? pass(`${backupRef} already holds ${tip} and is reused`)
        : refuse(`${backupRef} holds another commit`);
    }),
  );
  return { kind: 'branch', report, branch, tip, backupRef, configKeys };
}

// ---------------------------------------------------------------------------
// Path preconditions
// ---------------------------------------------------------------------------

function pathPlan(ctx: Context, listing: Listing): PathPlan {
  const { request, ports } = ctx;
  const fs = ports.fs;
  const info = listing.pathEntry;
  const preconditions: B1Precondition[] = [];
  const parentReal = (() => {
    try {
      return fs.realpath(dirname(request.path));
    } catch {
      return null;
    }
  })();
  const source =
    parentReal === null
      ? request.path
      : join(parentReal, basename(request.path));
  const report: B1SubjectReport = {
    kind: 'path',
    subject: source,
    decision: null,
    preconditions,
  };

  preconditions.push(
    guarded('computed-path', () => {
      const problem = worktreeParentProblem(request.primary, request.path);
      if (problem !== null) return refuse(problem);
      const expected = `${request.repository.repo}.${request.branch.replace(/\//g, '-')}`;
      if (basename(request.path) !== expected) {
        return refuse(`the path is not named ${expected}`);
      }
      if (parentReal === null) {
        return refuse(`the parent of ${request.path} cannot be resolved`);
      }
      if (info === null) return refuse('the entry is gone');
      return pass(
        `${source} is the computed worktree path, a direct child of an unlinked parent`,
      );
    }),
  );
  preconditions.push(
    guarded('owned-by-user', () => {
      if (info === null) return refuse('the entry is gone');
      const uid = fs.currentUid();
      if (uid === null || info.uid === null) {
        return refuse('ownership cannot be verified on this platform');
      }
      return info.uid === uid
        ? pass('the entry belongs to the current user')
        : refuse(`the entry belongs to another user (uid ${info.uid})`);
    }),
  );
  preconditions.push(
    guarded('not-registered-worktree', () => {
      for (const record of listing.records) {
        const recordPath = fs.realpath(record.path) ?? resolve(record.path);
        // The paths are compared as text, so the same entry spelled another
        // way (a case-insensitive filesystem) is also caught by its identity.
        const recordEntry = fs.lstatEntry(record.path);
        if (
          recordPath === source ||
          isWithinRoot(source, recordPath) ||
          isWithinRoot(recordPath, source) ||
          (info !== null &&
            recordEntry !== null &&
            recordEntry.identity === info.identity)
        ) {
          return refuse(
            `the registered worktree ${record.path} is at, inside, or around the path`,
          );
        }
      }
      return pass('no registered worktree is at, inside, or around the path');
    }),
  );
  preconditions.push(
    guarded('no-git-link', () => {
      if (info === null) return refuse('the entry is gone');
      if (info.kind !== 'directory') {
        return pass(`the entry is a ${info.kind}, which holds no .git link`);
      }
      const link = join(request.path, '.git');
      const entry = fs.lstatEntry(link);
      if (entry === null || entry.kind === 'directory') {
        return pass('the directory holds no .git file');
      }
      if (entry.kind !== 'file') {
        return refuse(`.git is a ${entry.kind}`);
      }
      const text = fs.readText(link) ?? '';
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (match === null || match[1] === undefined) {
        return refuse('the .git file does not name a git directory');
      }
      const target = isAbsolute(match[1])
        ? match[1]
        : resolve(request.path, match[1]);
      return fs.lstatEntry(target) === null
        ? pass('the .git file points to no existing administration directory')
        : refuse(
            `the .git file points to the existing directory ${shorten(target)}`,
          );
    }),
  );

  let destinationDirectory = '';
  let destinationParents: readonly PreservationParent[] = [];
  preconditions.push(
    guarded('destination', () => {
      const guards: PreserveGuardDeps = {
        ...fs,
        git: (args, cwd) => ctx.run('git', ['-C', cwd, ...args]),
      };
      const inspected = inspectPreserveDestination(
        guards,
        'b1-preserved',
        request.issue,
        request.primary,
        listing.records,
      );
      if (inspected.hold !== null) return refuse(inspected.hold);
      if (isWithinRoot(source, inspected.destination)) {
        return refuse(
          `the destination ${inspected.destination} is inside the leftover path, so the state root is inside what is being moved`,
        );
      }
      destinationDirectory = inspected.destination;
      destinationParents = inspected.parents;
      return pass(
        `the destination is ${join(destinationDirectory, basename(source))}`,
      );
    }),
  );
  preconditions.push(
    guarded('same-device', () => {
      if (info === null) return refuse('the entry is gone');
      if (destinationParents.length === 0) {
        return refuse('no destination parent was verified');
      }
      for (const parent of destinationParents) {
        if (parent.identity === null) continue;
        const device = parent.identity.split(':')[0];
        if (device !== info.device) {
          return refuse(
            `${parent.path} is on another device than the source, so a rename cannot keep the entry whole`,
          );
        }
      }
      return pass(
        'the source and every existing destination parent share one device',
      );
    }),
  );
  return {
    kind: 'path',
    report,
    source,
    info,
    destinationDirectory,
    destinationParents,
  };
}

// ---------------------------------------------------------------------------
// Confirmation records
// ---------------------------------------------------------------------------

function recordChecks(
  ctx: Context,
  trusted: TrustedAutoDecideReport | null,
  subjects: readonly B1SubjectReport[],
): void {
  const { request, ports, report } = ctx;
  const confirmation = request.confirmation;
  const unmetAll = (detail: string) => {
    for (const subject of subjects) {
      subject.preconditions.push({
        id: 'record-match',
        status: 'unmet',
        detail,
      });
    }
  };
  if (confirmation === null) {
    report.common.push({
      id: 'record',
      status: 'unmet',
      detail: 'no --confirmation was given, so no confirmation record was read',
    });
    report.common.push({
      id: 'decision-pairing',
      status: 'unmet',
      detail: 'the decisions cannot be paired without a confirmation issue',
    });
    unmetAll('no confirmation record was checked');
    return;
  }
  const confirmationLabel =
    trusted?.status === 'readable' ? trusted.confirmationLabelName : undefined;
  if (confirmationLabel === undefined || confirmationLabel === '') {
    report.common.push({
      id: 'record',
      status: 'unmet',
      detail:
        'the confirmation label name is not available from the trusted read',
    });
    report.common.push({
      id: 'decision-pairing',
      status: 'unmet',
      detail: 'the decisions cannot be paired without a readable record',
    });
    unmetAll('no confirmation record was checked');
    return;
  }

  let read: ConfirmationIssueRead | null = null;
  const reference = `${confirmation.owner}/${confirmation.repo}#${confirmation.number}`;
  report.common.push(
    guarded('record', () => {
      read = ports.readConfirmation({
        repository: { owner: confirmation.owner, repo: confirmation.repo },
        number: confirmation.number,
        confirmationLabel,
        authoringLabel: request.authoringLabel,
        policyPath: request.policyPath,
      });
      if (read.status === 'unreadable') {
        return refuse(`${reference} is unreadable: ${shorten(read.error)}`);
      }
      const problems: string[] = [];
      if (read.state !== 'open') problems.push('it is not open');
      if (!read.confirmationLabel) {
        problems.push(`it lacks the ${confirmationLabel} label`);
      }
      if (read.authoringLabel)
        problems.push('it still carries the authoring label');
      return problems.length === 0
        ? pass(`${reference} is open, labeled, and released`)
        : refuse(`${reference}: ${problems.join(', ')}`);
    }),
  );
  const current = read as ConfirmationIssueRead | null;
  if (current === null || current.status !== 'readable') {
    report.common.push({
      id: 'decision-pairing',
      status: 'unmet',
      detail: 'the decisions cannot be paired without a readable record',
    });
    unmetAll('no confirmation record was checked');
    return;
  }

  const source = `${request.repository.owner}/${request.repository.repo}#${request.issue}`;
  const pairedSubjects = new Map<string, string>();
  report.common.push(
    guarded('decision-pairing', () => {
      const ids = request.decisions;
      if (ids.length !== subjects.length) {
        return refuse(
          `${ids.length} --decision value(s) for ${subjects.length} listed subject(s)`,
        );
      }
      if (new Set(ids).size !== ids.length) {
        return refuse('a --decision value is repeated');
      }
      for (const id of ids) {
        const record = current.records.find(
          (candidate) =>
            candidate.decision === id &&
            candidate.class === 'b1Leftover' &&
            candidate.source.toLowerCase() === source.toLowerCase() &&
            candidate.claim === 'none',
        );
        if (record === undefined) {
          const why = current.voidedDecisions.includes(id)
            ? 'it is voided'
            : current.conflictingDecisions.includes(id)
              ? 'its records disagree'
              : 'no counting b1Leftover record for this issue carries it';
          return refuse(`decision ${id} matches no record: ${why}`);
        }
        const subject = subjects.find(
          (entry) => entry.subject === record.subject,
        );
        if (subject === undefined) {
          return refuse(`decision ${id} matches no listed subject`);
        }
        if (pairedSubjects.has(subject.subject)) {
          return refuse(
            `two decisions pair with the subject ${subject.subject}`,
          );
        }
        pairedSubjects.set(subject.subject, id);
      }
      return pass(
        `${ids.length} decision(s) pair one-to-one with the listed subjects`,
      );
    }),
  );
  for (const subject of subjects) {
    subject.preconditions.push(
      guarded('record-match', () => {
        const id = pairedSubjects.get(subject.subject);
        if (id === undefined)
          return refuse('no decision is paired with this subject');
        subject.decision = id;
        const match = matchDecisionRecord(current, {
          class: 'b1Leftover',
          source,
          claim: 'none',
          subject: subject.subject,
          decision: id,
        });
        if (match.verdict !== 'match') {
          return refuse(`decision ${id}: ${shorten(match.reason)}`);
        }
        const record = match.records[0];
        if (record === undefined) return refuse(`decision ${id} has no record`);
        if (record.locationNote || record.failureNote) {
          return refuse(
            `decision ${id} was already acted on or failed (a counting ${record.locationNote ? 'location' : 'failure'} note exists); a new attempt needs a new decision`,
          );
        }
        return pass(
          `decision ${id} has a counting record for this subject, and it is not voided`,
        );
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function failureNext(report: B1LeftoverReport): string {
  const locations = describeB1Locations(report);
  return `Stop. ${
    locations === null
      ? 'This run changed nothing.'
      : `This run changed state: ${locations}.`
  } Report the failure, and every location named here, on the confirmation issue as the auto-decide procedure's After acting step says, then finish or undo the cleanup by hand before rerunning this helper. This helper never retries or undoes it.`;
}

function failed(report: B1LeftoverReport, detail: string): B1PreserveFailure {
  report.outcome = 'failed';
  report.failure = detail;
  return { detail, nextAction: failureNext(report) };
}

function preserveBranch(
  ctx: Context,
  plan: BranchPlan,
): B1PreserveFailure | null {
  const { report } = ctx;
  const { branch, tip, backupRef } = plan;
  if (tip === null || backupRef === null) {
    return failed(report, `the tip of ${branch} is not readable`);
  }
  const ref = branchRef(ctx);

  const existing = inspectBackupRef(ctx, backupRef);
  if (existing.kind === 'refused') {
    return failed(report, existing.detail);
  }
  if (
    existing.kind === 'present' &&
    (existing.symref !== '' || existing.oid !== tip)
  ) {
    return failed(
      report,
      `${backupRef} is ${existing.symref !== '' ? 'a symbolic ref' : 'at another commit'}`,
    );
  }
  const reused = existing.kind === 'present';
  if (!reused) {
    const created = git(ctx, ['update-ref', backupRef, tip, '']);
    if (created.status !== 0) {
      const again = inspectBackupRef(ctx, backupRef);
      if (
        again.kind !== 'present' ||
        again.symref !== '' ||
        again.oid !== tip
      ) {
        return failed(
          report,
          `creating ${backupRef} failed (${describeStatus(created)}): ${shorten(created.stderr)}`,
        );
      }
    }
  }
  // The ref exists from here on, whatever the read-back says, so the report
  // names it before the read-back can fail.
  report.backupRefs.push(backupRef);
  report.actions.push({
    id: 'backup-ref',
    subject: branch,
    detail: `backup ref ${backupRef} ${reused ? 'reused' : 'written'} for branch ${branch} (tip ${tip})`,
  });
  const readBack = git(ctx, ['rev-parse', '--verify', backupRef]);
  if (readBack.status !== 0 || readBack.stdout.trim() !== tip) {
    return failed(
      report,
      `the backup ref ${backupRef} did not read back as ${tip}; the ref stays and the branch is untouched`,
    );
  }

  // `--no-deref`: never follow a symbolic ref to its target.
  const deleted = git(ctx, ['update-ref', '--no-deref', '-d', ref, tip]);
  if (deleted.status !== 0) {
    return failed(
      report,
      `deleting ${ref} at ${tip} failed (${describeStatus(deleted)}), so the tip moved or the ref changed: ${shorten(deleted.stderr)}; the branch is untouched`,
    );
  }
  const gone = git(ctx, ['rev-parse', '--verify', '--quiet', ref]);
  if (gone.status !== 1) {
    return failed(report, `${ref} is still present after its deletion`);
  }
  report.actions.push({
    id: 'branch-deleted',
    subject: branch,
    detail: `branch ${branch} deleted at ${tip}`,
  });

  if (plan.configKeys.length > 0) {
    const section = `branch.${branch}`;
    const removed = git(ctx, ['config', '--remove-section', section]);
    if (removed.status !== 0) {
      return failed(
        report,
        `the configuration section ${section} (${plan.configKeys.join(', ')}) could not be removed (${describeStatus(removed)}); remove it by hand before a branch of that name is recreated`,
      );
    }
    report.removedConfigSections.push(section);
    report.actions.push({
      id: 'config-section-removed',
      subject: branch,
      detail: `configuration section ${section} removed (${plan.configKeys.join(', ')})`,
    });
  }
  return null;
}

/**
 * The directories the creation step made: each parent that was absent when the
 * destination was inspected and exists now, then the destination itself. An
 * entry that cannot be inspected counts as present, so it is named.
 */
function createdDirectories(fs: B1Filesystem, plan: PathPlan): string[] {
  const present = (path: string): boolean => {
    try {
      return fs.lstat(path) !== 'absent';
    } catch {
      return true;
    }
  };
  return [
    ...plan.destinationParents
      .filter((parent) => parent.identity === null && present(parent.path))
      .map((parent) => parent.path),
    ...(present(plan.destinationDirectory) ? [plan.destinationDirectory] : []),
  ];
}

function preservePath(ctx: Context, plan: PathPlan): B1PreserveFailure | null {
  const { ports, report } = ctx;
  const fs = ports.fs;
  const { source, info } = plan;
  if (info === null) return failed(report, `${source} is gone`);
  const guards: PreserveGuardDeps = {
    ...fs,
    git: (args, cwd) => ctx.run('git', ['-C', cwd, ...args]),
  };

  let created: ReturnType<typeof createPreserveDestination>;
  try {
    created = createPreserveDestination(
      guards,
      plan.destinationDirectory,
      plan.destinationParents,
    );
  } catch (error) {
    // A read after a mkdir can throw. Directories made before it must still
    // be named, or the next action would say nothing changed.
    created = { parents: [], hold: `threw: ${errorMessage(error)}` };
  }
  const made = createdDirectories(fs, plan);
  if (created.hold !== null) {
    // The creation step may already have made the directory, and it stays in
    // place when it fails its privacy or identity check. Name every directory
    // it made, so the caller can post a failure note with the paths.
    if (made.length > 0) {
      report.actions.push({
        id: 'destination-created',
        subject: source,
        detail: `created ${made.join(', ')}, which stays in place`,
      });
    }
    return failed(
      report,
      `the destination ${plan.destinationDirectory} was not prepared: ${shorten(created.hold)}; the source ${source} is untouched`,
    );
  }
  report.actions.push({
    id: 'destination-created',
    subject: source,
    detail: `created ${made.join(', ')}`,
  });
  const final = join(plan.destinationDirectory, basename(source));
  const parents = new Map(
    created.parents.map(({ path, identity }) => [path, identity]),
  );

  const before = (() => {
    const changed = checkPreservationParents(guards, parents);
    if (changed !== null) return changed;
    if (fs.lstatEntry(final) !== null) return `${final} already exists`;
    const entry = fs.lstatEntry(source);
    if (entry === null || !sameEntry(entry, info)) {
      return `${source} changed after inspection`;
    }
    return null;
  })();
  if (before !== null) {
    return failed(
      report,
      `${shorten(before)}; the source ${source} is untouched and ${plan.destinationDirectory} stays in place`,
    );
  }

  try {
    fs.rename(source, final);
  } catch (error) {
    return failed(
      report,
      `renaming ${source} to ${final} failed: ${shorten(errorMessage(error))}; the source is untouched and ${plan.destinationDirectory} stays in place`,
    );
  }
  const moved = (() => {
    try {
      return fs.lstatEntry(final);
    } catch {
      return null;
    }
  })();
  if (moved === null || !sameEntry(moved, info)) {
    report.destinations.push({ from: source, to: final });
    report.actions.push({
      id: 'path-moved',
      subject: source,
      detail: `moved ${source} to ${final}; the moved entry's identity did not match, so it was left there`,
    });
    return failed(
      report,
      `the entry at ${final} does not match the identity of ${source} before the rename; it stays at ${final} and the original path is ${source}`,
    );
  }
  const changed = checkPreservationParents(guards, parents);
  if (changed !== null) {
    // The destination cannot be trusted any more. Move the entry back only
    // while its identity matches and the source path is free.
    let free = false;
    try {
      free = fs.lstatEntry(source) === null;
    } catch {
      free = false;
    }
    if (!free) {
      report.destinations.push({ from: source, to: final });
      report.actions.push({
        id: 'path-moved',
        subject: source,
        detail: `moved ${source} to ${final}; the original path is occupied again, so the entry was left there`,
      });
      return failed(
        report,
        `${shorten(changed)}; moving the entry back is needed, but ${source} is occupied again, so it stays at ${final}`,
      );
    }
    try {
      fs.rename(final, source);
    } catch (error) {
      report.destinations.push({ from: source, to: final });
      report.actions.push({
        id: 'path-moved',
        subject: source,
        detail: `moved ${source} to ${final}; moving it back failed, so it was left where the failure left it`,
      });
      return failed(
        report,
        `${shorten(changed)}; moving the entry back to ${source} failed: ${shorten(errorMessage(error))}; look for it at ${final} and at ${source}`,
      );
    }
    return failed(
      report,
      `${shorten(changed)}; the entry was moved back to ${source} and nothing is preserved`,
    );
  }
  report.destinations.push({ from: source, to: final });
  report.actions.push({
    id: 'path-moved',
    subject: source,
    detail: `moved ${source} to ${final}`,
  });
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * List the leftovers and check every precondition for every subject. In
 * `apply` mode, when all of them are met, preserve each subject: the branch
 * first, then the path. The report is filled as it goes, including after a
 * throw: the caller owns it, so a failure still names every location that was
 * saved. Returns the failure of an action, or `null`. An unmet precondition is
 * not a failure: nothing changed and the stops of a run without the flag
 * follow.
 */
export function runB1Preservation(
  request: B1PreserveRequest,
  ports: B1PreservePorts,
  run: B1Runner,
  report: B1LeftoverReport,
): B1PreserveFailure | null {
  const ctx: Context = { request, ports, run, report };
  const listing = list(ctx);
  if (listing === null) {
    report.outcome = 'unmet-preconditions';
    return null;
  }
  const branch = listing.branchTip !== null;
  const path = listing.pathEntry !== null;
  if (!branch && !path) {
    report.outcome = 'no-leftover';
    report.decisionsUnused = [...request.decisions];
    return null;
  }
  const { trusted } = commonChecks(ctx, listing);
  const plans: (BranchPlan | PathPlan)[] = [];
  if (branch) plans.push(branchPlan(ctx, listing));
  if (path) plans.push(pathPlan(ctx, listing));
  const subjects = plans.map((plan) => plan.report);
  report.subjects.push(...subjects);
  recordChecks(ctx, trusted, subjects);

  const everyMet =
    allMet(report.common) &&
    subjects.every((subject) => allMet(subject.preconditions));
  if (!everyMet) {
    report.outcome = 'unmet-preconditions';
    return null;
  }
  if (request.mode === 'dry-run') {
    report.outcome = 'ready';
    return null;
  }
  try {
    for (const plan of plans) {
      const failure =
        plan.kind === 'branch'
          ? preserveBranch(ctx, plan)
          : preservePath(ctx, plan);
      if (failure !== null) return failure;
    }
  } catch (error) {
    return failed(
      report,
      `an unexpected error stopped the preservation: ${shorten(errorMessage(error))}`,
    );
  }
  report.outcome = 'preserved';
  return null;
}

// ---------------------------------------------------------------------------
// Production ports
// ---------------------------------------------------------------------------

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function lstatKind(path: string): LstatKind {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'absent';
    throw error;
  }
}

function lstatEntry(path: string): B1EntryInfo | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.ino === 0n) {
      throw new Error(`${path} has no stable identity on this platform`);
    }
    return {
      kind: stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other',
      identity: `${stat.dev}:${stat.ino}`,
      device: String(stat.dev),
      uid: Number(stat.uid),
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function directoryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino === 0n) {
      return null;
    }
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export interface DefaultB1PortsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly now?: () => Date;
  readonly windowsAclReader?: WindowsAclReader;
}

/** The production ports: live GitHub reads and the real filesystem. */
export function createDefaultB1PreservePorts(
  options: DefaultB1PortsOptions = {},
): B1PreservePorts {
  const platform = options.platform ?? process.platform;
  const windowsAclReader = options.windowsAclReader ?? readWindowsAcl;
  return {
    readTrusted: ({ owner, repo }) => readTrustedAutoDecide({ owner, repo }),
    readConfirmation: (input) => readConfirmationIssue(input),
    fs: {
      lstat: lstatKind,
      directoryIdentity,
      realpath: realpathOrNull,
      stateRoot: resolveStateBase(
        options.env ?? process.env,
        platform,
        options.home ?? homedir(),
      ),
      now: options.now ?? (() => new Date()),
      inspectDirectoryPrivacy: (path) =>
        inspectDirectoryPrivacy(path, platform, windowsAclReader),
      ensurePrivateDirectory: (path) =>
        ensurePrivateStateDirectory(path, platform, windowsAclReader),
      mkdir: (path, mode) => mkdirSync(path, { mode }),
      lstatEntry,
      readText: readTextOrNull,
      rename: (from, to) => renameSync(from, to),
      currentUid: () => process.getuid?.() ?? null,
    },
  };
}
