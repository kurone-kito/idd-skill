// idd-generated-from: src/scripts/helper-flag-drift.mts
//
// The scripts/helper-flag-drift.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
const FLAG_TOKEN_PATTERN = /--[a-z][a-z0-9-]*/g;
// Matches a fenced-block line that invokes a helper by its repo-relative
// path, e.g. `node scripts/post-idd-marker.mjs --type watermark --apply`.
// Deliberately anchored to the literal `scripts/` prefix and `.mjs`
// extension -- a `.mts` source is never directly invoked, and a
// placeholder like `node scripts/<helper-name>.mjs` (angle brackets) does
// not match the path character class, so generic template lines are
// skipped rather than mistaken for a real worked example.
const NODE_INVOCATION_LINE_PATTERN = /\bnode\s+(scripts\/[\w./-]+\.mjs)\b(.*)$/;
const FENCE_OPEN_PATTERN = /^\s*(`{3,})/;
const FENCE_CLOSE_ONLY_PATTERN = /^\s*(`{3,})\s*$/;
/**
 * Extract every backtick-fenced code block in `text` as its own array of
 * lines (fence delimiter lines excluded), preserving block boundaries so a
 * shell line-continuation join never bridges two unrelated fences.
 *
 * Fence length is tracked per CommonMark: a fence opened with N backticks
 * is closed only by a later line consisting of nothing but M >= N
 * backticks (optional surrounding whitespace); anything shorter, or
 * carrying extra content, is literal fence *content*. This matters
 * concretely in this corpus -- some onboarding templates wrap an
 * illustrative issue body in a four-backtick fence that itself contains a
 * genuine ` ```sh ` worked example (e.g.
 * `idd-template/docs/onboarding/issue-mediated-bootstrap.md`). A
 * length-agnostic toggle (as `extractHeadingSlugs` in
 * markdown-link-audit.mts deliberately accepts, since a missed heading
 * there only widens tolerance) would treat the inner ` ```sh `/` ``` `
 * pair as closing and reopening the outer fence, both scrambling
 * everything after it and skipping that worked example entirely -- a
 * false negative this checker's whole purpose is to avoid. Tilde fences
 * are out of scope, matching the same precedent: none appear anywhere in
 * the corpus scanned here.
 */
export function extractFencedBlocks(text) {
  const blocks = [];
  let current = null;
  let fenceLength = 0;
  for (const line of text.split(/\r?\n/)) {
    if (current === null) {
      const openMatch = FENCE_OPEN_PATTERN.exec(line);
      if (openMatch) {
        current = [];
        fenceLength = openMatch[1].length;
      }
      continue;
    }
    const closeMatch = FENCE_CLOSE_ONLY_PATTERN.exec(line);
    if (closeMatch && closeMatch[1].length >= fenceLength) {
      blocks.push(current);
      current = null;
      continue;
    }
    current.push(line);
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}
/**
 * Extract every line that falls inside a triple-backtick fenced code block
 * in `text`, across every block, in document order.
 */
export function extractFencedLines(text) {
  return extractFencedBlocks(text).flat();
}
/** Every distinct `--flag` token appearing anywhere in `text`. */
export function extractFlagTokens(text) {
  return new Set(
    [...text.matchAll(FLAG_TOKEN_PATTERN)].map((match) => match[0]),
  );
}
/**
 * Join a trailing `\` shell line-continuation within one fenced block into
 * a single logical line, so a worked example wrapped across several lines
 * (common throughout this repo's instructions) is read as one command
 * instead of losing every flag after the first wrapped line.
 */
function joinLineContinuations(block) {
  const logicalLines = [];
  let buffer = '';
  for (const rawLine of block) {
    const trimmedEnd = rawLine.replace(/\s+$/, '');
    if (trimmedEnd.endsWith('\\')) {
      buffer += `${trimmedEnd.slice(0, -1)} `;
      continue;
    }
    buffer += rawLine;
    logicalLines.push(buffer);
    buffer = '';
  }
  if (buffer) {
    // A trailing continuation with no following line -- keep whatever was
    // accumulated rather than silently dropping it.
    logicalLines.push(buffer);
  }
  return logicalLines;
}
/**
 * Scan every source for fenced `node scripts/<helper>.mjs ...` invocation
 * lines (continuation-joined, see `joinLineContinuations`) and collect the
 * distinct `--flag` tokens documented per helper, each paired with the
 * first doc file it was seen in (first-seen only -- this drives an
 * actionable error message, not exhaustive provenance).
 */
export function collectDocumentedHelperInvocationFlags(sources) {
  const byHelper = new Map();
  for (const source of sources) {
    for (const block of extractFencedBlocks(source.text)) {
      for (const line of joinLineContinuations(block)) {
        const match = NODE_INVOCATION_LINE_PATTERN.exec(line);
        if (!match) {
          continue;
        }
        const helperPath = match[1];
        // A path-alias / traversal segment (`scripts/../bin/x.mjs`) is
        // never a genuine worked example -- docs/permissions.md
        // deliberately shows one to illustrate a Bash-permission
        // prefix-matching gap. Skip it rather than resolve and flag a
        // path nobody intends to invoke this way.
        if (helperPath.includes('..')) {
          continue;
        }
        const argsText = match[2];
        let flagsForHelper = byHelper.get(helperPath);
        if (!flagsForHelper) {
          flagsForHelper = new Map();
          byHelper.set(helperPath, flagsForHelper);
        }
        for (const flagMatch of argsText.matchAll(FLAG_TOKEN_PATTERN)) {
          if (!flagsForHelper.has(flagMatch[0])) {
            flagsForHelper.set(flagMatch[0], source.path);
          }
        }
      }
    }
  }
  return [...byHelper.entries()]
    .map(([helperPath, flags]) => ({
      helperPath,
      flags: [...flags.entries()]
        .map(([flag, docPath]) => ({ flag, docPath }))
        .sort((left, right) => left.flag.localeCompare(right.flag)),
    }))
    .sort((left, right) => left.helperPath.localeCompare(right.helperPath));
}
/**
 * Diff each helper's documented flags against its actual `--help` output
 * (via `probe`, injected so this stays pure). A helper whose probed output
 * carries zero recognizable `--flag` tokens is treated as an unverifiable
 * CLI (e.g. an interactive-only tool with no flag-driven `--help`) and is
 * skipped entirely, rather than flagging every one of its documented flags
 * as missing.
 */
export function collectHelperFlagDriftViolations(documented, probe) {
  const violations = [];
  for (const entry of documented) {
    const result = probe(entry.helperPath);
    if (!result.exists) {
      const firstDocPath = entry.flags[0]?.docPath ?? '(unknown doc)';
      violations.push(
        `${firstDocPath}: documents \`node ${entry.helperPath}\`, but ${entry.helperPath} does not exist in the repository`,
      );
      continue;
    }
    const actualFlags = extractFlagTokens(result.output);
    if (actualFlags.size === 0) {
      continue;
    }
    for (const { flag, docPath } of entry.flags) {
      if (!actualFlags.has(flag)) {
        violations.push(
          `${docPath}: documents \`${flag}\` for ${entry.helperPath}, but that flag does not appear in its --help output (possibly renamed or removed)`,
        );
      }
    }
  }
  return violations;
}
