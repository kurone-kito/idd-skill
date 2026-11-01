# IDD entry (user-global)

Apply only inside a Git repository for IDD issue/PR work.

Before work, run `idd-activation` in the repository with the stable harness
session ID as `--session-id`; read its JSON. If it is not on `PATH`, use
`~/.local/bin/idd-activation` on POSIX,
`& "$HOME\.local\bin\idd-activation.cmd"` in PowerShell, or
`"%USERPROFILE%\.local\bin\idd-activation.cmd"` in Command Prompt.

- If `active` is `false`, do nothing IDD-specific.
- If active with `selection.status: binding-required`, run
  `idd-onboard --distribution bind`, passing the same value to `--session-id`,
  then rerun activation. Wait for `ready` before opening phase instructions.
- If active and `selection.status: ready`, open
  `.github/instructions/idd-overview-core.instructions.md` under
  `instructionsRoot` and follow its phase routing.
- Otherwise stop before phase mutation and follow `selection.recovery`.
  Preparation needs an explicit immutable source; activation is read-only.

Run no other IDD helper or change state unless active and ready, or binding is
explicitly required above.
