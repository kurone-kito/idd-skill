# IDD entry (user-global)

This text loads in every session. Apply it only inside a Git repository, and
only for work driven by an IDD issue or pull request.

Before any such work, run `idd-activation` from the repository directory. If
it is not on `PATH`, run `node <payload>/scripts/idd-activation.mjs` instead.
Read its JSON output.

- If `active` is `true`, open `idd-overview-core.instructions.md` under the
  `instructionsRoot` it reports, and follow the IDD phase routing from there.
- Otherwise, do nothing IDD-specific.

Run no IDD helper and change no repository state unless `active` is `true`.
