#!/usr/bin/env node
// idd-generated-from: src/bin/idd-provider-outage-park.mts
//
// The bin/idd-provider-outage-park.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
// This direct entry supervises scripts/provider-outage-park.mjs so signals
// reach its owned read-worker process tree.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractShapedCliParseErrorMessage } from '../scripts/cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from '../scripts/helper-cli-runner.mts';
import { main } from '../scripts/provider-outage-park.mts';

const helperScriptPath = fileURLToPath(
  new URL('../scripts/provider-outage-park.mjs', import.meta.url),
);

function handleShapedCliParseError(error: unknown): boolean {
  const stderrText =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  const message = extractShapedCliParseErrorMessage(stderrText);
  if (message === null) return false;
  const helpResult = spawnSync(process.execPath, [helperScriptPath, '--help'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const usage =
    !helpResult.error && helpResult.status === 0
      ? helpResult.stdout?.trim()
      : '';
  process.stderr.write(`${message}\n${usage ? `${usage}\n` : ''}`);
  process.exitCode = 1;
  return true;
}

if (isHelperErrorEnvelopeEnabled()) {
  runHelperCli('provider-outage-park', main);
} else {
  let outcome: ReturnType<typeof main>;
  try {
    outcome = main();
  } catch (error) {
    if (!handleShapedCliParseError(error)) throw error;
    outcome = 1;
  }
  if (outcome instanceof Promise) {
    outcome.then(applyHelperCliOutcomeWhenDisabled, (error) => {
      if (!handleShapedCliParseError(error)) throw error;
    });
  } else {
    applyHelperCliOutcomeWhenDisabled(outcome);
  }
}
