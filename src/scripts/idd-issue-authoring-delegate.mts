#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-issue-authoring-delegate.mts
//
// The scripts/idd-issue-authoring-delegate.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Deterministic, network-free resolver for the issue-authoring adversarial
// draft-review delegate (#3599). Reports the effective command, mode,
// source, and unusable reason. It never invokes the configured command and
// never reads a branch diff: the caller sends the issue draft. The
// configured command is trusted executable configuration and can transmit
// that draft.

import { parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  loadPolicyConfig,
  type ResolveEffectiveIssueAuthoringDelegateFromEnvOptions,
  resolveEffectiveIssueAuthoringDelegateFromEnv,
} from './idd-config.mts';
import { resolveIssueAuthoringAdversarialWaitCeiling } from './policy-helpers.mts';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `policy:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --policy spec key
// below. See cli-args.mts's module header for the full invariant.
const IDD_ISSUE_AUTHORING_DELEGATE_FLAG_SPEC = {
  '--policy': { type: 'string' },
  '--no-user-global': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

const NO_DELEGATE_REASONS: Record<string, string> = {
  disabled: 'repository-local-explicit-disable',
  none: 'not-configured',
};

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-issue-authoring-delegate', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

export interface IssueAuthoringDelegateReport {
  usable: boolean;
  source: 'repository-local' | 'user-global' | 'none';
  command: string | null;
  mode: 'fallback' | 'combined' | 'on-success' | 'never' | null;
  reason: string | null;
  waitCeiling: string;
}

/**
 * `GITHUB_ACTIONS` is the remote surface this repository already tests.
 * `noUserGlobal` covers every other remote surface the caller recognizes.
 * Either one skips the user-global file. Neither one changes the
 * repository-local wait ceiling.
 */
function isRemoteAgentSurface(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

function repositoryLocalConfig(
  options?: ResolveEffectiveIssueAuthoringDelegateFromEnvOptions,
): unknown {
  if (options && Object.hasOwn(options, 'localConfig')) {
    return options.localConfig;
  }
  return loadPolicyConfig(options?.localPolicyPath).config;
}

/**
 * Map the layered resolver onto the helper report. `waitCeiling` always
 * comes from the repository-local document, including when the delegate
 * itself is inherited from the user-global file.
 */
export function buildIssueAuthoringDelegateReport(
  options?: ResolveEffectiveIssueAuthoringDelegateFromEnvOptions,
  noUserGlobal = false,
): IssueAuthoringDelegateReport {
  const env = options?.env ?? process.env;
  const resolvedOptions =
    noUserGlobal || isRemoteAgentSurface(env)
      ? {
          ...options,
          env: {},
          globalConfigPath: undefined,
          homedir: undefined,
        }
      : options;
  const effective =
    resolveEffectiveIssueAuthoringDelegateFromEnv(resolvedOptions);
  const usable = effective.status === 'local' || effective.status === 'global';
  return {
    usable,
    source: effective.source,
    command: usable ? (effective.delegate?.command ?? null) : null,
    mode: usable ? (effective.delegate?.mode ?? null) : null,
    reason: usable
      ? null
      : (effective.reason ??
        NO_DELEGATE_REASONS[effective.status] ??
        effective.status),
    waitCeiling: resolveIssueAuthoringAdversarialWaitCeiling(
      repositoryLocalConfig(options),
    ),
  };
}

interface ParsedArgs {
  policy: string;
  noUserGlobal: boolean;
  help: boolean;
}

function runCli(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const report = buildIssueAuthoringDelegateReport(
    args.policy ? { localPolicyPath: args.policy } : undefined,
    args.noUserGlobal,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(
    argv,
    IDD_ISSUE_AUTHORING_DELEGATE_FLAG_SPEC,
  );
  return {
    policy: (values.policy as string | undefined) ?? '',
    noUserGlobal: values['no-user-global'] as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-issue-authoring-delegate.mjs [--policy <path>] [--no-user-global]

Resolves issueAuthoring.adversarialReview.delegate. A repository-local
object, an explicit null disable, or a malformed value all stop there.
Only when that delegate is entirely absent does an optional user-global
$XDG_CONFIG_HOME/idd-skill/config.json (or
$HOME/.config/idd-skill/config.json) fragment apply. Under
GITHUB_ACTIONS=true the user-global layer is always skipped; pass
--no-user-global to skip it on any other remote surface. waitCeiling is
always the repository-local value (default PT20M) and does not read
critiqueLoop.subagentWaitCeiling. This command does not invoke the
delegate and does not read a branch diff. The configured command is
trusted executable configuration and can transmit the issue-draft data
the caller sends it.

Output schema:
{
  "usable": true,
  "source": "repository-local|user-global|none",
  "command": "..." | null,
  "mode": "fallback|combined|on-success|never" | null,
  "reason": null | "repository-local-explicit-disable|invalid-repository-local-delegate|not-configured",
  "waitCeiling": "PT20M"
}
`);
}
