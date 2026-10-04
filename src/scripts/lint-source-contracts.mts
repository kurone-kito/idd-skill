// idd-generated-from: src/scripts/lint-source-contracts.mts
//
// This local audit owns static source contracts that used to run only inside
// tests. It is intentionally limited to filesystem reads and pure detectors;
// it makes no GitHub, Git, or subprocess calls.

// #3240: keep the runtime check first so an unsupported Node version fails
// loudly before import.meta.main is evaluated.
import './node-runtime-guard.mts';

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mts';

export interface SourceText {
  path: string;
  name: string;
  text: string;
}

export interface ContractViolation {
  ruleId: string;
  path: string;
  message: string;
}

const ENTRY_GUARD =
  /^if \(.*(?:isMainModule\(|isCliExecution\(|process\.argv\[1\]|import\.meta\.main).*\)\s*\{/;

const MODULE_LEVEL_BINDING = /^(?:export )?(?:const(?!\s+enum\b)|let|var)\b/;

export const GUARD_FILE_NAME = 'node-runtime-guard.mts';
export const STANDALONE_GUARD_DUPLICATE_EXEMPTIONS = [
  'minimize-superseded-markers.mts',
] as const;

interface FlagConcept {
  concept: string;
  canonical: string;
  deprecated?: string;
  helpers: readonly string[];
  deprecatedScanExclude?: readonly string[];
}

const FLAG_CONCEPTS: readonly FlagConcept[] = [
  {
    concept: 'claim id',
    canonical: '--claim-id',
    deprecated: '--expected-claim-id',
    helpers: [
      'advisory-wait-state.mjs',
      'audit-pr-cleanup.mjs',
      'external-check-waiver.mjs',
      'idd-merge-execute.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
      'resume-claim-routing.mjs',
    ],
    deprecatedScanExclude: ['idd-merge-execute.mjs'],
  },
  {
    concept: 'agent id',
    canonical: '--agent-id',
    deprecated: '--expected-agent-id',
    helpers: [
      'advisory-wait-state.mjs',
      'audit-pr-cleanup.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
    ],
  },
  {
    concept: 'pull request number',
    canonical: '--pr',
    helpers: [
      'advisory-convergence.mjs',
      'advisory-wait-state.mjs',
      'audit-pr-cleanup.mjs',
      'branch-conflict-state.mjs',
      'discover-orphan-filter.mjs',
      'external-check-waiver.mjs',
      'forced-handoff-marker.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
      'review-activity-snapshot.mjs',
      'stalled-session-quiet-check.mjs',
    ],
  },
  {
    concept: 'trusted marker logins',
    canonical: '--trusted-marker-logins',
    helpers: [
      'advisory-convergence.mjs',
      'advisory-wait-state.mjs',
      'forced-handoff-marker.mjs',
      'minimize-superseded-markers.mjs',
      'pre-merge-readiness.mjs',
      'resume-claim-routing.mjs',
      'review-activity-snapshot.mjs',
    ],
  },
  {
    concept: 'IDD agent logins',
    canonical: '--idd-agent-logins',
    helpers: ['pre-merge-readiness.mjs'],
  },
  {
    concept: 'advisory bot logins',
    canonical: '--advisory-bot-logins',
    helpers: [
      'advisory-convergence.mjs',
      'pre-merge-readiness.mjs',
      'review-activity-snapshot.mjs',
    ],
  },
  {
    concept: 'GitHub auth token',
    canonical: '--gh-token',
    deprecated: '--token',
    helpers: [
      'claim-approval-gate.mjs',
      'resume-claim-routing.mjs',
      'resume-route-selection.mjs',
      'stalled-session-quiet-check.mjs',
      'suitability-triage.mjs',
    ],
    deprecatedScanExclude: ['select-desynced-index.mjs'],
  },
];

const NEAR_MISS_VARIANTS = [
  { variant: '--pr-number', canonical: '--pr' },
  { variant: '--pull-request', canonical: '--pr' },
  { variant: '--trusted-actors', canonical: '--trusted-marker-logins' },
  { variant: '--agent-logins', canonical: '--idd-agent-logins' },
  { variant: '--bot-logins', canonical: '--advisory-bot-logins' },
] as const;

const EXPECTED_HINT_HOOKS: Readonly<Record<string, readonly [string, number]>> =
  {
    'post-idd-marker.mts': ['invalidateDiscoverHints(', 1],
    'idd-merge-execute.mts': ['invalidateDiscoverHints(', 2],
    'idd-roadmap-audit-execute.mts': ['invalidateDiscoverHints(', 2],
    'suitability-close-execute.mts': ['invalidateDiscoverHints(', 2],
    'force-handoff.mts': ['invalidateHints(', 2],
  };

const EXPECTED_HINT_READERS = [
  'discover-orphan-filter.mts',
  'discover-roadmap-graph.mts',
] as const;

const EXPECTED_HINT_IMPORTERS = [
  'discover-orphan-filter.mts',
  'discover-roadmap-graph.mts',
  'force-handoff.mts',
  'idd-merge-execute.mts',
  'idd-roadmap-audit-execute.mts',
  'post-idd-marker.mts',
  'suitability-close-execute.mts',
] as const;

/**
 * Matches a quoted flag literal independent of quote style.
 * This intentionally mirrors the former flag-name-matrix test.
 */
function includesQuotedFlag(source: string, flag: string): boolean {
  return source.includes(`'${flag}'`) || source.includes(`"${flag}"`);
}

/** Pure detector for initialized top-level bindings after a CLI entry block. */
export function findModuleEvalOrderViolations(
  files: readonly { path: string; text: string }[],
): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/);
    const entryIndex = lines.findIndex((line) => ENTRY_GUARD.test(line));
    if (entryIndex < 0) continue;
    for (let i = entryIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (
        MODULE_LEVEL_BINDING.test(line) &&
        /(?<![=!<>])=(?![=>])/.test(line)
      ) {
        violations.push(
          `${path}:${i + 1}: module-level binding initialized after the CLI entry ` +
            `block (opened at line ${entryIndex + 1}) — top-level-await TDZ risk; ` +
            `declare it above the block. Offending line: ${line.trim()}`,
        );
      }
    }
  }
  return violations;
}

/** Static import/export-from specifiers only; dynamic imports are too late. */
export function findStaticRelativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  const pattern =
    /\b(?:import|export)\s+(?:[^"'\x60]+\s+from\s+)?["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  return [...specifiers];
}

/** Pure BFS over a flat module inventory, matching the former test guard. */
export function findGuardUnreachableEntries(
  files: ReadonlyMap<string, string>,
  entryNames: readonly string[],
  guardName = GUARD_FILE_NAME,
): string[] {
  return entryNames.filter((entry) => !reachesGuard(entry));

  function reachesGuard(start: string): boolean {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === guardName) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const text = files.get(current);
      if (text === undefined) continue;
      for (const specifier of findStaticRelativeImports(text)) {
        const basename = specifier.split('/').pop();
        if (basename) queue.push(basename);
      }
    }
    return false;
  }
}

function violation(
  ruleId: string,
  path: string,
  message: string,
): ContractViolation {
  return { ruleId, path, message };
}

function detectEntryContracts(
  files: readonly SourceText[],
): ContractViolation[] {
  const result: ContractViolation[] = [];
  if (files.length === 0) {
    return [
      violation(
        'SOURCE-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected at least one .mts helper source',
      ),
    ];
  }

  for (const message of findModuleEvalOrderViolations(files)) {
    const separator = message.indexOf(':');
    const path = message.slice(0, separator);
    result.push(
      violation('CLI-ENTRY-ORDER', path, message.slice(separator + 1).trim()),
    );
  }

  const byName = new Map(files.map(({ name, text }) => [name, text]));
  const entryNames = files
    .filter(({ text }) =>
      text.split(/\r?\n/).some((line) => ENTRY_GUARD.test(line)),
    )
    .map(({ name }) => name);
  if (entryNames.length === 0) {
    result.push(
      violation(
        'CLI-ENTRY-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected at least one CLI entry-block helper',
      ),
    );
  }
  if (!byName.has(GUARD_FILE_NAME)) {
    result.push(
      violation(
        'RUNTIME-GUARD-PRESENT',
        `src/scripts/${GUARD_FILE_NAME}`,
        'runtime guard source is missing from the scanned inventory',
      ),
    );
  }
  const scannedEntryNames = entryNames.filter(
    (name) =>
      !STANDALONE_GUARD_DUPLICATE_EXEMPTIONS.includes(
        name as (typeof STANDALONE_GUARD_DUPLICATE_EXEMPTIONS)[number],
      ),
  );
  const unreachable = findGuardUnreachableEntries(
    byName,
    scannedEntryNames,
    GUARD_FILE_NAME,
  );
  for (const name of unreachable) {
    result.push(
      violation(
        'RUNTIME-GUARD-REACHABILITY',
        `src/scripts/${name}`,
        `entry-block helper does not statically reach ${GUARD_FILE_NAME}`,
      ),
    );
  }
  for (const name of STANDALONE_GUARD_DUPLICATE_EXEMPTIONS) {
    const text = byName.get(name);
    if (text === undefined) {
      result.push(
        violation(
          'RUNTIME-GUARD-STANDALONE-EXEMPTION',
          `src/scripts/${name}`,
          'documented standalone exemption is missing',
        ),
      );
      continue;
    }
    if (!/typeof import\.meta\.main\s*!==\s*'boolean'/.test(text)) {
      result.push(
        violation(
          'RUNTIME-GUARD-STANDALONE-EXEMPTION',
          `src/scripts/${name}`,
          'standalone helper must retain its inlined import.meta.main guard',
        ),
      );
    }
    if (!/\^22\.23\.2 \|\| \^24\.2\.0 \|\| >=26\.0\.0/.test(text)) {
      result.push(
        violation(
          'RUNTIME-GUARD-STANDALONE-EXEMPTION',
          `src/scripts/${name}`,
          'inlined guard message must retain the engines.node range literal',
        ),
      );
    }
  }
  return result;
}

function detectDiscoverHintContracts(
  files: readonly SourceText[],
): ContractViolation[] {
  const result: ContractViolation[] = [];
  // This local audit contains the matcher spellings below; it is not a
  // production helper whose cache access should enter the enrolled set.
  const enrolledFiles = files.filter(
    ({ name }) => name !== 'lint-source-contracts.mts',
  );
  const byName = new Map(enrolledFiles.map(({ name, text }) => [name, text]));
  if (files.length === 0) {
    return [
      violation(
        'SOURCE-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected helper sources for Discover hint contracts',
      ),
    ];
  }

  const mutatorPattern =
    /\.(?:closeWorkItem|mergeChangeRequest(?:Admin)?AtRepo)\(/;
  let mutatorCount = 0;
  for (const { name, path, text } of enrolledFiles) {
    if (name.startsWith('provider-')) continue;
    if (!mutatorPattern.test(text)) continue;
    mutatorCount += 1;
    if (!text.includes('invalidateDiscoverHints(')) {
      result.push(
        violation(
          'DISCOVER-HINT-MUTATOR-INVALIDATION',
          path,
          'mutating helper path must invalidate Discover hints',
        ),
      );
    }
  }
  if (mutatorCount === 0) {
    result.push(
      violation(
        'DISCOVER-HINT-MUTATOR-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected at least one scanned close or merge helper path',
      ),
    );
  }

  for (const [name, [token, expectedCount]] of Object.entries(
    EXPECTED_HINT_HOOKS,
  )) {
    const text = byName.get(name);
    if (text === undefined) {
      result.push(
        violation(
          'DISCOVER-HINT-HOOK-COUNT',
          `src/scripts/${name}`,
          `expected ${expectedCount} occurrence(s) of ${token}; source is missing`,
        ),
      );
      continue;
    }
    const actualCount = text.split(token).length - 1;
    if (actualCount !== expectedCount) {
      result.push(
        violation(
          'DISCOVER-HINT-HOOK-COUNT',
          `src/scripts/${name}`,
          `expected ${expectedCount} occurrence(s) of ${token}, found ${actualCount}`,
        ),
      );
    }
  }

  const readers: string[] = [];
  const importers: string[] = [];
  for (const { name, text } of enrolledFiles) {
    if (name === 'discover-hint-cache.mts') continue;
    if (/\breadDiscoverHint\b/.test(text)) readers.push(name);
    if (text.includes("from './discover-hint-cache.mts'")) importers.push(name);
  }
  readers.sort();
  importers.sort();
  if (readers.length === 0) {
    result.push(
      violation(
        'DISCOVER-HINT-READER-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected at least one helper that reads Discover hints',
      ),
    );
  }
  if (importers.length === 0) {
    result.push(
      violation(
        'DISCOVER-HINT-IMPORTER-INVENTORY-NONEMPTY',
        'src/scripts/',
        'expected at least one helper that imports the Discover hint layer',
      ),
    );
  }
  if (JSON.stringify(readers) !== JSON.stringify(EXPECTED_HINT_READERS)) {
    result.push(
      violation(
        'DISCOVER-HINT-READER-ALLOWLIST',
        'src/scripts/',
        `expected readers [${EXPECTED_HINT_READERS.join(', ')}], found [${readers.join(', ')}]`,
      ),
    );
  }
  if (JSON.stringify(importers) !== JSON.stringify(EXPECTED_HINT_IMPORTERS)) {
    result.push(
      violation(
        'DISCOVER-HINT-IMPORTER-ALLOWLIST',
        'src/scripts/',
        `expected importers [${EXPECTED_HINT_IMPORTERS.join(', ')}], found [${importers.join(', ')}]`,
      ),
    );
  }
  return result;
}

function detectFlagContracts(
  files: readonly SourceText[],
): ContractViolation[] {
  const result: ContractViolation[] = [];
  const helperFiles = files.filter(
    ({ name }) => name !== 'lint-source-contracts.mjs',
  );
  if (helperFiles.length === 0) {
    return [
      violation(
        'HELPER-INVENTORY-NONEMPTY',
        'scripts/',
        'expected at least one generated helper .mjs file',
      ),
    ];
  }
  const byName = new Map(helperFiles.map(({ name, text }) => [name, text]));
  const relativePath = (name: string) => `scripts/${name}`;

  for (const {
    concept,
    canonical,
    deprecated,
    helpers,
    deprecatedScanExclude,
  } of FLAG_CONCEPTS) {
    for (const helper of helpers) {
      const source = byName.get(helper);
      if (source === undefined) {
        result.push(
          violation(
            'CLI-FLAG-HELPER-PRESENT',
            relativePath(helper),
            `required ${concept} helper is missing`,
          ),
        );
      } else if (!includesQuotedFlag(source, canonical)) {
        result.push(
          violation(
            'CLI-FLAG-CANONICAL',
            relativePath(helper),
            `must expose canonical flag ${canonical} for ${concept}`,
          ),
        );
      }
    }
    if (!deprecated) continue;
    for (const { name, text } of helperFiles) {
      if (deprecatedScanExclude?.includes(name)) continue;
      if (!includesQuotedFlag(text, deprecated)) continue;
      if (!includesQuotedFlag(text, canonical)) {
        result.push(
          violation(
            'CLI-FLAG-DEPRECATED-PAIR',
            relativePath(name),
            `accepts ${deprecated} without canonical ${canonical}`,
          ),
        );
      }
      if (
        !text.includes(`warnDeprecatedFlag('${deprecated}'`) &&
        !text.includes(`warnDeprecatedFlag("${deprecated}"`)
      ) {
        result.push(
          violation(
            'CLI-FLAG-DEPRECATION-WARNING',
            relativePath(name),
            `must route ${deprecated} through warnDeprecatedFlag()`,
          ),
        );
      }
      if (
        !/function warnDeprecatedFlag[\s\S]*?process\.stderr\.write/.test(text)
      ) {
        result.push(
          violation(
            'CLI-FLAG-DEPRECATION-WARNING',
            relativePath(name),
            'warnDeprecatedFlag() must write its warning to stderr',
          ),
        );
      }
    }
  }

  for (const { name, text } of helperFiles) {
    for (const { variant, canonical } of NEAR_MISS_VARIANTS) {
      if (
        includesQuotedFlag(text, variant) &&
        !includesQuotedFlag(text, canonical)
      ) {
        result.push(
          violation(
            'CLI-FLAG-NEAR-MISS',
            relativePath(name),
            `quotes ${variant}; use canonical ${canonical} (or accept both)`,
          ),
        );
      }
    }
  }

  const readiness = byName.get('pre-merge-readiness.mjs');
  const readinessFlags = [
    '--claim-id',
    '--agent-id',
    '--expected-claim-id',
    '--expected-agent-id',
  ];
  if (readiness === undefined) {
    result.push(
      violation(
        'CLI-FLAG-PRE-MERGE-ALIASES',
        'scripts/pre-merge-readiness.mjs',
        'pre-merge-readiness helper is missing',
      ),
    );
  } else {
    for (const flag of readinessFlags) {
      if (!includesQuotedFlag(readiness, flag)) {
        result.push(
          violation(
            'CLI-FLAG-PRE-MERGE-ALIASES',
            'scripts/pre-merge-readiness.mjs',
            `must accept ${flag}`,
          ),
        );
      }
    }
  }
  return result;
}

function readInventory(
  root: string,
  directory: string,
  extension: string,
): { files: SourceText[]; errors: ContractViolation[] } {
  const absoluteDirectory = join(root, directory);
  let names: string[];
  try {
    names = readdirSync(absoluteDirectory)
      .filter((name) => name.endsWith(extension))
      .sort();
  } catch (error) {
    return {
      files: [],
      errors: [
        violation(
          'SOURCE-INVENTORY-READABLE',
          directory,
          `cannot inspect inventory: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const files: SourceText[] = [];
  const errors: ContractViolation[] = [];
  for (const name of names) {
    const path = `${directory}/${name}`;
    try {
      files.push({
        name,
        path,
        text: readFileSync(join(absoluteDirectory, name), 'utf8'),
      });
    } catch (error) {
      errors.push(
        violation(
          'SOURCE-INVENTORY-READABLE',
          path,
          `cannot read source: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return { files, errors };
}

/** Read the bounded repository inventories and run all pure source detectors. */
export function collectSourceContractViolations(
  root: string,
): ContractViolation[] {
  const source = readInventory(root, 'src/scripts', '.mts');
  const generated = readInventory(root, 'scripts', '.mjs');
  const violations = [
    ...source.errors,
    ...generated.errors,
    ...detectEntryContracts(source.files),
    ...detectDiscoverHintContracts(source.files),
    ...detectFlagContracts(generated.files),
  ];
  return violations.sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      a.path.localeCompare(b.path) ||
      a.message.localeCompare(b.message),
  );
}

function parseRootArg(argv: readonly string[]): {
  root: string;
  help: boolean;
} {
  let root = resolveBundleRoot(import.meta.dirname);
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a directory path');
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { root, help };
}

export function main(argv = process.argv.slice(2)): number {
  let parsed: { root: string; help: boolean };
  try {
    parsed = parseRootArg(argv);
  } catch (error) {
    process.stderr.write(
      `lint-source-contracts: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(
      'Usage: node scripts/lint-source-contracts.mjs [--root <repository>] [--help]\n',
    );
    return 0;
  }

  const violations = collectSourceContractViolations(parsed.root);
  if (violations.length > 0) {
    for (const item of violations) {
      process.stderr.write(`${item.ruleId} ${item.path}: ${item.message}\n`);
    }
    process.stderr.write(
      `lint-source-contracts: ${violations.length} violation(s)\n`,
    );
    return 1;
  }
  process.stdout.write('lint-source-contracts: all source contracts passed\n');
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
