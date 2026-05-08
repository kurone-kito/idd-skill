# Workflow Boundary

This bundle handles pre-approval issue drafting only.

Use it to:

- prepare IDD-ready orphan issues when the target repository supports
  `issue-scope: orphan-first`
- prepare roadmap packages and child issues when work needs visible
  sequencing or parallel tracks
- surface non-ready buckets instead of guessing through blockers

Do not use it to:

- start the Discover -> Claim -> Work loop implicitly
- treat bundled references as a replacement for repository execution
  instructions
- publish issues unless the user explicitly asked for publishing

After the user approves the issue set, wait for a separate request to
publish the issues or start the IDD execution loop. Only then should
the workflow hand off to the repository's normal entry file and routed
`.github/instructions/*.instructions.md` phase files.
