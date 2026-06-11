#!/usr/bin/env node
// idd-generated-from: src/scripts/phase-id-resolver.mts
//
// The scripts/phase-id-resolver.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.

const DEFAULT_CANONICAL_PHASE_IDS = [
  'A0',
  'A0_O',
  'A0_T',
  'A1',
  'A1_5',
  'A2',
  'A3',
  'A3_5',
  'A4',
  'A4_5',
  'A5',
  'B1',
  'B2',
  'B3',
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'D1',
  'D2',
  'D3',
  'D4',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
  'E8',
  'E9',
  'E10',
  'E11',
  'E12',
  'E13',
  'E14',
  'E15',
  'F1',
  'F2',
  'F2_5',
  'F3',
  'F4',
  'F5',
];

const DEFAULT_LEGACY_ALIASES: Record<string, string[]> = {
  A0_O: ['A0-O', 'A0O'],
  A0_T: ['A0-T', 'A0T'],
  A1_5: ['A1.5', 'A1-5', 'A15'],
  A3_5: ['A3.5', 'A3-5', 'A35'],
  A4_5: ['A4.5', 'A4-5', 'A45'],
  F2_5: ['F2.5', 'F2-5', 'F25'],
};

interface PhaseIdResolution {
  canonicalPhaseId: string;
  matchedBy: string;
  normalizedInput: string;
}

interface PhaseIdResolver {
  canonicalPhaseIds: string[];
  legacyAliasMap: Record<string, string[]>;
  resolve(rawInput: unknown): PhaseIdResolution;
}

interface CreateResolverOptions {
  canonicalPhaseIds?: string[];
  legacyAliases?: Record<string, string[] | string>;
}

if (isCliExecution()) {
  runCli();
}

export function resolvePhaseId(
  input: unknown,
  options: CreateResolverOptions = {},
): PhaseIdResolution {
  const resolver = createPhaseIdResolver(options);
  return resolver.resolve(input);
}

export function createPhaseIdResolver({
  canonicalPhaseIds = DEFAULT_CANONICAL_PHASE_IDS,
  legacyAliases = DEFAULT_LEGACY_ALIASES,
}: CreateResolverOptions = {}): PhaseIdResolver {
  const canonicalByKey = new Map<string, string>();
  const aliasHits = new Map<string, Set<string>>();
  const canonicalOrder: string[] = [];
  const legacyAliasMap: Record<string, string[]> = {};

  for (const candidate of canonicalPhaseIds) {
    const normalized = normalizePhaseIdToken(candidate, { allowEmpty: false });
    if (!isCanonicalToken(normalized)) {
      throw buildResolverError(
        'invalid_canonical_phase_id',
        `Canonical phase ID must be alphanumeric with underscores: ${candidate}`,
      );
    }
    if (canonicalByKey.has(normalized)) {
      continue;
    }
    canonicalByKey.set(normalized, normalized);
    canonicalOrder.push(normalized);
  }

  for (const [canonical, aliases] of Object.entries(legacyAliases ?? {})) {
    const normalizedCanonical = normalizePhaseIdToken(canonical, {
      allowEmpty: false,
    });
    if (!canonicalByKey.has(normalizedCanonical)) {
      throw buildResolverError(
        'unknown_canonical_phase_id',
        `Legacy aliases reference unknown canonical phase ID: ${canonical}`,
      );
    }
    const list = Array.isArray(aliases) ? aliases : [aliases];
    for (const alias of list) {
      const normalizedAlias = normalizeAliasToken(alias);
      if (normalizedAlias === normalizedCanonical) {
        continue;
      }
      const owners = aliasHits.get(normalizedAlias) ?? new Set<string>();
      owners.add(normalizedCanonical);
      aliasHits.set(normalizedAlias, owners);
      if (!legacyAliasMap[normalizedCanonical]) {
        legacyAliasMap[normalizedCanonical] = [];
      }
      if (!legacyAliasMap[normalizedCanonical].includes(normalizedAlias)) {
        legacyAliasMap[normalizedCanonical].push(normalizedAlias);
      }
    }
  }

  const ambiguousAliases = [...aliasHits.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([alias, owners]) => ({
      alias,
      canonicalPhaseIds: [...owners].sort(),
    }));
  if (ambiguousAliases.length > 0) {
    throw buildResolverError(
      'ambiguous_alias_configuration',
      `Legacy alias map contains ambiguous entries: ${ambiguousAliases
        .map((entry) => `${entry.alias}=>${entry.canonicalPhaseIds.join('|')}`)
        .join(', ')}`,
      { ambiguousAliases },
    );
  }

  const aliasToCanonical = new Map<string, string>(
    [...aliasHits.entries()].map(([alias, owners]) => [alias, [...owners][0]]),
  );

  return {
    canonicalPhaseIds: canonicalOrder,
    legacyAliasMap,
    resolve(rawInput: unknown): PhaseIdResolution {
      const aliasInputKey = normalizeAliasToken(rawInput);
      const normalizedInput = normalizePhaseIdToken(rawInput, {
        allowEmpty: false,
      });
      if (!isSupportedInputToken(String(rawInput ?? ''))) {
        throw buildResolverError(
          'invalid_phase_id',
          `Phase ID contains unsupported characters: ${String(rawInput)}`,
        );
      }

      if (
        isCanonicalToken(aliasInputKey) &&
        canonicalByKey.has(aliasInputKey)
      ) {
        return {
          canonicalPhaseId: canonicalByKey.get(aliasInputKey) as string,
          matchedBy: 'canonical',
          normalizedInput,
        };
      }

      const aliasCanonical = aliasToCanonical.get(aliasInputKey);
      if (aliasCanonical) {
        return {
          canonicalPhaseId: aliasCanonical,
          matchedBy: 'legacy-alias',
          normalizedInput,
        };
      }

      throw buildResolverError(
        'unknown_phase_id',
        `Unknown phase ID: ${String(rawInput)} (normalized: ${normalizedInput})`,
        { normalizedInput },
      );
    },
  };
}

export function normalizePhaseIdToken(
  input: unknown,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): string {
  const source = String(input ?? '');
  const normalized = source
    .trim()
    .toUpperCase()
    .replace(/[.\-/:\\\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!allowEmpty && normalized.length === 0) {
    throw buildResolverError('invalid_phase_id', 'Phase ID must not be empty.');
  }
  return normalized;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.phaseId) {
    throw new Error('--phase-id is required');
  }

  const resolver = createPhaseIdResolver();
  const result = resolver.resolve(args.phaseId);
  const output = {
    input: args.phaseId,
    normalizedInput: result.normalizedInput,
    canonicalPhaseId: result.canonicalPhaseId,
    matchedBy: result.matchedBy,
    canonicalPhaseIds: args.verbose ? resolver.canonicalPhaseIds : undefined,
    legacyAliasMap: args.verbose ? resolver.legacyAliasMap : undefined,
  };
  process.stdout.write(`${JSON.stringify(compactObject(output), null, 2)}\n`);
}

function parseArgs(argv: string[]): {
  phaseId: string;
  verbose: boolean;
  help: boolean;
} {
  const parsed = {
    phaseId: '',
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = (): string => {
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--phase-id') {
      parsed.phaseId = requireValue();
      index += 1;
      continue;
    }
    if (token === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: node scripts/phase-id-resolver.mjs --phase-id <value> [--verbose]',
      '',
      'Resolve an IDD phase identifier to its canonical machine-facing ID.',
      'Legacy aliases (e.g. A4.5, A4-5) are normalized to canonical IDs (e.g. A4_5).',
    ].join('\n'),
  );
  process.stdout.write('\n');
}

function isCanonicalToken(token: string): boolean {
  return /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(token);
}

function isSupportedInputToken(rawInput: string): boolean {
  return /^[A-Za-z0-9.\-/:\\_\s]+$/.test(rawInput.trim());
}

function normalizeAliasToken(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function buildResolverError(
  code: string,
  message: string,
  details: unknown = {},
): Error {
  const error = new Error(message) as Error & {
    code: string;
    details: unknown;
  };
  error.code = code;
  error.details = details;
  return error;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = entry;
    }
  }
  return output;
}

function isCliExecution(): boolean {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}
