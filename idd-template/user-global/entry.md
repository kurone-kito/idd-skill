# IDD entry (user-global)

In Git repos; IDD issues/PRs only.

Run `idd-activation --session-id <id>` with stable ID; read JSON.
If off PATH: POSIX `~/.local/bin/idd-activation`; PowerShell
`& "$HOME\.local\bin\idd-activation.cmd"`; Command Prompt
`"%USERPROFILE%\.local\bin\idd-activation.cmd"`.

- `active: false`: stop.
- `selection.status: binding-required`: run
  `idd-onboard --distribution bind --session-id <id>`; rerun activation.
- `selection.status: ready`: open
  `.github/instructions/idd-overview-core.instructions.md` under
  `instructionsRoot`; follow phase routing.
- Otherwise stop; follow `selection.recovery`:
  - `prepare`: choose trusted immutable checkout; run
    `idd-onboard --distribution prepare --session-id <id> --source <checkout>`.
    After prepare, rerun activation.
  - `migrate` / `reselect`: run
    `idd-onboard --distribution inspect --session-id <id>`; send its report
    to maintainer to repair provenance or select trusted
    distribution. Inspection is read-only; do not bind or rerun activation.
    After repair, rerun activation; continue only at
    `binding-required` (then bind above).

Stop unless ready, binding-required, or recovery is prepare.
