# IDD entry (user-global)

Git repos; IDD issues/PRs only.

Command Prompt, with stable ID; read JSON.
`"%USERPROFILE%\.local\bin\idd-activation.cmd" --session-id <id>`.
POSIX/PowerShell: `idd-activation --session-id <id>`.
Off PATH: POSIX `~/.local/bin/idd-activation --session-id <id>`;
PowerShell `& "$HOME\.local\bin\idd-activation.cmd" --session-id <id>`.

- `active: false`: stop.
- `selection.status: binding-required`: run
  `idd-onboard --distribution bind --session-id <id>`; rerun activation.
- `selection.status: ready` with non-null `instructionsRoot`: open
  `.github/instructions/idd-overview-core.instructions.md` under
  `instructionsRoot`; follow routing.
- Otherwise stop; follow `selection.recovery`:
  - `prepare`: choose trusted checkout; run
    `idd-onboard --distribution prepare --session-id <id> --source <checkout>`.
    After prepare, rerun activation.
  - `migrate` / `reselect`: run
    `idd-onboard --distribution inspect --session-id <id>`; send its report
    to maintainer. Read-only; do not bind or rerun activation.
    After repair, rerun activation with the same session ID; continue at
    `ready`; bind only at `binding-required`.

Stop unless ready, binding-required, or recovery is prepare.
