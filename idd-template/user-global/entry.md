# IDD entry (user-global)

This text loads in every session. Apply it only inside a Git repository, and
only for work driven by an IDD issue or pull request.

Before any such work, run `idd-activation` from the repository directory. If
it is not on `PATH`, run `node "$PAYLOAD/scripts/idd-activation.mjs"` instead.
`PAYLOAD` is `$XDG_DATA_HOME/idd-skill/current` when `XDG_DATA_HOME` is a
qualified root. Otherwise it is `$HOME/.local/share/idd-skill/current` when
`HOME` is one. A qualified root is an absolute path that does not start with
`//` on POSIX, or a drive-letter or UNC path on Windows. If neither is
qualified, stop and report that the payload root is unresolved. Read the JSON
output.

- If `active` is `true`, open `.github/instructions/idd-overview-core.instructions.md`
  under the `instructionsRoot` it reports, and follow the IDD phase routing from
  there.
- Otherwise, do nothing IDD-specific.

Run no other IDD helper, and change no repository state, unless `active` is
`true`.
