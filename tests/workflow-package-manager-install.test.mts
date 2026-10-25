import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, 'idd-template', '.github', 'workflows');

interface WorkflowSite {
  file: string;
  installOccurrence: number;
  ambiguousOccurrence: number | null;
  helperSteps: string[];
}

interface Scenario {
  name: string;
  packageManager?: string;
  files: string[];
  manager: string;
  expectedInstall: string[] | null;
  error?: string;
}

const WORKFLOW_SITES: readonly WorkflowSite[] = [
  {
    file: 'post-merge-cleanup.yml',
    installOccurrence: 0,
    ambiguousOccurrence: null,
    helperSteps: ['Run F4 cleanup (server-side fallback)'],
  },
  {
    file: 'idd-advisory-convergence.yml',
    installOccurrence: 0,
    ambiguousOccurrence: 0,
    helperSteps: ['Run advisory-convergence check'],
  },
  {
    file: 'idd-advisory-convergence.yml',
    installOccurrence: 1,
    ambiguousOccurrence: 1,
    helperSteps: ['Post the self-referential-bootstrap-auto waiver'],
  },
  {
    file: 'idd-advisory-convergence-comment.yml',
    installOccurrence: 0,
    ambiguousOccurrence: null,
    helperSteps: ['Classify review comment', 'Rerun required HEAD check'],
  },
];

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'no declaration and no lockfile refuses before npm ci',
    files: [],
    manager: 'unusable',
    expectedInstall: null,
    error: 'No supported package-manager lockfile',
  },
  {
    name: 'explicit npm without npm evidence refuses before npm ci',
    packageManager: 'npm@10.0.0',
    files: ['pnpm-lock.yaml'],
    manager: 'npm',
    expectedInstall: null,
    error: 'neither package-lock.json nor npm-shrinkwrap.json',
  },
  {
    name: 'explicit pnpm without its lockfile refuses before install',
    packageManager: 'pnpm@9.0.0',
    files: ['package-lock.json'],
    manager: 'pnpm',
    expectedInstall: null,
    error: 'pnpm-lock.yaml is missing',
  },
  {
    name: 'explicit yarn without its lockfile refuses before install',
    packageManager: 'yarn@4.0.0',
    files: ['package-lock.json'],
    manager: 'yarn',
    expectedInstall: null,
    error: 'yarn.lock is missing',
  },
  {
    name: 'npm shrinkwrap is usable npm evidence',
    files: ['npm-shrinkwrap.json'],
    manager: 'npm',
    expectedInstall: ['npm ci'],
  },
  {
    name: 'both npm lockfiles still identify one manager',
    files: ['package-lock.json', 'npm-shrinkwrap.json'],
    manager: 'npm',
    expectedInstall: ['npm ci'],
  },
  {
    name: 'one pnpm lockfile selects frozen pnpm install',
    files: ['pnpm-lock.yaml'],
    manager: 'pnpm',
    expectedInstall: ['corepack enable', 'pnpm install --frozen-lockfile'],
  },
  {
    name: 'one yarn lockfile selects frozen yarn install',
    files: ['yarn.lock'],
    manager: 'yarn',
    expectedInstall: ['corepack enable', 'yarn install --frozen-lockfile'],
  },
  {
    name: 'conflicting manager lockfiles remain ambiguous',
    files: ['pnpm-lock.yaml', 'package-lock.json'],
    manager: 'ambiguous',
    expectedInstall: null,
    error: 'multiple package-manager lockfiles',
  },
  {
    name: 'an explicit supported manager wins over other lockfiles',
    packageManager: 'pnpm@9.0.0',
    files: ['pnpm-lock.yaml', 'package-lock.json'],
    manager: 'pnpm',
    expectedInstall: ['corepack enable', 'pnpm install --frozen-lockfile'],
  },
  {
    name: 'an unsupported explicit manager does not switch to npm',
    packageManager: 'bun@1.0.0',
    files: ['package-lock.json'],
    manager: 'unsupported',
    expectedInstall: null,
    error: 'packageManager value unsupported',
  },
];

function workflowText(file: string): string {
  return readFileSync(join(WORKFLOW_DIR, file), 'utf8');
}

test('package-manager self-waiver allowlist includes npm shrinkwrap', () => {
  const workflow = workflowText('idd-advisory-convergence.yml');
  const allowlist = workflow.match(
    /package-manager\)\s*\n\s+ALLOWLIST\+=\(\s*([\s\S]*?)\s+\)\s*\n\s+;;/,
  );
  assert.ok(allowlist, 'missing package-manager self-waiver allowlist');
  assert.match(allowlist?.[1] ?? '', /"npm-shrinkwrap\.json"/);
});

function steps(text: string): string[] {
  const starts = [...text.matchAll(/^ {6}- name: (.+)$/gm)].map(
    (match) => match.index ?? -1,
  );
  return starts.map((start, index) =>
    text.slice(start, starts[index + 1] ?? text.length),
  );
}

function stepText(text: string, name: string, occurrence = 0): string {
  const found = steps(text).filter(
    (step) => step.split(/\r?\n/, 1)[0] === `      - name: ${name}`,
  );
  assert.ok(found[occurrence], `missing step ${name} occurrence ${occurrence}`);
  return found[occurrence] ?? '';
}

function stepPosition(text: string, name: string, occurrence = 0): number {
  const found = [...text.matchAll(/^ {6}- name: (.+)$/gm)]
    .filter((match) => match[1] === name)
    .map((match) => match.index ?? -1);
  assert.ok(
    found[occurrence] !== undefined,
    `missing step ${name} occurrence ${occurrence}`,
  );
  return found[occurrence] ?? -1;
}

test('stepPosition selects a repeated workflow step by occurrence', () => {
  const text = [
    'jobs:',
    '  first:',
    '    steps:',
    '      - name: Install dependencies (package-manager profile)',
    '        run: echo first',
    '  second:',
    '    steps:',
    '      - name: Install dependencies (package-manager profile)',
    '        run: echo second',
  ].join('\n');
  const header = '      - name: Install dependencies (package-manager profile)';

  assert.equal(
    stepPosition(text, 'Install dependencies (package-manager profile)', 0),
    text.indexOf(header),
  );
  assert.equal(
    stepPosition(text, 'Install dependencies (package-manager profile)', 1),
    text.lastIndexOf(header),
  );
});

function runBlock(step: string): string {
  const lines = step.split(/\r?\n/);
  const runIndex = lines.indexOf('        run: |');
  assert.notEqual(runIndex, -1, 'step must use a literal run block');
  return lines
    .slice(runIndex + 1)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function createMocks(directory: string): { bin: string; log: string } {
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  for (const command of [
    'corepack',
    'npm',
    'pnpm',
    'yarn',
    'idd-workflow-helper',
  ]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      '#!/usr/bin/env bash\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> "$MOCK_LOG"\n',
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
  }
  return { bin, log };
}

function runShell(code: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', code], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function helperCanRunAfterInstallOutcome(
  installStep: string,
  helperStep: string,
  profile: 'package-manager' | 'ephemeral-npx',
  outcome: 'success' | 'failure' | 'skipped',
): boolean {
  const condition = helperStep.match(/^\s+if:\s*(.+)$/m)?.[1] ?? '';
  const hasStatusCheck =
    /\b(?:success|failure|cancelled|always)\s*\(\s*\)/i.test(condition);
  const installId = installStep.match(/^\s+id:\s*([A-Za-z0-9_-]+)/m)?.[1];
  const packageManagerSuccessGuard = installId
    ? new RegExp(
        `(?:^|&&)\\s*\\(\\s*steps\\.profile\\.outputs\\.profile\\s*!=\\s*['"]package-manager['"]\\s*\\|\\|\\s*steps\\.${installId}\\.outcome\\s*==\\s*['"]success['"]\\s*\\)\\s*(?:&&|$)`,
        'i',
      ).test(condition)
    : false;
  if (
    packageManagerSuccessGuard &&
    profile === 'package-manager' &&
    outcome !== 'success'
  ) {
    return false;
  }
  const failureOutcomeGuard = installId
    ? new RegExp(
        `steps\\.${installId}\\.outcome\\s*!=\\s*['"]${outcome}['"]`,
        'i',
      ).test(condition)
    : false;
  if (outcome !== 'success' && failureOutcomeGuard) return false;

  const installCanConcealFailure = /^\s+continue-on-error\s*:/m.test(
    installStep,
  );
  return installCanConcealFailure || hasStatusCheck;
}

function evaluate(site: WorkflowSite, scenario: Scenario): void {
  const text = workflowText(site.file);
  const installStep = stepText(
    text,
    'Install dependencies (package-manager profile)',
    site.installOccurrence,
  );
  const detectorStep = stepText(
    text,
    'Detect package manager',
    site.installOccurrence,
  );
  const helperSteps = site.helperSteps.map((name) => stepText(text, name));
  const installPosition = stepPosition(
    text,
    'Install dependencies (package-manager profile)',
    site.installOccurrence,
  );
  for (const [index, helperStep] of helperSteps.entries()) {
    const helperName = site.helperSteps[index] ?? '';
    assert.ok(
      stepPosition(text, helperName) > installPosition,
      'helper must follow install',
    );
    assert.ok(
      !/\b(always|failure|cancelled)\s*\(\s*\)/i.test(
        helperStep.match(/^\s+if:\s*(.+)$/m)?.[1] ?? '',
      ),
      'helper condition must not override a failed prior step',
    );
  }

  const fixture = mkdtempSync(join(tmpdir(), 'idd-pm-install-'));
  try {
    if (scenario.packageManager !== undefined) {
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ packageManager: scenario.packageManager }),
      );
    } else {
      writeFileSync(join(fixture, 'package.json'), '{}');
    }
    for (const file of scenario.files) {
      writeFileSync(join(fixture, file), 'fixture lockfile\n');
    }

    const { bin, log } = createMocks(fixture);
    const outputFile = join(fixture, 'github-output');
    writeFileSync(outputFile, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: outputFile,
      MOCK_LOG: log,
    };

    const detect = runShell(runBlock(detectorStep), fixture, env);
    assert.equal(
      detect.status,
      0,
      `${site.file} / ${scenario.name}: detector failed: ${detect.stderr}`,
    );
    const managerLine = readFileSync(outputFile, 'utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('manager='));
    assert.ok(
      managerLine,
      `${site.file} / ${scenario.name}: no manager output`,
    );
    const manager = managerLine?.slice('manager='.length);
    assert.equal(manager, scenario.manager, `${site.file} / ${scenario.name}`);
    assert.equal(
      readFileSync(log, 'utf8'),
      '',
      'detection must not install or run helpers',
    );

    if (manager === 'ambiguous') {
      if (site.ambiguousOccurrence !== null) {
        const ambiguous = stepText(
          text,
          'Fail closed on ambiguous package manager',
          site.ambiguousOccurrence,
        );
        const result = runShell(runBlock(ambiguous), fixture, env);
        assert.notEqual(
          result.status,
          0,
          `${site.file}: ambiguous manager must fail closed`,
        );
        assert.ok(result.stdout.includes(scenario.error ?? ''), result.stdout);
      } else {
        assert.match(
          installStep,
          /if:.*steps\.manager\.outputs\.manager != 'ambiguous'/,
          `${site.file}: ambiguous manager must skip installation`,
        );
        for (const helperStep of helperSteps) {
          assert.match(
            helperStep,
            /if:.*steps\.manager\.outputs\.manager != 'ambiguous'/,
            `${site.file}: ambiguous manager must skip the helper`,
          );
        }
      }
      assert.equal(
        readFileSync(log, 'utf8'),
        '',
        'ambiguous evidence must run no commands',
      );
      return;
    }

    const install = runShell(
      `MANAGER='${manager}'\n${runBlock(installStep)}`,
      fixture,
      env,
    );
    if (scenario.expectedInstall === null) {
      assert.notEqual(
        install.status,
        0,
        `${site.file} / ${scenario.name}: missing evidence must be refused`,
      );
      assert.ok(
        install.stdout.includes(scenario.error ?? ''),
        `${site.file} / ${scenario.name}: refusal should be clear: ${install.stdout}`,
      );
      assert.equal(
        readFileSync(log, 'utf8'),
        '',
        'refusal must start no install or helper',
      );
      for (const helperStep of helperSteps) {
        assert.equal(
          helperCanRunAfterInstallOutcome(
            installStep,
            helperStep,
            'package-manager',
            'failure',
          ),
          false,
          `${site.file} / ${scenario.name}: helper condition must keep a rejected install from running the helper`,
        );
        assert.equal(
          helperCanRunAfterInstallOutcome(
            installStep,
            helperStep,
            'package-manager',
            'skipped',
          ),
          false,
          `${site.file} / ${scenario.name}: helper condition must keep a skipped package-manager install from running the helper`,
        );
      }
      const rerunStep = helperSteps.find((step) =>
        step.includes('Rerun required HEAD check'),
      );
      if (rerunStep) {
        assert.equal(
          helperCanRunAfterInstallOutcome(
            installStep,
            rerunStep,
            'ephemeral-npx',
            'skipped',
          ),
          true,
          'a skipped package-manager install must not block other runnable profiles',
        );
      }
      return;
    }

    assert.equal(
      install.status,
      0,
      `${site.file} / ${scenario.name}: install failed: ${install.stderr}`,
    );
    const installCommands = readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(
      installCommands,
      scenario.expectedInstall,
      `${site.file} / ${scenario.name}`,
    );

    for (const _helperStep of helperSteps) {
      const helper = spawnSync('idd-workflow-helper', ['run'], {
        cwd: fixture,
        env,
        encoding: 'utf8',
      });
      assert.equal(
        helper.status,
        0,
        `${site.file} / ${scenario.name}: helper sentinel failed`,
      );
    }
    assert.deepEqual(
      readFileSync(log, 'utf8').trim().split(/\r?\n/),
      [
        ...scenario.expectedInstall,
        ...helperSteps.map(() => 'idd-workflow-helper run'),
      ],
      `${site.file} / ${scenario.name}: downstream helper order`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('template package-manager selectors and installs reject unusable evidence before helpers (idd-skill#4699)', () => {
  for (const site of WORKFLOW_SITES) {
    for (const scenario of SCENARIOS) {
      evaluate(site, scenario);
    }
  }
});
