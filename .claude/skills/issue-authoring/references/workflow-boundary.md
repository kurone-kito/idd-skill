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
- For new issues, bundled skill requires a capability-checked publication
  command that creates the issue with the authoring label atomically. If the
  target runtime cannot provide that operation, stop before creating the
  issue. Never intentionally create an unlabeled issue for the Stage 1 set
- Immediately after a new issue is created and labeled, bundled skill
  appends its `mode=acquire` owner marker with the current set ID, then
  re-fetches labels, body, and owner comments before treating it as a set
  member
- If an allegedly atomic create unexpectedly returns an unlabeled issue,
  close that issue before stopping and report the failed capability or
  permission check; deletion needs admin permission the authoring agent
  typically lacks (and `docs/permissions.md` forbids for normal IDD), so it
  is not the default recovery path
- If owner-marker append or verification is uncertain for a new issue,
  reconcile the returned comment ID and the paginated owner-marker log with
  bounded retries before closing. If a trusted marker is found, retain the
  label and recover or reopen the issue as a set member; otherwise leave the
  label in place and close before stopping.
- **Per-target ownership is separate from the hold label.** The configured
  authoring label is a shared claim-suppression lock, not a session lock. Before
  editing an existing issue or roadmap, the skill must fetch a fresh target
  snapshot, apply the label if it is absent, and append a hidden owner
  comment using the resolved marker prefix:

  ```html
  <!-- <marker-prefix>-authoring-owner: target=<owner>/<repo>#<number>; anchor=<owner>/<repo>#<number>; mode=acquire|resume|bootstrap|heartbeat|release; owner=<opaque-owner-token>; set=<opaque-set-id>; session=<opaque-session-id>; supersedes=<opaque-owner-token|none> -->
  ```

  _Issue-authoring ownership marker. Do not edit or delete._

  Append this HTML-first body with a direct JSON `POST` to the issue-comments
  endpoint; do not rely on `gh issue comment` or `gh api -f body=` for the
  owner marker. Verify the returned comment ID and body after posting.

  Owner tokens are per target: never compare a child target's `owner` value
  literally with the anchor's `owner` value. Every owner-marker log read for a
  target or anchor must use paginated issue-comment retrieval (for example,
  `gh api --paginate` or an API equivalent) and deterministic GitHub comment
  order (`created_at`, then comment ID); never rely on a single API page.

  Resolve the set anchor before appending any target marker. `anchor` records
  the canonical owner/repository/issue identity of that anchor; the anchor's
  own marker uses its `target` as the `anchor`, and every other marker in the
  set repeats the same value. A missing or mismatching `anchor` makes a
  marker invalid for set membership, resume, or release. A legacy marker
  without an anchor cannot resume a multi-target set; when no parent roadmap
  identifies the anchor, stop and bootstrap a fresh explicitly designated
  anchor instead of choosing a different lead implicitly.

  Only a trusted target-repository marker actor makes a marker valid: the
  current authenticated actor after posting and verifying it **and** passing
  a Write/Maintain/Admin permission check, a configured trusted bot or app,
  or an explicitly enabled Write/Maintain/Admin collaborator. Comment-only
  access is insufficient. If permission cannot be verified and no explicit
  bot/app trust applies, ignore and report the marker; syntax alone never
  grants ownership. For `acquire`, `bootstrap`, and `resume`, `owner` is a
  newly generated opaque per-target owner token; `supersedes=none` for
  `acquire` and `bootstrap`, while `resume` names the prior owner token.
  For `release`, retain the current owner token in `owner` and set
  `supersedes` to that same current owner token; `supersedes=none` is invalid
  for a release marker. For `heartbeat`, retain the current owner, set, and
  anchor, set `supersedes` to that same owner token, and do not open or close
  a generation; it only renews the current owner's freshness.
  Within an open generation, the first valid acquisition, bootstrap, or
  resume marker by GitHub comment order wins. A
  `resume` marker opens a new generation only for the exact interrupted set
  and matching prior owner token. A `release` marker must match the current
  owner and set, but remains provisional while its set release is in
  progress; an individual label removal never closes that target's
  generation. Only after a fresh re-read verifies every target's release
  marker and label removal does the set-level release close all target
  generations, after which a later `acquire` starts a new generation. The
  active generation's freshness is the GitHub `created_at`
  of its latest trusted acquisition, resume, or heartbeat marker; a resume
  marker
  refreshes that clock, and the label event alone never supersedes a fresh
  owner marker. The current generation's winner owns the target; any other
  session must stop without editing and leave the label in place. Do not
  edit or delete owner comments.
- For a new Stage 1 set, generate one opaque set ID and reuse it in every owner
  marker for that set. When resuming an interrupted set, recover and verify
  its persisted set ID from the exact trusted owner markers and reuse it
  instead of generating a replacement. Persist the resolved anchor identity in
  every marker as well. These append-only comments are the durable set, anchor,
  and target membership record; a resume may include only targets whose valid
  markers identify that exact set and anchor. Never infer set membership or the
  anchor from the shared label alone.
- Acquire one set anchor before acquiring any other target: use the parent
  roadmap when one exists, otherwise use the designated lead target. Freshly
  verify that anchor's trusted owner marker and set ID before acquiring child
  targets or wiring relationships. The anchor winner serializes acquisition
  for the whole set; no session may acquire children independently. If any
  target cannot be acquired under that anchor, stop all body and relationship
  edits, leave labels and append-only markers in place, and require an exact
  verified resume of that set rather than allowing a split ownership set.
- **Re-read before every edit.** Immediately before each body or roadmap
  relationship update, re-fetch both the target and the set anchor (the same
  fresh snapshot serves both roles when the target is the anchor). Require each
  target's expected owner token independently, plus the same set, anchor, and
  owning session, and require the expected body/label snapshot on the edited
  target to remain unchanged. An unexpected change, competing owner, malformed
  owner marker, or inability to prove a unique owner on either target is a
  conflict: stop without editing, leave the authoring label in place, and
  record the safe alternative.
- **Renew before every edit.** After that conflict check and immediately
  before the body or relationship mutation, append and verify a trusted
  `mode=heartbeat` marker for both the edited target and the set anchor (one
  marker serves both roles when they are the same target). Re-fetch both
  targets after the heartbeat and require each target's expected owner token
  independently, plus the same set, anchor, owning session, and expected target
  snapshot. If either heartbeat cannot be posted or verified, or a newer owner
  appears, stop without editing. A heartbeat never starts a new generation and
  never authorizes release.
- A target already held by another set is unavailable. A later session may
  resume only when the invocation identifies the exact interrupted set and
  the hold is past `issueAuthoring.authoringStaleAge`; it must append a
  `mode=resume` owner marker with a new owner token and `supersedes` value
  matching the prior owner token before re-running the same acquisition check.
  For a stale held target with no valid owner marker, append a trusted
  `mode=bootstrap` marker with the current set ID, a new owner token, and
  `supersedes=none`; this starts a new generation and is not evidence of any
  prior set membership. The first valid bootstrap marker wins. Staleness
  alone never authorizes takeover: use the latest trusted generation marker's
  GitHub `created_at` for marked targets, and the label event only for
  legacy-unowned bootstrap. A competing active marker still stops the
  session. If the target runtime provides an atomic acquisition helper, use
  it; otherwise this append-only conflict check is mandatory, including for
  `instructions-only` installs.
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
- Keep the set anchor held until every other target's label removal is
  verified, and remove the anchor label last. For every target, first
  re-fetch owner comments during release-marker preflight. If a valid
  current-owner/set `mode=release` marker already exists, reuse the earliest
  matching GitHub comment ID; otherwise append one with `supersedes` equal to
  the current owner token, re-fetch to verify it, and record its comment ID.
  Complete that preflight for the whole set before removing any label. A
  retry of an open generation must reuse the recorded or earliest matching
  marker and never append an indistinguishable duplicate. Then, immediately
  before each label removal, append and verify a `mode=heartbeat` marker for
  the target and set anchor (one marker when they coincide), then re-fetch both
  and require each target's expected owner token independently, plus the shared
  set/anchor/session, recorded release-marker comment, and expected label/body
  snapshot. Remove non-anchor labels one target at a time and re-fetch each
  result. Treat every release marker, heartbeat, and label removal as
  provisional: no target generation closes until every
  target's release marker and label removal are verified, at which point the
  set-level release closes all target generations together. If any later
  removal or verification fails, re-fetch every target already processed,
  retrying a failed post-removal read with a bounded fresh read, restore its
  authoring label while the current owner/set still matches, and verify the
  restored set state; leave every target generation open and stop. If
  restoration cannot be completed or a newer owner has appeared, record a
  set-level recovery hold and never claim a partial release.
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
