# Bootstrap Log Segment

## [2026-05-16 17:27:50 JST] Claim And Worktree Setup

```shell
$ git worktree add \
  /home/kurone-kito/ghq/github.com/kurone-kito/idd-skill.issue-548-run-idd-skill-onboarding-example \
  -b issue/548-run-idd-skill-onboarding-example origin/main
Preparing worktree (new branch 'issue/548-run-idd-skill-onboarding-example')
branch 'issue/548-run-idd-skill-onboarding-example' set up to track 'origin/main'.

$ cd /home/kurone-kito/ghq/github.com/kurone-kito/vrc-event-calendar

$ git worktree add \
  /home/kurone-kito/ghq/github.com/kurone-kito/vrc-event-calendar.issue-548-run-idd-skill-onboarding-example \
  -b issue/548-run-idd-skill-onboarding-example origin/main
Preparing worktree (new branch 'issue/548-run-idd-skill-onboarding-example')
branch 'issue/548-run-idd-skill-onboarding-example' set up to track 'origin/main'.

$ cd /home/kurone-kito/ghq/github.com/kurone-kito/vrc-event-calendar.issue-548-run-idd-skill-onboarding-example
```

> **Note:** The example repository was already created and cloned
> locally before this onboarding pass began.

## [2026-05-16 17:30:10 JST] Import IDD Template Bundle

```shell
$ mkdir -p .github
[command completed with no terminal output]
$ rsync -a ../idd-skill/idd-template/.github/idd/ .github/idd/
[command completed with no terminal output]
$ rsync -a ../idd-skill/idd-template/.github/instructions/ \
  .github/instructions/
[command completed with no terminal output]
$ rsync -a ../idd-skill/idd-template/docs/ docs/
[command completed with no terminal output]
$ rsync -a ../idd-skill/idd-template/profiles/ profiles/
[command completed with no terminal output]
```

## [2026-05-16 17:31:35 JST] Replace Placeholders And Record Local Policy

```shell
$ python3 - <<'PY'
from pathlib import Path
root = Path('.')
replacements = {
    '{{REPO_NAME}}': 'vrc-event-calendar',
    '{{PROJECT_MARKER_PREFIX}}': 'vrc-event-calendar',
    '{{TRUSTED_MARKER_ACTOR}}': 'kurone-kito',
    '{{FIX_VALIDATE_COMMANDS}}': 'true',
    '{{PRE_PUSH_VALIDATE_COMMANDS}}': 'true',
    '{{POST_FIX_VALIDATE_COMMANDS}}': 'true',
    '{{INSTALL_DEPS_COMMAND}}': 'true',
}
for base in [root / '.github', root / 'docs', root / 'profiles']:
    for path in base.glob('**/*'):
        if path.is_file():
            text = path.read_text(encoding='utf-8')
            for old, new in replacements.items():
                text = text.replace(old, new)
            path.write_text(text, encoding='utf-8')
PY
[command completed with no terminal output]

$ rg -n "\{\{REPO_NAME\}\}|\{\{PROJECT_MARKER_PREFIX\}\}|\{\{TRUSTED_MARKER_ACTOR\}\}|\{\{FIX_VALIDATE_COMMANDS\}\}|\{\{PRE_PUSH_VALIDATE_COMMANDS\}\}|\{\{POST_FIX_VALIDATE_COMMANDS\}\}|\{\{INSTALL_DEPS_COMMAND\}\}" \
  .github docs profiles -S
[no output]
```

> **Note:** The initial onboarding baseline keeps the command rows at
> `true`. `helperRuntime.profile` is still at the imported template
> default here and is switched to `instructions-only` in the next
> customization step because the application toolchain has not been
> bootstrapped yet.

## [2026-05-16 17:33:20 JST] Apply Consumer-Specific Customization

```text
Manual apply_patch sequence in the example worktree:
- .github/idd/config.json: switch `helperRuntime.profile` from
  `package-manager` to `instructions-only`; add
  `skipIssueAuthorApprovalGate = false`; add
  `maintainerApprovalActorPolicy = owners-and-maintainers-only`.
- .github/instructions/idd-overview.instructions.md: add resolved
  roadmap marker examples for `vrc-event-calendar`.
- .github/instructions/idd-overview-appendix.instructions.md: rewrite
  the template-sync note so later updates pull from upstream
  `kurone-kito/idd-skill`.
- AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md:
  add or update the repository-specific entry text and point the agent
  entry files at `docs/idd-workflow.md` and `docs/idd-policy.md`.
- docs/idd-policy.md: add the local policy record for
  `fully_autonomous_merge`, `copilot-advisory`,
  `fast-agent-resolve`, `instructions-only`, and the trusted marker
  actor `kurone-kito`.
- docs/onboarding/placeholders.md,
  docs/onboarding/agent-entry-and-verification.md,
  docs/policy-constants.md, and .cspell.config.yml: repair
  placeholder-replacement artifacts and lint issues introduced by the
  raw import.
```

> **Note:** This edit block switched `helperRuntime.profile` to
> `instructions-only`, recorded repository-local IDD policy, updated the
> agent entry files to point at `docs/idd-workflow.md`, and removed
> onboarding-doc lint issues introduced by raw placeholder replacement.

## [2026-05-16 17:35:10 JST] Validate Imported IDD State

```shell
$ node ../idd-skill/scripts/idd-doctor.mjs --json
{
  "errors": [],
  "warnings": [
    "all primary command rows are set to `true` (no-op substitutions)",
    "branch protection not readable for kurone-kito/vrc-event-calendar:main"
  ],
  "passes": [
    "required instruction and reference files are present",
    "profile artifacts are present",
    "no unresolved {{...}} placeholders in IDD-managed files",
    "marker prefix is valid and consistent (vrc-event-calendar)",
    "merge policy signal found",
    "review policy signal found",
    ".github/idd/config.json declares helper runtime profile \"instructions-only\"",
    "AGENTS.md references docs/idd-workflow.md",
    "CLAUDE.md references docs/idd-workflow.md",
    "GEMINI.md references docs/idd-workflow.md",
    "template version signal found in .github/idd/config.json"
  ]
}

$ gh issue list --state open --limit 20 --json number,title,labels
[]

$ gh label list --limit 20
bug
documentation
duplicate
enhancement
help wanted
good first issue
invalid
question
wontfix
roadmap
status:blocked-by-human
status:needs-decision
status:authoring
idd:ready
```

> **Note:** The branch-protection warning is a diagnostic limitation of
> `idd-doctor` against ruleset-managed protection. Live ruleset
> verification was handled separately during issue #549.
