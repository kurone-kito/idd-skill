import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IssueAuthoringDelegateReport } from '../src/scripts/idd-issue-authoring-delegate.mts';
import { buildIssueAuthoringDelegateReport } from '../src/scripts/idd-issue-authoring-delegate.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-issue-authoring-delegate.mjs');

const ABSENT_REPORT: IssueAuthoringDelegateReport = {
  usable: false,
  source: 'none',
  command: null,
  mode: null,
  reason: 'not-configured',
  waitCeiling: 'PT20M',
};

/** Run the built CLI with an isolated HOME so the operator's user-global
 * config never leaks, and neutralize GITHUB_ACTIONS the same way
 * idd-critique-delegate.test.mts does. */
function runCli(args: string[], env?: NodeJS.ProcessEnv): unknown {
  const isolatedHome = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-home-'),
  );
  const output = execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      ...env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: '',
    },
  });
  return JSON.parse(output);
}

test('reports a repository-local delegate and its own wait ceiling (#3599)', () => {
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      critiqueLoop: {
        delegate: { command: 'must-not-leak' },
        subagentWaitCeiling: 'PT45M',
      },
      issueAuthoring: {
        adversarialReview: {
          waitCeiling: 'PT5M',
          delegate: { command: 'local-review' },
        },
      },
    },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'repository-local',
    command: 'local-review',
    mode: 'fallback',
    reason: null,
    waitCeiling: 'PT5M',
  });
});

test('reports the configured mode when present alongside command (#3599)', () => {
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      issueAuthoring: {
        adversarialReview: {
          delegate: { command: 'local-review', mode: 'combined' },
        },
      },
    },
  });
  assert.equal(report.usable, true);
  assert.equal(report.mode, 'combined');
  assert.equal(report.waitCeiling, 'PT20M');
});

test('reports repository-local-explicit-disable for a null local delegate (#3599)', () => {
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      issueAuthoring: { adversarialReview: { delegate: null } },
    },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    mode: null,
    reason: 'repository-local-explicit-disable',
    waitCeiling: 'PT20M',
  });
});

test('a malformed repository-local delegate fails closed and never inherits a global delegate (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-malformed-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: {
          waitCeiling: 'PT1H',
          delegate: { command: 'global-review' },
        },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      issueAuthoring: {
        adversarialReview: {
          waitCeiling: 'PT5M',
          delegate: { command: 'x', mode: 'not-a-mode' },
        },
      },
    },
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    mode: null,
    reason: 'invalid-repository-local-delegate',
    waitCeiling: 'PT5M',
  });
});

test('an unknown adversarialReview key fails closed instead of looking absent (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-typo-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'global-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      issueAuthoring: {
        adversarialReview: { waitCeiling: 'PT5M', unexpected: true },
      },
    },
    globalConfigPath: globalPath,
    env: {},
  });
  assert.equal(report.usable, false);
  assert.equal(report.reason, 'invalid-repository-local-delegate');
  assert.equal(report.command, null);
  assert.equal(report.waitCeiling, 'PT5M');
});

test('inherits a user-global delegate only when the local delegate is absent, and ignores the global ceiling (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-global-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: {
        delegate: { command: 'must-not-leak' },
        subagentWaitCeiling: 'PT45M',
      },
      issueAuthoring: {
        adversarialReview: {
          waitCeiling: 'PT1H',
          delegate: { command: 'global-review', mode: 'never' },
        },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {
      critiqueLoop: { subagentWaitCeiling: 'PT45M' },
      issueAuthoring: { adversarialReview: { waitCeiling: 'PT5M' } },
    },
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'global-review',
    mode: 'never',
    reason: null,
    waitCeiling: 'PT5M',
  });
});

test('consults an $HOME-resolved user-global delegate outside GITHUB_ACTIONS (#3599)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'home-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {},
    env: { HOME: home },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'home-review',
    mode: 'fallback',
    reason: null,
    waitCeiling: 'PT20M',
  });
});

test('skips the user-global delegate under GITHUB_ACTIONS=true (#3599)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-actions-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'home-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {},
    env: { HOME: home, GITHUB_ACTIONS: 'true' },
  });
  assert.deepEqual(report, ABSENT_REPORT);
});

test('skips the user-global delegate when noUserGlobal is passed (#3599)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-nouser-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'home-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport(
    { localConfig: {}, env: { HOME: home } },
    true,
  );
  assert.deepEqual(report, ABSENT_REPORT);
});

test('noUserGlobal clears an explicit globalConfigPath (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-explicit-global-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'global-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport(
    { localConfig: {}, globalConfigPath: globalPath, env: {} },
    true,
  );
  assert.deepEqual(report, ABSENT_REPORT);
});

test('GITHUB_ACTIONS=true clears an explicit globalConfigPath (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-explicit-ci-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'global-review' } },
      },
    }),
  );
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {},
    globalConfigPath: globalPath,
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.deepEqual(report, ABSENT_REPORT);
});

test('reports not-configured when neither layer has a delegate (#3599)', () => {
  const report = buildIssueAuthoringDelegateReport({
    localConfig: {},
    env: {},
  });
  assert.deepEqual(report, ABSENT_REPORT);
});

test('CLI --help exits 0 and names the trusted-command boundary (#3599)', () => {
  const output = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(output, /Usage:/);
  assert.match(output, /trusted executable configuration/);
  assert.match(output, /waitCeiling/);
});

test('CLI --policy resolves an absent local delegate (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-cli-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      critiqueLoop: { subagentWaitCeiling: 'PT45M' },
    }),
  );
  const report = runCli([
    '--policy',
    policyPath,
  ]) as IssueAuthoringDelegateReport;
  assert.deepEqual(report, ABSENT_REPORT);
});

test('CLI --policy resolves a configured local delegate (#3599)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-cli-local-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: {
          waitCeiling: 'PT5M',
          delegate: { command: 'cli-review', mode: 'on-success' },
        },
      },
    }),
  );
  const report = runCli(['--policy', policyPath]);
  assert.deepEqual(report, {
    usable: true,
    source: 'repository-local',
    command: 'cli-review',
    mode: 'on-success',
    reason: null,
    waitCeiling: 'PT5M',
  });
});

test('CLI --no-user-global skips an otherwise-picked-up $HOME delegate (#3599)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-cli-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      issueAuthoring: {
        adversarialReview: { delegate: { command: 'home-review' } },
      },
    }),
  );
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-issue-authoring-delegate-cli-empty-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const commonEnv = {
    ...process.env,
    GITHUB_ACTIONS: '',
    HOME: home,
    XDG_CONFIG_HOME: '',
  };

  const withGlobal = execFileSync(
    process.execPath,
    [CLI_PATH, '--policy', policyPath],
    { encoding: 'utf8', timeout: 60_000, env: commonEnv },
  );
  assert.equal(JSON.parse(withGlobal).usable, true);
  assert.equal(JSON.parse(withGlobal).waitCeiling, 'PT20M');

  const withoutGlobal = execFileSync(
    process.execPath,
    [CLI_PATH, '--policy', policyPath, '--no-user-global'],
    { encoding: 'utf8', timeout: 60_000, env: commonEnv },
  );
  assert.deepEqual(JSON.parse(withoutGlobal), ABSENT_REPORT);
});
