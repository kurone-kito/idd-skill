// idd-generated-from: src/scripts/layered-policy.mts
//
// The scripts/layered-policy.mjs copy is generated from this .mts source by
// `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
/** Policy keys owned by repository policy rather than operator-global defaults. */
export const REPOSITORY_POLICY_FIELDS = Object.freeze({
  /** `helperRuntime` is read by the two advisory workflows, cleanup workflow, and pre-merge readiness. */
  helperRuntime:
    'idd-advisory-convergence.yml, idd-advisory-convergence-comment.yml, post-merge-cleanup.yml, pre-merge-readiness.mts',
  /** `trustedMarkerActors` is read by cleanup and trusted-marker consumers. */
  trustedMarkerActors:
    'post-merge-cleanup.yml, pre-merge-readiness.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
  /** `mergePolicy` controls authority in the F3 merge implementation. */
  mergePolicy: 'idd-merge-execute.mts and idd-merge.instructions.md',
  /** `mergeGate` controls the trusted solo-CODEOWNER fallback in F3. */
  mergeGate: 'idd-merge-execute.mts',
  /** `advisoryConvergence` configures the convergence helper policy read. */
  advisoryConvergence: 'advisory-convergence.mts',
  /** `reviewPolicy` controls whether advisory convergence applies. */
  reviewPolicy: 'advisory-convergence.mts',
  /** `ciGate` controls trusted CI and waiver decisions in its listed readers. */
  ciGate:
    'pre-merge-readiness.mts, resume-route-selection.mts, ci-wait-state.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
  /** `advisoryWait` is consumed by readiness and trusted advisory diagnosis. */
  advisoryWait:
    'pre-merge-readiness.mts, rerun-advisory-convergence.mts, external-check-waiver.mts',
  /** `advisoryBotLogins` is validated and consumed by trusted advisory diagnosis. */
  advisoryBotLogins: 'rerun-advisory-convergence.mts',
  /** `ciWait` controls trusted rerun behavior. */
  ciWait: 'rerun-advisory-convergence.mts',
  /** `developmentBranch` is read when readiness validates PR target branches. */
  developmentBranch: 'pre-merge-readiness.mts',
  /** `markerPrefix` binds generated marker parsing in readiness output. */
  markerPrefix: 'pre-merge-readiness.mts and protocol-helpers.mts',
  /** `claimTiming` supplies claim staleness to trusted readiness checks. */
  claimTiming: 'pre-merge-readiness.mts and rerun-advisory-convergence.mts',
  /** `forcedHandoff` determines trusted handoff authority and validation. */
  forcedHandoff: 'pre-merge-readiness.mts and external-check-waiver.mts',
  // The normalizer also reads these legacy aliases before falling back to
  // defaults, so keep them repository-owned whenever a local document exists.
  'forced-handoff': 'pre-merge-readiness.mts and external-check-waiver.mts',
  forcedHandoffMode: 'pre-merge-readiness.mts and external-check-waiver.mts',
  'forced-handoff-mode':
    'pre-merge-readiness.mts and external-check-waiver.mts',
  forcedHandoffAuthority:
    'pre-merge-readiness.mts and external-check-waiver.mts',
  'forced-handoff-authority':
    'pre-merge-readiness.mts and external-check-waiver.mts',
  /** `issueAuthoring` supplies the authoring guard label used by readiness. */
  issueAuthoring: 'pre-merge-readiness.mts',
  /** `markerTrust` controls whether collaborator-authored markers are trusted. */
  markerTrust:
    'pre-merge-readiness.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
  markerTrustAllowCollaboratorMarkers:
    'pre-merge-readiness.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
  allowCollaboratorMarkers:
    'pre-merge-readiness.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
  /** `providerOutage` controls trusted outage declarations and targets. */
  providerOutage:
    'pre-merge-readiness.mts, external-check-waiver.mts, local-validation-evidence.mts, provider-outage-declaration.mts',
});
/** Read canonical policy first; use the legacy filename only after ENOENT. */
// audit:ignore-dead-export: public layered-policy API introduced by #3818 for downstream roadmap consumers
export function loadRepositoryPolicyDocument(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const candidates = [
    join(root, '.github', 'idd', 'config.json'),
    join(root, 'idd-policy.json'),
  ];
  for (const [index, path] of candidates.entries()) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (index === 0 && isEnoent(error)) continue;
      if (index === 1 && isEnoent(error)) return { exists: false };
      return {
        exists: true,
        path,
        diagnostic: `cannot read repository policy ${path}: ${errorMessage(error)}`,
      };
    }
    try {
      const config = JSON.parse(text);
      if (!isPlainObject(config)) {
        return {
          exists: true,
          path,
          diagnostic: `repository policy ${path} must contain a JSON object`,
        };
      }
      return { exists: true, path, config };
    } catch (error) {
      return {
        exists: true,
        path,
        diagnostic: `cannot parse repository policy ${path}: ${errorMessage(error)}`,
      };
    }
  }
  return { exists: false };
}
/** Derive repository identity from Git using injectable cwd and command runner. */
// audit:ignore-dead-export: public layered-policy API introduced by #3818 for downstream roadmap consumers
export function deriveRepositoryIdentity(options) {
  const cwd = resolve(options.cwd);
  const runGit = options.runGit ?? defaultGitTextRunner;
  const remotes = runGit(['remote'], cwd)
    .split(/\r?\n/u)
    .map((remote) => remote.trim());
  const origin = remotes.includes('origin')
    ? runGit(['remote', 'get-url', 'origin'], cwd).trim()
    : '';
  const commonDir = runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  ).trim();
  if (!commonDir) {
    throw new Error('git rev-parse returned an empty common directory');
  }
  return {
    githubSlug: parseGithubOriginSlug(origin),
    mainWorktreeRoot: repositoryRootFromCommonDir(commonDir),
  };
}
/** Resolve local, selected override, global, then default values by leaf. */
// audit:ignore-dead-export: public layered-policy API introduced by #3818 for downstream roadmap consumers
export function resolveLayeredPolicy(input) {
  const diagnostics = [];
  const sourceMap = {};
  const local =
    input.localDocument.exists && isPlainObject(input.localDocument.config)
      ? input.localDocument.config
      : {};
  const global = isPlainObject(input.userGlobalConfig)
    ? input.userGlobalConfig
    : {};
  if (input.localDocument.diagnostic)
    diagnostics.push(input.localDocument.diagnostic);
  if (
    input.userGlobalConfig !== undefined &&
    !isPlainObject(input.userGlobalConfig)
  ) {
    diagnostics.push('user-global policy must contain a JSON object');
  }
  const selected = selectOverride(
    global.overrides,
    input.identity,
    input.platform ?? process.platform,
  );
  diagnostics.push(...selected.diagnostics);
  let config = overlayPolicyLayer({}, input.defaults, 'default', '', sourceMap);
  config = overlayGlobalLayer(
    config,
    withoutOverrides(global),
    'user-global',
    input.localDocument.exists,
    sourceMap,
  );
  config = overlayGlobalLayer(
    config,
    selected.config ?? {},
    'user-global-override',
    input.localDocument.exists,
    sourceMap,
  );
  config = overlayPolicyLayer(config, local, 'repository-local', '', sourceMap);
  return {
    config: isPlainObject(config) ? config : {},
    sourceMap,
    selectedOverrideIndex: selected.index,
    diagnostics,
  };
}
function overlayGlobalLayer(base, layer, source, localExists, sourceMap) {
  const filtered = Object.fromEntries(
    Object.entries(layer).filter(
      ([key]) => !(localExists && Object.hasOwn(REPOSITORY_POLICY_FIELDS, key)),
    ),
  );
  return overlayPolicyLayer(base, filtered, source, '', sourceMap);
}
function overlayPolicyLayer(base, incoming, source, path, sourceMap) {
  if (!isPlainObject(incoming)) return cloneJsonValue(base);
  if (!isPlainObject(base)) {
    clearSourcePath(sourceMap, path);
    const copy = cloneJsonValue(incoming);
    markLeafSources(copy, source, path, sourceMap);
    return copy;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const childPath = joinPolicyPath(path, key);
    const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      const mergedChild = overlayPolicyLayer(
        baseValue,
        value,
        source,
        childPath,
        sourceMap,
      );
      defineOwn(merged, key, mergedChild);
      if (isPlainObject(mergedChild) && Object.keys(mergedChild).length === 0) {
        defineOwn(sourceMap, childPath, source);
      } else {
        delete sourceMap[childPath];
      }
    } else {
      clearSourcePath(sourceMap, childPath);
      defineOwn(merged, key, cloneJsonValue(value));
      markLeafSources(value, source, childPath, sourceMap);
    }
  }
  return merged;
}
function markLeafSources(value, source, path, sourceMap) {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      markLeafSources(child, source, joinPolicyPath(path, key), sourceMap);
    }
  } else if (path) {
    defineOwn(sourceMap, path, source);
  }
}
/** Escape literal path separators inside a policy key before joining segments. */
function joinPolicyPath(parent, key) {
  const segment = key.replace(/\\/gu, '\\\\').replace(/\./gu, '\\.');
  return parent ? `${parent}.${segment}` : segment;
}
function clearSourcePath(sourceMap, path) {
  for (const key of Object.keys(sourceMap)) {
    if (key === path || (path && key.startsWith(`${path}.`)))
      delete sourceMap[key];
  }
}
function selectOverride(rawOverrides, identity, platform) {
  if (rawOverrides === undefined) return { index: null, diagnostics: [] };
  if (!Array.isArray(rawOverrides)) {
    return {
      index: null,
      diagnostics: ['user-global overrides must be an array'],
    };
  }
  const diagnostics = [];
  const matches = [];
  rawOverrides.forEach((value, index) => {
    if (!isPlainObject(value) || !isPlainObject(value.match)) {
      diagnostics.push(
        `ignored malformed user-global override at index ${index}`,
      );
      return;
    }
    const hasRepo = Object.hasOwn(value.match, 'repo');
    const hasPath = Object.hasOwn(value.match, 'path');
    if (hasRepo === hasPath || !isPlainObject(value.config)) {
      diagnostics.push(
        `ignored malformed user-global override at index ${index}`,
      );
      return;
    }
    let rank = -1;
    if (
      hasRepo &&
      identity.githubSlug &&
      typeof value.match.repo === 'string'
    ) {
      if (
        value.match.repo.trim().toLowerCase() ===
        identity.githubSlug.toLowerCase()
      ) {
        rank = 1_000_000;
      }
    } else if (
      hasPath &&
      !identity.githubSlug &&
      typeof value.match.path === 'string'
    ) {
      const rootSegments = pathSegments(identity.mainWorktreeRoot, platform);
      const suffixSegments = pathSegments(value.match.path, platform);
      if (
        rootSegments &&
        suffixSegments &&
        suffixSegments.length <= rootSegments.length &&
        suffixSegments.every(
          (segment, offset) =>
            segment ===
            rootSegments[rootSegments.length - suffixSegments.length + offset],
        )
      ) {
        rank = suffixSegments.length;
      }
    }
    if (rank >= 0) matches.push({ index, rank, config: value.config });
  });
  if (matches.length === 0) return { index: null, diagnostics };
  const highestRank = Math.max(...matches.map((candidate) => candidate.rank));
  const winners = matches.filter((candidate) => candidate.rank === highestRank);
  if (winners.length > 1) {
    diagnostics.push(
      `conflicting user-global overrides at indexes ${winners.map((winner) => winner.index).join(', ')}`,
    );
    return { index: null, diagnostics };
  }
  const winner = winners[0];
  if (!winner) return { index: null, diagnostics };
  return { config: winner.config, index: winner.index, diagnostics };
}
function pathSegments(value, platform) {
  const normalized = value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((part) => part === '.' || part === '..')
  ) {
    return null;
  }
  return platform === 'win32'
    ? segments.map((part) => part.toLowerCase())
    : segments;
}
function withoutOverrides(config) {
  const result = { ...config };
  delete result.overrides;
  return result;
}
function parseGithubOriginSlug(remote) {
  if (!remote) return null;
  let hostname = '';
  let repositoryPath = '';
  if (/^https:\/\//iu.test(remote) || /^ssh:\/\//iu.test(remote)) {
    try {
      const url = new URL(remote);
      const authority = /^[a-z]+:\/\/([^/?#]+)/iu.exec(remote)?.[1] ?? '';
      const invalidCredentials =
        url.password ||
        (url.protocol === 'https:' && url.username) ||
        (url.protocol === 'ssh:' &&
          url.username &&
          url.username.toLowerCase() !== 'git');
      if (
        (url.protocol !== 'https:' && url.protocol !== 'ssh:') ||
        url.hostname.toLowerCase() !== 'github.com' ||
        invalidCredentials ||
        authority.includes(':') ||
        url.port ||
        url.search ||
        url.hash
      )
        return null;
      hostname = url.hostname;
      repositoryPath = url.pathname.replace(/^\//u, '');
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(remote);
    if (!scp) return null;
    const [, scpHostname, scpPath] = scp;
    if (!scpHostname || !scpPath) return null;
    hostname = scpHostname;
    repositoryPath = scpPath;
  }
  if (hostname.toLowerCase() !== 'github.com' || repositoryPath.includes('%'))
    return null;
  const path = repositoryPath.replace(/\/+$/u, '').replace(/\.git$/iu, '');
  const parts = path.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    return null;
  }
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}
function repositoryRootFromCommonDir(commonDir) {
  const value = commonDir.trim();
  const isWindowsPath = /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
  const pathApi = isWindowsPath ? win32 : posix;
  if (!pathApi.isAbsolute(value))
    throw new Error(`git common directory is not absolute: ${commonDir}`);
  const normalized = pathApi.normalize(value);
  const leaf = pathApi.basename(normalized);
  let root = normalized;
  if (leaf === '.git') root = pathApi.dirname(normalized);
  else if (leaf.toLowerCase().endsWith('.git'))
    root = normalized.slice(0, -'.git'.length);
  if (!root || root === '.')
    throw new Error(
      `cannot derive repository root from git common directory: ${commonDir}`,
    );
  return pathApi.normalize(root);
}
function defaultGitTextRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    );
  }
  return value;
}
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isEnoent(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
