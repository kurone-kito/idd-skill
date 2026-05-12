# Onboarding Reference — Policy Decisions

Use this reference alongside `idd-template/ONBOARDING.md` when you need
the detailed policy-decision guidance that the thin onboarding entry
point now links to.

This page is the detailed companion for:

- Step 1B — confirm operator policy decisions
- Step 2 — re-check the selected policy before importing files
- Step 3 — record the selected policy in repository documentation

## Decisions that require explicit operator confirmation

These choices cannot be safely inferred from repository structure alone.
Keep the operator-confirmation boundary explicit.

### Merge policy

Choose exactly one merge policy before unattended runs begin:

- `fully_autonomous_merge` (distributed default): one trusted agent
  session may execute merge phase F3 after the normal claim, freshness,
  CI, advisory, and review gates pass
- `human_merge`: worker sessions stop at the merge-policy handoff gate
  and a human maintainer performs the merge
- `separate_merge_agent`: worker sessions stop at the default handoff
  gate and a separately authorized merge-capable actor performs the
  final merge path

Use `fully_autonomous_merge` as the proposed default unless the
operator explicitly opts out. For public or OSS repositories, recommend
`human_merge` before granting unattended credentials.

### Credential scope

Review `docs/permissions.md` with the operator before granting
unattended or merge-capable credentials. Choose the narrowest access
profile that can complete the intended phase.

Keep these boundaries explicit:

- `fully_autonomous_merge`: one trusted agent session may receive the
  merge-capable credential set needed to continue through F3
- `human_merge`: worker sessions must not receive merge-capable
  credentials because merge remains a human step
- `separate_merge_agent`: ordinary worker sessions stop at the handoff
  gate, while only the separately authorized merge-capable actor
  receives the stronger credentials needed for the final path

Record the selected credential boundary next to the merge policy so
future sessions can tell whether worker credentials and merge-capable
credentials are intentionally different.

### PR review policy profile

Choose whether the repository keeps the distributed GitHub Copilot
advisory review profile or applies a non-default review profile:

- `copilot-advisory` (distributed default)
- `no-advisory`
- another profile documented in `docs/idd-review-policy-profiles.md`

For non-default profiles, use the matching `profiles/<profile>/README.md`
artifact after import and update every listed phase file before treating
onboarding as complete.

### Review-thread resolution policy

Choose exactly one review-thread resolution profile:

- `fast-agent-resolve` (distributed default)
- `hybrid-reviewer-ack`
- `strict-reviewer-resolve`

If the repository chooses a non-default profile, update the review
snapshot, triage, review-fix, pre-merge, and merge phase files named in
`docs/idd-review-policy-profiles.md`.

### Critique-loop profile

Confirm whether the repository keeps the distributed critique-loop
defaults from `docs/policy-constants.md` or documents a local override.
At minimum, record whether the repository uses the shipped guardrails or
intentionally customizes the critique-loop behavior before unattended
execution begins.

### Issue-authoring companion

Confirm whether the operator wants the optional issue-authoring skill:

- `installed`: copy `skills/issue-authoring/` into the target repository
- `not installed`: continue without the companion

The companion helps draft IDD-ready issues and roadmaps. It does not
authorize publishing issues or starting the main execution loop on its
own.

### Helper runtime profile

Keep `instructions-only` unless helper support was explicitly
requested. When helper support is requested, choose the runtime profile
in this order:

1. `package-manager` when the target repository already uses pnpm, npm,
   or yarn
2. `vendored-node` when Node.js is available and helper files may be
   copied into the repository
3. `ephemeral-npx` only when a resolvable one-shot helper command
   already exists
4. `instructions-only` fallback when none of the above applies

Repositories without Node.js remain fully supported through
`instructions-only`.

Run this manifest helper from the target repository root when helper
support is enabled:

```sh
npx --yes --package <reviewed-helper-spec> \
  idd-helper-bundle-manifest --profile <selected-profile>
```

If `package-manager` auto-detection does not resolve npm, pnpm, or yarn,
pass `--package-manager <npm|pnpm|yarn>` explicitly. Pass
`--package-spec <pinned-spec>` when the repository wants the helper to
emit a reviewed tag, commit, tarball, or internal mirror URL. Treat
`refs/heads/main` as a manual opt-in when the repository explicitly
wants a mutable helper source instead of a reviewed pinned spec.

## Related default policies to confirm

The onboarding entry point should also confirm whether the repository
keeps the distributed claim-timing defaults from `docs/policy-constants.md`:

- `claim-stale-age`: `24 h`
- `claim-heartbeat-interval`: `12 h`

Record whether the repository keeps these defaults before unattended
workers begin running.

## Recording the selected policies

Create a local policy section in repository documentation (for example
in `.github/copilot-instructions.md`, `AGENTS.md`, or a dedicated
`docs/idd-policy.md`) and make it easy for future IDD sessions to find.

Use a structure like this:

```markdown
## IDD Policy Configuration

This repository uses the following IDD policies:

### Merge Policy

**Policy**: `{fully_autonomous_merge | human_merge | separate_merge_agent}`

### PR Review Policy

**Profile**: `{copilot-advisory | no-advisory | other}`

### Review-Thread Resolution Policy

**Policy**: `{fast-agent-resolve | hybrid-reviewer-ack | strict-reviewer-resolve}`

### Critique-Loop Profile

**Profile**: `{distributed defaults | repository override}`

### Claim Timing

- **claim-stale-age**: 24 h (or repository override)
- **claim-heartbeat-interval**: 12 h (or repository override)

### Credential Scope

**Worker credentials**: `{least-privilege worker scope}`

**Merge-capable credentials**: `{same as worker | separate stronger scope | not granted}`

### Helper Runtime Profile

**Profile**: `{instructions-only | package-manager | vendored-node | ephemeral-npx}`

### Issue-Authoring Companion

**Status**: `{installed | not installed}`
```

When the repository uses a non-default merge, review, or thread policy,
describe the local effect in prose near the selected value so future
agents do not need to infer what changed.

## Machine-readable policy file

`.github/idd/config.json` is the machine-readable record of the same
policy decisions. When present and valid, its `commands` object
overrides the command table values in
`idd-overview.instructions.md`. The non-command policy fields are a
machine-readable mirror that should stay aligned with the owning
instruction files and human-readable policy notes.

Keep these rules in mind:

- the JSON file is optional; the Markdown instructions remain the
  fallback when the JSON file is absent or invalid
- keep the human-readable policy section and `.github/idd/config.json`
  aligned in the same change
- treat non-command policy fields as synchronized metadata, not as a
  substitute for updating the instruction files that own phase behavior
- replace `<trusted-login>` in `trustedMarkerActors` with the GitHub
  login of each person or bot allowed to post trusted IDD markers
- keep command strings JSON-escaped instead of pasting fragile raw shell
- keep `helperRuntime.profile` aligned with the human-readable helper
  runtime section when helper support is enabled

The file validates against the canonical schema at:

<https://kurone-kito.github.io/idd-skill/schemas/policy.schema.json>

To validate locally from a checkout of `idd-skill`, run:

```sh
node scripts/validate-schemas.mjs
```
