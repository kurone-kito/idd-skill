// idd-generated-from: src/scripts/idd-config.mts
//
// The scripts/idd-config.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared `.github/idd/config.json` loader, extracted from 7 per-helper
// copies of a `readFileSync + JSON.parse`, null-on-any-error wrapper (see
// #1208).
//
// No memoization: an earlier revision of this module cached the parsed
// result per resolved config path, but `idd-merge-execute.mts` calls
// `collectPreMergeReadiness` (which reads this config) twice in the same
// process — once for the initial gate, once to deliberately re-validate
// "immediately before merging" and fail closed on drift (see that file's
// `runMergeExecute` doc comment). A memoized second read would silently
// reuse the first call's config even if `.github/idd/config.json` changed
// (e.g. a trusted-marker-actor login revoked) between the two calls,
// defeating exactly the drift this re-validation exists to catch. Every
// production call site reads this file at most once per process anyway,
// so memoization had no real payoff to justify that risk.
//
// `loadIddConfig()` below only covers the default, current-working-directory
// case (#1208's
// original scope). #1721 adds `loadPolicyConfig()` beside it for the nine
// helpers that also accept an explicit `--policy`/`--config` path, with
// stricter failure semantics (see that function's doc comment).
// `loadIddConfig()`'s own null-on-any-error contract is deliberately left
// unchanged here: it has 11 existing callers that already rely on "missing,
// unreadable, or malformed config all collapse to null", and widening its
// blast radius to match `loadPolicyConfig()`'s stricter rules is a separate,
// wider-review change #1721 does not attempt. A later session may pick that
// residual up knowingly.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
  readGithubRepoDefaultBranch,
} from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import {
  inspectCritiqueLoopDelegateLayer,
  inspectCritiqueLoopTelemetryHookLayer,
  inspectIssueAuthoringDelegateLayer,
  normalizePolicyConfig,
  resolveEffectiveCritiqueLoopDelegate,
  resolveEffectiveCritiqueLoopTelemetryHook,
  resolveEffectiveIssueAuthoringDelegate,
} from './policy-helpers.mjs';

export {
  deriveRepositoryIdentity,
  loadRepositoryPolicyDocument,
  REPOSITORY_POLICY_FIELDS,
  resolveLayeredPolicy,
} from './layered-policy.mjs';
/**
 * Read and parse `.github/idd/config.json` from the current working
 * directory, returning `null` when the file is missing,
 * unreadable, or not valid JSON — the existing fail-safe every per-helper
 * copy already implements: treat a missing or malformed config the same as
 * "no policy configured". Always re-reads the file; see the module header
 * for why this does not memoize.
 */
export function loadIddConfig() {
  try {
    return JSON.parse(
      readFileSync(resolve(process.cwd(), '.github/idd/config.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}
/**
 * Resolve the opt-in `upstreamEscalation.enabled` toggle from an
 * already-loaded config object -- e.g. {@link loadIddConfig}'s return
 * value directly, or {@link loadPolicyConfig}'s `.config` field (typed
 * `unknown`). Accepts `unknown` rather than `IddConfig` so a caller
 * with the latter, untyped shape never needs an unsafe cast just to
 * read this one field. Absent, `null`, or any non-`true` value
 * resolves to `false` -- the same absent/false-is-disabled shape
 * `worktreeGuard.enabled` uses at its own read site
 * (`idd-doctor.mts`'s `readWorktreeGuardEnabled`).
 */
export function isUpstreamEscalationEnabled(config) {
  return config?.upstreamEscalation?.enabled === true;
}
/** Default `.github/idd/config.json` path, relative to the process cwd. */
export const DEFAULT_POLICY_CONFIG_PATH = '.github/idd/config.json';
/**
 * Build the `gh api` argv that reads `.github/idd/config.json` for
 * `owner/repo` **at `ref`** via the Contents API, narrowed to `.content`
 * (base64). `--method GET` is required alongside the `-f ref=...` field:
 * `gh api` defaults to POST as soon as any `-f` value is present, and the
 * Contents API only accepts GET -- an unqualified `-f ref=...` here 404s on
 * every call (confirmed empirically), which {@link loadTrustedIddConfig}'s
 * own catch block would otherwise silently treat as "config genuinely
 * absent, use defaults" instead of surfacing the real problem.
 */
export function buildIddConfigContentsArgs(owner, repo, ref) {
  return [
    'api',
    `repos/${owner}/${repo}/contents/.github/idd/config.json`,
    '--method',
    'GET',
    '-f',
    `ref=${ref}`,
    '--jq',
    '.content',
  ];
}
/**
 * Fetch and parse `.github/idd/config.json` for `owner/repo` **at a trusted
 * `ref`** -- a repository's default branch, or a PR's base branch -- via
 * the Contents API, instead of a local worktree read. Generalized from
 * `rerun-advisory-convergence.mts`'s original `loadRemoteIddConfig` (#1434)
 * so every caller that needs this trust boundary (that file's bot-identity
 * diagnosis, and `pre-merge-readiness.mts`'s policy-gate resolution, #2373)
 * shares one fetch-and-classify implementation instead of near-identical
 * copies.
 *
 * `ref` must be a value the PR under evaluation cannot itself steer --
 * never a PR's own `headSha`, never a local working-tree read. A PR that
 * could edit the ref this function reads from could edit its own
 * `.github/idd/config.json` to disguise a bot-triggered run as non-bot, loosen
 * `ciWait.rerunPolicy`, widen `trustedMarkerActors`, or otherwise weaken any
 * policy-driven gate that resolves through this function.
 *
 * Returns `null` -- falls back to the same documented defaults
 * {@link loadIddConfig} does for a missing local file -- **only** on a
 * confirmed 404 (`ref` genuinely has no config committed). Any other
 * failure -- a permission error, a transient Contents API failure, or
 * malformed content -- means this function cannot confirm whether `ref`
 * configures a non-default policy, so silently substituting defaults could
 * misclassify what the trusted ref actually governs. That ambiguity throws
 * instead of guessing, rather than proceeding on unconfirmed policy.
 *
 * `fetchEncodedConfig` is injectable (default: a real `gh api` call via
 * {@link ghText}) so a caller like `collectPreMergeReadiness` can pass a
 * fake in tests without spawning a `gh` process, mirroring
 * `idd-merge-execute.mts`'s `resolveRemoteSoloCodeownerAdminFallbackMode`.
 *
 * **Verified 2026-09-08 (#2716)**: GitHub's Contents API does NOT mask a
 * permission denial as a 404 for this endpoint. A disposable private repo
 * (`kurone-kito/idd-skill-issue-2716-contents-api-probe`, intentionally
 * retained) ran a GitHub Actions workflow declaring `permissions: {
 * contents: none }` at the job level and read an existing file at a valid
 * ref via the workflow's own ephemeral `GITHUB_TOKEN`. Observed response:
 * `403` with `{"message": "Resource not accessible by integration"}` --
 * a genuine, unambiguous permission denial, distinguishable from a real
 * 404. The `deriveGhHttpStatus(error) === 404` guard in the function body
 * below correctly evaluates false for a 403, so this case falls through
 * to the throw branch instead of being misclassified as absence. See
 * `docs/idd-helper-scripts.md` for the full test methodology.
 */
export function loadTrustedIddConfig(
  owner,
  repo,
  ref,
  fetchEncodedConfig = (fetchOwner, fetchRepo, fetchRef) =>
    ghText(
      buildIddConfigContentsArgs(fetchOwner, fetchRepo, fetchRef),
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    ),
) {
  try {
    const encoded = fetchEncodedConfig(owner, repo, ref);
    const decoded = Buffer.from(encoded.replace(/\n/g, ''), 'base64').toString(
      'utf8',
    );
    const parsed = JSON.parse(decoded);
    // A syntactically-valid top-level scalar/array/`null` (`JSON.parse('null')`
    // succeeds) would otherwise masquerade as this function's own "absent"
    // sentinel -- the same fail-open gap #1776 fixed for loadPolicyConfig's
    // local-file read, reopened here via a trusted-ref fetch instead.
    if (!isPlainObject(parsed)) {
      throw new Error(
        `expected a JSON object at the top level, got ${describeJsonValueKind(parsed)}`,
      );
    }
    return parsed;
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot confirm .github/idd/config.json for ${owner}/${repo}@${ref}: this trusted-ref read requires the file to be readable or genuinely absent (404) at this ref, not merely unreadable -- ${message}`,
    );
  }
}
/**
 * kurone-kito/idd-skill#3251: choose the ref a gate trusted-actor list
 * reads `.github/idd/config.json` from. A PR-scoped caller passes the
 * PR base ref; a repository-scoped caller passes `''` and this falls
 * back to the live default branch. Never a local worktree path.
 */
export function selectTrustedConfigRef(baseRefName, liveDefaultBranch) {
  const ref =
    String(baseRefName ?? '').trim() || String(liveDefaultBranch ?? '').trim();
  if (!ref) {
    throw new Error(
      'cannot resolve a trusted ref for .github/idd/config.json: no base ref was supplied and the repository live default branch could not be determined',
    );
  }
  return ref;
}
/**
 * Load `.github/idd/config.json` for the shared gate trusted-actor
 * builder. `baseRefName` is the PR base ref for a PR-scoped read and
 * `''` for a repository-scoped read (the live default branch).
 */
export function loadTrustedActorConfig({
  owner,
  repo,
  baseRefName = '',
  readDefaultBranch = readGithubRepoDefaultBranch,
  fetchEncodedConfig,
}) {
  const ref = selectTrustedConfigRef(
    baseRefName,
    String(baseRefName ?? '').trim() ? null : readDefaultBranch(owner, repo),
  );
  return loadTrustedIddConfig(owner, repo, ref, fetchEncodedConfig);
}
/**
 * Read `forcedHandoff.mode` at a trusted ref through the same loader and
 * normalization F2 applies, so a legacy `forcedHandoffMode` spelling resolves
 * identically on both sides of the gate.
 */
export function readTrustedForcedHandoffMode(
  owner,
  repo,
  ref,
  fetchEncodedConfig,
) {
  try {
    const config = loadTrustedIddConfig(owner, repo, ref, fetchEncodedConfig);
    if (config === null) {
      return { status: 'other', ref, mode: null };
    }
    const mode = normalizePolicyConfig(config).forcedHandoff.mode;
    return mode === 'human-gated'
      ? { status: 'human-gated', ref }
      : { status: 'other', ref, mode };
  } catch (error) {
    return {
      status: 'unreadable',
      ref,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
/**
 * Whether `branch` exists on the remote. Only a 404 means absent. Any other
 * failure throws, so the caller records it as unreadable instead of treating
 * an unknown branch as one that carries no opt-in.
 */
export function probeRemoteBranch(owner, repo, branch) {
  try {
    ghText([
      'api',
      `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      '--jq',
      '.name',
    ]);
    return 'present';
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return 'absent';
    }
    throw error;
  }
}
/**
 * Decide whether a forced handoff on `claimBranch` may proceed: every copy the
 * Resume and F2 gates would read must confirm `human-gated`. `openPrs` lists
 * the open pull requests the handoff targets: the one `--pr` names, or every
 * open PR under `--plan` when none is named. An empty list means the handoff
 * targets no PR. With a PR, the copies are its
 * base and the claim branch itself. With none, they are the live default
 * branch and, when the claim branch exists on the remote, that branch. Never
 * throws: a failed read is recorded, so `--plan` can report it and still exit
 * 0.
 */
export function evaluateForcedHandoffPreflight({
  owner,
  repo,
  claimBranch,
  openPrs,
  deps = {},
}) {
  const readMode = deps.readMode ?? readTrustedForcedHandoffMode;
  const readDefaultBranch =
    deps.readDefaultBranch ?? readGithubRepoDefaultBranch;
  const probeBranch = deps.probeBranch ?? probeRemoteBranch;
  const checks = [];
  const readCopy = (kind, label, ref) => {
    let reading;
    try {
      reading = readMode(owner, repo, ref);
    } catch (error) {
      reading = {
        status: 'unreadable',
        ref,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    checks.push({ kind, label, lookup: false, reading });
  };
  if (openPrs.length > 0) {
    const bases = [];
    for (const pr of openPrs) {
      const base = String(pr.baseRefName ?? '').trim();
      if (base === '') {
        checks.push({
          kind: 'pr-base',
          label: `the base branch of PR #${pr.number ?? '?'}`,
          lookup: true,
          reading: {
            status: 'unreadable',
            ref: `PR #${pr.number ?? '?'}`,
            error: `no base ref was returned for PR #${pr.number ?? '?'}`,
          },
        });
      } else if (!bases.includes(base)) {
        bases.push(base);
      }
    }
    for (const base of bases) {
      readCopy('pr-base', `the base branch ${base}`, base);
    }
    readCopy('claim-branch', `the claim branch ${claimBranch}`, claimBranch);
  } else {
    let defaultBranch = '';
    let defaultBranchError = 'could not determine the live default branch';
    try {
      defaultBranch = String(readDefaultBranch(owner, repo) ?? '').trim();
    } catch (error) {
      defaultBranchError =
        error instanceof Error ? error.message : String(error);
    }
    if (defaultBranch === '') {
      checks.push({
        kind: 'default-branch',
        label: 'the live default branch',
        lookup: true,
        reading: {
          status: 'unreadable',
          ref: '',
          error: defaultBranchError,
        },
      });
    } else {
      readCopy(
        'default-branch',
        `the default branch ${defaultBranch}`,
        defaultBranch,
      );
    }
    try {
      if (probeBranch(owner, repo, claimBranch) === 'present') {
        readCopy(
          'claim-branch',
          `the claim branch ${claimBranch}`,
          claimBranch,
        );
      }
    } catch (error) {
      checks.push({
        kind: 'claim-branch',
        label: `the claim branch ${claimBranch}`,
        lookup: true,
        reading: {
          status: 'unreadable',
          ref: claimBranch,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  const failing = checks.find(
    (check) => check.reading.status !== 'human-gated',
  );
  if (!failing) {
    return { ok: true, checks, refusal: null };
  }
  const reading = failing.reading;
  const label = failing.label;
  let cause;
  if (reading.status === 'unreadable') {
    cause = `could not be read (${reading.error})`;
  } else if (reading.status === 'other' && reading.mode !== null) {
    cause = `sets forcedHandoff.mode to ${reading.mode}`;
  } else {
    cause = 'does not set forcedHandoff.mode (no config file or no block)';
  }
  // The step must fix the copy that failed. A copy that could not be looked up
  // needs the lookup restored; a config that could not be read may also be
  // repaired at its source. The claim branch sets the mode itself, or, when it
  // has no forcedHandoff block, takes it from the copy that already confirmed.
  // A merge alone cannot replace a mode the claim branch sets, so the reader's
  // "disabled" for a missing block is not told apart from an explicit one here.
  let sequence;
  if (reading.status === 'unreadable') {
    sequence = failing.lookup
      ? 'Restore the read named above, then rerun.'
      : 'Restore the read named above, then rerun. If the error reports that the committed .github/idd/config.json is not valid JSON or is not a JSON object, repair that file through its normal path, then rerun.';
  } else if (failing.kind === 'claim-branch') {
    sequence =
      openPrs.length > 0
        ? `Set forcedHandoff.mode to human-gated on the claim branch ${claimBranch} through its normal path, or, when that branch has no forcedHandoff block, merge the PR's base branch into it and push the merge, then rerun. The merge gate reads the base-branch config, so only the base branch's opt-in counts for it.`
        : `Set forcedHandoff.mode to human-gated on the claim branch ${claimBranch}, or, when that branch has no forcedHandoff block, merge the default branch into it and push the merge, then rerun.`;
  } else if (openPrs.length > 0) {
    sequence = `Commit the opt-in to the base branch through its normal pull-request path, merge that branch into the PR branch ${claimBranch} and push the merge, then rerun. The merge gate reads the base-branch config, so the opt-in must land there, not only on the PR branch.`;
  } else {
    sequence =
      'Commit the opt-in to the default branch through its normal pull-request path, then rerun.';
  }
  return {
    ok: false,
    checks,
    refusal: `forced handoff refused: ${label} ${cause}, and forced handoff needs forcedHandoff.mode to be human-gated there. The successor would stop at Resume or F2 with claim-id-mismatch. ${sequence}`,
  };
}
/**
 * Read and parse a policy config file for the nine `--policy`/`--config`
 * aware helpers (#1721), converging the read-and-parse failure semantics
 * `discover-shared-file-overlap.mts` originally documented on its own:
 *
 * - An explicitly-supplied `policyPath` (non-empty) throws on **any**
 *   failure — missing, unreadable, or malformed — naming the resolved path
 *   and the underlying message. An operator who passes `--policy` has
 *   stated that the file matters; silently falling back to defaults would
 *   discard that intent.
 * - The default path (`policyPath` empty or omitted) returns `{ config:
 *   null }` only when the file does not exist (`ENOENT`) — the legitimate
 *   "repository has no IDD config" case. A syntax error, permission error,
 *   or any other read failure on the default path still throws: an
 *   existing-but-broken config is never silently equivalent to "absent".
 * - A file that parses as valid JSON but whose top-level value is not a
 *   plain object (`null`, an array, a string, a number, a boolean) is
 *   rejected the same way as a syntax error, for both the explicit and
 *   default path. `JSON.parse('null')` succeeds and returns `null`, which
 *   — left unchecked — would be indistinguishable from this function's own
 *   "absent" sentinel and silently re-open exactly the fail-open gap this
 *   function exists to close.
 *
 * Callers keep their own shape normalization (field extraction, defaults
 * for individual fields, etc.) on top of the raw `config` this returns —
 * this function converges only the read-and-parse step, not per-helper
 * field semantics. `loadIddConfig()` above is intentionally not reused
 * here: its null-on-any-error contract does not distinguish "absent" from
 * "malformed", which is exactly the distinction this function exists to
 * make.
 */
export function loadPolicyConfig(policyPath) {
  const explicit = typeof policyPath === 'string' && policyPath.length > 0;
  const path = resolve(
    process.cwd(),
    explicit ? policyPath : DEFAULT_POLICY_CONFIG_PATH,
  );
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(parsed)) {
      // A syntactically-valid top-level scalar/array/`null` is still a
      // malformed *policy config* -- reject it the same way a syntax error
      // is rejected below, rather than letting `JSON.parse('null')` in
      // particular masquerade as this function's own "absent" sentinel.
      throw new Error(
        `expected a JSON object at the top level, got ${describeJsonValueKind(parsed)}`,
      );
    }
    return { path, config: parsed };
  } catch (error) {
    if (!explicit && isEnoentError(error)) {
      return { path, config: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load policy from ${path}: ${message}`);
  }
}
/** True when `value` is a non-null, non-array JSON object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Short human-readable description of a non-object parsed JSON value. */
function describeJsonValueKind(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}
/**
 * True for a config-root that cannot be resolved against the process cwd.
 * On Windows: drive-letter (`C:\…` / `C:/…`) or UNC (`\\server\…`) only.
 * On POSIX: `/…` only (not `//…`, not a Windows drive or UNC string).
 * Rejects relative paths and Windows current-drive roots such as `\config`,
 * which `path.isAbsolute` treats as absolute on win32.
 */
function isQualifiedConfigRoot(value) {
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  }
  return value.startsWith('/') && !value.startsWith('//');
}
/** True when `error` is a Node.js filesystem error with `code: 'ENOENT'`. */
function isEnoentError(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
/** Directory name under XDG/`$HOME/.config` for the operator-global IDD file. */
export const USER_GLOBAL_CONFIG_DIRNAME = 'idd-skill';
/** Basename of the operator-global IDD policy file. */
export const USER_GLOBAL_CONFIG_FILENAME = 'config.json';
/**
 * Resolve the user-global IDD config path: `$XDG_CONFIG_HOME/idd-skill/config.json`
 * when `XDG_CONFIG_HOME` is a non-empty **qualified** root, otherwise
 * `$HOME/.config/idd-skill/config.json` when `$HOME` is a qualified root.
 * A qualified root is platform-specific (POSIX `/…`; Windows drive letter
 * or UNC) — a non-empty but relative or cross-platform-unsafe value is
 * ignored rather than joined against the process cwd. Returns `undefined`
 * when neither base directory is usable. Never calls `os.homedir()`.
 */
export function resolveUserGlobalConfigPath(options) {
  const env = options?.env ?? process.env;
  const xdg =
    typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  if (xdg.length > 0 && isQualifiedConfigRoot(xdg)) {
    return join(xdg, USER_GLOBAL_CONFIG_DIRNAME, USER_GLOBAL_CONFIG_FILENAME);
  }
  const homeCandidate =
    typeof options?.homedir === 'string' && options.homedir.length > 0
      ? options.homedir
      : typeof env.HOME === 'string'
        ? env.HOME
        : '';
  const home = homeCandidate.trim();
  if (home.length === 0 || !isQualifiedConfigRoot(home)) {
    return undefined;
  }
  return join(
    home,
    '.config',
    USER_GLOBAL_CONFIG_DIRNAME,
    USER_GLOBAL_CONFIG_FILENAME,
  );
}
/**
 * Read the operator-global policy file for C1 delegate inheritance.
 *
 * Missing, unreadable, non-JSON, and non-object documents are `absent`
 * (non-fatal). Callers must not merge this document into repository
 * policy. {@link resolveEffectiveCritiqueLoopDelegate} reads only
 * `critiqueLoop.delegate`, and
 * {@link resolveEffectiveIssueAuthoringDelegate} reads only
 * `issueAuthoring.adversarialReview.delegate`. Opt-in to local C1 or
 * issue-authoring resolution; CI and merge helpers must not call this.
 */
export function loadUserGlobalPolicyDocument(options) {
  const path =
    typeof options?.path === 'string' && options.path.length > 0
      ? options.path
      : resolveUserGlobalConfigPath(options);
  if (path === undefined) {
    return { status: 'absent' };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { status: 'absent', path };
    }
    return { status: 'present', path, config: parsed };
  } catch {
    return { status: 'absent', path };
  }
}
/**
 * Opt-in C1 entry: resolve the effective critique delegate from the
 * repository-local document plus an optional user-global file. Does not
 * run as a side effect of {@link loadIddConfig} or {@link loadPolicyConfig}.
 */
export function resolveEffectiveCritiqueLoopDelegateFromEnv(options) {
  const localConfig =
    options && Object.hasOwn(options, 'localConfig')
      ? options.localConfig
      : loadPolicyConfig(options?.localPolicyPath).config;
  const local = inspectCritiqueLoopDelegateLayer(localConfig);
  if (local.status !== 'absent') {
    return resolveEffectiveCritiqueLoopDelegate({ localConfig });
  }
  const global = loadUserGlobalPolicyDocument({
    env: options?.env,
    path: options?.globalConfigPath,
    homedir: options?.homedir,
  });
  return resolveEffectiveCritiqueLoopDelegate({
    localConfig,
    globalConfig: global.status === 'present' ? global.config : undefined,
  });
}
/**
 * Opt-in C-phase entry: resolve the effective `critiqueLoop.telemetryHook`
 * from the repository-local document plus an optional user-global file
 * (#2679). Structurally identical control flow to
 * {@link resolveEffectiveCritiqueLoopDelegateFromEnv}: repository-local
 * always wins outright when present (configured, disabled, or malformed);
 * only when repository-local is entirely absent does the user-global
 * fragment apply. Does not run as a side effect of {@link loadIddConfig} or
 * {@link loadPolicyConfig}.
 */
export function resolveEffectiveCritiqueLoopTelemetryHookFromEnv(options) {
  const localConfig =
    options && Object.hasOwn(options, 'localConfig')
      ? options.localConfig
      : loadPolicyConfig(options?.localPolicyPath).config;
  const local = inspectCritiqueLoopTelemetryHookLayer(localConfig);
  if (local.status !== 'absent') {
    return resolveEffectiveCritiqueLoopTelemetryHook({ localConfig });
  }
  const global = loadUserGlobalPolicyDocument({
    env: options?.env,
    path: options?.globalConfigPath,
    homedir: options?.homedir,
  });
  return resolveEffectiveCritiqueLoopTelemetryHook({
    localConfig,
    globalConfig: global.status === 'present' ? global.config : undefined,
  });
}
/**
 * Opt-in issue-authoring entry: resolve
 * `issueAuthoring.adversarialReview.delegate` from the repository-local
 * document plus an optional user-global file (#3599). Does not read
 * `critiqueLoop.delegate` and does not run as a side effect of
 * {@link loadIddConfig} or {@link loadPolicyConfig}.
 */
export function resolveEffectiveIssueAuthoringDelegateFromEnv(options) {
  const localConfig =
    options && Object.hasOwn(options, 'localConfig')
      ? options.localConfig
      : loadPolicyConfig(options?.localPolicyPath).config;
  const local = inspectIssueAuthoringDelegateLayer(localConfig);
  if (local.status !== 'absent') {
    return resolveEffectiveIssueAuthoringDelegate({ localConfig });
  }
  const global = loadUserGlobalPolicyDocument({
    env: options?.env,
    path: options?.globalConfigPath,
    homedir: options?.homedir,
  });
  return resolveEffectiveIssueAuthoringDelegate({
    localConfig,
    globalConfig: global.status === 'present' ? global.config : undefined,
  });
}
