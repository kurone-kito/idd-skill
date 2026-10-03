#!/usr/bin/env node
// idd-generated-from: src/scripts/repository-policy-audit.mts
//
// Deterministic repository-policy checks extracted from runtime test suites.
// Keep evaluators over supplied file snapshots separate from the thin reader
// and CLI so regression fixtures need neither GitHub nor installed packages.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ADVISORY_CONVERGENCE_CHECK_SELECTOR } from './advisory-convergence.mts';
import { MARKER_HIDE_POLICY, OPERATIONAL_MARKERS } from './marker-helpers.mts';
import {
  normalizePolicyConfig,
  resolveEffectiveCritiqueLoopTelemetryHook,
} from './policy-helpers.mts';
import { PR_OPERATIONAL_COMMENT_PREFIXES } from './protocol-helpers.mts';
import { validate } from './validate-schemas.mts';

export type RepositoryPolicyDocuments = ReadonlyMap<string, string>;

interface RuleContext {
  text(path: string): string;
  json(path: string): unknown;
}

interface RuleDefinition {
  id: string;
  paths: readonly string[];
  check(context: RuleContext): void;
}

interface RawPolicyConfig extends Record<string, unknown> {
  githubApi?: { loadControl?: unknown };
}

class RuleFailure extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
    this.name = 'RuleFailure';
  }
}

const SUITABILITY = '.github/instructions/idd-suitability.instructions.md';
const DISCOVER = '.github/instructions/idd-discover.instructions.md';
const TEMPLATE_DISCOVER =
  'idd-template/.github/instructions/idd-discover.instructions.md';
const WORKFLOW = 'docs/idd-workflow.md';
const TEMPLATE_WORKFLOW = 'idd-template/docs/idd-workflow.md';
const REVIEW_TRIAGE =
  'idd-template/.github/instructions/idd-review-triage.instructions.md';
const LIVE_REVIEW_TRIAGE =
  '.github/instructions/idd-review-triage.instructions.md';
const MERGE = 'idd-template/.github/instructions/idd-merge.instructions.md';
const LIVE_MERGE = '.github/instructions/idd-merge.instructions.md';
const RESUME_DETAIL = 'idd-template/docs/idd-resume-detail.md';
const WORK = 'idd-template/.github/instructions/idd-work.instructions.md';
const PR_SUBMIT =
  'idd-template/.github/instructions/idd-pr-submit.instructions.md';
const REVIEW_FIX =
  'idd-template/.github/instructions/idd-review-fix.instructions.md';
const CI = 'idd-template/.github/instructions/idd-ci.instructions.md';
const AUTONOMY = 'docs/idd-autonomy-contract.md';
const TEMPLATE_AUTONOMY = 'idd-template/docs/idd-autonomy-contract.md';
const HELPER_DOC = 'docs/idd-helper-scripts.md';
const TEMPLATE_HELPER_DOC = 'idd-template/docs/idd-helper-scripts.md';
const COMMENT_MINIMIZATION = 'idd-template/docs/idd-comment-minimization.md';
const POST_MARKER_GUIDANCE =
  'idd-template/.github/instructions/idd-review-snapshot.instructions.md';
const TEMPLATE_POST_MARKER_HELPER = 'idd-template/docs/idd-helper-scripts.md';
const STANDARD_REVIEW_SNAPSHOT =
  'idd-template/.github/instructions/idd-review-snapshot.instructions.md';
const LITE_REVIEW_SNAPSHOT =
  'idd-template/.github/instructions/lite/idd-review-snapshot-lite.instructions.md';
const ADVISORY_FALLBACK =
  'idd-template/docs/idd-advisory-wait-shell-fallback.md';
const POLICY_SCHEMA = 'schemas/policy.schema.json';
const A45_FIXTURES = 'tests/fixtures/consistency/a45-outcomes.json';
const ROADMAP_AUDIT = '.github/instructions/idd-roadmap-audit.instructions.md';
const CUSTOMIZATION = 'docs/customization.md';
const PACKAGE_JSON = 'package.json';
const REPO_CONFIG = '.github/idd/config.json';
const TEMPLATE_CONFIG = 'idd-template/.github/idd/config.json';
const F2_FILES = [
  'idd-template/.github/instructions/idd-pre-merge.instructions.md',
  '.github/instructions/idd-pre-merge.instructions.md',
] as const;
const F3_FILES = [MERGE, LIVE_MERGE] as const;

const NO_MAIN_MENTIONS_ALLOWED = new Set<string>();
const REVIEW_TRIAGE_ALLOWED_MAIN_LINES = new Set([
  '[design rationale](../../docs/idd-design-rationale.md#merge-main-livelock-under-fast-moving-main)).',
]);
const B1_TRUSTED_CHECKOUT_MAIN_LINES = new Set([
  '1. Ensure the local `main` branch is up to date and has no local',
  'commits. Run this from the primary worktree while on `main`:',
  'git log origin/main..main --oneline',
  'If the second command outputs any lines, local `main` has unpushed',
  'commits — stop and report, do not force-reset `main`. Otherwise,',
  'git merge --ff-only origin/main',
  'After this `main` fast-forward, do **not** change the primary',
  "worktree's HEAD off `main` for any reason during B1 — see",
  "The primary worktree's HEAD MUST remain on `main` throughout B1; if it",
  'ever leaves `main`, stop immediately and follow the B1 self-check',
  '`main`.',
  '`main` baseline — verify with a fresh-vs-stale `node_modules` comparison',
]);

function fail(path: string, message: string): never {
  throw new RuleFailure(path, message);
}

function requirePattern(
  path: string,
  text: string,
  pattern: RegExp,
  description: string,
): void {
  if (!pattern.test(text)) fail(path, `missing ${description}`);
}

function requirePhrases(
  path: string,
  text: string,
  phrases: readonly string[],
): void {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) {
      fail(path, `missing required clause: ${phrase}`);
    }
  }
}

function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function findBareMainLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /\bmain\b/.test(line))
    .map((line) => line.trim());
}

function findUnallowedMainLines(
  text: string,
  allowed: ReadonlySet<string>,
): string[] {
  return findBareMainLines(text).filter((line) => !allowed.has(line));
}

function extractCheckOutcomes(text: string): Map<string, string> {
  const entries = [
    ...text.matchAll(
      /^### Check \d+: ([^\n]+)\n[\s\S]*?^- \*\*Outcome on fail\*\*: `([^`]+)`$/gm,
    ),
  ];
  return new Map(
    entries.map(([, heading, outcome]) => [heading.trim(), outcome]),
  );
}

function extractOutcomeTable(text: string): Map<string, string> {
  const sectionMatch = text.match(
    /## Failure Outcomes[\s\S]*?\n\| Outcome[\s\S]*?\n((?:\|[^\n]+\n)+)/,
  );
  const rows = (sectionMatch?.[1] ?? '')
    .split(/\r?\n/)
    .filter((row) => row.startsWith('| `'));
  return new Map(
    rows.map((row) => {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return [cells[0].replaceAll('`', ''), cells[2]];
    }),
  );
}

function extractBulletListLabels(
  markdown: string,
  anchorPhrase: string,
): string[] {
  const anchorIndex = markdown.indexOf(anchorPhrase);
  if (anchorIndex === -1)
    throw new Error(`missing section anchor: ${anchorPhrase}`);
  const labels: string[] = [];
  let inList = false;
  for (const line of markdown.slice(anchorIndex).split('\n')) {
    const bulletMatch = /^-\s+`([^`]+)`/.exec(line);
    if (bulletMatch) {
      inList = true;
      labels.push(bulletMatch[1]);
      continue;
    }
    if (!inList) continue;
    if (line.trim() === '') break;
    const continuationMatch = /^\s+`([^`]+)`/.exec(line);
    if (continuationMatch) labels.push(continuationMatch[1]);
  }
  return labels;
}

function extractPrefixTokens(section: string): string[] {
  return [...section.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((span) => span.endsWith(':'));
}

function sameSet<T>(actual: ReadonlySet<T>, expected: ReadonlySet<T>): boolean {
  return (
    actual.size === expected.size &&
    [...expected].every((value) => actual.has(value))
  );
}

function isEmpty<T>(values: readonly T[]): boolean {
  return values.length === 0;
}

function evaluateCandidatePolicy(path: string, text: string): void {
  const sectionStart = text.indexOf('## Candidate Rules');
  if (sectionStart === -1) fail(path, 'missing "## Candidate Rules" section');
  const nextHeadingIndex = text.indexOf('\n## ', sectionStart + 1);
  const section = text.slice(
    sectionStart,
    nextHeadingIndex === -1 ? undefined : nextHeadingIndex,
  );
  let candidates: string[];
  let excluded: string[];
  try {
    candidates = extractBulletListLabels(section, 'Candidate prefixes are:');
    excluded = extractBulletListLabels(section, 'Excluded from this list');
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
  if (new Set(candidates).size !== candidates.length) {
    fail(path, 'candidate prefix list contains duplicates');
  }
  if (new Set(excluded).size !== excluded.length) {
    fail(path, 'excluded prefix list contains duplicates');
  }
  const labels = OPERATIONAL_MARKERS.map((marker) => marker.label);
  const expectedCandidates = new Set(
    labels.filter(
      (label) => MARKER_HIDE_POLICY.get(label)?.policy !== 'excluded',
    ),
  );
  const expectedExcluded = new Set(
    labels.filter(
      (label) => MARKER_HIDE_POLICY.get(label)?.policy === 'excluded',
    ),
  );
  if (!sameSet(new Set(candidates), expectedCandidates)) {
    fail(
      path,
      'candidate list must name every non-excluded marker exactly once',
    );
  }
  if (!sameSet(new Set(excluded), expectedExcluded)) {
    fail(path, 'excluded note must name every excluded marker exactly once');
  }
}

function checkOperationalExclusions(
  path: string,
  text: string,
  anchor: string,
): void {
  const start = text.indexOf(anchor);
  if (start === -1) fail(path, 'missing E1 exclusion section');
  const end = text.indexOf('Never exclude an untrusted-author', start);
  if (end === -1) fail(path, 'missing exclusion list boundary');
  const found = extractPrefixTokens(text.slice(start, end)).sort();
  const expected = [...PR_OPERATIONAL_COMMENT_PREFIXES].sort();
  if (expected.length === 0)
    fail(path, 'operational-comment prefix inventory is empty');
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    fail(path, 'E1 exclusions differ from PR_OPERATIONAL_COMMENT_PREFIXES');
  }
}

function extractBoundedRegion(
  content: string,
  start: string,
  end: string,
  path: string,
): string {
  const startIndex = content.indexOf(start);
  assert.notEqual(
    startIndex,
    -1,
    `missing start marker ${JSON.stringify(start)} in ${path}`,
  );
  const afterStart = content.slice(startIndex + start.length);
  const endIndex = afterStart.indexOf(end);
  assert.notEqual(
    endIndex,
    -1,
    `missing end marker ${JSON.stringify(end)} after ${JSON.stringify(start)} in ${path}`,
  );
  return afterStart.slice(0, endIndex);
}

const RULES: readonly RuleDefinition[] = [
  {
    id: 'helper-runtime-docs',
    paths: [HELPER_DOC],
    check({ text }) {
      const path = HELPER_DOC;
      const live = text(path);
      requirePhrases(path, live, [
        'discover-roadmap-graph.mjs',
        'Discover Roadmap Graph Contract',
        'discover-viability-gate.mjs',
        'suitability-triage.mjs',
      ]);
    },
  },
  {
    id: 'marker-candidate-list',
    paths: [COMMENT_MINIMIZATION],
    check({ text }) {
      evaluateCandidatePolicy(COMMENT_MINIMIZATION, text(COMMENT_MINIMIZATION));
    },
  },
  {
    id: 'operational-comment-prefixes',
    paths: [STANDARD_REVIEW_SNAPSHOT, LITE_REVIEW_SNAPSHOT],
    check({ text }) {
      checkOperationalExclusions(
        STANDARD_REVIEW_SNAPSHOT,
        text(STANDARD_REVIEW_SNAPSHOT),
        'Exclude **trusted agent operational comments**',
      );
      checkOperationalExclusions(
        LITE_REVIEW_SNAPSHOT,
        text(LITE_REVIEW_SNAPSHOT),
        '4. From that raw set, exclude trusted-agent operational marker comments',
      );
    },
  },
  {
    id: 'urgency-matrix-doc',
    paths: [REVIEW_TRIAGE],
    check({ text }) {
      const path = REVIEW_TRIAGE;
      const contents = collapsed(text(path));
      requirePhrases(path, contents, [
        'instead of normal judgment',
        'defect in shipped behavior — code, helper output, CI result, or instruction text that changes what an agent does',
        'excluding wording/clarity polish and extra test coverage for already-working behavior',
        'Judge validity and E4 severity (a false claim is Rejected)',
        "the fix's marginal review-wave cost",
        'never override.',
        'wording/formatting changing no behavior',
        'extra tests, comments, or naming for already-correct behavior',
        'a correctness risk short of `high`',
        'an adopt-now (a)-(c) condition',
        '`very-low` < `low` < `medium` < `high`',
        'High defers only at `very-low`',
        'Medium or unknown, not at `high`',
        'the floor only raises',
        'Unscored urgency never defers',
        'null urgency still defers',
        'unknown severity never defers in these modes',
        'counts as Medium',
        'never PATH B',
        'CODEOWNER/required-reviewer item',
        'Accept forced does not win',
        'High never eligible',
        'a missing, failed, or incomplete fetch fails closed',
        'every scored urgency',
        'review-fix-loop-cutoff',
        '(a)-(c)',
      ]);
    },
  },
  {
    id: 'post-marker-outcomes',
    paths: [POST_MARKER_GUIDANCE, TEMPLATE_POST_MARKER_HELPER],
    check({ text }) {
      const step2 = collapsed(text(POST_MARKER_GUIDANCE));
      requirePhrases(POST_MARKER_GUIDANCE, step2, [
        '--prior-head-sha {head-SHA} --prior-total-item-count {total-item-count} --prior-max-activity-at {max-activity-updatedAt}',
        'operationLocal.decision: refuse',
        '`same-head-activity`: new undispositioned or uncovered',
        'exits 1, posting nothing',
        '`decision: defer` exits 0 (`mode: "dry-run"`), posting nothing',
        'skip the after-posting steps',
      ]);
      const helper = collapsed(text(TEMPLATE_POST_MARKER_HELPER));
      requirePhrases(TEMPLATE_POST_MARKER_HELPER, helper, [
        "`--operation-local` outcomes: `--apply` does not say which run happened, so read the envelope's `operationLocal.decision`.",
        '`defer` (required checks not passing) exits `0`, prints `mode: "dry-run"`, and posts nothing',
        '`refuse` (`same-head-activity`, a moved HEAD, or a CI-completion mismatch) exits `1`, posts nothing, and prints the same envelope on stdout',
        'The `--prior-*` guard is evaluated before the defer',
      ]);
      const row = text(TEMPLATE_POST_MARKER_HELPER)
        .split('\n')
        .find((line) => line.startsWith('| `post-idd-marker.mjs`'));
      if (!row)
        fail(TEMPLATE_POST_MARKER_HELPER, 'missing post-idd-marker helper row');
      const gateCell = row.split('|')[4] ?? '';
      requirePhrases(TEMPLATE_POST_MARKER_HELPER, gateCell, [
        '--operation-local',
        '`refuse` decision',
        'exits `1` and prints the envelope on stdout',
        '`defer` (required checks not passing) exits `0`',
      ]);
    },
  },
  {
    id: 'advisory-fallback-order',
    paths: [ADVISORY_FALLBACK],
    check({ text }) {
      const path = ADVISORY_FALLBACK;
      const fallback = text(path);
      const botMutation = fallback.indexOf(
        'requestReviews(input:{pullRequestId:$id,botIds:$reviewer,union:true})',
      );
      const userMutation = fallback.indexOf(
        'requestReviews(input:{pullRequestId:$id,userIds:$reviewer,union:true})',
      );
      const marker = fallback.indexOf(
        'node scripts/post-idd-marker.mjs --type advisory-recovery',
      );
      assert.ok(
        botMutation > 0 && userMutation > botMutation && marker > userMutation,
      );
      requirePhrases(path, fallback, [
        'requestedReviewer{__typename',
        'variables:{id:$id,reviewer:[$reviewer]}',
        'botIds:$reviewer',
        'userIds:$reviewer',
        'gh api graphql --input -',
        'type == "user" and $l == $configured',
        'registration_attempt aw3-s',
        'command -v registration_attempt',
        'AW3-S registration returned an unexpected status',
        'NODES_AFTER=$(request_nodes) || return 2',
        '<profile-selected-post-idd-marker-command> --type advisory',
        'claim_revalidate || return 3',
      ]);
      requirePattern(
        path,
        fallback,
        /REVIEWER_TYPE=.*ascii_downcase/,
        'reviewer type normalization',
      );
      requirePattern(
        path,
        fallback,
        /registration_check\(\)[\s\S]*?max_attempts=3/,
        'bounded AW3-S registration check',
      );
      requirePattern(
        path,
        fallback,
        /AW3S_ENTRY.*pending|non-pending/,
        'AW3-S pending state',
      );
      requirePattern(
        path,
        fallback,
        /if \[ "\$AW3S_ENTRY" = "pending" \][\s\S]*?--remove-reviewer/,
        'pending reviewer removal',
      );
      requirePattern(
        path,
        fallback,
        /case "\$REGISTRATION_STATUS"[\s\S]*?2\)[\s\S]*?exit 2/,
        'unexpected registration status failure',
      );
      requirePattern(
        path,
        fallback,
        /if \[ "\$evidence_mode" = "aw3-s" \][\s\S]*?\[ "\$EVENT_NEW" = true \][\s\S]*?else/,
        'AW3-S event evidence split',
      );
      requirePattern(
        path,
        fallback,
        /NODES_BEFORE=\n\s*if \[ "\$evidence_mode" != "aw3-s" \]/,
        'pre-request node snapshot',
      );
      requirePattern(
        path,
        fallback,
        /\[ "\$EVENT_NEW" = true \] && return 0[\s\S]*NODES_AFTER=\$\(request_nodes\)/,
        'event evidence precedes node reread',
      );
      requirePattern(
        path,
        fallback,
        /claim_revalidate \|\| return 3[\s\S]*?return 0/,
        'claim revalidation before success',
      );
      if (
        /if \[ "\$evidence_mode" = "aw3-s" \][\s\S]*?then\s+\[ "\$EVENT_NEW" = true \]\s+\|\|/.test(
          fallback,
        )
      ) {
        fail(
          path,
          'AW3-S evidence must not use the unsafe conditional fallback',
        );
      }
      if (
        /REGISTRATION_STATUS[\s\S]*?node scripts\/post-idd-marker\.mjs --type advisory --target pr/.test(
          fallback,
        )
      ) {
        fail(
          path,
          'registration status must not directly trigger the marker helper',
        );
      }
      if (fallback.includes("IFS=$'\\t'"))
        fail(path, 'tab IFS workaround regressed');
    },
  },
  {
    id: 'shadow-path-guidance',
    paths: [...F2_FILES, ...F3_FILES],
    check(context) {
      if (isEmpty(F2_FILES) || isEmpty(F3_FILES)) {
        fail(MERGE, 'F2/F3 pipeline inventory is empty');
      }
      for (const path of F2_FILES) {
        const contents = collapsed(context.text(path));
        const pipelines = [
          ...contents.matchAll(/`(git ls-tree -r -z [^`]*)`/g),
        ];
        if (pipelines.length !== 1)
          fail(path, 'must have exactly one F2 pipeline');
        requirePattern(
          path,
          contents,
          /Under `set -o pipefail`, run `git ls-tree -r -z /,
          'F2 shadow-path command',
        );
        requirePattern(
          path,
          contents,
          /and again with `-o -i`; any output or failure holds\./,
          'ignored-path F2 variant',
        );
        if (
          /xargs(?=\s)[^`]*?\s-[A-Za-z0-9]*r\b|xargs[^`]*--no-run-if-empty/.test(
            contents,
          )
        )
          fail(path, 'unsafe xargs pipeline returned');
        if (contents.includes('for paths in'))
          fail(path, 'per-path loop returned');
        if (contents.includes(':(top)'))
          fail(path, 'top-level pathspec returned');
      }
      for (const path of F3_FILES) {
        const contents = collapsed(context.text(path));
        requirePattern(
          path,
          contents,
          /Run F2's shadow-path check against `\$\{PR_HEAD_SHA_F3\}`; any output or failure holds\./,
          'F3 shared shadow-path check',
        );
        if (contents.includes('for paths in'))
          fail(path, 'per-path loop returned');
        if (contents.includes(':(top)'))
          fail(path, 'top-level pathspec returned');
      }
    },
  },
  {
    id: 'a45-outcome-fixtures',
    paths: [SUITABILITY, A45_FIXTURES],
    check({ text, json }) {
      const checks = extractCheckOutcomes(text(SUITABILITY));
      const outcomes = extractOutcomeTable(text(SUITABILITY));
      const fixtures = json(A45_FIXTURES);
      if (!Array.isArray(fixtures)) fail(A45_FIXTURES, 'expected an array');
      const seen = new Set<string>();
      for (const [index, value] of fixtures.entries()) {
        if (typeof value !== 'object' || value === null) {
          fail(A45_FIXTURES, `fixture ${index} must be an object`);
        }
        const fixture = value as Record<string, unknown>;
        if (
          typeof fixture.id !== 'string' ||
          typeof fixture.failedCheck !== 'string' ||
          typeof fixture.expectedOutcome !== 'string'
        ) {
          fail(A45_FIXTURES, `fixture ${index} is missing string fields`);
        }
        if (checks.get(fixture.failedCheck) !== fixture.expectedOutcome) {
          fail(SUITABILITY, `${fixture.id}: check-to-outcome mapping drifted`);
        }
        if (!outcomes.has(fixture.expectedOutcome)) {
          fail(SUITABILITY, `${fixture.id}: outcome is absent from the table`);
        }
        seen.add(fixture.expectedOutcome);
      }
      if (
        JSON.stringify([...seen].sort()) !==
        JSON.stringify([
          'blocked-by-human',
          'duplicate',
          'invalid',
          'needs-decision',
          'out-of-scope',
          'unclear',
        ])
      )
        fail(A45_FIXTURES, 'fixture outcome inventory changed');
      requirePattern(
        SUITABILITY,
        outcomes.get('invalid') ?? '',
        /do not retry/i,
        'invalid outcome no-retry instruction',
      );
    },
  },
  {
    id: 'roadmap-node-classification',
    paths: [DISCOVER, TEMPLATE_DISCOVER, WORKFLOW, TEMPLATE_WORKFLOW],
    check({ text }) {
      for (const path of [DISCOVER, TEMPLATE_DISCOVER]) {
        requirePattern(
          path,
          text(path),
          /roadmap node/i,
          'roadmap node classification',
        );
        requirePattern(
          path,
          text(path),
          /execution leaf/i,
          'execution leaf definition',
        );
        requirePattern(
          path,
          text(path),
          /only open roadmap nodes remain/i,
          'open-node exhaustion guidance',
        );
        requirePattern(
          path,
          text(path),
          /A3\/A4\/A4\.5\/A5/i,
          'roadmap phase routing',
        );
      }
      for (const path of [WORKFLOW, TEMPLATE_WORKFLOW]) {
        requirePattern(
          path,
          text(path),
          /classify roadmap/i,
          'roadmap classification entry path',
        );
      }
    },
  },
  {
    id: 'codex-critique-invocation',
    paths: [WORKFLOW, TEMPLATE_WORKFLOW],
    check({ text }) {
      const sections = [WORKFLOW, TEMPLATE_WORKFLOW].map((path) => {
        const source = text(path);
        const start = source.indexOf('## Critique pass invocation');
        if (start === -1) fail(path, 'missing critique pass section');
        const next = source.indexOf('\n## ', start + 1);
        const section = source.slice(start, next === -1 ? undefined : next);
        const codexRow = section.match(/^\| Codex CLI\s+\|([^\n]+)\|$/m)?.[1];
        if (!codexRow) fail(path, 'missing Codex critique row');
        requirePattern(
          path,
          codexRow,
          /Use one bounded read-only native subagent review when supported and suitable/,
          'bounded reviewer route',
        );
        requirePattern(
          path,
          codexRow,
          /parent waits for and collects the result/,
          'parent collection requirement',
        );
        requirePattern(
          path,
          codexRow,
          /structured self-critique/,
          'self-critique fallback',
        );
        requirePattern(
          path,
          codexRow,
          /delegation is unavailable, disabled, unsuitable, or fails/,
          'delegation fallback conditions',
        );
        if (/Self-critique: add a "review the above for issues"/.test(codexRow))
          fail(path, 'obsolete self-critique instruction returned');
        requirePattern(
          path,
          section,
          /objective diff validation floor/,
          'objective validation floor',
        );
        requirePattern(
          path,
          section,
          /This floor applies \*\*uniformly\*\* to every runtime/,
          'uniform validation floor',
        );
        requirePattern(
          path,
          section,
          /parent collects the reviewer result before\s+continuing/,
          'reviewer result ordering',
        );
        return { codexRow: codexRow.trim(), section };
      });
      if (
        sections[0].codexRow !== sections[1].codexRow ||
        sections[0].section !== sections[1].section
      ) {
        fail(TEMPLATE_WORKFLOW, 'source and template critique guidance differ');
      }
    },
  },
  {
    id: 'path-a-verify-before-accept',
    paths: [REVIEW_TRIAGE, LIVE_REVIEW_TRIAGE],
    check({ text }) {
      for (const path of [REVIEW_TRIAGE, LIVE_REVIEW_TRIAGE]) {
        const contents = text(path);
        requirePattern(
          path,
          contents,
          /Verify\s+before\s+accept/,
          'verify-before-accept rule',
        );
        requirePattern(
          path,
          contents,
          /actor-permission\s+cap/i,
          'actor permission cap',
        );
        requirePattern(
          path,
          contents,
          /collaborators\/\{username\}\/permission/,
          'permission API check',
        );
        requirePattern(
          path,
          contents,
          /assertion\s+alone\s+never\s+reaches\s+Accept\s+forced/,
          'untrusted assertion rejection',
        );
      }
    },
  },
  {
    id: 'trusted-duplicate-marker',
    paths: [MERGE, LIVE_MERGE],
    check({ text }) {
      for (const path of [MERGE, LIVE_MERGE]) {
        const contents = text(path);
        requirePattern(
          path,
          contents,
          /Duplicate-success-record\s+skip\s+rule/,
          'duplicate-success skip rule',
        );
        requirePattern(
          path,
          contents,
          /whose\s+author\s+is\s+a\s+trusted\s+marker\s+actor/,
          'trusted marker author',
        );
        requirePattern(
          path,
          contents,
          /An\s+untrusted\s+commenter's\s+marker-prefixed\s+comment\s+never\s+counts\s+as\s+evidence/,
          'untrusted marker exclusion',
        );
      }
    },
  },
  {
    id: 'operator-confirmation-merge-gate',
    paths: [AUTONOMY, TEMPLATE_AUTONOMY],
    check({ text }) {
      for (const path of [AUTONOMY, TEMPLATE_AUTONOMY]) {
        const contents = text(path);
        requirePattern(
          path,
          contents,
          /standing\s+operator\s+confirmation\s+before\s+this\s+merge\s+regardless\s+of\s+this\s+Reversible\s+classification/,
          'standing confirmation gate',
        );
        requirePattern(
          path,
          contents,
          /protects\s+reviewer\s+attention/,
          'reviewer-attention caveat',
        );
        requirePattern(
          path,
          contents,
          /not\s+against\s+data\s+loss/,
          'data-loss caveat',
        );
        requirePattern(
          path,
          contents,
          /unresolved\s+review\s+threads/,
          'unresolved-thread condition',
        );
        requirePattern(
          path,
          contents,
          /idd-review-fix-lite\.instructions\.md/,
          'lite review-fix reference',
        );
      }
    },
  },
  {
    id: 'f2-own-comment-carveout',
    paths: F2_FILES,
    check({ text }) {
      for (const path of F2_FILES) {
        const contents = text(path);
        requirePattern(
          path,
          contents,
          /own-agent-authored\s+procedural\s+or\s+status\s+comment/,
          'own agent status-comment carve-out',
        );
        requirePattern(
          path,
          contents,
          /hold\s+comment\s+explaining\s+a\s+blocker/,
          'blocker hold comment',
        );
        requirePattern(
          path,
          contents,
          /introduces\s+no\s+reviewer\s+or\s+bot\s+finding\s+of\s+its\s+own/,
          'no-finding condition',
        );
        requirePattern(
          path,
          contents,
          /triggered\s+solely\s+by\s+disposition\s+replies/,
          'sole-cause condition',
        );
      }
    },
  },
  {
    id: 'f2-third-party-advisory-carveout',
    paths: F2_FILES,
    check({ text }) {
      for (const path of F2_FILES) {
        const contents = text(path);
        requirePattern(
          path,
          contents,
          /third-party\s+advisory\s+bot's\s+own\s+skip-review\s+or\s+no-action\s+notice/,
          'third-party advisory notice carve-out',
        );
        requirePattern(
          path,
          contents,
          /no\s+reviewer\s+finding\s+or\s+actionable\s+content/,
          'no-actionable-content condition',
        );
        requirePattern(
          path,
          contents,
          /triggered\s+solely\s+by\s+that\s+notice/,
          'sole-notice cause',
        );
        requirePattern(
          path,
          contents,
          /mixed-cause\s+trigger\s+still\s+returns\s+to\s+E1\s+normally/,
          'mixed-cause return to E1',
        );
      }
    },
  },
  {
    id: 'recursive-roadmap-audit',
    paths: [ROADMAP_AUDIT, WORKFLOW, CUSTOMIZATION],
    check({ text }) {
      requirePattern(
        ROADMAP_AUDIT,
        text(ROADMAP_AUDIT),
        /nested roadmaps?/i,
        'nested roadmap coverage',
      );
      requirePattern(
        ROADMAP_AUDIT,
        text(ROADMAP_AUDIT),
        /bottom-up/i,
        'bottom-up audit order',
      );
      requirePattern(
        ROADMAP_AUDIT,
        text(ROADMAP_AUDIT),
        /exact roadmap issue being mutated/i,
        'exact mutated issue',
      );
      requirePattern(
        WORKFLOW,
        text(WORKFLOW),
        /nested roadmap/i,
        'workflow nested-roadmap entry',
      );
      requirePattern(
        WORKFLOW,
        text(WORKFLOW),
        /bottom-up/i,
        'workflow bottom-up order',
      );
      requirePattern(
        CUSTOMIZATION,
        text(CUSTOMIZATION),
        /bottom-up/i,
        'customization bottom-up order',
      );
      requirePattern(
        CUSTOMIZATION,
        text(CUSTOMIZATION),
        /exact roadmap node being mutated/i,
        'customization exact-node rule',
      );
    },
  },
  {
    id: 'package-config-version-alignment',
    paths: [PACKAGE_JSON, REPO_CONFIG, TEMPLATE_CONFIG],
    check({ json }) {
      const packageVersion = (json(PACKAGE_JSON) as Record<string, unknown>)
        .version;
      for (const path of [REPO_CONFIG, TEMPLATE_CONFIG]) {
        const iddVersion = (json(path) as Record<string, unknown>).iddVersion;
        if (packageVersion !== iddVersion)
          fail(
            path,
            `iddVersion ${String(iddVersion)} differs from package version ${String(packageVersion)}`,
          );
      }
    },
  },
  {
    id: 'advisory-waiver-dogfood-opt-in',
    paths: [REPO_CONFIG, TEMPLATE_CONFIG],
    check({ json }) {
      const repo = normalizePolicyConfig(json(REPO_CONFIG));
      const mode = repo.ciGate.externalCheckWaivers.mode;
      if (mode !== 'maintainer-authorized')
        fail(
          REPO_CONFIG,
          'maintainer-authorized waiver backstop must stay enabled',
        );
      const waivable = repo.ciGate.externalChecks.waivable;
      if (
        !Array.isArray(waivable) ||
        !waivable.some(
          (entry) =>
            entry?.selector === ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
            entry?.matchMode === 'exact',
        )
      ) {
        fail(
          REPO_CONFIG,
          `${ADVISORY_CONVERGENCE_CHECK_SELECTOR} must be registered with exact matching`,
        );
      }
      const template = normalizePolicyConfig(json(TEMPLATE_CONFIG));
      if (
        template.ciGate.externalCheckWaivers.mode !== 'disabled' ||
        template.ciGate.externalChecks.waivable.length !== 0
      ) {
        fail(
          TEMPLATE_CONFIG,
          'distributed waiver policy must remain disabled with no waivable checks',
        );
      }
    },
  },
  {
    id: 'merge-policy-dogfood-opt-in',
    paths: [REPO_CONFIG, TEMPLATE_CONFIG],
    check({ json }) {
      if (
        (json(REPO_CONFIG) as Record<string, unknown>).mergePolicy !==
        'fully_autonomous_merge'
      )
        fail(
          REPO_CONFIG,
          'local dogfood merge policy must remain fully_autonomous_merge',
        );
      if (
        (json(TEMPLATE_CONFIG) as Record<string, unknown>).mergePolicy !==
        'human_merge'
      )
        fail(
          TEMPLATE_CONFIG,
          'distributed merge policy must remain human_merge',
        );
    },
  },
  {
    id: 'critique-telemetry-dogfood-hook',
    paths: [REPO_CONFIG],
    check({ json }) {
      const resolved = resolveEffectiveCritiqueLoopTelemetryHook({
        localConfig: json(REPO_CONFIG),
      });
      if (
        resolved.status !== 'local' ||
        resolved.source !== 'repository-local' ||
        resolved.hook?.command !== 'idd-critique-telemetry'
      ) {
        fail(
          REPO_CONFIG,
          'repository-local telemetry hook must resolve to idd-critique-telemetry',
        );
      }
    },
  },
  {
    id: 'github-api-load-control-dogfood',
    paths: [REPO_CONFIG, TEMPLATE_CONFIG, POLICY_SCHEMA],
    check({ json }) {
      const repo = json(REPO_CONFIG) as RawPolicyConfig;
      const errors = validate(repo, json(POLICY_SCHEMA));
      if (errors.length > 0)
        fail(REPO_CONFIG, `policy config fails schema: ${errors.join('; ')}`);
      const actual = repo.githubApi?.loadControl;
      if (
        JSON.stringify(actual) !==
        JSON.stringify({ enabled: true, maxConcurrent: 4 })
      )
        fail(
          REPO_CONFIG,
          'measured loadControl must remain enabled at maxConcurrent 4',
        );
      const template = json(TEMPLATE_CONFIG) as Record<string, unknown>;
      if ('githubApi' in template)
        fail(
          TEMPLATE_CONFIG,
          'distributed template must omit the local githubApi entry',
        );
    },
  },
  {
    id: 'f4-dirty-worktree-hold',
    paths: [MERGE],
    check({ text }) {
      const contents = text(MERGE);
      const start = contents.indexOf(
        '4. Concurrent workers sharing one clone',
        contents.indexOf('## F4'),
      );
      const end = contents.indexOf(
        '\n5. Run from the **primary worktree**',
        start,
      );
      if (start < 0 || end <= start)
        fail(MERGE, 'F4 step 4 boundaries not found');
      const step = contents.slice(start, end);
      requirePattern(
        MERGE,
        step,
        /`primary-worktree-dirty`/,
        'dirty primary-worktree classification',
      );
      requirePattern(
        MERGE,
        step,
        /\(idd-overview-appendix\.instructions\.md#hold--suspend\)/,
        'hold-and-suspend route',
      );
      requirePattern(
        MERGE,
        step,
        /stop\s+before\s+step\s+5/,
        'stop before cleanup',
      );
      requirePattern(
        MERGE,
        step,
        /never\s+remove\s+the\s+issue\s+worktree\s+because\s+of\s+it/,
        'preserve issue worktree',
      );
    },
  },
  {
    id: 'f4-worktree-error-routing',
    paths: [MERGE],
    check({ text }) {
      const contents = text(MERGE);
      const f4Start = contents.indexOf('## F4');
      const step4Start = contents.indexOf(
        '4. Concurrent workers sharing one clone',
        f4Start,
      );
      const step4End = contents.indexOf(
        '\n5. Run from the **primary worktree**',
        step4Start,
      );
      const step5End = contents.indexOf(
        '\n6. If GitHub auto-delete is disabled',
        step4End,
      );
      const f4End = contents.indexOf('\n## F5', step5End);
      if (
        [f4Start, step4Start, step4End, step5End, f4End].some(
          (index) => index < 0,
        ) ||
        step4End <= step4Start ||
        step5End <= step4End ||
        f4End <= step5End
      )
        fail(MERGE, 'F4 step 4/5 boundaries not found');
      const step4 = contents.slice(step4Start, step4End);
      const step5 = contents.slice(step4End, step5End);
      const f4 = contents.slice(step4Start, f4End);
      requirePattern(
        MERGE,
        step4,
        /already\s+used\s+by\s+worktree/,
        'worktree-in-use diagnosis',
      );
      requirePattern(
        MERGE,
        step4,
        /`development-branch-in-use`/,
        'worktree-in-use outcome',
      );
      requirePattern(
        MERGE,
        step4,
        /Not\s+possible\s+to\s+fast-forward/,
        'diverged-branch diagnosis',
      );
      requirePattern(
        MERGE,
        step4,
        /`development-branch-diverged`/,
        'diverged-branch outcome',
      );
      requirePattern(
        MERGE,
        step4,
        /&&\s+git\s+merge\s+--ff-only/,
        'fast-forward-only recovery',
      );
      requirePattern(MERGE, step5, /headRefOid/, 'remote head recheck');
      requirePattern(
        MERGE,
        step5,
        /`local-branch-unmerged-commits`/,
        'unmerged local-branch outcome',
      );
      requirePattern(
        MERGE,
        step5,
        /If\s+it\s+still\s+does/,
        'branch deletion confirmation',
      );
      if (/investigate\s+rather\s+than\s+assume/.test(contents))
        fail(MERGE, 'obsolete investigative instruction returned');
      if (/update-ref\s+-d|reset\s+--hard/.test(f4))
        fail(MERGE, 'destructive branch cleanup guidance returned');
      const branchDMatches = f4.match(/branch\s+-D/g) ?? [];
      if (
        branchDMatches.length !== 1 ||
        !/operator[\s\S]{0,40}branch\s+-D/.test(step5)
      )
        fail(MERGE, 'branch -D must appear only in the step 5 operator note');
    },
  },
  {
    id: 'b1-main-boundary',
    paths: [WORK],
    check({ text }) {
      const contents = text(WORK);
      if (findBareMainLines(contents).length === 0)
        fail(WORK, 'B1 trusted-checkout guidance is missing');
      const unallowed = findUnallowedMainLines(
        contents,
        B1_TRUSTED_CHECKOUT_MAIN_LINES,
      );
      if (unallowed.length > 0)
        fail(
          WORK,
          `main appears outside the B1 allowlist: ${unallowed.join(' | ')}`,
        );
    },
  },
  {
    id: 'pr-submit-main-boundary',
    paths: [PR_SUBMIT, REVIEW_FIX],
    check({ text }) {
      for (const path of [PR_SUBMIT, REVIEW_FIX]) {
        if (
          findUnallowedMainLines(text(path), NO_MAIN_MENTIONS_ALLOWED).length >
          0
        ) {
          fail(
            path,
            'bare main branch mention is outside the trusted-checkout boundary',
          );
        }
      }
    },
  },
  {
    id: 'review-triage-main-boundary',
    paths: [REVIEW_TRIAGE],
    check({ text }) {
      const unexpected = findUnallowedMainLines(
        text(REVIEW_TRIAGE),
        REVIEW_TRIAGE_ALLOWED_MAIN_LINES,
      );
      if (unexpected.length > 0)
        fail(
          REVIEW_TRIAGE,
          `unexpected main mention: ${unexpected.join(' | ')}`,
        );
    },
  },
  {
    id: 'merge-main-boundary',
    paths: [MERGE],
    check({ text }) {
      if (
        findUnallowedMainLines(text(MERGE), NO_MAIN_MENTIONS_ALLOWED).length > 0
      ) {
        fail(
          MERGE,
          'bare main branch mention is outside the trusted-checkout boundary',
        );
      }
    },
  },
  {
    id: 'fetch-refspecs',
    paths: [
      WORK,
      REVIEW_FIX,
      MERGE,
      PR_SUBMIT,
      REVIEW_TRIAGE,
      RESUME_DETAIL,
      TEMPLATE_HELPER_DOC,
    ],
    check({ text }) {
      const workText = text(WORK);
      if (!workText.includes('git fetch origin\n   git log origin/main..main'))
        fail(WORK, 'B1 must fetch origin before reading origin/main');
      if (
        !workText.includes(
          'never fall back. Then\n`git fetch origin` (may be missing/stale',
        )
      )
        fail(WORK, 'worktree setup must use a plain origin fetch');
      if (/git fetch origin main\b/.test(workText))
        fail(WORK, 'bare single-branch fetch of main returned');
      const refspec =
        'git fetch origin +refs/heads/{development-branch}:refs/remotes/origin/{development-branch}';
      if (!text(REVIEW_FIX).includes(refspec))
        fail(
          REVIEW_FIX,
          'review-fix must use a fully-qualified destination refspec',
        );
      const mergeText = text(MERGE);
      if (
        !mergeText.includes(
          'git fetch origin\n   git switch {development-branch} ||',
        )
      )
        fail(MERGE, 'F4 must plain-fetch before reading origin branch');
      if (/git fetch origin \{development-branch\}/.test(mergeText))
        fail(MERGE, 'bare single-branch development fetch returned');
      const submitText = text(PR_SUBMIT);
      if (
        !submitText.includes(
          'First run `git fetch origin`, then check whether the branch is',
        ) ||
        /git fetch origin \{development-branch\}/.test(submitText)
      )
        fail(PR_SUBMIT, 'D1 fetch guidance drifted');
      const triageText = text(REVIEW_TRIAGE);
      if (
        !triageText.includes(
          '`git fetch origin && git merge\n   origin/{development-branch}`',
        ) ||
        /git fetch origin \{development-branch\}/.test(triageText)
      )
        fail(REVIEW_TRIAGE, 'E-phase sync fetch guidance drifted');
      const resumeText = text(RESUME_DETAIL);
      if (
        !resumeText.includes(
          'git fetch origin +refs/heads/{branch}:refs/remotes/origin/{branch}',
        ) ||
        !resumeText.includes(refspec)
      )
        fail(
          RESUME_DETAIL,
          'resume fetch variants require destination refspecs',
        );
      if (
        !text(TEMPLATE_HELPER_DOC).includes(
          'git fetch origin +refs/heads/main:refs/remotes/origin/main',
        )
      )
        fail(
          TEMPLATE_HELPER_DOC,
          'signed merge wrapper must fetch main with destination refspec',
        );
    },
  },
  {
    id: 'd4-pending-recovery-actions',
    paths: [PR_SUBMIT],
    check({ text }) {
      const path = PR_SUBMIT;
      const contents = text(path);
      const bullet = extractBoundedRegion(
        contents,
        'reports `pending: true`**',
        'the elapsed-window `SATISFIED` case take.',
        path,
      );
      requirePattern(
        path,
        bullet,
        /advisory-wait-state/,
        'advisory wait-state helper',
      );
      requirePattern(path, bullet, /lastCopilotCommit/, 'HEAD-coverage signal');
      const requestNow = extractBoundedRegion(
        bullet,
        'read `outcome`:',
        'and it splits on `copilotPending`.',
        path,
      );
      requirePattern(
        path,
        requestNow,
        /only `REQUEST_NEEDED`/,
        'request only for REQUEST_NEEDED',
      );
      const requestSplit = extractBoundedRegion(
        bullet,
        'and it splits on `copilotPending`.',
        'same as `CAP_EXHAUSTED`/`RECOVERY_NEEDED` below.',
        path,
      );
      for (const [pattern, label] of [
        [/When `false`/, 'non-pending case'],
        [/request a review now/, 'request action'],
        [/post the same-head `advisory-wait:` marker/, 'marker action'],
        [/--type advisory/, 'advisory marker type'],
        [/When `copilotPending` is `true`/, 'pending case'],
        [/AW3-S/, 'bounded recovery owner'],
        [
          /idd-review-snapshot\.instructions\.md[\s\S]*\(E1\)/,
          'pending-case E1 route',
        ],
      ] as const)
        requirePattern(path, requestSplit, pattern, label);
      const wait = extractBoundedRegion(
        bullet,
        'same as `CAP_EXHAUSTED`/`RECOVERY_NEEDED` below.',
        'and resume D4.',
        path,
      );
      requirePattern(path, wait, /`WAIT`/, 'WAIT outcome');
      requirePattern(path, wait, /request nothing/, 'WAIT performs no request');
      const satisfied = extractBoundedRegion(
        bullet,
        'and resume D4.',
        'below instead.',
        path,
      );
      for (const [pattern, label] of [
        [/`SATISFIED`/, 'SATISFIED outcome'],
        [/matches this HEAD SHA/, 'current-head coverage'],
        [/rerun-and-resume-D4/, 'covered SATISFIED action'],
        [/does \*\*not\*\* match this HEAD SHA/, 'elapsed SATISFIED split'],
        [/elapsed window/, 'elapsed-window branch'],
        [/pending: true.*for this HEAD/, 'same-head wait proof'],
      ] as const)
        requirePattern(path, satisfied, pattern, label);
      const exitToE1 = extractBoundedRegion(
        contents,
        'below instead.',
        'the elapsed-window `SATISFIED` case take.',
        path,
      );
      requirePattern(
        path,
        exitToE1,
        /`CAP_EXHAUSTED`/,
        'cap-exhausted E1 exit',
      );
      requirePattern(
        path,
        exitToE1,
        /`RECOVERY_NEEDED`/,
        'recovery-needed E1 exit',
      );
      requirePattern(
        path,
        exitToE1,
        /idd-review-snapshot\.instructions\.md.*\(E1\)/,
        'E1 snapshot route',
      );
    },
  },
  {
    id: 'ci-exception-d4-delegation',
    paths: [CI],
    check({ text }) {
      const row = extractBoundedRegion(text(CI), 'Exception 3:', ' |', CI);
      requirePattern(
        CI,
        row,
        /D4's `pending: true` recovery check/,
        'D4 recovery delegation',
      );
    },
  },
  {
    id: 'd3-impact-checklist-derivation',
    paths: [PR_SUBMIT],
    check({ text }) {
      const section = extractBoundedRegion(
        text(PR_SUBMIT),
        '### D3.6 — Derive the IDD impact checklist',
        '### PR body language',
        PR_SUBMIT,
      );
      for (const label of [
        'Instruction files changed',
        'Template files changed',
        'Helper scripts changed',
        'Config schema changed',
        'Security / credential / merge behavior changed',
      ]) {
        requirePattern(
          PR_SUBMIT,
          section,
          new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `D3.6 checkbox ${label}`,
        );
      }
      requirePattern(
        PR_SUBMIT,
        section,
        /root-anchored path-prefix match/,
        'root-anchored instruction path check',
      );
      requirePattern(
        PR_SUBMIT,
        section,
        /excludes `idd-template\/\.github\/instructions\/`\s+paths/,
        'template mirror exclusion',
      );
      requirePattern(
        PR_SUBMIT,
        section,
        /Skip this sub-step and D3\.7 below entirely when/,
        'missing-template skip',
      );
    },
  },
  {
    id: 'd3-final-head-impact-recheck',
    paths: [PR_SUBMIT],
    check({ text }) {
      const section = extractBoundedRegion(
        text(PR_SUBMIT),
        '### D3.7 — Re-verify the IDD impact checklist before merge',
        '## D4 — Wait for CI',
        PR_SUBMIT,
      );
      requirePattern(
        PR_SUBMIT,
        section,
        /re-derive D3\.6's checklist/,
        'D3.6 checklist re-derivation',
      );
      requirePattern(PR_SUBMIT, section, /ratchet-rule/, 'ratchet rule');
      requirePattern(
        PR_SUBMIT,
        section,
        /gh pr edit \{pr-number\} --body-file/,
        'complete-body update',
      );
      requirePattern(
        PR_SUBMIT,
        section,
        /never pass a partial file/,
        'complete-file requirement',
      );
      requirePattern(
        PR_SUBMIT,
        section,
        /D3\.5 step 6's closing-set check/,
        'closing-set verification',
      );
      if (/this round's fix/.test(section))
        fail(PR_SUBMIT, 'round-specific PR-body prose returned');
    },
  },
];

// audit:ignore-dead-export: fixture tests need each stable rule's input path.
export const repositoryPolicyRulePaths = Object.fromEntries(
  RULES.map((rule) => [rule.id, rule.paths]),
) as Readonly<Record<string, readonly string[]>>;
// audit:ignore-dead-export: fixture tests must exercise every stable rule ID.
export const repositoryPolicyRuleIds = RULES.map((rule) => rule.id);

export interface RepositoryPolicyViolation {
  ruleId: string;
  path: string;
  message: string;
}

export function collectRepositoryPolicyViolationsFromDocuments(
  documents: RepositoryPolicyDocuments,
): RepositoryPolicyViolation[] {
  const violations: RepositoryPolicyViolation[] = [];
  for (const rule of RULES) {
    const readText = (path: string): string => {
      const value = documents.get(path);
      if (value === undefined) fail(path, 'required input document is missing');
      return value;
    };
    const context: RuleContext = {
      text: readText,
      json(path) {
        const value = readText(path);
        try {
          return JSON.parse(value) as unknown;
        } catch (error) {
          fail(
            path,
            `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
    try {
      rule.check(context);
    } catch (error) {
      violations.push({
        ruleId: rule.id,
        path:
          error instanceof RuleFailure
            ? error.path
            : (rule.paths[0] ?? '<unknown>'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return violations;
}

export function collectRepositoryPolicyViolations(
  root = process.cwd(),
): RepositoryPolicyViolation[] {
  const documents = new Map<string, string>();
  for (const path of new Set(RULES.flatMap((rule) => rule.paths))) {
    try {
      documents.set(path, readFileSync(resolve(root, path), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return collectRepositoryPolicyViolationsFromDocuments(documents);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let validArgs = args.length === 0;
  if (args.length === 2 && args[0] === '--root') {
    root = resolve(args[1]);
    validArgs = true;
  }
  if (!validArgs) {
    console.error(
      'usage: node scripts/repository-policy-audit.mjs [--root <directory>]',
    );
    process.exitCode = 2;
  }
  if (validArgs) {
    const violations = collectRepositoryPolicyViolations(root);
    for (const violation of violations) {
      console.error(
        `${violation.ruleId}: ${violation.path}: ${violation.message}`,
      );
    }
    if (violations.length === 0) console.log('repository policy audit passed');
    else process.exitCode = 1;
  }
}
