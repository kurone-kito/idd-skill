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

Adding a single new file under an existing `generatedBlocks[].sourceGlobs`
match — for example, a new lite instruction file under
`idd-template/.github/instructions/lite/` — touches three separate
manifest edits, not one, for `node scripts/audit-docs.mjs --check` to
pass:

1. A `syncPairs` entry (source/target and mode) so the mirrored copy is
   generated and compared.
2. A `bundleBudgets` entry when the file participates in a phase bundle,
   so the phase's context ceiling covers it.
3. The file's path added to the matching `generatedBlocks[].paths` list.

Step 3 is required for the audit check to pass — it compares `paths`
against the files each block's `sourceGlobs` actually match, and fails
by naming the block and the glob-matched file missing from `paths` (the
error has the form `<block-id>: manifest paths omit <path>`, where
`<block-id>` and `<path>` stand for the actual block id and file path).
`sync-docs.mjs` shares this exact `paths`-first, `sourceGlobs`-fallback
resolution rule with `audit-docs.mjs` (one function, imported by both):
`paths` is the only input it consults when present, and `sourceGlobs` is
used only as a fallback when `paths` is absent — so skipping the
`generatedBlocks[].paths` edit does not regenerate an empty block, but
it still fails this `paths`/`sourceGlobs` consistency check. Adding only
the `syncPairs` and `bundleBudgets` entries above is not enough;
skipping the `generatedBlocks[].paths` edit still fails the audit.

## Instruction Size Budgets

`instructionSizeBudgets` is an array of one entry per audited glob, each
with its own `id`, `glob`, `alwaysLoadedPattern`,
`alwaysLoadedLimitBytes`, and `phaseLimitBytes`. Two entries currently
run against the same caps: `instruction-size-budgets-dogfood` measures
this repo's own generated `.github/instructions/idd-*.instructions.md`
copies, and `instruction-size-budgets-idd-template` measures the
canonical `idd-template/.github/instructions/idd-*.instructions.md`
source adopters actually receive. The two copies of a `structure`-mode
sync pair (see Sync Modes above) may carry different prose and
therefore different byte counts, so without a dedicated entry per copy
one side could silently exceed the shared cap while only the other side
is ever measured (#1667).

Each entry's own `id` is the scope/label that keeps a violation message
unambiguous about which file set tripped it — the audited path's own
`.github/instructions/` vs `idd-template/.github/instructions/` prefix
disambiguates it a second time. Add a new entry (with its own `id`) for
any future glob that needs the same per-file byte cap, rather than
widening an existing entry's `glob` to cover unrelated files.

Like `checkFileSets`'s changed-file scoping, each entry only measures
files that changed against the resolved git comparison base (skipped
with a notice, never an error, when no base resolves — for example a
shallow clone without `origin/main`) — an unrelated PR never fails on a
pre-existing oversized file it did not touch. Widening a glob only
protects a copy going forward, from the next time someone actually
edits it; it does not retroactively re-audit every unchanged file on
every run. A one-time audit across every current file (not just changed
ones) is still worth running by hand after adding a new entry, to catch
any divergence that already exists.

## Bundle Budgets

The `bundleBudgets` entries cap the combined byte size of named file
groups loaded together on each phase path (including instruction
bundles and other context-bearing surfaces such as the onboarding front
door and its on-demand companions), so context re-bloat fails the audit
instead of silently degrading unattended loops.

Each `limitBytes` value encodes at most roughly 10% headroom over the
bundle size measured when the entry was added or last adjusted.
**Ratchet rule**: raising any `limitBytes` value requires an explicit
callout in the pull request description explaining why the growth is
justified; shrinking a limit after an instruction diet needs no
callout.

### Context ceiling

The `bundleBudgets` ratchet alone has no upper bound — each `limitBytes`
value has only ever followed content growth, and nothing mechanical
stopped the next exact-fit bump. Observed on
[#1213](https://github.com/kurone-kito/idd-skill/issues/1213) (closed
2026-07-03) and
[#1259](https://github.com/kurone-kito/idd-skill/issues/1259) (closed
2026-07-04, the very next day): both recovered headroom and both fully
regressed for lack of an upper bound. `contextCeiling` is an absolute,
200K-context-derived cap layered on top: 196,000 bytes ≈ 49,000–60,300
tokens at this corpus's observed 3.25–4.0 bytes/token, leaving the rest
of a 200K context window for the harness system prompt, tool schemas,
adopter-repo instructions, and working context.

- `maxBundleLimitBytes`: no non-exempt bundle's `limitBytes` may exceed
  this value.
- `maxUtilizationPct`: no non-exempt bundle's measured (banner-stripped)
  byte total may exceed this percentage of its own `limitBytes`. This is
  what kills future exact-fit landings even for bundles that stay under
  `maxBundleLimitBytes`.
- `noticeUtilizationPct`: any bundle (exempt or not) reaching this
  utilization prints a notice, making the near-ceiling band visible on
  every CI run instead of only at the moment a bundle tips over.
- `exemptBundles`: bundle ids temporarily excused from the two error
  checks above. Sibling diet issues shrink this list; a listed bundle
  that no longer violates either check gets a notice suggesting the
  exemption be removed — exemptions are meant to shrink to empty, not
  accumulate.

An id in `exemptBundles` that does not match any `bundleBudgets` entry
is itself an audit error (a typo or a bundle rename left behind).

As of the
[#1659](https://github.com/kurone-kito/idd-skill/issues/1659) 128K-ceiling
roadmap's finalize track
([#1658](https://github.com/kurone-kito/idd-skill/issues/1658)),
`exemptBundles` is empty: every bundle that entered the roadmap over
`maxBundleLimitBytes` or above `maxUtilizationPct` cleared both checks —
`bundle-review`, `bundle-work`, and `bundle-merge` via the sibling
content diets and #1658's own limit-lowering ratchet;
`bundle-pr-submit-lite` via a margin-restoring limit _raise_ instead,
since it was never over the byte ceiling, only briefly above the
utilization threshold. Keep the list empty going forward — add an entry
only alongside a maintainer-authorized exception (the same
PR-description callout the ratchet's own raise convention requires),
and shrink it back to empty in the same PR or a tracked follow-up once
that exception resolves.

As of [#2181](https://github.com/kurone-kito/idd-skill/issues/2181)
(resolved 2026-09-01), the ceiling moved from a 128K-token to a
200K-token context-window baseline: `bundle-review` had re-entered
`exemptBundles` pinned at the old 126,000-byte ceiling with no ratchet
room, exactly while the
Copilot-outage roadmap
([#2318](https://github.com/kurone-kito/idd-skill/issues/2318)) needed
advisory-wait instruction headroom in that bundle. The maintainer's
priority call: outage resilience outranks the byte diet in both
importance and urgency, and every session-model class the loop
currently exercises holds a context of 200K tokens or more. So
`maxBundleLimitBytes` rose to 196,000 (the same ~30%-of-window
discipline applied at 200K), `bundle-review` ratcheted to 138,000 and
`bundle-merge` to 122,000 (both back under the notice band), and
`exemptBundles` returned to empty. The diet remains a best-effort
goal: the raise-callout convention, the 98% utilization error, and the
95% notice all stay in force, and the lite bundles' budgets are
untouched — the 128K-class guidance in `docs/idd-workflow.md`
continues to route weak models to the lite profile.

## Markdown Link/Anchor Audit

`markdownLinkAudit` resolves every relative Markdown link found under
its configured `globs`, and any `#fragment` on that link, against the
target file's actual content: the file must exist, and a `#fragment`
must match one of the target's headings after applying GitHub's own
slugging rules — lowercase, delete punctuation outright (never
replace it with a hyphen or space), convert each space to a hyphen
without collapsing runs, and append `-1`, `-2`, ... to a heading slug
repeated later in the same document. A link to a directory (a target
ending in `/`) is checked for the directory's existence only, never
an anchor. Runs unconditionally over every matched file, not scoped
to changed files: a heading rename in one file orphans inbound
anchors in files a given pull request never touches, so a
changed-file scope would miss exactly the drift class this check
exists to catch. External `http(s)`, `mailto:`, and `tel:` links are
out of scope — no network I/O.

### Template context

A link from an `idd-template/**` file is resolved against what
adopters actually receive, not the source repository tree, in two
layers.

**Escape check**: `templateRoot` (default `idd-template/`) is the
outer boundary. A relative link whose resolved path falls outside
`templateRoot` fails the audit even when that exact path happens to
exist in the source repository — adopters never get the sibling files
the source repository ships outside `idd-template/`. Observed on
[#1696](https://github.com/kurone-kito/idd-skill/issues/1696) (the
2026-07-28 audit, closed 2026-08-01): a template instruction file's
relative link to the source repository's own
`copilot-instructions.md` and to a source-repo-only `schemas/`
directory both rot silently before this checker existed.

**Distributed-set check**: adopters do not receive the whole
`idd-template/` directory either — `--import` copies only the
`idd-template-core-files` generated block plus one helper-runtime
profile's files (`resolveCoreTemplateFiles` in
`src/scripts/idd-onboard.mts`), a set narrower than `templateRoot`.
`markdownLinkAudit.distributedFileSetBlockId` names the generated
block defining that set. For a source file covered by the named
block, a link that stays inside `templateRoot` still fails when its
resolved target is not itself in the distributed set — for example a
link to `idd-template/README.md` or `idd-template/ONBOARDING.md`,
neither of which ships to an adopter clone. `ONBOARDING.md` and
`README.md` themselves are template files outside the distributed
set, so a link **from** either one keeps the escape-only rule above
instead, since both are read in the source repository rather than
copied out. This class of dead link was fixed one file at a time
before this stricter check existed:
[#2062](https://github.com/kurone-kito/idd-skill/issues/2062)
(PR [#2087](https://github.com/kurone-kito/idd-skill/pull/2087)),
[#2088](https://github.com/kurone-kito/idd-skill/issues/2088)
(PR [#2107](https://github.com/kurone-kito/idd-skill/pull/2107)),
[#2982](https://github.com/kurone-kito/idd-skill/issues/2982)
(PR [#3047](https://github.com/kurone-kito/idd-skill/pull/3047)), and
[#3231](https://github.com/kurone-kito/idd-skill/issues/3231)
(PR [#3232](https://github.com/kurone-kito/idd-skill/pull/3232),
an inline code span rather than a link, so out of this checker's
scope). Both checks retarget the same way: a hosted URL, or a file
that genuinely ships in the distributed set, is the fix — not a
suppression.

### Suppressing an intentional exception

Add an `<!-- audit:ignore-link -->` HTML comment on the same source
line as the link to suppress every link on that line (matched after
inline code spans are stripped, so documenting the marker itself in
backtick-wrapped example text never suppresses a real link on that
same line). The marker must be a well-formed comment — a longer,
unrelated comment that merely starts with the same text is never
matched. Optionally carry a reason before the closing `-->`, for
example `<!-- audit:ignore-link: known false positive -->`. Keep this
narrowly used: prefer fixing the link or the heading first, and
reserve the marker for a link this checker cannot correctly evaluate.

## Lite Gate Parity

Most lite files under `idd-template/.github/instructions/lite/` state
that any mismatch with their standard-file counterpart (within the
lite file's declared scope) is a bug in the lite file, but nothing
mechanical checked that promise. Parity has been restored by hand,
repeatedly, after each gap was found by chance: issue
[#1700](https://github.com/kurone-kito/idd-skill/issues/1700) and
[#1701](https://github.com/kurone-kito/idd-skill/issues/1701) (lite E14
recovery bounds and E3 routing),
[#1794](https://github.com/kurone-kito/idd-skill/issues/1794) (the
activation-nonce recheck dropped from two lite guards),
[#2772](https://github.com/kurone-kito/idd-skill/issues/2772) (five
lite restatements that lost conditions),
[#2968](https://github.com/kurone-kito/idd-skill/issues/2968) (a
requested systematic lite-vs-standard sweep, itself performed by
hand), and
[#2978](https://github.com/kurone-kito/idd-skill/issues/2978) (lite
resume routing). `liteGateParity` is the prevention pass: a
machine-readable registry of named safety gates, each pointing at one
standard-file location and either its lite-file counterpart(s) or a
stated reason the lite profile omits it on purpose.

### Registry shape

`liteGateParity` is an array of entries. Each entry carries:

- `id` (unique, kebab-case) and `phase` (for example `F2`) — free-form
  labels; only `id` uniqueness is enforced.
- `standard`: one **location** in a canonical
  `idd-template/.github/instructions/*.instructions.md` source (never
  a path under `lite/`).
- exactly one of:
  - `lite`: one or more locations in
    `idd-template/.github/instructions/lite/` (always under `lite/`),
    optionally paired with `helperGate` (below);
  - `omittedByDesign`: `{ reason, lite: <location> }` — a non-empty
    `reason` plus the lite file's own location stating the exclusion,
    so every omission is visible where a lite reader would look for
    the gate.

A **location** is `{ file, heading, contains }` or `{ file, heading,
pattern }` — exactly one of `contains` (a literal substring) or
`pattern` (a regular-expression source, no implicit flags). `heading`
is the exact ATX heading text (no leading `#`s); its section runs from
that heading to the next heading of the same or shallower level,
including any fenced code blocks the section contains — many lite
gates live inside a fenced example. The heading is resolved with
GitHub's own heading-slug algorithm (the same one
[Markdown Link/Anchor Audit](#markdown-linkanchor-audit) above uses),
so a renamed heading fails the same way a dead anchor would. `heading`
must be unique within its own file: since it is always plain text
(never a pre-suffixed slug like `Gate-1`), it can only ever describe a
document's _first_ occurrence of that heading, so a location whose
file repeats the identical heading text elsewhere fails closed as
ambiguous rather than silently resolving to the first occurrence
(#3310 review).

`helperGate: { source, gate }` marks a `lite` entry whose lite
location delegates the actual gate decision to a helper's verdict
(for example a `blockers[]` entry) instead of restating it in prose;
the audit then also requires the literal `gate: '<gate>'` text
inside `source` (typically a `src/scripts/*.mts` helper module), so a
helper-side rename of the gate id is caught too.

### What the check catches, and what it does not

`collectLiteGateParityViolations`
(`src/scripts/consistency-helpers.mts`) reports an error for: an entry
carrying neither or both of `lite`/`omittedByDesign`; an empty
`omittedByDesign.reason`; a duplicate `id`; a location's file that
does not exist; a heading with no matching GitHub slug in its file, or
one that matches more than one heading there; a
location carrying both or neither of `contains`/`pattern`; a
`contains` substring or `pattern` match missing from its heading's
section; a `standard` location under `lite/`, or a `lite` location
outside it; a `helperGate` literal missing from its `source`; and a
`helperGate` on an `omittedByDesign` entry, which has no lite
location to delegate a verdict from.

**Known limit**: the registry detects a _registered_ gate
disappearing from either side — it does not detect an unregistered
new standard gate that never got a lite counterpart or an
`omittedByDesign` entry. Authors adding a new standard safety gate
register it here in the same pull request.
