#!/usr/bin/env node
// idd-generated-from: src/bin/idd-local-admission.mts
//
// The bin/idd-local-admission.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Unlike the run-helper wrappers, this bin does not spawn scripts/idd-local-admission.mjs
// as a child process. It runs that module in this process (#4428, decision
// D2 = A), so a SIGTERM sent to the registered command reaches the admitted
// command, which run-helper cannot forward.

import { runLocalAdmissionEntry } from '../scripts/idd-local-admission.mts';

runLocalAdmissionEntry();
