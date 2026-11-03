#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-effective-config.mts
//
// The scripts/idd-effective-config.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
//
// Read-only policy diagnostic with two modes. The default mode (#3820) prints
// the effective local policy as JSON with the layer each leaf came from, the
// selected user-global override, and any layering diagnostics; it reads only
// local files. The `--trusted-auto-decide` mode (#4958) instead reads the
// repository policy and its schema from a trusted base on GitHub (a pull
// request's base name, or the live default branch) and prints the trusted
// auto-decide verdict for every class; it reads none of the local layers.
// Neither mode writes, claims, posts, or changes any state.

import { parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  deriveRepositoryIdentity,
  type LayeredLocalPolicyLoad,
  loadLayeredLocalPolicy,
  readTrustedAutoDecide,
} from './idd-config.mts';
import { POLICY_DEFAULTS } from './policy-helpers.mts';

// Declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason documented in idd-critique-delegate.mts.
const IDD_EFFECTIVE_CONFIG_FLAG_SPEC = {
  '--no-user-global': { type: 'boolean', default: false },
  '--key': { type: 'string' },
  '--trusted-auto-decide': { type: 'boolean', default: false },
  '--base-ref': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-effective-config', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

export interface EffectiveConfigReport {
  repository: {
    policyPath: string;
    policyExists: boolean;
    policyDiagnostic: string | null;
  };
  userGlobalContributed: boolean;
  selectedOverrideIndex: number | null;
  config: Record<string, unknown> | null;
  sourceMap: LayeredLocalPolicyLoad['sourceMap'];
  diagnostics: string[];
}

export interface EffectiveConfigKeyReport {
  key: string;
  found: boolean;
  value: unknown;
  /** The layer the value came from, or `null` when it is absent or mixed. */
  source: string | null;
  /** Every distinct layer beneath the key, sorted; empty when absent. */
  sources: string[];
}

/** Build the full report from a loaded layered policy. */
export function buildEffectiveConfigReport(
  loaded: LayeredLocalPolicyLoad,
  policyPath: string,
): EffectiveConfigReport {
  return {
    repository: {
      policyPath,
      policyExists: loaded.local.exists,
      policyDiagnostic: loaded.local.diagnostic ?? null,
    },
    userGlobalContributed: loaded.userGlobalContributed,
    selectedOverrideIndex: loaded.selectedOverrideIndex,
    config: loaded.config,
    sourceMap: loaded.sourceMap,
    diagnostics: loaded.diagnostics,
  };
}

/**
 * Read one dotted path (for example `reviewPolicy` or `critiqueLoop.delegate`)
 * from the effective config, with the layer that supplied it. A path with no
 * value reports `found: false` and a null source rather than an error.
 */
export function buildEffectiveConfigKeyReport(
  loaded: LayeredLocalPolicyLoad,
  key: string,
): EffectiveConfigKeyReport {
  let value: unknown = loaded.config;
  for (const segment of key.split('.')) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return { key, found: false, value: null, source: null, sources: [] };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  const sources = layersBeneath(loaded.sourceMap, key);
  return {
    key,
    found: true,
    value,
    source: sources.length === 1 ? (sources[0] ?? null) : null,
    sources,
  };
}

/**
 * The distinct layers that supplied a dotted key. The source map is keyed by
 * leaf, so an object-valued key has no entry of its own: its layers are the
 * layers of the leaves beneath it, and a single shared layer is the answer.
 */
function layersBeneath(
  sourceMap: LayeredLocalPolicyLoad['sourceMap'],
  key: string,
): string[] {
  const direct = sourceMap[key];
  if (direct !== undefined) return [direct];
  const prefix = `${key}.`;
  const layers = new Set<string>();
  for (const [path, layer] of Object.entries(sourceMap)) {
    if (path.startsWith(prefix)) layers.add(layer);
  }
  return [...layers].sort();
}

function runCli(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.trustedAutoDecide || args.trustedOnlyFlagGiven) {
    return runTrustedAutoDecide(args);
  }
  const loaded = loadLayeredLocalPolicy({
    noUserGlobal: args.noUserGlobal,
    defaults: POLICY_DEFAULTS,
  });
  const report =
    args.key === ''
      ? buildEffectiveConfigReport(loaded, '.github/idd/config.json')
      : buildEffectiveConfigKeyReport(loaded, args.key);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function usage(message: string): HelperCliResult {
  process.stderr.write(`idd-effective-config: ${message}\n`);
  return { exitCode: 2, kind: 'usage', message, httpStatus: null };
}

/**
 * The `--trusted-auto-decide` mode (#4958). Every usage check runs before any
 * read. The repository comes from `--owner`/`--repo`, else from the
 * checkout's GitHub `origin`; the local policy layers are never read. An
 * unreadable report is printed and exits 1 so a caller cannot mistake it for
 * a verdict.
 */
function runTrustedAutoDecide(args: ParsedArgs): HelperCliResult {
  if (!args.trustedAutoDecide) {
    return usage(
      '--base-ref, --owner, and --repo are accepted only with --trusted-auto-decide',
    );
  }
  if (args.keyGiven) {
    return usage(
      '--key cannot be combined with --trusted-auto-decide: the trusted mode reads no local layer',
    );
  }
  if (args.noUserGlobal) {
    return usage(
      '--no-user-global cannot be combined with --trusted-auto-decide: the trusted mode never reads the user-global layers',
    );
  }
  if (args.baseRef !== undefined && args.baseRef.trim() === '') {
    return usage(
      '--base-ref must name the pull request base branch; omit it to read the live default branch',
    );
  }
  const owner = args.owner?.trim() ?? '';
  const repo = args.repo?.trim() ?? '';
  if (args.owner !== undefined || args.repo !== undefined) {
    if (owner === '' || repo === '') {
      return usage('--owner and --repo must be given together, both non-empty');
    }
  }
  let target = { owner, repo };
  if (owner === '') {
    let slug: string | null = null;
    try {
      slug = deriveRepositoryIdentity({ cwd: process.cwd() }).githubSlug;
    } catch {
      slug = null;
    }
    const [slugOwner, slugRepo] = slug?.split('/') ?? [];
    if (!slugOwner || !slugRepo) {
      return usage(
        'cannot resolve the repository from this checkout\'s GitHub "origin" remote; pass --owner and --repo',
      );
    }
    target = { owner: slugOwner, repo: slugRepo };
  }
  const report = readTrustedAutoDecide({
    owner: target.owner,
    repo: target.repo,
    baseRefName: args.baseRef?.trim() ?? '',
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'unreadable') {
    return {
      exitCode: 1,
      kind: 'gate',
      message: `trusted auto-decide policy is unreadable: ${report.error ?? 'unknown error'}`,
      httpStatus: null,
    };
  }
  return 0;
}

interface ParsedArgs {
  noUserGlobal: boolean;
  key: string;
  /** Whether `--key` was passed at all, even with an empty value. */
  keyGiven: boolean;
  trustedAutoDecide: boolean;
  /** Whether `--base-ref`, `--owner`, or `--repo` was passed. */
  trustedOnlyFlagGiven: boolean;
  baseRef: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, IDD_EFFECTIVE_CONFIG_FLAG_SPEC);
  const optional = (name: string): string | undefined =>
    values[name] as string | undefined;
  const baseRef = optional('base-ref');
  const owner = optional('owner');
  const repo = optional('repo');
  return {
    noUserGlobal: values['no-user-global'] as boolean,
    key: (values.key as string | undefined) ?? '',
    keyGiven: values.key !== undefined,
    trustedAutoDecide: values['trusted-auto-decide'] as boolean,
    trustedOnlyFlagGiven:
      baseRef !== undefined || owner !== undefined || repo !== undefined,
    baseRef,
    owner,
    repo,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-effective-config.mjs [--key <dotted.path>] [--no-user-global]
  node scripts/idd-effective-config.mjs --trusted-auto-decide [--base-ref <name>] [--owner <owner> --repo <repo>]

Prints the effective local policy as JSON, with the layer each leaf came from
(repository, user-global override, user-global, or default), the selected
user-global override index, and layering diagnostics. Read-only.

  --key <dotted.path>  print only that value and its source layer
  --no-user-global     skip the user-global layers entirely

A local --key value, such as --key dangerouslyAutoDecide or a key under
autoDecide, is a diagnostic of this checkout and never authority.

--trusted-auto-decide reads .github/idd/config.json and
schemas/policy.schema.json from a trusted base on GitHub, validates the
document, and prints the master switch and each auto-decide class verdict
(enabled, master-off, class-off, or unreadable) as JSON. It reads none of the
local layers, so it rejects --key and --no-user-global. Read-only; exits 1
when the report is unreadable (the report is still printed) and 2 on a usage
error the mode detects. A flag that cannot be parsed exits 1 with nothing on
stdout.

  --base-ref <name>    the pull request base branch name; never a head or
                       feature ref. Omit it to read the live default branch.
  --owner <owner>      repository owner; give it with --repo
  --repo <repo>        repository name. Without both, the repository comes
                       from this checkout's GitHub "origin" remote; in a fork
                       checkout, pass both for the base repository.
`);
}
