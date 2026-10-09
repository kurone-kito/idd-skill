#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-activation.mts
//
// The scripts/idd-activation.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
// Read-only activation gate for the user-global IDD entry text (#3821).
// It makes no network calls and writes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import {
  isQualifiedConfigRoot,
  loadUserGlobalPolicyDocument,
} from './idd-config.mjs';
import {
  deriveRepositoryIdentity,
  loadRepositoryPolicyDocument,
  resolveLayeredPolicy,
} from './layered-policy.mjs';

const INSTRUCTION_ENTRY =
  '.github/instructions/idd-overview-core.instructions.md';
/**
 * Resolve the installed payload directory. `XDG_DATA_HOME` wins when it is a
 * qualified root; otherwise `$HOME/.local/share`. A relative value is ignored
 * the same way `resolveUserGlobalConfigPath` ignores a relative
 * `XDG_CONFIG_HOME`. Returns `undefined` when neither root is usable.
 */
export function resolveInstalledPayloadRoot(options) {
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
function defaultGitRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
function inactive(reason) {
  return { active: false, tier: 'none', instructionsRoot: null, reason };
}
/** Apply the activation rules in order and return the first match. */
export function computeActivation(options) {
  const runGit = options.runGit ?? defaultGitRunner;
  const cwd = resolve(options.cwd);
  let topLevel;
  try {
    const inside = runGit(['rev-parse', '--is-inside-work-tree'], cwd).trim();
    if (inside !== 'true') return inactive('not-a-git-work-tree');
    topLevel = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    return inactive('not-a-git-work-tree');
  }
  if (topLevel.length === 0) return inactive('not-a-git-work-tree');
  if (existsSync(join(topLevel, INSTRUCTION_ENTRY))) {
    return {
      active: true,
      tier: 'repository-local',
      instructionsRoot: topLevel,
      reason: 'repository-instruction-files',
    };
  }
  const payloadRoot = resolveInstalledPayloadRoot(options);
  if (loadRepositoryPolicyDocument(topLevel).exists) {
    if (payloadRoot === undefined) return inactive('payload-root-unresolved');
    return {
      active: true,
      tier: 'repository-local',
      instructionsRoot: payloadRoot,
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
      if (payloadRoot === undefined) return inactive('payload-root-unresolved');
      return {
        active: true,
        tier: 'user-global-override',
        instructionsRoot: payloadRoot,
        reason: 'user-global-override-match',
      };
    }
  }
  return inactive('no-activation-rule');
}
const ACTIVATION_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
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
function runCli() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    ACTIVATION_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const cwdValue = values.cwd;
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
