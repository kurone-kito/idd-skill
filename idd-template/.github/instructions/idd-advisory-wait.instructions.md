# IDD — Copilot Advisory-Wait Protocol

This file defines the shared advisory-wait protocol used by:

- **E14** (`idd-review-fix.instructions.md`)
- **F2** (`idd-pre-merge.instructions.md`)
- **F3** (`idd-merge.instructions.md`)

Policy constants (cap and windows) are named in
[`docs/policy-constants.md`](../../docs/policy-constants.md). This file
owns behavior.

## Scope — Copilot-only settle/wait window

This protocol's settle/wait window covers **Copilot only**. Other
advisory reviewers configured through `.github/idd/config.json`
`advisoryBotLogins` (for example CodeRabbit or a Codex connector) are
**not** given a wait window by this protocol. That Copilot-only scope is
deliberate: see the `external-bot` profile in
[`docs/idd-review-policy-profiles.md`](../../docs/idd-review-policy-profiles.md),
which swaps the single advisory bot by manual customization instead of
gating on every configured bot.

In a repository that configures non-Copilot `advisoryBotLogins`, the
load-bearing safety net for their late-arriving findings is the **E1
activity-universe snapshot + `review-watermark` delta**
(`idd-review-snapshot.instructions.md`), re-checked by the F2/F3
merge-readiness gate — not this advisory-wait window. See
[`idd-pre-merge.instructions.md`](idd-pre-merge.instructions.md) for the
merge-gate requirement that forbids a bare CI-green merge without a fresh
covering snapshot.

## Fast path — common case

In the overwhelmingly common case the advisory bot reviews the current HEAD
within a couple of minutes, so the gate reduces to one check: poll
`LAST_COPILOT_COMMIT` (the `commit_id` of the latest Copilot review); as soon
as it equals the current `PR_HEAD_SHA` the gate is **SATISFIED** — skip the
AW2-AW5 marker / recovery / cap machinery and take the caller's `SATISFIED`
action (E14 → E15, F2 → CI check, F3 → merge). This is the common-case outcome
of **both** the helper-first canonical path (`outcome` / `f3Outcome` =
`SATISFIED`) and the shell fallback (AW3 decision table, row one), and changes
neither.

Enter the full protocol below **only** when `LAST_COPILOT_COMMIT != PR_HEAD_SHA`
— the canonical path (or the shell fallback when the helper cannot be trusted)
then handles the request, pending, stalled, restart, and cap cases.

Keep the wait itself cheap per the
[wake-up discipline](idd-ci.instructions.md#wake-up-discipline): schedule
a single wake at the **expected** completion, or background only if the
topology-safety condition holds (confirmed to route completion back to
this turn); otherwise wait synchronously. Batch all post-wait actions
into one turn.

## 1. Canonical path (helper-first)

When helper support is installed, use the profile-selected
advisory-wait helper command as the canonical evidence collector.

```sh
# source repo / vendored-node profile
node scripts/advisory-wait-state.mjs \
  --pr <pr-number> \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"

# package-manager / ephemeral-npx profile
<profile-selected-advisory-wait-command> \
  --pr <pr-number> \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"
```

Resolve `<profile-selected-advisory-wait-command>` from the helper
runtime manifest wiring in `docs/idd-helper-scripts.md`. Do not hardcode
`node scripts/...` for profiles that do not vendor `scripts/`.

Contract: `docs/idd-helper-scripts.md#stable-helper-evidence-outputs`
and `schemas/advisory-wait-state.schema.json`.

Required helper fields:

- `prHeadSha`
- `lastCopilotCommit`
- `copilotPending`
- `copilotPendingCoversHead`
- `outcome`
- `f3Outcome`
- `earliestSameHeadAt`
- `requestMarkerCount`
- `requestCap`
- `pendingWindowMinutes`
- `settledWindowMinutes`
- `pollIntervalMinutes`
- `capExhaustedRoute`
- `trustedMarkerSummary`

Optional non-gating secondary-bot fields (`secondaryBotLogin: ""` ⇒ disabled,
behavior identical to the primary-only path):

- `secondaryBotLogin` — resolved secondary advisory bot login, or empty when
  none is configured (a secondary equal to the primary counts as none).
- `secondaryRequestNeeded` — `true` when the secondary should be requested
  once for the current HEAD. **Not** in the `outcome` / `f3Outcome` enums and
  never changes any routing.

Allowed `outcome` / `f3Outcome` values:

- `SATISFIED`
- `REQUEST_NEEDED`
- `RECOVERY_NEEDED`
- `CAP_EXHAUSTED`
- `WAIT`

`HOLD` remains a protocol-level routing state for AW4/AW5 fail-closed
stops. It is caller-derived and not emitted by helper enums.

Resolve the effective advisory policy from helper output when available;
otherwise read `.github/idd/config.json` `advisoryWait.*`, falling back
to the distributed defaults named in `docs/policy-constants.md`:

- `REQUEST_CAP`
- `PENDING_WINDOW_MINUTES`
- `SETTLED_WINDOW_MINUTES`
- `POLL_INTERVAL_MINUTES`
- `CAP_EXHAUSTED_ROUTE`

`CAP_EXHAUSTED_ROUTE` must remain fail-closed. Supported values are:

- `phase-specific` (default): E14 skips to E15; F2 and F3 hold.
- `hold`: E14, F2, and F3 all hold on `CAP_EXHAUSTED`.

### Caller mapping

<!-- dprint-ignore-start -->
| Outcome | E14 | F2 | F3 |
| --- | --- | --- | --- |
| `SATISFIED` | proceed to E15 | continue to CI check | proceed with merge |
| `REQUEST_NEEDED` | request Copilot + marker + poll | return to E14 | return to E14 |
| `RECOVERY_NEEDED` | post recovery marker + poll | post recovery marker + poll | post recovery marker and return to F2 |
| `CAP_EXHAUSTED` | use `CAP_EXHAUSTED_ROUTE` | post cap-exhausted hold and stop | post cap-exhausted hold and stop |
| `WAIT` | continue polling | poll then restart F2 from top | do not merge; return to F2 |
| `HOLD` | post hold and stop | post hold and stop | post hold and stop |
<!-- dprint-ignore-end -->

### Secondary advisory bot supplement (non-gating)

When `advisoryWait.secondaryBotLogin` is configured, the helper sets
`secondaryRequestNeeded: true` alongside a `CAP_EXHAUSTED` or a stalled
`SATISFIED` (closed by the elapsed window while the primary never reviewed
HEAD). This is **orthogonal** to the table above: it changes no
`outcome` / `f3Outcome` value or route, never satisfies the primary gate, and
posts no `advisory-wait` marker. E14 then requests the secondary once per HEAD
(see `idd-review-fix.instructions.md`); its review is ordinary advisory input,
returned to review-triage by the E1 snapshot if it lands before merge.

### F3-specific interpretation

**Precedence**: when valid helper output is available, **F3 uses
`f3Outcome` exclusively**, so the **F3** column in the Caller-mapping table
above is read from `f3Outcome`. The `Outcome` column governs the **E14**,
**F2**, and shell-fallback rows (the shell-fallback path has no
`f3Outcome`); on `REQUEST_NEEDED`, F2 returns to E14 while E14 itself
requests Copilot and polls. This is why the helper can legitimately emit
`outcome: REQUEST_NEEDED` together with `f3Outcome: SATISFIED` (when
`copilotPending` is `false`) and F3 still merges on `f3Outcome` rather than
taking the `Outcome`-driven F2 route back to E14.

- F3 must use `f3Outcome` when helper output is available.
- If `copilotPending` is `false`, F3 treats advisory wait as satisfied.
- If `copilotPending` is `true`, F3 must not merge on `WAIT`,
  `REQUEST_NEEDED`, or `RECOVERY_NEEDED`.

## 2. Fail-closed fallback trigger

Do **not** proceed on helper output unless all required fields and enums
are valid and the output is consistent with protocol expectations.

Immediately switch to shell fallback (AW1-AW5) when any of these occurs:

- helper is unavailable
- helper exits non-zero
- helper output is invalid JSON
- required fields are missing
- enum value is outside the allowed set
- helper evidence disagrees with live state in a way that affects
  routing

If fallback cannot establish safe evidence, route to hold (`AW4` or
`AW5`) and stop.

## 3. Shell fallback (AW1-AW5)

Use this path whenever helper-first cannot be trusted.

### AW1 — Copilot review state

AW3 inputs:

- `LAST_COPILOT_COMMIT` — `commit_id` of the latest Copilot review
  (empty if none); equality with `PR_HEAD_SHA` short-circuits to
  **SATISFIED**.
- `COPILOT_PENDING` — `true` if Copilot is in `requested_reviewers`.
- `COPILOT_PENDING_COVERS_HEAD` — `true` if the latest Copilot
  `review_requested` event in the PR timeline follows the current
  HEAD's `committed` event.

See [shell fallback AW1](../../docs/idd-advisory-wait-shell-fallback.md#aw1)
for commands.

### AW2 — Advisory marker evidence

AW3 inputs:

- `TRUSTED_MARKER_LOGIN_JSON` — JSON list of trusted marker logins
  (current actor, configured trusted actors, plus write/maintain/admin
  collaborators when `IDD_TRUST_COLLABORATOR_MARKERS` is on).
- `EARLIEST_SAME_HEAD_AT` — earliest `created_at` of a trusted marker
  matching `advisory-wait`, `advisory-wait-recovery`, or
  `<!-- advisory-wait: … -->` for the current `PR_HEAD_SHA` (empty if
  none).
- `REQUEST_MARKER_COUNT` — count of trusted `advisory-wait` markers
  on this PR (excludes recovery markers).

See [shell fallback AW2](../../docs/idd-advisory-wait-shell-fallback.md#aw2)
for commands.

Rules:

- only trusted marker actors can start or extend advisory clocks
- same-head clock anchor is marker `created_at` (not embedded text)
- request-cap counting excludes recovery markers
- refresh AW2 evidence at each polling cycle
- never use commit author/committer timestamps as advisory proof

### AW3 — Decision table

Evaluate top-to-bottom; first match wins.

<!-- dprint-ignore-start -->
| `LAST_COPILOT_COMMIT` | `COPILOT_PENDING` | Marker state | Head proof / cap | Elapsed | Outcome |
| --- | --- | --- | --- | --- | --- |
| `== PR_HEAD_SHA` | any | any | any | any | `SATISFIED` |
| `!= PR_HEAD_SHA` | `"true"` | no same-head marker | `COPILOT_PENDING_COVERS_HEAD=true` | — | `RECOVERY_NEEDED` |
| `!= PR_HEAD_SHA` | `"true"` | no same-head marker | not proven; `REQUEST_MARKER_COUNT` < `REQUEST_CAP` | — | `REQUEST_NEEDED` |
| `!= PR_HEAD_SHA` | `"true"` | no same-head marker | not proven; `REQUEST_MARKER_COUNT` >= `REQUEST_CAP` | — | `CAP_EXHAUSTED` |
| `!= PR_HEAD_SHA` | `"true"` | marker exists | any | >= `PENDING_WINDOW_MINUTES` min | `SATISFIED` |
| `!= PR_HEAD_SHA` | `"true"` | marker exists | any | < `PENDING_WINDOW_MINUTES` min | `WAIT` |
| `!= PR_HEAD_SHA` | `"false"` | marker exists | any | >= `SETTLED_WINDOW_MINUTES` min | `SATISFIED` |
| `!= PR_HEAD_SHA` | `"false"` | marker exists | any | < `SETTLED_WINDOW_MINUTES` min | `WAIT` |
| `!= PR_HEAD_SHA` | `"false"` | no same-head marker | `REQUEST_MARKER_COUNT` >= `REQUEST_CAP` | — | `CAP_EXHAUSTED` |
| `!= PR_HEAD_SHA` | `"false"` | no same-head marker | `REQUEST_MARKER_COUNT` < `REQUEST_CAP` | — | `REQUEST_NEEDED` |
<!-- dprint-ignore-end -->

### AW3-R — Recovery marker

Use only when AW3 outcome is `RECOVERY_NEEDED`:

```text
advisory-wait-recovery: {agent-id} {PR_HEAD_SHA} {ISO8601-recovery-time}
```

When helper runtime is enabled, render and POST this marker with the
profile-selected post-idd-marker command — `--type advisory-recovery
--target pr <pr-number> --agent-id <id> --head-sha <PR_HEAD_SHA>
--timestamp <ISO8601> --apply` — which emits the plain-text
`advisory-wait-recovery:` form with no visible note so the AW2 recognizer
still matches; the manual JSON `POST` stays the fallback. The same helper
posts the `advisory-wait:` request form (the marker E14 sends on
`REQUEST_NEEDED`) via `--type advisory` with the same `--agent-id` /
`--head-sha` / `--timestamp` fields. See `docs/idd-helper-scripts.md`.

Rules:

- do not request another Copilot review in this path
- advisory clock starts from marker comment `created_at`
- if marker cannot be posted/read, route to `AW4` recovery-failed hold

### AW3-H — Hide superseded advisory-wait markers

After any new `advisory-wait` or `advisory-wait-recovery` marker is
verified to exist on GitHub for the current `PR_HEAD_SHA`, minimize
every trusted prior `advisory-wait*` marker on this PR whose embedded
HEAD SHA does **not** match the current `PR_HEAD_SHA` as `OUTDATED`.
The current-HEAD wait clock no longer needs the prior-HEAD markers
to be visible, and hiding them reduces F4 backlog and review-page
noise.

Find candidate subject IDs (trusted `advisory-wait*` markers whose
embedded SHA differs from `PR_HEAD_SHA`), then call:

```sh
node scripts/minimize-superseded-markers.mjs \
  --subject-ids "<id1>,<id2>,..." \
  --classifier OUTDATED \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" \
  --apply
```

Skip this step entirely if the new marker was not verified on
GitHub, the candidate set is empty (no prior-HEAD trusted markers),
or the helper is unavailable — F4 cleanup still catches them later.

Never hide a marker for the **current** `PR_HEAD_SHA`. The
`EARLIEST_SAME_HEAD_AT` anchor in AW2 relies on at least one
visible same-head marker.

### AW4 — Hold templates

#### Pending refresh failed

> Copilot review is pending for this PR, but the PR timeline does not
> prove that the request was created after HEAD `{PR_HEAD_SHA}` entered
> the PR, and E14 could not refresh the pending request. A maintainer
> must verify or request the Copilot review before this step can safely
> continue. Do not merge until the maintainer has resolved this.

#### Recovery failed

> Copilot review is pending for HEAD `{PR_HEAD_SHA}` but no
> advisory-wait marker can be posted or read. A maintainer must verify
> the Copilot advisory-wait state before this step can safely continue.
> Do not merge until the maintainer has resolved this.

#### Cap exhausted

> The configured per-PR Copilot re-review cap is exhausted. A maintainer must
> manually request and evaluate a Copilot review before merge.

### AW5 — Missing-marker recovery during polling

If `EARLIEST_SAME_HEAD_AT` becomes empty during active polling, post
this hold and stop:

> Advisory-wait marker for HEAD `{PR_HEAD_SHA}` is missing during
> polling. Unable to compute elapsed time. A maintainer must verify the
> Copilot advisory-wait state before this phase can safely continue.

## AW6 — Same-HEAD advisory reroll

F2-only (`#1511`) on `sameHeadReroll.eligible`; see
`idd-helper-scripts.md`. `requestable`: post the marker below **before**
requesting the review, then poll (not E14's loop). `inFlight`: poll only.
Else F2's route; `!inFlight`: E1.

```text
advisory-reroll: {agent-id} {PR_HEAD_SHA} {ISO8601-requested-at}
```

Plain text, no HTML comment — matching both `advisory-wait:`'s and
`advisory-wait-recovery:`'s shape. When helper runtime is enabled, render
and POST this marker with the profile-selected post-idd-marker command:

```sh
post-idd-marker --type advisory-reroll --target pr <pr-number> \
  --agent-id <id> --head-sha <PR_HEAD_SHA> --timestamp <ISO8601> --apply
```

The manual JSON `POST` stays the fallback. Fail closed to a hold
(mirroring AW3-R) if the marker cannot be posted or verified.
