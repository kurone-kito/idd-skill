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

import { requireFlag, stripLeadingArgumentSeparator } from './cli-args.mts';
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

  // #1722: validate every flag THIS marker type requires, by name, before
  // the renderer ever sees the payload -- previously only --type was
  // checked here, so a missing per-type flag (e.g. --timestamp for
  // claimed-by) fell through to the renderer's own aggregate guard, which
  // reports only an unattributed "invalid ... marker payload" with no
  // indication of which flag was absent. requireFlag (cli-args.mts) reports
  // the exact missing flag, matching the shape the --type check above
  // already uses. --supersedes / --max-activity-at / --ci-completed-at are
  // deliberately NOT required here: the renderers themselves default an
  // absent or empty value to the `none` sentinel, so requiring them here
  // would reject input the renderer accepts. The renderer's own aggregate
  // guard stays in place as defense-in-depth for any other direct caller of
  // renderClaimedByMarker / renderReviewWatermarkMarker /
  // renderReviewBaselineMarker (e.g. protocol-helpers.mts consumers outside
  // this CLI).
  let body: string;
  if (type === 'claimed-by') {
    body = renderClaimedByMarker({
      agentId: requireFlag(args['agent-id'], '--agent-id'),
      claimId: requireFlag(args['claim-id'], '--claim-id'),
      supersedes: args.supersedes,
      timestamp: requireFlag(args.timestamp, '--timestamp'),
      branch: requireFlag(args.branch, '--branch'),
    });
  } else if (type === 'review-watermark') {
    body = renderReviewWatermarkMarker({
      agentId: requireFlag(args['agent-id'], '--agent-id'),
      claimId: requireFlag(args['claim-id'], '--claim-id'),
      headSha: requireFlag(args['head-sha'], '--head-sha'),
      maxActivityAt: args['max-activity-at'],
      totalItemCount: requireFlag(
        args['total-item-count'],
        '--total-item-count',
      ),
      ciCompletedAt: args['ci-completed-at'],
    });
  } else {
    body = renderReviewBaselineMarker({
      agentId: requireFlag(args['agent-id'], '--agent-id'),
      claimId: requireFlag(args['claim-id'], '--claim-id'),
      sha: requireFlag(args.sha, '--sha'),
    });
  }

  process.stdout.write(`${body}\n`);
}

interface ParsedArgs {
  type: string;
  help: boolean;
  [key: string]: string | boolean;
}

// Excluded from the #1446 cli-args.mts wrapper: this parser collects
// dynamic, marker-type-dependent keys into an index-signature bag
// (`[key: string]: string | boolean` above) rather than a fixed set of
// declared flags. `util.parseArgs`'s `strict: true` rejects any option not
// named in its static spec, and `strict: false` would instead coerce every
// unrecognized flag to `true` -- neither matches this file's "accept
// whatever field this marker type needs" contract.
function parseArgs(rawArgv: string[]): ParsedArgs {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
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
