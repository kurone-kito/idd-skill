# Documentation Audit

The documentation audit keeps repeatable repository rules in CI instead
of relying only on agent memory.

Run it locally with:

```sh
node scripts/audit-docs.mjs --check
```

The audit reads [`sync-manifest.json`](sync-manifest.json). The
manifest has these main responsibilities:

- README pairs define files that must change together in pull requests,
  plus lightweight structure and language-link checks.
- Generated blocks define file lists that are rendered from the current
  repository state and compared with marked Markdown blocks.
- Sync pairs define template versus dogfooding files and the comparison
  mode for each pair.
- File sets guard mirror completeness between a canonical glob and a
  mirrored glob, matched by basename (`match: "basename"`). With
  `requireSyncPairs: true`, every matched pair must also have a
  `syncPairs` entry, so a new file added to the canonical side without
  a mirrored copy — or without a sync pair covering it — fails the
  audit instead of shipping silently unmirrored. An unexpected file on
  the mirrored side fails too unless the set opts in with
  `allowExtraTargets: true`; `requiredBasenames` can additionally pin
  specific basenames that must always be present on the mirrored side.
  Basename matching requires **unique basenames on each side**: if a
  recursive glob ever matches two files with the same name in different
  directories, the audit fails closed with an "ambiguous basename"
  error rather than silently keeping only one of them.
- The root Markdown allowlist names the only `*.md` files that may live
  at the repository root; anything else fails the audit with a hint to
  record session evidence in issue comments instead.

## Sync Modes

- `exact`: the source and target must match byte-for-byte after line
  ending normalization.
- `concreted`: the source is transformed with explicit replacements,
  then compared exactly with the target.
- `structure`: Markdown heading levels and normalized heading text must
  match. Use this only when prose is intentionally different but the
  navigational shape must stay aligned.
- `contains`: the target must include each listed text fragment or
  regular expression. An optional `reference` file only asserts that the
  referenced source exists; it is not a semantic sync check.

## Intentional Exceptions

Prefer adding an explicit manifest rule over weakening the script. For a
new allowed concrete mapping, add a `concreted` sync pair with a
`replacements` array. For an intentional prose-only difference, use
`structure` and document why in the pair's `note` field. For generated
file lists, update the manifest paths or globs first, then rerun the
audit so the marked block can be refreshed deliberately.

## Bundle Budgets

The `bundleBudgets` entries cap the combined byte size of the
instruction files loaded together on each phase path (discovery,
resume, work, review, and merge), so context re-bloat fails the audit
instead of silently degrading unattended loops.

Each `limitBytes` value encodes at most roughly 10% headroom over the
bundle size measured when the entry was added or last adjusted.
**Ratchet rule**: raising any `limitBytes` value requires an explicit
callout in the pull request description explaining why the growth is
justified; shrinking a limit after an instruction diet needs no
callout.
