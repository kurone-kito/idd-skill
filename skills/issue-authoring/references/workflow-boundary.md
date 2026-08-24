# Workflow Boundary

This bundle handles issue authoring end to end under the authoring
hold: drafting and publishing are one continuous stage with no
per-step approval, and release from the authoring hold is the single
approval boundary that hands off to IDD execution.

## Two-stage contract

### Stage 1: Author-and-publish (under the hold)

- Skill drafts issues in the target repository. Each candidate moves
  through the readiness buckets: `deferred` → `ready` or an escalation
  bucket (`needs-decision`, `blocked-by-human`, `out-of-scope`)
- Before publishing a `ready` body, bundled skill runs the mechanical
  `audit-authored-issue` gate and the critique pass (both unchanged
  and still mandatory)
- Bundled skill then publishes directly under the configured authoring
  label (`issueAuthoring.authoringLabelName`, defaulting to
  `status:authoring`) — **no prior user approval of the drafted body
  is required**. If the current request asked only for a preview
  (drafts to look at before anything is created), bundled skill stops
  after reporting the proposed set instead of publishing; publishing
  is otherwise the default outcome of drafting, not an opt-in step
- If the label does not exist in the target repository, bundled skill
  creates it with `gh label create` before first use; label creation or
  application failure blocks publishing
- For existing issues, bundled skill applies the authoring label before
  updating issue content
- For new issues, bundled skill creates the issue with the authoring label
  when the publication command supports that; otherwise it applies the
  label immediately after creation
- Immediately after a new issue is created and labeled, bundled skill
  appends its `mode=acquire` owner marker with the current set ID, then
  re-fetches labels, body, and owner comments before treating it as a set
  member
- If post-create label application fails, bundled skill closes the created
  issue before stopping; deletion needs admin permission the authoring
  agent typically lacks (and `docs/permissions.md` forbids for normal IDD),
  so it is not the default path
- If owner-marker append or verification fails for a new issue, leave the
  authoring label in place and close the created issue before stopping
- **Per-target ownership is separate from the hold label.** The configured
  authoring label is a shared claim-suppression lock, not a session lock. Before
  editing an existing issue or roadmap, the skill must fetch a fresh target
  snapshot, apply the label if it is absent, and append a hidden owner
  comment using the resolved marker prefix:

  ```html
  <!-- <marker-prefix>-authoring-owner: target=<owner>/<repo>#<number>; mode=acquire|resume|release; owner=<opaque-owner-token>; set=<opaque-set-id>; session=<opaque-session-id>; supersedes=<opaque-owner-token|none> -->
  ```

  Only a trusted target-repository marker actor makes a marker valid: the
  current authenticated actor after posting and verifying it, a configured
  trusted bot or app, or an explicitly enabled Write/Maintain/Admin
  collaborator. Ignore and report other marker-shaped comments; syntax alone
  never grants ownership. For `acquire` and `resume`, `owner` is a newly
  generated opaque per-target owner token; `supersedes=none` for `acquire`,
  while `resume` names the prior owner token. Within an open generation, the
  first valid acquisition or resume marker by GitHub comment order wins. A
  `resume` marker opens a new generation only for the exact interrupted set
  and matching prior owner token. A `release` marker must match the current
  owner and set, and closes that generation only after a fresh re-read
  confirms Stage 2 removed the label; a later `acquire` then starts a new
  generation. The current generation's winner owns the target; any other
  session must stop without editing and leave the label in place. Do not
  edit or delete owner comments.
- Generate one opaque set ID at Stage 1 start and reuse it in every owner
  marker for that set. These append-only comments are the durable set and
  target membership record; a resume may include only targets whose valid
  markers identify that exact set. Never infer set membership from the
  shared label alone.
- **Re-read before every edit.** Immediately before each body or roadmap
  relationship update, re-fetch the target and require the same owner to
  remain the winner and the expected body/label snapshot to remain unchanged.
  An unexpected change, competing owner, malformed owner marker, or inability
  to prove a unique owner is a conflict: stop without editing, leave the
  authoring label in place, and record the safe alternative.
- A target already held by another set is unavailable. A later session may
  resume only when the invocation identifies the exact interrupted set and
  the hold is past `issueAuthoring.authoringStaleAge`; it must append a
  `mode=resume` owner marker with a new owner token and `supersedes` value
  matching the prior owner token before re-running the same acquisition check.
  A held target with no valid owner marker is legacy-unowned and follows the
  same first-resume-wins rule. Staleness alone never authorizes takeover, and
  a competing active marker still stops the session. If the target runtime
  provides an atomic acquisition helper, use it; otherwise this append-only
  conflict check is mandatory, including for `instructions-only` installs.
- **The held issue IS the draft.** In-place body edits, roadmap
  relationship wiring (children first, then roadmaps once the real
  issue numbers exist), and re-lint of already-published bodies all
  happen on the published issue, under the same label — not in a
  session-local buffer that a later session cannot see
- **Interrupted-session guard.** If a Stage 1 session stops before the
  set is fully wired and stable, the authoring label stays on every
  issue it already published, and its owner markers stay in place. The
  label suppresses Discover while the markers preserve set identity and
  target membership for a later verified resume; a later session must not
  infer either from the label alone.

### Stage 2: Release (the single approval boundary)

- The user's explicit hold-release request is the only approval this
  bundle's workflow requires, and it authorizes IDD execution for the
  released issues
- Before removing the authoring label, bundled skill runs a release
  checklist that absorbs the rigor of the dropped middle step:
  - every child issue is referenced from its parent roadmap's
    `## Tracks` list
  - no unsubstituted placeholder (a leftover `#TBD`, template
    stand-in, or similar) remains in any published body
  - the `audit-authored-issue` linter (or its manual fallback under
    `instructions-only`) is green on every published body in the set
- Bundled skill removes the authoring label from all published issues
  only after the release checklist passes and the user's release
  request is explicit
- Release remains a human action; nothing in this bundle auto-releases
  a held issue set

## A4.5 Gate Timing

The IDD discover phase evaluates published issues through the A4.5
pre-claim suitability gate. This gate runs after an issue is published
but before it is claimed for work.

**Why A4.5 exists**: Issues drafted with incomplete information or from
assumptions that did not hold when published may fail A4.5 checks
(incoherent, unsafe, duplicate, etc.). A4.5 catches these before they
waste agent time during work.

**Prevention during drafting**: This bundle is where coherence, safety,
and uniqueness should be validated **before** publishing. A4.5 runs
seven suitability checks; the three that drafting can most directly
prevent (coherence, safety, uniqueness) correspond to bucket escalation
triggers during drafting:

- If an issue might be incoherent → escalate to `needs-decision` during
  drafting
- If an issue might contain untrusted input → escalate to `blocked-by-human`
  or fix during drafting
- If an issue might be a duplicate → run reuse-first checks during
  drafting before publishing

When these prevent-during-drafting checks are applied correctly, published
issues will pass A4.5; if they do not, A4.5 will catch them at discover
time and report the specific failure (unclear, invalid, duplicate).

## Use this bundle to

- prepare IDD-ready orphan issues when the target repository discovers
  orphans (`issue-scope: roadmap-first`, the default, via the orphan
  fallback, or `orphan-first`), including any required
  `orphan-first-policy` approval handoff
- prepare roadmap packages and child issues when work needs visible
  sequencing or parallel tracks
- surface non-ready buckets instead of guessing through blockers

## Do not use this bundle to

- start the Discover -> Claim -> Work loop implicitly
- treat bundled references as a replacement for repository execution
  instructions
- publish a body that has not passed the mechanical
  `audit-authored-issue` gate and the critique pass
- remove the authoring label from any issue without an explicit
  release request

## Handoff to execution

Once the user's explicit release request removes the authoring label
from every issue in the released set, execution is authorized: the
repository's normal entry file and routed
`.github/instructions/*.instructions.md` phase files (Discover, Claim,
Work) may pick up the released issues. This bundle does not itself
start that loop.
