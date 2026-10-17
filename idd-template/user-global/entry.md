# IDD entry (user-global)

This text loads in every session. Apply it only inside a Git repository, and
only for work driven by an IDD issue or pull request.

Before any such work, run `idd-activation` from the repository directory. If it
is not on `PATH`, run `~/.local/bin/idd-activation` on POSIX. On Windows
PowerShell, run `& "$HOME\.local\bin\idd-activation.cmd"`; in Command Prompt,
run `"%USERPROFILE%\.local\bin\idd-activation.cmd"`. Read the JSON output.

- If `active` is `true`, open `.github/instructions/idd-overview-core.instructions.md`
  under the `instructionsRoot` it reports, and follow the IDD phase routing from
  there.
- Otherwise, do nothing IDD-specific.

Run no other IDD helper, and change no repository state, unless `active` is
`true`.
