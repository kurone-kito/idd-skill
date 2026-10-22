#!/usr/bin/env node
// idd-generated-from: src/bin/idd-provider-outage-park.mts
//
// The bin/idd-provider-outage-park.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
// This direct entry supervises scripts/provider-outage-park.mjs so signals
// reach its owned read-worker process tree.

import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from '../scripts/helper-cli-runner.mts';
import { main } from '../scripts/provider-outage-park.mts';

if (isHelperErrorEnvelopeEnabled()) {
  runHelperCli('provider-outage-park', main);
} else {
  const outcome = main();
  if (outcome instanceof Promise) {
    outcome.then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  } else {
    applyHelperCliOutcomeWhenDisabled(outcome);
  }
}
