// Runs the imported/substituted/verified helper bundle in adopter-shaped
// trees (idd-skill#3241): the closest existing coverage
// (`tests/idd-onboard.test.mts`'s single vendored-node fixture, which
// probes only a few selected helpers rather than sweeping the catalog,
// and `tests/cli-entry-smoke.test.mts`'s source-tree `--help` smokes)
// never sweeps the *whole* cataloged helper set from inside an imported
// target, so a helper whose import closure or `EXTRA_RUNTIME_FILES`
// entry misses a runtime file -- or a template workflow invocation
// naming a helper that was never vended -- can reach `main` unnoticed.
// This file spawns only `node`
// (never `gh`, `npx`, or a package manager), so it runs in the bare-node
// `lint` job with no `node_modules` installed.
//
// The independent `--help` sweep below deliberately does NOT call
// idd-onboard.mts's own `checkHelperLoad` (the `--verify` oracle this file
// also asserts against) -- a defect in that oracle must not be able to
// hide a real load failure from this harness.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NON_TTY_ERROR } from '../src/scripts/force-handoff.mts';
import { buildCommandCatalog } from '../src/scripts/helper-runtime-manifest.mts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'idd-onboard.mjs');
const WORKFLOWS_DIR = join(REPO_ROOT, 'idd-template', '.github', 'workflows');

// Matches tests/cli-entry-smoke.test.mts's own per-spawn timeout.
const SPAWN_TIMEOUT_MS = 60_000;

// The one entry in the interactive-only exception list: force-handoff.mts
// rejects non-TTY stdin before parsing any argument (including --help), so
// it can never satisfy the ordinary "exit 0, non-empty stdout" contract.
const FORCE_HANDOFF_ID = 'force-handoff';

// The six helpers idd-template/.github/workflows/*.yml invoke today, per
// the issue's own floor-against-a-vacuous-pass requirement.
const FLOOR_HELPER_IDS = [
  'advisory-convergence',
  'external-check-waiver',
  'audit-pr-cleanup',
  'review-comment-origin',
  'rerun-advisory-convergence',
  'advisory-comment-debounce',
];

// ---------------------------------------------------------------------------
// Temp-dir tracking (mirrors tests/idd-onboard.test.mts's trackedMkdtemp)
// ---------------------------------------------------------------------------

const createdFixtureDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdFixtureDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdFixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI invocation (mirrors tests/idd-onboard.test.mts's runCliBin)
// ---------------------------------------------------------------------------

interface CliResult {
  status: number;
  verdict: Record<string, unknown>;
}

function runOnboardCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [BIN_PATH, ...args, '--allow-root', tmpdir()],
      { encoding: 'utf8' },
    );
    return {
      status: 0,
      verdict: JSON.parse(stdout) as Record<string, unknown>,
    };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return {
      status: failed.status ?? -1,
      verdict: JSON.parse(String(failed.stdout ?? '{}')) as Record<
        string,
        unknown
      >,
    };
  }
}

const CLI_OVERRIDE_FLAGS = [
  '--repo-name',
  'my-app',
  '--marker-prefix',
  'my-app',
  '--trusted-marker-actor',
  'trusted-user-a',
  '--fix-validate-commands',
  'npm run lint:fix && npm run lint',
  '--pre-push-validate-commands',
  'npm run lint && npm run test',
  '--post-fix-validate-commands',
  'npm run lint:fix && npm run test',
  '--install-deps-command',
  'npm install',
];

// ---------------------------------------------------------------------------
// Independent --help sweep (shared by every shape's oracle)
// ---------------------------------------------------------------------------

interface CatalogCommand {
  id: string;
  scriptName: string;
  binName: string;
  entryPath: string;
  vendoredCommand: string;
  description: string;
  contractPaths: string[];
}

interface SweepFailure {
  id: string;
  path: string;
  reason: string;
}

interface SweepResult {
  probed: string[];
  failed: SweepFailure[];
}

/**
 * Spawn every cataloged helper's `--help` and classify the result, from
 * scratch -- never via idd-onboard.mts's own `checkHelperLoad`. `entryPath`
 * resolves one catalog command to the absolute file to spawn (vendored-node
 * shapes: under the imported target; the package-manager shape: under this
 * repo's own `bin/`), and `cwd` is always the shape's own target directory
 * -- defends the "no ancestor package.json" guarantee (shape 1) against a
 * helper that does a cwd-relative, rather than import.meta.url-relative,
 * lookup; a default cwd would otherwise be REPO_ROOT, which does have one.
 * Skips (never probes, never fails) an entryPath absent under its resolved
 * location -- that is a manifest-completeness gap, a different finding
 * from a load failure.
 */
function sweepHelp(
  catalog: readonly CatalogCommand[],
  resolveEntryPath: (command: CatalogCommand) => string,
  cwd: string,
): SweepResult {
  const probed: string[] = [];
  const failed: SweepFailure[] = [];
  for (const command of catalog) {
    const entryPath = resolveEntryPath(command);
    if (!existsSync(entryPath)) {
      continue;
    }
    probed.push(entryPath);
    const result = spawnSync(process.execPath, [entryPath, '--help'], {
      cwd,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      // Only *sends* killSignal once the deadline elapses; force
      // termination since a spawned helper cannot be assumed to
      // cooperate with SIGTERM (mirrors idd-onboard.mts's own
      // spawnHelperHelp, PR #3303).
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const ok =
      command.id === FORCE_HANDOFF_ID
        ? result.status === 1 && stderr.includes(NON_TTY_ERROR)
        : result.status === 0 && stdout.trim() !== '';
    if (!ok) {
      const snippet = stderr.trim().split('\n')[0] ?? '';
      failed.push({
        id: command.id,
        path: entryPath,
        reason: `exited ${String(result.status)}${
          snippet ? `: ${snippet}` : ' with no stderr'
        }`,
      });
    }
  }
  return { probed, failed };
}

/** Only the passing subset's identity survives into the passed set the
 * static-scan test consumes -- a failed sweep entry never counts as
 * resolvable, even defensively (the sweep tests themselves also assert
 * `failed` is empty). */
function passingIds<K>(
  catalog: readonly CatalogCommand[],
  sweep: SweepResult,
  keyOf: (command: CatalogCommand) => K,
): Set<K> {
  const failedIds = new Set(sweep.failed.map((entry) => entry.id));
  return new Set(
    catalog.filter((command) => !failedIds.has(command.id)).map(keyOf),
  );
}

// ---------------------------------------------------------------------------
// Interactive-only exception-list validator
// ---------------------------------------------------------------------------

/** Pure: reports every `exceptionIds` entry absent from `catalog`, so the
 * interactive-only exception list can never silently go stale (a helper
 * renamed or removed from the catalog would otherwise leave a dangling,
 * unnoticed exception). */
function validateExceptionList(
  exceptionIds: readonly string[],
  catalog: readonly { id: string }[],
): string[] {
  const catalogIds = new Set(catalog.map((command) => command.id));
  return exceptionIds
    .filter((id) => !catalogIds.has(id))
    .map(
      (id) =>
        `exception list names "${id}", which is absent from the command catalog`,
    );
}

test('interactive-only exception list: validates clean against the real catalog', () => {
  const violations = validateExceptionList(
    [FORCE_HANDOFF_ID],
    buildCommandCatalog(),
  );
  assert.deepEqual(violations, []);
});

test('interactive-only exception list: the validator reports a violation when its target is missing from the catalog', () => {
  const catalogWithoutForceHandoff = buildCommandCatalog().filter(
    (command) => command.id !== FORCE_HANDOFF_ID,
  );
  const violations = validateExceptionList(
    [FORCE_HANDOFF_ID],
    catalogWithoutForceHandoff,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /force-handoff/);
});

// ---------------------------------------------------------------------------
// Shape 1 -- vendored-node, no ancestor package.json
//
// Populates shape1PassedEntryPaths for the static-scan test below. node:test
// runs the test() calls declared in one file sequentially, in declaration
// order, by default (no --test-concurrency configured anywhere in this
// repository's test invocations) -- the static-scan test depends on this
// ordering and is declared after both this test and shape 3's below.
// ---------------------------------------------------------------------------

let shape1PassedEntryPaths: Set<string> | undefined;
// Set only on the ancestor-package.json skip path below, so the
// static-scan test (which depends on shape1PassedEntryPaths) can skip
// itself too, instead of hard-failing on a missing prerequisite that was
// never a defect (PR #3361 review, CodeRabbit + Copilot). Shape 3 below
// has no equivalent skip path -- the package-manager profile has no
// environment-dependent precondition -- so its own
// `assert.ok(shape3PassedBinNames, ...)` stays an unconditional hard
// check, correctly, with no matching shape3SkipReason needed.
let shape1SkipReason: string | undefined;

test('shape 1 (vendored-node, no ancestor package.json): import+substitute+verify pass, and every helper --help loads independently', (t) => {
  let probeDir = resolve(tmpdir());
  for (;;) {
    if (existsSync(join(probeDir, 'package.json'))) {
      shape1SkipReason = `ancestor package.json found at ${join(
        probeDir,
        'package.json',
      )}; shape 1 requires a package.json-less ancestry from the OS temp directory`;
      t.skip(shape1SkipReason);
      return;
    }
    const parent = dirname(probeDir);
    if (parent === probeDir) {
      break;
    }
    probeDir = parent;
  }

  const targetRoot = trackedMkdtemp('adopter-shape1-');
  const importResult = runOnboardCli([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(importResult.status, 0);

  const substituteResult = runOnboardCli([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituteResult.status, 0);

  const verifyResult = runOnboardCli([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(verifyResult.status, 0);
  assert.equal(verifyResult.verdict.blocking, false);
  const helperLoad = verifyResult.verdict.helperLoad as {
    applicable: boolean;
    failed: unknown[];
  };
  assert.equal(helperLoad.applicable, true);
  assert.deepEqual(helperLoad.failed, []);

  const catalog = buildCommandCatalog();
  const sweep = sweepHelp(
    catalog,
    (command) => join(targetRoot, command.entryPath),
    targetRoot,
  );
  assert.equal(sweep.probed.length, catalog.length);
  assert.deepEqual(sweep.failed, []);

  shape1PassedEntryPaths = passingIds(
    catalog,
    sweep,
    (command) => command.entryPath,
  );
});

// ---------------------------------------------------------------------------
// Shape 2 -- vendored-node, foreign root package.json
// ---------------------------------------------------------------------------

test('shape 2 (vendored-node, foreign root package.json): import+substitute+verify pass, the foreign package.json survives untouched, and every helper --help loads independently', () => {
  const targetRoot = trackedMkdtemp('adopter-shape2-');
  const foreignPackageJson = '{"name":"adopter-fixture","private":true}\n';
  writeFileSync(join(targetRoot, 'package.json'), foreignPackageJson);

  const importResult = runOnboardCli([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(importResult.status, 0);
  assert.equal(
    readFileSync(join(targetRoot, 'package.json'), 'utf8'),
    foreignPackageJson,
    'vendored-node must never overwrite a foreign root package.json',
  );

  const substituteResult = runOnboardCli([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituteResult.status, 0);

  const verifyResult = runOnboardCli([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(verifyResult.status, 0);
  assert.equal(verifyResult.verdict.blocking, false);
  const helperLoad = verifyResult.verdict.helperLoad as {
    applicable: boolean;
    failed: unknown[];
  };
  assert.equal(helperLoad.applicable, true);
  assert.deepEqual(helperLoad.failed, []);

  const catalog = buildCommandCatalog();
  const sweep = sweepHelp(
    catalog,
    (command) => join(targetRoot, command.entryPath),
    targetRoot,
  );
  assert.equal(sweep.probed.length, catalog.length);
  assert.deepEqual(sweep.failed, []);
});

// ---------------------------------------------------------------------------
// Shape 3 -- package-manager
//
// Populates shape3PassedBinNames for the static-scan test below (see the
// ordering note above shape 1).
// ---------------------------------------------------------------------------

let shape3PassedBinNames: Set<string> | undefined;

test('shape 3 (package-manager): import+substitute+verify pass, and every cataloged bin --help loads from the source repo with the imported tree as cwd', () => {
  const targetRoot = trackedMkdtemp('adopter-shape3-');
  const importResult = runOnboardCli([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'package-manager',
  ]);
  assert.equal(importResult.status, 0);

  const substituteResult = runOnboardCli([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituteResult.status, 0);

  const verifyResult = runOnboardCli([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'package-manager',
  ]);
  assert.equal(verifyResult.status, 0);
  assert.equal(verifyResult.verdict.blocking, false);

  // package-manager vends no scripts/bin of its own (only the core
  // template file set) -- the installed package is this repository's own
  // tree, so the binaries under test are REPO_ROOT's own bin/<binName>.mjs,
  // unmodified, run with the imported tree as cwd.
  const catalog = buildCommandCatalog();
  const sweep = sweepHelp(
    catalog,
    (command) => join(REPO_ROOT, 'bin', `${command.binName}.mjs`),
    targetRoot,
  );
  assert.equal(sweep.probed.length, catalog.length);
  assert.deepEqual(sweep.failed, []);

  shape3PassedBinNames = passingIds(
    catalog,
    sweep,
    (command) => command.binName,
  );
});

// ---------------------------------------------------------------------------
// Shape 4 -- instructions-only
// ---------------------------------------------------------------------------

test('shape 4 (instructions-only): import+substitute+verify pass and vend no scripts/ directory', () => {
  const targetRoot = trackedMkdtemp('adopter-shape4-');
  const importResult = runOnboardCli([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'instructions-only',
  ]);
  assert.equal(importResult.status, 0);
  assert.equal(existsSync(join(targetRoot, 'scripts')), false);

  const substituteResult = runOnboardCli([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituteResult.status, 0);

  const verifyResult = runOnboardCli([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'instructions-only',
  ]);
  assert.equal(verifyResult.status, 0);
  assert.equal(verifyResult.verdict.blocking, false);
});

// ---------------------------------------------------------------------------
// Schema-deletion synthetic failure (proves the sweep detects a real
// failure, in its own fresh temp dir so nothing else depends on its
// mutated state).
// ---------------------------------------------------------------------------

test('deleting schemas/policy.schema.json after import makes the independent sweep report at least one failing entryPath', () => {
  const targetRoot = trackedMkdtemp('adopter-schema-delete-');
  const importResult = runOnboardCli([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(importResult.status, 0);

  const substituteResult = runOnboardCli([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituteResult.status, 0);

  unlinkSync(join(targetRoot, 'schemas', 'policy.schema.json'));

  const catalog = buildCommandCatalog();
  const sweep = sweepHelp(
    catalog,
    (command) => join(targetRoot, command.entryPath),
    targetRoot,
  );
  assert.ok(
    sweep.failed.length >= 1,
    'expected at least one cataloged helper to fail --help after schemas/policy.schema.json was deleted',
  );
});

// ---------------------------------------------------------------------------
// Static workflow resolution
// ---------------------------------------------------------------------------

type InvocationKind = 'node' | 'pnpm' | 'yarn' | 'npm' | 'npx';

interface WorkflowInvocationHit {
  kind: InvocationKind;
  /** For `node`: the bare script name (no `scripts/` prefix, no `.mjs`
   * suffix). For every other kind: the full `idd-<name>` bin name. */
  name: string;
  line: string;
}

// Five independent RegExp objects, each tested against one non-comment
// line at a time -- never concatenated into a single alternation string
// (a bash `grep -E` prototype of the `npx` pattern silently failed to
// match inside one combined `|` alternation during this issue's own
// verification, a POSIX-ERE `$`-anchor quirk; the equivalent plain
// JavaScript RegExp -- tested here, both individually and combined with
// `|` -- matches correctly either way, but keeping the patterns separate
// keeps each kind's name-extraction unambiguous regardless).
const INVOCATION_PATTERNS: {
  kind: InvocationKind;
  re: RegExp;
  toName: (match: RegExpExecArray) => string;
}[] = [
  {
    kind: 'node',
    re: /\bnode scripts\/([a-zA-Z0-9_-]+)\.mjs\b/g,
    toName: (match) => match[1] ?? '',
  },
  {
    kind: 'pnpm',
    re: /\bpnpm exec idd-([a-zA-Z0-9-]+)\b/g,
    toName: (match) => `idd-${match[1] ?? ''}`,
  },
  {
    kind: 'yarn',
    re: /\byarn idd-([a-zA-Z0-9-]+)\b/g,
    toName: (match) => `idd-${match[1] ?? ''}`,
  },
  {
    kind: 'npm',
    re: /\bnpm exec idd-([a-zA-Z0-9-]+)\b/g,
    toName: (match) => `idd-${match[1] ?? ''}`,
  },
  {
    kind: 'npx',
    re: /npx --yes --package "\$SPEC" idd-([a-zA-Z0-9-]+)\b/g,
    toName: (match) => `idd-${match[1] ?? ''}`,
  },
];

/** Scans workflow text for the five documented invocation forms, skipping
 * any line whose first non-whitespace character is `#`. Line-scoped (each
 * of the five patterns is matched against one line at a time), not a
 * single unanchored multi-line pattern, so a job id or marker name (for
 * example `idd-advisory-convergence:`) can't false-positive -- none of the
 * five patterns match without their own literal invocation prefix
 * (`node scripts/`, `pnpm exec `, `yarn `, `npm exec `, or
 * `npx --yes --package "$SPEC" `) immediately before the name. */
function scanWorkflowInvocations(text: string): WorkflowInvocationHit[] {
  const hits: WorkflowInvocationHit[] = [];
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  for (const line of lines) {
    for (const { kind, re, toName } of INVOCATION_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null = re.exec(line);
      while (match !== null) {
        hits.push({ kind, name: toName(match), line });
        match = re.exec(line);
      }
    }
  }
  return hits;
}

/** Resolves every hit against the catalog and the two shapes' passing
 * sets. A `node` hit must name a catalog `entryPath` that also passed
 * shape 1's sweep; a package-runner hit must name a catalog `binName`
 * that also passed shape 3's sweep. Returns one violation string per
 * unresolved hit. */
function resolveWorkflowInvocationViolations(
  hits: readonly WorkflowInvocationHit[],
  catalog: readonly CatalogCommand[],
  passedEntryPaths: ReadonlySet<string>,
  passedBinNames: ReadonlySet<string>,
): string[] {
  const byEntryPath = new Map(
    catalog.map((command) => [command.entryPath, command]),
  );
  const byBinName = new Map(
    catalog.map((command) => [command.binName, command]),
  );
  const violations: string[] = [];
  for (const hit of hits) {
    if (hit.kind === 'node') {
      const entryPath = `scripts/${hit.name}.mjs`;
      if (!byEntryPath.has(entryPath) || !passedEntryPaths.has(entryPath)) {
        violations.push(
          `node ${entryPath} (unresolved; line: ${hit.line.trim()})`,
        );
      }
    } else if (!byBinName.has(hit.name) || !passedBinNames.has(hit.name)) {
      violations.push(
        `${hit.kind} ${hit.name} (unresolved; line: ${hit.line.trim()})`,
      );
    }
  }
  return violations;
}

test('static workflow resolution: every template workflow helper invocation resolves against the imported/verified bundle', (t) => {
  if (shape1SkipReason !== undefined) {
    // Honor shape 1's own legitimate skip instead of hard-failing on a
    // prerequisite that was never a defect (PR #3361 review).
    t.skip(`shape 1 was skipped: ${shape1SkipReason}`);
    return;
  }
  assert.ok(
    shape1PassedEntryPaths,
    'expected shape 1 to have populated shape1PassedEntryPaths first',
  );
  assert.ok(
    shape3PassedBinNames,
    'expected shape 3 to have populated shape3PassedBinNames before this test runs (shape 3 has no skip path, so an unset value here means it failed, not that it was skipped)',
  );

  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((name) =>
    name.endsWith('.yml'),
  );
  assert.ok(workflowFiles.length > 0, 'expected template workflow files');

  const catalog = buildCommandCatalog();
  const allHits: WorkflowInvocationHit[] = [];
  for (const file of workflowFiles) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    allHits.push(...scanWorkflowInvocations(text));
  }

  const violations = resolveWorkflowInvocationViolations(
    allHits,
    catalog,
    // biome-ignore lint/style/noNonNullAssertion: asserted non-undefined above
    shape1PassedEntryPaths!,
    // biome-ignore lint/style/noNonNullAssertion: asserted non-undefined above
    shape3PassedBinNames!,
  );
  assert.deepEqual(violations, []);

  // Floor against a vacuous pass: each of the six helpers the templates
  // invoke today must be found via every one of the five invocation
  // forms -- not merely appear in the deduplicated found-name set, which
  // would stay green even if one form's regex silently broke for one
  // helper while the other four forms kept registering it as "found".
  const seenKindsById = new Map<string, Set<InvocationKind>>();
  for (const hit of allHits) {
    const id = hit.kind === 'node' ? hit.name : hit.name.replace(/^idd-/, '');
    const seenKinds = seenKindsById.get(id) ?? new Set<InvocationKind>();
    seenKinds.add(hit.kind);
    seenKindsById.set(id, seenKinds);
  }
  const everyKind: InvocationKind[] = ['node', 'pnpm', 'yarn', 'npm', 'npx'];
  for (const floorId of FLOOR_HELPER_IDS) {
    const seenKinds = seenKindsById.get(floorId) ?? new Set<InvocationKind>();
    for (const kind of everyKind) {
      assert.ok(
        seenKinds.has(kind),
        `expected floor helper "${floorId}" to be invoked via the "${kind}" form in idd-template/.github/workflows/*.yml`,
      );
    }
  }
});

test('scanWorkflowInvocations + resolveWorkflowInvocationViolations flag an unresolvable node and pnpm invocation in a synthetic workflow snippet', () => {
  const synthetic = [
    'jobs:',
    '  example:',
    '    steps:',
    '      - run: |',
    '          node scripts/does-not-exist.mjs',
    '          pnpm exec idd-does-not-exist',
  ].join('\n');

  const hits = scanWorkflowInvocations(synthetic);
  const catalog = buildCommandCatalog();
  const violations = resolveWorkflowInvocationViolations(
    hits,
    catalog,
    new Set(),
    new Set(),
  );
  assert.equal(violations.length, 2);
  assert.match(violations[0] ?? '', /does-not-exist\.mjs/);
  assert.match(violations[1] ?? '', /idd-does-not-exist/);
});
