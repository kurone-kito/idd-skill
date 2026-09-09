// idd-generated-from: src/scripts/triage-structural-evidence.mts
//
// The scripts/triage-structural-evidence.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
/**
 * Structural (non-lexical) evidence signal for the A4 viability gate and
 * the A4.5 suitability triage (#2767): three mechanical booleans an issue
 * body/author/edit-history can satisfy that, together, demote a specific
 * lexical false-positive `fail` to a `warn`-annotated `pass` instead of
 * outright rejecting a genuinely well-specified, trustworthy issue. Each
 * signal alone proves nothing about intent -- `verificationCommand` and
 * `candidateFilesExist` are shape checks any author (including an
 * untrusted one) can satisfy -- so the demotion always requires all
 * three together; `trustedEditor` is what actually carries the weight.
 *
 * Deliberately provider-agnostic: every function here takes already-
 * fetched primitives (body text, author login, editor logins, a trust
 * predicate) rather than fetching anything itself, so no test needs to
 * mock `gh` (per #1212's scope note) and no caller here needs to adopt
 * the provider-port abstraction. `discover-viability-gate.mts` and
 * `discover-orphan-filter.mts` (already provider-port callers) and
 * `suitability-triage.mts` (still on direct `gh` calls) each gather the
 * primitives their own way and call `evaluateStructuralEvidence`.
 */
import { parseCandidateFiles } from './discover-shared-file-overlap.mjs';

/**
 * A code span inside the `## Acceptance criteria` section naming one of
 * these runnable-verification command shapes counts as a
 * `verificationCommand` signal on its own. Deliberately narrow (the four
 * shapes the issue names) rather than "any code span" -- a broad match
 * would demote on any inline code, including a mere file path.
 */
const VERIFICATION_COMMAND_CODE_SPAN_PATTERN =
  /`(?:node --test\b[^`]*|pnpm run [^\s`]+[^`]*|npx [^\s`]+[^`]*|node scripts\/[^\s`]+\.mjs[^`]*)`/;
/** A Markdown checkbox list item: `- [ ]` / `- [x]` / `* [X]`. */
const CHECKBOX_ITEM_PATTERN = /^\s*[-*+]\s+\[[ xX]\]/gm;
/**
 * ATX-heading-only section boundary, deliberately simpler than
 * `suitability-triage.mts`'s own `NEXT_HEADING_PATTERN` (which also
 * recognizes Setext headings and has accumulated several precision
 * fixes). Reusing that constant would create a circular import --
 * `suitability-triage.mts` imports this module for the demotion wiring.
 * This is an advisory pre-check, not a precision-critical gate: a missed
 * Setext boundary only means this function fails to find the section (no
 * demotion, identical to today's behavior), never a false demotion, so
 * the simpler regex is an accepted, deliberate trade-off.
 */
const NEXT_ATX_HEADING_PATTERN = /\n {0,3}#{1,6}\s/;
/** Matches the `## Acceptance criteria` heading (any ATX level, any of
 * the two capitalization conventions used across this repository's own
 * issues) on its own line. */
const ACCEPTANCE_CRITERIA_HEADING_PATTERN =
  /^#{1,6}[ \t]*Acceptance\s+[Cc]riteria[ \t]*$/im;
/** Extract the raw text of the named ATX section (heading line excluded,
 * bounded by the next ATX heading or end of body). Returns `''` when the
 * heading is absent. */
function extractSectionText(body, headingPattern) {
  const match = body.match(headingPattern);
  if (!match) {
    return '';
  }
  const start = (match.index ?? 0) + (match[0]?.length ?? 0);
  const rest = body.slice(start);
  const nextHeadingIndex = rest.search(NEXT_ATX_HEADING_PATTERN);
  return nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
}
/**
 * `verificationCommand` signal (#2767): the `## Acceptance criteria`
 * section contains at least one code span matching `node --test`,
 * `pnpm run <script>`, `npx <tool>`, or `node scripts/<name>.mjs`, OR at
 * least two checkbox items. Returns `false` when the section is absent.
 */
export function hasVerificationCommandSignal(body) {
  const section = extractSectionText(
    String(body ?? ''),
    ACCEPTANCE_CRITERIA_HEADING_PATTERN,
  );
  if (section.length === 0) {
    return false;
  }
  if (VERIFICATION_COMMAND_CODE_SPAN_PATTERN.test(section)) {
    return true;
  }
  const checkboxCount = [...section.matchAll(CHECKBOX_ITEM_PATTERN)].length;
  return checkboxCount >= 2;
}
/**
 * A bare `*.instructions.md` reference is exactly what
 * `parseCandidateFiles`'s own `normalizeContentionPath` collapses an
 * `idd-template/.github/instructions/<name>` (or
 * `.github/instructions/<name>`) path down to, for its own contention-key
 * purpose -- correct there, but never a real filesystem path from repo
 * root. This is the one shape `candidateFilesExistOnDisk` resolves
 * specially before giving up on a path.
 */
function candidatePathVariants(rawPath) {
  const variants = [rawPath];
  if (/\.instructions\.md$/i.test(rawPath) && !rawPath.includes('/')) {
    variants.push(`.github/instructions/${rawPath}`);
    variants.push(`idd-template/.github/instructions/${rawPath}`);
  }
  return variants;
}
/**
 * `candidateFilesExist` signal (#2767): the `## Candidate files` section
 * (parsed with `discover-shared-file-overlap.mts`'s own
 * `parseCandidateFiles` -- the same backtick-path extraction the issue
 * asks to reuse) lists at least one path that exists in the working
 * tree, resolved against `repoRoot` (default `process.cwd()`).
 */
export function candidateFilesExistOnDisk(
  body,
  existsAt,
  repoRoot = process.cwd(),
) {
  const paths = parseCandidateFiles(body);
  return paths.some((path) =>
    candidatePathVariants(path).some((variant) =>
      existsAt(resolveRepoPath(repoRoot, variant)),
    ),
  );
}
/** Minimal path join avoiding a hard `node:path` dependency for this one
 * call site's simple case (no `..`/`.` segments to resolve -- every
 * candidate-file path is already relative and forward-slashed). */
function resolveRepoPath(repoRoot, relativePath) {
  if (/^([a-zA-Z]:)?[/\\]/.test(relativePath)) {
    return relativePath;
  }
  return `${repoRoot.replace(/[/\\]+$/, '')}/${relativePath}`;
}
/**
 * `trustedEditor` signal (#2767): the issue author AND every editor
 * GraphQL `Issue.userContentEdits` records (deduplicated) must each pass
 * `isTrustedLogin`. A `null` editor login (a deleted/ghost account) fails
 * closed -- it can never pass `isTrustedLogin`, whatever that predicate
 * does, since `isTrustedLogin` only ever receives a real login string
 * here. An empty `editorLogins` array (never edited) means only the
 * author needs to pass.
 */
export function isTrustedEditorSignal(author, editorLogins, isTrustedLogin) {
  const normalizedAuthor = String(author ?? '')
    .trim()
    .toLowerCase();
  if (normalizedAuthor.length === 0) {
    return false;
  }
  const logins = new Set([normalizedAuthor]);
  for (const editorLogin of editorLogins) {
    if (typeof editorLogin !== 'string' || editorLogin.trim().length === 0) {
      // A null/ghost editor login can never be trusted -- fail closed
      // immediately rather than folding it into the set as an unmatched
      // key that `isTrustedLogin` never sees.
      return false;
    }
    logins.add(editorLogin.trim().toLowerCase());
  }
  return [...logins].every((login) => isTrustedLogin(login));
}
/** Build a `trustedLogin` predicate from a static allow-list plus a
 * collaborator-permission-based fallback, checking the cheap static list
 * first. Callers pass their own `collaboratorPermission`-backed
 * predicate (see `collaborator-permission.mts`) so this module never
 * imports the live `gh`-calling helper directly. */
export function buildTrustedLoginPredicate(
  trustedMarkerLogins,
  isTrustedCollaborator,
) {
  const staticLogins = new Set(
    trustedMarkerLogins.map((login) => login.trim().toLowerCase()),
  );
  return (login) => {
    const normalized = login.trim().toLowerCase();
    return staticLogins.has(normalized) || isTrustedCollaborator(normalized);
  };
}
/** `true` only when all three signals hold. */
export function hasAllStructuralSignals(evidence) {
  return Boolean(
    evidence?.verificationCommand &&
      evidence.candidateFilesExist &&
      evidence.trustedEditor,
  );
}
/** Compute all three signals in one call. */
export function evaluateStructuralEvidence(input) {
  return {
    verificationCommand: hasVerificationCommandSignal(input.body),
    candidateFilesExist: candidateFilesExistOnDisk(
      input.body,
      input.existsAt,
      input.repoRoot,
    ),
    trustedEditor: isTrustedEditorSignal(
      input.author,
      input.editorLogins,
      input.isTrustedLogin,
    ),
  };
}
