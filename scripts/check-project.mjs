#!/usr/bin/env node
// idd-generated-from: src/scripts/check-project.mts
//
// The scripts/check-project.mjs copy is generated from this .mts source by
// `pnpm run build`. Edit the .mts source, never the generated .mjs.
//
// Ordered validation runner for the source repository (#3756). It runs five
// groups in a fixed order and reports each group on its own line. A failed
// group does not stop the groups after it, a group with an unavailable
// prerequisite is skipped with its reason, and only a run where every group
// passes exits 0. A spawn failure or a signal is a failure, never a pass.
//
// Node scripts run through `process.execPath`. pnpm runs through the pnpm
// entry point that pnpm exports as `npm_execpath`, so Windows never needs to
// execute a `.CMD` shim. The build:check group runs the canonical `.mts`
// sources directly, so a corrupted generated copy cannot skip it.
// Side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. See node-runtime-guard.mts.
import './node-runtime-guard.mjs';
import { spawnSync } from 'node:child_process';

const GROUP_ORDER = ['lint', 'typecheck', 'build:check', 'test', 'audit'];
function realSpawn(command, args) {
  const result = spawnSync(command, [...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
  };
}
/**
 * Run the groups in the order given. Each group runs all of its commands, so
 * every failing check is reported, and a group passes only when all of its
 * commands exit 0 with no spawn error and no signal.
 */
export function runCheckGroups(groups, deps = {}) {
  const spawn = deps.spawn ?? realSpawn;
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const results = [];
  for (const group of groups) {
    const reason = group.prerequisite?.() ?? null;
    if (reason !== null) {
      log(`[skip] ${group.id}: ${reason}`);
      results.push({
        id: group.id,
        status: 'skipped',
        reason,
        failedLabels: [],
      });
      continue;
    }
    const failedLabels = [];
    for (const check of group.commands) {
      log(`[run] ${group.id} / ${check.label}`);
      const outcome = spawn(check.command, check.args);
      if (outcome.error) {
        log(`[fail] ${group.id} / ${check.label}: ${outcome.error.message}`);
        failedLabels.push(check.label);
      } else if (outcome.signal !== null) {
        log(
          `[fail] ${group.id} / ${check.label}: terminated by ${outcome.signal}`,
        );
        failedLabels.push(check.label);
      } else if (outcome.status !== 0) {
        log(`[fail] ${group.id} / ${check.label}: exit ${outcome.status}`);
        failedLabels.push(check.label);
      } else {
        log(`[pass] ${group.id} / ${check.label}`);
      }
    }
    results.push({
      id: group.id,
      status: failedLabels.length === 0 ? 'passed' : 'failed',
      reason: null,
      failedLabels,
    });
  }
  log('');
  log('summary:');
  for (const result of results) {
    const detail =
      result.status === 'skipped'
        ? ` (${result.reason})`
        : result.status === 'failed'
          ? ` (${result.failedLabels.join(', ')})`
          : '';
    log(`  ${result.id}: ${result.status}${detail}`);
  }
  const allPassed = results.every((result) => result.status === 'passed');
  return { results, exitCode: allPassed ? 0 : 1 };
}
/**
 * The five groups of the source repository. `npmExecPath` is pnpm's entry
 * point (`process.env.npm_execpath`); groups that need pnpm are skipped with a
 * reason when it is absent, which is a non-success exit.
 */
export function defaultCheckGroups(npmExecPath) {
  const needsPnpm = () => {
    if (!npmExecPath) {
      return 'pnpm entry point unavailable: run through pnpm run so npm_execpath is set';
    }
    if (/\.(cmd|bat|ps1)$/iu.test(npmExecPath)) {
      return `pnpm entry point is a Windows shim that cannot be spawned directly: ${npmExecPath}`;
    }
    return null;
  };
  // pnpm 12 exports a native executable as npm_execpath; older pnpm exports a
  // CommonJS entry point, which must run under node.
  const pnpm = (label, args) =>
    /\.(c|m)?js$/u.test(npmExecPath ?? '')
      ? { label, command: process.execPath, args: [npmExecPath ?? '', ...args] }
      : { label, command: npmExecPath ?? '', args: [...args] };
  const node = (label, script, extra = []) => ({
    label,
    command: process.execPath,
    args: [script, ...extra],
  });
  const exec = (label, args) => pnpm(label, ['exec', ...args]);
  const run = (script) => pnpm(`pnpm run ${script}`, ['run', script]);
  return [
    {
      id: 'lint',
      prerequisite: needsPnpm,
      commands: [
        exec('biome', ['biome', 'check', '--error-on-warnings']),
        exec('dprint', ['dprint', 'check', '**/*.md']),
        exec('cspell', ['cspell', 'lint', '**', '--no-progress']),
        exec('markdownlint', ['markdownlint-cli2', '**/*.md']),
        node('code-span-wrap', 'scripts/audit-code-span-wrap.mjs'),
        node('dead-exports', 'scripts/audit-dead-exports.mjs', ['--check']),
        run('lint:boundaries'),
        run('lint:contracts'),
      ],
    },
    {
      id: 'typecheck',
      prerequisite: needsPnpm,
      commands: [run('typecheck')],
    },
    {
      id: 'build:check',
      commands: [
        node('check-build-artifacts', 'src/scripts/check-build-artifacts.mts'),
        node(
          'check-untracked-artifacts',
          'src/scripts/check-untracked-artifacts.mts',
        ),
      ],
    },
    {
      id: 'test',
      prerequisite: needsPnpm,
      commands: [run('test:scripts')],
    },
    {
      id: 'audit',
      prerequisite: needsPnpm,
      commands: [
        node('audit-docs', 'scripts/audit-docs.mjs', ['--check']),
        run('audit:schemas'),
        node(
          'verify-workshop-integrity',
          'scripts/verify-workshop-integrity.mjs',
          ['--format', 'table'],
        ),
        run('docs:sync:check'),
      ],
    },
  ];
}
/** Resolve the groups named on the command line, in the fixed order. */
export function selectCheckGroups(all, requested) {
  if (requested.length === 0) return [...all];
  for (const id of requested) {
    if (!GROUP_ORDER.includes(id)) {
      return `unknown group "${id}"; expected one of ${GROUP_ORDER.join(', ')}`;
    }
  }
  return all.filter((group) => requested.includes(group.id));
}
if (import.meta.main) {
  const selected = selectCheckGroups(
    defaultCheckGroups(process.env.npm_execpath),
    process.argv.slice(2),
  );
  if (typeof selected === 'string') {
    process.stderr.write(`check-project: ${selected}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = runCheckGroups(selected).exitCode;
  }
}
