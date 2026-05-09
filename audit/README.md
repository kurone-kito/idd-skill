# Documentation Audit

The documentation audit keeps repeatable repository rules in CI instead
of relying only on agent memory.

Run it locally with:

```sh
node scripts/audit-docs.mjs --check
```

The audit reads [`sync-manifest.json`](sync-manifest.json). The
manifest has three main responsibilities:

- README pairs define files that must change together in pull requests,
  plus lightweight structure and language-link checks.
- Generated blocks define file lists that are rendered from the current
  repository state and compared with marked Markdown blocks.
- Sync pairs define template versus dogfooding files and the comparison
  mode for each pair.

## Sync Modes

- `exact`: the source and target must match byte-for-byte after line
  ending normalization.
- `concreted`: the source is transformed with explicit replacements,
  then compared exactly with the target.
- `structure`: Markdown heading levels and normalized heading text must
  match. Use this only when prose is intentionally different but the
  navigational shape must stay aligned.
- `contains`: the target must include each listed text fragment or
  regular expression.

## Intentional Exceptions

Prefer adding an explicit manifest rule over weakening the script. For a
new allowed concrete mapping, add a `concreted` sync pair with a
`replacements` array. For an intentional prose-only difference, use
`structure` and document why in the pair's `note` field. For generated
file lists, update the manifest paths or globs first, then rerun the
audit so the marked block can be refreshed deliberately.
