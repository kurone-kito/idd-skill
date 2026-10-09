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
import { parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadLayeredLocalPolicy } from './idd-config.mjs';

// Declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason documented in idd-critique-delegate.mts.
const IDD_EFFECTIVE_CONFIG_FLAG_SPEC = {
  '--no-user-global': { type: 'boolean', default: false },
  '--key': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-effective-config', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
/** Build the full report from a loaded layered policy. */
export function buildEffectiveConfigReport(loaded, policyPath) {
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
export function buildEffectiveConfigKeyReport(loaded, key) {
  let value = loaded.config;
  for (const segment of key.split('.')) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return { key, found: false, value: null, source: null };
    }
    value = value[segment];
  }
  return {
    key,
    found: true,
    value,
    source: loaded.sourceMap[key] ?? null,
  };
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const loaded = loadLayeredLocalPolicy({ noUserGlobal: args.noUserGlobal });
  const report =
    args.key === ''
      ? buildEffectiveConfigReport(loaded, '.github/idd/config.json')
      : buildEffectiveConfigKeyReport(loaded, args.key);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, IDD_EFFECTIVE_CONFIG_FLAG_SPEC);
  return {
    noUserGlobal: values['no-user-global'],
    key: values.key ?? '',
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-effective-config.mjs [--key <dotted.path>] [--no-user-global]

Prints the effective local policy as JSON, with the layer each leaf came from
(repository, user-global override, user-global, or default), the selected
user-global override index, and layering diagnostics. Read-only.

  --key <dotted.path>  print only that value and its source layer
  --no-user-global     skip the user-global layers entirely
`);
}
