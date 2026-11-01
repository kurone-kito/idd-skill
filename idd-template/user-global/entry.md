# IDD entry (user-global)

Apply only in a Git repo for IDD issue/PR work.

Before IDD work, run `idd-activation --session-id <id>` with the stable
harness ID; read JSON. If absent from `PATH`, use
`~/.local/bin/idd-activation` on POSIX,
`& "$HOME\.local\bin\idd-activation.cmd"` in PowerShell, or
`"%USERPROFILE%\.local\bin\idd-activation.cmd"` in Command Prompt.

- If `active` is `false`, do nothing IDD-specific.
- If active with `selection.status: binding-required`, run
  `idd-onboard --distribution bind --session-id <id>`; rerun activation.
- If active with `selection.status: ready`, open
  `.github/instructions/idd-overview-core.instructions.md` under
  `instructionsRoot` and follow phase routing.
- Otherwise stop and follow `selection.recovery`.
  - `prepare`: choose a trusted immutable checkout, then run:

    ```sh
    idd-onboard --distribution prepare --session-id <id> --source <checkout>
    ```

  - `migrate` / `reselect`: run
    `idd-onboard --distribution inspect --session-id <id>`, review it, then
    rerun activation after recovery.

Run no other IDD helper or change state unless active and ready, or binding is
explicitly required above.
