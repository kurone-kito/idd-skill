#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-shared-file-overlap.mts
//
// The scripts/discover-shared-file-overlap.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Read-only discovery-time evidence helper (#1019): for a set of candidate
// issues, report the high-contention shared files each would touch (parsed
// from its `## Candidate files` section) and whether any of those files
// overlap an actively-claimed or open-PR issue's candidate files. It also
// emits a soft de-prioritization order for A4 Step 2. It is the
// file-contention companion to the #1008 `--with-claim-state` claim-eligibility
// annotation. Evidence-only: it claims nothing and mutates no state.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAutopilotSuitability } from './autopilot-suitability.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import { parseIsoDurationToMs } from './policy-helpers.mjs';
import {
  resolveActiveClaim,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// Exported (#1484) so suitability-triage.mts's high-confidence Check 4 tier
// can build the identical high-contention set this module uses for A4 Step 2,
// instead of re-declaring its own copy of these defaults.
export const DEFAULT_MANIFEST_PATH = 'audit/sync-manifest.json';
/**
 * F-phase bundles whose member instruction files concentrate concurrent
 * edits. `bundle-review-triage-phase` + `bundle-review-fix-phase` replace
 * the former single `bundle-review` id (#2694: split into E1-E8 assessment
 * and E9-E15 remediation phase bundles, reusing #2789's shared `bundle-core`
 * instead of a second overlapping core bundle); `bundle-merge-phase`
 * likewise replaces the former single `bundle-merge` id (#2851: split into
 * a phase-specific bundle, also reusing `bundle-core` instead of listing
 * `idd-overview-core` / `idd-overview-appendix` directly). Because neither
 * successor bundle carries the two core files directly any more,
 * `bundle-core` is listed explicitly here so the resolved union stays the
 * same 10 files as before the #2851 split, instead of silently shrinking
 * by the two core files.
 */
export const DEFAULT_BUNDLE_IDS = [
  'bundle-core',
  'bundle-review-triage-phase',
  'bundle-review-fix-phase',
  'bundle-merge-phase',
];
/** Append-mostly shared surfaces that are not bundle members. */
export const DEFAULT_EXTRA_FILES = [DEFAULT_MANIFEST_PATH];
const DEFAULT_AUTOPILOT_SUITABILITY_FLOOR = 3;
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound on the best-effort open-PR scan (a `gh pr list --limit`). */
const OPEN_PR_SCAN_LIMIT = 500;
/** A Setext-style sibling heading's own underline: a lone run of `=` or `-`
 * characters (optional leading indent up to 3 *space* characters -- a tab
 * does not qualify (Codex review, PR #2840, round 11): CommonMark's block
 * openers tolerate 0-3 literal spaces of indent, never a tab (which
 * advances to the next 4-column tab stop, past the threshold), so a
 * tab-indented `---` renders as plain paragraph text, not a real
 * underline; the earlier `[ \t]{0,3}` wrongly counted a tab the same as a
 * space -- optional trailing whitespace), with no other content on the
 * line. Declared here (well above the `import.meta.main` CLI entry block
 * below) rather than next to {@link parseCandidateFiles}'s own use of it
 * -- a module-level binding initialized after that block is a
 * top-level-await TDZ risk (`tests/cli-entry-smoke.test.mts`). */
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
/**
 * A line CommonMark would never let become a Setext heading's own content
 * line even when immediately followed by an underline-shaped line: a list
 * item bullet/ordered marker, or a blockquote marker (Codex review, PR
 * #2840, round 2). A `- \`src/a.mts\`` bullet directly followed by a `---`
 * thematic break is not a Setext heading over that bullet -- the `---`
 * ends the list instead -- so treating it as one dropped the list's own
 * final (and, for a one-item list, only) candidate path. The marker-line
 * alternative's own leading indent is `{0,3}` *spaces*, not `[ \t]`, for
 * the same reason as {@link SETEXT_UNDERLINE_PATTERN} (Codex review, PR
 * #2840, round 11).
 */
const SETEXT_MARKER_LED_LINE_PATTERN = /^ {0,3}(?:[-*+][ \t]+|\d+[.)][ \t]+|>)/;
/**
 * Any line indented at all (deliberately broad regardless of tab-vs-space,
 * matching {@link SETEXT_MARKER_LED_LINE_PATTERN}'s own indent-tolerance
 * looseness), used by {@link isSetextIneligiblePrecedingLine} both as its
 * own indent test and to detect a *continuation* two lines up.
 */
const INDENTED_NONBLANK_LINE_PATTERN = /^[ \t]+\S/;
/**
 * True when `lines[contentIndex]` -- a line immediately followed (no
 * blank line between) by an underline-shaped line -- is not eligible to
 * be read as that Setext heading's own content, per CommonMark. Two
 * disqualifiers:
 *
 * 1. A list-item bullet/ordered marker or blockquote marker (Codex
 *    review, PR #2840, round 2): see {@link SETEXT_MARKER_LED_LINE_PATTERN}.
 * 2. An indented line that is itself a *continuation* of a list item --
 *    walking backward through the run of indented, non-blank lines this
 *    line is part of eventually reaches a marker-led line (Codex review,
 *    PR #2840, round 16, corrected round 20). A genuine multi-line Setext
 *    heading's own content lines are ALL indented too (CommonMark allows
 *    a Setext heading to span several lines), but that whole run traces
 *    back to a blank line or an unindented top-level line, never a list
 *    marker -- checking only the ONE line immediately before
 *    (round 16's own form) wrongly treated a second heading content line
 *    as a continuation just because the FIRST heading content line above
 *    it also happened to be indented, e.g. `" First line\n Second
 *    line\n ---"` right after a blank line: both lines are the SAME
 *    multi-line heading's own content, not a continuation of anything.
 *    `gh api /markdown` confirms CommonMark forms one heading
 *    ("First line<br>Second line") from both lines together.
 *
 *    An indented *wrapped continuation* line of a multi-line bullet --
 *    e.g. `- change:\n  \`src/a.mts\`\n---`, where the second line
 *    carries the real candidate path but starts with a backtick, not a
 *    marker -- is still correctly excluded this way, since walking back
 *    from it reaches `- change:` directly (marker-led); a
 *    continuation-of-a-continuation (`- Run:\n  one\n  two\n---`) is
 *    also still excluded, since walking back from its last indented line
 *    passes through the middle indented line and still reaches `- Run:`.
 *    A genuine 1-3-space-indented top-level Setext heading (CommonMark-
 *    legal, e.g. ` Notes\n -----` right after a blank line) is still
 *    eligible: walking back one step reaches the blank line, not a
 *    marker.
 */
function isSetextIneligiblePrecedingLine(lines, contentIndex) {
  const line = lines[contentIndex] ?? '';
  if (SETEXT_MARKER_LED_LINE_PATTERN.test(line)) {
    return true;
  }
  if (!INDENTED_NONBLANK_LINE_PATTERN.test(line)) {
    return false;
  }
  let index = contentIndex - 1;
  while (
    index >= 0 &&
    INDENTED_NONBLANK_LINE_PATTERN.test(lines[index] ?? '')
  ) {
    index -= 1;
  }
  const boundary = lines[index];
  return (
    boundary !== undefined && SETEXT_MARKER_LED_LINE_PATTERN.test(boundary)
  );
}
/**
 * Given `lastContentIndex` -- a line already confirmed eligible (not
 * `isSetextIneligiblePrecedingLine`) as the line directly above a Setext
 * heading's own underline -- finds the FIRST line of that heading's own
 * content paragraph, walking backward through as many immediately
 * preceding non-blank, non-marker-led lines as exist (Codex review, PR
 * #2840, round 24): CommonMark lets a Setext heading's content span
 * several lines, e.g. `` "`package.json`\nNotes\n---" `` renders as one
 * heading from BOTH lines -- `gh api /markdown` confirms
 * `<h2><code>package.json</code><br>Notes</h2>`. Round 20's own fix only
 * corrected *eligibility* (is the last line before the underline part of
 * a real heading, not a list continuation); it left the truncation point
 * itself at that last line, so a real backtick-quoted path on an EARLIER
 * line of the same multi-line heading still leaked into the preceding
 * section's own extracted text. Never walks back past `lowerBound`
 * (the section's own opening line), matching the caller's existing
 * `index > start` guard against misreading the section's own first line.
 */
function findSetextContentRunStart(lines, lastContentIndex, lowerBound) {
  let index = lastContentIndex;
  while (
    index > lowerBound &&
    (lines[index - 1] ?? '').trim() !== '' &&
    !SETEXT_MARKER_LED_LINE_PATTERN.test(lines[index - 1] ?? '')
  ) {
    index -= 1;
  }
  return index;
}
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `candidate:`): tests/flag-name-matrix.test.mts scans this file's
// *compiled* .mjs source text for quoted flag literals such as the
// --candidate spec key below. See cli-args.mts's module header for the
// full invariant. (This comment deliberately avoids writing that key
// inside matching quote marks, so it cannot itself satisfy the scan if
// the real key is ever renamed -- see #1446's PR description for why
// that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const DISCOVER_SHARED_FILE_OVERLAP_FLAG_SPEC = {
  '--candidate': { type: 'string', multiple: true },
  '--candidates': { type: 'string', multiple: true },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
  '--manifest': { type: 'string', default: DEFAULT_MANIFEST_PATH },
  '--bundles': { type: 'string' },
  '--check-overlap': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  runCli();
}
/**
 * Normalize a candidate-file path to its contention key. Strips surrounding
 * backticks and a leading `./`, and collapses a `idd-template/<x>` source onto
 * its generated `<x>` mirror so the two count as one contention surface. An
 * instruction file is keyed by its basename (`idd-merge.instructions.md`):
 * those basenames are unique repo-wide and issues cite them in several forms
 * (full source path, mirror path, or bare), so basename keying makes every
 * form compare equal.
 */
export function normalizeContentionPath(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/^`+/, '').replace(/`+$/, '').trim();
  value = value.replace(/^\.\//, '');
  value = value.replace(/^idd-template\//, '');
  const instruction = value.match(/(?:^|\/)([^/]+\.instructions\.md)$/);
  if (instruction) {
    return instruction[1];
  }
  return value;
}
/**
 * Parse the `## Candidate files` section of an issue body into a
 * de-duplicated list of {@link CandidateFileEntry} (raw path alongside its
 * normalized contention key). The section is advisory, so parsing is
 * lenient: it extracts every backtick-quoted path in the section —
 * including the continuation lines of a multi-line bullet — plus the
 * leading path-like token of any bullet that has no backticks at all.
 * Returns `[]` when the section is absent. De-duplicates on `raw` (Codex
 * review, PR #2840, round 9; previously deduplicated on `normalized`,
 * which silently discarded a later raw spelling sharing an earlier one's
 * contention key even when the later spelling is the one that actually
 * exists on disk -- see {@link candidateFilesExistOnDisk}'s doc comment).
 * `parseCandidateFiles` applies its own separate normalized-key dedup on
 * top, preserving that function's pre-existing one-entry-per-contention-
 * key contract for its own callers.
 *
 * (Considered and rejected, round 9: masking genuine inline code spans
 * out of `body` first, to guard a multi-line span from smuggling a fake
 * heading/Setext boundary past detection. Verified against GitHub's own
 * renderer -- see `triage-structural-evidence.mts`'s
 * `hasVerificationCommandSignal` doc comment -- that CommonMark's
 * block-before-inline parsing order already makes that input impossible:
 * an ATX heading (or Setext-eligible content line) inside an open span
 * closes it as literal text before the span can extend across the
 * heading, so there is no fake heading for a masking pass to hide.)
 */
export function parseCandidateFileEntries(body) {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    // Setext-style sibling heading boundary (Codex review, PR #2840): only
    // once already inside the section (`start !== -1`), stop at a
    // non-blank content line immediately followed (no blank line between)
    // by its own underline -- e.g. `Notes\n-----` -- the same boundary
    // `triage-structural-evidence.mts`'s own Acceptance-criteria section
    // extraction already recognizes. An ATX heading alone missed this
    // shape, letting an existing path in the later, unrelated section
    // leak into `candidateFilesExist`. `index > start` (rather than `>=`)
    // keeps the section's own opening line from ever being misread as a
    // Setext heading's content line. The preceding line must also be
    // Setext-heading-*eligible* (round 2, Codex): a list-item bullet or
    // blockquote line directly above an underline-shaped line is never a
    // Setext heading over that line -- e.g. a `---` right after this
    // section's own last candidate-file bullet ends the list (CommonMark's
    // own thematic-break rule), it does not retroactively turn that bullet
    // into a heading -- so wrongly truncating there dropped a real,
    // possibly the only, candidate path.
    if (
      start !== -1 &&
      index > start &&
      lines[index - 1].trim() !== '' &&
      !isSetextIneligiblePrecedingLine(lines, index - 1) &&
      SETEXT_UNDERLINE_PATTERN.test(lines[index])
    ) {
      end = findSetextContentRunStart(lines, index - 1, start);
      break;
    }
    // Leading indent is `{0,3}` literal *spaces*, not `\s` (Codex review,
    // PR #2840, round 11): `\s` also matches a tab, which CommonMark does
    // not tolerate as ATX-heading indent (a tab advances to the next
    // 4-column tab stop, past the 0-3-space threshold) -- a tab-indented
    // `## Candidate files` line renders as an indented code block, not a
    // real heading, so `\s{0,3}` wrongly opened (or closed) a section on
    // a line GitHub itself never treats as one.
    const heading = lines[index].match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (!heading) {
      continue;
    }
    const title = heading[2]
      // Strip a valid ATX closing hash sequence (Codex review, PR #2840,
      // round 14, reordered round 23): `## Candidate files ##` renders on
      // GitHub as a level-2 heading titled exactly "Candidate files" --
      // the trailing `##` is closing-sequence syntax, not part of the
      // title -- the same trailing-hash tolerance
      // `ACCEPTANCE_CRITERIA_HEADING_PATTERN` already carries for the
      // sibling section. Without this, the round-12 exact-match fix
      // rejected a heading GitHub itself renders identically to the bare
      // form, silently dropping every candidate path in that section.
      //
      // Must run BEFORE stripping inline formatting characters (round
      // 23): `` ## Candidate `files ##` `` keeps its trailing `##` as
      // literal code-span CONTENT, not a real ATX closer -- `gh api
      // /markdown` confirms the rendered heading is
      // `Candidate <code>files ##</code>`, not `Candidate files`.
      // Stripping backticks first exposed those code-span hashes as if
      // they were a real closer, wrongly opening the section on a
      // heading GitHub renders as something else entirely.
      .replace(/[ \t]+#+[ \t]*$/, '')
      .replace(/[*_`]/g, '')
      .trim()
      .toLowerCase();
    if (start === -1) {
      // Exact match, not a `\b`-bounded prefix (Codex review, PR #2840,
      // round 12): the prefix form also matched a related but distinct
      // sibling heading such as "## Candidate files considered but
      // rejected" -- a real heading, just not this section's contract
      // heading -- wrongly opening the section on it and letting an
      // existing path listed there satisfy `candidateFilesExist`.
      if (title === 'candidate files') {
        start = index + 1;
      }
      continue;
    }
    end = index;
    break;
  }
  if (start === -1) {
    return [];
  }
  const section = lines.slice(start, end);
  const sectionText = section.join('\n');
  const entries = [];
  // Every backtick-quoted path in the section, regardless of line wrapping.
  for (const match of sectionText.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim();
    const normalized = normalizeContentionPath(raw);
    if (looksLikePath(normalized)) {
      entries.push({ raw, normalized });
    }
  }
  // Bullets that quote no path fall back to a strict leading-token scan.
  for (const line of section) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item || /`[^`]+`/.test(item[1])) {
      continue;
    }
    const entry = extractStandaloneToken(item[1]);
    if (entry) {
      entries.push(entry);
    }
  }
  const seenRaw = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (seenRaw.has(entry.raw)) {
      continue;
    }
    seenRaw.add(entry.raw);
    deduped.push(entry);
  }
  return deduped;
}
/**
 * Parse the `## Candidate files` section into a de-duplicated, normalized
 * path list, built from {@link parseCandidateFileEntries} for its callers:
 * `suitability-triage.mts`'s Check 4 high-contention tier and this module's
 * own `analyzeSharedFileOverlap`, both of which compare candidate paths as
 * contention keys, never as filesystem paths. Applies its own
 * normalized-key `Set` dedup (Codex review, PR #2840, round 9) --
 * {@link parseCandidateFileEntries} itself now de-duplicates on `raw`, so
 * two raw spellings sharing a contention key (e.g. an
 * `idd-template/<name>` source and its `<name>` mirror) both survive
 * there; collapsing them back to one entry per key here preserves this
 * function's own pre-existing one-entry-per-contention-key contract.
 * {@link candidateFilesExistOnDisk} (triage-structural-evidence.mts, #2767)
 * needs the un-normalized `raw` form instead -- a filesystem existence
 * check against a mirror-collapsed contention key can report a real file
 * as existing when the path actually written in the issue does not.
 */
export function parseCandidateFiles(body) {
  return [
    ...new Set(
      parseCandidateFileEntries(body).map((entry) => entry.normalized),
    ),
  ];
}
/** Extract a strict leading path token from a bullet that quotes no path. */
function extractStandaloneToken(itemBody) {
  let text = itemBody.trim();
  text = text.split(/\s+(?:—|–|--)\s+/)[0];
  text = text.split(/\s+\(/)[0];
  const raw = text.split(/[\s,;]+/)[0] ?? '';
  const normalized = normalizeContentionPath(raw);
  return looksLikeStandalonePath(normalized) ? { raw, normalized } : null;
}
/** A backtick-quoted token only needs a separator or extension. */
function looksLikePath(value) {
  return value.length > 0 && !/\s/.test(value) && /[/.]/.test(value);
}
/**
 * An unquoted bullet token must look unambiguously like a file path: a final
 * extension, a glob, or a trailing directory slash. This rejects prose such
 * as "generated/mirrored" that merely contains a slash.
 */
function looksLikeStandalonePath(value) {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  return (
    /\.[a-z0-9]+$/i.test(value) || value.includes('*') || value.endsWith('/')
  );
}
/**
 * Resolve the high-contention shared-file set from the sync manifest: the
 * union of the named bundles' member files plus any extra append-mostly
 * surfaces. Paths are normalized so a source and its mirror collapse together.
 */
export function resolveHighContentionFiles(options) {
  const bundleIds = new Set(options.bundleIds ?? DEFAULT_BUNDLE_IDS);
  const extraFiles = options.extraFiles ?? DEFAULT_EXTRA_FILES;
  const result = new Set();
  const bundles = options.manifest?.bundleBudgets;
  if (Array.isArray(bundles)) {
    for (const bundle of bundles) {
      const entry = bundle;
      if (!entry || !bundleIds.has(String(entry.id))) {
        continue;
      }
      if (Array.isArray(entry.files)) {
        for (const file of entry.files) {
          result.add(normalizeContentionPath(file));
        }
      }
    }
  }
  for (const file of extraFiles) {
    result.add(normalizeContentionPath(file));
  }
  return result;
}
/**
 * Compute per-candidate high-contention overlap evidence against the active
 * set, plus a soft de-prioritization order for A4 Step 2.
 */
export function analyzeSharedFileOverlap(input) {
  const floor = input.floor ?? DEFAULT_AUTOPILOT_SUITABILITY_FLOOR;
  // When the autopilot-suitability kill switch is off (A4 Step 2 ignores the
  // score and selects by lowest issue number), equalize every effectiveScore so
  // the recommended order is driven by overlap then issue number, not score.
  const suitabilityEnabled = input.suitabilityEnabled !== false;
  const highContention = new Set(input.highContentionFiles);
  const activeTouched = input.activeIssues.map((active) => ({
    number: active.number,
    reason: active.reason,
    files: intersect(active.candidateFiles, highContention),
  }));
  const candidates = input.candidates.map((candidate) => {
    const score = typeof candidate.score === 'number' ? candidate.score : null;
    const highContentionTouched = intersect(
      candidate.candidateFiles,
      highContention,
    );
    const touchedSet = new Set(highContentionTouched);
    const overlaps = [];
    for (const active of activeTouched) {
      if (active.number === candidate.number) {
        continue;
      }
      const shared = active.files.filter((file) => touchedSet.has(file));
      if (shared.length > 0) {
        overlaps.push({
          number: active.number,
          reason: active.reason,
          files: shared.slice().sort(),
        });
      }
    }
    overlaps.sort((left, right) => left.number - right.number);
    return {
      number: candidate.number,
      score,
      effectiveScore: suitabilityEnabled ? (score ?? floor) : 0,
      candidateFiles: candidate.candidateFiles,
      highContentionTouched,
      overlaps,
      overlapFlag: overlaps.length > 0,
    };
  });
  const preSorted = candidates
    .slice()
    .sort(
      (left, right) =>
        right.effectiveScore - left.effectiveScore ||
        left.number - right.number,
    );
  const recommendedOrder = applyOverlapTieBreaker(preSorted).map(
    (candidate) => candidate.number,
  );
  return {
    candidates,
    recommendedOrder,
    summary: {
      candidateCount: candidates.length,
      flaggedCount: candidates.filter((candidate) => candidate.overlapFlag)
        .length,
      activeIssueCount: input.activeIssues.length,
    },
  };
}
/**
 * Soft de-prioritization tie-breaker for A4 Step 2. The input must already be
 * ordered by the existing rules (suitability score descending, then issue
 * number ascending / desync). Within each equal-`effectiveScore` band this
 * stably moves overlap-flagged candidates after the non-overlapping ones; it
 * never crosses a score band and never drops a candidate, so a colliding
 * candidate that is the only ready work keeps its position.
 */
export function applyOverlapTieBreaker(ranked) {
  const out = [];
  for (let index = 0; index < ranked.length; ) {
    let end = index;
    while (
      end < ranked.length &&
      ranked[end].effectiveScore === ranked[index].effectiveScore
    ) {
      end += 1;
    }
    const band = ranked.slice(index, end);
    for (const candidate of band) {
      if (!candidate.overlapFlag) {
        out.push(candidate);
      }
    }
    for (const candidate of band) {
      if (candidate.overlapFlag) {
        out.push(candidate);
      }
    }
    index = end;
  }
  return out;
}
function intersect(files, highContention) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    if (highContention.has(file) && !seen.has(file)) {
      seen.add(file);
      result.push(file);
    }
  }
  return result.sort();
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.candidates.length === 0) {
    throw new Error('at least one --candidate <number> is required');
  }
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const policy = loadPolicy(args.policy);
  const now = args.now || new Date().toISOString();
  const { manifest, missing: manifestMissing } = loadManifest(args.manifest);
  // A missing manifest must not fall back to resolveHighContentionFiles's
  // extraFiles default (the manifest path itself) — that would fabricate a
  // one-entry high-contention set from a file that doesn't exist.
  const highContentionFiles = manifestMissing
    ? new Set()
    : resolveHighContentionFiles({
        manifest,
        bundleIds: args.bundles ?? DEFAULT_BUNDLE_IDS,
        // Track the manifest actually in use so a custom --manifest is the file
        // reported (and matched) as high-contention, not the hard-coded default.
        extraFiles: [args.manifest],
      });
  const candidates = args.candidates.map((number) => {
    const issue = fetchIssue(port, number);
    return {
      number,
      score: parseAutopilotSuitability(issue.body, policy.markerPrefix),
      candidateFiles: parseCandidateFiles(issue.body),
    };
  });
  let activeIssues = [];
  // A missing manifest guarantees an empty high-contention set (see above),
  // so every overlap intersection would be empty regardless of active-issue
  // data — skip the API cost entirely in that case.
  if (args.checkOverlap && !manifestMissing) {
    activeIssues = discoverActiveIssues({
      port,
      trustedActors: policy.trustedMarkerActors,
      staleAgeMs: policy.claimStaleAgeMs,
      now,
    });
  }
  const analysis = analyzeSharedFileOverlap({
    candidates,
    activeIssues,
    highContentionFiles,
    floor: policy.autopilotSuitabilityFloor,
    suitabilityEnabled: policy.autopilotSuitabilityEnabled,
  });
  const output = {
    repository: { owner, repo },
    checkedOverlap: args.checkOverlap,
    manifestMissing,
    highContentionFiles: [...highContentionFiles].sort(),
    ...analysis,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
/**
 * Discover the concurrently-active set: every issue closed by an open PR
 * (repo-wide), plus candidate issues that already carry a non-stale claim.
 * Active-by-claim covers every issue with a remote `issue/<n>-*` branch (every
 * IDD claim creates one once pushed), resolved with the standard `claimed-by`
 * claim-state rules — not just the candidate set — so a claim held by another
 * session is detected even though it is outside the unclaimed candidates being
 * ranked. A claim whose branch is not yet pushed is picked up once it appears
 * remotely. Active-by-PR is a best-effort scan of open PRs (bounded by the
 * PR-list page cap). Both stay bounded — no repo-wide comment scan — which is
 * the fetch cost `--check-overlap` gates; the overlap signal is an advisory A4
 * Step 2 tie-breaker, so best-effort coverage is acceptable. Edge cases the
 * advisory signal does not specially resolve: legacy claim-id-less markers and
 * forced-handoff-successor adoption (the default `resolveActiveClaim` path).
 */
function discoverActiveIssues(options) {
  const { port, trustedActors, staleAgeMs, now } = options;
  const active = new Map();
  // Active-by-PR: issues closed by an open PR (best-effort across open PRs,
  // bounded by the PR-list page cap).
  for (const number of fetchOpenPrLinkedIssues(port)) {
    if (!active.has(number)) {
      const body = fetchIssue(port, number).body;
      active.set(number, {
        number,
        reason: 'pr',
        candidateFiles: parseCandidateFiles(body),
      });
    }
  }
  // Active-by-claim: scan the issues that have a *remote* `issue/<n>-*` branch
  // — every IDD claim creates one, published once its branch is pushed — so a
  // non-stale claim held by another session is detected even though it is
  // outside the (unclaimed) candidate set the ranking operates on. Bounded by
  // the number of active issue branches, not a repo-wide comment scan; a claim
  // whose branch is not yet pushed is picked up once it appears remotely. The
  // configured claim stale age drives both the supersession check inside
  // resolveActiveClaim and the non-stale filter here.
  const isTrusted = (login) =>
    trustedActors.some((actor) => actor.toLowerCase() === login.toLowerCase());
  const isStale = (activeCreatedAt, nextCreatedAt) =>
    new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >=
    staleAgeMs;
  for (const number of fetchActiveClaimBranchNumbers(port)) {
    if (active.has(number)) {
      continue;
    }
    const comments = fetchIssueComments(port, number);
    const claim = resolveActiveClaim(comments, {
      isTrustedAuthor: isTrusted,
      isStale,
    });
    if (claim && !isStale(claim.createdAt, now)) {
      const body = fetchIssue(port, number).body;
      active.set(number, {
        number,
        reason: 'claim',
        candidateFiles: parseCandidateFiles(body),
      });
    }
  }
  return [...active.values()].sort((left, right) => left.number - right.number);
}
/** Issue numbers that currently have an `issue/<n>-*` branch on the remote. */
function fetchActiveClaimBranchNumbers(port) {
  const numbers = new Set();
  for (const ref of port.listIssueBranchRefs()) {
    const match = ref.match(/^refs\/heads\/issue\/(\d+)-/);
    if (match) {
      numbers.add(Number.parseInt(match[1], 10));
    }
  }
  return [...numbers];
}
function fetchIssue(port, number) {
  // Fail closed: let a fetch failure surface rather than returning an empty
  // body, which would silently suppress this issue's candidate files and emit
  // a false "no overlap" result. `getWorkItem` returns null on a 404 instead
  // of throwing (unlike this file's pre-migration `gh issue view`, which
  // threw on any failure, missing issues included), so a missing issue is
  // turned back into a thrown error here to preserve that fail-closed
  // contract.
  const issue = port.getWorkItem(number);
  if (!issue) {
    throw new Error(`issue #${number} not found`);
  }
  return { body: issue.body };
}
/**
 * Map a `ProviderComment` to the `CommentLike` shape `resolveActiveClaim`
 * consumes. `resolveActiveClaim` reads the author from `author.login`, but
 * `ProviderComment` carries it as a flat `authorLogin` (matching
 * `discover-roadmap-graph`'s own comment loader, which maps the equivalent
 * REST `user.login` the same way), so the login must be mapped across here.
 * Emitting `authorLogin` unmapped would leave `author` empty and silently
 * disable claim detection.
 */
export function toClaimComment(raw) {
  return {
    body: raw.body,
    createdAt: raw.createdAt,
    author: { login: raw.authorLogin },
  };
}
function fetchIssueComments(port, number) {
  return port.listWorkItemComments(number).map(toClaimComment);
}
function fetchOpenPrLinkedIssues(port) {
  // Best-effort: `gh pr list` caps at --limit, so a repo with more open PRs
  // than the cap drops the overflow. Acceptable for an advisory signal.
  return port.listIssueNumbersClosedByOpenChangeRequests(OPEN_PR_SCAN_LIMIT);
}
/**
 * Load the sync manifest. A missing file (`ENOENT` — the common adopter case,
 * since `audit/sync-manifest.json` is a source-repo audit artifact that
 * adopter repositories do not ship) degrades quietly: `missing: true`, no
 * throw. Any other read failure (permissions, a directory in place of the
 * file, …) or a present-but-malformed manifest still fails closed exactly as
 * before — an empty manifest would otherwise yield an empty high-contention
 * set, making every candidate look non-overlapping.
 */
export function loadManifest(manifestPath) {
  const targetPath = resolve(
    process.cwd(),
    manifestPath || DEFAULT_MANIFEST_PATH,
  );
  let raw;
  try {
    raw = readFileSync(targetPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { manifest: null, missing: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to load sync manifest at ${targetPath}: ${message}`,
    );
  }
  try {
    return { manifest: JSON.parse(raw), missing: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to load sync manifest at ${targetPath}: ${message}`,
    );
  }
}
function loadPolicy(policyPath) {
  // Fail closed on an explicit --policy that cannot be loaded: silently
  // using defaults would drop custom trusted actors / claim timing and let
  // active claims disappear. An absent default config still falls back
  // (idd-config.mts's loadPolicyConfig, #1721, converges this read-and-parse
  // semantics for all nine --policy/--config-aware helpers).
  const config = loadPolicyConfig(policyPath).config;
  const markerPrefix =
    typeof config?.markerPrefix === 'string' && config.markerPrefix.length > 0
      ? config.markerPrefix
      : DEFAULT_MARKER_PREFIX;
  const trusted = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config,
  });
  const floorValue = config?.autopilotSuitability?.floor;
  const autopilotSuitabilityFloor =
    typeof floorValue === 'number' && floorValue >= 1 && floorValue <= 5
      ? floorValue
      : DEFAULT_AUTOPILOT_SUITABILITY_FLOOR;
  const autopilotSuitabilityEnabled =
    config?.autopilotSuitability?.enabled !== false;
  const claimStaleAgeMs =
    parseIsoDurationToMs(config?.claimTiming?.staleAge) ??
    DEFAULT_CLAIM_STALE_AGE_MS;
  return {
    markerPrefix,
    trustedMarkerActors: trusted.actors,
    autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled,
    claimStaleAgeMs,
  };
}
/**
 * Walk `argv` and return every occurrence of the given long-flag literals
 * (e.g. `--candidate`, `--candidates`) in argv order, tagged with which
 * flag matched and its literal string value. `parseCliArgs` has already
 * thrown on anything malformed (a missing value, a flag-shaped value, an
 * unknown flag) by the time this runs, so this is a pure
 * order-reconstruction pass over already-validated input, not a second
 * parse/validation pass. Covers both the `--flag value` and `--flag=value`
 * forms Node's `util.parseArgs` itself accepts for a long option (#1450
 * review follow-up: grouping every `--candidate` occurrence before every
 * `--candidates` occurrence silently reordered interleaved input, e.g.
 * `--candidates 1,2 --candidate 3`).
 */
function collectOrderedOccurrences(argv, flagNames) {
  const occurrences = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const bareFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!flagNames.includes(bareFlag)) {
      continue;
    }
    const value =
      equalsIndex === -1 ? argv[index + 1] : token.slice(equalsIndex + 1);
    occurrences.push({ flag: bareFlag, value });
  }
  return occurrences;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    DISCOVER_SHARED_FILE_OVERLAP_FLAG_SPEC,
  );
  // parsePositiveInt keeps its existing throw-on-invalid contract and
  // message shape unchanged; only the flag-syntax parsing around it (a
  // missing/flag-shaped value, an unknown flag) is now strict. Every
  // --candidate/--candidates occurrence is now accumulated in argv order
  // (not just the last, and not grouped by flag name).
  const candidates = collectOrderedOccurrences(argv, [
    '--candidate',
    '--candidates',
  ]).flatMap((occurrence) => {
    if (occurrence.flag === '--candidate') {
      return [parsePositiveInt(occurrence.value, '--candidate')];
    }
    return occurrence.value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((trimmed) => parsePositiveInt(trimmed, '--candidates'));
  });
  return {
    candidates,
    owner: values.owner,
    repo: values.repo,
    policy: values.policy,
    manifest: values.manifest,
    bundles:
      values.bundles === undefined
        ? null
        : String(values.bundles)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    checkOverlap: values['check-overlap'],
    now: values.now,
    help,
  };
}
function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value ?? ''}`);
  }
  return parsed;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-shared-file-overlap.mjs --candidate <number> [--candidate <number> ...] [--candidates <n1,n2>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--manifest <path>] [--bundles <id1,id2,...>] [--check-overlap] [--now <ISO8601>] [--help]

Reports, per candidate, the high-contention shared files it would touch (from
its '## Candidate files' section) and — with --check-overlap — whether any
overlap an actively-claimed or open-PR issue. recommendedOrder applies the soft
A4 Step 2 de-prioritization tie-breaker (score desc, then non-overlapping
first within a score band, then issue number); it does NOT apply
discover.selectionDesync — the agent layers the overlap nudge after its own
desync pick. Evidence-only: never a hard gate.

Without --check-overlap no active-set discovery runs (no extra GitHub API
cost); each candidate's high-contention files are still reported.

--check-overlap coverage (best-effort, no repo-wide comment scan): open-PR
overlap scans open PRs (bounded by the gh pr list page cap). Active-claim
overlap scans the issues that have a remote issue/<n>-* branch (every IDD claim
creates one once pushed), paginated to the end and resolved with the configured
claim stale age, so a non-stale claim held by another session is detected even
when it is outside the unclaimed candidate set being ranked. A claim whose
branch is not yet pushed is picked up once it appears remotely.
`);
}
