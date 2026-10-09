#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-effective-config.mts
//
// The scripts/idd-effective-config.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
//
// Read-only diagnostic for the layered policy (#3820). It prints the effective
// local policy as JSON with the layer each leaf came from, the selected
// user-global override, and any layering diagnostics. It never writes, claims,
// posts, or changes any state, so it is safe to run anywhere.

import { parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  type LayeredLocalPolicyLoad,
  loadLayeredLocalPolicy,
} from './idd-config.mts';
import { POLICY_DEFAULTS } from './policy-helpers.mts';

// Declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason documented in idd-critique-delegate.mts.
const IDD_EFFECTIVE_CONFIG_FLAG_SPEC = {
  '--no-user-global': { type: 'boolean', default: false },
  '--key': { type: 'string' },
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

interface ParsedArgs {
  noUserGlobal: boolean;
  key: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, IDD_EFFECTIVE_CONFIG_FLAG_SPEC);
  return {
    noUserGlobal: values['no-user-global'] as boolean,
    key: (values.key as string | undefined) ?? '',
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-effective-config.mjs [--key <dotted.path>] [--no-user-global]

Prints the effective local policy as JSON, with the layer each leaf came from
(repository, user-global override, user-global, or default), the selected
user-global override index, and layering diagnostics. Read-only.

  --key <dotted.path>  print only that value and its source layer
  --no-user-global     skip the user-global layers entirely
`);
}
