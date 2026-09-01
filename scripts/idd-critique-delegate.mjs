#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-critique-delegate.mts
//
// The scripts/idd-critique-delegate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Deterministic, network-free helper for the C1 critique-delegate verdict
// (#2329). Delegates entirely to the existing exported resolvers --
// `resolveEffectiveCritiqueLoopDelegateFromEnv` (idd-config.mts), which in
// turn calls `resolveEffectiveCritiqueLoopDelegate` / `parseCritiqueLoopDelegate`
// (policy-helpers.mts) -- and only maps their result onto a CLI-friendly
// shape. No validation rule (key-set, own-property, whitespace, mode-enum,
// parent-object, or config-root check) is reimplemented here; this file
// exists so a lite-profile session never has to restate that contract in
// prose, per `idd-work-lite.instructions.md` C1.
import { parseCliArgs } from './cli-args.mjs';
import { resolveEffectiveCritiqueLoopDelegateFromEnv } from './idd-config.mjs';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `policy:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --policy spec key
// below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const IDD_CRITIQUE_DELEGATE_FLAG_SPEC = {
  '--policy': { type: 'string' },
  '--no-user-global': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
// Also declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason as the flag spec above: buildCritiqueDelegateReport
// reads this synchronously from the trigger's runCli() call.
const NO_DELEGATE_REASONS = {
  disabled: 'repository-local-explicit-disable',
  none: 'not-configured',
};
if (import.meta.main) {
  runCli();
}
/**
 * `docs/idd-workflow.md`'s "User-global critique delegate default" contract
 * is that "a GitHub-hosted or other remote agent surface has no such
 * operator home directory and never consults this layer" -- true only by
 * environmental happenstance for the written prose contract (a remote
 * runner simply has no such file to find), but this helper calls the
 * global-file lookup unconditionally, so an environment that happens to
 * carry a stray `$HOME`/`$XDG_CONFIG_HOME` config would silently violate
 * that contract. `GITHUB_ACTIONS` is the one remote surface this
 * repository already has a concrete, tested signal for (see
 * `advisory-convergence.mts`) and is auto-detected; `noUserGlobal` is the
 * caller-controlled escape hatch for every other remote surface a caller
 * recognizes about its own deployment but this helper cannot infer from a
 * single provider variable (#2329 review).
 */
function isRemoteAgentSurface(env) {
  return env.GITHUB_ACTIONS === 'true';
}
/**
 * Build the C1 verdict from the layered resolver's result. Pure mapping:
 * `status`/`source`/`delegate`/`reason` come from
 * {@link resolveEffectiveCritiqueLoopDelegateFromEnv} unchanged; this
 * function only decides `usable` and fills in a machine-readable `reason`
 * for the two unusable statuses that resolver leaves reason-less
 * (`disabled`, `none`) so a caller never sees a bare `null`.
 */
export function buildCritiqueDelegateReport(options, noUserGlobal = false) {
  const env = options?.env ?? process.env;
  const resolvedOptions =
    noUserGlobal || isRemoteAgentSurface(env)
      ? { ...options, env: {} }
      : options;
  const effective =
    resolveEffectiveCritiqueLoopDelegateFromEnv(resolvedOptions);
  const usable = effective.status === 'local' || effective.status === 'global';
  return {
    usable,
    source: effective.source,
    command: usable ? (effective.delegate?.command ?? null) : null,
    mode: usable ? (effective.delegate?.mode ?? null) : null,
    reason: usable
      ? null
      : (effective.reason ??
        NO_DELEGATE_REASONS[effective.status] ??
        effective.status),
  };
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const report = buildCritiqueDelegateReport(
    args.policy ? { localPolicyPath: args.policy } : undefined,
    args.noUserGlobal,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, IDD_CRITIQUE_DELEGATE_FLAG_SPEC);
  return {
    policy: values.policy ?? '',
    noUserGlobal: values['no-user-global'],
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-critique-delegate.mjs [--policy <path>] [--no-user-global]

Resolves the effective C1 critique-loop delegate the same way
resolveEffectiveCritiqueLoopDelegate does: repository-local
.github/idd/config.json's critiqueLoop.delegate wins outright (a
configured object, an explicit null disable, or a malformed value all
stop there); only when it is entirely absent does an optional
user-global $XDG_CONFIG_HOME/idd-skill/config.json (or
$HOME/.config/idd-skill/config.json) fragment apply; absent both, no
delegate is usable. Under GITHUB_ACTIONS=true the user-global layer is
always skipped, matching the documented remote-agent-surface contract;
pass --no-user-global to skip it explicitly on any other remote surface
the caller recognizes but this helper cannot auto-detect. Deterministic
and network-free; reads only local files under --policy's path
resolution and the user-global path resolution already defined in
idd-config.mts.

Output schema:
{
  "usable": true,
  "source": "repository-local|user-global|none",
  "command": "..." | null,
  "mode": "fallback|combined|on-success|never" | null,
  "reason": null | "repository-local-explicit-disable|invalid-repository-local-delegate|not-configured"
}

usable: false means run the per-agent critique pass instead; reason is
then always a non-null machine-readable string. usable: true means
command/mode are both non-null and reason is null.
`);
}
