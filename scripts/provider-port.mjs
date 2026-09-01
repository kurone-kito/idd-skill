// idd-generated-from: src/scripts/provider-port.mts
//
// The scripts/provider-port.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Provider port (#2266): the actual operation surface a domain helper
// (discovery, claim, resume, roadmap-audit, permission flows) calls instead
// of invoking `gh` or a GitHub endpoint directly. Builds on the vocabulary
// `provider-contract.mts` (#2265) already names (capability groups, error
// categories) without changing that module. This file is pure types --
// the `ProviderPort` interface and its method-shape types -- no
// `gh`/network/subprocess code lives here. The GitHub implementation is
// `provider-adapter-github.mts`; the in-memory test implementation is
// `provider-adapter-fake.mts`.
//
// A method exists per today's DISTINCT existing call shape, not per
// "logical operation" -- two existing call sites that answer a similar
// question with different queries, pagination, or failure semantics get
// two separate methods, never one shared method with a flag. Unifying
// call shapes is a follow-up concern; this migration only moves transport.
//
// Sync by design, no blanket Promise-ification: every existing `gh`
// invocation this port replaces is `execFileSync`-backed and synchronous,
// and several consumers call into sync-only call chains a Promise-returning
// method cannot satisfy -- e.g. `collaborator-permission.mts`'s
// `resolveTrustedCollaboratorMarkerLogins` calls the permission lookup
// inside a synchronous `Array.filter()` callback, which structurally
// cannot `await`. An async variant is added additively, not retrofitted
// onto the sync methods, where a real consumer genuinely needs one --
// `discover-roadmap-graph.mts`'s bounded-concurrency traversal (step 12,
// `mapPool`-driven) does: its issue/sub-issue loaders run several `gh`
// subprocesses in flight at once via the non-blocking `ghTextAsync`, which
// the synchronous `execFileSync`-backed methods above cannot express
// (they would serialize the fan-out). The `*Async` methods below are that
// addition -- traversal-only, not a general async surface.
export {};
