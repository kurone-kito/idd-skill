import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DoctorReport } from '../src/scripts/idd-doctor.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const IDD_DOCTOR_SCRIPT = join(REPO_ROOT, 'scripts/idd-doctor.mjs');

// ---------------------------------------------------------------------------
// idd-skill#1810: `checkPostMergeCleanupBacklog` (idd-doctor.mts) is the only
// production caller of `readCleanupEvidenceTrustedLogins`, which itself has
// had direct unit tests since idd-skill#1804/PR#1809 -- but no test before
// this file exercised the caller's own `hasTrustedEvidence` trust-check
// logic (idd-skill#1691, fixed by PR#1759) with realistic
// `gh api .../comments` TSV-shaped output. Reverting that check back to its
// pre-#1759 fail-open shape (`return login.length > 0`) left the full suite
// green before this backfill -- see idd-skill#1810's issue body for the
// empirical verification this file locks in.
//
// `checkPostMergeCleanupBacklog` shells out via the module's private
// `runCommand`/`execFileSync('gh', ...)`, with no dependency-injection seam,
// so this reuses the stubbed-`gh`-on-`PATH` CLI-smoke pattern
// `tests/gh-pagination-parsing-smoke.test.mts` (#1692) established, spawning
// the real generated `scripts/idd-doctor.mjs`.
//
// Unlike that file's exact-argv stub table, this stub matches by CALL SHAPE
// (subcommand + a targeted regex over the `gh api` resource path) rather
// than full argv equality: `checkPostMergeCleanupBacklog`'s own merged-PR
// search embeds `merged:>=<sinceIso>`, computed from `Date.now()` at
// doctor-run time, so an exact-argv table could never be pinned to a fixed
// literal.
//
// A near-empty `--repo-root` also makes idd-doctor's *other* checks (missing
// required IDD files, missing Project commands table, etc.) report real
// errors unrelated to this backfill's target, which makes the CLI process
// exit non-zero. `runIddDoctorReport` below tolerates that and reads the
// `--json` report off the caught error's `stdout` (`execFileSync` still
// captures it); every test here asserts only the specific backlog-related
// warning strings it cares about, ignoring the rest of the report.
// ---------------------------------------------------------------------------

function buildCleanupBacklogStubGh(config: {
  owner: string;
  repo: string;
  mergedPrNumbers: number[];
  evidenceByPr: Map<number, string>;
  failEvidenceFor?: Set<number>;
  // idd-skill#1829: per-PR head ref, defaulting to an `issue/*`-shaped
  // branch so the pre-existing tests below (authored before the
  // `headRefName` scoping fix) keep exercising an IDD-branch PR without
  // being rewritten.
  headRefNameByPr?: Map<number, string>;
}): string {
  const owner = JSON.stringify(config.owner);
  const repo = JSON.stringify(config.repo);
  const headRefNameByPr = config.headRefNameByPr ?? new Map();
  const prListJson = JSON.stringify(
    config.mergedPrNumbers.map((number) => ({
      number,
      headRefName: headRefNameByPr.get(number) ?? `issue/${number}-fixture`,
    })),
  );
  const evidenceTable = JSON.stringify([...config.evidenceByPr.entries()]);
  const failingNumbers = JSON.stringify([...(config.failEvidenceFor ?? [])]);
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ owner: { login: ${owner} }, name: ${repo} }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(${JSON.stringify(prListJson)});
  process.exit(0);
}
if (args[0] === 'api' && args[1] === '--paginate') {
  const match = /issues\\/(\\d+)\\/comments/.exec(args[2] ?? '');
  const number = match ? Number(match[1]) : null;
  const failing = new Set(${failingNumbers});
  if (number !== null && failing.has(number)) {
    process.stderr.write('stubbed evidence-fetch failure for PR #' + number + '\\n');
    process.exit(1);
  }
  const table = new Map(${evidenceTable});
  process.stdout.write(number !== null ? (table.get(number) ?? '') : '');
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runIddDoctorReport(cwd: string, stubGhSource: string): DoctorReport {
  const stubRoot = mkdtempSync(join(tmpdir(), 'idd-doctor-cleanup-gh-'));
  try {
    const ghPath = join(stubRoot, 'gh');
    writeFileSync(ghPath, stubGhSource);
    chmodSync(ghPath, 0o755);
    const argv = [
      IDD_DOCTOR_SCRIPT,
      '--json',
      '--repo-root',
      cwd,
      '--cleanup-backlog-warn-threshold',
      '0',
    ];
    const options = {
      encoding: 'utf8' as const,
      env: { ...process.env, PATH: `${stubRoot}:${process.env.PATH ?? ''}` },
      timeout: 60_000,
    };
    try {
      return JSON.parse(
        execFileSync(process.execPath, argv, options),
      ) as DoctorReport;
    } catch (error) {
      // idd-doctor.mjs exits 1 whenever report.errors is non-empty -- a
      // near-empty --repo-root always trips the unrelated "missing required
      // IDD files" / "missing Project commands table" checks, so a
      // non-zero exit here is expected and irrelevant to this file's
      // target. execFileSync still captures full stdout on the thrown
      // error.
      const stdout = (error as { stdout?: string } | null)?.stdout;
      if (typeof stdout === 'string' && stdout.length > 0) {
        return JSON.parse(stdout) as DoctorReport;
      }
      throw error;
    }
  } finally {
    rmSync(stubRoot, { recursive: true, force: true });
  }
}

function withTempCwd(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-doctor-cleanup-cwd-'));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const BACKLOG_WARNING_SUBSTRING = 'lack F4 cleanup evidence';

// Paired tests: identical merged-PR numbers and comment IDs, differing only
// in the evidence comment's author login -- a positive control proving the
// "no warning" case below is because the trust check evaluated true, not
// because the scan silently failed to run at all.
const MERGED_PR_NUMBERS = [601, 602];

test("checkPostMergeCleanupBacklog CLI: a trusted author's idd-cleanup-evidence marker suppresses the backlog warning", () => {
  withTempCwd((cwd) => {
    const report = runIddDoctorReport(
      cwd,
      buildCleanupBacklogStubGh({
        owner: 'o',
        repo: 'r',
        mergedPrNumbers: MERGED_PR_NUMBERS,
        evidenceByPr: new Map([
          [601, '5001\tgithub-actions[bot]\n'],
          [602, '5002\tgithub-actions[bot]\n'],
        ]),
      }),
    );
    assert.ok(
      !report.warnings.some((w) => w.includes(BACKLOG_WARNING_SUBSTRING)),
      `expected no cleanup-backlog warning, got: ${JSON.stringify(report.warnings)}`,
    );
  });
});

test("checkPostMergeCleanupBacklog CLI: an untrusted author's identically-shaped marker does NOT suppress the backlog warning (idd-skill#1691, PR#1759 regression guard)", () => {
  withTempCwd((cwd) => {
    const report = runIddDoctorReport(
      cwd,
      buildCleanupBacklogStubGh({
        owner: 'o',
        repo: 'r',
        mergedPrNumbers: MERGED_PR_NUMBERS,
        evidenceByPr: new Map([
          [601, '5001\tuntrusted-user\n'],
          [602, '5002\tanother-untrusted-user\n'],
        ]),
      }),
    );
    const backlogWarning = report.warnings.find((w) =>
      w.includes(BACKLOG_WARNING_SUBSTRING),
    );
    assert.ok(
      backlogWarning,
      `expected a cleanup-backlog warning, got: ${JSON.stringify(report.warnings)}`,
    );
    assert.match(
      backlogWarning ?? '',
      /^post-merge cleanup backlog: 2 merged PRs/,
    );
    assert.match(backlogWarning ?? '', /#601/);
    assert.match(backlogWarning ?? '', /#602/);
  });
});

test('checkPostMergeCleanupBacklog CLI: a per-PR evidence-fetch failure is reported separately and never silently counted as missing evidence', () => {
  withTempCwd((cwd) => {
    const report = runIddDoctorReport(
      cwd,
      buildCleanupBacklogStubGh({
        owner: 'o',
        repo: 'r',
        mergedPrNumbers: [701],
        evidenceByPr: new Map(),
        failEvidenceFor: new Set([701]),
      }),
    );
    assert.ok(
      report.warnings.some(
        (w) =>
          w.includes(
            'post-merge cleanup evidence query failed for 1 merged PR(s)',
          ) && w.includes('#701'),
      ),
      `expected an evidence-fetch-failure warning, got: ${JSON.stringify(report.warnings)}`,
    );
    assert.ok(
      !report.warnings.some((w) => w.includes(BACKLOG_WARNING_SUBSTRING)),
      `evidence-fetch failures must not be folded into the missing-evidence backlog warning, got: ${JSON.stringify(report.warnings)}`,
    );
  });
});

// idd-skill#1829: a Dependabot-style (or any other non-IDD) branch must
// never count toward the backlog total or the `Examples: ...` list -- only
// `checkPostMergeCleanupBacklog`'s IDD-branch-naming scoping fix
// distinguishes the two; the pre-fix code counted both merged PRs
// regardless of head ref, which this test would fail against (count 2,
// #802 present).
test('checkPostMergeCleanupBacklog CLI: excludes a merged PR whose head ref is not an IDD branch (idd-skill#1829)', () => {
  withTempCwd((cwd) => {
    const report = runIddDoctorReport(
      cwd,
      buildCleanupBacklogStubGh({
        owner: 'o',
        repo: 'r',
        mergedPrNumbers: [801, 802],
        evidenceByPr: new Map(),
        headRefNameByPr: new Map([
          [801, 'issue/801-fix-foo'],
          [802, 'dependabot/npm_and_yarn/lodash-4.17.21'],
        ]),
      }),
    );
    const backlogWarning = report.warnings.find((w) =>
      w.includes(BACKLOG_WARNING_SUBSTRING),
    );
    assert.ok(
      backlogWarning,
      `expected a cleanup-backlog warning, got: ${JSON.stringify(report.warnings)}`,
    );
    assert.match(
      backlogWarning ?? '',
      /^post-merge cleanup backlog: 1 merged PRs/,
    );
    assert.match(backlogWarning ?? '', /#801/);
    assert.doesNotMatch(backlogWarning ?? '', /#802/);
  });
});
