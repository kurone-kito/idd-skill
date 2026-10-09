#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-activation.mts
//
// The scripts/idd-activation.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// Read-only activation gate for the user-global IDD entry text (#3821).
// It makes no network calls and writes nothing.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  isQualifiedConfigRoot,
  loadUserGlobalPolicyDocument,
} from './idd-config.mts';
import {
  deriveRepositoryIdentity,
  type GitTextRunner,
  loadRepositoryPolicyDocument,
  resolveLayeredPolicy,
} from './layered-policy.mts';

const INSTRUCTION_ENTRY =
  '.github/instructions/idd-overview-core.instructions.md';

export type ActivationTier =
  | 'repository-local'
  | 'user-global-override'
  | 'none';

export interface ActivationResult {
  active: boolean;
  tier: ActivationTier;
  instructionsRoot: string | null;
  reason: string;
}

export interface ActivationOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  runGit?: GitTextRunner;
}

/**
 * Resolve the installed payload directory. `XDG_DATA_HOME` wins when it is a
 * qualified root; otherwise `$HOME/.local/share`. A relative value is ignored
 * the same way `resolveUserGlobalConfigPath` ignores a relative
 * `XDG_CONFIG_HOME`. Returns `undefined` when neither root is usable.
 */
export function resolveInstalledPayloadRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): string | undefined {
  const env = options?.env ?? process.env;
  const xdg =
    typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : '';
  if (xdg.length > 0 && isQualifiedConfigRoot(xdg)) {
    return join(xdg, 'idd-skill', 'current');
  }
  const homeCandidate =
    typeof options?.homedir === 'string' && options.homedir.length > 0
      ? options.homedir
      : typeof env.HOME === 'string'
        ? env.HOME
        : '';
  const home = homeCandidate.trim();
  if (home.length === 0 || !isQualifiedConfigRoot(home)) return undefined;
  return join(home, '.local', 'share', 'idd-skill', 'current');
}

/**
 * Run git from `cwd` with inherited `GIT_*` variables removed. A variable
 * such as `GIT_DIR` would redirect every query to another repository, so the
 * repository must be found from the working directory alone.
 */
function defaultGitRunner(args: string[], cwd: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Resolve the installed payload and confirm it holds the core instruction
 * file. A missing install fails closed rather than naming a directory that
 * does not exist.
 */
function readyPayloadRoot(options: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): { root: string } | { reason: string } {
  const root = resolveInstalledPayloadRoot(options);
  if (root === undefined) return { reason: 'payload-root-unresolved' };
  if (!isRegularFile(join(root, INSTRUCTION_ENTRY))) {
    return { reason: 'payload-not-installed' };
  }
  return { root };
}

/** A directory at the instruction path cannot be opened as the overview. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function inactive(reason: string): ActivationResult {
  return { active: false, tier: 'none', instructionsRoot: null, reason };
}

/** Apply the activation rules in order and return the first match. */
export function computeActivation(
  options: ActivationOptions,
): ActivationResult {
  const runGit = options.runGit ?? defaultGitRunner;
  const cwd = resolve(options.cwd);

  let topLevel: string;
  try {
    const inside = runGit(['rev-parse', '--is-inside-work-tree'], cwd).trim();
    if (inside !== 'true') return inactive('not-a-git-work-tree');
    topLevel = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    return inactive('not-a-git-work-tree');
  }
  if (topLevel.length === 0) return inactive('not-a-git-work-tree');

  if (isRegularFile(join(topLevel, INSTRUCTION_ENTRY))) {
    return {
      active: true,
      tier: 'repository-local',
      instructionsRoot: topLevel,
      reason: 'repository-instruction-files',
    };
  }

  if (loadRepositoryPolicyDocument(topLevel).exists) {
    const payload = readyPayloadRoot(options);
    if (!('root' in payload)) return inactive(payload.reason);
    return {
      active: true,
      tier: 'repository-local',
      instructionsRoot: payload.root,
      reason: 'repository-policy-minimal-import',
    };
  }

  const userGlobal = loadUserGlobalPolicyDocument(options);
  if (userGlobal.status === 'present') {
    const identity = deriveRepositoryIdentity({ cwd: topLevel, runGit });
    const resolved = resolveLayeredPolicy({
      localDocument: { exists: false },
      identity,
      userGlobalConfig: userGlobal.config,
    });
    if (resolved.selectedOverrideIndex !== null) {
      const payload = readyPayloadRoot(options);
      if (!('root' in payload)) return inactive(payload.reason);
      return {
        active: true,
        tier: 'user-global-override',
        instructionsRoot: payload.root,
        reason: 'user-global-override-match',
      };
    }
  }

  return inactive('no-activation-rule');
}

const ACTIVATION_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-activation.mjs [--cwd <path>]

Read-only gate for the user-global IDD entry text (#3821). Prints one JSON
object with active, tier, instructionsRoot, and reason. It makes no network
calls and writes nothing.

Options:
  --cwd <path>   directory to classify (default: the current directory)
  -h, --help     show this help
`);
}

function runCli(): HelperCliResult {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    ACTIVATION_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const cwdValue = values.cwd as string | undefined;
  if (cwdValue !== undefined && cwdValue.length === 0) {
    throw markCliUsageError(new Error('--cwd must not be empty'));
  }
  const result = computeActivation({ cwd: cwdValue ?? process.cwd() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-activation', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
