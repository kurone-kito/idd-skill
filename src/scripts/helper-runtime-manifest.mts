#!/usr/bin/env node
// idd-generated-from: src/scripts/helper-runtime-manifest.mts
//
// The scripts/helper-runtime-manifest.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package root by walking up to the nearest package.json.
// This is location-independent, so it returns the same root whether this
// module runs as the emitted scripts/helper-runtime-manifest.mjs (one
// level deep), the src/scripts/helper-runtime-manifest.mts source under
// Node type-stripping (two levels deep), or is imported by another
// module — a fixed `..` from import.meta.url would resolve to src/ for
// the source.
function resolveRepoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = resolveRepoRoot(import.meta.url);

interface HelperCommand {
  id: string;
  scriptName: string;
  binName: string;
  entryPath: string;
  vendoredCommand: string;
  description: string;
  contractPaths?: string[];
}

interface ManagedFile {
  sourcePath: string;
  targetPath: string;
}

interface PackageMetadata {
  name: string;
  repository: string;
  nodeEngines: string;
}

interface LockfileMatch {
  filename: string;
  manager: string;
}

interface RuntimeEvidence {
  hasPackageJson: boolean;
  declaredPackageManager: string;
  lockfileMatches: LockfileMatch[];
  detectedPackageManager: string;
  packageJsonOnly: boolean;
  ambiguousPackageManager: boolean;
}

interface Recommendation {
  profile: string;
  packageManager: string;
  reason: string;
  evidence: RuntimeEvidence;
}

interface ProfileEntry {
  profile: string;
  description: string;
  packageManager: string;
  installCommand: string;
  managedDependencies: { devDependencies: Record<string, string> };
  managedPackageJsonScripts: Record<string, string>;
  managedFiles: ManagedFile[];
  commands: Record<string, string>;
  notes: string[];
  // Only the vendored-node profile vends files into the adopter
  // repository, so only it recommends `<path> linguist-vendored`
  // .gitattributes lines (one per managed file). Other profiles omit
  // this field entirely.
  recommendedGitattributes?: string[];
}

interface ManifestArgs {
  help: boolean;
  profile: string;
  fromProfile: string;
  packageManager: string;
  packageSpec: string;
  targetRoot: string;
}

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'];
const PROFILE_NAMES = [
  'package-manager',
  'vendored-node',
  'ephemeral-npx',
  'instructions-only',
];
const PACKAGE_NAME = '@kurone-kito/idd-skill';
const DEFAULT_PACKAGE_SPEC =
  'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/refs/heads/main';
const SOURCE_REPOSITORY = 'github:kurone-kito/idd-skill';
const PACKAGE_SPEC_PIN_HINT =
  'Pass --package-spec with a pinned tarball URL or reviewed commit archive when you need reproducible helper imports.';
const NODE_ENGINES = '^22.22.2 || >=24';
const SCRIPT_FILE_EXTENSIONS = ['.mjs', '.js', '.json'];
// Runtime data files a helper reads at execution time (not via `import`),
// so the import-graph walk cannot discover them. A consumer that vendors
// exactly `managedFiles` must still receive these or the helper crashes on a
// missing path. The drift guard in tests/helper-runtime-manifest.test.mts
// asserts the vendored-node managedFiles include every data path
// validate-schemas references, so this list must stay complete.
const EXTRA_RUNTIME_FILES = new Map<string, string[]>([
  ['scripts/advisory-wait-policy.mjs', ['schemas/policy.schema.json']],
  // validate-schemas validates every schema/fixture pair in its CLI `cases`
  // table by reading the files directly; none of them are imported.
  [
    'scripts/validate-schemas.mjs',
    [
      'schemas/advisory-wait-state.schema.json',
      'schemas/claim-marker.schema.json',
      'schemas/forced-handoff-marker.schema.json',
      'schemas/idd-merge-execute.schema.json',
      'schemas/live-status-digest.schema.json',
      'schemas/phase-graph.json',
      'schemas/phase-graph.schema.json',
      'schemas/policy.schema.json',
      'schemas/pre-merge-readiness.schema.json',
      'fixtures/schemas/advisory-wait-state.invalid.json',
      'fixtures/schemas/advisory-wait-state.valid.json',
      'fixtures/schemas/claim-marker.invalid.json',
      'fixtures/schemas/claim-marker.valid.json',
      'fixtures/schemas/forced-handoff-marker.invalid.json',
      'fixtures/schemas/forced-handoff-marker.valid.json',
      'fixtures/schemas/idd-merge-execute.invalid.json',
      'fixtures/schemas/idd-merge-execute.valid.json',
      'fixtures/schemas/live-status-digest.invalid.json',
      'fixtures/schemas/live-status-digest.valid.json',
      'fixtures/schemas/phase-graph.invalid.json',
      'fixtures/schemas/phase-graph.valid.json',
      'fixtures/schemas/policy.invalid.json',
      'fixtures/schemas/policy.valid.json',
      'fixtures/schemas/pre-merge-readiness.invalid.json',
      'fixtures/schemas/pre-merge-readiness.valid.json',
    ],
  ],
]);

const HELPER_COMMANDS: HelperCommand[] = [
  {
    id: 'advisory-wait-state',
    scriptName: 'idd:advisory-wait-state',
    binName: 'idd-advisory-wait-state',
    entryPath: 'scripts/advisory-wait-state.mjs',
    vendoredCommand: 'node scripts/advisory-wait-state.mjs',
    description:
      'Collect advisory-wait state without mutating PR review state.',
    contractPaths: ['schemas/advisory-wait-state.schema.json'],
  },
  {
    id: 'audit-pr-cleanup',
    scriptName: 'idd:audit-pr-cleanup',
    binName: 'idd-audit-pr-cleanup',
    entryPath: 'scripts/audit-pr-cleanup.mjs',
    vendoredCommand: 'node scripts/audit-pr-cleanup.mjs',
    description: 'Audit or apply post-merge comment cleanup.',
  },
  {
    id: 'branch-conflict-state',
    scriptName: 'idd:branch-conflict-state',
    binName: 'idd-branch-conflict-state',
    entryPath: 'scripts/branch-conflict-state.mjs',
    vendoredCommand: 'node scripts/branch-conflict-state.mjs',
    description:
      'Collect read-only branch conflict and synchronization state evidence for a PR.',
    contractPaths: ['schemas/branch-conflict-state.schema.json'],
  },
  {
    id: 'branch-name',
    scriptName: 'idd:branch-name',
    binName: 'idd-branch-name',
    entryPath: 'scripts/branch-name.mjs',
    vendoredCommand: 'node scripts/branch-name.mjs',
    description:
      'Compute the canonical A5(e) issue/<number>-<slug> branch name from an issue number and title.',
  },
  {
    id: 'ci-wait-policy',
    scriptName: 'idd:ci-wait-policy',
    binName: 'idd-ci-wait-policy',
    entryPath: 'scripts/ci-wait-policy.mjs',
    vendoredCommand: 'node scripts/ci-wait-policy.mjs',
    description:
      'Resolve shared ciWait defaults and deterministic rerun-budget decisions.',
    contractPaths: ['schemas/policy.schema.json'],
  },
  {
    id: 'claim-approval-gate',
    scriptName: 'idd:claim-approval-gate',
    binName: 'idd-claim-approval-gate',
    entryPath: 'scripts/claim-approval-gate.mjs',
    vendoredCommand: 'node scripts/claim-approval-gate.mjs',
    description:
      'Evaluate the A5(a) issue-author approval gate against issue state.',
  },
  {
    id: 'discover-orphan-filter',
    scriptName: 'idd:discover-orphan-filter',
    binName: 'idd-discover-orphan-filter',
    entryPath: 'scripts/discover-orphan-filter.mjs',
    vendoredCommand: 'node scripts/discover-orphan-filter.mjs',
    description:
      'Classify open issues into orphan candidates and filtered buckets.',
  },
  {
    id: 'discover-readiness-check',
    scriptName: 'idd:discover-readiness-check',
    binName: 'idd-discover-readiness-check',
    entryPath: 'scripts/discover-readiness-check.mjs',
    vendoredCommand: 'node scripts/discover-readiness-check.mjs',
    description:
      'Collect read-only A3 readiness filtering evidence for candidate issues.',
  },
  {
    id: 'discover-roadmap-graph',
    scriptName: 'idd:discover-roadmap-graph',
    binName: 'idd-discover-roadmap-graph',
    entryPath: 'scripts/discover-roadmap-graph.mjs',
    vendoredCommand: 'node scripts/discover-roadmap-graph.mjs',
    description: 'Collect read-only A1.5/A2 recursive roadmap graph evidence.',
  },
  {
    id: 'discover-shared-file-overlap',
    scriptName: 'idd:discover-shared-file-overlap',
    binName: 'idd-discover-shared-file-overlap',
    entryPath: 'scripts/discover-shared-file-overlap.mjs',
    vendoredCommand: 'node scripts/discover-shared-file-overlap.mjs',
    description:
      'Flag high-contention shared-file overlap between candidate issues and actively-claimed / open-PR work.',
  },
  {
    id: 'discover-viability-gate',
    scriptName: 'idd:discover-viability-gate',
    binName: 'idd-discover-viability-gate',
    entryPath: 'scripts/discover-viability-gate.mjs',
    vendoredCommand: 'node scripts/discover-viability-gate.mjs',
    description:
      'Collect read-only A4 viability filtering evidence for candidate issues.',
  },
  {
    id: 'doctor',
    scriptName: 'idd:doctor',
    binName: 'idd-doctor',
    entryPath: 'scripts/idd-doctor.mjs',
    vendoredCommand: 'node scripts/idd-doctor.mjs',
    description:
      'Run IDD onboarding drift checks against the local repository.',
  },
  {
    id: 'emit-marker',
    scriptName: 'idd:emit-marker',
    binName: 'idd-emit-marker',
    entryPath: 'scripts/emit-marker.mjs',
    vendoredCommand: 'node scripts/emit-marker.mjs',
    description:
      'Emit a per-cycle claimed-by / review-watermark / review-baseline marker body (emit-only, no network write).',
  },
  {
    id: 'external-check-waiver',
    scriptName: 'idd:external-check-waiver',
    binName: 'idd-external-check-waiver',
    entryPath: 'scripts/external-check-waiver.mjs',
    vendoredCommand: 'node scripts/external-check-waiver.mjs',
    description:
      'Dry-run or apply a maintainer-authorized external-check waiver comment for an active PR claim.',
  },
  {
    id: 'force-handoff',
    scriptName: 'idd:force-handoff',
    binName: 'idd-force-handoff',
    entryPath: 'scripts/force-handoff.mjs',
    vendoredCommand: 'node scripts/force-handoff.mjs',
    description:
      'Interactive TTY-only operator facade for forced handoff: issue → optional PR → y/N confirmation.',
  },
  {
    id: 'forced-handoff-marker',
    scriptName: 'idd:forced-handoff-marker',
    binName: 'idd-forced-handoff-marker',
    entryPath: 'scripts/forced-handoff-marker.mjs',
    vendoredCommand: 'node scripts/forced-handoff-marker.mjs',
    description:
      'Render a maintainer-approved forced-handoff marker body for an active claim.',
    contractPaths: ['schemas/forced-handoff-marker.schema.json'],
  },
  {
    id: 'helper-bundle-manifest',
    scriptName: 'idd:helper-bundle-manifest',
    binName: 'idd-helper-bundle-manifest',
    entryPath: 'scripts/helper-runtime-manifest.mjs',
    vendoredCommand: 'node scripts/helper-runtime-manifest.mjs',
    description:
      'Print the canonical helper bundle import plan for each runtime profile.',
  },
  {
    id: 'live-status-digest',
    scriptName: 'idd:live-status-digest',
    binName: 'idd-live-status-digest',
    entryPath: 'scripts/live-status-digest.mjs',
    vendoredCommand: 'node scripts/live-status-digest.mjs',
    description: 'Render or apply the optional live status digest.',
  },
  {
    id: 'merge-execute',
    scriptName: 'idd:merge-execute',
    binName: 'idd-merge-execute',
    entryPath: 'scripts/idd-merge-execute.mjs',
    vendoredCommand: 'node scripts/idd-merge-execute.mjs',
    description:
      'Evaluate the F3 merge gate (dry-run) and execute the bound merge with --apply.',
    contractPaths: ['schemas/idd-merge-execute.schema.json'],
  },
  {
    id: 'phase-id-resolver',
    scriptName: 'idd:phase-id-resolver',
    binName: 'idd-phase-id-resolver',
    entryPath: 'scripts/phase-id-resolver.mjs',
    vendoredCommand: 'node scripts/phase-id-resolver.mjs',
    description: 'Resolve canonical phase IDs with legacy alias compatibility.',
  },
  {
    id: 'pre-merge-readiness',
    scriptName: 'idd:pre-merge-readiness',
    binName: 'idd-pre-merge-readiness',
    entryPath: 'scripts/pre-merge-readiness.mjs',
    vendoredCommand: 'node scripts/pre-merge-readiness.mjs',
    description: 'Collect read-only F2/F3 merge-gate evidence.',
    contractPaths: ['schemas/pre-merge-readiness.schema.json'],
  },
  {
    id: 'resume-claim-routing',
    scriptName: 'idd:resume-claim-routing',
    binName: 'idd-resume-claim-routing',
    entryPath: 'scripts/resume-claim-routing.mjs',
    vendoredCommand: 'node scripts/resume-claim-routing.mjs',
    description:
      'Evaluate Resume Step 1 claim routing outcomes from claim marker history.',
  },
  {
    id: 'resume-route-selection',
    scriptName: 'idd:resume-route-selection',
    binName: 'idd-resume-route-selection',
    entryPath: 'scripts/resume-route-selection.mjs',
    vendoredCommand: 'node scripts/resume-route-selection.mjs',
    description:
      'Evaluate Resume Step 3 route selection from PR, CI, and review state.',
  },
  {
    id: 'review-activity-snapshot',
    scriptName: 'idd:review-activity-snapshot',
    binName: 'idd-review-activity-snapshot',
    entryPath: 'scripts/review-activity-snapshot.mjs',
    vendoredCommand: 'node scripts/review-activity-snapshot.mjs',
    description: 'Collect read-only review activity and CI snapshot evidence.',
  },
  {
    id: 'review-disposition-verify',
    scriptName: 'idd:review-disposition-verify',
    binName: 'idd-review-disposition-verify',
    entryPath: 'scripts/review-disposition-verify.mjs',
    vendoredCommand: 'node scripts/review-disposition-verify.mjs',
    description:
      'Verify disposition marker presence on review items for E7 meta-check.',
  },
  {
    id: 'stalled-session-quiet-check',
    scriptName: 'idd:stalled-session-quiet-check',
    binName: 'idd-stalled-session-quiet-check',
    entryPath: 'scripts/stalled-session-quiet-check.mjs',
    vendoredCommand: 'node scripts/stalled-session-quiet-check.mjs',
    description: 'Detect quiet windows for Resume/S2 stalled-session recovery.',
    contractPaths: ['schemas/stalled-session-quiet-check.schema.json'],
  },
  {
    id: 'suitability-triage',
    scriptName: 'idd:suitability-triage',
    binName: 'idd-suitability-triage',
    entryPath: 'scripts/suitability-triage.mjs',
    vendoredCommand: 'node scripts/suitability-triage.mjs',
    description:
      'Evaluate A4.5 suitability checks and map deterministic outcomes.',
  },
];

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const manifest = buildHelperRuntimeManifest({
    profile: args.profile,
    fromProfile: args.fromProfile,
    packageManager: args.packageManager,
    packageSpec: args.packageSpec,
    targetRoot: args.targetRoot,
  });

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function buildHelperRuntimeManifest({
  profile = '',
  fromProfile = '',
  packageManager = '',
  packageSpec = '',
  targetRoot = process.cwd(),
}: {
  profile?: string;
  fromProfile?: string;
  packageManager?: string;
  packageSpec?: string;
  targetRoot?: string;
} = {}) {
  const packageRoot = PACKAGE_ROOT;
  const packageMetadata = resolveSourcePackageMetadata(packageRoot);
  const normalizedProfile = normalizeProfile(profile);
  const normalizedFromProfile = normalizeOptionalProfile(fromProfile);
  const normalizedTargetRoot = targetRoot || process.cwd();
  const normalizedPackageSpec = normalizePackageSpec(packageSpec);
  const recommendation = recommendHelperRuntimeProfile(normalizedTargetRoot);
  const normalizedPackageManager = normalizePackageManager(
    packageManager || detectPackageManager(normalizedTargetRoot),
    normalizedProfile,
  );
  const managedFiles = collectVendoredFiles(packageRoot);
  const commandCatalog = buildCommandCatalog();
  const profileCatalog = buildProfileCatalog({
    packageMetadata,
    managedFiles,
    packageManager: normalizedPackageManager,
    packageSpec: normalizedPackageSpec,
  });

  const selectedProfiles: Record<string, ProfileEntry> = normalizedProfile
    ? { [normalizedProfile]: profileCatalog[normalizedProfile] }
    : profileCatalog;

  return {
    version: 1,
    sourceRepository: packageMetadata.repository,
    packageName: packageMetadata.name,
    packageSpec: normalizedPackageSpec,
    packageSpecPinHint: PACKAGE_SPEC_PIN_HINT,
    nodeEngines: packageMetadata.nodeEngines,
    packageManager: normalizedPackageManager,
    recommendation,
    availableProfiles: [...PROFILE_NAMES],
    commandCatalog,
    profiles: selectedProfiles,
    switching:
      normalizedProfile && normalizedFromProfile
        ? buildSwitchPlan({
            fromProfile: normalizedFromProfile,
            toProfile: normalizedProfile,
            profileCatalog,
          })
        : null,
  };
}

export function collectVendoredFiles(
  packageRoot = PACKAGE_ROOT,
): ManagedFile[] {
  const queue = HELPER_COMMANDS.map((command) => command.entryPath).map(
    (entryPath) => resolve(packageRoot, entryPath),
  );
  const visited = new Set<string>();
  const managedFiles = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const currentPath = relativePath(packageRoot, current);
    managedFiles.add(currentPath);
    for (const extraFile of EXTRA_RUNTIME_FILES.get(currentPath) ?? []) {
      managedFiles.add(
        relativePath(packageRoot, resolve(packageRoot, extraFile)),
      );
    }

    const source = readFileSync(current, 'utf8');
    for (const specifier of findRelativeImports(source)) {
      const dependency = resolveRelativeImport(current, specifier);
      if (!dependency) {
        continue;
      }
      queue.push(dependency);
    }
  }

  for (const command of HELPER_COMMANDS) {
    for (const contractPath of command.contractPaths ?? []) {
      managedFiles.add(
        relativePath(packageRoot, resolve(packageRoot, contractPath)),
      );
    }
  }

  return [...managedFiles].sort().map((targetPath) => ({
    sourcePath: targetPath,
    targetPath,
  }));
}

export function detectPackageManager(root = process.cwd()): string {
  return collectHelperRuntimeEvidence(root).detectedPackageManager;
}

export function collectHelperRuntimeEvidence(
  root = process.cwd(),
): RuntimeEvidence {
  const packageJsonPath = resolve(root, 'package.json');
  let declaredPackageManager = '';
  let hasPackageJson = false;
  if (existsSync(packageJsonPath)) {
    hasPackageJson = true;
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        packageManager?: unknown;
      };
      const declared = String(packageJson.packageManager ?? '');
      for (const manager of PACKAGE_MANAGERS) {
        if (declared.startsWith(`${manager}@`)) {
          declaredPackageManager = manager;
          break;
        }
      }
    } catch {
      // Ignore parse errors here and fall back to lockfile detection.
    }
  }

  const lockfileMatches = [
    { filename: 'pnpm-lock.yaml', manager: 'pnpm' },
    { filename: 'package-lock.json', manager: 'npm' },
    { filename: 'yarn.lock', manager: 'yarn' },
  ].filter(({ filename }) => existsSync(resolve(root, filename)));
  const detectedPackageManager =
    declaredPackageManager ||
    (lockfileMatches.length === 1 ? lockfileMatches[0].manager : '');

  return {
    hasPackageJson,
    declaredPackageManager,
    lockfileMatches,
    detectedPackageManager,
    packageJsonOnly:
      hasPackageJson && !declaredPackageManager && lockfileMatches.length === 0,
    ambiguousPackageManager:
      !declaredPackageManager && lockfileMatches.length > 1,
  };
}

export function recommendHelperRuntimeProfile(
  root = process.cwd(),
): Recommendation {
  const evidence = collectHelperRuntimeEvidence(root);
  if (evidence.detectedPackageManager) {
    return {
      profile: 'package-manager',
      packageManager: evidence.detectedPackageManager,
      reason: evidence.declaredPackageManager
        ? 'Detected supported packageManager metadata.'
        : 'Detected exactly one supported package-manager lockfile.',
      evidence,
    };
  }

  if (evidence.ambiguousPackageManager) {
    return {
      profile: 'vendored-node',
      packageManager: '',
      reason:
        'Multiple supported package-manager signals were detected; do not guess an install path. Prefer vendored-node before ephemeral-npx when helper support is still desired.',
      evidence,
    };
  }

  let reason = 'No supported package-manager evidence was detected.';
  if (evidence.packageJsonOnly) {
    reason =
      'package.json alone is not enough evidence to assume npm, another package manager, or a real Node.js helper path.';
  }

  return {
    profile: 'instructions-only',
    packageManager: '',
    reason: `${reason} Keep instructions-only unless separate repository evidence confirms a real Node.js helper path; if helper support is still desired then, prefer vendored-node before ephemeral-npx.`,
    evidence,
  };
}

function buildCommandCatalog(): {
  id: string;
  scriptName: string;
  binName: string;
  entryPath: string;
  vendoredCommand: string;
  description: string;
  contractPaths: string[];
}[] {
  return HELPER_COMMANDS.map((command) => ({
    id: command.id,
    scriptName: command.scriptName,
    binName: command.binName,
    entryPath: command.entryPath,
    vendoredCommand: command.vendoredCommand,
    description: command.description,
    contractPaths: command.contractPaths ?? [],
  }));
}

export function resolveSourcePackageMetadata(
  packageRoot = PACKAGE_ROOT,
): PackageMetadata {
  const fallback: PackageMetadata = {
    name: PACKAGE_NAME,
    repository: SOURCE_REPOSITORY,
    nodeEngines: NODE_ENGINES,
  };
  const packageJsonPath = resolve(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return fallback;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown;
      repository?: unknown;
      engines?: { node?: unknown };
    };
    if (packageJson.name !== PACKAGE_NAME) {
      return fallback;
    }
    return {
      name: PACKAGE_NAME,
      repository: normalizeRepository(packageJson.repository),
      nodeEngines: String(packageJson.engines?.node ?? NODE_ENGINES),
    };
  } catch {
    return fallback;
  }
}

function normalizeRepository(repository: unknown): string {
  if (typeof repository === 'string' && repository) {
    return repository;
  }
  if (
    repository &&
    typeof repository === 'object' &&
    typeof (repository as { url?: unknown }).url === 'string' &&
    (repository as { url: string }).url
  ) {
    return (repository as { url: string }).url;
  }
  return SOURCE_REPOSITORY;
}

function buildProfileCatalog({
  packageMetadata,
  managedFiles,
  packageManager,
  packageSpec,
}: {
  packageMetadata: PackageMetadata;
  managedFiles: ManagedFile[];
  packageManager: string;
  packageSpec: string;
}): Record<string, ProfileEntry> {
  const packageManagerScripts = Object.fromEntries(
    HELPER_COMMANDS.map((command) => [command.scriptName, command.binName]),
  );
  const vendoredCommands = Object.fromEntries(
    HELPER_COMMANDS.map((command) => [
      command.scriptName,
      command.vendoredCommand,
    ]),
  );
  const ephemeralCommands = Object.fromEntries(
    HELPER_COMMANDS.map((command) => [
      command.scriptName,
      `npx --yes --package ${packageSpec} ${command.binName}`,
    ]),
  );

  return {
    'package-manager': {
      profile: 'package-manager',
      description:
        "Install the helper bundle through the repository's existing package manager and invoke helper bins through package.json scripts.",
      packageManager,
      installCommand: packageManager
        ? buildPackageManagerInstallCommand(packageManager, packageSpec)
        : '',
      managedDependencies: {
        devDependencies: {
          [packageMetadata.name]: packageSpec,
        },
      },
      managedPackageJsonScripts: packageManagerScripts,
      managedFiles: [],
      commands: packageManagerScripts,
      notes: [
        "Use the repository's existing package manager instead of assuming pnpm.",
        PACKAGE_SPEC_PIN_HINT,
      ],
    },
    'vendored-node': {
      profile: 'vendored-node',
      description:
        'Copy the helper bundle into the target repository and invoke helpers through local node scripts.',
      packageManager: '',
      installCommand: '',
      managedDependencies: {
        devDependencies: {},
      },
      managedPackageJsonScripts: {},
      managedFiles,
      commands: vendoredCommands,
      notes: [
        'Copy the listed files into matching paths in the target repository.',
        'The managed file list is derived from the helper entrypoint import graph to avoid hand-maintained drift.',
        "Append the recommendedGitattributes lines to the adopter's .gitattributes so the vendored bundle is marked linguist-vendored (dropped from language statistics and de-prioritized in code search).",
      ],
      recommendedGitattributes: managedFiles.map(
        (file) => `${file.targetPath} linguist-vendored`,
      ),
    },
    'ephemeral-npx': {
      profile: 'ephemeral-npx',
      description:
        'Resolve helper commands one-shot through npx without copying files into the repository.',
      packageManager: '',
      installCommand: '',
      managedDependencies: {
        devDependencies: {},
      },
      managedPackageJsonScripts: {},
      managedFiles: [],
      commands: ephemeralCommands,
      notes: [
        'This profile requires Node.js and npm with npx available at execution time.',
        PACKAGE_SPEC_PIN_HINT,
      ],
    },
    'instructions-only': {
      profile: 'instructions-only',
      description:
        'Keep the portable Markdown workflow only and omit helper dependencies entirely.',
      packageManager: '',
      installCommand: '',
      managedDependencies: {
        devDependencies: {},
      },
      managedPackageJsonScripts: {},
      managedFiles: [],
      commands: {},
      notes: [
        'No helper files, helper package dependencies, or helper wrapper scripts are required.',
      ],
    },
  };
}

function buildSwitchPlan({
  fromProfile,
  toProfile,
  profileCatalog,
}: {
  fromProfile: string;
  toProfile: string;
  profileCatalog: Record<string, ProfileEntry>;
}) {
  const from = profileCatalog[fromProfile];
  const to = profileCatalog[toProfile];
  return {
    fromProfile,
    toProfile,
    removeFiles: subtractPaths(from.managedFiles, to.managedFiles),
    addFiles: subtractPaths(to.managedFiles, from.managedFiles),
    removePackageJsonScripts: Object.keys(from.managedPackageJsonScripts)
      .filter((name) => !(name in to.managedPackageJsonScripts))
      .sort(),
    addPackageJsonScripts: Object.fromEntries(
      Object.entries(to.managedPackageJsonScripts)
        .filter(
          ([name, command]) => from.managedPackageJsonScripts[name] !== command,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    removeDevDependencies: Object.keys(from.managedDependencies.devDependencies)
      .filter((name) => !(name in to.managedDependencies.devDependencies))
      .sort(),
    addDevDependencies: Object.fromEntries(
      Object.entries(to.managedDependencies.devDependencies)
        .filter(
          ([name, spec]) =>
            from.managedDependencies.devDependencies[name] !== spec,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function subtractPaths(
  leftFiles: ManagedFile[],
  rightFiles: ManagedFile[],
): string[] {
  const right = new Set(rightFiles.map((file) => file.targetPath));
  return leftFiles
    .filter((file) => !right.has(file.targetPath))
    .map((file) => file.targetPath)
    .sort();
}

function buildPackageManagerInstallCommand(
  packageManager: string,
  packageSpec: string,
): string {
  if (packageManager === 'npm') {
    return `npm install --save-dev ${packageSpec}`;
  }
  if (packageManager === 'pnpm') {
    return `pnpm add -D ${packageSpec}`;
  }
  if (packageManager === 'yarn') {
    return `yarn add --dev ${packageSpec}`;
  }
  throw new Error(`unsupported package manager: ${packageManager}`);
}

function parseArgs(argv: string[]): ManifestArgs {
  const parsed: ManifestArgs = {
    help: false,
    profile: '',
    fromProfile: '',
    packageManager: '',
    packageSpec: '',
    targetRoot: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };

    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--profile') {
      parsed.profile = requireValue();
      index += 1;
      continue;
    }
    if (token === '--from-profile') {
      parsed.fromProfile = requireValue();
      index += 1;
      continue;
    }
    if (token === '--package-manager') {
      parsed.packageManager = requireValue();
      index += 1;
      continue;
    }
    if (token === '--package-spec') {
      parsed.packageSpec = requireValue();
      index += 1;
      continue;
    }
    if (token === '--target-root') {
      parsed.targetRoot = requireValue();
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(`usage: node scripts/helper-runtime-manifest.mjs [options]

Options:
  --profile <package-manager|vendored-node|ephemeral-npx|instructions-only>
  --from-profile <package-manager|vendored-node|ephemeral-npx|instructions-only>
  --package-manager <npm|pnpm|yarn>
  --package-spec <npm-spec-or-tarball-url>
  --target-root <path>
  --help
`);
}

function normalizePackageSpec(packageSpec: string): string {
  return packageSpec || DEFAULT_PACKAGE_SPEC;
}

function normalizeProfile(profile: string): string {
  if (!profile) {
    return '';
  }
  if (!PROFILE_NAMES.includes(profile)) {
    throw new Error(`unsupported profile: ${profile}`);
  }
  return profile;
}

function normalizeOptionalProfile(profile: string): string {
  if (!profile) {
    return '';
  }
  return normalizeProfile(profile);
}

function normalizePackageManager(
  packageManager: string,
  profile: string,
): string {
  if (!packageManager) {
    if (profile === 'package-manager') {
      throw new Error(
        'package-manager profile requires --package-manager <npm|pnpm|yarn> or a detectable package manager in --target-root',
      );
    }
    return '';
  }
  if (!PACKAGE_MANAGERS.includes(packageManager)) {
    throw new Error(`unsupported package manager: ${packageManager}`);
  }
  return packageManager;
}

function findRelativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]+\s+from\s+)?["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const directory = dirname(fromFile);
  const basePath = resolve(directory, specifier);
  const candidates = existsSync(basePath)
    ? [basePath]
    : SCRIPT_FILE_EXTENSIONS.map((extension) => `${basePath}${extension}`);

  return candidates.find((candidate) => existsSync(candidate)) ?? '';
}

function relativePath(root: string, target: string): string {
  return relative(root, target).replaceAll('\\', '/');
}

function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(moduleUrl) === resolve(process.argv[1]);
}
