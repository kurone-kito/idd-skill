# Workflow Boundary

This bundle handles pre-approval issue drafting only.

## Handoff sequence

The issue-authoring bundle fits into a three-phase handoff:

### Phase 1: Drafting (this bundle)

- Skill drafts issues in the target repository
- Issues move through readiness buckets: `deferred` → `ready` or
  → escalation bucket (`needs-decision`, `blocked-by-human`, `out-of-scope`)
- User approves the issue set before any publication

### Phase 2: Publishing (user-authorized handoff)

- User explicitly asks for publication
- Bundled skill creates or updates issues in the target repository
- User verifies the published issues look correct
- Published issues remain on hold until user explicitly requests IDD execution

### Phase 3: Execution (separate IDD loop)

- User explicitly asks to start the IDD execution loop
- Target repository's `.github/instructions/idd-discover.instructions.md`
  takes over
- IDD discover phase runs A0-T/A0-O/A1-A4.5 gates
- Suitable issues are claimed, worked, and merged

**Approval boundaries**:

- **After drafting** (Phase 1 → Phase 2): User must explicitly approve the
  issue set
- **After publishing** (Phase 2 → Phase 3): User must explicitly request IDD
  execution
- **No implicit progression**: Each handoff requires explicit user request.
  The bundle must not auto-transition to publishing or execution.

## A4.5 Gate Timing

The IDD discover phase evaluates published issues through the A4.5
pre-claim suitability gate. This gate runs after an issue is published
but before it is claimed for work.

**Why A4.5 exists**: Issues drafted with incomplete information or from
assumptions that did not hold when published may fail A4.5 checks
(incoherent, unsafe, duplicate, etc.). A4.5 catches these before they
waste agent time during work.

**Prevention during drafting**: This bundle is where coherence, safety,
and uniqueness should be validated **before** publishing. The three
A4.5 prevention checks (coherence, safety, uniqueness) correspond to
bucket escalation triggers during drafting:

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

- prepare IDD-ready orphan issues when the target repository supports
  `issue-scope: orphan-first`, including any required
  `orphan-first-policy` approval handoff
- prepare roadmap packages and child issues when work needs visible
  sequencing or parallel tracks
- surface non-ready buckets instead of guessing through blockers

## Do not use this bundle to

- start the Discover → Claim → Work loop implicitly
- treat bundled references as a replacement for repository execution
  instructions
- publish issues unless the user explicitly asked for publishing

## Handoff to execution

After the user approves the issue set, wait for a separate request to
publish the issues or start the IDD execution loop. Only then should
the workflow hand off to the repository's normal entry file and routed
`.github/instructions/*.instructions.md` phase files.
