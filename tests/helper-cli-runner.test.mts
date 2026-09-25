import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import {
  ghText,
  tagGhCommandError,
  wrapGhCompatibilityError,
} from '../src/scripts/gh-exec.mts';
import type {
  HelperCliResult,
  RunHelperCliIo,
} from '../src/scripts/helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  buildHelperErrorEnvelope,
  CliUsageError,
  classifyHelperError,
  ERROR_ENVELOPE_ENV_VAR,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from '../src/scripts/helper-cli-runner.mts';
import { collectVendoredFiles } from '../src/scripts/helper-runtime-manifest.mts';
import { createGithubProviderAdapter } from '../src/scripts/provider-adapter-github.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELPER_CLI_RUNNER_MJS_URL = pathToFileURL(
  join(REPO_ROOT, 'scripts', 'helper-cli-runner.mjs'),
).href;

// ---------------------------------------------------------------------------
// #3342 — runHelperCli()'s opt-in JSON error envelope. These tests exercise
// the REAL classifier and envelope builder through the injectable
// RunHelperCliIo seam (a fake IO implementation, not a mocked stand-in for
// runHelperCli itself), and for every gh-derived case, the real gh-exec.mts
// wrappers against a stubbed `gh` binary -- so the `ghCommand` tag this
// suite relies on is proven the same way gh-exec.mts's own callers get it,
// not hand-constructed to match what the classifier happens to check for.
// ---------------------------------------------------------------------------

const GH_ERROR_FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/gh-errors.json', import.meta.url), 'utf8'),
) as {
  cases: Record<string, { status: number; stderr?: string; stdout?: string }>;
};

function ghErrorFixtureStderr(id: string): string {
  const fixture = GH_ERROR_FIXTURES.cases[id];
  assert.ok(fixture?.stderr, `missing gh-errors.json fixture stderr: ${id}`);
  return fixture.stderr;
}

function stubGh(scriptBody: string): () => void {
  return stubExecutable('gh', scriptBody);
}

/**
 * Run `body` with `process.stderr.write` captured (swallow-only, no
 * forwarding to the real stream), so a deliberately-triggered `gh`
 * failure below doesn't leak its stub's stderr text to this suite's own
 * console output -- `execFileSync`'s default `stdio` forwards a failed
 * child's stderr to the real stream in addition to capturing it on the
 * thrown error (`gh-exec.test.mts`'s own `#3076` control test proves this
 * is normal, accepted `execFileSync` behavior for an unhandled failure,
 * not a bug this suite is checking for). Mirrors the same local helper
 * already duplicated in `gh-exec.test.mts` / `discover-roadmap-graph.
 * test.mts` / `idd-doctor.test.mts` / `suitability-triage.test.mts`.
 */
function captureStderr<T>(body: () => T): T {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return body();
  } finally {
    process.stderr.write = original;
  }
}

/** Records every decision `runHelperCli` makes through the {@link
 * RunHelperCliIo} seam, without touching the real `process`. */
interface FakeIo {
  io: RunHelperCliIo;
  stderrWrites: string[];
  getExitCode: () => number | undefined;
  takeOverCalled: () => boolean;
  /** Simulates the real `uncaughtException` firing with `error` -- the
   * event `DEFAULT_HELPER_CLI_IO.takeOverUncaughtCrash` actually waits
   * for, which this fake never generates on its own. */
  simulateUncaughtCrash: (error: unknown) => void;
}

function createFakeIo(envelopeEnabled: boolean): FakeIo {
  const stderrWrites: string[] = [];
  let exitCode: number | undefined;
  let capturedRender: ((error: unknown) => void) | null = null;
  const io: RunHelperCliIo = {
    env: envelopeEnabled ? { [ERROR_ENVELOPE_ENV_VAR]: '1' } : {},
    writeStderr: (text) => {
      stderrWrites.push(text);
    },
    writeStderrQueued: (text) => {
      stderrWrites.push(text);
    },
    setExitCode: (code) => {
      exitCode = code;
    },
    takeOverUncaughtCrash: (render) => {
      capturedRender = render;
    },
  };
  return {
    io,
    stderrWrites,
    getExitCode: () => exitCode,
    takeOverCalled: () => capturedRender !== null,
    simulateUncaughtCrash: (error) => {
      assert.ok(capturedRender, 'takeOverUncaughtCrash was never called');
      (capturedRender as (error: unknown) => void)(error);
    },
  };
}

/** Runs `main` through the real `runHelperCli`, expecting it to throw (a
 * thrown, not returned, error) -- returns the fake IO and the rethrown
 * error so a case can simulate the crash and inspect the envelope. */
function runExpectingThrow(
  main: () => HelperCliResult,
  envelopeEnabled: boolean,
): { fake: FakeIo; error: unknown } {
  const fake = createFakeIo(envelopeEnabled);
  let caught: unknown;
  try {
    runHelperCli('test-helper', main, fake.io);
    assert.fail('expected runHelperCli to rethrow');
  } catch (error) {
    caught = error;
  }
  return { fake, error: caught };
}

function lastEnvelope(fake: FakeIo): unknown {
  const lastLine = fake.stderrWrites.at(-1);
  assert.ok(lastLine, 'expected at least one stderr write');
  return JSON.parse(lastLine as string);
}

// --- usage -------------------------------------------------------------

test('runHelperCli: a thrown CliUsageError classifies as usage', () => {
  const { fake, error } = runExpectingThrow(() => {
    throw new CliUsageError('missing required --pr <number> argument');
  }, true);
  fake.simulateUncaughtCrash(error);
  assert.deepEqual(lastEnvelope(fake), {
    iddHelperError: {
      version: 1,
      helper: 'test-helper',
      kind: 'usage',
      exitCode: 1,
      message: 'missing required --pr <number> argument',
      httpStatus: null,
    },
  });
});

test('runHelperCli: a plain Error tagged via markCliUsageError classifies as usage', () => {
  const { fake, error } = runExpectingThrow(() => {
    throw markCliUsageError(new Error('unknown argument: --bogus'));
  }, true);
  fake.simulateUncaughtCrash(error);
  const envelope = lastEnvelope(fake) as {
    iddHelperError: { kind: string; message: string };
  };
  assert.equal(envelope.iddHelperError.kind, 'usage');
  assert.equal(envelope.iddHelperError.message, 'unknown argument: --bogus');
});

// --- transport / not-found (real gh-exec.mts calls against a stubbed gh) --

test('runHelperCli: a gh: HTTP 503 failure classifies as transport with httpStatus 503', () => {
  const restore = stubGh(
    `process.stderr.write('gh: HTTP 503'); process.exit(1);`,
  );
  try {
    const { fake, error } = captureStderr(() =>
      runExpectingThrow(() => {
        ghText(['repo', 'view']);
        return 0;
      }, true),
    );
    fake.simulateUncaughtCrash(error);
    const envelope = lastEnvelope(fake) as {
      iddHelperError: {
        kind: string;
        exitCode: number;
        httpStatus: number | null;
      };
    };
    assert.equal(envelope.iddHelperError.kind, 'transport');
    assert.equal(envelope.iddHelperError.exitCode, 1);
    assert.equal(envelope.iddHelperError.httpStatus, 503);
  } finally {
    restore();
  }
});

test('runHelperCli: a gh 403 secondary-rate-limit failure classifies as transport with httpStatus 403', () => {
  const stderrText = ghErrorFixtureStderr('secondaryRateLimit403');
  const restore = stubGh(
    `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(1);`,
  );
  try {
    const { fake, error } = captureStderr(() =>
      runExpectingThrow(() => {
        ghText(['repo', 'view']);
        return 0;
      }, true),
    );
    fake.simulateUncaughtCrash(error);
    const envelope = lastEnvelope(fake) as {
      iddHelperError: {
        kind: string;
        exitCode: number;
        httpStatus: number | null;
      };
    };
    assert.equal(envelope.iddHelperError.kind, 'transport');
    assert.equal(envelope.iddHelperError.exitCode, 1);
    assert.equal(envelope.iddHelperError.httpStatus, 403);
  } finally {
    restore();
  }
});

test('runHelperCli: a gh failure with no derivable HTTP status classifies as transport with httpStatus null', () => {
  const restore = stubGh(
    `process.stderr.write('gh: unexpected error occurred'); process.exit(1);`,
  );
  try {
    const { fake, error } = captureStderr(() =>
      runExpectingThrow(() => {
        ghText(['repo', 'view']);
        return 0;
      }, true),
    );
    fake.simulateUncaughtCrash(error);
    const envelope = lastEnvelope(fake) as {
      iddHelperError: {
        kind: string;
        exitCode: number;
        httpStatus: number | null;
      };
    };
    assert.equal(envelope.iddHelperError.kind, 'transport');
    assert.equal(envelope.iddHelperError.exitCode, 1);
    assert.equal(envelope.iddHelperError.httpStatus, null);
  } finally {
    restore();
  }
});

test('runHelperCli: an exec timeout classifies as transport with httpStatus null', () => {
  // Block synchronously well past the configured timeout so execFileSync's
  // own timeout enforcement kills this process before it can exit cleanly
  // (same pattern as gh-exec.test.mts's own timeout coverage).
  const restore = stubGh(`
const start = Date.now();
while (Date.now() - start < 2000) {
  // busy-wait
}
process.stdout.write('too slow');
`);
  try {
    const { fake, error } = runExpectingThrow(() => {
      ghText(['repo', 'view'], { timeout: 50 });
      return 0;
    }, true);
    fake.simulateUncaughtCrash(error);
    const envelope = lastEnvelope(fake) as {
      iddHelperError: {
        kind: string;
        exitCode: number;
        httpStatus: number | null;
      };
    };
    assert.equal(envelope.iddHelperError.kind, 'transport');
    assert.equal(envelope.iddHelperError.exitCode, 1);
    assert.equal(envelope.iddHelperError.httpStatus, null);
  } finally {
    restore();
  }
});

test('runHelperCli: a gh 404 failure classifies as not-found with httpStatus 404', () => {
  const stderrText = ghErrorFixtureStderr('bare404');
  const restore = stubGh(
    `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(1);`,
  );
  try {
    const { fake, error } = captureStderr(() =>
      runExpectingThrow(() => {
        ghText(['repo', 'view']);
        return 0;
      }, true),
    );
    fake.simulateUncaughtCrash(error);
    const envelope = lastEnvelope(fake) as {
      iddHelperError: {
        kind: string;
        exitCode: number;
        httpStatus: number | null;
      };
    };
    assert.equal(envelope.iddHelperError.kind, 'not-found');
    assert.equal(envelope.iddHelperError.exitCode, 1);
    assert.equal(envelope.iddHelperError.httpStatus, 404);
  } finally {
    restore();
  }
});

// --- cause-chain walk (#3342) ---------------------------------------------
//
// `discover-readiness-check.mts` / `discover-viability-gate.mts` /
// `authoring-owner-provenance.mts` / `resume-claim-routing.mts` never call
// gh-exec.mts directly for their issue lookup -- they go through
// `ProviderPort.getWorkItem()` (`provider-adapter-github.mts`), whose
// non-404 failure path wraps the real, gh-exec.mts-tagged error in a
// brand-new `Error` (`toProviderError`), preserving the original only as
// `.cause`. Before `classifyHelperError` walked the cause chain, it
// checked only the thrown value itself and misclassified this case:
// observed against the built bins, `IDD_HELPER_ERROR_ENVELOPE=1 node
// bin/idd-discover-readiness-check.mjs --issue 1 --owner X --repo Y`
// against a fake `gh` failing with `gh: HTTP 503` reported
// `"kind":"internal","httpStatus":null` instead of `"kind":"transport"` --
// reproducible the same way for `discover-viability-gate.mjs` and
// `authoring-owner-provenance.mjs`. These cases exercise the REAL
// `createGithubProviderAdapter(...).getWorkItem()` -> `toProviderError`
// path against a stubbed `gh`, not a hand-constructed `.cause` stand-in.

test('classifyHelperError: a ProviderPort.getWorkItem() gh transport failure (wrapped via toProviderError, tag preserved only on .cause) classifies as transport, not internal', () => {
  const restore = stubGh(
    `process.stderr.write('gh: HTTP 503'); process.exit(1);`,
  );
  try {
    let thrown: unknown;
    captureStderr(() => {
      try {
        createGithubProviderAdapter('owner', 'repo').getWorkItem(1);
        assert.fail('expected getWorkItem to throw');
      } catch (error) {
        thrown = error;
      }
    });
    // The thrown value itself carries no ghCommand tag -- only its .cause
    // does (proves this case actually exercises the chain walk, not just
    // a directly-tagged error the pre-fix classifier already handled).
    assert.equal(Object.hasOwn(thrown as object, 'ghCommand'), false);
    assert.ok((thrown as { cause?: unknown }).cause, 'expected a .cause link');
    const classified = classifyHelperError(thrown);
    assert.equal(classified.kind, 'transport');
    assert.equal(classified.httpStatus, 503);
  } finally {
    restore();
  }
});

test('classifyHelperError: a toProviderError-shaped .cause chain carrying a gh 404 classifies as not-found', () => {
  // deriveGhHttpStatus(candidate) is exercised directly here (rather than
  // through getWorkItem, which treats a genuine 404 as "no such item" and
  // returns null instead of throwing -- see docs/idd-helper-scripts.md's
  // migrated-helpers table) against a synthetic-but-representative
  // gh-exec.mts-tagged + toProviderError-wrapped pair, so the chain-walk
  // mechanism itself is covered for the not-found branch even though
  // getWorkItem's own real call graph never reaches it that way.
  const restore = stubGh(
    `process.stderr.write('gh: HTTP 404'); process.exit(1);`,
  );
  try {
    let tagged: unknown;
    captureStderr(() => {
      try {
        ghText(['repo', 'view']);
      } catch (error) {
        tagged = error;
      }
    });
    assert.ok(tagged, 'expected a tagged gh-exec.mts error');
    const wrapped = new Error('issue lookup failed', { cause: tagged });
    const classified = classifyHelperError(wrapped);
    assert.equal(classified.kind, 'not-found');
    assert.equal(classified.httpStatus, 404);
  } finally {
    restore();
  }
});

test('wrapGhCompatibilityError keeps a bare gh: HTTP line classifiable without changing the compatibility message', () => {
  const original = Object.assign(new Error('Command failed: gh api'), {
    stderr: 'gh: HTTP 404\n',
  });
  const wrapped = wrapGhCompatibilityError(original);
  assert.equal(wrapped.message, 'gh command failed: gh: HTTP 404');
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(wrapped, 'stderr'),
    false,
  );
  assert.equal(inspect(wrapped).includes('stderr'), false);
  const classified = classifyHelperError(wrapped);
  assert.equal(classified.kind, 'not-found');
  assert.equal(classified.httpStatus, 404);
  assert.match(classified.message, /gh command failed: gh: HTTP 404/);

  const wrapped503 = wrapGhCompatibilityError(
    Object.assign(new Error('Command failed: gh api'), {
      stderr: 'gh: HTTP 503',
    }),
  );
  const classified503 = classifyHelperError(wrapped503);
  assert.equal(classified503.kind, 'transport');
  assert.equal(classified503.httpStatus, 503);

  // The prefixed message alone does not satisfy the line-start match.
  const messageOnly = classifyHelperError(
    tagGhCommandError(new Error('gh command failed: gh: HTTP 404')),
  );
  assert.equal(messageOnly.kind, 'transport');
  assert.equal(messageOnly.httpStatus, null);
});

// --- gate / internal -----------------------------------------------------

test('runHelperCli: a returned non-zero exit code classifies as gate', () => {
  const fake = createFakeIo(true);
  runHelperCli('test-helper', () => 1, fake.io);
  assert.equal(fake.getExitCode(), 1);
  assert.deepEqual(lastEnvelope(fake), {
    iddHelperError: {
      version: 1,
      helper: 'test-helper',
      kind: 'gate',
      exitCode: 1,
      message: 'test-helper exited with code 1',
      httpStatus: null,
    },
  });
});

test('runHelperCli: a returned, already-classified outcome object is trusted verbatim (pre-merge-readiness pattern)', () => {
  const fake = createFakeIo(true);
  const outcome: HelperCliResult = {
    exitCode: 1,
    kind: 'transport',
    message: 'gh: HTTP 503',
    httpStatus: 503,
  };
  runHelperCli('pre-merge-readiness', () => outcome, fake.io);
  assert.equal(fake.getExitCode(), 1);
  assert.deepEqual(lastEnvelope(fake), {
    iddHelperError: {
      version: 1,
      helper: 'pre-merge-readiness',
      kind: 'transport',
      exitCode: 1,
      message: 'gh: HTTP 503',
      httpStatus: 503,
    },
  });
});

test('runHelperCli: a plain thrown Error (untagged, non-gh) classifies as internal', () => {
  const { fake, error } = runExpectingThrow(() => {
    throw new Error('something broke');
  }, true);
  fake.simulateUncaughtCrash(error);
  assert.deepEqual(lastEnvelope(fake), {
    iddHelperError: {
      version: 1,
      helper: 'test-helper',
      kind: 'internal',
      exitCode: 1,
      message: 'something broke',
      httpStatus: null,
    },
  });
});

// --- envelope-unset contract ----------------------------------------------

test('runHelperCli: with IDD_HELPER_ERROR_ENVELOPE unset, a thrown error propagates with no envelope write and no IO exit-code call', () => {
  const { fake, error } = runExpectingThrow(() => {
    throw new Error('something broke');
  }, false);
  assert.equal((error as Error).message, 'something broke');
  assert.deepEqual(fake.stderrWrites, []);
  assert.equal(fake.takeOverCalled(), false);
  assert.equal(fake.getExitCode(), undefined);
});

test('runHelperCli: with IDD_HELPER_ERROR_ENVELOPE unset, a returned non-zero exit code still sets the exit code with no envelope write', () => {
  const fake = createFakeIo(false);
  runHelperCli('test-helper', () => 1, fake.io);
  assert.equal(fake.getExitCode(), 1);
  assert.deepEqual(fake.stderrWrites, []);
});

test('runHelperCli: a successful (exit-0) outcome never writes an envelope even with the variable set', () => {
  const fake = createFakeIo(true);
  runHelperCli('test-helper', () => 0, fake.io);
  assert.equal(fake.getExitCode(), 0);
  assert.deepEqual(fake.stderrWrites, []);
});

// --- classifyHelperError / buildHelperErrorEnvelope (direct) --------------

test('classifyHelperError: a CliUsageError instance classifies as usage regardless of message text', () => {
  const classified = classifyHelperError(new CliUsageError('anything'));
  assert.deepEqual(classified, {
    kind: 'usage',
    message: 'anything',
    httpStatus: null,
  });
});

test('buildHelperErrorEnvelope: assembles the documented single-line shape', () => {
  const envelope = buildHelperErrorEnvelope('some-helper', 2, {
    kind: 'gate',
    message: 'not ready yet',
    httpStatus: null,
  });
  assert.deepEqual(envelope, {
    iddHelperError: {
      version: 1,
      helper: 'some-helper',
      kind: 'gate',
      exitCode: 2,
      message: 'not ready yet',
      httpStatus: null,
    },
  });
});

// --- disabled-path call-site helpers (#3342 review round 5, Copilot) -----
//
// A migrated helper's own `if (import.meta.main)` trigger must call
// `main`/`runCli` DIRECTLY (never through `runHelperCli`) when the
// envelope is disabled, applying the returned outcome via
// `applyHelperCliOutcomeWhenDisabled` afterward -- routing through
// `runHelperCli` unconditionally, even just for its try/catch
// classification bookkeeping, adds `runHelperCli`'s own frame to the
// V8-captured stack of any error constructed while `main` runs, which
// breaks the "byte-identical when the envelope is unset" contract for a
// helper's raw, unclassified uncaught-crash text. See
// `applyHelperCliOutcomeWhenDisabled`'s own doc comment in
// `helper-cli-runner.mts` for the full empirical reasoning.
// ---------------------------------------------------------------------------

test('isHelperErrorEnvelopeEnabled: true only when the variable is exactly "1"', () => {
  assert.equal(
    isHelperErrorEnvelopeEnabled({ [ERROR_ENVELOPE_ENV_VAR]: '1' }),
    true,
  );
  assert.equal(isHelperErrorEnvelopeEnabled({}), false);
  assert.equal(
    isHelperErrorEnvelopeEnabled({ [ERROR_ENVELOPE_ENV_VAR]: 'true' }),
    false,
  );
  assert.equal(
    isHelperErrorEnvelopeEnabled({ [ERROR_ENVELOPE_ENV_VAR]: '0' }),
    false,
  );
});

test('applyHelperCliOutcomeWhenDisabled: sets the exit code from a plain numeric outcome, success or gate alike', () => {
  const fake = createFakeIo(false);
  applyHelperCliOutcomeWhenDisabled(0, fake.io);
  assert.equal(fake.getExitCode(), 0);
  applyHelperCliOutcomeWhenDisabled(2, fake.io);
  assert.equal(fake.getExitCode(), 2);
  // No envelope write either way -- this function does no envelope work
  // at all, by design (the caller already knows the envelope is disabled).
  assert.deepEqual(fake.stderrWrites, []);
});

test('applyHelperCliOutcomeWhenDisabled: sets the exit code from an already-classified outcome object (pre-merge-readiness pattern)', () => {
  const fake = createFakeIo(false);
  applyHelperCliOutcomeWhenDisabled(
    {
      exitCode: 1,
      kind: 'transport',
      message: 'gh: HTTP 503',
      httpStatus: 503,
    },
    fake.io,
  );
  assert.equal(fake.getExitCode(), 1);
  assert.deepEqual(fake.stderrWrites, []);
});

/**
 * Spawns a synthetic fixture module that reproduces the exact required
 * call-site pattern (`if (envelopeEnabled) { runHelperCli(...) } else {
 * applyHelperCliOutcomeWhenDisabled(main()) }`) against the REAL built
 * `scripts/helper-cli-runner.mjs`, with `main` throwing uncaught, and
 * returns the captured stderr -- proving the fix against the actual
 * shipped module, not a hand-rolled stand-in.
 */
function spawnDisabledPathFixture(envelopeEnabled: boolean): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-disabled-path-fixture-'));
  try {
    const fixturePath = join(tempRoot, 'fixture.mjs');
    writeFileSync(
      fixturePath,
      [
        `import { applyHelperCliOutcomeWhenDisabled, isHelperErrorEnvelopeEnabled, runHelperCli } from ${JSON.stringify(HELPER_CLI_RUNNER_MJS_URL)};`,
        envelopeEnabled ? "process.env.IDD_HELPER_ERROR_ENVELOPE = '1';" : '',
        'function main() {',
        "  throw new Error('boom');",
        '}',
        'if (isHelperErrorEnvelopeEnabled()) {',
        "  runHelperCli('fixture-helper', main);",
        '} else {',
        '  applyHelperCliOutcomeWhenDisabled(main());',
        '}',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [fixturePath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return result.stderr ?? '';
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('disabled-path call-site pattern: an uncaught crash carries no runHelperCli stack frame when the envelope is disabled', () => {
  const stderr = spawnDisabledPathFixture(false);
  assert.match(stderr, /at main \(/);
  assert.doesNotMatch(stderr, /runHelperCli/);
});

test('control: the SAME fixture, with the envelope enabled, DOES carry a runHelperCli frame (proves the disabled-path assertion above is actually meaningful, not vacuously true)', () => {
  const stderr = spawnDisabledPathFixture(true);
  assert.match(stderr, /at main \(/);
  assert.match(stderr, /runHelperCli/);
});

// --- helper-runtime-manifest integration -----------------------------------

test('collectVendoredFiles(): includes scripts/helper-cli-runner.mjs so vendored-node adopters receive the new module through the existing import-closure walk', () => {
  const files = collectVendoredFiles().map((file) => file.targetPath);
  assert.ok(
    files.includes('scripts/helper-cli-runner.mjs'),
    `expected scripts/helper-cli-runner.mjs in: ${files.join(', ')}`,
  );
});
