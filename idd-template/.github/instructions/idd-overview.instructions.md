---
applyTo: "**"
excludeAgent: "code-review"
---

# IDD (Issue-Driven Development) — Shared Definitions

This file has been split into two focused files:

- **`idd-overview-core.instructions.md`**:
  Runtime-critical definitions always loaded on IDD execution.
  Contains claim format, ownership gates, and fail-closed safety checks.
- **`idd-overview-appendix.instructions.md`**:
  Reference content for maintainers and implementation guidance.
  Contains policy constants, digest rules, commit signing, template sync,
  and other reference material.

**On IDD startup**: Load `idd-overview-core.instructions.md` for the
current shared definitions and phase routing table.

**For detailed reference**: See `idd-overview-appendix.instructions.md`
for operational guidance and detailed implementations.

## Project commands

When a phase refers to a named command set, run the corresponding
commands. **Adapt this section when applying this workflow to a
different project.**

If `.github/idd/config.json` exists and validates against the canonical
schema at
<https://kurone-kito.github.io/idd-skill/schemas/policy.schema.json>, its `commands`
object overrides the table below. Policy fields such as
`skipIssueAuthorApprovalGate` and `maintainerApprovalActorPolicy` are
the recorded machine-readable policy. Absent values keep the gate
enabled and default approval actors to
`owners-and-maintainers-only`.

| Name                    | Commands                         |
| ----------------------- | -------------------------------- |
| **fix-validate**        | `{{FIX_VALIDATE_COMMANDS}}`      |
| **pre-push-validate**   | `{{PRE_PUSH_VALIDATE_COMMANDS}}` |
| **post-fix-validate**   | `{{POST_FIX_VALIDATE_COMMANDS}}` |
| **install-deps**        | `{{INSTALL_DEPS_COMMAND}}`       |
| **issue-scope**         | `roadmap`                        |
| **orphan-first-policy** | `none`                           |

Non-shell rows such as **issue-scope** and **orphan-first-policy** are
workflow settings. Read them literally, not as commands.

`pre-push-validate` omits auto-fix. If lint fails, run
**fix-validate**, commit, then re-run **pre-push-validate**.

If **fix-validate** or **post-fix-validate** changes files, stage and
commit them before any push, rebase, or step that requires a clean
tree.

`install-deps` must be idempotent. Re-running it in fresh, reused, or
recreated worktrees must not require manual cleanup and should not leave
unexpected tracked changes.

**Tool availability**: run commands only when tools exist. For Node.js:
prefer project scripts; use `npx <tool>` if Node.js and `npx` are available
and no relevant script exists; else use `true`. For other tools, use
`true` when absent.
