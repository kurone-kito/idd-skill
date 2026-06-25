#!/usr/bin/env node
// idd-generated-from: src/scripts/post-idd-marker.mts
//
// The scripts/post-idd-marker.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Write-side companion to emit-marker (#1047). IDD operational markers are
// HTML-comment-first, so an agent must POST them as a JSON body — the
// `gh issue comment` / `gh api -f body=` paths silently reject HTML-only
// bodies. This helper renders the canonical body for each operational marker
// type (reusing the single-sourced protocol-helpers renderers so formats are
// not duplicated) and POSTs it via the reliable JSON path.
//
// It is a single-marker render+POST primitive with NO claim/state gating, by
// design (the emit-marker philosophy). The calling phase runs its
// claim-revalidation gate immediately before invoking `--apply`, exactly as the
// manual POST path it replaces already requires.
import { execFileSync } from 'node:child_process';
import {
  renderAdvisoryWaitMarker,
  renderAdvisoryWaitRecoveryMarker,
  renderClaimedByMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
  renderUnclaimedByMarker,
} from './protocol-helpers.mjs';
export const MARKER_TYPES = [
  'claim',
  'unclaim',
  'watermark',
  'baseline',
  'advisory',
  'advisory-recovery',
];
export const TARGET_KINDS = ['issue', 'pr'];
/**
 * Build the canonical ready-to-post body for one operational marker type.
 * Pure and network-free: it dispatches to the single-sourced protocol-helpers
 * renderer for `type`, so the body stays byte-identical to what emit-marker and
 * the written marker formats produce. Throws on an unknown type or an invalid
 * field set (the renderer's own validation).
 */
export function buildMarkerBody(type, fields) {
  switch (type) {
    case 'claim':
      return renderClaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        supersedes: fields.supersedes,
        timestamp: fields.timestamp,
        branch: fields.branch,
      });
    case 'unclaim':
      return renderUnclaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        timestamp: fields.timestamp,
      });
    case 'watermark':
      return renderReviewWatermarkMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        headSha: fields['head-sha'],
        maxActivityAt: fields['max-activity-at'],
        totalItemCount: fields['total-item-count'],
        ciCompletedAt: fields['ci-completed-at'],
      });
    case 'baseline':
      return renderReviewBaselineMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        sha: fields.sha,
      });
    case 'advisory':
      return renderAdvisoryWaitMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'advisory-recovery':
      return renderAdvisoryWaitRecoveryMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    default:
      throw new Error(
        `--type is required and must be one of: ${MARKER_TYPES.join(', ')}`,
      );
  }
}
export function parseArgs(argv) {
  const args = {
    type: '',
    target: '',
    number: null,
    apply: false,
    owner: '',
    repo: '',
    help: false,
    fields: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--apply') {
      args.apply = true;
      continue;
    }
    if (!token.startsWith('--')) {
      // The sole positional argument is the issue/PR number.
      if (args.number !== null) {
        throw new Error(`unexpected positional argument: ${token}`);
      }
      const parsed = Number.parseInt(token, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`invalid issue/PR number: ${token}`);
      }
      args.number = parsed;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for argument: ${token}`);
    }
    index += 1;
    if (token === '--type') {
      args.type = value;
    } else if (token === '--target') {
      args.target = value;
    } else if (token === '--owner') {
      args.owner = value;
    } else if (token === '--repo') {
      args.repo = value;
    } else {
      // Any other --flag is a renderer field, stored under its kebab name.
      args.fields[token.slice(2)] = value;
    }
  }
  return args;
}
const USAGE = `usage: node scripts/post-idd-marker.mjs --type <type> --target <issue|pr> <number> [field flags...] [--apply]

Render the canonical HTML-comment-first body for an IDD operational marker
(advisory markers are plain-text per the AW3 protocol) and POST it via the
reliable JSON path. Default mode is dry-run (prints the body); --apply posts it.
This helper performs no claim/state gating — the calling phase must run its
claim-revalidation gate before --apply, as the manual POST path it replaces does.

  --type <type>        one of: ${MARKER_TYPES.join(', ')}
  --target <issue|pr>  the comment target kind (both use the issues comments API)
  <number>             issue or PR number (positional, required)
  --apply              POST the marker (default: dry-run, print the body)
  --owner <owner>      repo owner (default: gh repo view)
  --repo <repo>        repo name (default: gh repo view)
  -h, --help           show this help

Per-type field flags:
  claim              --agent-id --claim-id --supersedes --timestamp --branch
  unclaim            --agent-id --claim-id --timestamp
  watermark          --agent-id --claim-id --head-sha --max-activity-at --total-item-count --ci-completed-at
  baseline           --agent-id --claim-id --sha
  advisory           --agent-id --head-sha --timestamp
  advisory-recovery  --agent-id --head-sha --timestamp
`;
function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}
/**
 * POST the marker body as a JSON document (`{"body": …}`) read from stdin via
 * `gh api --input -`. The JSON path is mandatory because HTML-comment-first
 * bodies are silently dropped by `gh issue comment` / `gh api -f body=`.
 *
 * Both `--target issue` and `--target pr` POST to the same
 * `repos/{owner}/{repo}/issues/{number}/comments` endpoint (a PR is an issue
 * for the comments API); `target` is descriptive-only and never changes routing.
 */
function postMarker(owner, repo, number, body) {
  const out = execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${owner}/${repo}/issues/${number}/comments`,
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body }), encoding: 'utf8' },
  );
  return JSON.parse(out);
}
function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return moduleUrl === `file://${entry}` || moduleUrl.endsWith(entry);
}
if (isMainModule(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
    throw error;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!MARKER_TYPES.includes(args.type)) {
    process.stderr.write(
      `--type is required and must be one of: ${MARKER_TYPES.join(', ')}\n`,
    );
    process.exit(1);
  }
  if (!TARGET_KINDS.includes(args.target)) {
    process.stderr.write(
      `--target is required and must be one of: ${TARGET_KINDS.join(', ')}\n`,
    );
    process.exit(1);
  }
  if (args.number === null) {
    process.stderr.write('a positional issue/PR <number> is required\n');
    process.exit(1);
  }
  let body;
  try {
    body = buildMarkerBody(args.type, args.fields);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
    throw error;
  }
  const number = args.number;
  if (!args.apply) {
    const result = {
      mode: 'dry-run',
      type: args.type,
      target: args.target,
      number,
      body,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const posted = postMarker(owner, repo, number, body);
  const result = {
    mode: 'apply',
    type: args.type,
    target: args.target,
    number,
    commentId: posted.id,
    url: posted.html_url,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
