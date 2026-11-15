# Installed skill dispatcher

This is a stable entry point. Its `name` frontmatter selects the skill; the
full contract lives only in the immutable distribution selected for this
repository and session. Resolve that selection before reading any skill
contract or reference.

## Resolve the route

1. Honor a repository-local skill copy first. If the current host already
   selected this skill from the repository, use that local copy and stop here.
2. Use the stable session ID supplied by the host wrapper. The wrapper owns
   creating and persisting it; never mint a new ID for an invocation.
3. In a Git repository, run `idd-activation --session-id <stable-id>` and
   read its JSON. If the command is not on `PATH`, follow the
   platform-specific command in the installed `user-global/entry.md`. When
   `active` is `false`, use step 4. When `active` is `true`, this route
   applies to every skill invocation in that repository, issue authoring
   included:
   - Continue only when `selection.status` is `ready`. Use the exact
     `instructionsRoot` and `selection.report.selected` from that response.
   - For `binding-required`, `not-ready`, or a missing selection, follow
     `user-global/entry.md`'s bind or recovery route and stop until activation
     returns `ready`. Never load a global copy as a fallback.
4. Outside a Git repository, or when activation reports `active: false`, run
   the host's read-only
   `idd-onboard --distribution inspect --session-id <stable-id>` wrapper.
   Continue only when the report has a non-null `selected.sourceCommit`,
   `receipt.status: verified`, `preparation: prepared`,
   `compatibility: compatible`, and a `verdict` of `coherent-candidate`,
   `pin-preserved`, or `session-bound`. Any `source` value can pass; do not
   require a particular one. Issue authoring must still follow its selected
   contract's activation, publication, and applicability rules. A standalone
   spec audit remains read-only.

If the route is missing, ambiguous, incompatible, or unverified, stop and
report the `verdict` and `recovery` from the report; keep any last verified
selection. The only preparation or binding allowed is the explicit step that
`user-global/entry.md` names for `binding-required` or recovery `prepare`;
after it, start again at step 3 or 4. Never prepare, bind, change the global
default, or load another version on your own as an automatic fallback.

## Verify and load one bundle

For both routes, resolve the qualified data root the same way as the host
wrapper (`XDG_DATA_HOME/idd-skill` when `XDG_DATA_HOME` is qualified,
otherwise `HOME/.local/share/idd-skill`) and use
`prepared/<selected.sourceCommit>` beneath it. `instructionsRoot` confirms the
active route; for repository-local instructions it can name the checkout root
instead of the prepared set.

Before opening the skill contract, verify all of these facts:

- `manifest.json` is directly in that prepared-set root and its
  `sourceCommit` equals the selected report's `sourceCommit`.
- Each component's `digest` in `manifest.json` equals the same component's
  `digest` in the report's `selected.components`, and equals the digest
  recomputed from that component's `files` list: `sha256:` followed by the
  hex SHA-256 of one `<sha256> <path>` line per file, each ending in a line
  feed, sorted by path in UTF-8 byte order.
- `components.skillBundles.<name>.provenance.commit` equals that same commit.
- The component's `files` list contains `SKILL.md`; its SHA-256 matches the
  bytes at `skills/<name>/SKILL.md` in this prepared set.
- The skill name is the `name` in this dispatch entry's frontmatter.

Then read only `skills/<name>/SKILL.md` from that exact prepared set. Resolve
its relative references inside the same set, and verify each one against the
SHA-256 that `components.skillBundles.<name>.files` lists for it before
reading it. Never read a contract or reference from `~/.claude/skills/` or
`~/.agents/skills/` after dispatch.

`components.helper.invocation` records the set's entry helper; for a set that
`idd-onboard --distribution prepare` creates, that is the activation command.
The dispatcher does not run that helper and does not pass it to the contract,
so this build only records it. Do not reconstruct the command from the current
package. Every helper the contract names resolves through the repository's own
`helperRuntime` profile, as the contract says; the dispatcher does not
substitute another one.

## Host wrapper contract

The host-owned wrapper supplies a stable session ID and the invocation's
repository/worktree, preserves repository-local precedence, runs the supported
activation or inspection command, verifies the selected bundle, and loads
only its contract. External harness wrappers remain operator-owned: the
installer does not rewrite files outside its receipt-managed payload and the
two global skill roots. Diagnose an incompatible external wrapper and leave it
unchanged.
