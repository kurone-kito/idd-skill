import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stubExecutable } from './test-utils.mts';

// ---------------------------------------------------------------------------
// #3342 — a per-bin CLI contract sweep for the opt-in JSON error envelope.
// Discovers every `bin/idd-*.mjs` from the directory (never a hand-kept
// list, so a new bin added later is caught automatically) and runs each
// twice -- once with an unknown flag, once with no arguments at all --
// against a fake `gh` that always fails, from a fresh temporary directory
// outside any git repository. The committed table
// (tests/fixtures/helper-cli-contract.json) records, per bin, whether it
// is migrated onto runHelperCli and, if so, the documented exit code and
// envelope `kind` for both runs. A bin missing from the table fails this
// suite outright -- see the first test below.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN_DIR = join(REPO_ROOT, 'bin');
const PER_RUN_TIMEOUT_MS = 10_000;
const ENVELOPE_LINE_PREFIX = '{"iddHelperError":';

interface RunExpectation {
  exitCode: number;
  kind: string | null;
}

interface BinTableEntry {
  migrated: boolean;
  runs?: {
    unknownFlag: RunExpectation;
    noArgs: RunExpectation;
  };
}

interface ExtraScenario {
  name: string;
  args: string[];
  exitCode: number;
  kind: string;
  httpStatus?: number | null;
  stdoutIsErrorJson?: boolean;
  /**
   * An optional replacement `gh` script body (raw Node.js source, same
   * contract as {@link stubExecutable}'s `scriptBody`) that stands in for
   * `SHARED_GH_SCRIPT` for the duration of this one scenario -- swapped
   * in and back out (see the extra-scenarios test loop below), never
   * nested on top of the shared stub. Needed when a helper makes an
   * earlier, unrelated `gh` call before the one this scenario targets --
   * `resume-claim-routing.mjs`'s `ghTransportFailure503ViaProviderPort`
   * scenario is the motivating case: it must let `resolveViewerLogin`
   * (`gh api user`) and `listWorkItemComments` (`.../comments`) succeed
   * so the run actually reaches `ProviderPort.getWorkItem()` -- the
   * `.cause`-wrapped path this scenario exists to cover -- instead of
   * failing earlier on a call the shared stub would fail regardless of
   * path.
   *
   * Swap, not stack: `stubExecutable`'s win32 branch layers same-named
   * stubs via `NODE_OPTIONS`'s `--require` list, loaded left-to-right --
   * a second `gh` stub registered on top of the first would never even
   * run, since the first preload's body calls `process.exit()` before
   * the second is ever reached. Tearing the shared stub down first (via
   * the test loop's own swap) avoids that collision entirely, on every
   * platform, rather than relying on override semantics `stubExecutable`
   * does not actually provide for a repeated executable name.
   */
  ghScript?: string;
}

interface ContractTable {
  bins: Record<string, BinTableEntry>;
  extraScenarios: Record<string, ExtraScenario[]>;
}

const TABLE = JSON.parse(
  readFileSync(
    new URL('./fixtures/helper-cli-contract.json', import.meta.url),
    'utf8',
  ),
) as ContractTable;

const DISCOVERED_BINS = readdirSync(BIN_DIR)
  .filter((name) => /^idd-.*\.mjs$/.test(name))
  .sort();

let restoreGh: (() => void) | undefined;
let tempHome: string;
let tempCwd: string;

// A fixed error on every invocation, regardless of subcommand or args --
// every scenario in this suite either never reaches `gh` at all (a usage
// error short-circuits first) or needs exactly this failure shape from
// whichever `gh` call it does reach. A scenario whose own `gh` call graph
// needs an earlier call to succeed first (see `ExtraScenario.ghScript`'s
// own doc comment) swaps this stub out for its own spawn only -- never
// nests a second `gh` stub on top of this one (see that same doc comment
// for why stacking two same-named stubs is unsafe on win32).
const SHARED_GH_SCRIPT = `process.stderr.write('gh: HTTP 503'); process.exit(1);`;

before(() => {
  restoreGh = stubExecutable('gh', SHARED_GH_SCRIPT);
  tempHome = mkdtempSync(join(tmpdir(), 'idd-helper-cli-contract-home-'));
  // Outside any git repository on purpose -- a helper that fell back to
  // resolving the current repo from a local .git would otherwise pick up
  // this checkout's own remote instead of failing closed the way a real
  // adopter clone with no matching context would.
  tempCwd = mkdtempSync(join(tmpdir(), 'idd-helper-cli-contract-cwd-'));
});

after(() => {
  restoreGh?.();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

/**
 * The child environment for a contract-sweep spawn: the fake `gh` stub's
 * own `PATH` (and, on win32, `NODE_OPTIONS`) mutation from `stubExecutable`
 * is inherited via `process.env`, plus the opt-in envelope variable and a
 * fresh `HOME`/`XDG_CONFIG_HOME`. Repo-location override variables
 * (`GIT_DIR` and friends) and any real `GH_TOKEN` are scrubbed so a
 * helper's own repo/auth resolution can never reach outside this fixture
 * regardless of what the calling shell happens to export (mirrors
 * `test-utils.mts`'s own `fixtureEnv()` scrubbing, narrowed to the
 * variables that matter for a CLI-only spawn rather than a git fixture).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GH_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  // GitHub Actions sets this, and audit-pr-cleanup treats it as the
  // repository instead of calling gh. That skips the fake-gh 503 the
  // no-args row records as transport and fails later as a usage error.
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_REPOSITORY_OWNER;
  env.HOME = tempHome;
  env.XDG_CONFIG_HOME = tempHome;
  env.IDD_HELPER_ERROR_ENVELOPE = '1';
  return env;
}

interface ContractRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawns `bin` with `args` under the shared contract-sweep environment
 * (fresh temp cwd/HOME, fake gh, envelope opted in, stdin ignored, and a
 * fixed per-run timeout that kills a genuinely hung child). */
function spawnBin(bin: string, args: readonly string[]): ContractRunResult {
  const result = spawnSync(process.execPath, [join(BIN_DIR, bin), ...args], {
    cwd: tempCwd,
    env: childEnv(),
    encoding: 'utf8',
    timeout: PER_RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut:
      (result.error as { code?: string } | undefined)?.code === 'ETIMEDOUT',
  };
}

/** Finds the trailing envelope line in `stderrText` (mirrors
 * `run-helper.mts`'s own `extractTrailingEnvelopeLine`), or `null` when
 * none is present. */
function extractEnvelope(stderrText: string): {
  iddHelperError: { kind: string; exitCode: number; httpStatus: unknown };
} | null {
  const lines = stderrText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === '') {
      continue;
    }
    return line.startsWith(ENVELOPE_LINE_PREFIX) ? JSON.parse(line) : null;
  }
  return null;
}

// --- fixture-table integrity ------------------------------------------

test('helper-cli-contract fixture: every discovered bin/idd-*.mjs has a table row', () => {
  const missing = DISCOVERED_BINS.filter((bin) => !(bin in TABLE.bins));
  assert.deepEqual(
    missing,
    [],
    `bins missing from tests/fixtures/helper-cli-contract.json: ${missing.join(', ')}`,
  );
});

test('helper-cli-contract fixture: the first, discover/claim, review/merge, and marker/handoff batches are marked migrated', () => {
  const migratedBins = DISCOVERED_BINS.filter(
    (bin) => TABLE.bins[bin]?.migrated,
  ).sort();
  assert.deepEqual(migratedBins, [
    'idd-advisory-comment-debounce.mjs',
    'idd-advisory-convergence.mjs',
    'idd-advisory-wait-state.mjs',
    'idd-audit-authored-issue.mjs',
    'idd-audit-pr-cleanup.mjs',
    'idd-authoring-owner-provenance.mjs',
    'idd-branch-conflict-state.mjs',
    'idd-branch-name.mjs',
    'idd-ci-wait-policy.mjs',
    'idd-ci-wait-state.mjs',
    'idd-claim-approval-gate.mjs',
    'idd-claim-lock.mjs',
    'idd-clone-lock.mjs',
    'idd-discover-orphan-filter.mjs',
    'idd-discover-readiness-check.mjs',
    'idd-discover-roadmap-graph.mjs',
    'idd-discover-shared-file-overlap.mjs',
    'idd-discover-viability-gate.mjs',
    'idd-disposition-non-review-notices.mjs',
    'idd-emit-marker.mjs',
    'idd-external-check-waiver.mjs',
    'idd-force-handoff.mjs',
    'idd-forced-handoff-marker.mjs',
    'idd-live-status-digest.mjs',
    'idd-local-validation-evidence.mjs',
    'idd-merge-execute.mjs',
    'idd-merged-pr-feedback-sweep.mjs',
    'idd-minimize-superseded-markers.mjs',
    'idd-phase-id-resolver.mjs',
    'idd-post-idd-marker.mjs',
    'idd-pre-merge-readiness.mjs',
    'idd-rerun-advisory-convergence.mjs',
    'idd-resolve-review-thread.mjs',
    'idd-resume-claim-routing.mjs',
    'idd-resume-route-selection.mjs',
    'idd-review-activity-snapshot.mjs',
    'idd-review-comment-origin.mjs',
    'idd-review-disposition-verify.mjs',
    'idd-roadmap-audit-execute.mjs',
    'idd-select-desynced-index.mjs',
    'idd-stalled-session-quiet-check.mjs',
    'idd-suitability-close-execute.mjs',
    'idd-suitability-triage.mjs',
    'idd-sweep-authoring-markers.mjs',
  ]);
});

// --- per-bin sweep -------------------------------------------------------

for (const bin of DISCOVERED_BINS) {
  test(`bin/${bin}: unknown-flag and no-args runs behave per the contract table`, () => {
    const entry = TABLE.bins[bin];
    assert.ok(entry, `bin/${bin} is missing from the contract table`);

    const unknownFlagResult = spawnBin(bin, ['--bogus-unknown-flag-xyz']);
    assert.equal(
      unknownFlagResult.timedOut,
      false,
      `bin/${bin} (unknown flag) exceeded the ${PER_RUN_TIMEOUT_MS}ms per-run timeout`,
    );

    const noArgsResult = spawnBin(bin, []);
    assert.equal(
      noArgsResult.timedOut,
      false,
      `bin/${bin} (no args) exceeded the ${PER_RUN_TIMEOUT_MS}ms per-run timeout`,
    );

    // A bin listed as not yet migrated: only the timeout assertions above
    // apply -- its exit code, stdout, and stderr shape are all still
    // whatever they were before #3342, unconstrained here.
    if (!entry.migrated) {
      return;
    }

    const runs = entry.runs;
    assert.ok(runs, `bin/${bin} is migrated but has no "runs" table entry`);

    assert.equal(
      unknownFlagResult.status,
      runs.unknownFlag.exitCode,
      `bin/${bin} (unknown flag) exit code`,
    );
    assert.equal(
      runs.unknownFlag.kind,
      'usage',
      `bin/${bin} (unknown flag) fixture row must document kind "usage"`,
    );
    const unknownFlagEnvelope = extractEnvelope(unknownFlagResult.stderr);
    assert.ok(
      unknownFlagEnvelope,
      `bin/${bin} (unknown flag) expected a trailing error envelope line`,
    );
    assert.equal(
      unknownFlagEnvelope.iddHelperError.kind,
      runs.unknownFlag.kind,
    );
    assert.equal(
      unknownFlagEnvelope.iddHelperError.exitCode,
      runs.unknownFlag.exitCode,
    );

    assert.equal(
      noArgsResult.status,
      runs.noArgs.exitCode,
      `bin/${bin} (no args) exit code`,
    );
    const noArgsEnvelope = extractEnvelope(noArgsResult.stderr);
    if (runs.noArgs.kind === null) {
      assert.equal(
        noArgsEnvelope,
        null,
        `bin/${bin} (no args) expected no envelope line`,
      );
    } else {
      assert.ok(
        noArgsEnvelope,
        `bin/${bin} (no args) expected a trailing error envelope line`,
      );
      assert.equal(noArgsEnvelope.iddHelperError.kind, runs.noArgs.kind);
      assert.equal(
        noArgsEnvelope.iddHelperError.exitCode,
        runs.noArgs.exitCode,
      );
    }
  });
}

// --- bin-specific extra scenarios ----------------------------------------

/**
 * Runs `body` with the shared `gh` stub temporarily swapped out for
 * `scriptBody` (when given) -- torn down first, then a fresh
 * `stubExecutable('gh', scriptBody)` installed, then torn back down and
 * the shared stub reinstalled afterward -- rather than nesting a second
 * `gh` stub on top of the first. See `ExtraScenario.ghScript`'s own doc
 * comment for why stacking two same-named stubs is unsafe on win32; a
 * swap has no such platform-dependent hazard, since exactly one `gh`
 * stub is ever active at a time on every platform. A no-op swap
 * (`scriptBody` undefined) just runs `body` under the already-installed
 * shared stub.
 */
function withGhScript<T>(scriptBody: string | undefined, body: () => T): T {
  if (scriptBody === undefined) {
    return body();
  }
  restoreGh?.();
  const restoreScenario = stubExecutable('gh', scriptBody);
  try {
    return body();
  } finally {
    restoreScenario();
    restoreGh = stubExecutable('gh', SHARED_GH_SCRIPT);
  }
}

for (const [bin, scenarios] of Object.entries(TABLE.extraScenarios)) {
  for (const scenario of scenarios) {
    test(`bin/${bin}: extra scenario "${scenario.name}"`, () => {
      withGhScript(scenario.ghScript, () => {
        const result = spawnBin(bin, scenario.args);
        assert.equal(
          result.timedOut,
          false,
          `bin/${bin} scenario "${scenario.name}" exceeded the ${PER_RUN_TIMEOUT_MS}ms per-run timeout`,
        );
        assert.equal(result.status, scenario.exitCode);
        if (scenario.stdoutIsErrorJson) {
          const parsedStdout = JSON.parse(result.stdout) as Record<
            string,
            unknown
          >;
          assert.ok(
            'error' in parsedStdout,
            `bin/${bin} scenario "${scenario.name}" expected stdout to be {"error": ...} JSON, got: ${result.stdout}`,
          );
        }
        const envelope = extractEnvelope(result.stderr);
        assert.ok(
          envelope,
          `bin/${bin} scenario "${scenario.name}" expected a trailing error envelope line`,
        );
        assert.equal(envelope.iddHelperError.kind, scenario.kind);
        assert.equal(envelope.iddHelperError.exitCode, scenario.exitCode);
        if (scenario.httpStatus !== undefined) {
          assert.equal(envelope.iddHelperError.httpStatus, scenario.httpStatus);
        }
      });
    });
  }
}
