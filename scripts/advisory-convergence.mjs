#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-convergence.mts
//
// The scripts/advisory-convergence.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Read-only policy-engine helper (#1340): deterministically asserts whether
// the primary advisory bot's ("Copilot's") review has *converged* on the
// current PR HEAD -- see issue #1340 and roadmap #1342. This closes a gap
// where the existing evidence collectors (`pre-merge-readiness.mjs`,
// `review-disposition-verify.mjs`, `advisory-wait-state.mjs`) report JSON
// for the model to interpret, but no single helper asserts the invariant
// with a hard exit code.
//
// Reuse map (no duplicated review-parsing logic):
//   - `readAdvisoryPrimaryBotLogin` / `resolveAdvisoryPrimaryBotLogin` --
//     Copilot identity resolution.
//   - `resolveAdvisoryBotLogins`, `resolveTrustedMarkerActors` -- the same
//     trust/identity resolution every other helper uses.
//   - `resolveLatestCopilotReviewClause`, `fetchReviewsAndHeadCommit`,
//     `isVerifiedCopilotAuthor` (which itself reuses
//     `isCopilotReviewerLogin`'s login-string check) -- the latest-review
//     Clause 1 evidence, extracted to `review-clause.mts` (#1806) so
//     `rerun-advisory-convergence.mts` can reuse the exact same evidence
//     for its own live-coverage recovery signal, without importing this
//     whole file.
//   - `summarizeDispositionEvidenceForGate` -- reused UNFILTERED for
//     per-thread disposition-marker validity; this file only adds a thin
//     Copilot-authorship filter on top of its `missingThreads` output.
//   - `summarizeClaimValidation`, `summarizeExternalCheckWaivers` -- reused
//     verbatim for the deadline/waiver escape hatch, auto-discovering the
//     PR's linked issue exactly as `external-check-waiver.mts`'s own
//     `--apply` path already does, so no claim flag is required to call
//     this helper (`--pr <n> --assert` is sufficient -- see docs).
//   - `resolveCollaboratorMarkerTrust`, `isAuthorizedForcedHandoffActor`,
//     `operationalMarkerPrefix` -- reused, matching `pre-merge-readiness.mts`
//     exactly (#1344), to thread forced-handoff-aware claim resolution and
//     collaborator-marker trust into the same `summarizeClaimValidation`
//     call above, so this gate does not disagree with the sibling F2/F3
//     helpers when a repository opts into either (both stay no-ops
//     otherwise).
//
// This helper never mutates GitHub state: it only reads PR/review/thread/
// comment data and prints a verdict.
//
// #1511: bounded same-HEAD advisory reroll evidence. `itemCount` (Clause 1
// above) is a STATIC snapshot of the primary bot's review comment count at
// submission time -- rejecting/resolving those items in triage never
// changes it, so `converged` can stay false PERMANENTLY on a HEAD the bot
// has already reviewed, even once every one of its findings has a valid
// disposition. The `sameHeadReroll` field group below surfaces exactly
// when that residual is the ONLY thing blocking convergence, plus a
// bounded counter (backed by a distinct `advisory-reroll:` marker, kept
// separate from the advisory-wait `REQUEST_CAP`) so instructions (AW6 in
// idd-advisory-wait.instructions.md, invoked only from F2) can request a
// few fresh same-HEAD re-reviews before falling through to the existing
// deadline+waiver/hold backstop. This is PURELY ADDITIVE evidence:
// `converged`/`waived`/`ready` below are computed with ZERO reference to
// `sameHeadReroll.*` (see the tests asserting this), so the carve-out can
// never let the gate pass on anything other than the primary bot's own
// real signal -- it only tells a caller when requesting a reroll is safe
// and how much budget remains.
//
// #2015: bounded poll for the "not reviewed yet" race. The hosting
// workflow's `pull_request`/`pull_request_target` `synchronize` trigger
// fires the instant a push lands, well before the primary bot's own
// review typically lands (10-40s later) -- originally via the separate
// `pull_request_review` trigger the hosting workflow declared directly;
// #2764 Phase 1 moved that trigger to a companion workflow instead (a
// same-repository PR could otherwise edit the required workflow's own
// copy to control when its review-triggered run re-asserted), but the
// timing gap this poll exists for is unchanged, since the push-triggered
// run still starts immediately regardless of where the review's own
// signal now arrives from -- so a push that also needs a fresh review
// used to get asserted, and fail, before that review existed, costing an
// external rerun most of the time. The CLI entry point at the bottom of
// this file now runs through `runAdvisoryConvergenceWithPoll` instead of
// `runAdvisoryConvergence` directly: when (and ONLY when) the verdict's
// sole blocking reason is that the primary bot has not reviewed the PR AT
// ALL yet (`isSoleCopilotNotReviewedYetReason` -- excludes a stale-HEAD
// review, unresolved threads, an indeterminate claim scope, or any other
// reason, all of which still fail immediately with no wait, exactly as
// before), it polls a short, bounded window (every
// `DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS`, up to
// `DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS` total, wall-clock bounded --
// see `runAdvisoryConvergenceWithPoll`'s own doc comment) before its real
// assert-driven exit. This changes nothing about `--assert`'s exit-code
// contract, roadmap #1342's deterministic-convergence policy, or this
// check's required/fail-closed/non-bypassable nature: if the review still
// has not landed by the end of the window, or lands with outstanding
// items, the job fails exactly as it always has. See
// `runAdvisoryConvergenceWithPoll`'s own doc comment for a known residual
// (PR #2023 review): a review landing WHILE this poll is asleep can still
// need the pre-existing external-rerun recovery, via a different
// mechanism (this run gets cancelled by the hosting workflow's own
// concurrency group, not a plain immediate-assert failure) -- the poll's
// actual win is narrower than "never needs a rerun again."
import { readFileSync } from 'node:fs';
import {
  advisoryWaitSectionIsValid,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP,
  DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySameHeadRerollCap,
  readAdvisoryWaitPolicy,
  resolveEffectiveAdvisoryTerminalWindowMinutes,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from './advisory-wait-policy.mjs';
import { buildCopilotRecoverySummary } from './advisory-wait-state.mjs';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mjs';
import {
  normalizeAuthorityEvidence,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  digestExternalCheckWaiverMarkerBody,
  isValidIsoTimestamp,
  parseClaimComment,
  parseExternalCheckWaiverComment,
} from './marker-helpers.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
import {
  compareIsoTimestamps,
  DEFAULT_STALE_AGE_MS,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
  summarizeDispositionEvidenceForGate,
  summarizeExternalCheckWaivers,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
import { evaluateProviderCapabilityOutcome } from './provider-contract.mjs';
import {
  evaluateProviderOutageRelief,
  resolveProviderOutageDeclaration,
} from './provider-outage-declaration.mjs';
import {
  fetchReviewsAndHeadCommit,
  isVerifiedCopilotAuthor,
  resolveLatestCopilotReviewClause,
} from './review-clause.mjs';
import { loadJson, validateConfigSection } from './validate-schemas.mjs';
/** The external-check-waiver selector this gate recognizes (documented in
 * docs/idd-helper-scripts.md and docs/policy-constants.md; #1341's required
 * check is expected to register under the same name). #1570: re-exported
 * from the shared `advisory-wait-policy.mts` constant (rather than declared
 * standalone) so `protocol-helpers.mts`'s `buildPreMergeReadinessSummary`
 * can filter terminal-unavailability waiver evidence by the identical
 * selector string without importing this module (which would create an
 * import cycle back through `advisory-wait-state.mts`). The exported name
 * and value are unchanged for existing consumers. */
export const ADVISORY_CONVERGENCE_CHECK_SELECTOR =
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR;
/** kurone-kito/idd-skill#2657: the committed allowlist of paths whose own
 * edit lets `idd-advisory-convergence.yml` auto-post a scoped
 * `self-referential-bootstrap-auto` waiver for the PR that edits them --
 * the narrow trigger set the Background section requires (an
 * import-derived set would auto-waive most PRs, since this gate's own
 * script transitively imports several of the most-edited files in the
 * repository). A hand-curated set, and exactly this SOURCE REPOSITORY's
 * own trigger set: this repository's own top-level
 * `.github/workflows/idd-advisory-convergence.yml` hardcodes these same
 * paths directly (its own checker files are these exact `.mts` sources,
 * regardless of its own configured `helperRuntime.profile`), and
 * {@link resolveSelfReferentialTriggerFiles} below returns this constant
 * only when `repositoryFullName` resolves to this repository. Every
 * other repository resolves a profile-derived set instead (Codex +
 * Copilot review, PR #2895): this repository's own `src/scripts/*.mts`
 * sources are never vended to a `vendored-node`/`package-manager`
 * adopter, so using this list unconditionally for the DISTRIBUTED
 * `idd-template/` copy left the mechanism both non-functional (a
 * genuine checker upgrade could never match a path that never exists in
 * the adopter's own checkout) and gameable (a PR could touch that
 * nonexistent path purely to satisfy the string match).
 * `marker-helpers.mts`/`protocol-helpers.mts`/`provider-adapter-github.mts`
 * joined this set across this same review (Codex, PR #2895):
 * `advisory-convergence.mts` directly imports the marker parser/renderer,
 * the waiver summarizer, and the `getWorkflowRun`/
 * `listChangeRequestChangedFiles` GitHub adapter calls the trust path
 * itself invokes, from these three files respectively -- a checker
 * repair isolated to any one of them (exactly what this PR's own
 * earlier commits did, across all three, to implement `run-id:` and the
 * independent allowlist check) must also be able to trigger this
 * bypass, or it recreates the very deadlock this mechanism exists to
 * solve. This is a deliberately bounded set of DIRECT, waiver-path-
 * specific dependencies, not every file `advisory-convergence.mts`
 * imports for its OTHER, unrelated verdict logic (deadline, terminal
 * state, disposition evidence, ...) -- `policy-helpers.mts` and
 * `collaborator-permission.mts` in particular are explicitly excluded,
 * per the issue's own background, as high-edit-contention files shared
 * by many unrelated consumers. Widening this set is a reviewed edit to
 * the constant, never automatic.
 *
 * `.github/idd/config.json` joined this set later still (Codex review,
 * PR #2895, round 10): this repository's own `ciGate`/`advisoryWait`
 * policy inputs live there too, same as for every other repository's
 * own profile-derived set below, and a repair to this repository's own
 * policy configuration deserves the same bootstrap this list already
 * grants its `.mts` sources.
 *
 * kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 9): being in
 * this allowlist does NOT mean every possible bug in these files can be
 * self-bootstrapped -- an inherent, narrow dead zone remains, and always
 * will, by the same trusted-checkout design this mechanism itself
 * depends on (both the posting job and this verdict job check out the
 * repository's default branch, never the PR head -- see the workflow's
 * own header comment for why: executing PR-controlled code with
 * `issues: write` would defeat the whole point of `pull_request_target`).
 * A bug specifically WITHIN the code that decides whether/how to invoke
 * `--auto-bootstrap` (`runExternalCheckWaiver`'s own auto-bootstrap
 * branches and `planExternalCheckWaiver`'s `autoBootstrap`-gated
 * checks, both in `external-check-waiver.mts`), the four Actions-API
 * methods the trust chain itself calls (`getWorkflowRun`,
 * `getWorkflowRunJobs`, `listWorkflowRunArtifacts`,
 * `listChangeRequestChangedFiles` in `provider-adapter-github.mts`), or
 * this file's own verification functions
 * ({@link verifySelfReferentialBootstrapWaiverRun},
 * {@link verifySelfReferentialBootstrapWaiverProvenance},
 * {@link verifySelfReferentialBootstrapWaiverArtifactBinding},
 * {@link resolveSelfReferentialTriggerFiles}, `autoWaiverValid`) cannot
 * be rescued by THIS mechanism, because the OLD, buggy version of
 * exactly that code is what would have to decide to trust the fix --
 * the same fixed point every self-hosting bootstrap has (compiling a
 * fixed compiler bug still needs the old, broken compiler for the first
 * build). Isolating marker emission into a smaller module would shrink
 * this dead zone, never eliminate it, and is out of scope here. The
 * REST of each listed file's surface (which is most of it -- each
 * implements far more than this one trust path) remains genuinely
 * bootstrappable exactly as advertised above. For the residual case,
 * this repository's existing `ciGate.externalCheckWaivers.mode:
 * "maintainer-authorized"` backstop (AGENTS.md's "Advisory-convergence
 * waiver backstop" bullet) is the documented human off-ramp for
 * precisely "the autonomous advisory-convergence loop cannot converge
 * on its own" -- not a gap this constant needs to also close.
 *
 * kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 16): a
 * SEPARATE, narrower residual gap in {@link verifySelfReferentialBootstrapWaiverRun}
 * itself -- its `run-id:` check proves only that the CITED run has the
 * right path/head-sha/repository/event, never that the cited run is the
 * one that actually POSTED this specific comment. A same-repository
 * `pull_request`-triggered workflow with `issues: write` (the same actor
 * this file's own comments already assume can post arbitrary
 * `github-actions[bot]`-authored comments) can discover a legitimate,
 * concurrently running `pull_request_target` run of THIS workflow for
 * its own PR and cite that run's id in a forged marker -- the run-id is
 * bearer evidence, not provenance-bound. This does NOT widen what such a
 * forgery can actually waive, though: `touchesSelfReferentialAllowlist`
 * is fetched independently from the PR's own live file-changes API,
 * never from the comment, so a forged marker can only cause a PR that
 * genuinely touches the allowlist to get its (otherwise-legitimate)
 * waiver via forgery instead of via the real job -- the allowlist check
 * remains the load-bearing security boundary. The one CONCRETE exploit
 * this bearer-evidence gap enabled -- a forged `claim-id:none` marker
 * validating on a PR whose closing issues expose ambiguous, multiple
 * active claims, a state the posting helper itself always refuses to
 * post ANY marker for -- was closed directly in `autoWaiverValid`'s own
 * `claimCandidateAmbiguous` check below.
 *
 * kurone-kito/idd-skill#2912 (round 1): the general provenance-binding
 * gap the paragraph above described was first closed by
 * {@link verifySelfReferentialBootstrapWaiverProvenance} (proving the
 * cited run's own job actually executed the posting step, within a few
 * seconds of this specific comment's `createdAt`) paired with a
 * duplicate-run-id uniqueness check: no OTHER candidate marker citing
 * the same run id may ALSO independently pass that same provenance
 * check, scoped to provenance-PASSING candidates only so a legitimate
 * `gh run rerun <run-id>` (this repository's own standard automated
 * recovery path for a stuck `idd-advisory-convergence` instance,
 * `rerun-advisory-convergence.mts`) keeps working: its second, equally
 * genuine marker no longer shares the first attempt's window, so the
 * stale sibling fails provenance on its own rather than being
 * misclassified as a forgery collision.
 *
 * kurone-kito/idd-skill#2912 (round 2): that round-1 uniqueness check
 * had its own gap -- it trusted "no OTHER candidate is CURRENTLY
 * VISIBLE", a property an attacker with `issues: write` can falsify
 * after the fact by deleting the genuine marker once it posts (that
 * scope permits deleting ANY issue comment on the repository, not only
 * ones the deleting token itself authored), leaving a forged sibling as
 * the sole survivor of the next scan (independently found by both the
 * Codex and Copilot reviews of PR #2914). {@link verifySelfReferentialBootstrapWaiverArtifactBinding}
 * replaces the visibility-based uniqueness check with a positive-binding
 * one: the cited run's own trusted job execution now uploads a
 * run-scoped Actions artifact naming the exact comment id it posted
 * ({@link SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX}), and a marker
 * only validates when it IS that exact, artifact-named comment.
 * Artifacts are scoped to the run that uploaded them by the Actions
 * runtime's own dedicated upload token, never by the shared
 * `GITHUB_TOKEN` `permissions:` surface comments (and check runs, which
 * share the same "any same-repository workflow can mutate them"
 * exposure) are created and mutated through, so no unrelated run can
 * add, edit, or remove an entry from that trusted set regardless of
 * which `permissions:` it self-grants. Deleting the genuine comment now
 * only removes it from the LIVE candidate scan the correlation step
 * needs -- degrading this mechanism to "no auto-waiver" (fail closed),
 * never "the forged one wins". {@link verifySelfReferentialBootstrapWaiverProvenance}'s
 * window check remains in place as defense in depth (and still does the
 * rerun-disambiguation work described above); the round-1 duplicate-
 * timestamp-count mechanism it used to pair with has been removed
 * entirely, subsumed by the strictly stronger artifact binding. The one
 * residual this round does NOT close: an attacker who additionally
 * self-grants the broader, repository-wide `actions: write` permission
 * could delete the genuine run's artifact through Actions' own
 * artifact-management endpoint -- still only "no auto-waiver", never a
 * forged one, and outside the `issues: write`-scoped threat model both
 * findings (and this fix) are framed against. The pre-existing
 * maintainer-authorized waiver remains the documented escape hatch
 * either way.
 *
 * kurone-kito/idd-skill#2912 (round 3): round 2's artifact binding had
 * its own sibling gap, found by a Copilot review of PR #2914's round-2
 * commit -- it trusted a candidate's comment `id` alone, and `issues:
 * write` permits EDITING an existing issue comment's body in place, not
 * only deleting one, which preserves that comment's `id` AND `createdAt`
 * while replacing its content. An attacker could therefore wait for the
 * genuine marker to post (its `id` becomes artifact-trusted), then edit
 * that SAME comment's body to a forged marker citing the same run id --
 * round 2's check would still accept it, since it never looked at
 * content. {@link verifySelfReferentialBootstrapWaiverArtifactBinding}
 * now binds to the pair (comment `id`, SHA-256 digest of that comment's
 * exact body -- {@link digestExternalCheckWaiverMarkerBody}) rather than
 * `id` alone: the posting job hashes the body it reads back from the
 * GitHub API immediately after posting (`external-check-waiver.mts`'s
 * `ExternalCheckWaiverReport.bodyDigest`) and uploads it as part of the
 * artifact's name (`idd-self-waiver-marker-<comment-id>-<body-digest>`);
 * this consumer hashes the SAME live comment's CURRENT body during its
 * own scan. An edited body digests differently, so the `(id, bodyDigest)`
 * pair no longer matches any trusted binding and correlation fails
 * closed -- exactly the "no auto-waiver" degradation round 2 already
 * guarantees for deletion, now also covering in-place edits. Hashing the
 * body also transitively binds `headSha` and `run-id`, both embedded in
 * it, so an edit that tries to redirect a trusted marker at a different
 * commit or run is caught by the same mechanism, not a separate one. Both
 * sides hash an API-returned body verbatim -- so GitHub-side content
 * normalization (if any) cancels out identically on both sides in the
 * ordinary case, instead of producing a false-negative on a genuine,
 * unedited marker -- see {@link digestExternalCheckWaiverMarkerBody}'s own
 * doc comment for why, and round 4 immediately below for exactly which
 * API-returned body the posting side now hashes.
 *
 * kurone-kito/idd-skill#2912 (round 4): round 3's posting side had its
 * own race, found by a Copilot review of PR #2914's round-3 commit --
 * `ExternalCheckWaiverReport.bodyDigest` preferred a body observed in a
 * LATER, separate post-write re-read (`external-check-waiver.mts`'s own
 * `readPrComments()` reconcile, run for an unrelated reason: detecting a
 * concurrent duplicate waiver) over the body GitHub's create-comment API
 * call itself returned, falling back to the locally-sent string only when
 * that later re-read came up empty. That preference opened the same class
 * of window round 3 closes on THIS consumer's side: a same-repository
 * `issues: write` workflow could edit the genuine comment's body in the
 * interval between the POST returning and that later re-read running, and
 * the posting side would then hash and report the FORGED body as
 * `bodyDigest` -- which this consumer's own live-body scan (reading that
 * SAME, now-edited comment) would then match, validating the edit as if
 * the trusted job had posted it verbatim. Round 4 removes that fallback
 * entirely: the posting side now hashes ONLY the `body` field the
 * create-comment response returns for the exact POST that created the
 * comment -- returned atomically, in the same API call, with no window
 * for an intervening edit -- and reports no `bodyDigest` at all (never
 * substituting a later, mutable read) when that response lacks a body
 * string. This consumer needs no change for round 4: it already hashes
 * the live comment's CURRENT body during its own scan, and a body edited
 * after posting already fails to match the (now correctly
 * POST-response-bound) trusted digest either way.
 *
 * Precondition on "the cited job's step conclusion is `success`"
 * actually implying it posted a marker: `runExternalCheckWaiver`'s own
 * `--auto-bootstrap` path can report step-level `success` on a
 * deliberate no-op skip (never posting) when
 * `ciGate.externalCheckWaivers.mode` is not `maintainer-authorized` or
 * the selector is not registered under
 * `ciGate.externalChecks.waivable` (`external-check-waiver.mts`'s
 * `benignAutoBootstrapSkipReasons` set). This is self-consistent by
 * construction, not a separate gap to close: `summarizeExternalCheckWaivers`
 * gates `.valid` classification on that exact same
 * `mode`/`waivableSelectors` policy, read from the same trusted
 * checkout at consume time -- when the benign-skip path is reachable,
 * no self-referential-bootstrap-auto marker (genuine or forged) ever
 * reaches `.valid` for `autoWaiverValid`'s `.some()` to iterate in the
 * first place, so the step-success-without-posting case never actually
 * gets evaluated for provenance. Still worth stating explicitly, since
 * an adopter who reads only this file's own trust chain (not
 * `external-check-waiver.mts`'s posting-side logic too) could otherwise
 * read "step succeeded" as an unconditional proof of posting. */
export const SELF_REFERENTIAL_WAIVER_TRIGGER_FILES = [
  'src/scripts/advisory-convergence.mts',
  'src/scripts/advisory-wait-state.mts',
  'src/scripts/advisory-wait-policy.mts',
  'src/scripts/rerun-advisory-convergence.mts',
  'src/scripts/external-check-waiver.mts',
  'src/scripts/marker-helpers.mts',
  'src/scripts/protocol-helpers.mts',
  'src/scripts/provider-adapter-github.mts',
  '.github/idd/config.json',
  '.github/workflows/idd-advisory-convergence.yml',
  '.github/workflows/idd-advisory-convergence-comment.yml',
];
/** kurone-kito/idd-skill#2657 (Codex + Copilot review, PR #2895): the
 * source repository's own identity, used ONLY to select
 * {@link SELF_REFERENTIAL_WAIVER_TRIGGER_FILES} as-is for this
 * repository's own required check instead of a profile-derived set --
 * this repository's checker files are its own `.mts` sources regardless
 * of its configured `helperRuntime.profile` (`package-manager`, chosen
 * for its own IDD dependency, not for this workflow's own file layout).
 * A literal repository-identity check inside otherwise-generic
 * distributed code is an intentional, narrow exception, not a pattern to
 * extend -- every other repository-specific behavior in this codebase is
 * config-driven, never an identity check. */
const SELF_REFERENTIAL_ALLOWLIST_ORIGIN_REPOSITORY = 'kurone-kito/idd-skill';
/** kurone-kito/idd-skill#2657 (Codex + Copilot review, PR #2895): the
 * trigger-file allowlist a given repository/profile pair actually
 * verifies against at consume time, mirroring the derivation the
 * distributed `idd-template/` copy of `idd-advisory-convergence.yml`'s
 * own posting-side bash step performs (kept in sync by hand across the
 * two languages/files, the same convention already used for
 * {@link SELF_REFERENTIAL_WAIVER_TRIGGER_FILES} itself). The two
 * workflow paths and the runtime config are both profile-invariant --
 * every profile's own checker version pin lives in one of the four base
 * paths or in the profile-specific paths below. Granularity is
 * deliberately whole-file, matching this repository's own
 * `.mts`-based allowlist: a `package.json` touch for any reason (not
 * only an `idd-skill` dependency bump) satisfies the `package-manager`
 * case, exactly as an unrelated `.mts` edit already satisfies this
 * repository's own case today.
 *
 * kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 8):
 * `.github/idd/config.json` is included for EVERY profile, not only
 * `ephemeral-npx` (whose own checker-version pin lives there via
 * `helperRuntime.packageSpec`) -- both the posting job and this
 * verdict job check out the repository's trusted default branch, never
 * the PR head, so a PR that fixes a broken checker by migrating
 * `helperRuntime.profile` itself (e.g. `package-manager` to
 * `ephemeral-npx`, to work around a broken lockfile/manager
 * detection) resolves the OLD, still-broken profile on both sides.
 * Scoping the config file to only the profile it happens to migrate
 * TO would leave every other profile's own migration-via-config-only
 * fix permanently unable to trigger this bypass -- the same trap this
 * mechanism exists to escape. The config file is itself one of this
 * check's own policy inputs (`ciGate`, `advisoryWait`, `helperRuntime`
 * all live there) regardless of profile, so this is a generalization
 * of an existing category, not a scope-widening exception. */
export function resolveSelfReferentialTriggerFiles(
  helperRuntimeProfile,
  repositoryFullName,
) {
  if (
    String(repositoryFullName ?? '').toLowerCase() ===
    SELF_REFERENTIAL_ALLOWLIST_ORIGIN_REPOSITORY
  ) {
    return SELF_REFERENTIAL_WAIVER_TRIGGER_FILES;
  }
  const basePaths = [
    '.github/idd/config.json',
    '.github/workflows/idd-advisory-convergence.yml',
    '.github/workflows/idd-advisory-convergence-comment.yml',
  ];
  switch (helperRuntimeProfile) {
    case 'vendored-node':
      return [
        'scripts/advisory-convergence.mjs',
        'scripts/advisory-wait-state.mjs',
        'scripts/advisory-wait-policy.mjs',
        'scripts/rerun-advisory-convergence.mjs',
        'scripts/external-check-waiver.mjs',
        'scripts/marker-helpers.mjs',
        'scripts/protocol-helpers.mjs',
        'scripts/provider-adapter-github.mjs',
        ...basePaths,
      ];
    case 'package-manager':
      return [
        'package.json',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        ...basePaths,
      ];
    // ephemeral-npx (which pins its checker version via
    // helperRuntime.packageSpec in the config file above) and every
    // other/unresolved profile have no additional profile-specific path
    // of their own, so both resolve to the profile-invariant base set
    // via this default.
    default:
      return basePaths;
  }
}
/** kurone-kito/idd-skill#2657: this gate's own workflow file path, as
 * reported by the GitHub Actions runs API's `path` field -- the value a
 * self-referential-bootstrap-auto waiver's `run-id:` lookup must match
 * (trust condition (c)). Declared as its own explicit literal (Copilot
 * review, PR #2895) rather than derived by indexing into
 * {@link SELF_REFERENTIAL_WAIVER_TRIGGER_FILES} -- an index-derived value
 * would silently point at the wrong entry if that array is ever
 * reordered. A dedicated test asserts this value is still a member of
 * that array, so the two can never drift apart despite being declared
 * independently. */
export const ADVISORY_CONVERGENCE_WORKFLOW_PATH =
  '.github/workflows/idd-advisory-convergence.yml';
// kurone-kito/idd-skill#2657: `SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON` /
// `SELF_REFERENTIAL_BOOTSTRAP_AUTO_EXPIRY` are declared in
// `advisory-wait-policy.mts` (imported above) and re-exported here for
// backward-compatible call sites, rather than declared locally: this file
// already imports FROM `external-check-waiver.mts`
// (`resolveCollaboratorAuthority`/`normalizeAuthorityEvidence`), which also
// needs these two constants for its own `--auto-bootstrap` CLI mode --
// declaring them in either file directly would form an import cycle.
export {
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_EXPIRY,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from './advisory-wait-policy.mjs';
/** #1719: stable, machine-readable tokens for
 * `sameHeadReroll.ineligibleReasons` -- one per boolean term of the
 * `eligible` conjunction, in the same order the conjunction is written in
 * `computeAdvisoryConvergenceVerdict` below, so a report-mode caller can
 * self-diagnose a stuck AW6 reroll without re-deriving the eligibility rule
 * from `idd-advisory-wait.instructions.md` by hand. Exported (rather than
 * inlined as string literals at each call site) so tests reference the same
 * single source of truth the implementation does. */
export const SAME_HEAD_REROLL_INELIGIBLE_REASON = {
  SCOPE_NOT_APPLICABLE: 'scope-not-applicable',
  REVIEW_PENDING: 'review-pending',
  UNRESOLVED_COPILOT_THREADS: 'unresolved-copilot-threads',
  MISSING_REGULAR_COMMENT_DISPOSITION: 'missing-regular-comment-disposition',
  REVIEW_ITEM_COUNT_UNKNOWN: 'review-item-count-unknown',
  REVIEW_ITEM_COUNT_NOT_POSITIVE: 'review-item-count-not-positive',
  ALREADY_SATISFIED_VIA_REVIEW_ACK: 'already-satisfied-via-review-ack',
};
/** #2143: stable tokens for `nextActions[].token` -- one per branch of
 * {@link collectAssertNextActions}, the same catalog the stderr track
 * (`formatAssertNextActions`) already prints. Exported so tests can pin
 * the set. The schema `enum` is hand-maintained beside this object and
 * must stay in sync; the pin test compares both. */
export const ADVISORY_CONVERGENCE_NEXT_ACTION_TOKEN = {
  INDETERMINATE_APPLICABILITY: 'indeterminate-applicability',
  REQUEST_REVIEW: 'request-review',
  REQUEST_RE_REVIEW: 'request-re-review',
  DISPOSITION_POSTED_ITEMS: 'disposition-posted-items',
  DISPOSITION_THREADS: 'disposition-threads',
  ACK_SUPPRESSED: 'ack-suppressed',
  WAIVER_TERMINAL: 'waiver-terminal',
  HOLD_TERMINAL: 'hold-terminal',
  WAIVER_DEADLINE: 'waiver-deadline',
  HOLD_DEADLINE: 'hold-deadline',
  SAME_HEAD_REROLL: 'same-head-reroll',
  REREAD_VERDICT: 'reread-verdict',
};
/** #2137: exact `reviewPolicy` values that skip Copilot / primary-bot
 * clauses. Mapped to the `applicability.reason` token so tests and
 * operators can tell which policy produced the short-circuit. */
const REVIEW_POLICY_NOT_APPLICABLE_REASON = {
  'human-required': 'review-policy-human-required',
  'no-advisory': 'review-policy-no-advisory',
};
/** Return the `not_applicable` reason for a human-only / no-advisory
 * `reviewPolicy`, or `null` when today's Copilot / `primaryBotLogin`
 * applicability should run. Exact enum match only: absent, invalid,
 * `copilot-advisory`, and `external-bot` all return `null`. */
export function reviewPolicyNotApplicableReason(reviewPolicy) {
  if (reviewPolicy === 'human-required' || reviewPolicy === 'no-advisory') {
    return REVIEW_POLICY_NOT_APPLICABLE_REASON[reviewPolicy];
  }
  return null;
}
/**
 * kurone-kito/idd-skill#2657: the fourth (path/head-sha/repo) and fifth
 * (event-type) trust conditions a `self-referential-bootstrap-auto`
 * waiver's `run-id:` field must resolve to, given an already-fetched (or
 * errored) `GET /repos/{owner}/{repo}/actions/runs/{run-id}` lookup
 * result. Pure and fail-closed: an absent/errored lookup, or any single
 * mismatching field, is `false`, never a thrown exception -- a
 * transient or malformed lookup must never widen trust. The event check
 * is the specific gap the 2026-09-11 hearing added: during
 * kurone-kito/idd-skill#2764 Phase 1, `idd-advisory-convergence.yml`
 * still declares both `pull_request` and `pull_request_target`, so a
 * same-repository PR editing the workflow YAML can still trigger a
 * `pull_request`-triggered run of it whose `path`/`head_sha`/
 * `head_repository.full_name` all satisfy the other three conditions.
 *
 * kurone-kito/idd-skill#2911: exported (was module-private) so
 * `pre-merge-readiness.mts`'s own stale-self-waiver merge blocker can
 * reuse this exact verification rather than reimplementing it -- see
 * that file's own doc comment on its `autoWaiverRunVerified` option
 * for the full call site. This remains the bearer-evidence check only
 * (proves the cited run has the right shape, not that it actually
 * posted the comment citing it -- kurone-kito/idd-skill#2912 tracks
 * closing that residual gap); callers still need their own
 * independent `touchesSelfReferentialAllowlist` precondition to keep
 * a forged-but-shape-valid citation from affecting an unrelated PR.
 */
export function verifySelfReferentialBootstrapWaiverRun(run, expected) {
  if (!run || 'error' in run) {
    return false;
  }
  // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): fail closed when
  // this invocation's own resolved repository identity is empty (e.g. a
  // caller upstream failed to resolve owner/repo) -- without this,
  // `String(undefined ?? '') === ''` would make an ABSENT expected
  // repository equal an absent `run.repositoryFullName` too (a run whose
  // own `head_repository` the Actions API reported as null), letting a
  // malformed/direct invocation validate an auto-waiver without proving
  // which repository actually ran it. `expected.path`/`expected.headSha`
  // need no equivalent guard: both are always non-empty by construction
  // (a hardcoded workflow-path constant and a regex-validated 40-hex SHA
  // respectively), so an empty `run` counterpart already fails those
  // comparisons on its own.
  if (!expected.repositoryFullName) {
    return false;
  }
  return (
    String(run.path ?? '') === expected.path &&
    String(run.headSha ?? '').toLowerCase() ===
      expected.headSha.toLowerCase() &&
    // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): repository
    // owner/name identities are case-insensitive on GitHub -- normalize
    // both operands the same way headSha above (and
    // resolveSelfReferentialTriggerFiles's own origin-repository check)
    // already do, so a run reported back with different casing than
    // this invocation's own resolved repositoryFullName is not
    // incorrectly rejected.
    String(run.repositoryFullName ?? '').toLowerCase() ===
      expected.repositoryFullName.toLowerCase() &&
    run.event === 'pull_request_target'
  );
}
/** kurone-kito/idd-skill#2912: this gate's own self-waiver job id, as
 * reported by the GitHub Actions jobs API's `name` field (no `name:`
 * override in the workflow, so the reported name is literally the job
 * id) -- the job {@link verifySelfReferentialBootstrapWaiverProvenance}
 * requires proof of execution from. Declared as its own explicit
 * literal, mirroring {@link ADVISORY_CONVERGENCE_WORKFLOW_PATH}'s own
 * "kept in sync by hand with the YAML" convention; a dedicated test
 * pins both this and {@link SELF_REFERENTIAL_WAIVER_POST_STEP_NAME}
 * against the workflow file's own literal text. */
export const SELF_REFERENTIAL_WAIVER_JOB_ID =
  'idd-advisory-convergence-self-waiver';
/** kurone-kito/idd-skill#2912: the exact `name:` of the step, within
 * {@link SELF_REFERENTIAL_WAIVER_JOB_ID}, that actually posts a
 * self-referential-bootstrap-auto marker -- kept in sync by hand with
 * `.github/workflows/idd-advisory-convergence.yml`'s own "Post the
 * self-referential-bootstrap-auto waiver" step, the same convention as
 * {@link SELF_REFERENTIAL_WAIVER_JOB_ID} above. */
export const SELF_REFERENTIAL_WAIVER_POST_STEP_NAME =
  'Post the self-referential-bootstrap-auto waiver';
/**
 * kurone-kito/idd-skill#2912: whether the cited run's own jobs-API
 * evidence proves its {@link SELF_REFERENTIAL_WAIVER_JOB_ID} job actually
 * completed {@link SELF_REFERENTIAL_WAIVER_POST_STEP_NAME}, rather than
 * merely having the right run-level shape
 * ({@link verifySelfReferentialBootstrapWaiverRun}'s own job). This is
 * the binding step that closes the residual gap the module header notes
 * (#2657, round 16): a run whose own path/head-sha/repository/event all
 * check out does not by itself prove THAT run's own job posted THIS
 * specific comment -- a same-repository `pull_request`-triggered
 * workflow can discover a legitimate run's id via the public Actions API
 * and cite it in a forged marker. Requiring the post step's own
 * `conclusion: 'success'` AND that the marker's own `createdAt` falls
 * within that step's `[startedAt, completedAt]` execution window makes
 * this practically unforgeable: a forged marker would need the cited
 * run's post step to have actually run and succeeded at almost exactly
 * the moment the forged comment was created, which only the run's own
 * job -- not an unrelated, concurrently-running one -- controls. Pure
 * and fail-closed, matching {@link verifySelfReferentialBootstrapWaiverRun}'s
 * own contract: an absent/errored lookup, a non-`success` conclusion, or
 * a missing/unparseable window is always `false`, never a thrown
 * exception. */
function verifySelfReferentialBootstrapWaiverProvenance(
  jobLookup,
  markerCreatedAt,
) {
  if (!jobLookup || 'error' in jobLookup) {
    return false;
  }
  if (jobLookup.conclusion !== 'success') {
    return false;
  }
  const startedAt = String(jobLookup.startedAt ?? '');
  const completedAt = String(jobLookup.completedAt ?? '');
  if (
    !isValidIsoTimestamp(markerCreatedAt) ||
    !isValidIsoTimestamp(startedAt) ||
    !isValidIsoTimestamp(completedAt)
  ) {
    return false;
  }
  const markerMs = Date.parse(markerCreatedAt);
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  return markerMs >= startedMs && markerMs <= completedMs;
}
/** kurone-kito/idd-skill#2912 (round 2, extended round 3): the fixed
 * prefix of the Actions artifact name {@link SELF_REFERENTIAL_WAIVER_JOB_ID}'s
 * own posting job uploads immediately after successfully posting a
 * `self-referential-bootstrap-auto` marker, followed by the posted
 * comment's own decimal `id`, a literal `-`, and the SHA-256 hex digest
 * of that comment's exact posted body
 * ({@link digestExternalCheckWaiverMarkerBody}) -- e.g.
 * `idd-self-waiver-marker-123456789-<64 lowercase hex characters>`. Round
 * 2 named the artifact with the id alone; round 3 appends the body digest
 * because the id alone does not survive an in-place body edit (see
 * {@link verifySelfReferentialBootstrapWaiverArtifactBinding}'s own doc
 * comment for that exploit). Both fields live in the artifact's NAME,
 * never its content, so recovering them costs one `list artifacts` JSON
 * call per cited run id -- no zip download/extraction is needed. Kept in
 * sync by hand with `.github/workflows/idd-advisory-convergence.yml`'s
 * own "Upload the posted marker's provenance artifact" step (the `with:
 * name:` value there, not the preceding "Record the posted marker's
 * provenance" step that only stages the local file `actions/upload-artifact`
 * reads), the same convention {@link SELF_REFERENTIAL_WAIVER_JOB_ID} and
 * {@link SELF_REFERENTIAL_WAIVER_POST_STEP_NAME} already follow; a
 * dedicated test pins all three against the workflow file's own literal
 * text (both the repository-root copy and its `idd-template/` mirror). */
export const SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX =
  'idd-self-waiver-marker-';
/**
 * kurone-kito/idd-skill#2912 (round 2, extended round 3): whether the
 * `.valid` marker `entry` under evaluation is one the cited run id's own
 * trusted {@link SELF_REFERENTIAL_WAIVER_JOB_ID} job execution actually
 * recorded posting, via the run-scoped Actions artifact
 * {@link SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX} describes. This
 * is the binding step that closes a gap
 * {@link verifySelfReferentialBootstrapWaiverProvenance} alone cannot:
 * that check alone only proves the cited run's job succeeded and posted
 * SOME comment within a tight time window, never THIS EXACT comment --
 * a same-repository `pull_request`-triggered workflow (untrusted,
 * PR-controlled code, `issues: write`) can post a forged marker citing
 * a legitimate, concurrently-running `pull_request_target` run's id
 * inside that same window, wait for the genuine marker to post, and
 * then DELETE it (`issues: write` permits deleting ANY issue comment on
 * the repository, not only ones the deleting token itself authored) --
 * leaving the forged marker as the sole survivor of a plain "no
 * duplicate candidate currently visible" scan, which is exactly the
 * property this file's PRIOR round-1 uniqueness check depended on
 * (kurone-kito/idd-skill#2912, closed in round 2).
 *
 * Round 2's id-only binding had its own sibling gap (a Copilot review of
 * PR #2914's round-2 commit): `issues: write` also permits EDITING an
 * existing comment's body in place, preserving its `id` AND `createdAt`
 * while replacing the content -- an attacker could wait for the genuine
 * marker to post (its `id` becomes artifact-trusted), then rewrite that
 * SAME comment's body to a forged marker, which round 2's id-only check
 * would still accept. Round 3 closes this by binding to the PAIR
 * (comment `id`, SHA-256 digest of that comment's exact body) instead of
 * `id` alone -- see the module header's round-3 paragraph for the full
 * exploit and fix description.
 *
 * `entry` carries no comment `id`/body of its own (`ExternalCheckWaiverEvidence.valid`
 * is a shared type many other callers use unchanged), so this
 * correlates `entry.createdAt` back to `candidates` -- the SAME
 * `{id, createdAt, bodyDigest}` triples `collectFromGitHub` derived from
 * the identical raw comment scan that produced `entry` in the first
 * place -- and requires the match to be UNIQUE: two distinct candidates
 * sharing the same wall-clock second (a genuine marker and a same-window
 * forged sibling) is ambiguous and fails closed for both, never guesses
 * a winner. `createdAt` alone (not the full pair) still drives THIS
 * correlation step -- an edited body never changes `createdAt`, only
 * `id` uniquely names which live comment `entry` came from -- and the
 * uniquely-correlated candidate's OWN `(id, bodyDigest)` pair must then
 * appear in `trustedBindings` -- the cited run's own artifact-recorded
 * set.
 *
 * Because artifacts are scoped to the run that uploaded them by the
 * Actions runtime's own dedicated upload token (never the shared
 * `GITHUB_TOKEN` `permissions:` surface comments and check runs are
 * both mutable through), no unrelated run -- however it scopes its own
 * `permissions:` block -- can add, edit, or remove an entry from
 * `trustedBindings`. A forged OR edited comment's `(id, bodyDigest)`
 * pair therefore never appears there regardless of timing, deletion, or
 * in-place editing tricks; deleting the GENUINE comment only removes it
 * from `candidates` (a live re-fetch), which degrades this to "no
 * correlated candidate -- fail closed", never "the forged one wins". The
 * one residual: an attacker who additionally self-grants the broader,
 * repository-wide `actions: write` permission (distinct from `issues:
 * write`) could delete the genuine run's artifact through Actions' own
 * artifact-management endpoint, which still only degrades to "no
 * auto-waiver" (fail closed), never "a forged waiver validates" -- and
 * is outside the `issues: write`-scoped threat model this fix (and the
 * independent review findings that prompted both rounds) are all framed
 * against.
 *
 * Pure and fail-closed like every other verification function in this
 * file: an absent/empty `trustedBindings`, no unique correlated
 * candidate, or a correlated candidate whose `(id, bodyDigest)` pair is
 * not in `trustedBindings` are all `false`, never a thrown exception.
 */
function verifySelfReferentialBootstrapWaiverArtifactBinding(
  candidates,
  trustedBindings,
  entryCreatedAt,
) {
  const bindingKey = (id, bodyDigest) => {
    const normalizedId = String(id ?? '').trim();
    const normalizedDigest = String(bodyDigest ?? '')
      .trim()
      .toLowerCase();
    return normalizedId && normalizedDigest
      ? `${normalizedId}:${normalizedDigest}`
      : '';
  };
  const trusted = new Set(
    (trustedBindings ?? [])
      .map((binding) => bindingKey(binding?.id, binding?.bodyDigest))
      .filter((key) => key.length > 0),
  );
  if (trusted.size === 0) {
    return false;
  }
  const matches = (candidates ?? []).filter(
    (candidate) => candidate.createdAt === entryCreatedAt,
  );
  if (matches.length !== 1) {
    // Zero: no live candidate at all for this exact timestamp (e.g. the
    // genuine comment was deleted). More than one: two distinct comments
    // citing the same run id share the same wall-clock second -- fail
    // closed rather than guessing which one `entry` actually is.
    return false;
  }
  const key = bindingKey(matches[0]?.id, matches[0]?.bodyDigest);
  return key.length > 0 && trusted.has(key);
}
/**
 * Compute the deterministic advisory-convergence verdict from already-
 * fetched PR evidence. Pure (no I/O), so it is directly unit-testable with
 * fixtures -- mirrors `buildPreMergeReadinessSummary` /
 * `buildAdvisoryWaitSummary` in `protocol-helpers.mts`.
 */
export function computeAdvisoryConvergenceVerdict(inputs, options) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  // Lowercased before validating, so a mixed-/upper-case 40-hex SHA is
  // accepted (normalized), not rejected -- the error message below
  // describes the post-normalization shape, not a case restriction on the
  // input.
  const prHeadSha = String(inputs.prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a 40-character hexadecimal commit SHA');
  }
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const reviews = inputs.reviews ?? [];
  const threads = inputs.threads ?? [];
  const comments = inputs.comments ?? [];
  const claimEvents = inputs.claimEvents ?? [];
  const reasons = [];
  const claim = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins,
    // #1344: parity with `pre-merge-readiness.mts`'s own
    // `summarizeClaimValidation` call -- see `AdvisoryConvergenceOptions`
    // for why each field is a no-op when the caller omits it.
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    prFirstCommitAt: options.prFirstCommitAt ?? null,
    staleAgeMs: options.staleAgeMs,
  });
  const activeClaimId = claim.activeClaim?.claimId ?? '';
  const activeClaimSupersedes = claim.activeClaim?.supersedes ?? '';
  // `idd-claimed` narrows this gate to verified IDD-owned PRs; the default
  // `all-prs` behavior keeps the gate applicable everywhere else.
  const convergenceScope =
    options.convergenceScope === 'idd-claimed' ? 'idd-claimed' : 'all-prs';
  const prHeadRefName = String(options.prHeadRefName ?? '').trim();
  const activeClaimBranch = String(claim.activeClaim?.branch ?? '').trim();
  // #1686: evidence the CLI-collection layer computes over EVERY candidate
  // claim issue (not just whichever one -- if any -- ended up "active"), so
  // the applicability gate can tell a genuinely non-IDD PR apart from an
  // IDD-shaped PR whose claim linkage is currently broken. See each field's
  // own doc comment on `AdvisoryConvergenceInputs` for the full rationale.
  //
  // #1821: the TS type already requires both fields at compile time, but
  // that guard is erased at emit -- an untyped caller of the exported
  // `.mjs` (or a hand-written JS caller) can still pass `undefined` or a
  // non-boolean value through. Reject that here instead of silently
  // coercing it to `false`, matching this function's existing
  // error-handling convention for invalid inputs (see the `now` /
  // `prHeadSha` validation above).
  if (typeof inputs.claimMarkerHistoryPresent !== 'boolean') {
    throw new Error('claimMarkerHistoryPresent must be a boolean');
  }
  if (typeof inputs.claimCandidateAmbiguous !== 'boolean') {
    throw new Error('claimCandidateAmbiguous must be a boolean');
  }
  const claimMarkerHistoryPresent = inputs.claimMarkerHistoryPresent;
  const claimCandidateAmbiguous = inputs.claimCandidateAmbiguous;
  // #1906: read as `=== true` on both sides -- see each field's own doc
  // comment (`AdvisoryConvergenceInputs.prAuthorIsBot`,
  // `AdvisoryConvergenceOptions.exemptBotAuthoredPrs`) for why neither is
  // required-with-throw like the two claim-evidence booleans above.
  const exemptBotAuthoredPrs = options.exemptBotAuthoredPrs === true;
  const prAuthorIsBot = inputs.prAuthorIsBot === true;
  // #2137: honor reviewPolicy first. human-required / no-advisory must
  // not demand Copilot even on an `idd-claimed` hybrid PR (that scope
  // is the wrong substitute). Ready comes from the existing
  // `scopeNotApplicable` path, never a fake `converged`.
  const reviewPolicySkipReason = reviewPolicyNotApplicableReason(
    options.reviewPolicy,
  );
  const applicability = reviewPolicySkipReason
    ? {
        scope: convergenceScope,
        status: 'not_applicable',
        reason: reviewPolicySkipReason,
      }
    : convergenceScope === 'idd-claimed'
      ? !claim.activeClaimPresent
        ? claimCandidateAmbiguous
          ? {
              scope: convergenceScope,
              status: 'indeterminate',
              reason: 'idd-claimed-multiple-resolving-claim-candidates',
            }
          : claimMarkerHistoryPresent
            ? {
                scope: convergenceScope,
                status: 'indeterminate',
                reason: 'idd-claimed-claim-history-without-active-claim',
              }
            : {
                scope: convergenceScope,
                status: 'not_applicable',
                reason: 'idd-claimed-no-verified-linked-issue-claim',
              }
        : !prHeadRefName
          ? {
              scope: convergenceScope,
              status: 'applicable',
              reason: 'idd-claimed-head-branch-unavailable',
            }
          : !activeClaimBranch
            ? {
                scope: convergenceScope,
                status: 'applicable',
                reason: 'idd-claimed-linked-claim-branch-unavailable',
              }
            : activeClaimBranch !== prHeadRefName
              ? {
                  scope: convergenceScope,
                  status: 'indeterminate',
                  reason: 'idd-claimed-branch-mismatch',
                }
              : {
                  scope: convergenceScope,
                  status: 'applicable',
                  reason: 'idd-claimed-branch-matched',
                }
      : // #1906: opt-in bot-authored-PR exemption, `all-prs` scope only --
        // `idd-claimed` already resolves this exact PR shape to
        // `not_applicable` via its own `idd-claimed-no-verified-linked-
        // issue-claim` branch above, untouched by this addition.
        exemptBotAuthoredPrs && prAuthorIsBot && !claimMarkerHistoryPresent
        ? {
            scope: convergenceScope,
            status: 'not_applicable',
            reason: 'bot-authored-no-claim-history',
          }
        : {
            scope: convergenceScope,
            status: 'applicable',
            reason: 'all-prs',
          };
  // `scopeNotApplicable` keeps its pre-#1686 meaning EXACTLY -- `status ===
  // 'not_applicable'` only -- since it still gates the waiver-evidence
  // bookkeeping (`waived` below) and the unconditional `ready` pass for a
  // genuinely non-IDD PR. `scopeIndeterminate` is the new third state:
  // unlike `not_applicable`, it must NEVER let `ready` become true through
  // the ordinary convergence path (`converged` below is forced `false` for
  // it, same as `not_applicable` blocks evaluating convergence at all) --
  // only the existing deadline/terminal-plus-maintainer-waiver escape hatch
  // can still clear it (`waived` stays gated by `scopeNotApplicable` alone,
  // deliberately NOT `scopeBlocksConvergenceEval`, so a trusted maintainer
  // marker can still resolve an indeterminate verdict same as any other
  // non-converged one -- see the module header and PR discussion for why
  // hard-blocking indeterminate with no waiver escape at all would leave a
  // required check with no recovery path for a repository under
  // `required_approving_review_count: 0`).
  const scopeNotApplicable = applicability.status === 'not_applicable';
  const scopeIndeterminate = applicability.status === 'indeterminate';
  const scopeBlocksConvergenceEval = scopeNotApplicable || scopeIndeterminate;
  if (scopeIndeterminate) {
    reasons.push(
      `applicability is indeterminate (${applicability.reason}): this PR carries evidence of IDD claim activity but its claim linkage cannot be resolved cleanly -- repair the claim/PR-body linkage (or, for a confirmed benign case, have a trusted maintainer post an idd-external-check-waiver marker) before this check can converge`,
    );
  }
  // --- Clause 1: latest Copilot review is clean on the current HEAD -----
  const review = resolveLatestCopilotReviewClause(
    reviews,
    prHeadSha,
    primaryBotLogin,
  );
  const pending = scopeBlocksConvergenceEval ? false : !review.matchesHead;
  if (!scopeBlocksConvergenceEval && pending) {
    reasons.push(
      review.found
        ? `latest ${primaryBotLogin} review (commit ${review.commitId || '<unknown>'}) does not cover current HEAD ${prHeadSha}`
        : `${primaryBotLogin} has not reviewed this pull request yet`,
    );
  }
  // --- Clause 2: every current Copilot-authored thread is resolved or ---
  // --- validly dispositioned (reusing summarizeDispositionEvidenceForGate)
  const copilotThreadIds = classifyCopilotAuthoredThreadIds(
    threads,
    primaryBotLogin,
  );
  const dispositionEvidence = summarizeDispositionEvidenceForGate(
    { comments, threads },
    {
      // `summarizeDispositionEvidenceForGate` requires a recognized
      // "IDD agent" login to accept an Accept/Reject/AMD marker as a fresh
      // disposition (see `hasFreshDisposition`). This gate has no separate
      // notion of "IDD agent" from "trusted marker actor" -- both mean the
      // same thing here (whoever is authorized to post operational markers
      // on this repo) -- so the trusted set is reused for both, avoiding an
      // extra CLI flag / config surface the issue does not ask for.
      iddAgentLogins: trustedMarkerLogins,
      trustedMarkerLogins,
      advisoryBotLogins: normalizeTrustedMarkerLogins(
        options.advisoryBotLogins ?? [],
      ),
      prAuthorLogin: String(options.prAuthorLogin ?? '')
        .trim()
        .toLowerCase(),
      // Deliberately no `snapshotBoundaryAt`: this claim-independent gate has
      // no F2 review-watermark to anchor one to, and threading a sentinel
      // (e.g. `now`) through would make every resolved thread's feedback
      // trivially predate it -- silently turning the boundary-gated
      // ack-only-post-disposition classification (`classifyThreadAckOnly-
      // PostDisposition`, protocol-helpers.mts) into permanent dead code
      // instead of the deliberate carve-out it looks like. "Resolved is
      // sufficient" (below) is handled directly, without relying on that
      // classification at all.
    },
  );
  // Clause 2 per the issue: "resolved OR carries a valid disposition
  // marker." `missingThreads` (computed without a boundary, above) flags
  // BOTH an unresolved thread lacking a fresh marker AND a resolved thread
  // lacking one (`reason: 'missing-fresh-disposition'`) -- the latter is not
  // a Clause-2 blocker here, since resolution alone already satisfies it, so
  // only the genuinely unresolved entries count.
  const copilotBlocking = dispositionEvidence.missingThreads.filter(
    (thread) =>
      copilotThreadIds.has(String(thread.id ?? '')) &&
      thread.isResolved === false,
  );
  const threadClause = {
    copilotThreadCount: copilotThreadIds.size,
    blockingIds: copilotBlocking.map((thread) => String(thread.id ?? '')),
    blockingCount: copilotBlocking.length,
    satisfied: copilotBlocking.length === 0,
  };
  // --- #2050: disposition-aware Clause 1 override -------------------------
  // The raw `review.satisfied` (review-clause.mts) is a purely mechanical
  // `matchesHead && itemCount === 0 && suppressedCount === 0` check, with no
  // awareness of whether a trusted actor already read and dispositioned
  // those findings -- computed here as a thin caller-side override instead
  // of inside `resolveLatestCopilotReviewClause` itself, since both halves
  // below need evidence (`threadClause`, `comments`, `trustedMarkerLogins`)
  // that pure, low-dependency function does not receive (and its OTHER
  // caller, `rerun-advisory-convergence.mts`, only ever reads `.matchesHead`,
  // never `.satisfied`, so this override cannot affect it).
  //
  // `hasValidReviewAck` (#2050 / #2056): true when a trusted `review-ack:`
  // marker's OWN GitHub `created_at` (never an embedded, agent-supplied
  // timestamp -- the same trust boundary `hasFreshDisposition`,
  // protocol-helpers.mts, and `summarizeSameHeadRerollMarkers` already
  // apply) postdates the latest primary-bot review's `submittedAt`, AND
  // the marker's embedded HEAD SHA equals the current PR HEAD. A single
  // whole-review acknowledgement, not a per-finding identifier scheme --
  // see the issue's "Decision" section for why.
  const hasValidReviewAck = resolveHasValidReviewAck(
    comments,
    trustedMarkerLogins,
    review.submittedAt,
    prHeadSha,
  );
  // `itemCountClauseSatisfied`: `itemCount === 0`, OR every thread THIS
  // SPECIFIC review opened is resolved or validly dispositioned. Bound to
  // `review.reviewId` (Copilot review, this PR: `classifyThreadIdsForReview`)
  // rather than reusing `threadClause` (Clause 2's PR-WIDE, review-agnostic
  // set) directly: `threadClause.satisfied` can be vacuously true from an
  // OLDER, already-dispositioned review's threads while the LATEST review's
  // own items have no thread representation at all -- a resolved-but-stale
  // thread must never stand in for the CURRENT review's own coverage. This
  // also naturally handles the #1719 incident shape (a "Comments suppressed
  // due to low confidence" item counted in `itemCount` but invisible to any
  // `reviewThreads` query): `latestReviewThreadIds` stays empty and
  // `itemCountClauseSatisfied` stays `false`.
  const latestReviewThreadIds = classifyThreadIdsForReview(
    threads,
    primaryBotLogin,
    review.reviewId,
  );
  const latestReviewBlocking = dispositionEvidence.missingThreads.filter(
    (thread) =>
      latestReviewThreadIds.has(String(thread.id ?? '')) &&
      thread.isResolved === false,
  );
  // #2054 review (Copilot + CodeRabbit, independently): the thread-evidence
  // disjunct alone neither required a KNOWN itemCount, nor that the
  // NUMBER of this-review-originated threads actually covers every posted
  // item -- `itemCount: null` (unknown count), or `itemCount: 2` with only
  // ONE such thread, would otherwise satisfy this on "at least one resolved
  // thread exists," leaving other posted items unaccounted for.
  // `latestReviewThreadIds.size >= review.itemCount` requires as many
  // review-scoped threads as claimed items (each of the review's own
  // comments originates at most one thread, so this count can never
  // legitimately exceed `itemCount`, making `>=` and exact equality
  // equivalent in practice; `>=` is the more defensive form).
  // `review.itemCount !== null` fails closed on the unknown-count case,
  // matching this file's other missing-evidence guards (e.g.
  // `reviewItemCountKnownTerm` in the sameHeadReroll terms below).
  // #2056: the nonzero branch requires a positive integer before trusting
  // `>=` -- `itemCount: -1` with an empty thread set would otherwise
  // satisfy `0 >= -1` and report the review covered with no real thread
  // evidence. `itemCount === 0` stays the clean-review short-circuit.
  const itemCountClauseSatisfied =
    review.itemCount === 0 ||
    (review.itemCount !== null &&
      Number.isInteger(review.itemCount) &&
      review.itemCount > 0 &&
      latestReviewThreadIds.size >= review.itemCount &&
      latestReviewBlocking.length === 0);
  // `suppressedClauseSatisfied`: `suppressedCount === 0`, OR a valid
  // `review-ack` covers it.
  const suppressedClauseSatisfied =
    review.suppressedCount === 0 || hasValidReviewAck;
  const reviewSatisfied =
    review.matchesHead && itemCountClauseSatisfied && suppressedClauseSatisfied;
  // Clause 1's "review is not clean" reason is pushed here, after Clause 2's
  // `threadClause` and the disposition-aware overrides above are available
  // -- deliberately deferred from the `pending` check above (whose own `if`
  // already exhausts the pending case, so `reasons` order is unaffected:
  // pending and not-satisfied are mutually exclusive, and this still
  // precedes Clause 2's own thread-blocking reason below).
  //
  // #1719: reported adopter incident -- the primary bot's review on current
  // HEAD carried `itemCount: 1` while every visible GraphQL review thread
  // was already `isResolved: true`; the actual cause was a "Comments
  // suppressed due to low confidence" item embedded in the review's
  // top-level BODY TEXT rather than posted as a review thread -- it
  // contributes to `itemCount` but is invisible to any `reviewThreads`
  // query, so it can never be resolved the normal way, and nothing in this
  // gate's output pointed there. When zero Copilot-authored threads exist at
  // all, no thread query can explain a positive `itemCount` -- point
  // directly at the review body instead of leaving an agent to re-derive
  // this by hand a second time.
  //
  // #1880: a related but distinct incident shape -- the primary bot's
  // review on current HEAD carries `itemCount: 0` (zero POSTED comments)
  // while its top-level body still embeds a `Suppressed comments (N)`
  // block for a finding it chose not to post as a comment at all. The
  // #1719 branch above only fires when `itemCount > 0`, so this case fell
  // through to full convergence with an empty `reasons[]` until now (PR
  // #1875 commit 9711d404). `reviewSatisfied` is already gated on
  // `suppressedClauseSatisfied`, so `converged` is already correctly
  // `false` here -- this branch only supplies the explanation.
  //
  // #2050: `ackSuffix` names the recovery marker (not a profile-specific
  // command path -- adopters on a non-vendored profile run a different
  // `post-idd-marker` invocation) whenever a nonzero `suppressedCount` is
  // still unresolved for lack of a valid `review-ack` -- computed once,
  // shared by both branches below.
  const ackSuffix =
    review.suppressedCount > 0 && !hasValidReviewAck
      ? '; post a trusted review-ack marker after this review to cover the suppressed comment(s)'
      : '';
  if (!scopeBlocksConvergenceEval && !pending && !reviewSatisfied) {
    if (review.itemCount === 0 && review.suppressedCount > 0) {
      reasons.push(
        `latest ${primaryBotLogin} review on current HEAD carries ${review.suppressedCount} suppressed comment(s) not reflected in itemCount (posted comment count is 0) -- check the review body directly, since a suppressed finding is never posted as a comment or review thread${ackSuffix}`,
      );
    } else {
      const itemCountReason =
        review.itemCount === null
          ? `latest ${primaryBotLogin} review on current HEAD carries an unknown number of actionable items (comment count unavailable)`
          : `latest ${primaryBotLogin} review on current HEAD carries ${review.itemCount} actionable item(s)`;
      // A review can carry both posted comments (itemCount > 0) AND a
      // suppressed-comments section at once; append a pointer to the
      // latter rather than silently dropping it from the reported reason.
      const suppressedSuffix =
        review.suppressedCount > 0
          ? ` (plus ${review.suppressedCount} suppressed comment(s) in the review body, not counted in itemCount)`
          : '';
      // #2050 / #2056: the "check the review body directly" pointer is for
      // items that have no review-thread representation at all -- zero
      // scoped threads, or a resolved/dispositioned partial set whose
      // count is still below itemCount. When THIS review's own threads
      // exist but are still unresolved/undispositioned, the separate
      // `threadClause.satisfied` reason below already names those
      // blocking threads, so the body pointer would be a red herring.
      const uncoveredItemCount =
        review.itemCount !== null &&
        Number.isInteger(review.itemCount) &&
        review.itemCount > 0 &&
        latestReviewThreadIds.size < review.itemCount;
      const zeroThreadEvidence =
        uncoveredItemCount && latestReviewThreadIds.size === 0;
      const partialResolvedCoverage =
        uncoveredItemCount &&
        latestReviewThreadIds.size > 0 &&
        latestReviewBlocking.length === 0;
      const threadEvidenceGap = zeroThreadEvidence
        ? `no ${primaryBotLogin}-authored review-thread evidence accounts for them`
        : `only ${latestReviewThreadIds.size} of ${review.itemCount} items have ${primaryBotLogin}-authored review-thread evidence`;
      reasons.push(
        zeroThreadEvidence || partialResolvedCoverage
          ? `${itemCountReason}${suppressedSuffix}${ackSuffix} -- ${threadEvidenceGap}; check the review body directly for an item suppressed due to low confidence, which counts toward itemCount but never appears in reviewThreads`
          : `${itemCountReason}${suppressedSuffix}${ackSuffix}`,
      );
    }
  }
  if (!scopeBlocksConvergenceEval && !threadClause.satisfied) {
    reasons.push(
      `${threadClause.blockingCount} ${primaryBotLogin}-authored review thread(s) are neither resolved nor validly dispositioned: ${threadClause.blockingIds.join(', ')}`,
    );
  }
  // #1719: eligibility-relevant `dispositionEvidence` counters, exposed on
  // the report object -- see `AdvisoryConvergenceDispositionEvidence`'s doc
  // comment for why this is a narrow counters-only projection, not the same
  // shape as `pre-merge-readiness.mjs`'s own `dispositionEvidence` field.
  const dispositionEvidenceReport = {
    missingRegularCommentCount: dispositionEvidence.missingRegularCommentCount,
    missingThreadCount: dispositionEvidence.missingThreadCount,
  };
  const converged =
    !scopeBlocksConvergenceEval &&
    !pending &&
    reviewSatisfied &&
    threadClause.satisfied;
  // --- Same-HEAD advisory reroll evidence (#1511) ------------------------
  // Purely additive: `converged` above is already final and is never
  // recomputed or referenced below this point -- see the module header and
  // the "sameHeadReroll never affects converged/ready" test.
  // `dispositionEvidence.missingRegularCommentCount` reuses the SAME
  // evidence F2's own separate "missingRegularComments.length == 0"
  // condition already reads -- an ad hoc regular PR comment (not part of
  // a review thread) can still be an unaddressed, possibly-PATH-A item
  // even when every Copilot-authored THREAD is resolved/dispositioned.
  // Without this, `eligible` could fire while genuine triage work is
  // still outstanding, spending a bounded reroll attempt on a HEAD that
  // was not actually done yet -- and if the bot does not answer quickly,
  // that attempt is permanently consumed before the real blocker is even
  // cleared (PR #1517 review).
  //
  // #1719: each of the seven eligibility terms above is ALSO computed as
  // its own named boolean, paired with a stable token in
  // `sameHeadRerollTerms` -- `sameHeadRerollEligible` (`.every()`) and
  // `sameHeadRerollIneligibleReasons` (`.filter().map()`) are BOTH derived
  // from that one array, so they cannot disagree; a term added to the
  // conjunction without a paired token here would be a compile-time
  // array-literal edit, not a
  // hand-maintained parallel expression. `reviewItemCountPositiveTerm` is
  // deliberately written as "unknown counts as satisfied"
  // (`itemCount === null || itemCount > 0`), not the bare `itemCount > 0`
  // the original two-line conjunct implied standalone: this keeps the two
  // item-count terms mutually exclusive in `ineligibleReasons` (an unknown
  // count reports ONLY `review-item-count-unknown`, never also
  // `review-item-count-not-positive`), while `reviewItemCountKnownTerm &&
  // reviewItemCountPositiveTerm` together still reduce to exactly the
  // original `itemCount !== null && itemCount > 0` conjunct.
  // #1880: `reviewItemCountPositiveTerm` ALSO counts `suppressedCount > 0`
  // as "positive" -- `itemCount` and `suppressedCount` are both read from
  // the SAME static review snapshot (never updated by later disposition
  // activity, same as `itemCount`'s own doc comment on
  // `AdvisoryConvergenceReviewClause`), so a suppressed-only block is the
  // identical "nothing else can clear this except a fresh review" shape
  // #1511's reroll exists for. The token's FAILURE condition stays exactly
  // as precise as before: `REVIEW_ITEM_COUNT_NOT_POSITIVE` now fires only
  // when itemCount is a known 0 AND suppressedCount is also 0 -- i.e.
  // genuinely nothing (posted or suppressed) to reroll for, still an
  // accurate reading of the existing token name/doc row.
  // #1686: `indeterminate` now also disqualifies a same-HEAD reroll --
  // offering to reroll Copilot is pointless while the underlying claim
  // linkage itself is broken/ambiguous, so this term (and its
  // `SCOPE_NOT_APPLICABLE` token; see that token's doc row in
  // docs/idd-helper-scripts.md) fires for either non-`applicable` status.
  const scopeApplicableTerm = !scopeBlocksConvergenceEval;
  const reviewNotPendingTerm = !pending;
  const threadsSatisfiedTerm = threadClause.satisfied;
  const noMissingRegularCommentsTerm =
    dispositionEvidence.missingRegularCommentCount === 0;
  const reviewItemCountKnownTerm = review.itemCount !== null;
  const reviewItemCountPositiveTerm =
    review.itemCount === null ||
    review.itemCount > 0 ||
    review.suppressedCount > 0;
  // #2056: a valid review-ack can make `reviewSatisfied` true while
  // `suppressedCount` stays positive -- without this term, eligible /
  // requestable would still tell a caller to spend an AW6 reroll on a
  // review that is already covered. Scoped to ack-based satisfaction
  // (`reviewSatisfied && hasValidReviewAck`) so a clean `itemCount: 0`
  // review still reports ONLY `review-item-count-not-positive`.
  const notAlreadySatisfiedViaReviewAckTerm = !(
    reviewSatisfied && hasValidReviewAck
  );
  const sameHeadRerollTerms = [
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.SCOPE_NOT_APPLICABLE,
      satisfied: scopeApplicableTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_PENDING,
      satisfied: reviewNotPendingTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.UNRESOLVED_COPILOT_THREADS,
      satisfied: threadsSatisfiedTerm,
    },
    {
      token:
        SAME_HEAD_REROLL_INELIGIBLE_REASON.MISSING_REGULAR_COMMENT_DISPOSITION,
      satisfied: noMissingRegularCommentsTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_UNKNOWN,
      satisfied: reviewItemCountKnownTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_NOT_POSITIVE,
      satisfied: reviewItemCountPositiveTerm,
    },
    {
      token:
        SAME_HEAD_REROLL_INELIGIBLE_REASON.ALREADY_SATISFIED_VIA_REVIEW_ACK,
      satisfied: notAlreadySatisfiedViaReviewAckTerm,
    },
  ];
  const sameHeadRerollEligible = sameHeadRerollTerms.every(
    (term) => term.satisfied,
  );
  const sameHeadRerollIneligibleReasons = sameHeadRerollTerms
    .filter((term) => !term.satisfied)
    .map((term) => term.token);
  const sameHeadRerollCap =
    Number.isInteger(options.sameHeadRerollCap) &&
    Number(options.sameHeadRerollCap) > 0
      ? Number(options.sameHeadRerollCap)
      : DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP;
  const pendingWindowMinutesForReroll =
    Number.isFinite(options.pendingWindowMinutes) &&
    Number(options.pendingWindowMinutes) > 0
      ? Number(options.pendingWindowMinutes)
      : DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES;
  const rerollMarkers = summarizeSameHeadRerollMarkers(
    comments,
    prHeadSha,
    trustedMarkerLogins,
  );
  // A fresh primary-bot review submitted AT OR AFTER the latest reroll
  // marker's own GitHub `created_at` means that request has already been
  // answered -- regardless of what the fresh review's itemCount turned out
  // to be (a "1 -> 3" surprise is still an answer; it is simply not a
  // converging one, and the normal E1/E4 triage path handles it, never this
  // evidence). `>=`, not `>`: the marker's `created_at` comes from the REST
  // comments endpoint while the review's `submittedAt` is fetched
  // separately via GraphQL, so an equal recorded server timestamp (e.g.
  // both landing in the same second) must still count as answered -- a
  // strict `>` would otherwise wait out the full pending window on a tie
  // that already represents a genuine response (PR #1517 review). A
  // missing/invalid `submittedAt` fails closed toward "not yet answered"
  // (never toward a false "landed"), same direction as `isValidIsoTimestamp`
  // guards elsewhere in this file.
  const hasFreshReviewSinceLastReroll =
    rerollMarkers.latestAt !== '' &&
    isValidIsoTimestamp(review.submittedAt) &&
    Date.parse(review.submittedAt) >= Date.parse(rerollMarkers.latestAt);
  const rerollElapsedMinutes =
    rerollMarkers.latestAt !== ''
      ? minutesBetween(rerollMarkers.latestAt, now)
      : 0;
  // Bounding "in flight" by the same advisoryWait.pendingWindow the AW3
  // decision table already uses for "bot is pending a re-request" (no new
  // duration knob) is what makes resume/restart exact: an old, never-
  // answered reroll self-describes as no-longer-in-flight once the window
  // elapses, instead of blocking a retry forever if the bot goes silent.
  const sameHeadRerollInFlight =
    !scopeBlocksConvergenceEval &&
    rerollMarkers.latestAt !== '' &&
    !hasFreshReviewSinceLastReroll &&
    rerollElapsedMinutes < pendingWindowMinutesForReroll;
  const sameHeadRerollExhausted = rerollMarkers.count >= sameHeadRerollCap;
  const sameHeadReroll = {
    eligible: sameHeadRerollEligible,
    ineligibleReasons: sameHeadRerollIneligibleReasons,
    count: rerollMarkers.count,
    cap: sameHeadRerollCap,
    exhausted: sameHeadRerollExhausted,
    latestAt: rerollMarkers.latestAt,
    inFlight: sameHeadRerollInFlight,
    requestable:
      sameHeadRerollEligible &&
      !sameHeadRerollExhausted &&
      !sameHeadRerollInFlight,
  };
  // --- Deadline clock, anchored on the current HEAD commit's own --------
  // --- timestamp (not an IDD marker -- see module header for why) -------
  const deadlineMinutes = Number.isFinite(options.deadlineMinutes)
    ? Number(options.deadlineMinutes)
    : DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES;
  const headCommittedAt = String(options.headCommittedAt ?? '');
  const elapsedMinutes = isValidIsoTimestamp(headCommittedAt)
    ? minutesBetween(headCommittedAt, now)
    : null;
  const deadlinePassed =
    elapsedMinutes !== null && elapsedMinutes >= deadlineMinutes;
  const deadline = {
    minutes: deadlineMinutes,
    headCommittedAt,
    elapsedMinutes,
    passed: deadlinePassed,
  };
  // --- Terminal Copilot-unavailability evidence (#1570/#1572) ------------
  // Reuses `review.commitId` (Clause 1's absolute-latest Copilot review, `''`
  // when none exists) as the `lastCopilotCommit` input -- the same fetched
  // evidence, no separate lookup. Purely additive: computed unconditionally,
  // reported in its own `terminal` field (never merged into `deadline`
  // above), and -- per `buildCopilotRecoverySummary`'s own contract --
  // `state: "COPILOT_UNAVAILABLE"` is waiver *eligibility* only. It is
  // structurally impossible for `terminal` alone to set `converged`/`ready`:
  // see the waiver-gate and `ready` computation below, both of which require
  // a valid waiver in addition to `terminalUnavailable`.
  // Note: `pre-merge-readiness.mts` resolves `lastCopilotCommit` differently
  // (submittedAt-sorted via `findLastCopilotReviewCommit`, not fetch-order
  // `.at(-1)`), so under a force-push/revert ordering the two gates could
  // disagree on terminal state. Tolerable by construction: both gates must
  // independently pass to merge, so any disagreement fails closed (the
  // stricter side blocks; a waiver resolves it) -- never an unsafe merge.
  const recoveryCycleCap =
    Number.isFinite(options.recoveryCycleCap) &&
    Number(options.recoveryCycleCap) > 0
      ? Number(options.recoveryCycleCap)
      : DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP;
  const terminalWindowMinutesOption =
    Number.isFinite(options.terminalWindowMinutes) &&
    Number(options.terminalWindowMinutes) > 0
      ? Number(options.terminalWindowMinutes)
      : DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES;
  const terminal = buildCopilotRecoverySummary(
    { comments, prHeadSha, lastCopilotCommit: review.commitId },
    {
      now,
      trustedMarkerLogins,
      claimId: activeClaimId,
      agentId: claim.activeClaim?.agentId ?? '',
      recoveryCycleCap,
      terminalWindowMinutes: terminalWindowMinutesOption,
    },
  );
  const terminalUnavailable = terminal.state === 'COPILOT_UNAVAILABLE';
  // --- Waiver escape hatch (reachable once the deadline has passed, or ---
  // --- once terminal Copilot unavailability is proven -- either one ------
  // --- independently opens the SAME waiver-evidence check below) ---------
  const waiverMode = String(options.waiverMode ?? 'disabled');
  const waiverCheckSelector =
    String(options.waiverCheckSelector ?? '').trim() ||
    ADVISORY_CONVERGENCE_CHECK_SELECTOR;
  let validWaiverCount = 0;
  // #2353: default when the enclosing precondition never opens -- no
  // declaration relief can apply before the SAME precondition the direct
  // waiver above requires has opened.
  let outageRelief = {
    relieved: false,
    reason: 'waiver precondition not open',
  };
  if (
    !converged &&
    (deadlinePassed || terminalUnavailable) &&
    waiverMode === 'maintainer-authorized'
  ) {
    const waiverEvidence = summarizeExternalCheckWaivers(comments, {
      prHeadSha,
      activeClaimId,
      activeClaimSupersedes,
      trustedMarkerLogins,
      now,
      // The REAL configured `ciGate.externalChecks.waivable` list (not a
      // hardcoded single-entry override for this gate's own selector):
      // respects the existing two-dimensional waiver opt-in
      // (`externalCheckWaivers.mode` AND a per-check `waivable`
      // registration) instead of silently making this gate waivable the
      // moment ANY external check is opted into waiver mode (see PR #1343
      // review). An absent/empty list waives nothing, matching
      // `summarizeExternalCheckWaivers`'s own "empty list waives nothing"
      // contract.
      waivableSelectors: [...(options.waivableSelectors ?? [])],
      maxValidity: String(options.waiverMaxValidity ?? 'PT24H'),
      // Explicit rather than relying solely on the enclosing `if`'s
      // `waiverMode === 'maintainer-authorized'` guard above (Copilot
      // review, PR #2895): a future refactor that loosens that guard
      // without noticing this implicit dependency could otherwise
      // silently reopen this call's own mode gate. Matches the
      // auto-waiver call below, which already passes this explicitly.
      mode: waiverMode,
    });
    // Even when the configured list makes SOME check waivable, only count a
    // waiver whose own marker selector is THIS gate's selector -- a valid
    // waiver for an unrelated external check must never satisfy this one.
    // The SAME evidence collection satisfies either precondition above: a
    // maintainer posts one waiver marker for this selector/HEAD/claim, and
    // whichever precondition (ordinary deadline, or terminal eligibility)
    // is currently open consumes it -- see the `ready` computation below,
    // which still requires the precondition it corresponds to.
    validWaiverCount = waiverEvidence.valid.filter(
      (entry) => entry.checkSelector === waiverCheckSelector,
    ).length;
    // #2353: a repository-scoped `providerOutage.declarationTarget`
    // declaration substitutes for a per-pull-request waiver marker on THIS
    // selector, gated by the SAME enclosing precondition as the direct
    // waiver above, plus `evaluateProviderOutageRelief`'s own additional
    // requirement that THIS pull request's own terminal-unavailable state
    // independently holds -- never the deadline-only opener, even though
    // the deadline path can also reach this branch. A declaration active
    // only under a passed deadline (no proven terminal state) therefore
    // still yields `relieved: false` here, by that function's own contract.
    outageRelief = evaluateProviderOutageRelief({
      declarationActive: options.outageDeclarationActive === true,
      prTerminalUnavailable: terminalUnavailable,
      requestedSelector: waiverCheckSelector,
      waivableSelectors: [...(options.waivableSelectors ?? [])],
    });
  }
  // --- Self-referential-bootstrap-auto waiver (kurone-kito/idd-skill#2657) -
  // --- Evaluated UNCONDITIONALLY -- never gated behind
  // `deadlinePassed`/`terminalUnavailable` the way the ordinary waiver
  // below is. This is the 2026-09-11 hearing's fix for the 2026-09-10
  // self-cancellation bug: a waiver whose validity window shares
  // `deadlinePassed`'s own anchor/duration is always already expired by
  // the time it would ever be read through that same gated branch.
  // Computed BEFORE the `waiver` object below so its own outcome can be
  // reported there (Copilot review, PR #2895: a `ready: true` verdict
  // reached solely through this path previously exposed no field
  // explaining why, contradicting the published `ready` formula).
  //
  // A SECOND `summarizeExternalCheckWaivers` call, identical to the
  // primary call below in every option except `trustedMarkerLogins` --
  // which is extended to include `github-actions[bot]` for THIS call
  // only. The primary call's own `trustedMarkerLogins` binding is never
  // reassigned, so this can never widen trust for an ordinary
  // person-authored waiver. `mode` is threaded through identically: an
  // adopter with `ciGate.externalCheckWaivers.mode` not
  // `maintainer-authorized` gets no automated waiver either, matching
  // the manual flow.
  const autoWaiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId,
    activeClaimSupersedes,
    trustedMarkerLogins: [...trustedMarkerLogins, 'github-actions[bot]'],
    now,
    waivableSelectors: [...(options.waivableSelectors ?? [])],
    maxValidity: String(options.waiverMaxValidity ?? 'PT24H'),
    mode: waiverMode,
    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): one of exactly
    // three authorized call sites (kurone-kito/idd-skill#2911 added the
    // third, in pre-merge-readiness.mts's own stale-self-waiver merge
    // blocker) -- see `allowSelfReferentialBootstrapAuto`'s own doc
    // comment in protocol-helpers.mts for the full list and why every
    // other caller must leave this unset. This one is the GATE decision
    // (feeds `autoWaiverValid` directly below), paired with the
    // independent run-id/event-type/HEAD/repository/changed-file
    // verification that follows.
    allowSelfReferentialBootstrapAuto: true,
  });
  const autoWaiverRepositoryFullName = String(
    options.repositoryFullName ?? '',
  ).trim();
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895): independently
  // verify the PR's own diff actually touches the committed allowlist,
  // rather than trusting the posting job's own internal check to have
  // enforced it -- see `AdvisoryConvergenceInputs.changedFilePaths`'s
  // doc comment for the exact bypass this closes. This is a hard
  // precondition on `autoWaiverValid` below, independent of the four
  // run-id trust conditions.
  const selfReferentialTriggerFiles = resolveSelfReferentialTriggerFiles(
    options.helperRuntimeProfile,
    autoWaiverRepositoryFullName,
  );
  const touchesSelfReferentialAllowlist = (inputs.changedFilePaths ?? []).some(
    (path) => selfReferentialTriggerFiles.includes(path),
  );
  // Defense in depth: the trust-set extension above already scopes the
  // call to one login, but a marker's `reason`/`runId` are still
  // attacker-shaped input from that login's own comment body, so this
  // filters the specific marker kind within it rather than trusting
  // every `github-actions[bot]`-authored waiver of any reason.
  //
  // kurone-kito/idd-skill#2657 (Copilot review, PR #2895, round 10):
  // additionally blocked when `scopeIndeterminate` AND no active claim
  // resolves (`!claim.activeClaimPresent`) -- NOT `scopeIndeterminate`
  // alone, which would also block the `idd-claimed-branch-mismatch`
  // sub-case a prior test already pins as intentionally still
  // auto-waivable ("#1686 path 3 symmetry"): that sub-case's own real,
  // bindable `activeClaimId` means an accepted marker there is bound to
  // a KNOWN, exactly-matched claim, not the `none` sentinel -- no
  // safeguard to bypass. The two sub-cases this DOES need to block
  // (`idd-claimed-multiple-resolving-claim-candidates` and
  // `idd-claimed-claim-history-without-active-claim`) both fall under
  // `!claim.activeClaimPresent`, where the CONSUMER's own claim
  // resolution reports an empty active claim, same as a genuinely
  // claimless PR -- letting a `none`-bound auto-bootstrap marker
  // validate through the unconditional auto-waiver branch there would
  // bypass the `scopeIndeterminate` human-review requirement with no
  // human judgment involved at all, unlike the ordinary
  // maintainer-authorized waiver (which intentionally CAN resolve
  // `scopeIndeterminate`, per that path's own gating on
  // `scopeNotApplicable` alone -- a human maintainer's explicit judgment
  // call, not a mechanical one). `all-prs` scope (the default) never
  // produces `scopeIndeterminate` at all, so this is a no-op there.
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 16): the
  // round 10 guard just above only ever fires when `scopeIndeterminate`
  // can be non-trivially true, which per its own doc comment never
  // happens under `all-prs` scope (this repository's own configured
  // default) -- so it provides NO protection there against the exact
  // same "multiple linked issues expose active claims" ambiguity
  // `selectLinkedIssueCandidate` (`external-check-waiver.mts`) refuses
  // to auto-post a marker for in the first place. Without this, a
  // forged `claim-id:none` marker citing a legitimate, concurrently
  // running `pull_request_target` run's id (the run-id check alone
  // verifies only that CITED run's own metadata, not that it actually
  // posted this comment -- the general form of that gap is closed by
  // `verifySelfReferentialBootstrapWaiverProvenance` and
  // `verifySelfReferentialBootstrapWaiverArtifactBinding` below,
  // kurone-kito/idd-skill#2912; this `claimCandidateAmbiguous` guard is
  // independent defense-in-depth for
  // the SPECIFIC claim-ambiguity shape, not a substitute for either)
  // could validate on such a PR even though the legitimate posting
  // helper would have refused to post ANY marker for it.
  // `claimCandidateAmbiguous` is the SAME signal the producer
  // uses (`classifyClaimCandidateAmbiguity`), independent of
  // `convergenceScope`, so gate on it directly here too rather than
  // only through the scope-specific check above.
  const autoWaiverValid =
    !scopeNotApplicable &&
    !(scopeIndeterminate && !claim.activeClaimPresent) &&
    !claimCandidateAmbiguous &&
    touchesSelfReferentialAllowlist &&
    autoWaiverEvidence.valid.some(
      (entry) =>
        entry.checkSelector === waiverCheckSelector &&
        entry.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON &&
        entry.authorLogin === 'github-actions[bot]' &&
        entry.runId !== '' &&
        verifySelfReferentialBootstrapWaiverRun(
          inputs.autoWaiverRunLookups?.[entry.runId],
          {
            path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
            headSha: prHeadSha,
            repositoryFullName: autoWaiverRepositoryFullName,
          },
        ) &&
        // kurone-kito/idd-skill#2912: prove the cited run's OWN job
        // posted THIS comment, not merely that some run with the right
        // shape exists -- see `verifySelfReferentialBootstrapWaiverProvenance`'s
        // own doc comment for the gap this closes.
        verifySelfReferentialBootstrapWaiverProvenance(
          inputs.autoWaiverRunJobLookups?.[entry.runId],
          entry.createdAt,
        ) &&
        // kurone-kito/idd-skill#2912 (round 2, extended round 3): prove
        // the cited run's own trusted execution positively recorded
        // posting THIS EXACT comment, by id AND body content (via a
        // run-scoped Actions artifact only that run's own upload token
        // could have created), not merely that no OTHER candidate
        // currently happens to be visible (round 1) or that some
        // candidate with a matching id exists regardless of whether its
        // body was since edited in place (round 2) -- see
        // `verifySelfReferentialBootstrapWaiverArtifactBinding`'s own
        // doc comment for the comment-deletion and edit-in-place
        // forgeries this closes.
        verifySelfReferentialBootstrapWaiverArtifactBinding(
          inputs.autoWaiverRunIdCandidates?.[entry.runId],
          inputs.autoWaiverRunArtifactBindings?.[entry.runId],
          entry.createdAt,
        ),
    );
  const waiver = {
    mode: waiverMode,
    checkSelector: waiverCheckSelector,
    activeClaimId,
    validCount: validWaiverCount,
    outageRelieved: outageRelief.relieved,
    autoWaiverValid,
  };
  const waived =
    !scopeNotApplicable && (validWaiverCount > 0 || outageRelief.relieved);
  if (!scopeNotApplicable && !converged && terminalUnavailable && !waived) {
    reasons.push(
      waiverMode === 'maintainer-authorized'
        ? `Copilot is terminally unavailable (recovery cap exhausted and terminal window elapsed with no current-HEAD review) with no valid maintainer external-check waiver and no active provider-outage declaration relief for selector "${waiverCheckSelector}" on current HEAD`
        : `Copilot is terminally unavailable (recovery cap exhausted and terminal window elapsed with no current-HEAD review) and no waiver is available (ciGate.externalCheckWaivers.mode is "${waiverMode}", not "maintainer-authorized")`,
    );
  } else if (!scopeNotApplicable && !converged && deadlinePassed && !waived) {
    reasons.push(
      waiverMode === 'maintainer-authorized'
        ? `deadline (${deadlineMinutes}m) passed with no valid maintainer external-check waiver for selector "${waiverCheckSelector}" on current HEAD (a provider-outage declaration cannot relieve the deadline-only path -- it requires this pull request's own proven terminal-unavailable state)`
        : `deadline (${deadlineMinutes}m) passed and no waiver is available (ciGate.externalCheckWaivers.mode is "${waiverMode}", not "maintainer-authorized")`,
    );
  }
  const ready =
    scopeNotApplicable ||
    converged ||
    ((deadlinePassed || terminalUnavailable) && waived) ||
    autoWaiverValid;
  // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): the
  // `reasons.push` guards above only exclude `waived`, so a `ready`
  // verdict reached solely through `autoWaiverValid` (never gated
  // behind `deadlinePassed`/`terminalUnavailable` the way `waived` is)
  // could otherwise carry a stale "deadline passed with no valid
  // waiver" or "terminally unavailable" explanation alongside
  // `ready: true` -- a directly contradictory pair no consumer of this
  // JSON verdict should ever see. Mirrors the existing `nextActions`
  // invariant below: a ready verdict's `reasons` is always `[]`.
  if (ready) {
    reasons.length = 0;
  }
  const reviewReport = {
    ...review,
    satisfied: reviewSatisfied,
  };
  // #2143: same catalog as the stderr track. Computed AFTER `ready` so a
  // ready verdict is always `[]`; `ready` itself never reads this field.
  const nextActions = collectAssertNextActions({
    ready,
    prNumber: inputs.prNumber,
    prHeadSha,
    primaryBotLogin,
    applicability,
    review: reviewReport,
    threads: threadClause,
    deadline,
    waiver,
    sameHeadReroll,
    terminal,
  });
  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prNumber: inputs.prNumber,
    prHeadSha,
    now,
    primaryBotLogin,
    applicability,
    // #2050: `satisfied` reported here is the disposition-aware override
    // (`reviewSatisfied`), not the raw mechanical value
    // `resolveLatestCopilotReviewClause` itself returns -- every other field
    // (`matchesHead` / `itemCount` / `suppressedCount` / `submittedAt` /
    // `found` / `commitId`) is untouched.
    review: reviewReport,
    threads: threadClause,
    pending,
    deadline,
    waiver,
    dispositionEvidence: dispositionEvidenceReport,
    sameHeadReroll,
    terminal,
    converged,
    waived,
    ready,
    reasons,
    nextActions,
  };
}
// `isVerifiedCopilotAuthor` (#1686 defense-in-depth on top of
// `isCopilotReviewerLogin`'s login-string check) and
// `resolveLatestCopilotReviewClause` (Clause 1 evaluation against the
// single, absolute-latest Copilot review) now live in `review-clause.mts`
// and are imported above -- both used here unchanged, with
// `isVerifiedCopilotAuthor` also reused directly by
// `classifyCopilotAuthoredThreadIds` below.
/** Thread IDs whose *originating* (first) comment is Copilot-authored.
 * `summarizeReviewThreadsForGate` classifies by latest-commenter identity
 * for a different purpose (backlog gating) and is not bot-scoped, so this
 * is new, narrow logic -- the disposition-marker validity it feeds into
 * still comes entirely from the reused `summarizeDispositionEvidenceForGate`
 * output. */
export function classifyCopilotAuthoredThreadIds(threads, primaryBotLogin) {
  const ids = new Set();
  threads.forEach((thread, index) => {
    // GitHub's GraphQL `comments` connection on a review thread returns
    // comments in creation order -- the same assumption `fetchReviewThreads`
    // / `fetchThreadCommentPages` already rely on when appending paginated
    // results without re-sorting -- so the thread-opening comment is always
    // `nodes[0]`. Deliberately not timestamp-sorted: `compareIsoTimestamps`
    // sorts a missing/invalid `createdAt` BEFORE any valid one (by design,
    // for existing "pick the latest, ignore garbage" call sites elsewhere),
    // which would let a later reply with a bad timestamp silently usurp
    // "originating" status and make a genuinely Copilot-opened thread
    // invisible to this gate.
    const originating = (thread.comments?.nodes ?? [])[0];
    if (
      originating &&
      isVerifiedCopilotAuthor(originating.author, primaryBotLogin)
    ) {
      // Match `summarizeDispositionEvidenceForGate`'s own
      // `missingThreads[].id` fallback exactly (protocol-helpers.mts) so a
      // thread with an empty/missing GraphQL id still round-trips through
      // the `.has()` lookup in the caller instead of silently diverging.
      ids.add(String(thread.id ?? '') || `thread-${index + 1}`);
    }
  });
  return ids;
}
/**
 * #2050: Copilot-authored thread IDs whose *originating* comment belongs to
 * a SPECIFIC review (matched by GraphQL review node id), unlike
 * {@link classifyCopilotAuthoredThreadIds}'s review-agnostic set (every
 * Copilot-authored thread anywhere in the PR's history -- which Clause 2
 * genuinely needs). Clause 1's `itemCount`-half needs narrower, review-bound
 * evidence: `threadClause.satisfied` alone can be vacuously true from an
 * OLDER, already-dispositioned review's threads while the LATEST review's
 * own items have no thread representation at all -- a resolved-but-stale
 * thread must never stand in for the CURRENT review's own coverage (Copilot
 * review, this PR). Each thread's originating comment's `pullRequestReview`
 * is already fetched by `fetchReviewThreads` below; matching on its `id`
 * against a Copilot review's own `id` (review-clause.mts's `reviewId`) also
 * proves Copilot authorship by construction (every comment in one GitHub
 * review shares that review's single author), but `isVerifiedCopilotAuthor`
 * is still checked directly for defense-in-depth, matching this file's
 * existing convention. `reviewId === ''` (not found / off-HEAD) always
 * returns an empty set, fail-closed.
 */
export function classifyThreadIdsForReview(threads, primaryBotLogin, reviewId) {
  const ids = new Set();
  if (!reviewId) return ids;
  threads.forEach((thread, index) => {
    const originating = (thread.comments?.nodes ?? [])[0];
    if (
      originating &&
      isVerifiedCopilotAuthor(originating.author, primaryBotLogin) &&
      String(originating.pullRequestReview?.id ?? '') === reviewId
    ) {
      ids.add(String(thread.id ?? '') || `thread-${index + 1}`);
    }
  });
  return ids;
}
/**
 * Same-HEAD advisory reroll marker evidence (#1511): count and latest
 * GitHub `created_at` of trusted `advisory-reroll:` comments whose embedded
 * HEAD SHA matches the current HEAD. Mirrors `summarizeAdvisoryWaitMarkers`
 * (protocol-helpers.mts)'s same-head-scoped half, but kept local to this
 * file rather than added there -- matching the `classifyCopilotAuthored-
 * ThreadIds` precedent above (new, gate-specific logic that no other
 * helper needs). Deliberately does NOT feed `advisory-wait:`'s unscoped
 * REQUEST_CAP counting: separateness from that cap is a named #1511
 * acceptance criterion, achieved simply by using a distinct marker prefix
 * that `summarizeAdvisoryWaitMarkers`'s own regexes never match.
 */
function summarizeSameHeadRerollMarkers(
  comments,
  prHeadSha,
  trustedMarkerLogins,
) {
  const trusted = new Set(trustedMarkerLogins);
  // prHeadSha is already validated to `^[0-9a-f]{40}$` by the caller (see
  // the top of computeAdvisoryConvergenceVerdict), so it is safe to embed
  // directly in a RegExp literal with no escaping -- a hex string has no
  // regex-special characters. Requires the FULL canonical marker shape --
  // a valid trailing ISO-8601 timestamp, end-anchored -- matching the
  // `advisory-reroll:` entry in `OPERATIONAL_MARKERS` (marker-helpers.mts)
  // exactly, not merely a loose prefix+SHA check: an accidental or
  // malformed trusted comment (a typo'd timestamp, or appended prose after
  // the SHA) must never consume one of the bounded reroll attempts, since
  // that budget is small (default 2) and a false increment costs much more
  // proportionally than it would against the much larger REQUEST_CAP
  // (PR #1517 review).
  const pattern = new RegExp(
    `^advisory-reroll:\\s+\\S+\\s+${prHeadSha}\\s+\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z\\s*$`,
  );
  let count = 0;
  let latestAt = '';
  for (const comment of comments) {
    const body = String(comment.body ?? '').trimEnd();
    if (!pattern.test(body)) continue;
    const login = String(comment.author?.login ?? comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trusted.has(login)) continue;
    count += 1;
    // GitHub server `createdAt`/`created_at` ONLY -- never an embedded,
    // agent-supplied timestamp. Same "clock anchor is marker created_at,
    // not embedded text" invariant AW2 already states for advisory-wait:,
    // load-bearing here since `inFlight` compares this against
    // `review.submittedAt`, another GitHub server timestamp.
    const createdAt = String(comment.createdAt ?? comment.created_at ?? '');
    if (
      isValidIsoTimestamp(createdAt) &&
      (!latestAt || Date.parse(createdAt) > Date.parse(latestAt))
    ) {
      latestAt = createdAt;
    }
  }
  return { count, latestAt };
}
// #2050 / #2056: requires the FULL canonical `review-ack:` marker shape --
// a valid trailing ISO-8601 timestamp, end-anchored -- matching the
// `review-ack:` entry in `OPERATIONAL_MARKERS` (marker-helpers.mts)
// exactly, same reasoning as `summarizeSameHeadRerollMarkers`'s own
// pattern above: a malformed or truncated comment must never count as a
// valid ack. Kept as a fixed module-level constant: group 1 is the
// embedded HEAD SHA (compared to the current PR HEAD in
// `resolveHasValidReviewAck`) and group 2 is the embedded timestamp
// (validated with `isValidIsoTimestamp` -- the bare digit-shape match
// alone accepts a syntactically-digit-shaped but semantically invalid
// calendar date/time, e.g. `2026-99-99T99:99:99Z`).
const REVIEW_ACK_MARKER_PATTERN =
  /^review-ack:\s+\S+\s+([0-9a-f]{40})\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/;
/**
 * #2050 / #2056: disposition-aware Clause 1 escape hatch -- true when a
 * trusted `review-ack:` marker exists on the PR whose OWN GitHub-assigned
 * `created_at` (never an embedded, agent-supplied timestamp -- the same
 * "clock anchor is marker created_at, not embedded text" trust boundary
 * `hasFreshDisposition` (protocol-helpers.mts) and
 * `summarizeSameHeadRerollMarkers` above both already apply) is strictly
 * after the latest primary-bot review's own `submittedAt`, AND whose
 * embedded HEAD SHA equals the current PR HEAD (the same same-HEAD
 * filter `summarizeSameHeadRerollMarkers` already applies to
 * `advisory-reroll` markers).
 *
 * The `createdAt > submittedAt` ordering still invalidates a pre-existing
 * ack when a later review lands (same HEAD or not, e.g. an AW6 same-HEAD
 * reroll). The SHA check closes the delayed-POST race the ordering
 * check cannot: a marker that embedded HEAD A can still receive a
 * GitHub `createdAt` after review B's `submittedAt` if the PR advanced
 * between render and POST.
 *
 * Fails closed (returns `false`) when `reviewSubmittedAt` is missing or
 * invalid, or when `prHeadSha` is empty, since there is then no anchor
 * to compare an ack against.
 */
function resolveHasValidReviewAck(
  comments,
  trustedMarkerLogins,
  reviewSubmittedAt,
  prHeadSha,
) {
  if (!isValidIsoTimestamp(reviewSubmittedAt) || !prHeadSha) {
    return false;
  }
  const trusted = new Set(trustedMarkerLogins);
  return comments.some((comment) => {
    const body = String(comment.body ?? '').trimEnd();
    const match = body.match(REVIEW_ACK_MARKER_PATTERN);
    // Group 1 = embedded HEAD SHA, group 2 = embedded timestamp.
    // The timestamp is otherwise never trusted for the
    // createdAt-vs-submittedAt comparison below, but a marker whose OWN
    // digit-shaped field is not a real calendar date/time is malformed --
    // reject it here the same way `detectMalformedOperationalMarker`
    // (marker-helpers.mts) rejects other structurally-invalid markers.
    if (!match || match[1] !== prHeadSha || !isValidIsoTimestamp(match[2])) {
      return false;
    }
    const login = String(comment.author?.login ?? comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trusted.has(login)) {
      return false;
    }
    // GitHub server `createdAt`/`created_at` ONLY -- never the marker's own
    // embedded (agent-supplied) timestamp field, same anchor rule AW2
    // already states for `advisory-wait:`.
    const createdAt = String(comment.createdAt ?? comment.created_at ?? '');
    return (
      isValidIsoTimestamp(createdAt) &&
      compareIsoTimestamps(createdAt, reviewSubmittedAt) > 0
    );
  });
}
/** Whole minutes elapsed from `start` to `end`, clamped to 0 and floored --
 * matching `minutesBetweenIso` (protocol-helpers.mts) exactly, so a clock-
 * skew or malformed-timestamp edge case can never make `deadline.elapsed-
 * Minutes` negative or fractional. Not reused directly since that helper is
 * not exported. */
function minutesBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const ADVISORY_CONVERGENCE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--claim-issue': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--advisory-bot-logins': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--assert': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, ADVISORY_CONVERGENCE_FLAG_SPEC);
  return {
    // Both resolve-to-null on an invalid/absent value (fails closed at the
    // caller) -- the established contract this migration must preserve;
    // see "an invalid --pr resolves to null" in tests/advisory-convergence.
    // test.mts.
    prNumber: parseCanonicalIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    claimIssueNumber: parseCanonicalIntegerOrNull(values['claim-issue']),
    trustedMarkerLogins: values['trusted-marker-logins'],
    advisoryBotLogins: values['advisory-bot-logins'],
    now: values.now,
    assert: values.assert,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/advisory-convergence.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--claim-issue <number>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--now <ISO8601>] [--assert] [--help]

Read-only: asserts whether the primary advisory bot's review has converged
on the current PR HEAD. Every invocation other than --help/-h prints the
JSON verdict to stdout. Without --assert, always exits 0 (report-only).
With --assert, exits non-zero unless the verdict is "ready" (converged, or
validly waived past the configured deadline).
`);
}
const defaultDeps = { collect: collectFromGitHub };
/**
 * Parse argv, collect evidence (via `deps.collect`, real `gh` calls by
 * default), compute the verdict, and derive the `--assert` exit code.
 * Mirrors `idd-merge-execute.mts`'s `runMergeExecute` DI pattern so tests
 * can substitute a fake `collect` instead of shelling out to `gh`.
 */
export function runAdvisoryConvergence(argv, deps = defaultDeps) {
  const args = parseArgs(argv);
  if (args.help) {
    return { verdict: null, exitCode: 0, help: true };
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  const { inputs, options } = deps.collect(args);
  const verdict = computeAdvisoryConvergenceVerdict(inputs, options);
  const exitCode = args.assert ? (verdict.ready ? 0 : 1) : 0;
  return { verdict, exitCode, help: false };
}
/**
 * #2015: `true` only for the narrow "primary bot has not reviewed this
 * pull request AT ALL yet" verdict shape -- the one case
 * {@link runAdvisoryConvergenceWithPoll} is allowed to poll on. Deliberately
 * NOT true for "the bot's latest review targets an older commit" (a
 * *different* `reasons[]` string, produced once `review.found` is `true`
 * but `matchesHead` is `false` -- see the `pending`/`reasons.push` pair in
 * {@link computeAdvisoryConvergenceVerdict}): once the bot has reviewed the
 * PR at least once, `review.found` stays `true` forever, so this predicate
 * can only ever fire before the bot's very first review lands. That is
 * exactly the issue #2015 acceptance criterion ("the only reason a first
 * check would fail is '{bot} has not reviewed this pull request yet' --
 * not on any other failure reason"), not an accidental scope gap: a later
 * push invalidating an earlier review is a different race with a different
 * reason string, and is intentionally left to fail immediately with no
 * wait, same as every other not-ready reason.
 *
 * `reasons.length === 1` is defense-in-depth, not redundant with the
 * `pending`/`review.found` pair: an unusually short configured deadline
 * (or a terminal-Copilot-unavailability state) can append its own reason
 * alongside the pending one, and this predicate must not poll then either
 * -- polling cannot help a deadline/terminal reason converge.
 */
export function isSoleCopilotNotReviewedYetReason(verdict) {
  return (
    verdict.pending &&
    !verdict.review.found &&
    verdict.reasons.length === 1 &&
    verdict.reasons[0] ===
      `${verdict.primaryBotLogin} has not reviewed this pull request yet`
  );
}
/** Poll interval for {@link runAdvisoryConvergenceWithPoll}'s bounded wait
 * (#2015), within the issue's suggested 5-10s cadence. */
export const DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS = 7_500;
/** Total bounded wait budget, across all poll attempts, for
 * {@link runAdvisoryConvergenceWithPoll} (#2015) -- the issue's suggested
 * ~60s ceiling. */
export const DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS = 60_000;
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');
/**
 * Resolve the configured Copilot-review bounded-poll interval/ceiling
 * (#2333) from `.github/idd/config.json`'s `advisoryConvergence` section,
 * scoped-validated the same way every policy reader in this file's
 * `advisory-wait-policy.mts` siblings validates its own subtree (#1359): an
 * unrelated invalid field elsewhere in the document must not zero out an
 * otherwise-valid `advisoryConvergence` section. Missing config, an
 * unreadable/malformed file, or a schema-invalid `advisoryConvergence`
 * section all fail closed to today's hardcoded defaults -- reproducing the
 * pre-#2333 behavior exactly, per that issue's own acceptance criterion.
 *
 * Deliberately a separate config subtree from `advisoryWait.pollInterval`
 * (`advisory-wait-policy.mts`, a whole-minute-only ISO 8601 duration): that
 * key governs the E-phase advisory-wait protocol's own longer-horizon wait
 * loop. This poll is shorter-lived and runs entirely inside the
 * `idd-advisory-convergence` required check itself, before the E-phase
 * protocol ever engages, so it needs sub-minute precision the whole-minute
 * pattern cannot express -- reusing that key's name or pattern here would
 * misrepresent this as the same setting.
 */
export function readCopilotReviewPollPolicy(path = '.github/idd/config.json') {
  const fallback = {
    pollIntervalMs: DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS,
    maxWaitMs: DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
  };
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryConvergence')
        .length > 0
    ) {
      return fallback;
    }
    const section = config?.advisoryConvergence ?? {};
    return {
      pollIntervalMs:
        parseIsoDurationToMs(section.copilotReviewPollInterval) ??
        fallback.pollIntervalMs,
      maxWaitMs:
        parseIsoDurationToMs(section.copilotReviewPollMaxWait) ??
        fallback.maxWaitMs,
    };
  } catch {
    return fallback;
  }
}
/** Falls back to `fallback` for a non-finite or non-positive value --
 * mirrors `gh-exec.mts`'s `withBoundedRetry` guard on its own duration
 * options, so a `NaN`/zero/negative caller-supplied interval or budget
 * cannot silently defeat the bound (a zero interval against a real,
 * non-faked clock would otherwise tight-loop until `maxWaitMs` elapses). */
function positiveMsOrDefault(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
/** Synchronous bounded sleep via `Atomics.wait` on a throwaway
 * `SharedArrayBuffer` -- the same technique
 * `rerun-advisory-convergence.mts`'s own `sleepSync` uses, chosen there (and
 * reused here rather than switching this file to `async`/`await`) so this
 * file can stay fully synchronous like every other helper in this module
 * family; duplicated as this one-line function rather than imported from
 * that sibling file, mirroring that file's own precedent of duplicating a
 * few lines over adding cross-file coupling for a narrow, already-stable
 * reuse. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * #2015: wraps {@link runAdvisoryConvergence} with a short, bounded poll
 * for the narrow case {@link isSoleCopilotNotReviewedYetReason} identifies
 * -- absorbing the common race where the `pull_request`/`pull_request_target`
 * `synchronize` trigger fires (and this CLI runs) before the primary
 * bot's own review has actually landed (typically 10-40s later). Every
 * other not-ready reason still fails on the very
 * first pass with no wait, exactly as {@link runAdvisoryConvergence} alone
 * already does -- this wrapper adds no new pass path, only absorbs a
 * latency this one specific reason is known to resolve on its own. Does
 * NOT change `--assert`'s exit-code contract or roadmap #1342's
 * deterministic, fail-closed convergence policy: if the bot's review still
 * has not landed by the end of the window, or lands with outstanding
 * items, the final result fails exactly as `runAdvisoryConvergence` alone
 * would have failed immediately.
 *
 * `exitCode !== 0` from the first attempt already implies `--assert` was
 * passed and the verdict was not ready (the only way
 * {@link runAdvisoryConvergence} returns non-zero), so this never needs to
 * re-parse `argv` itself to check `--assert`.
 *
 * The bound is wall-clock, not sleep-count: `maxWaitMs` is a deadline
 * (`now() + maxWaitMs`), and each iteration's actual sleep is capped to the
 * REMAINING budget, not the nominal `pollIntervalMs` (PR #2023 review,
 * Codex P2) -- production `collectFromGitHub` performs several real,
 * potentially slow `gh` calls per re-check, and counting only requested
 * sleep time (ignoring that collection time) could let the loop run well
 * past its documented bound and risk the hosting workflow's own
 * `timeout-minutes` before ever reaching its fail-closed exit.
 *
 * A re-check is never launched once a sleep has already consumed the full
 * remaining budget (PR #2023 review round 2, Codex P2 + Copilot) --
 * `collectFromGitHub` has its own independent `gh` timeouts (up to
 * `DEFAULT_GH_PAGINATED_TIMEOUT_MS` = 120s, #1675) that this poll's
 * `maxWaitMs` cannot bound from the outside, so starting a fresh collection
 * pass exactly AT the deadline could otherwise blow the wall-clock bound
 * wide open. KNOWN RESIDUAL: a collection that starts just BEFORE the
 * deadline (i.e. while genuine budget remains) can still run long, bounded
 * only by `gh-exec.mts`'s own per-call timeouts, not by `maxWaitMs` --
 * threading a remaining-budget deadline into every `gh` call inside
 * `collectFromGitHub` would close that gap but is a multi-call-site change
 * out of scope for this narrow poll wrapper. One consequence: a
 * `pollIntervalMs` configured `>=` `maxWaitMs` yields zero re-checks (the
 * first sleep alone exhausts the budget) -- an edge case only reachable via
 * an explicit non-default override, never the production defaults below.
 *
 * KNOWN RESIDUAL (PR #2023 review, Codex P1), reshaped by #2764 Phase 1:
 * the hosting workflow's concurrency group is keyed by PR number ALONE
 * across all three of its triggers, with `cancel-in-progress: true` (see
 * `idd-advisory-convergence.yml`'s own header). Originally, if the
 * primary bot's review landed WHILE this poll was still sleeping, that
 * submission started a fresh `pull_request_review`-triggered run
 * directly in the SAME concurrency group, cancelling this run before its
 * next scheduled re-check ever observed the review. `pull_request_review`
 * no longer triggers the hosting workflow directly (#2764 Phase 1 moved
 * it to a companion workflow); a review now reaches this run only
 * indirectly, via the companion's `gh run rerun` on an already-terminal
 * instance, not by entering this concurrency group as a fresh trigger
 * while a sibling is still polling. Whether a rerun re-entering this
 * group while another instance is still polling can still cancel it is
 * not re-derived here. No safe mechanical fix was found for the original
 * race within #2015's scope: narrowing the concurrency group would
 * defeat the deliberate cross-trigger debouncing the workflow's own
 * "Concurrency-hardening investigation"
 * comment already documents as load-bearing, and there is no way for a
 * script to detect an imminent cancellation from inside the run it is
 * about to lose. This is NOT a regression versus the pre-#2015 baseline,
 * only a narrower win than "no external rerun ever needed": before #2015,
 * this run always finished FAILURE well before the review landed (10-40s
 * later), so cancellation essentially never happened, but the resulting
 * rollup update from the later review-triggered run was ALREADY subject to
 * the exact same documented stale-rollup risk this residual describes (see
 * `#1381` in that same investigation comment) -- the pre-existing recovery
 * (`rerun-advisory-convergence.mjs`, which explicitly reruns a stale
 * CANCELLED-conclusion sibling instance, not only a FAILURE one) covers
 * this run's cancelled outcome exactly as it already covered the
 * pre-#2015 case. The poll's actual win is narrower than the eliminate-
 * every-rerun framing above: it resolves without any rerun specifically
 * when a scheduled re-check happens to observe the landed review before a
 * competing trigger's cancellation reaches this run -- which still occurs
 * whenever the review lands close to (but not exactly inside) an active
 * sleep, or after this poll's window has already closed.
 */
export function runAdvisoryConvergenceWithPoll(
  argv,
  deps = defaultDeps,
  pollOptions = {},
) {
  let result = runAdvisoryConvergence(argv, deps);
  if (
    result.exitCode !== 0 &&
    result.verdict &&
    isSoleCopilotNotReviewedYetReason(result.verdict)
  ) {
    const pollIntervalMs = positiveMsOrDefault(
      pollOptions.pollIntervalMs,
      DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS,
    );
    const maxWaitMs = positiveMsOrDefault(
      pollOptions.maxWaitMs,
      DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
    );
    const sleep = pollOptions.sleep ?? sleepSync;
    const now = pollOptions.now ?? Date.now;
    const deadline = now() + maxWaitMs;
    while (now() < deadline) {
      sleep(Math.min(pollIntervalMs, deadline - now()));
      // #2023 review round 2: don't launch a re-check once the sleep above
      // has already consumed the entire remaining budget -- see this
      // function's own doc comment for why (collection has its own
      // unbounded-relative-to-maxWaitMs `gh` timeouts).
      if (now() >= deadline) break;
      result = runAdvisoryConvergence(argv, deps);
      if (
        result.exitCode === 0 ||
        !result.verdict ||
        !isSoleCopilotNotReviewedYetReason(result.verdict)
      ) {
        break;
      }
    }
  }
  return result;
}
// --- Production I/O: fetch PR/review/thread/comment evidence via `gh` ----
/**
 * `gh` stdio policy for the viewer-login probe (`gh api user`).
 *
 * Under GitHub Actions the workflow token is a GitHub App installation token
 * with no authenticated user, so `gh api user` always returns 403 ("Resource
 * not accessible by integration"). That is expected and harmless here:
 * `viewerLogin === ''` is the correct value in CI (there is no runner "self"
 * whose markers should be trusted). Only the inherited stderr leaks the
 * confusing 403 line into the run log, so under Actions we capture that
 * run's stderr (`stdio` pipe) to keep the log clean.
 *
 * Outside Actions (a local/interactive run) the probe normally succeeds; if it
 * genuinely fails we deliberately **inherit** stderr so the failure stays
 * visible — a silently-empty `viewerLogin` narrows self-marker trust, the same
 * fail-noisy concern #1396 hardens for the roadmap-audit helper.
 *
 * Both branches set `stdio` **explicitly** rather than leaning on
 * `execFileSync`'s default: that default already writes the child's stderr to
 * the parent (so a bare call would leak the 403), but relying on it is
 * non-obvious. `pipe` captures stderr (silent); `inherit` forwards it to the
 * parent (visible). stdin is `ignore` on both.
 *
 * #2267: this exact policy now lives inside
 * `ProviderPort.resolveViewerLoginSafeQuiet`'s GitHub adapter implementation
 * (`provider-adapter-github.mts`), which `collectFromGitHub` below calls
 * instead of invoking `gh` directly. Kept here, unused in production, only
 * because it is directly unit-tested pure logic (no `gh` invocation of its
 * own) documenting the policy the adapter mirrors.
 */
export function viewerProbeGhOptions(env = process.env) {
  return {
    stdio:
      env.GITHUB_ACTIONS === 'true'
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'inherit'],
  };
}
/** Total attempts (including the first) for {@link retryTransientGhFailure}. */
const RETRY_TRANSIENT_GH_FAILURE_ATTEMPTS = 3;
/** Base delay (ms) for {@link retryTransientGhFailure}'s backoff + jitter. */
const RETRY_TRANSIENT_GH_FAILURE_BASE_DELAY_MS = 200;
/**
 * #2459: `collectFromGitHub`'s hot-path single-shot `gh` calls threw with
 * no retry on any failure, so a several-second runner network blip
 * crashed the whole required `idd-advisory-convergence` CI job instead of
 * self-healing, burning a full `ciWait.rerunPolicy` rerun-once budget
 * entry on pure infrastructure noise. Retry only a genuinely transient
 * failure: no parsed HTTP status (a transport-level blip with no server
 * response -- e.g. the truncated captured stdout `#1394` already
 * documents under heavy concurrent load) or a 5xx. A definitive 4xx
 * (not-found, forbidden, unauthorized, etc.) is a permanent rejection a
 * retry cannot fix, so it rethrows immediately instead of wasting the
 * attempt budget.
 *
 * Deliberately self-contained (reuses this file's own `sleepSync`, does
 * NOT import `gh-exec.mts`'s async `withBoundedRetry`): this file is
 * already migrated onto `provider-port.mts`
 * (`provider-port-migration-guard.test.mts`), which forbids regaining a
 * direct `gh-exec.mts` import; several of the wrapped port methods below
 * are also called, with no retry, by many other synchronous callers
 * across the codebase, so converting them (and this file's own synchronous call
 * chain) to `async` to use the Promise-based `withBoundedRetry` would
 * cascade well beyond this caller's scope.
 *
 * `deps.sleep` defaults to the real, blocking `sleepSync` (production
 * behavior); a test exercising a retry path injects a no-op to avoid a
 * real wall-clock delay per attempt (Copilot review, PR #2502).
 */
export function retryTransientGhFailure(task, deps = {}) {
  const sleep = deps.sleep ?? sleepSync;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return task();
    } catch (error) {
      const status = deriveGhHttpStatus(error);
      const retryable = status === null || status >= 500;
      if (attempt >= RETRY_TRANSIENT_GH_FAILURE_ATTEMPTS || !retryable) {
        throw error;
      }
      sleep(
        RETRY_TRANSIENT_GH_FAILURE_BASE_DELAY_MS * attempt +
          Math.random() * RETRY_TRANSIENT_GH_FAILURE_BASE_DELAY_MS,
      );
    }
  }
}
/**
 * `createPort` is injectable (defaults to the real GitHub adapter) so a test
 * can drive this collection entry end to end against
 * `createFakeProviderAdapter` fixtures instead of a live `gh` process
 * (#2267 AC4's "unit tests exercise the PR-facing state machine with a fake
 * provider" -- see the exported `collectFromGitHub` used directly by
 * `advisory-convergence-fake-provider.test.mts`). `defaultDeps.collect`
 * (this file's own production wiring for `runAdvisoryConvergence`) never
 * passes a second argument, so it keeps using the real adapter unchanged.
 */
export function collectFromGitHub(
  args,
  createPort = createGithubProviderAdapter,
) {
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createPort(owner, repo);
  const viewerLogin = port
    .resolveViewerLoginSafeQuiet()
    .viewerLogin.toLowerCase();
  const rawConfig = loadIddConfig();
  const { actors: configuredTrustedActors } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: rawConfig,
  });
  const { logins: advisoryBotLogins } = resolveAdvisoryBotLogins({
    flagValue: args.advisoryBotLogins,
    envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
    config: rawConfig,
  });
  const view = retryTransientGhFailure(() =>
    port.getChangeRequestConvergenceView(Number(args.prNumber)),
  );
  const prHeadSha = view.headSha.toLowerCase();
  const prHeadRefName = view.headRefName.trim();
  const prAuthorLogin = view.authorLogin.toLowerCase();
  const prUrl = view.url;
  const closingIssuesReferences = view.closingIssuesReferences;
  // Fetched here (ahead of `trustedMarkerLogins` below) so a collaborator's
  // marker-shaped PR comment can be detected before that set is used to
  // resolve `claimEvents` -- see `resolveTrustedCollaboratorMarkerLogins`.
  const comments = retryTransientGhFailure(() =>
    port.listWorkItemComments(Number(args.prNumber)),
  ).map(toIssueCommentPayload);
  // #1344: collaborator-marker trust, matching `pre-merge-readiness.mts`'s
  // `readCollaboratorTrustEnabled` exactly, except reusing the already-
  // loaded `rawConfig` instead of a second `.github/idd/config.json` read
  // (`resolveCollaboratorMarkerTrust` and `loadIddConfig` are both already
  // null-safe, so no extra try/catch is needed for that simplification).
  const collaboratorTrustEnabled = resolveCollaboratorMarkerTrust(
    rawConfig,
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );
  const { reviews, headCommittedAt } = fetchReviewsAndHeadCommit(
    owner,
    repo,
    Number(args.prNumber),
    port,
  );
  const threads = fetchReviewThreads(port, Number(args.prNumber));
  // #1347: fetch every claim-issue candidate's raw comments (pure I/O)
  // BEFORE computing `trustedMarkerLogins`, so collaborator-marker trust
  // can be resolved from ALL candidates' comments -- not just whichever
  // one the presence-check below eventually picks. Folding trust only
  // from the already-picked candidate is circular: a lone candidate's
  // claim-establishing marker, authored by a login trusted only via
  // collaborator-marker trust, would never register as "active" for the
  // presence check to pick it in the first place, discarding the real
  // claim data before that trust is ever computed. See
  // `pickResolvingClaimEvents`'s doc comment for the full history.
  const claimCandidates = fetchClaimEventCandidates(
    port,
    args.claimIssueNumber,
    closingIssuesReferences,
  );
  // Deliberately NOT unioned with `advisoryBotLogins` here (unlike some
  // other locally-collected sets in this file that scope broader trust for
  // marker *parsing*): every sibling helper (advisory-wait-state.mts,
  // pre-merge-readiness.mts) keeps `trustedMarkerLogins` and
  // `advisoryBotLogins` disjoint, and this specific set also authorizes
  // `--assert`-gating external-check waivers (via `summarizeExternalCheck-
  // Waivers`, below) -- folding a configured advisory bot login in here
  // would let that bot's own comment count as a "maintainer-authorized"
  // waiver author.
  //
  // #1344/#1347: folds collaborator-marker trust over the UNION of PR
  // comments and EVERY claim-issue candidate's comments, matching
  // `pre-merge-readiness.mts`'s `[...comments, ...claimComments]` union in
  // spirit (extended here to all candidates, since this gate -- unlike
  // pre-merge-readiness.mts -- auto-discovers among several linked issues
  // rather than requiring a single explicit one). Scanning `comments`
  // alone would make `collaboratorTrustEnabled` a no-op for claim and
  // forced-handoff markers: those are always posted to the claim ISSUE,
  // never the PR (see `forced-handoff-marker.mts`), and
  // `applyClaimEvent`'s `isTrustedAuthor` gate runs before any
  // claim/forced-handoff parsing -- an untrusted-author's marker never
  // even reaches the authorization check.
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(port, [
          ...comments,
          ...claimCandidates.flat(),
        ])
      : []),
  ]);
  // #1810: delegates to `resolveClaimEvidence` (below `hasTrustedClaimMarker-
  // History`'s definition) instead of calling `pickResolvingClaimEvents` /
  // `classifyClaimCandidateAmbiguity` / `hasTrustedClaimMarkerHistory`
  // separately here -- see that function's doc comment for why this call
  // site's own compute-and-forward wiring needed a direct test, not just
  // the three underlying helpers.
  const { claimEvents, claimCandidateAmbiguous, claimMarkerHistoryPresent } =
    resolveClaimEvidence(
      claimCandidates,
      trustedMarkerLogins,
      Boolean(args.claimIssueNumber),
    );
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const deadlineMinutes = readAdvisoryConvergenceDeadlineMinutes();
  // #1511: bounded same-HEAD reroll cap, plus the existing pendingWindow
  // (reused, not a new duration knob) that bounds how long a reroll can
  // stay "in flight" before a caller may safely retry.
  const sameHeadRerollCap = readAdvisorySameHeadRerollCap();
  const { pendingWindowMinutes } = readAdvisoryWaitPolicy();
  // #1570/#1572: bounded per-PR-HEAD Copilot stall-recovery cycle cap and
  // 12h terminal-unavailability window, read independently of the five-key
  // `AdvisoryWaitPolicy` shape above for the same reason `sameHeadRerollCap`
  // is (see advisory-wait-policy.mts's own doc comments on each resolver).
  const recoveryCycleCap = readAdvisoryRecoveryCycleCap();
  // No manual cast: `normalizePolicyConfig`'s inferred return type already
  // carries `ciGate.externalCheckWaivers.{mode,maxValidity}` precisely (see
  // `external-check-waiver.mts`'s `NormalizedPolicy` alias for the same
  // pattern) -- re-declaring the shape here would silently stop tracking
  // that source of truth on drift.
  const policy = normalizePolicyConfig(rawConfig);
  // kurone-kito/idd-skill#2657 (Codex + Copilot review, PR #2895): read
  // directly from the already-loaded `rawConfig` rather than a second
  // `.github/idd/config.json` read (see the reviewPolicy read below for
  // the same convention) -- `normalizePolicyConfig` does not carry
  // `helperRuntime` through its own normalized shape, since that section
  // is validated (not defaulted) elsewhere (`policy-helpers.mts`).
  const rawHelperRuntime = rawConfig?.helperRuntime;
  const helperRuntimeProfile =
    rawHelperRuntime &&
    typeof rawHelperRuntime === 'object' &&
    typeof rawHelperRuntime.profile === 'string'
      ? rawHelperRuntime.profile
      : undefined;
  // Resolved once and reused below AND in the returned `options.now` --
  // #2353 (Codex review on PR #2370): the declaration-validity read must
  // evaluate at the SAME instant the rest of this verdict does (deadline,
  // waiver expiry, terminal evidence), or a `--now`-overridden invocation
  // (deterministic replay, tests) would resolve `outageDeclarationActive`
  // against the real wall clock instead, an inconsistency within the same
  // verdict.
  const resolvedNow =
    args.now || new Date().toISOString().replace('.000Z', 'Z');
  // #2353: resolve whether a repository-scoped `providerOutage.
  // declarationTarget` declaration is active for THIS gate's own selector
  // (`idd-advisory-convergence` -- see idd-advisory-wait.instructions.md's
  // "Sustained outage" note). Fails closed to inactive on ANY error (unset
  // target, unreadable/unparseable comments, authority-lookup failure),
  // matching `prFirstCommitAt` below: a transient fetch failure must never
  // widen what this gate accepts. Resolved BEFORE `terminalWindowMinutes`
  // (#2554): the SAME `.active` verdict now also gates the declaration-
  // scoped terminal-window override below, not just `outageRelief` further
  // down.
  let outageDeclarationActive = false;
  const outageDeclarationTargetIssue =
    policy?.providerOutage?.declarationTarget;
  if (outageDeclarationTargetIssue) {
    try {
      const declarationComments = retryTransientGhFailure(() =>
        port.listWorkItemComments(outageDeclarationTargetIssue),
      ).map(toIssueCommentPayload);
      const authorityOf = (actorLogin) =>
        normalizeAuthorityEvidence(
          resolveCollaboratorAuthority({ owner, repo, actor: actorLogin }),
          actorLogin,
          owner,
          policy.ciGate.externalCheckWaivers.authorityPolicy,
        );
      outageDeclarationActive = resolveProviderOutageDeclaration({
        declarationTargetConfigured: true,
        comments: declarationComments,
        service: ADVISORY_CONVERGENCE_CHECK_SELECTOR,
        policy,
        authorityOf,
        now: new Date(resolvedNow),
      }).active;
    } catch {
      outageDeclarationActive = false;
    }
  }
  // #2554: shortens to `advisoryWait.providerOutage.terminalWindow` only
  // while `outageDeclarationActive` (just above) holds for THIS gate's own
  // selector; otherwise falls through to the unconditional
  // `advisoryWait.terminalWindow` value, byte-identical to before this
  // change. `recoveryCycleCap` above is deliberately untouched -- the issue
  // scopes this override to the terminal-window duration alone.
  //
  // Schema-validated first (Copilot review, PR #2564 round 3): the prior
  // `readAdvisoryTerminalWindowMinutes()` call re-read
  // `.github/idd/config.json` itself and failed closed to the default
  // whenever the `advisoryWait` section was schema-invalid for ANY reason.
  // Passing `rawConfig` straight to the pure resolver would silently drop
  // that validation -- an unrelated invalid key elsewhere in `advisoryWait`
  // could then let a stale `terminalWindow` value through instead of
  // falling back, exactly the same validate-before-resolve gate
  // `pre-merge-readiness.mts`'s own `advisoryWaitConfig` variable already
  // applies.
  const validatedAdvisoryWaitConfig = advisoryWaitSectionIsValid(rawConfig)
    ? rawConfig
    : {};
  const terminalWindowMinutes = resolveEffectiveAdvisoryTerminalWindowMinutes({
    config: validatedAdvisoryWaitConfig,
    declarationActive: outageDeclarationActive,
  });
  // #1344: forced-handoff-aware claim resolution, matching
  // `pre-merge-readiness.mts` exactly, except reading `forcedHandoff.mode`/
  // `authorityPolicy` off the already-loaded/normalized `policy` above
  // instead of `readForcedHandoffMode()`/`readForcedHandoffAuthorityPolicy()`
  // (each of which independently re-reads and re-parses
  // `.github/idd/config.json`) -- `readForcedHandoffPolicy`
  // (collaborator-permission.mts) computes those two fields via the exact
  // same `normalizePolicyConfig` call, so `policy.forcedHandoff.*` is
  // identical, not an approximation.
  const forcedHandoffAuthorityPolicy = policy.forcedHandoff.authorityPolicy;
  const forcedHandoffEnabled = policy.forcedHandoff.mode === 'human-gated';
  const forcedHandoffPermissionCache = new Map();
  // Part B (#1058): an issue-only handoff that predates the PR is honored
  // even against a PR-backed claim. Resolved only when forced handoffs are
  // enabled, and fails closed to `null` (reject) on any lookup/parse error
  // so a transient commits-API failure never widens what this gate accepts.
  let prFirstCommitAt = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = retryTransientGhFailure(() =>
        port.listChangeRequestCommits(Number(args.prNumber)),
      );
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const staleAgeMs =
    parseIsoDurationToMs(policy.claimTiming.staleAge) ?? DEFAULT_STALE_AGE_MS;
  const convergenceScope =
    policy?.advisoryWait?.convergenceScope === 'idd-claimed'
      ? 'idd-claimed'
      : 'all-prs';
  // #1906: opt-in, off by default, and only ever consulted under
  // `all-prs` scope (`idd-claimed` never reaches the new applicability
  // branch -- see `computeAdvisoryConvergenceVerdict`). Fetch the PR's
  // own author `__typename` only when BOTH the flag is enabled AND
  // scope is `all-prs`, so a repository that enables the flag under
  // `idd-claimed` (where it can never apply) still pays for zero extra
  // GraphQL round trips, matching the "no behavior/cost change unless
  // genuinely applicable" goal the plain opt-in-off case already gets.
  // Fails closed to `false` ("not a Bot-typed author", today's
  // `applicable`/`all-prs` outcome) on any fetch error, matching
  // `prFirstCommitAt` above: a transient GraphQL failure must never
  // widen what this gate accepts.
  const exemptBotAuthoredPrs = policy.advisoryWait.exemptBotAuthoredPrs;
  // #2137: forward any string (including invalid enum values).
  // Non-string / absent stay undefined. computeAdvisoryConvergenceVerdict
  // treats only exact human-required / no-advisory as skip, so an
  // invalid string still keeps today's Copilot / primaryBotLogin
  // applicability.
  //
  // #2267: a provider that declares its `advisory-review` capability
  // unsupported (a non-GitHub adapter with no equivalent advisory
  // reviewer) coerces this gate to the same `'no-advisory'` skip a
  // repository can already opt into by config -- reusing the #2137-tested
  // skip path instead of adding a second one, and inert for GitHub, whose
  // adapter always declares every capability supported (see
  // `listCapabilityDeclarations`).
  const advisoryReviewDeclaration = port
    .listCapabilityDeclarations()
    .find((declaration) => declaration.group === 'advisory-review');
  const advisoryReviewUnsupported = Boolean(
    advisoryReviewDeclaration &&
      evaluateProviderCapabilityOutcome(advisoryReviewDeclaration) ===
        'not_applicable',
  );
  const reviewPolicy = advisoryReviewUnsupported
    ? 'no-advisory'
    : typeof rawConfig?.reviewPolicy === 'string'
      ? rawConfig.reviewPolicy
      : undefined;
  let prAuthorIsBot = false;
  if (exemptBotAuthoredPrs && convergenceScope === 'all-prs') {
    try {
      prAuthorIsBot =
        fetchPrAuthor(port, Number(args.prNumber))?.__typename === 'Bot';
    } catch {
      prAuthorIsBot = false;
    }
  }
  // kurone-kito/idd-skill#2657: pre-resolve `GET
  // /repos/{owner}/{repo}/actions/runs/{run-id}` evidence for any
  // self-referential-bootstrap-auto waiver candidate marker, so the pure
  // verdict function performs no I/O of its own. A cheap, network-free
  // local scan (marker-shape prefix test + author/reason/run-id/HEAD
  // parse) narrows this to the small set of comments that could
  // possibly be this waiver kind before paying for one Actions-run
  // lookup per DISTINCT run id among them -- expiry/claim trust is
  // verified later, inside `computeAdvisoryConvergenceVerdict`; this
  // scan is a cost optimization only, never the authoritative check.
  // The author check (Copilot review, PR #2895) is still required here,
  // not merely redundant with the authoritative one: without it, any
  // commenter could post arbitrarily many fake same-reason markers with
  // distinct `run-id:` values and force this required check to spend
  // one Actions-run lookup per fake id on every assert invocation --
  // individually fail-closed, but a real drain on the repository-shared
  // `GITHUB_TOKEN` rate-limit budget.
  //
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 5): the
  // author check alone does not bound the COUNT of lookups -- a
  // same-repository PR-authored `pull_request` workflow with
  // `issues: write` can still post as `github-actions[bot]` (that
  // token's permissions are not fork-restricted for a same-repository
  // PR) and spam arbitrarily many distinct fake `run-id:` values under
  // the correct reason token, each costing a separate serialized
  // Actions API call. A local, network-free HEAD-SHA match against
  // this PR's OWN current HEAD closes most of this cheaply --
  // `renderExternalCheckWaiverComment` always binds a genuine marker to
  // the HEAD it was posted for -- but a same-HEAD flood is still
  // possible, so a hard cap on the number of distinct run ids ever
  // looked up remains necessary too.
  //
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 6): an
  // EARLIEST-first cap (this file's own prior revision) is exactly as
  // exploitable as a LATEST-first one, just from the opposite
  // direction -- a same-repository attacker workflow that wins the race
  // to post before the trusted posting job finishes can crowd out the
  // genuine, later marker just as reliably as a late flood could crowd
  // out an early one. No selection ORDER can fully close this without
  // an API call per candidate, which is the exact cost this prefilter
  // exists to avoid. This is a bounded-cost, defense-in-depth
  // optimization, never the authoritative check -- `autoWaiverValid`
  // below still requires independent Actions-run/allowlist
  // verification regardless of what this prefilter selects, and the
  // existing maintainer-authorized waiver remains available as the
  // documented escape hatch on the rare PR where a flood genuinely
  // exhausts this budget. Twenty is a deliberately generous bound
  // (versus the "at most one legitimate marker per relevant push"
  // steady state) that keeps worst-case API cost small and safe while
  // making a reliable crowd-out require posting dozens of distinct
  // spam comments on the PR -- conspicuous, and itself rate-limited by
  // GitHub's own comment-creation API, unlike an unbounded lookup loop.
  // kurone-kito/idd-skill#2912: this same bound now also caps a SECOND
  // and THIRD lookup per run id (`getWorkflowRunJobs`, for
  // `verifySelfReferentialBootstrapWaiverProvenance`; and
  // `listWorkflowRunArtifacts`, for
  // `verifySelfReferentialBootstrapWaiverArtifactBinding`), so worst-case
  // cost is up to 3 * MAX_AUTO_WAIVER_RUN_LOOKUPS Actions-API calls, not
  // a new, separately-bounded budget of its own.
  const MAX_AUTO_WAIVER_RUN_LOOKUPS = 20;
  const autoWaiverCandidates = [];
  const seenAutoWaiverRunIds = new Set();
  // kurone-kito/idd-skill#2912 (round 2, extended round 3): collected
  // over EVERY qualifying comment (not deduplicated by
  // `seenAutoWaiverRunIds`, which exists only to bound the number of
  // Actions-API lookups), each paired with its own comment `id` AND
  // (round 3) a SHA-256 digest of its own live body --
  // `verifySelfReferentialBootstrapWaiverArtifactBinding` needs the id
  // to correlate a `.valid` evidence entry (which carries no id of its
  // own) back to the specific live comment it came from, and the body
  // digest to detect whether that specific comment's content has since
  // been edited in place (round 2's id-only binding could not). See
  // `AdvisoryConvergenceInputs.autoWaiverRunIdCandidates`'s own doc
  // comment for the full correlation contract.
  const autoWaiverRunIdCandidates = new Map();
  for (const comment of comments) {
    const body = String(comment.body ?? '');
    if (!/^<!--\s*idd-external-check-waiver:/i.test(body)) {
      continue;
    }
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (authorLogin !== 'github-actions[bot]') {
      continue;
    }
    const createdAt = String(comment.createdAt ?? '');
    const parsed = parseExternalCheckWaiverComment(body, createdAt);
    // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): `parsed.runId`
    // is attacker-controlled comment text (the marker's `run-id:` field is
    // never percent-decoded or otherwise sanitized -- see
    // ParsedExternalCheckWaiver.runId's own doc comment), and
    // `getWorkflowRun` interpolates it directly into a `gh api` REST path
    // (`repos/{owner}/{repo}/actions/runs/{runId}`). A same-repository
    // workflow (the same threat model MAX_AUTO_WAIVER_RUN_LOOKUPS's own doc
    // comment above already covers) could otherwise post a bot-authored
    // marker whose run-id contains `/`, `?`, or other path syntax and steer
    // this bounded lookup at an unintended API path instead of a single
    // Actions run. Validate the token is a canonical positive integer --
    // the same shape `ci-wait-policy.mts`'s `--run-id` already requires --
    // before it is ever eligible to become a lookup key; a malformed token
    // fails closed here exactly like every other invalid input in this
    // file, rather than reaching the API call at all.
    // kurone-kito/idd-skill#2657 (Copilot review, PR #2895, round 13): also
    // require `parsed.checkSelector` to EXACTLY equal
    // `ADVISORY_CONVERGENCE_CHECK_SELECTOR` (never a glob/broader match --
    // the genuine self-waiver job always posts this exact selector).
    // Without this, a same-repository `pull_request`-triggered workflow
    // (runs PR-controlled code, unlike the trusted `pull_request_target`
    // verdict job) could post up to `MAX_AUTO_WAIVER_RUN_LOOKUPS` bot-
    // authored markers with the reserved reason and current HEAD but an
    // arbitrary `checkSelector`, consuming the entire bounded lookup
    // budget before the genuine marker is ever considered -- a denial-of-
    // service on this deliberately-bounded mechanism.
    if (
      parsed &&
      parsed.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON &&
      parsed.checkSelector === ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      parsed.runId &&
      parseCanonicalIntegerOrNull(parsed.runId) !== null &&
      String(parsed.headSha ?? '')
        .trim()
        .toLowerCase() === prHeadSha
    ) {
      // kurone-kito/idd-skill#2912 (round 2, extended round 3): every
      // qualifying comment's own `id`/`createdAt`/`bodyDigest` triple is
      // recorded against its cited run id, regardless of whether this is
      // the first (lookup-triggering) sighting. Appended via `.push`,
      // not a spread-rebuild, so this stays linear in the comment count
      // (Copilot review, PR #2914). `digestExternalCheckWaiverMarkerBody`
      // hashes `body` verbatim -- the exact string this scan already read
      // from the live comment -- never a locally-reconstructed one, the
      // same API-returned-body-on-both-sides contract that function's
      // own doc comment requires.
      const candidateList = autoWaiverRunIdCandidates.get(parsed.runId);
      const candidate = {
        id: String(comment.id ?? ''),
        createdAt,
        bodyDigest: digestExternalCheckWaiverMarkerBody(body),
      };
      if (candidateList) {
        candidateList.push(candidate);
      } else {
        autoWaiverRunIdCandidates.set(parsed.runId, [candidate]);
      }
      if (!seenAutoWaiverRunIds.has(parsed.runId)) {
        seenAutoWaiverRunIds.add(parsed.runId);
        autoWaiverCandidates.push({ runId: parsed.runId, createdAt });
      }
    }
  }
  const autoWaiverRunIds = new Set(
    autoWaiverCandidates
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, MAX_AUTO_WAIVER_RUN_LOOKUPS)
      .map((candidate) => candidate.runId),
  );
  const autoWaiverRunLookups = {};
  for (const runId of autoWaiverRunIds) {
    try {
      const raw = port.getWorkflowRun(owner, repo, runId);
      autoWaiverRunLookups[runId] = {
        path: raw?.path ?? null,
        headSha: raw?.head_sha ?? null,
        repositoryFullName: raw?.head_repository?.full_name ?? null,
        event: raw?.event ?? null,
      };
    } catch (error) {
      // Fail closed per run id: a lookup failure (unknown run, transient
      // API error) must never crash the whole collection, and
      // `verifySelfReferentialBootstrapWaiverRun` already treats an
      // `{error}` entry the same as an absent one -- always a rejection.
      autoWaiverRunLookups[runId] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // kurone-kito/idd-skill#2912: a second, per-run-id lookup sharing the
  // exact same `autoWaiverRunIds` budget as the run-metadata lookup
  // above (so worst case doubles the lookup call count, still bounded
  // by `MAX_AUTO_WAIVER_RUN_LOOKUPS`) -- see
  // `AdvisoryConvergenceInputs.autoWaiverRunJobLookups`'s own doc
  // comment for why the run-metadata lookup alone is insufficient.
  const autoWaiverRunJobLookups = {};
  for (const runId of autoWaiverRunIds) {
    try {
      const raw = port.getWorkflowRunJobs(owner, repo, runId);
      const selfWaiverJob = (raw?.jobs ?? []).find(
        (job) => job?.name === SELF_REFERENTIAL_WAIVER_JOB_ID,
      );
      const postStep = (selfWaiverJob?.steps ?? []).find(
        (step) => step?.name === SELF_REFERENTIAL_WAIVER_POST_STEP_NAME,
      );
      autoWaiverRunJobLookups[runId] = {
        conclusion: postStep?.conclusion ?? null,
        startedAt: postStep?.started_at ?? null,
        completedAt: postStep?.completed_at ?? null,
      };
    } catch (error) {
      // Fail closed per run id, mirroring the run-metadata lookup above:
      // a lookup failure must never crash the whole collection, and
      // `verifySelfReferentialBootstrapWaiverProvenance` already treats
      // an `{error}` entry the same as an absent one -- always a
      // rejection.
      autoWaiverRunJobLookups[runId] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // kurone-kito/idd-skill#2912 (round 2, extended round 3): a THIRD
  // per-run-id lookup sharing the exact same `autoWaiverRunIds` budget
  // as the two above (so worst case triples the lookup call count,
  // still bounded by `MAX_AUTO_WAIVER_RUN_LOOKUPS`) -- recovers the SET
  // of `(comment id, body digest)` bindings the cited run's own trusted
  // job execution recorded posting, via the artifact-name convention
  // `SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX` documents (round 3
  // extended that convention with a trailing `-<body-digest>` segment).
  // See `AdvisoryConvergenceInputs.autoWaiverRunArtifactBindings`'s own
  // doc comment for why this closes a gap the run-metadata and
  // job-provenance lookups above cannot.
  const autoWaiverArtifactNamePattern = new RegExp(
    `^${SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX}([1-9][0-9]*)-([0-9a-f]{64})$`,
  );
  const autoWaiverRunArtifactBindings = {};
  for (const runId of autoWaiverRunIds) {
    try {
      const raw = port.listWorkflowRunArtifacts(owner, repo, runId);
      const bindings = [];
      for (const artifact of raw?.artifacts ?? []) {
        const match = autoWaiverArtifactNamePattern.exec(
          String(artifact?.name ?? ''),
        );
        if (match) {
          bindings.push({
            id: match[1],
            bodyDigest: match[2],
          });
        }
      }
      autoWaiverRunArtifactBindings[runId] = bindings;
    } catch {
      // Fail closed per run id, mirroring the two lookups above: a
      // lookup failure must never crash the whole collection, and an
      // empty trusted-binding set already means "nothing trusted" to
      // `verifySelfReferentialBootstrapWaiverArtifactBinding` -- no
      // separate `{error}` union variant is needed here.
      autoWaiverRunArtifactBindings[runId] = [];
    }
  }
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895): fetched only
  // when a candidate marker exists (same cost-optimization scope as the
  // run-id lookups above) -- see `AdvisoryConvergenceInputs.changedFilePaths`'s
  // doc comment for why the pure verdict function needs this
  // independent evidence rather than trusting the posting job's own
  // internal allowlist check.
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 12): merge in
  // `listChangeRequestRenamedFromPaths` too -- the general-purpose
  // `listChangeRequestChangedFiles` deliberately no longer includes a
  // renamed file's OLD path (see that port method's own doc comment for
  // the CODEOWNERS-pollution incident this split fixes), but this
  // specific allowlist check still needs it: a rename-shaped checker
  // repair away from an allowlisted path must still be recognized.
  const changedFilePaths =
    autoWaiverRunIds.size > 0
      ? [
          ...retryTransientGhFailure(() =>
            port.listChangeRequestChangedFiles(Number(args.prNumber)),
          ),
          ...retryTransientGhFailure(() =>
            port.listChangeRequestRenamedFromPaths(Number(args.prNumber)),
          ),
        ]
      : undefined;
  return {
    inputs: {
      prNumber: Number(args.prNumber),
      prHeadSha,
      reviews,
      threads,
      comments,
      claimEvents,
      claimMarkerHistoryPresent,
      claimCandidateAmbiguous,
      prAuthorIsBot,
      autoWaiverRunLookups,
      autoWaiverRunJobLookups,
      autoWaiverRunIdCandidates: Object.fromEntries(autoWaiverRunIdCandidates),
      autoWaiverRunArtifactBindings,
      changedFilePaths,
    },
    options: {
      now: resolvedNow,
      primaryBotLogin,
      trustedMarkerLogins,
      advisoryBotLogins,
      convergenceScope,
      exemptBotAuthoredPrs,
      reviewPolicy,
      prHeadRefName,
      prAuthorLogin,
      headCommittedAt,
      deadlineMinutes,
      waiverMode: String(
        policy?.ciGate?.externalCheckWaivers?.mode ?? 'disabled',
      ),
      waiverMaxValidity: String(
        policy?.ciGate?.externalCheckWaivers?.maxValidity ?? 'PT24H',
      ),
      waiverCheckSelector: ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      waivableSelectors: policy?.ciGate?.externalChecks?.waivable ?? [],
      repositoryFullName: owner && repo ? `${owner}/${repo}` : '',
      helperRuntimeProfile,
      outageDeclarationActive,
      sameHeadRerollCap,
      pendingWindowMinutes,
      recoveryCycleCap,
      terminalWindowMinutes,
      forcedHandoffEnabled,
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(
          owner,
          repo,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          forcedHandoffPermissionCache,
        ),
      expectedLinkedPrs: [String(args.prNumber), prUrl].filter(Boolean),
      prFirstCommitAt,
      staleAgeMs,
    },
  };
}
/**
 * Fetch one issue's comments and normalize them to the `author.login` /
 * `createdAt` shape `resolveActiveClaim`/`applyClaimEvent`
 * (`protocol-helpers.mts`) require. Unlike `summarizeDispositionEvidence-
 * ForGate` / `summarizeExternalCheckWaivers`, the claim resolver has NO
 * `user.login` / `created_at` REST fallback (`event.author?.login ?? ''`,
 * `event.createdAt ?? ''`, verbatim) -- passing raw `gh api` REST comments
 * through unnormalized silently resolves `activeClaimPresent: false` for
 * every real claim, breaking the entire waiver escape hatch without any
 * error. `pre-merge-readiness.mts`'s own `normalizeClaimComment` does the
 * same normalization for the identical reason; mirrored here rather than
 * imported since it is not exported.
 */
function fetchClaimComments(port, issueNumber) {
  return port.listWorkItemComments(issueNumber).map((comment) => ({
    body: comment.body,
    createdAt: comment.createdAt,
    author: { login: comment.authorLogin },
  }));
}
/**
 * Fetch the claim-issue candidate(s)' raw comment streams -- pure I/O, no
 * trust judgment. When `explicitIssueNumber` (`--claim-issue`) is given,
 * fetch it alone -- no ambiguity to resolve. Otherwise a PR can close more
 * than one issue (`pr.closingIssuesReferences`), so fetch every candidate's
 * comments; {@link pickResolvingClaimEvents} disambiguates them afterward.
 *
 * Split out from a single `resolveClaimEvents` (#1344) so the
 * `trustedMarkerLogins` used for disambiguation can be computed from ALL
 * candidates' comments first (see the `collectFromGitHub` call site) --
 * #1347 found that resolving trust from only the eventually-picked
 * candidate is circular: a lone candidate's claim-establishing marker,
 * authored by a login trusted only via collaborator-marker trust, would
 * never be recognized as "active" long enough to be picked in the first
 * place, discarding the real claim data before that trust is ever folded
 * in.
 */
function fetchClaimEventCandidates(port, explicitIssueNumber, refs) {
  if (explicitIssueNumber) {
    return [fetchClaimComments(port, explicitIssueNumber)];
  }
  const candidateNumbers = [
    ...new Set(
      (refs ?? []).map((ref) => ref?.number).filter((n) => Number.isInteger(n)),
    ),
  ];
  return candidateNumbers.map((issueNumber) =>
    fetchClaimComments(port, issueNumber),
  );
}
/** Candidate claim-issue comment streams whose *active claim* actually
 * resolves (`summarizeClaimValidation`). Shared by
 * {@link pickResolvingClaimEvents} and {@link classifyClaimCandidateAmbiguity}
 * (#1686) so both read the identical disambiguation result instead of two
 * independently-maintained filters that could drift. */
function filterResolvingClaimCandidates(candidates, trustedMarkerLogins) {
  return candidates.filter((comments) =>
    Boolean(
      summarizeClaimValidation(comments, { trustedMarkerLogins })
        .activeClaimPresent,
    ),
  );
}
/**
 * Resolve the linked (claim) issue's comment stream for waiver-claim
 * binding, given already-fetched candidate comment streams
 * ({@link fetchClaimEventCandidates}) and a `trustedMarkerLogins` already
 * fully resolved (including any collaborator-marker-trust fold) over ALL
 * candidates' comments. Pure -- no I/O -- so it is directly unit-testable.
 *
 * `isExplicit` mirrors `fetchClaimEventCandidates`'s own
 * `explicitIssueNumber` check: an explicit `--claim-issue` candidate is
 * returned unconditionally, no ambiguity to resolve. Otherwise, keep only
 * the candidate whose *active claim* actually resolves
 * (`summarizeClaimValidation`), mirroring how `external-check-waiver.mts`'s
 * own `selectLinkedIssueCandidate` disambiguates multiple linked issues by
 * active-claim presence rather than requiring a single closing reference.
 * Zero or multiple resolving candidates fail closed to `[]` (no waiver
 * claim can bind unambiguously), same as before #1344/#1347 -- and
 * unchanged by #1686: {@link classifyClaimCandidateAmbiguity} below is the
 * new, separate signal that lets a caller tell the "zero resolving" and
 * "multiple resolving" cases apart without touching this function's own
 * fail-closed-to-`[]` contract (pinned by
 * "pickResolvingClaimEvents: zero or multiple resolving candidates still
 * fail closed to [] (unchanged from pre-#1344/#1347 behavior)" in
 * tests/advisory-convergence.test.mts).
 */
export function pickResolvingClaimEvents(
  candidates,
  trustedMarkerLogins,
  isExplicit,
) {
  if (isExplicit) {
    return candidates[0] ?? [];
  }
  const resolving = filterResolvingClaimCandidates(
    candidates,
    trustedMarkerLogins,
  );
  return resolving.length === 1 ? resolving[0] : [];
}
/**
 * #1686: true when two or more claim-issue candidates each independently
 * resolve an active trusted claim -- the specific disambiguation-failure
 * case {@link pickResolvingClaimEvents} already fails closed to `[]` for
 * (see its own doc comment above and the module header's path 2). Surfaced
 * as an explicit signal so the `idd-claimed` applicability gate
 * (`computeAdvisoryConvergenceVerdict`) can distinguish "this PR's closing
 * references are ambiguous between two actively-claimed issues" from the
 * ordinary "no candidate resolves at all" case, which
 * `pickResolvingClaimEvents`'s own collapsed `[]` output cannot
 * distinguish by itself. An explicit `--claim-issue` target has no
 * ambiguity to resolve -- always `false`, mirroring
 * `pickResolvingClaimEvents`'s own `isExplicit` short-circuit.
 */
export function classifyClaimCandidateAmbiguity(
  candidates,
  trustedMarkerLogins,
  isExplicit,
) {
  if (isExplicit) {
    return false;
  }
  return (
    filterResolvingClaimCandidates(candidates, trustedMarkerLogins).length > 1
  );
}
/**
 * #1686: true when at least one TRUSTED, syntactically valid `claimed-by`
 * marker exists anywhere in `candidates`' raw comment streams -- regardless
 * of whether it currently resolves to an ACTIVE claim. A released
 * (`unclaimed-by`), superseded-without-a-qualifying-takeover, or otherwise
 * no-longer-current claim still counts: this function answers "did real IDD
 * claim activity ever happen here", not "is a claim active right now" (that
 * question is `summarizeClaimValidation(...).activeClaimPresent`, already
 * computed elsewhere).
 *
 * Note on *why* this function is needed rather than an age comparison:
 * `resolveActiveClaim` (protocol-helpers.mts) has no `now` parameter and
 * never expires a claim by elapsed time alone -- staleness there only
 * matters when a LATER claim event attempts to supersede the active one
 * (`claim.supersedes === activeClaim.claimId && isStale(...)`). A claim
 * that goes stale on a long-open PR with no subsequent takeover event stays
 * `activeClaimPresent: true` forever in this codebase; time by itself never
 * clears it. So the concrete way `activeClaimPresent` becomes `false` while
 * genuine claim history exists is an explicit release/handoff event (or a
 * disambiguation failure -- see {@link classifyClaimCandidateAmbiguity}
 * instead), not a bare age computation -- this function's own test fixtures
 * demonstrate that shape rather than asserting on elapsed time. See the
 * module header's path 4 and `AdvisoryConvergenceInputs.claimMarkerHistoryPresent`'s
 * doc comment.
 */
export function hasTrustedClaimMarkerHistory(candidates, trustedMarkerLogins) {
  const trusted = new Set(trustedMarkerLogins);
  return candidates.some((candidateComments) =>
    candidateComments.some((event) => {
      const login = String(event.author?.login ?? event.user?.login ?? '')
        .trim()
        .toLowerCase();
      if (!trusted.has(login)) {
        return false;
      }
      return (
        parseClaimComment(
          event.body ?? '',
          event.createdAt ?? event.created_at ?? '',
        ) !== null
      );
    }),
  );
}
/**
 * Resolve all three claim-evidence fields `collectFromGitHub` forwards into
 * {@link AdvisoryConvergenceInputs} from already-fetched claim candidates and
 * resolved trust -- pure (no I/O), so it is directly unit-testable, mirroring
 * {@link filterResolvingClaimCandidates}'s existing shared-helper extraction
 * pattern. `collectFromGitHub` previously called
 * {@link pickResolvingClaimEvents}, {@link classifyClaimCandidateAmbiguity},
 * and {@link hasTrustedClaimMarkerHistory} separately and forwarded their
 * results inline; that compute-and-forward wiring is itself the #1810 gap --
 * each of the three helpers has direct unit tests, but nothing proved the
 * real call site actually threads their outputs into the verdict inputs.
 * Collapsing all three into one exported step makes the call site a trivial,
 * visually obvious delegation and gives the wiring itself a direct test.
 */
export function resolveClaimEvidence(
  candidates,
  trustedMarkerLogins,
  isExplicit,
) {
  const claimEvents = pickResolvingClaimEvents(
    candidates,
    trustedMarkerLogins,
    isExplicit,
  );
  // #1686: ambiguity is a distinct signal from `claimEvents` above --
  // `pickResolvingClaimEvents` deliberately collapses BOTH "zero candidates
  // resolve" and "two or more candidates resolve" to `[]` (see its own doc
  // comment), so this must be computed separately over the same
  // `candidates`/`trustedMarkerLogins` inputs rather than re-derived from the
  // already-collapsed `claimEvents`.
  const claimCandidateAmbiguous = classifyClaimCandidateAmbiguity(
    candidates,
    trustedMarkerLogins,
    isExplicit,
  );
  // #1686: true when ANY candidate claim issue ever carried a trusted,
  // syntactically valid `claimed-by` marker -- computed over the union of
  // every candidate's RAW comment stream (`candidates`, not the
  // resolved-and-possibly-emptied `claimEvents`), so a stale, released, or
  // otherwise no-longer-active claim still counts as genuine IDD claim
  // history. See `hasTrustedClaimMarkerHistory`'s doc comment for the full
  // rationale and the module header's path 4.
  const claimMarkerHistoryPresent = hasTrustedClaimMarkerHistory(
    candidates,
    trustedMarkerLogins,
  );
  return { claimEvents, claimCandidateAmbiguous, claimMarkerHistoryPresent };
}
/**
 * Candidate collaborator-marker-trust logins: comment authors whose comment
 * matches a recognized operational-marker prefix (claim, waiver,
 * forced-handoff, etc. -- `operationalMarkerPrefix`), permission-checked
 * and kept only when Write/Maintain/Admin. Mirrors
 * `pre-merge-readiness.mts`'s function of the same name exactly. The
 * `collectFromGitHub` call site passes the UNION of PR comments and the
 * resolved claim issue's own comments (matching `pre-merge-readiness.mts`'s
 * `[...comments, ...claimComments]` union) -- PR comments alone are not
 * enough, since forced-handoff and claim markers are always posted to the
 * claim issue, never the PR (see `forced-handoff-marker.mts`). Only called
 * when `markerTrust.allowCollaboratorMarkers` / `IDD_TRUST_COLLABORATOR_MARKERS`
 * is enabled -- a no-op repository never pays for these lookups.
 */
function resolveTrustedCollaboratorMarkerLogins(port, commentLikeEvents) {
  const markerAuthors = [
    ...new Set(
      commentLikeEvents
        .filter(
          (comment) => operationalMarkerPrefix(comment.body ?? '') !== null,
        )
        .map((comment) => comment.author?.login ?? comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];
  return markerAuthors.filter((login) => {
    const result = retryTransientGhFailure(() =>
      port.getCollaboratorPermission(login),
    );
    const permission = result.outcome === 'found' ? result.permission : '';
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}
/**
 * Map a `ProviderPort.listWorkItemComments` result back onto the REST
 * `issues/{n}/comments` shape this file's `resolveTrustedCollaboratorMarkerLogins`
 * (and `inputs.comments`, consumed by `summarizeDispositionEvidenceForGate`)
 * already expect -- mirrors `pre-merge-readiness.mts`'s own shim of the same
 * name for the identical reason (keeps every downstream consumer
 * byte-identical instead of reshaping it for the port's flat `authorLogin`
 * field).
 */
function toIssueCommentPayload(comment) {
  return {
    id: comment.id,
    body: comment.body,
    author: { login: comment.authorLogin },
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}
/** #1906: fetch the PR's own author `login`/`__typename` via
 * {@link ProviderPort.getChangeRequestAuthor} -- the REST-shaped `pr view
 * --json author` fetch in `collectFromGitHub` only returns `login`, no type
 * discriminator. Deliberately its own minimal round trip rather than folded
 * into `fetchReviewThreads` below or `fetchReviewsAndHeadCommit`
 * (review-clause.mts): both of those are narrowly-scoped Copilot-review
 * evidence collectors, the latter shared verbatim with
 * `rerun-advisory-convergence.mts`, and widening either with an unrelated
 * PR-author field would blur that scope for no shared benefit. Called by
 * `collectFromGitHub` only when the opt-in `exemptBotAuthoredPrs` policy
 * is enabled (see the call site), so a repository that never sets the
 * flag never pays for this extra request. */
function fetchPrAuthor(port, prNumber) {
  const author = retryTransientGhFailure(() =>
    port.getChangeRequestAuthor(prNumber),
  );
  return author ? { login: author.login, __typename: author.typename } : null;
}
/** Map a `ProviderPort.listChangeRequestReviewThreadsWithAuthorType` node
 * back onto this file's own `ReviewThreadPayload` shape (the
 * `{comments: {pageInfo, nodes}}` wrapper `classifyCopilotAuthoredThreadIds`
 * / `classifyThreadIdsForReview` / `summarizeDispositionEvidenceForGate`
 * already expect and are directly tested against) -- same shim strategy as
 * {@link toIssueCommentPayload}. `pageInfo.hasNextPage` is always `false`:
 * the port's `fetchReviewThreadsGeneric` already fully paginates every
 * thread's comments before returning. */
function toReviewThreadPayload(node) {
  return {
    id: node.id,
    isResolved: node.isResolved,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: node.comments.map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        author: {
          login: comment.authorLogin,
          __typename: comment.authorTypename,
        },
        pullRequestReview: { id: comment.pullRequestReviewId },
      })),
    },
  };
}
function fetchReviewThreads(port, prNumber) {
  return port
    .listChangeRequestReviewThreadsWithAuthorType(prNumber)
    .map(toReviewThreadPayload);
}
/**
 * Structured next-action catalog for a non-ready verdict (#2143).
 * Derived from structured verdict fields, never from parsing `reasons[]`.
 * Empty when `ready` is true. Script-authored English; not LLM prose.
 * Shared by the stdout JSON field and the stderr formatter so the two
 * channels cannot disagree.
 */
export function collectAssertNextActions(verdict) {
  if (verdict.ready) {
    return [];
  }
  const pr = verdict.prNumber;
  const sha = verdict.prHeadSha;
  const bot = verdict.primaryBotLogin || 'copilot';
  const restLogin =
    bot === 'copilot' ? 'copilot-pull-request-reviewer[bot]' : bot;
  const T = ADVISORY_CONVERGENCE_NEXT_ACTION_TOKEN;
  const items = [];
  if (verdict.applicability.status === 'indeterminate') {
    const waiverReady =
      (verdict.deadline.passed ||
        verdict.terminal.state === 'COPILOT_UNAVAILABLE') &&
      verdict.waiver.mode === 'maintainer-authorized';
    const pointer = `node scripts/advisory-convergence.mjs --pr ${pr} --assert`;
    items.push({
      token: T.INDETERMINATE_APPLICABILITY,
      summary: waiverReady
        ? `Applicability is indeterminate (${verdict.applicability.reason}). Repair the claim linkage (claimed-by branch vs PR head) or post a maintainer external-check waiver for selector "${verdict.waiver.checkSelector}" on HEAD ${sha}, then: ${pointer}`
        : `Applicability is indeterminate (${verdict.applicability.reason}). Repair the claim linkage (claimed-by branch vs PR head), then: ${pointer}`,
      pointer,
    });
  }
  if (!verdict.review.found) {
    const reviewer = bot === 'copilot' ? 'copilot' : restLogin;
    items.push({
      token: T.REQUEST_REVIEW,
      summary: `${bot} has not reviewed this PR. Request a review (E14) then post an advisory-wait marker:`,
      pointer: [
        `gh pr edit ${pr} --add-reviewer ${reviewer}`,
        `# on GraphQL login-resolution failure ("Could not resolve user with login '${reviewer}'"):`,
        `gh api repos/{owner}/{repo}/pulls/${pr}/requested_reviewers -X POST -f "reviewers[]=${restLogin}"`,
        `node scripts/post-idd-marker.mjs --type advisory --target pr ${pr} --agent-id <id> --head-sha ${sha} --timestamp <ISO8601> --apply`,
      ].join('\n'),
    });
  } else if (!verdict.review.matchesHead) {
    const pointer = `node scripts/advisory-wait-state.mjs --pr ${pr}`;
    items.push({
      token: T.REQUEST_RE_REVIEW,
      summary: `Latest ${bot} review covers ${verdict.review.commitId || '<unknown>'}, not HEAD ${sha}. Request a re-review of the current HEAD (E14 / AW3 REQUEST_NEEDED) and wait with: ${pointer}`,
      pointer,
    });
  }
  const itemCount = verdict.review.itemCount;
  if (
    verdict.review.matchesHead &&
    typeof itemCount === 'number' &&
    itemCount > 0
  ) {
    const pointer = `node scripts/resolve-review-thread.mjs --pr ${pr} --comment-id <id> --body "**Accepted** — …" --claim-issue <n> --claim-id <id> --apply`;
    items.push({
      token: T.DISPOSITION_POSTED_ITEMS,
      summary: `Latest ${bot} review on HEAD has ${itemCount} posted item(s). Disposition each thread (E6/E13): ${pointer}`,
      pointer,
    });
  }
  if (verdict.threads.blockingCount > 0) {
    const ids =
      verdict.threads.blockingIds.join(', ') || '(see threads.blockingIds)';
    const pointer = 'resolve-review-thread (E6/E13)';
    items.push({
      token: T.DISPOSITION_THREADS,
      summary: `${verdict.threads.blockingCount} Copilot thread(s) are unresolved and lack a valid disposition (${ids}). Reply with a stamped **Accepted**/**Rejected** and resolve via ${pointer}.`,
      pointer,
    });
  }
  if (verdict.review.suppressedCount > 0) {
    const pointer = `node scripts/post-idd-marker.mjs --type review-ack --target pr ${pr} --agent-id <id> --head-sha ${sha} --timestamp <ISO8601> --apply`;
    items.push({
      token: T.ACK_SUPPRESSED,
      summary: `Latest ${bot} review reports ${verdict.review.suppressedCount} suppressed comment(s). After reading the review body, post a trusted review-ack if they are handled: ${pointer}`,
      pointer,
    });
  }
  if (verdict.terminal.state === 'COPILOT_UNAVAILABLE') {
    if (verdict.waiver.mode === 'maintainer-authorized') {
      const pointer = `node scripts/rerun-advisory-convergence.mjs --pr ${pr}`;
      items.push({
        token: T.WAIVER_TERMINAL,
        summary: `Copilot is terminally unavailable. Post a maintainer external-check waiver for selector "${verdict.waiver.checkSelector}" on HEAD ${sha} (idd-pre-merge F2 / external-check-waiver), then: ${pointer}`,
        pointer,
      });
    } else {
      const pointer = 'Hold for a maintainer; do not auto-merge.';
      items.push({
        token: T.HOLD_TERMINAL,
        summary: `Copilot is terminally unavailable and waivers are not enabled (mode "${verdict.waiver.mode}"). ${pointer}`,
        pointer,
      });
    }
  } else if (verdict.deadline.passed) {
    if (verdict.waiver.mode === 'maintainer-authorized') {
      const pointer = `Post a maintainer external-check waiver for selector "${verdict.waiver.checkSelector}" on HEAD ${sha}, then rerun the required check.`;
      items.push({
        token: T.WAIVER_DEADLINE,
        summary: `Convergence deadline (${verdict.deadline.minutes}m) has passed. ${pointer}`,
        pointer,
      });
    } else {
      const pointer = 'Hold for a maintainer.';
      items.push({
        token: T.HOLD_DEADLINE,
        summary: `Convergence deadline (${verdict.deadline.minutes}m) has passed and waivers are not enabled (mode "${verdict.waiver.mode}"). ${pointer}`,
        pointer,
      });
    }
  }
  if (verdict.sameHeadReroll.requestable) {
    const pointer = `node scripts/rerun-advisory-convergence.mjs --pr ${pr}`;
    items.push({
      token: T.SAME_HEAD_REROLL,
      summary: `Same-HEAD reroll is still requestable. Diagnose and rerun one instance at a time: ${pointer}`,
      pointer,
    });
  }
  if (items.length === 0) {
    const pointer = `node scripts/advisory-convergence.mjs --pr ${pr} --assert`;
    items.push({
      token: T.REREAD_VERDICT,
      summary: `Re-read the JSON verdict on stdout and follow idd-advisory-wait.instructions.md / idd-pre-merge.instructions.md F2. Then: ${pointer}`,
      pointer,
    });
  }
  return items;
}
/**
 * Compact next-action guidance for a non-ready `--assert` verdict (#2142).
 * Formats {@link collectAssertNextActions}; does not read
 * `verdict.nextActions`, so a spread-mutated verdict stays consistent
 * with its own fields. Empty when `ready` is true.
 */
export function formatAssertNextActions(verdict) {
  const items = collectAssertNextActions(verdict);
  if (items.length === 0) {
    return '';
  }
  const lines = ['Next action (idd-advisory-convergence --assert failed):'];
  for (const item of items) {
    lines.push(`- ${item.summary}`);
    if (item.pointer.includes('\n')) {
      for (const extra of item.pointer.split('\n')) {
        lines.push(`  ${extra}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
/** Write next-action guidance (stderr, first) then the JSON verdict (stdout).
 * Guidance is emitted only when `emitGuidance` is true (the `--assert`
 * failure path). Report-only runs keep stdout JSON and a silent stderr. */
export function writeAdvisoryConvergenceCliOutput(verdict, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  if (options.emitGuidance && !verdict.ready) {
    const next = formatAssertNextActions(verdict);
    if (next) {
      stderr.write(next);
      if (env.GITHUB_ACTIONS === 'true') {
        const summary = next
          .split('\n')
          .find((line) => line.startsWith('- '))
          ?.replace(/^- /, '');
        if (summary) {
          stderr.write(`::notice::${summary}\n`);
        }
      }
    }
  }
  stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}
// CLI: emit the verdict as JSON and set the exit code when invoked directly.
// Guarded behind `import.meta.main` so importing this module (for unit
// tests) never parses process.argv, prints usage, or makes a `gh` call.
if (import.meta.main) {
  const { pollIntervalMs, maxWaitMs } = readCopilotReviewPollPolicy();
  const { verdict, exitCode, help } = runAdvisoryConvergenceWithPoll(
    process.argv.slice(2),
    defaultDeps,
    { pollIntervalMs, maxWaitMs },
  );
  if (help) {
    printHelp();
  } else if (verdict) {
    writeAdvisoryConvergenceCliOutput(verdict, {
      emitGuidance: exitCode !== 0,
    });
  }
  process.exit(exitCode);
}
