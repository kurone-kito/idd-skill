#!/usr/bin/env node
// idd-generated-from: src/scripts/emit-marker.mts
//
// The scripts/emit-marker.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Emit-only CLI for the three per-cycle operational marker bodies
// (claimed-by / review-watermark / review-baseline). It prints the
// ready-to-post body string to stdout and performs NO network write; the
// agent posts it via the documented HTTP path. The render logic lives in
// protocol-helpers; this is the thin CLI surface.

import {
  renderClaimedByMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
} from './protocol-helpers.mts';

const MARKER_TYPES = ['claimed-by', 'review-watermark', 'review-baseline'];

if (import.meta.main) {
  runCli();
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const type = args.type;
  if (!type || !MARKER_TYPES.includes(type)) {
    throw new Error(
      `--type is required and must be one of: ${MARKER_TYPES.join(', ')}`,
    );
  }

  let body: string;
  if (type === 'claimed-by') {
    body = renderClaimedByMarker({
      agentId: args['agent-id'],
      claimId: args['claim-id'],
      supersedes: args.supersedes,
      timestamp: args.timestamp,
      branch: args.branch,
    });
  } else if (type === 'review-watermark') {
    body = renderReviewWatermarkMarker({
      agentId: args['agent-id'],
      claimId: args['claim-id'],
      headSha: args['head-sha'],
      maxActivityAt: args['max-activity-at'],
      totalItemCount: args['total-item-count'],
      ciCompletedAt: args['ci-completed-at'],
    });
  } else {
    body = renderReviewBaselineMarker({
      agentId: args['agent-id'],
      claimId: args['claim-id'],
      sha: args.sha,
    });
  }

  process.stdout.write(`${body}\n`);
}

interface ParsedArgs {
  type: string;
  help: boolean;
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { type: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unknown argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for argument: ${token}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/emit-marker.mjs --type claimed-by --agent-id <id> --claim-id <id> --supersedes <id|none> --timestamp <ISO8601> --branch <name>
  node scripts/emit-marker.mjs --type review-watermark --agent-id <id> --claim-id <id> --head-sha <sha> --max-activity-at <ISO8601|none> --total-item-count <n> --ci-completed-at <ISO8601|none>
  node scripts/emit-marker.mjs --type review-baseline --agent-id <id> --claim-id <id> --sha <sha>

Prints the exact ready-to-post marker body (HTML token + visible note) to
stdout. Emit-only: performs no network write. Post it via the documented
HTTP path. The written marker formats remain the canonical fallback.
`);
}
