// idd-generated-from: src/scripts/release-tag.mts
//
// The scripts/release-tag.mjs copy is generated from this .mts source by
// `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// The closed core of the release-tag helper (issue #4523). It runs one
// operation, `signed-annotated-tag`, and refuses any other before a git or
// `gh` command runs. The packaged command-line entry point and registration
// are issue #4630; this module also decides and returns `{ report, exitStatus }`.
//
// Order: input checks, then the preconditions (the `gh` reads before any
// fetch), then the effects. A failed check refuses with its name and stops.
// The effects are at most one signed annotated tag object, made from the
// merge commit with the repository's own signing setup, and at most one
// successful push of that object. The helper never deletes, moves, or
// force-pushes a tag, never creates an unsigned tag, a branch, or a commit,
// and never edits a tracked file. A dry run (the default) writes only what
// its fetches write: remote-tracking refs and `FETCH_HEAD`.
//
// Every git command runs under one time bound (2 minutes by default, the
// bound the signed-commit merge wrapper section of docs/idd-helper-scripts.md
// sets). On timeout the recorded PID and its descendants get SIGTERM, then
// one shared wait (30 seconds by default) runs; a survivor that is not the
// signing program, a missing PID, or a missing process listing refuses.
//
// cspell:ignore refmap openpgp gpgsm ppid

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import {
  type CommandResult as ClaimedPushCommandResult,
  runProductionCommand as runClaimedPushCommand,
} from './claimed-push.mts';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { isNotDispatchedRefusal } from './github-api-refusal.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type ClassifiedHelperError,
  classifyHelperError,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  loadLayeredLocalPolicy,
  loadUserGlobalPolicyDocument,
} from './idd-config.mts';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mts';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
} from './policy-helpers.mts';

/** The one operation this core runs. */
const OPERATION = 'signed-annotated-tag';

/** The remote is fixed: the core never takes a remote argument. */
const REMOTE = 'origin';

/** The signing bound of the signed-commit merge wrapper section. */
const DEFAULT_TIME_BOUND_MS = 120_000;

/** The shared wait after SIGTERM, from the same section. */
const DEFAULT_SHARED_WAIT_MS = 30_000;

/** How often the shared wait reads the process listing again. */
const DEFAULT_POLL_INTERVAL_MS = 100;

/** How long a run that exited waits for its output pipes to end. */
const OUTPUT_DRAIN_MS = 2_000;

/** How long one process listing may take. */
const PROCESS_LISTING_TIMEOUT_MS = 10_000;

/** Captured output above this size is cut, and the run refuses as unreadable. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A `gh --repo` value: `HOST/OWNER/REPO`. An owner may hold `_`, as an
 * enterprise managed user's login does.
 */
const GH_REPOSITORY_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u;

/** The default-branch read, exactly as claimed-push's allow-list has it. */
const DEFAULT_BRANCH_ARGS = [
  'repo',
  'view',
  '--json',
  'defaultBranchRef',
  '--jq',
  '.defaultBranchRef.name',
] as const;

const ISSUE_FIELDS = 'state,labels';
const PULL_REQUEST_FIELDS = 'state,mergeCommit';

/**
 * The first git release whose `git tag -s` fails when an SSH signer fails.
 * Before 2.44.0, `builtin/tag.c` tested the signer's positive exit status with
 * `< 0`, so the command exited 0 and wrote an unsigned annotated tag.
 */
const MIN_SIGNING_GIT = { major: 2, minor: 44 } as const;

/** Fetch flags that keep a fetch to its own refspec and to no other write. */
const FETCH_FLAGS = [
  '--no-tags',
  '--refmap=',
  '--no-recurse-submodules',
  '--no-auto-maintenance',
] as const;

/** Every refusal name the core can return. */
export type ReleaseTagRefusalName =
  | 'unknown-operation'
  | 'invalid-version'
  | 'invalid-merge-sha'
  | 'invalid-pull-request'
  | 'invalid-issue'
  | 'invalid-allowed-signers'
  | 'invalid-apply'
  | 'origin-url-unreadable'
  | 'origin-url-ambiguous'
  | 'push-url-mismatch'
  | 'repository-not-hosted'
  | 'gh-repo-mismatch'
  | 'policy-unreadable'
  | 'policy-label-invalid'
  | 'release-issue-unreadable'
  | 'release-issue-closed'
  | 'release-issue-blocked'
  | 'pull-request-unreadable'
  | 'pull-request-not-merged'
  | 'merge-commit-mismatch'
  | 'default-branch-unreadable'
  | 'default-branch-invalid'
  | 'default-branch-mismatch'
  | 'branch-fetch-failed'
  | 'fetch-head-mismatch'
  | 'merge-commit-missing'
  | 'merge-commit-unreachable'
  | 'merge-commit-unreadable'
  | 'package-version-mismatch'
  | 'idd-version-mismatch'
  | 'template-idd-version-mismatch'
  | 'changelog-heading-missing'
  | 'remote-tag-unreadable'
  | 'remote-tag-invalid'
  | 'remote-tag-unsigned'
  | 'remote-tag-signature-invalid'
  | 'local-tag-unreadable'
  | 'local-tag-conflict'
  | 'git-version-unsupported'
  | 'signing-config-unreadable'
  | 'signing-failed'
  | 'signing-timeout'
  | 'created-tag-invalid'
  | 'tag-unsigned'
  | 'signature-check-failed'
  | 'push-failed'
  | 'push-outcome-unknown'
  | 'remote-tag-conflict'
  | 'post-push-check-failed'
  | 'process-listing-unavailable'
  | 'pid-record-missing'
  | 'process-survivor'
  | 'command-timeout';

export type ReleaseTagPreconditionName =
  | 'input'
  | 'repository'
  | 'release-issue'
  | 'bump-pull-request'
  | 'default-branch'
  | 'merge-commit'
  | 'package-version'
  | 'idd-version'
  | 'template-idd-version'
  | 'changelog-heading'
  | 'remote-tag'
  | 'local-tag';

export type ReleaseTagEffectName =
  | 'create-tag'
  | 'signature-check'
  | 'push-tag'
  | 'post-push-check';

/** The refusals of the timeout procedure itself. */
const PROCESS_REFUSALS: ReadonlySet<ReleaseTagRefusalName> = new Set([
  'process-listing-unavailable',
  'pid-record-missing',
  'process-survivor',
]);

const PRECONDITION_ORDER: readonly ReleaseTagPreconditionName[] = [
  'input',
  'repository',
  'release-issue',
  'bump-pull-request',
  'default-branch',
  'merge-commit',
  'package-version',
  'idd-version',
  'template-idd-version',
  'changelog-heading',
  'remote-tag',
  'local-tag',
];

const EFFECT_ORDER: readonly ReleaseTagEffectName[] = [
  'create-tag',
  'signature-check',
  'push-tag',
  'post-push-check',
];

export interface ReleaseTagPreconditionResult {
  name: ReleaseTagPreconditionName;
  status: 'passed' | 'failed' | 'not-run';
  detail: string;
}

export interface ReleaseTagEffectResult {
  name: ReleaseTagEffectName;
  status: 'planned' | 'done' | 'skipped' | 'failed' | 'not-run';
  detail: string;
}

/** One process still running after the shared wait. */
export interface SurvivorRecord {
  pid: number;
  args: string;
  /** True only for the signing program, a direct child of the git process. */
  signer: boolean;
}

/** What the time bound recorded and signaled. */
export interface ProcessRecord {
  recorded: number[];
  survivors: SurvivorRecord[];
  waitedMs: number;
}

export interface ReleaseTagRefusal {
  name: ReleaseTagRefusalName;
  detail: string;
  /** Present after a time bound fired; null otherwise. */
  processes: ProcessRecord | null;
}

export interface ReleaseTagReport {
  operation: typeof OPERATION | null;
  mode: 'dry-run' | 'apply';
  tag: string | null;
  decision: 'create' | 'use-local-tag' | 'found' | 'refused';
  preconditions: ReleaseTagPreconditionResult[];
  effects: ReleaseTagEffectResult[];
  /** The tag object the run created, used, or found. */
  tagObject: string | null;
  /** The commit that tag object peels to. */
  peeledCommit: string | null;
  created: boolean;
  found: boolean;
  pushAttempts: number;
  /** True after a landed push, false when none landed, null when unknown. */
  pushed: boolean | null;
  refusal: ReleaseTagRefusal | null;
}

export interface ReleaseTagOutcome {
  report: ReleaseTagReport;
  /** 0 for a passed dry run or a created, found, or pushed tag; 1 otherwise. */
  exitStatus: 0 | 1;
  /** Present when a GitHub read failed and the CLI must preserve its class. */
  cliError?: ClassifiedHelperError;
}

/** The inputs of `signed-annotated-tag`. Each is validated before any command. */
export interface ReleaseTagInput {
  operation: unknown;
  version: unknown;
  mergeSha: unknown;
  pullRequest: unknown;
  issue: unknown;
  /** Absolute path of the allowed-signers file for an SSH-signed tag. */
  allowedSigners: unknown;
  /** Only `true` performs the effects; absent or `false` is a dry run. */
  apply?: unknown;
  /** The repository checkout; defaults to the process directory. */
  cwd?: string;
}

/** What one child process reported. */
export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
  /** True when GitHub API load control refused a `gh` read before it ran. */
  notDispatched?: boolean;
  /** True when the time bound fired before the command exited. */
  timedOut?: boolean;
  /** Present when the time bound fired. */
  termination?: TerminationRecord;
  /** Preserved CLI classification for a failed GitHub read. */
  cliError?: ClassifiedHelperError;
}

/** The time bound's record of one timeout. */
export interface TerminationRecord extends ProcessRecord {
  /** False when `spawn` returned no PID. */
  pidRecorded: boolean;
  /** False when a process listing could not be read. */
  listingAvailable: boolean;
}

export type ReleaseTagRequest =
  | {
      kind: 'git';
      args: readonly string[];
      cwd: string;
      /** The signing programs a survivor may be; empty for other commands. */
      signerPrograms?: readonly string[];
    }
  | {
      kind: 'gh';
      args: readonly string[];
      /** The repository checkout the read is about. */
      cwd: string;
    };

export type ReleaseTagRunner = (
  request: ReleaseTagRequest,
) => Promise<CommandResult>;

/** How the core reads a repository identity from a remote URL. */
export type RepositoryIdentity =
  | {
      kind: 'hosted';
      /** How git reaches it: `ssh` covers ssh URLs and the scp-like form. */
      transport: HostedTransport;
      host: string;
      /** The URL's port, or the transport's default port. */
      port: number;
      owner: string;
      repo: string;
    }
  | { kind: 'local'; path: string };

export type HostedTransport = 'ssh' | 'https' | 'http' | 'git';

/** The port each transport uses when the URL names none. */
const DEFAULT_PORTS: Readonly<Record<HostedTransport, number>> = {
  ssh: 22,
  https: 443,
  http: 80,
  git: 9418,
};

/** The transport of each accepted URL scheme. */
const SCHEME_TRANSPORTS: Readonly<Record<string, HostedTransport>> = {
  https: 'https',
  http: 'http',
  ssh: 'ssh',
  'git+ssh': 'ssh',
  'ssh+git': 'ssh',
  git: 'git',
};

/** The gate-label policy: the repository's own file and any user-global labels. */
export type ReleaseTagPolicyRead =
  | {
      ok: true;
      /** The primary checkout's repository policy file, or null without one. */
      policy: unknown;
      /**
       * Every non-empty `labels.blockedByHumanLabelName` the user-global file
       * sets, at its top level or in any override. They are collected without
       * matching an override to this repository, because that match runs git
       * outside the time bound; each one also blocks.
       */
      userGlobalLabels: string[];
    }
  | { ok: false; reason: string };

export interface ReleaseTagDeps {
  run: ReleaseTagRunner;
  /** The environment the git children get; `GH_REPO` is read from it. */
  env: NodeJS.ProcessEnv;
  /**
   * The gate-label policy of the primary checkout at `primary`. The core
   * finds that path with a bounded `git worktree list`, so a worktree's own
   * copy of the policy is never read. Reading it runs no git command.
   */
  readPolicy: (primary: string) => ReleaseTagPolicyRead;
  isRegularFile: (path: string) => boolean;
  /** The `gh --repo` value for `origin`, or null when there is none. */
  ghRepositorySlug: (identity: RepositoryIdentity) => string | null;
}

export interface ReleaseTagDepsOptions {
  env?: NodeJS.ProcessEnv;
  /** The bound for every git command, in milliseconds. */
  timeBoundMs?: number;
  /** The shared wait after SIGTERM, in milliseconds. */
  sharedWaitMs?: number;
  /** How often the shared wait reads the process listing, in milliseconds. */
  pollIntervalMs?: number;
}

/** One `ps` row. */
interface ProcessEntry {
  pid: number;
  ppid: number;
  stat: string;
  args: string;
}

export interface BoundedCommand {
  file: string;
  args: readonly string[];
  cwd: string;
}

export interface BoundedCommandOptions {
  env: NodeJS.ProcessEnv;
  timeBoundMs: number;
  sharedWaitMs: number;
  pollIntervalMs: number;
  /** The programs a direct child of the command may be counted as. */
  signerPrograms: readonly string[];
}

class Refused extends Error {
  readonly refusal: ReleaseTagRefusal;
  readonly step: ReleaseTagPreconditionName | ReleaseTagEffectName;
  readonly cliError: ClassifiedHelperError | null;

  constructor(
    step: ReleaseTagPreconditionName | ReleaseTagEffectName,
    name: ReleaseTagRefusalName,
    detail: string,
    processes: ProcessRecord | null = null,
    cliError: ClassifiedHelperError | null = null,
  ) {
    super(`${name}: ${detail}`);
    this.step = step;
    this.refusal = { name, detail, processes };
    this.cliError = cliError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Strip URLs and `user@host:` remote forms from git output. */
function redact(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/giu, '<url>')
    .replace(/[^\s'"@/]+@[^\s'":/]+:[^\s'"]*/gu, '<url>');
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return redact(trimmed);
  }
  return '';
}

/** The first line of a failed command's stderr, or of its error, redacted. */
function failureDetail(result: CommandResult): string {
  return firstLine(result.stderr) || firstLine(result.error ?? '');
}

function withDetail(reason: string, detail: string): string {
  return detail === '' ? reason : `${reason}: ${detail}`;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.trim() !== '');
}

/**
 * The identity of a remote URL: `host/owner/repo` for an https, ssh, git, or
 * scp-style URL with a two-segment path, the resolved path for an absolute
 * path or a `file://` URL, and null for anything else.
 */
export function parseRepositoryIdentity(
  url: string,
): RepositoryIdentity | null {
  // A URL with control characters or surrounding whitespace is refused, not
  // trimmed: git would not reach the repository the trimmed text names.
  if (url === '' || url !== url.trim() || CONTROL_CHARACTER.test(url)) {
    return null;
  }
  const value = url;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu.exec(value);
  if (scheme !== null) {
    const name = (scheme[1] ?? '').toLowerCase();
    const rest = scheme[2] ?? '';
    if (name === 'file') {
      let path: string;
      try {
        path = decodeURIComponent(rest.replace(/^[^/]*/u, ''));
      } catch {
        // A malformed percent escape names no path.
        return null;
      }
      return path.startsWith('/')
        ? { kind: 'local', path: resolve(path) }
        : null;
    }
    const transport = Object.hasOwn(SCHEME_TRANSPORTS, name)
      ? SCHEME_TRANSPORTS[name]
      : undefined;
    if (transport === undefined) return null;
    const hosted =
      /^(?:[^/@]+@)?([A-Za-z0-9.-]+)(?::(\d+))?\/([^/]+)\/([^/]+?)(?:\.git)?\/*$/u.exec(
        rest,
      );
    if (hosted === null) return null;
    return hostedIdentity(
      transport,
      hosted[1],
      hosted[2] === undefined ? DEFAULT_PORTS[transport] : Number(hosted[2]),
      hosted[3],
      hosted[4],
    );
  }
  if (isAbsolute(value)) return { kind: 'local', path: resolve(value) };
  const scp =
    /^(?:[^/@:]+@)?([A-Za-z0-9.-]+):(?!\/)([^/]+)\/([^/]+?)(?:\.git)?\/*$/u.exec(
      value,
    );
  if (scp === null) return null;
  return hostedIdentity('ssh', scp[1], DEFAULT_PORTS.ssh, scp[2], scp[3]);
}

function hostedIdentity(
  transport: HostedTransport,
  rawHost: string | undefined,
  port: number,
  owner: string | undefined,
  repo: string | undefined,
): RepositoryIdentity | null {
  const host = (rawHost ?? '').toLowerCase();
  if (
    host === '' ||
    owner === undefined ||
    owner === '' ||
    repo === undefined ||
    repo === '' ||
    repo === '.git' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return null;
  }
  return { kind: 'hosted', transport, host, port, owner, repo };
}

/**
 * Whether two identities name one repository: the same host, owner, and
 * repository, and, over the same transport, the same port. Ports of different
 * transports are not compared, so HTTPS fetch with SSH push to the same
 * repository passes, while SSH on port 22 and SSH on port 2222 do not.
 */
function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  if (a.kind === 'local' || b.kind === 'local') {
    return a.kind === 'local' && b.kind === 'local' && a.path === b.path;
  }
  return (
    a.host === b.host &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    (a.transport !== b.transport || a.port === b.port)
  );
}

/** The `gh --repo` slug of a hosted identity. */
function hostedSlug(identity: RepositoryIdentity): string | null {
  if (identity.kind !== 'hosted') return null;
  const slug = `${identity.host}/${identity.owner}/${identity.repo}`;
  return GH_REPOSITORY_SLUG.test(slug) ? slug : null;
}

/** Whether a set `GH_REPO` names the same repository as `slug`. */
function ghRepoAgrees(value: string, slug: string): boolean {
  const parts = value.trim().split('/');
  const full =
    parts.length === 2
      ? ['github.com', ...parts]
      : parts.length === 3
        ? parts
        : [];
  if (full.length !== 3) return false;
  return full.join('/').toLowerCase() === slug.toLowerCase();
}

/**
 * The closed allow-list of this core's own `gh` reads: the release issue and
 * the bump pull request, each bound to one repository with `--repo`. The
 * default-branch read goes through claimed-push's own allow-list instead.
 */
function isAllowedReleaseGhRead(args: readonly string[]): boolean {
  if (args.length !== 7) return false;
  const [noun, verb, number, repoFlag, slug, jsonFlag, fields] = args;
  return (
    ((noun === 'issue' && fields === ISSUE_FIELDS) ||
      (noun === 'pr' && fields === PULL_REQUEST_FIELDS)) &&
    verb === 'view' &&
    /^[1-9][0-9]*$/u.test(number ?? '') &&
    repoFlag === '--repo' &&
    GH_REPOSITORY_SLUG.test(slug ?? '') &&
    jsonFlag === '--json'
  );
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function fromClaimedPush(result: ClaimedPushCommandResult): CommandResult {
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.notDispatched === true ? { notDispatched: true } : {}),
  };
}

/** Whether two paths name the same directory; false when either is missing. */
function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Run one `gh` read. The default-branch read is sent through claimed-push's
 * production runner, which applies its `isAllowedGhRead` list and runs `gh` in
 * the process directory, so it is refused unless `cwd` is that directory;
 * `gh` would otherwise read the repository of another checkout. The two reads
 * of this core carry `--repo` and pass their own closed list. Any other
 * argument list is refused before a process starts.
 */
function runGhRead(args: readonly string[], cwd: string): CommandResult {
  if (sameList(args, DEFAULT_BRANCH_ARGS)) {
    if (!sameDirectory(cwd, process.cwd())) {
      return {
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error:
          'the default-branch read runs in the process directory, which is not the repository checkout',
      };
    }
    return fromClaimedPush(
      runClaimedPushCommand({ kind: 'gh', args, cwd: process.cwd() }),
    );
  }
  if (!isAllowedReleaseGhRead(args)) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'the release-tag core refuses this gh argument list',
    };
  }
  try {
    return {
      status: 0,
      signal: null,
      stdout: ghText([...args], GH_TEXT_LOOP_TIMEOUT_OPTIONS),
      stderr: '',
    };
  } catch (error) {
    const fields = isRecord(error) ? error : {};
    const status = typeof fields.status === 'number' ? fields.status : null;
    const signal =
      typeof fields.signal === 'string' && fields.signal !== ''
        ? fields.signal
        : null;
    return {
      status,
      signal,
      stdout: outputText(fields.stdout),
      stderr: outputText(fields.stderr),
      ...(status === null
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
      ...(isNotDispatchedRefusal(error) ? { notDispatched: true } : {}),
      cliError: classifyHelperError(error),
    };
  }
}

/** One full process listing, or null when `ps` is missing or fails. */
function listProcesses(env: NodeJS.ProcessEnv): ProcessEntry[] | null {
  try {
    const result = spawnSync(
      'ps',
      ['-A', '-ww', '-o', 'pid=,ppid=,stat=,args='],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PROCESS_LISTING_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
    if (result.error !== undefined || result.status !== 0) return null;
    const entries: ProcessEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/u.exec(line);
      if (match === null) continue;
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        stat: match[3] ?? '',
        args: (match[4] ?? '').trim(),
      });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** Whether a process's arguments start with a signing program. */
function namesProgram(args: string, programs: readonly string[]): boolean {
  const tokens = args.split(/\s+/u);
  const candidates = [args];
  const space = args.indexOf(' ');
  if (space > 0) candidates.push(args.slice(space + 1));
  return programs.some((program) => {
    if (program === '') return false;
    const name = basename(program);
    return (
      candidates.some(
        (candidate) =>
          candidate === program || candidate.startsWith(`${program} `),
      ) ||
      basename(tokens[0] ?? '') === name ||
      basename(tokens[1] ?? '') === name
    );
  });
}

function signalTerm(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone (ESRCH), or not ours to signal: the shared wait decides.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * The timeout procedure: one listing, the root PID and every descendant
 * found by walking parent links, SIGTERM to all of them back to back, then
 * one shared wait that polls the listing until every recorded PID is gone
 * or a zombie. A child reparented before the listing is never recorded.
 */
async function terminateTree(
  rootPid: number | null,
  options: BoundedCommandOptions,
): Promise<TerminationRecord> {
  if (rootPid === null) {
    return {
      recorded: [],
      survivors: [],
      waitedMs: 0,
      pidRecorded: false,
      listingAvailable: true,
    };
  }
  const listing = listProcesses(options.env);
  if (listing === null) {
    signalTerm(rootPid);
    return {
      recorded: [rootPid],
      survivors: [],
      waitedMs: 0,
      pidRecorded: true,
      listingAvailable: false,
    };
  }
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of listing) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const recorded: ProcessEntry[] = [
    listing.find((entry) => entry.pid === rootPid) ?? {
      pid: rootPid,
      ppid: -1,
      stat: '',
      args: '',
    },
  ];
  const seen = new Set<number>([rootPid]);
  for (let index = 0; index < recorded.length; index += 1) {
    const parent = recorded[index]?.pid ?? -1;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      recorded.push(child);
    }
  }
  for (const entry of recorded) signalTerm(entry.pid);

  // A monotonic clock: a wall-clock step (seen on WSL2) must not stretch or
  // cut the shared wait.
  const started = performance.now();
  const deadline = started + options.sharedWaitMs;
  let alive = recorded;
  let listingAvailable = true;
  for (;;) {
    const now = listProcesses(options.env);
    listingAvailable = now !== null;
    if (now !== null) {
      const live = new Set(
        now.filter((entry) => !entry.stat.startsWith('Z')).map((e) => e.pid),
      );
      alive = recorded.filter((entry) => live.has(entry.pid));
      if (alive.length === 0) break;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(options.pollIntervalMs, remaining));
  }
  return {
    recorded: recorded.map((entry) => entry.pid),
    survivors: alive.map((entry) => ({
      pid: entry.pid,
      args: entry.args,
      signer:
        entry.ppid === rootPid &&
        options.signerPrograms.length > 0 &&
        namesProgram(entry.args, options.signerPrograms),
    })),
    waitedMs: Math.round(performance.now() - started),
    pidRecorded: true,
    listingAvailable,
  };
}

/**
 * Run one command under the time bound. The PID is recorded at spawn. The run
 * settles when the command exits (after its output pipes end, or after a short
 * drain when a descendant still holds them), or when the bound fires, never on
 * `close` alone. After a timeout it settles once the timeout procedure ends.
 */
export function runBoundedCommand(
  command: BoundedCommand,
  options: BoundedCommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((settle) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let settled = false;
    let timedOut = false;
    let exitStatus: number | null = null;
    let exitSignal: string | null = null;
    let exited = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const openStreams = new Set<string>();

    const text = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString('utf8');
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle(result);
    };
    const finishExited = (): void => {
      finish({
        status: overflow ? null : exitStatus,
        signal: exitSignal,
        stdout: text(out),
        stderr: text(err),
        ...(overflow ? { error: 'the command output exceeded the cap' } : {}),
      });
    };

    try {
      child = spawn(command.file, [...command.args], {
        cwd: command.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      settle({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const pid = typeof child.pid === 'number' ? child.pid : null;

    const streams = [
      { name: 'stdout', stream: child.stdout, chunks: out },
      { name: 'stderr', stream: child.stderr, chunks: err },
    ] as const;
    for (const { name, stream, chunks } of streams) {
      if (stream === null) continue;
      openStreams.add(name);
      stream.on('data', (chunk: Buffer) => {
        if (outBytes + errBytes + chunk.length > MAX_OUTPUT_BYTES) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
        if (name === 'stdout') outBytes += chunk.length;
        else errBytes += chunk.length;
      });
      stream.on('end', () => {
        openStreams.delete(name);
        if (exited && !timedOut && openStreams.size === 0) finishExited();
      });
      stream.on('error', () => {
        openStreams.delete(name);
      });
    }

    child.on('error', (error) => {
      if (exited || timedOut) return;
      finish({
        status: null,
        signal: null,
        stdout: text(out),
        stderr: text(err),
        error: error.message,
      });
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitStatus = code;
      exitSignal = signal;
      if (timedOut) return;
      if (openStreams.size === 0) {
        finishExited();
        return;
      }
      drainTimer = setTimeout(finishExited, OUTPUT_DRAIN_MS);
    });

    timer = setTimeout(() => {
      if (settled || exited) return;
      timedOut = true;
      void terminateTree(pid, options).then((termination) => {
        finish({
          status: null,
          signal: null,
          stdout: text(out),
          stderr: text(err),
          timedOut: true,
          termination,
          error: `the command did not finish within ${options.timeBoundMs} ms`,
        });
      });
    }, options.timeBoundMs);
  });
}

function positiveMs(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

/** The `labels.blockedByHumanLabelName` of a policy object, when non-empty. */
function gateLabelOf(config: unknown): string | null {
  const labels = isRecord(config) ? config.labels : undefined;
  const value = isRecord(labels) ? labels.blockedByHumanLabelName : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Every gate label the user-global file sets, at its top level or in an override. */
function userGlobalGateLabels(env: NodeJS.ProcessEnv): string[] {
  const document = loadUserGlobalPolicyDocument({ env });
  if (document.status !== 'present' || !isRecord(document.config)) return [];
  const found = [gateLabelOf(document.config)];
  const overrides = document.config.overrides;
  if (Array.isArray(overrides)) {
    for (const entry of overrides) {
      found.push(gateLabelOf(isRecord(entry) ? entry.config : undefined));
    }
  }
  return [...new Set(found.filter((label) => label !== null))];
}

/**
 * The production deps: git runs under the time bound with `env`, the `gh`
 * reads run through the repository's `gh` layer, and the gate label comes
 * from the primary checkout's policy.
 */
export function createReleaseTagDeps(
  options: ReleaseTagDepsOptions = {},
): ReleaseTagDeps {
  const env = options.env ?? process.env;
  const bounded = {
    env,
    timeBoundMs: positiveMs(
      options.timeBoundMs,
      DEFAULT_TIME_BOUND_MS,
      'timeBoundMs',
    ),
    sharedWaitMs: positiveMs(
      options.sharedWaitMs,
      DEFAULT_SHARED_WAIT_MS,
      'sharedWaitMs',
    ),
    pollIntervalMs: positiveMs(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    ),
  };
  return {
    env,
    run: async (request) => {
      if (request.kind === 'gh') return runGhRead(request.args, request.cwd);
      return await runBoundedCommand(
        { file: 'git', args: request.args, cwd: request.cwd },
        { ...bounded, signerPrograms: request.signerPrograms ?? [] },
      );
    },
    readPolicy: (primary) => {
      try {
        // The repository file alone: the layered loader would match a
        // user-global override to this repository with git outside the time
        // bound, so the user-global labels are collected separately below.
        const loaded = loadLayeredLocalPolicy({
          cwd: primary,
          env,
          noUserGlobal: true,
        });
        if (loaded.local.diagnostic !== undefined) {
          return {
            ok: false,
            reason: `the repository policy of the primary checkout ${primary} is unreadable: ${loaded.local.diagnostic}`,
          };
        }
        return {
          ok: true,
          policy: loaded.config ?? null,
          userGlobalLabels:
            env.GITHUB_ACTIONS === 'true' ? [] : userGlobalGateLabels(env),
        };
      } catch (error) {
        return {
          ok: false,
          reason: `the policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    isRegularFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    ghRepositorySlug: hostedSlug,
  };
}

interface Context {
  input: ValidInput;
  deps: ReleaseTagDeps;
  report: ReleaseTagReport;
}

interface ValidInput {
  version: string;
  sha: string;
  pullRequest: number;
  issue: number;
  allowedSigners: string;
  apply: boolean;
  cwd: string;
  tag: string;
}

type SignatureKind = 'ssh' | 'openpgp' | 'x509' | 'none';

function emptyReport(operation: unknown, apply: unknown): ReleaseTagReport {
  return {
    operation: operation === OPERATION ? OPERATION : null,
    mode: apply === true ? 'apply' : 'dry-run',
    tag: null,
    decision: 'refused',
    preconditions: PRECONDITION_ORDER.map((name) => ({
      name,
      status: 'not-run',
      detail: '',
    })),
    effects: EFFECT_ORDER.map((name) => ({
      name,
      status: 'not-run',
      detail: '',
    })),
    tagObject: null,
    peeledCommit: null,
    created: false,
    found: false,
    pushAttempts: 0,
    pushed: false,
    refusal: null,
  };
}

function setPrecondition(
  report: ReleaseTagReport,
  name: ReleaseTagPreconditionName,
  status: ReleaseTagPreconditionResult['status'],
  detail: string,
): void {
  const entry = report.preconditions.find((item) => item.name === name);
  if (entry !== undefined) {
    entry.status = status;
    entry.detail = detail;
  }
}

function setEffect(
  report: ReleaseTagReport,
  name: ReleaseTagEffectName,
  status: ReleaseTagEffectResult['status'],
  detail: string,
): void {
  const entry = report.effects.find((item) => item.name === name);
  if (entry !== undefined) {
    entry.status = status;
    entry.detail = detail;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateInput(
  input: ReleaseTagInput,
  deps: ReleaseTagDeps,
): ValidInput {
  if (input.operation !== OPERATION) {
    throw new Refused(
      'input',
      'unknown-operation',
      `the operation must be ${OPERATION}, not ${describe(input.operation)}`,
    );
  }
  if (
    typeof input.version !== 'string' ||
    !VERSION_PATTERN.test(input.version)
  ) {
    throw new Refused(
      'input',
      'invalid-version',
      `the version must be X.Y.Z without a prefix or suffix, not ${describe(input.version)}`,
    );
  }
  if (typeof input.mergeSha !== 'string' || !SHA_PATTERN.test(input.mergeSha)) {
    throw new Refused(
      'input',
      'invalid-merge-sha',
      `the merge commit must be 40 lowercase hexadecimal characters, not ${describe(input.mergeSha)}`,
    );
  }
  if (!isPositiveInteger(input.pullRequest)) {
    throw new Refused(
      'input',
      'invalid-pull-request',
      `the bump pull request must be a positive integer, not ${describe(input.pullRequest)}`,
    );
  }
  if (!isPositiveInteger(input.issue)) {
    throw new Refused(
      'input',
      'invalid-issue',
      `the release issue must be a positive integer, not ${describe(input.issue)}`,
    );
  }
  const signers = input.allowedSigners;
  if (
    typeof signers !== 'string' ||
    signers === '' ||
    CONTROL_CHARACTER.test(signers) ||
    !isAbsolute(signers) ||
    !deps.isRegularFile(signers)
  ) {
    throw new Refused(
      'input',
      'invalid-allowed-signers',
      `the allowed-signers file must be an absolute path to an existing regular file, not ${describe(signers)}`,
    );
  }
  if (input.apply !== undefined && typeof input.apply !== 'boolean') {
    throw new Refused(
      'input',
      'invalid-apply',
      `apply must be true or false, not ${describe(input.apply)}`,
    );
  }
  return {
    version: input.version,
    sha: input.mergeSha,
    pullRequest: input.pullRequest,
    issue: input.issue,
    allowedSigners: signers,
    apply: input.apply === true,
    cwd: input.cwd ?? process.cwd(),
    tag: `v${input.version}`,
  };
}

/** The refusal a timed-out command gets, by the precedence of the plan. */
function timeoutRefusal(
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  result: CommandResult,
  fallback: ReleaseTagRefusalName,
  detail: string,
): Refused {
  const termination = result.termination;
  const processes: ProcessRecord | null =
    termination === undefined
      ? null
      : {
          recorded: termination.recorded,
          survivors: termination.survivors,
          waitedMs: termination.waitedMs,
        };
  if (termination !== undefined && !termination.listingAvailable) {
    return new Refused(
      step,
      'process-listing-unavailable',
      withDetail(
        detail,
        'the process listing could not be read, so the process tree is unconfirmed',
      ),
      processes,
    );
  }
  if (termination !== undefined && !termination.pidRecorded) {
    return new Refused(
      step,
      'pid-record-missing',
      withDetail(detail, 'no PID was recorded at launch'),
      processes,
    );
  }
  const others = termination?.survivors.filter((item) => !item.signer) ?? [];
  if (others.length > 0) {
    return new Refused(
      step,
      'process-survivor',
      withDetail(
        detail,
        `PIDs ${others.map((item) => item.pid).join(', ')} outlived the shared wait and are not the signing program`,
      ),
      processes,
    );
  }
  const leaked = termination?.survivors.filter((item) => item.signer) ?? [];
  return new Refused(
    step,
    fallback,
    leaked.length > 0
      ? withDetail(
          detail,
          `the signing program (PIDs ${leaked.map((item) => item.pid).join(', ')}) outlived the shared wait and was left running`,
        )
      : detail,
    processes,
  );
}

async function git(
  ctx: Context,
  args: readonly string[],
  signerPrograms?: readonly string[],
): Promise<CommandResult> {
  return await ctx.deps.run({
    kind: 'git',
    args,
    cwd: ctx.input.cwd,
    ...(signerPrograms === undefined ? {} : { signerPrograms }),
  });
}

/**
 * Run a git read: exit 0 returns the result, a timeout refuses by the
 * precedence above, and any other end refuses with `failure`.
 */
async function gitRead(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  args: readonly string[],
  failure: ReleaseTagRefusalName,
  reason: string,
  allowed: readonly number[] = [0],
): Promise<CommandResult> {
  const result = await git(ctx, args);
  if (result.timedOut === true) {
    throw timeoutRefusal(step, result, 'command-timeout', reason);
  }
  if (result.status === null || !allowed.includes(result.status)) {
    throw new Refused(step, failure, withDetail(reason, failureDetail(result)));
  }
  return result;
}

async function ghRead(
  ctx: Context,
  step: ReleaseTagPreconditionName,
  args: readonly string[],
  failure: ReleaseTagRefusalName,
  reason: string,
): Promise<string> {
  const result = await ctx.deps.run({ kind: 'gh', args, cwd: ctx.input.cwd });
  if (result.status !== 0) {
    throw new Refused(
      step,
      failure,
      withDetail(
        reason,
        result.notDispatched === true
          ? 'GitHub API load control refused the read before it started'
          : failureDetail(result),
      ),
      null,
      result.cliError ?? null,
    );
  }
  return result.stdout;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function checkRepository(ctx: Context): Promise<string> {
  const step = 'repository';
  const fetchUrls = lines(
    (
      await gitRead(
        ctx,
        step,
        ['remote', 'get-url', '--all', REMOTE],
        'origin-url-unreadable',
        `the ${REMOTE} fetch URL could not be read`,
      )
    ).stdout,
  );
  const pushUrls = lines(
    (
      await gitRead(
        ctx,
        step,
        ['remote', 'get-url', '--push', '--all', REMOTE],
        'origin-url-unreadable',
        `the ${REMOTE} push URL could not be read`,
      )
    ).stdout,
  );
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) {
    throw new Refused(
      step,
      'origin-url-ambiguous',
      `${REMOTE} must have exactly one fetch URL and one push URL, not ${fetchUrls.length} and ${pushUrls.length}`,
    );
  }
  const fetchIdentity = parseRepositoryIdentity(fetchUrls[0] ?? '');
  const pushIdentity = parseRepositoryIdentity(pushUrls[0] ?? '');
  if (fetchIdentity === null || pushIdentity === null) {
    throw new Refused(
      step,
      'origin-url-unreadable',
      `the ${REMOTE} ${fetchIdentity === null ? 'fetch' : 'push'} URL names no repository this core can compare`,
    );
  }
  if (!sameRepository(fetchIdentity, pushIdentity)) {
    throw new Refused(
      step,
      'push-url-mismatch',
      `the ${REMOTE} push URL does not name the repository its fetch URL names`,
    );
  }
  const slug = ctx.deps.ghRepositorySlug(fetchIdentity);
  if (slug === null || !GH_REPOSITORY_SLUG.test(slug)) {
    throw new Refused(
      step,
      'repository-not-hosted',
      `the ${REMOTE} fetch URL names no HOST/OWNER/REPO repository for the gh reads`,
    );
  }
  const ghRepo = ctx.deps.env.GH_REPO;
  if (
    typeof ghRepo === 'string' &&
    ghRepo.trim() !== '' &&
    !ghRepoAgrees(ghRepo, slug)
  ) {
    throw new Refused(
      step,
      'gh-repo-mismatch',
      `GH_REPO is set to ${describe(ghRepo)}, which is not ${slug}`,
    );
  }
  setPrecondition(ctx.report, step, 'passed', `${REMOTE} is ${slug}`);
  return slug;
}

async function checkReleaseIssue(ctx: Context, slug: string): Promise<void> {
  const step = 'release-issue';
  const listing = await gitRead(
    ctx,
    step,
    ['worktree', 'list', '--porcelain', '-z'],
    'policy-unreadable',
    'git worktree list could not be read',
  );
  let primary: string | undefined;
  try {
    const main = parseLocalWorktreeList(listing.stdout)[0];
    primary = main === undefined || main.bare ? undefined : main.path;
  } catch {
    primary = undefined;
  }
  if (primary === undefined || primary === '') {
    throw new Refused(
      step,
      'policy-unreadable',
      'git worktree list names no primary checkout',
    );
  }
  const policy = ctx.deps.readPolicy(primary);
  if (!policy.ok) {
    throw new Refused(step, 'policy-unreadable', policy.reason);
  }
  const labels = isRecord(policy.policy) ? policy.policy.labels : undefined;
  if (isRecord(labels) && Object.hasOwn(labels, 'blockedByHumanLabelName')) {
    const raw = labels.blockedByHumanLabelName;
    if (
      typeof raw !== 'string' ||
      raw.trim() === '' ||
      CONTROL_CHARACTER.test(raw)
    ) {
      throw new Refused(
        step,
        'policy-label-invalid',
        `labels.blockedByHumanLabelName must be a non-empty string without control characters, not ${describe(raw)}`,
      );
    }
  }
  const gates = [
    ...new Set([
      normalizePolicyConfig(policy.policy).labels.blockedByHumanLabelName,
      ...policy.userGlobalLabels,
    ]),
  ];
  const stdout = await ghRead(
    ctx,
    step,
    [
      'issue',
      'view',
      String(ctx.input.issue),
      '--repo',
      slug,
      '--json',
      ISSUE_FIELDS,
    ],
    'release-issue-unreadable',
    `issue #${ctx.input.issue} could not be read`,
  );
  const issue = parseJson(stdout);
  if (
    !isRecord(issue) ||
    typeof issue.state !== 'string' ||
    !Array.isArray(issue.labels)
  ) {
    throw new Refused(
      step,
      'release-issue-unreadable',
      `issue #${ctx.input.issue} returned no state and labels`,
    );
  }
  const names: string[] = [];
  for (const label of issue.labels) {
    if (!isRecord(label) || typeof label.name !== 'string') {
      throw new Refused(
        step,
        'release-issue-unreadable',
        `issue #${ctx.input.issue} returned a label with no name`,
      );
    }
    names.push(label.name);
  }
  if (issue.state !== 'OPEN') {
    throw new Refused(
      step,
      'release-issue-closed',
      `issue #${ctx.input.issue} is ${describe(issue.state)}, not OPEN`,
    );
  }
  const blocking = gates.find((gate) => names.includes(gate));
  if (blocking !== undefined) {
    throw new Refused(
      step,
      'release-issue-blocked',
      `issue #${ctx.input.issue} carries the label ${describe(blocking)}`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `issue #${ctx.input.issue} is open without ${gates.map((gate) => describe(gate)).join(' or ')}`,
  );
}

async function checkPullRequest(ctx: Context, slug: string): Promise<void> {
  const step = 'bump-pull-request';
  const stdout = await ghRead(
    ctx,
    step,
    [
      'pr',
      'view',
      String(ctx.input.pullRequest),
      '--repo',
      slug,
      '--json',
      PULL_REQUEST_FIELDS,
    ],
    'pull-request-unreadable',
    `pull request #${ctx.input.pullRequest} could not be read`,
  );
  const pr = parseJson(stdout);
  if (!isRecord(pr) || typeof pr.state !== 'string') {
    throw new Refused(
      step,
      'pull-request-unreadable',
      `pull request #${ctx.input.pullRequest} returned no state`,
    );
  }
  if (pr.state !== 'MERGED') {
    throw new Refused(
      step,
      'pull-request-not-merged',
      `pull request #${ctx.input.pullRequest} is ${describe(pr.state)}, not MERGED`,
    );
  }
  const oid = isRecord(pr.mergeCommit) ? pr.mergeCommit.oid : undefined;
  if (oid !== ctx.input.sha) {
    throw new Refused(
      step,
      'merge-commit-mismatch',
      `pull request #${ctx.input.pullRequest} merged as ${describe(oid)}, not ${ctx.input.sha}`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `pull request #${ctx.input.pullRequest} merged as ${ctx.input.sha}`,
  );
}

async function checkDefaultBranch(ctx: Context): Promise<string> {
  const step = 'default-branch';
  const name = (
    await ghRead(
      ctx,
      step,
      DEFAULT_BRANCH_ARGS,
      'default-branch-unreadable',
      'the default branch could not be read',
    )
  ).trim();
  if (
    inspectDevelopmentBranch({ developmentBranch: name }).status !==
    'configured'
  ) {
    throw new Refused(
      step,
      'default-branch-invalid',
      `the default branch name ${describe(name)} is unusable`,
    );
  }
  const symref = await gitRead(
    ctx,
    step,
    ['ls-remote', '--symref', REMOTE, 'HEAD'],
    'default-branch-unreadable',
    `the HEAD of ${REMOTE} could not be read`,
  );
  const head = lines(symref.stdout)
    .map((line) => /^ref: refs\/heads\/(\S+)\tHEAD$/u.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (head !== name) {
    throw new Refused(
      step,
      'default-branch-mismatch',
      `gh names ${describe(name)}, but the HEAD of ${REMOTE} names ${describe(head ?? null)}`,
    );
  }
  setPrecondition(ctx.report, step, 'passed', `the default branch is ${name}`);
  return name;
}

async function revParse(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  rev: string,
  failure: ReleaseTagRefusalName,
): Promise<string | null> {
  const result = await gitRead(
    ctx,
    step,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', rev],
    failure,
    `${rev} could not be read`,
    [0, 1],
  );
  if (result.status === 1) return null;
  const value = result.stdout.trim();
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new Refused(step, failure, `${rev} resolved to an unexpected value`);
  }
  return value;
}

async function checkMergeCommit(ctx: Context, branch: string): Promise<void> {
  const step = 'merge-commit';
  const tracking = `refs/remotes/${REMOTE}/${branch}`;
  await gitRead(
    ctx,
    step,
    ['fetch', ...FETCH_FLAGS, REMOTE, `+refs/heads/${branch}:${tracking}`],
    'branch-fetch-failed',
    `${REMOTE}/${branch} could not be fetched`,
  );
  const fetched = await revParse(
    ctx,
    step,
    'FETCH_HEAD',
    'fetch-head-mismatch',
  );
  const tip = await revParse(ctx, step, tracking, 'fetch-head-mismatch');
  if (fetched === null || tip === null || fetched !== tip) {
    throw new Refused(
      step,
      'fetch-head-mismatch',
      `FETCH_HEAD does not match ${tracking} right after the fetch`,
    );
  }
  const type = await git(ctx, ['cat-file', '-t', ctx.input.sha]);
  if (type.timedOut === true) {
    throw timeoutRefusal(
      step,
      type,
      'command-timeout',
      'the merge commit could not be read',
    );
  }
  if (type.status !== 0 || type.stdout.trim() !== 'commit') {
    throw new Refused(
      step,
      'merge-commit-missing',
      `${ctx.input.sha} is not a commit in this repository after fetching ${REMOTE}/${branch}`,
    );
  }
  const ancestor = await gitRead(
    ctx,
    step,
    ['merge-base', '--is-ancestor', ctx.input.sha, tip],
    'merge-commit-unreadable',
    'the ancestry could not be read',
    [0, 1],
  );
  if (ancestor.status === 1) {
    throw new Refused(
      step,
      'merge-commit-unreachable',
      `${ctx.input.sha} is not reachable from ${REMOTE}/${branch} (${tip})`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `${ctx.input.sha} is reachable from ${REMOTE}/${branch} (${tip})`,
  );
}

async function readBlob(
  ctx: Context,
  step: ReleaseTagPreconditionName,
  path: string,
): Promise<string | null> {
  const result = await git(ctx, [
    'cat-file',
    'blob',
    `${ctx.input.sha}:${path}`,
  ]);
  if (result.timedOut === true) {
    throw timeoutRefusal(
      step,
      result,
      'command-timeout',
      `${path} could not be read`,
    );
  }
  return result.status === 0 ? result.stdout : null;
}

async function checkJsonField(
  ctx: Context,
  step: ReleaseTagPreconditionName,
  path: string,
  field: string,
  failure: ReleaseTagRefusalName,
): Promise<void> {
  const text = await readBlob(ctx, step, path);
  const value = text === null ? undefined : parseJson(text);
  const actual = isRecord(value) ? value[field] : undefined;
  if (actual !== ctx.input.version) {
    throw new Refused(
      step,
      failure,
      text === null
        ? `${path} is missing at ${ctx.input.sha}`
        : `${path} has ${field} ${describe(actual)} at ${ctx.input.sha}, not ${describe(ctx.input.version)}`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `${path} ${field} is ${ctx.input.version}`,
  );
}

function isCalendarDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined)
    return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

async function checkChangelog(ctx: Context): Promise<void> {
  const step = 'changelog-heading';
  const text = await readBlob(ctx, step, 'CHANGELOG.md');
  const escaped = ctx.input.version.replaceAll('.', '\\.');
  const heading = new RegExp(
    `^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})[ \\t]*\\r?$`,
    'mu',
  );
  const date = text === null ? undefined : heading.exec(text)?.[1];
  if (date === undefined || !isCalendarDate(date)) {
    throw new Refused(
      step,
      'changelog-heading-missing',
      `CHANGELOG.md at ${ctx.input.sha} has no "## [${ctx.input.version}] - YYYY-MM-DD" heading with a valid date`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `CHANGELOG.md has "## [${ctx.input.version}] - ${date}"`,
  );
}

type RemoteTag = { state: 'absent' } | { state: 'present'; object: string };

/**
 * Read the remote tag: `ls-remote` for the exact ref, then, when present, a
 * fetch that writes only `FETCH_HEAD` and objects, whose result must be the
 * listed object.
 */
async function readRemoteTag(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  failure: ReleaseTagRefusalName,
): Promise<RemoteTag> {
  const ref = `refs/tags/${ctx.input.tag}`;
  const listed = await gitRead(
    ctx,
    step,
    ['ls-remote', '--refs', REMOTE, ref],
    failure,
    `the remote tag ${ctx.input.tag} could not be listed`,
  );
  const matches = lines(listed.stdout)
    .map((line) => line.split('\t'))
    .filter((parts) => parts[1] === ref);
  if (matches.length === 0) return { state: 'absent' };
  const object = matches[0]?.[0] ?? '';
  if (matches.length > 1 || !OBJECT_ID_PATTERN.test(object)) {
    throw new Refused(
      step,
      failure,
      `${REMOTE} listed ${ref} in an unexpected form`,
    );
  }
  await gitRead(
    ctx,
    step,
    ['fetch', ...FETCH_FLAGS, REMOTE, ref],
    failure,
    `the remote tag ${ctx.input.tag} could not be fetched`,
  );
  const fetched = await revParse(ctx, step, 'FETCH_HEAD', failure);
  if (fetched !== object) {
    throw new Refused(
      step,
      failure,
      `the fetched ${ctx.input.tag} is ${describe(fetched)}, not the listed ${object}`,
    );
  }
  return { state: 'present', object };
}

/**
 * The tag-object check: a tag object whose headers are exactly
 * `object <merge sha>`, `type commit`, and `tag vX.Y.Z`. Returns the problem,
 * or null when the object passes.
 */
async function tagObjectProblem(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  object: string,
  failure: ReleaseTagRefusalName,
): Promise<{ problem: string | null; body: string }> {
  const type = await gitRead(
    ctx,
    step,
    ['cat-file', '-t', object],
    failure,
    `${object} could not be read`,
  );
  if (type.stdout.trim() !== 'tag') {
    return {
      problem: `${object} is a ${describe(type.stdout.trim())} object, not an annotated tag`,
      body: '',
    };
  }
  const body = (
    await gitRead(
      ctx,
      step,
      ['cat-file', 'tag', object],
      failure,
      `${object} could not be read`,
    )
  ).stdout;
  const headers = new Map<string, string>();
  for (const line of body.split('\n')) {
    if (line === '') break;
    const space = line.indexOf(' ');
    if (space > 0 && !headers.has(line.slice(0, space))) {
      headers.set(line.slice(0, space), line.slice(space + 1));
    }
  }
  if (
    headers.get('object') !== ctx.input.sha ||
    headers.get('type') !== 'commit'
  ) {
    return {
      problem: `${object} does not point directly at the commit ${ctx.input.sha}`,
      body,
    };
  }
  if (headers.get('tag') !== ctx.input.tag) {
    return {
      problem: `${object} is named ${describe(headers.get('tag') ?? null)}, not ${ctx.input.tag}`,
      body,
    };
  }
  return { problem: null, body };
}

/**
 * The signature armor lines git knows (`gpg-interface.c`: `openpgp_sigs`,
 * `x509_sigs`, and `ssh_sigs`). OpenPGP has two.
 */
const SIGNATURE_MARKERS: readonly (readonly [string, SignatureKind])[] = [
  ['-----BEGIN PGP SIGNATURE-----', 'openpgp'],
  ['-----BEGIN PGP MESSAGE-----', 'openpgp'],
  ['-----BEGIN SIGNED MESSAGE-----', 'x509'],
  ['-----BEGIN SSH SIGNATURE-----', 'ssh'],
];

/** The kind of the last line that starts a known signature, as git reads it. */
function signatureKind(body: string): SignatureKind {
  let kind: SignatureKind = 'none';
  for (const line of body.split('\n')) {
    const match = SIGNATURE_MARKERS.find(([marker]) => line.startsWith(marker));
    if (match !== undefined) kind = match[1];
  }
  return kind;
}

/**
 * One git setting: its value, or null when it is unset (`git config --get`
 * exits 1). A timeout refuses by the timeout precedence, and any other failure
 * refuses, so an unreadable setting never reads as an unset one.
 */
async function configValue(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  key: string,
): Promise<string | null> {
  const result = await git(ctx, ['config', '--get', key]);
  if (result.timedOut === true) {
    throw timeoutRefusal(
      step,
      result,
      'command-timeout',
      `${key} could not be read`,
    );
  }
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Refused(
      step,
      'signing-config-unreadable',
      withDetail(`${key} could not be read`, failureDetail(result)),
    );
  }
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

/** The signing programs git runs for a signature format. */
async function signerPrograms(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  kind: SignatureKind,
): Promise<string[]> {
  if (kind === 'ssh') {
    return [(await configValue(ctx, step, 'gpg.ssh.program')) ?? 'ssh-keygen'];
  }
  if (kind === 'x509') {
    return [(await configValue(ctx, step, 'gpg.x509.program')) ?? 'gpgsm'];
  }
  const set = [
    await configValue(ctx, step, 'gpg.openpgp.program'),
    await configValue(ctx, step, 'gpg.program'),
  ].filter((value): value is string => value !== null);
  return set.length > 0 ? [...new Set(set)] : ['gpg'];
}

/**
 * The signature check: the object is verified by its ID, with the input
 * allowed-signers file pinned on every call. Returns the problem, or null.
 */
async function signatureProblem(
  ctx: Context,
  step: ReleaseTagPreconditionName | ReleaseTagEffectName,
  object: string,
  body: string,
): Promise<{ unsigned: boolean; problem: string | null }> {
  const kind = signatureKind(body);
  if (kind === 'none') {
    return { unsigned: true, problem: `${object} carries no signature` };
  }
  const result = await git(
    ctx,
    [
      '-c',
      `gpg.ssh.allowedSignersFile=${ctx.input.allowedSigners}`,
      'verify-tag',
      object,
    ],
    await signerPrograms(ctx, step, kind),
  );
  if (result.timedOut === true) {
    throw timeoutRefusal(
      step,
      result,
      'command-timeout',
      `${object} could not be verified`,
    );
  }
  if (result.status !== 0) {
    return {
      unsigned: false,
      problem: withDetail(
        `the ${kind} signature of ${object} did not verify`,
        failureDetail(result),
      ),
    };
  }
  return { unsigned: false, problem: null };
}

async function checkRemoteTag(ctx: Context): Promise<boolean> {
  const step = 'remote-tag';
  const remote = await readRemoteTag(ctx, step, 'remote-tag-unreadable');
  if (remote.state === 'absent') {
    setPrecondition(
      ctx.report,
      step,
      'passed',
      `${REMOTE} has no ${ctx.input.tag}`,
    );
    return false;
  }
  const object = await tagObjectProblem(
    ctx,
    step,
    remote.object,
    'remote-tag-unreadable',
  );
  if (object.problem !== null) {
    throw new Refused(
      step,
      'remote-tag-invalid',
      `remote ${ctx.input.tag}: ${object.problem}`,
    );
  }
  const signature = await signatureProblem(
    ctx,
    step,
    remote.object,
    object.body,
  );
  if (signature.problem !== null) {
    throw new Refused(
      step,
      signature.unsigned
        ? 'remote-tag-unsigned'
        : 'remote-tag-signature-invalid',
      `remote ${ctx.input.tag}: ${signature.problem}`,
    );
  }
  ctx.report.tagObject = remote.object;
  ctx.report.peeledCommit = ctx.input.sha;
  ctx.report.found = true;
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `${REMOTE} has a signed ${ctx.input.tag} (${remote.object}) at ${ctx.input.sha}`,
  );
  return true;
}

async function checkLocalTag(ctx: Context): Promise<string | null> {
  const step = 'local-tag';
  const ref = `refs/tags/${ctx.input.tag}`;
  const object = await revParse(ctx, step, ref, 'local-tag-unreadable');
  if (object === null) {
    setPrecondition(ctx.report, step, 'passed', `no local ${ctx.input.tag}`);
    return null;
  }
  const check = await tagObjectProblem(
    ctx,
    step,
    object,
    'local-tag-unreadable',
  );
  if (check.problem !== null) {
    throw new Refused(
      step,
      'local-tag-conflict',
      `the local tag ${ctx.input.tag} (${object}) is left in place and cannot be used: ${check.problem}`,
    );
  }
  setPrecondition(
    ctx.report,
    step,
    'passed',
    `the local tag ${ctx.input.tag} (${object}) points at ${ctx.input.sha}`,
  );
  return object;
}

/**
 * Whether the local tag exists, for a refusal's detail after signing ended
 * badly. `earlier` names that end: when this read itself times out, its own
 * timeout refusal (with its process record) replaces the earlier refusal and
 * carries `earlier` in its detail.
 */
async function localTagNote(ctx: Context, earlier: string): Promise<string> {
  const result = await git(ctx, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `refs/tags/${ctx.input.tag}`,
  ]);
  if (result.timedOut === true) {
    throw timeoutRefusal(
      'create-tag',
      result,
      'command-timeout',
      `${earlier}; reading the local tag ${ctx.input.tag} afterwards did not finish`,
    );
  }
  if (result.status === 0) {
    return `the local tag ${ctx.input.tag} (${result.stdout.trim()}) exists and was left in place`;
  }
  if (result.status === 1) return `no local ${ctx.input.tag} was created`;
  return `whether a local ${ctx.input.tag} exists is unknown`;
}

/**
 * Refuse a git that writes an unsigned tag when an SSH signer fails, before
 * anything is signed. Checked whenever this run would create an SSH-signed
 * tag, in a dry run too, so the refusal shows before `--apply`. OpenPGP and
 * X.509 signing on that git already fail closed: their signer path returns
 * -1, which `git tag` dies on.
 */
async function checkSigningGit(ctx: Context): Promise<void> {
  const step = 'create-tag';
  const result = await gitRead(
    ctx,
    step,
    ['--version'],
    'git-version-unsupported',
    'git --version could not be read',
  );
  const text = result.stdout.trim();
  const match = /^git version (\d+)\.(\d+)/u.exec(text);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (
    match === null ||
    major < MIN_SIGNING_GIT.major ||
    (major === MIN_SIGNING_GIT.major && minor < MIN_SIGNING_GIT.minor)
  ) {
    throw new Refused(
      step,
      'git-version-unsupported',
      `${describe(text)} is older than git ${MIN_SIGNING_GIT.major}.${MIN_SIGNING_GIT.minor}.0 or unreadable; before that release, git tag -s exits 0 and writes an unsigned tag when an SSH signer fails, so no tag is signed`,
    );
  }
}

/** The signature format `git tag -s` uses here, from `gpg.format`. */
async function signingKind(ctx: Context): Promise<SignatureKind> {
  const format =
    (await configValue(ctx, 'create-tag', 'gpg.format')) ?? 'openpgp';
  return format === 'ssh' ? 'ssh' : format === 'x509' ? 'x509' : 'openpgp';
}

async function createTag(ctx: Context, kind: SignatureKind): Promise<string> {
  const step = 'create-tag';
  const result = await git(
    ctx,
    [
      'tag',
      '-s',
      '-m',
      `release ${ctx.input.tag}`,
      ctx.input.tag,
      ctx.input.sha,
    ],
    await signerPrograms(ctx, step, kind),
  );
  if (result.timedOut === true) {
    // Classify the timeout first. Only a tree confirmed gone (or one whose
    // sole survivor is the signer) allows another git command; otherwise
    // the local tag is not read at all.
    const refusal = timeoutRefusal(
      step,
      result,
      'signing-timeout',
      `signing ${ctx.input.tag} did not finish`,
    );
    refusal.refusal.detail +=
      refusal.refusal.name === 'signing-timeout'
        ? `; ${await localTagNote(ctx, refusal.refusal.detail)}`
        : '; the local tag was not read, because the process tree is unconfirmed';
    throw refusal;
  }
  if (result.status !== 0) {
    throw new Refused(
      step,
      'signing-failed',
      withDetail(
        `signing ${ctx.input.tag} failed; ${await localTagNote(
          ctx,
          `signing ${ctx.input.tag} failed`,
        )}`,
        failureDetail(result),
      ),
    );
  }
  const object = await revParse(
    ctx,
    step,
    `refs/tags/${ctx.input.tag}`,
    'created-tag-invalid',
  );
  if (object === null) {
    throw new Refused(
      step,
      'created-tag-invalid',
      `git tag reported success, but no local ${ctx.input.tag} exists`,
    );
  }
  const check = await tagObjectProblem(
    ctx,
    step,
    object,
    'created-tag-invalid',
  );
  if (check.problem !== null) {
    throw new Refused(
      step,
      'created-tag-invalid',
      `the local tag ${ctx.input.tag} (${object}) is left in place: ${check.problem}`,
    );
  }
  ctx.report.created = true;
  setEffect(ctx.report, step, 'done', `created ${ctx.input.tag} (${object})`);
  return object;
}

async function checkLocalSignature(
  ctx: Context,
  object: string,
): Promise<void> {
  const step = 'signature-check';
  const body = (
    await gitRead(
      ctx,
      step,
      ['cat-file', 'tag', object],
      'signature-check-failed',
      `${object} could not be read`,
    )
  ).stdout;
  const signature = await signatureProblem(ctx, step, object, body);
  if (signature.problem !== null) {
    throw new Refused(
      step,
      signature.unsigned ? 'tag-unsigned' : 'signature-check-failed',
      `the local tag ${ctx.input.tag} (${object}) is left in place: ${signature.problem}`,
    );
  }
  setEffect(ctx.report, step, 'done', `${object} carries a valid signature`);
}

async function pushTag(ctx: Context, object: string): Promise<void> {
  const step = 'push-tag';
  const ref = `refs/tags/${ctx.input.tag}`;
  for (;;) {
    ctx.report.pushAttempts += 1;
    const result = await git(ctx, [
      'push',
      '--no-follow-tags',
      REMOTE,
      `${object}:${ref}`,
    ]);
    if (result.status === 0) break;
    if (result.timedOut === true) {
      const refusal = timeoutRefusal(
        step,
        result,
        'push-failed',
        'the push did not finish',
      );
      if (refusal.refusal.name !== 'push-failed') {
        ctx.report.pushed = null;
        throw refusal;
      }
    }
    let remote: RemoteTag;
    try {
      remote = await readRemoteTag(ctx, step, 'push-outcome-unknown');
    } catch (error) {
      ctx.report.pushed = null;
      throw error;
    }
    if (remote.state === 'present' && remote.object === object) break;
    if (remote.state === 'present') {
      throw new Refused(
        step,
        'remote-tag-conflict',
        `${REMOTE} now has ${ctx.input.tag} as ${remote.object}, not this run's ${object}`,
      );
    }
    if (ctx.report.pushAttempts >= 2) {
      throw new Refused(
        step,
        'push-failed',
        withDetail(
          `${ctx.input.tag} did not reach ${REMOTE} after ${ctx.report.pushAttempts} pushes`,
          failureDetail(result),
        ),
      );
    }
  }
  ctx.report.pushed = true;
  setEffect(
    ctx.report,
    step,
    'done',
    `${REMOTE} has ${ctx.input.tag} (${object}) after ${ctx.report.pushAttempts} push invocation(s)`,
  );
}

async function postPushCheck(ctx: Context, object: string): Promise<void> {
  const step = 'post-push-check';
  const fail = (
    detail: string,
    processes: ProcessRecord | null = null,
  ): Refused =>
    new Refused(
      step,
      'post-push-check-failed',
      `${detail}; nothing was repaired`,
      processes,
    );
  let remote: RemoteTag;
  try {
    remote = await readRemoteTag(ctx, step, 'post-push-check-failed');
  } catch (error) {
    // A process-tree refusal keeps its own name: it blocks more than a
    // failed check does.
    // Any other refusal is reported as the failed check, keeping the time
    // bound's process record when the read timed out.
    if (error instanceof Refused && !PROCESS_REFUSALS.has(error.refusal.name)) {
      throw fail(error.refusal.detail, error.refusal.processes);
    }
    throw error;
  }
  if (remote.state === 'absent')
    throw fail(`${REMOTE} has no ${ctx.input.tag}`);
  if (remote.object !== object) {
    throw fail(
      `${REMOTE} has ${ctx.input.tag} as ${remote.object}, not ${object}`,
    );
  }
  const check = await tagObjectProblem(
    ctx,
    step,
    object,
    'post-push-check-failed',
  );
  if (check.problem !== null) throw fail(check.problem);
  const signature = await signatureProblem(ctx, step, object, check.body);
  if (signature.problem !== null) throw fail(signature.problem);
  setEffect(
    ctx.report,
    step,
    'done',
    `the remote ${ctx.input.tag} (${object}) passed the checks`,
  );
}

async function runChecksAndEffects(ctx: Context): Promise<void> {
  const slug = await checkRepository(ctx);
  await checkReleaseIssue(ctx, slug);
  await checkPullRequest(ctx, slug);
  const branch = await checkDefaultBranch(ctx);
  await checkMergeCommit(ctx, branch);
  await checkJsonField(
    ctx,
    'package-version',
    'package.json',
    'version',
    'package-version-mismatch',
  );
  await checkJsonField(
    ctx,
    'idd-version',
    '.github/idd/config.json',
    'iddVersion',
    'idd-version-mismatch',
  );
  await checkJsonField(
    ctx,
    'template-idd-version',
    'idd-template/.github/idd/config.json',
    'iddVersion',
    'template-idd-version-mismatch',
  );
  await checkChangelog(ctx);
  const found = await checkRemoteTag(ctx);
  // The local tag matters only when the remote tag is absent: a found remote
  // tag means no local tag is used or written, so a stale one never refuses.
  const local = found ? null : await checkLocalTag(ctx);
  if (found) {
    setPrecondition(
      ctx.report,
      'local-tag',
      'not-run',
      `${REMOTE} already has a valid ${ctx.input.tag}, so no local tag is used or written`,
    );
  }

  if (found) {
    ctx.report.decision = 'found';
    for (const name of EFFECT_ORDER) {
      setEffect(
        ctx.report,
        name,
        'skipped',
        `${REMOTE} already has a valid ${ctx.input.tag}`,
      );
    }
    return;
  }
  ctx.report.decision = local === null ? 'create' : 'use-local-tag';
  const kind = local === null ? await signingKind(ctx) : null;
  if (kind === 'ssh') await checkSigningGit(ctx);
  if (local !== null) {
    ctx.report.tagObject = local;
    ctx.report.peeledCommit = ctx.input.sha;
    setEffect(
      ctx.report,
      'create-tag',
      'skipped',
      `the local tag ${ctx.input.tag} (${local}) is used`,
    );
  }
  if (!ctx.input.apply) {
    if (local === null) {
      setEffect(
        ctx.report,
        'create-tag',
        'planned',
        `sign ${ctx.input.tag} at ${ctx.input.sha}`,
      );
      setEffect(
        ctx.report,
        'signature-check',
        'planned',
        'verify the new tag object',
      );
    } else {
      await checkLocalSignature(ctx, local);
    }
    setEffect(
      ctx.report,
      'push-tag',
      'planned',
      `push ${ctx.input.tag} to ${REMOTE}`,
    );
    setEffect(
      ctx.report,
      'post-push-check',
      'planned',
      `read ${ctx.input.tag} from ${REMOTE} again`,
    );
    return;
  }
  const object = local ?? (await createTag(ctx, kind ?? 'openpgp'));
  ctx.report.tagObject = object;
  ctx.report.peeledCommit = ctx.input.sha;
  await checkLocalSignature(ctx, object);
  await pushTag(ctx, object);
  await postPushCheck(ctx, object);
}

/**
 * Run `signed-annotated-tag`. Returns the report and the exit status the
 * command-line main (#4630) sets; never throws for a refusal.
 */
// audit:ignore-dead-export: the command-line main that calls it is issue #4630
export async function runReleaseTag(
  input: ReleaseTagInput,
  deps: ReleaseTagDeps = createReleaseTagDeps(),
): Promise<ReleaseTagOutcome> {
  const report = emptyReport(input.operation, input.apply);
  let valid: ValidInput;
  try {
    valid = validateInput(input, deps);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    setPrecondition(report, 'input', 'failed', error.refusal.detail);
    report.refusal = error.refusal;
    return {
      report,
      exitStatus: 1,
      ...(error.cliError === null ? {} : { cliError: error.cliError }),
    };
  }
  report.tag = valid.tag;
  setPrecondition(
    report,
    'input',
    'passed',
    `operation ${OPERATION} for ${valid.tag}`,
  );
  const ctx: Context = { input: valid, deps, report };
  try {
    await runChecksAndEffects(ctx);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    report.decision = 'refused';
    report.refusal = error.refusal;
    if ((PRECONDITION_ORDER as readonly string[]).includes(error.step)) {
      setPrecondition(
        report,
        error.step as ReleaseTagPreconditionName,
        'failed',
        error.refusal.detail,
      );
    } else {
      setEffect(
        report,
        error.step as ReleaseTagEffectName,
        'failed',
        error.refusal.detail,
      );
    }
    return {
      report,
      exitStatus: 1,
      ...(error.cliError === null ? {} : { cliError: error.cliError }),
    };
  }
  return { report, exitStatus: 0 };
}

const RELEASE_TAG_FLAG_SPEC = {
  '--operation': { type: 'string' },
  '--version': { type: 'string' },
  '--merge-sha': { type: 'string' },
  '--pr': { type: 'string' },
  '--issue': { type: 'string' },
  '--allowed-signers': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('release-tag', runCli);
  } else {
    runCli().then(applyHelperCliOutcomeWhenDisabled, (error: unknown) => {
      throw error;
    });
  }
}

async function runCli(): Promise<HelperCliResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    throw markCliUsageError(error);
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const outcome = await runReleaseTag({
    operation: parsed.operation,
    version: parsed.version,
    mergeSha: parsed.mergeSha,
    pullRequest: parsed.pullRequest,
    issue: parsed.issue,
    allowedSigners: parsed.allowedSigners,
    apply: parsed.apply,
  });
  process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  if (outcome.exitStatus === 0) return 0;
  const refusal = outcome.report.refusal;
  const inputRefusal =
    refusal !== null &&
    [
      'unknown-operation',
      'invalid-version',
      'invalid-merge-sha',
      'invalid-pull-request',
      'invalid-issue',
      'invalid-allowed-signers',
      'invalid-apply',
    ].includes(refusal.name);
  return {
    exitCode: 1,
    kind: outcome.cliError?.kind ?? (inputRefusal ? 'usage' : 'gate'),
    message:
      outcome.cliError?.message ??
      refusal?.detail ??
      'the release-tag operation was refused',
    ...(outcome.cliError === undefined
      ? {}
      : {
          httpStatus: outcome.cliError.httpStatus,
          ...(outcome.cliError.notDispatched
            ? { notDispatched: true as const }
            : {}),
          ...(outcome.cliError.retryAt
            ? { retryAt: outcome.cliError.retryAt }
            : {}),
        }),
  };
}

interface ParsedReleaseTagArgs {
  operation: string | null;
  version: string | null;
  mergeSha: string | null;
  pullRequest: number | null;
  issue: number | null;
  allowedSigners: string | null;
  apply: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedReleaseTagArgs {
  const { values, help } = parseCliArgs(argv, RELEASE_TAG_FLAG_SPEC);
  return {
    operation: typeof values.operation === 'string' ? values.operation : null,
    version: typeof values.version === 'string' ? values.version : null,
    mergeSha:
      typeof values['merge-sha'] === 'string' ? values['merge-sha'] : null,
    pullRequest: parseCanonicalIntegerOrNull(
      typeof values.pr === 'string' ? values.pr : undefined,
    ),
    issue: parseCanonicalIntegerOrNull(
      typeof values.issue === 'string' ? values.issue : undefined,
    ),
    allowedSigners:
      typeof values['allowed-signers'] === 'string'
        ? values['allowed-signers']
        : null,
    apply: values.apply === true,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  idd-release-tag --operation signed-annotated-tag --version <x.y.z> \\
    --merge-sha <commit-sha> --pr <number> --issue <number> \\
    --allowed-signers <absolute-path> [--apply]

Create or verify the signed annotated release tag for a merged version bump.
The only supported operation is signed-annotated-tag.

Inputs:
  --version          Release version without a prefix or suffix.
  --merge-sha        40-character lowercase merge commit SHA.
  --pr               Merged version-bump pull request number.
  --issue            Open release issue number.
  --allowed-signers  Absolute path to the SSH allowed-signers file.
  --apply            Create and push the tag after all checks pass.

Dry-run is the default. It checks the release and reports planned effects;
pass --apply to create and push the signed annotated tag.
`);
}
