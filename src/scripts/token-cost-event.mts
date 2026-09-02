#!/usr/bin/env node
// idd-generated-from: src/scripts/token-cost-event.mts
//
// The scripts/token-cost-event.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood phase-event helper (#2293), called from
// source-repo agent guidelines only (CLAUDE.md / AGENTS.md / GEMINI.md /
// .github/copilot-instructions.md's "Dogfood: token-cost events" note) --
// never from idd-template/ or .github/instructions/, which distribute to
// adopters with no token-cost data to record. Appends one explicit
// phase enter/exit line (schemas/token-cost-event.schema.json) so a later
// harvest can prefer these timestamps over marker-join reconstruction.
// Not registered in HELPER_COMMANDS: a maintainer/CI-only dogfood tool,
// never an adopter-facing helper (see SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts and DOGFOOD_ONLY_CONCRETE_TOOLS
// in tests/helper-runtime-manifest.test.mts).
//
// Fail-open by design: this is called from an agent's own phase-transition
// hook, so a typo'd flag or an unwritable --out path must never block the
// IDD loop it is merely observing. Default mode swallows any failure
// (bad args, schema-invalid event, unwritable path) into a stderr warning
// and exit 0. --strict (tests, and any caller that wants to know) turns
// every one of those into a loud, non-zero-exit failure instead.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCliArgs } from './cli-args.mts';
import type {
  TokenCostEvent,
  TokenCostStageId,
  TokenCostVendor,
} from './token-cost-core.mts';
import { loadJson, validate } from './validate-schemas.mts';

const SCHEMA_PATH = 'schemas/token-cost-event.schema.json';
const DEFAULT_OUT_RELATIVE = join('idd-skill', 'token-cost', 'events.jsonl');

/**
 * `${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/token-cost/events.jsonl`,
 * or `--out`'s explicit override. Never created eagerly -- the caller
 * creates the parent directory right before the one append this process
 * performs.
 */
export function resolveOutPath(
  explicitOut: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitOut) {
    return explicitOut;
  }
  const stateHome =
    env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(stateHome, DEFAULT_OUT_RELATIVE);
}

// Vendor session env vars this helper knows how to auto-derive
// `vendorSessionId` from (#2424). Claude-only for now: `$CLAUDE_CODE_SESSION_ID`
// is a verified real env var whose value matches the session's own
// `~/.claude/projects/<encoded-cwd>/<id>.jsonl` basename exactly (the same
// value `extractSessionId()` reads back out of that file's own records in
// token-cost-adapter-claude.mts). Codex/Grok have no verified equivalent
// yet -- add a row here once one is confirmed, rather than guessing.
const VENDOR_SESSION_ID_ENV_VAR: Readonly<Record<string, string>> = {
  claude: 'CLAUDE_CODE_SESSION_ID',
};

/**
 * Reads the env var mapped to `vendor` (if any) and returns its value,
 * unless it is empty or looks like a filesystem path (`/` or `\` --
 * schemas/token-cost-event.schema.json's own `vendorSessionId` description
 * says "Never a filesystem path"; this stamping step is what has to honor
 * that, since the schema's own type is a bare `["string", "null"]` with no
 * format the validator enforces).
 */
function deriveVendorSessionId(
  vendor: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const envVar = VENDOR_SESSION_ID_ENV_VAR[vendor];
  if (!envVar) {
    return undefined;
  }
  const value = env[envVar];
  if (!value || value.includes('/') || value.includes('\\')) {
    return undefined;
  }
  return value;
}

/**
 * Build one {@link TokenCostEvent} from parsed CLI values and the current
 * time. Throws a plain, human-readable message on any malformed input --
 * the CLI's own try/catch below decides whether that throw is fatal
 * (--strict) or a swallowed warning (default, fail-open). Stage id and
 * vendor are NOT pre-validated against their enums here: {@link validate}
 * against the schema (called by the CLI body, not this function) is the
 * single source of truth for both, so an enum drift between this helper
 * and the schema can never leave one checked and the other not.
 */
export function buildEvent(
  values: Record<string, string | boolean | string[] | boolean[] | undefined>,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): TokenCostEvent {
  const enter = values.enter === true;
  const exit = values.exit === true;
  if (enter === exit) {
    throw new Error('exactly one of --enter or --exit is required');
  }
  const stageId = values.stage;
  if (typeof stageId !== 'string' || stageId.length === 0) {
    throw new Error('--stage is required');
  }
  const vendor = values.vendor;
  if (typeof vendor !== 'string' || vendor.length === 0) {
    throw new Error('--vendor is required');
  }
  const event: TokenCostEvent = {
    schemaVersion: 1,
    event: enter ? 'enter' : 'exit',
    stageId: stageId as TokenCostStageId,
    at: now.toISOString(),
    vendor: vendor as TokenCostVendor,
  };
  const vendorSessionId = deriveVendorSessionId(vendor, env);
  if (vendorSessionId !== undefined) {
    event.vendorSessionId = vendorSessionId;
  }
  const issueRaw = values.issue;
  if (issueRaw !== undefined) {
    if (typeof issueRaw !== 'string') {
      throw new Error('--issue must be a single value');
    }
    const issueNumber = Number(issueRaw);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`--issue must be a positive integer, got "${issueRaw}"`);
    }
    event.issueNumber = issueNumber;
  }
  return event;
}

/**
 * Validate `event` against the committed schema and append it as one
 * JSONL line to `outPath`, creating the parent directory first. Throws on
 * either a schema violation or a filesystem failure (unwritable path,
 * missing permissions) -- the caller decides whether that throw is fatal.
 */
export function writeEvent(event: TokenCostEvent, outPath: string): void {
  const schema = loadJson(SCHEMA_PATH);
  const errors = validate(event, schema);
  if (errors.length > 0) {
    throw new Error(`event fails schema validation: ${errors.join('; ')}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const TOKEN_COST_EVENT_FLAG_SPEC = {
  '--stage': { type: 'string' },
  '--enter': { type: 'boolean', default: false },
  '--exit': { type: 'boolean', default: false },
  '--issue': { type: 'string' },
  '--vendor': { type: 'string' },
  // Accepted for CLI-surface symmetry with the calling convention this
  // issue's own sketch shows -- not persisted, since
  // schemas/token-cost-event.schema.json has no field for an IDD claim id
  // (distinct from vendorSessionId, the AI vendor's own session
  // identifier).
  '--claim-id': { type: 'string' },
  '--out': { type: 'string' },
  '--strict': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/token-cost-event.mjs --stage <id> --enter [options]
  node scripts/token-cost-event.mjs --stage <id> --exit [options]

  --stage <id>      IDD stage id: discover, claim, work, submit-pr,
                     review, merge, cleanup. Required.
  --enter / --exit   Exactly one is required.
  --issue <n>        Issue number, when this event is issue-scoped.
  --vendor <v>       Agent vendor: grok, claude, or codex. Required.
  --claim-id <id>    Accepted for calling-convention symmetry; not
                      persisted (no schema field for it).
  --out <path>       JSONL append target (default:
                     \${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/token-cost/events.jsonl).
  --strict           Exit non-zero on any failure instead of the default
                     fail-open warning-and-exit-0 behavior.
  --now <ISO8601>    Override the current time (tests only).
  --help, -h         Show this help.

For --vendor claude, vendorSessionId is auto-derived from
$CLAUDE_CODE_SESSION_ID when set -- no flag needed. No equivalent env var
is known yet for grok or codex.

Fail-open by default: a bad flag, a schema-invalid event, or an
unwritable --out path prints a stderr warning and exits 0, so a
forgotten or misconfigured hook never blocks the IDD loop. Pass
--strict to turn every one of those into a non-zero exit instead.
`);
}

if (import.meta.main) {
  // Decided before parseCliArgs runs, from the raw argv, so a parse
  // failure itself (unknown flag, missing value) still respects
  // --strict -- the flag whose own presence that same parse call would
  // otherwise be needed to report.
  const strict = process.argv.slice(2).includes('--strict');
  try {
    const { values, help } = parseCliArgs(
      process.argv.slice(2),
      TOKEN_COST_EVENT_FLAG_SPEC,
    );
    if (help) {
      printHelp();
      process.exit(0);
    }
    let now = new Date();
    if (values.now) {
      now = new Date(values.now as string);
      if (Number.isNaN(now.getTime())) {
        throw new Error(
          `--now is not a valid ISO8601 timestamp: ${values.now as string}`,
        );
      }
    }
    const event = buildEvent(values, now);
    const outPath = resolveOutPath(values.out as string | undefined);
    writeEvent(event, outPath);
    process.stdout.write(`token-cost-event: wrote ${outPath}\n`);
  } catch (error) {
    const message = (error as Error).message;
    if (strict) {
      process.stderr.write(`token-cost-event: ${message}\n`);
      process.exit(1);
    }
    process.stderr.write(`token-cost-event: warning: ${message}\n`);
    process.exit(0);
  }
}
