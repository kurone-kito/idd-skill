import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { advisoryMarkerComment } from '../src/scripts/advisory-wait-state.mts';
import type { AdvisoryWaitMarkerFamily } from '../src/scripts/marker-helpers.mts';
import {
  advisoryWaitFamilyMarkerStart,
  OPERATIONAL_MARKERS,
  operationalMarkerPrefix,
  parseAdvisoryWaitFamilyMarker,
  parseAdvisoryWaitRequestMarker,
} from '../src/scripts/marker-helpers.mts';
import { summarizeAdvisoryWaitMarkers } from '../src/scripts/protocol-helpers.mts';

// #3338: contract test for the shared advisory-wait-family grammar. Before
// this issue, three consumers (protocol-helpers.mts's
// `advisoryWaitMarkerMatchesHead`/`advisoryWaitRequestMarker`,
// provider-health.mts's own regexes, and advisory-wait-state.mts's
// `advisoryMarkerComment`) each hand-copied the `advisory-wait:` /
// `advisory-wait-recovery:` / `advisory-reroll:` / `<!-- advisory-wait: -->`
// marker grammar with a different degree of fidelity to the canonical
// `OPERATIONAL_MARKERS` entries. This corpus exercises every consumer --
// plus the `jq` fallback filters documented in
// docs/idd-advisory-wait-shell-fallback.md -- against the same set of
// bodies, so a future edit that reintroduces drift in any one of them fails
// here instead of silently diverging again.

const PR_HEAD_SHA = 'a'.repeat(40);
const WRONG_SHA = 'b'.repeat(40);
const AGENT = 'idd-agent';
const TS = '2026-01-01T00:00:00Z';
const TS_FRACTIONAL = '2026-01-01T00:00:00.123Z';

const FAMILY_LABEL: Record<AdvisoryWaitMarkerFamily, string> = {
  'advisory-wait': 'advisory-wait:',
  'advisory-wait-recovery': 'advisory-wait-recovery:',
  'advisory-reroll': 'advisory-reroll:',
  'advisory-wait-html': '<!-- advisory-wait:',
};

interface CorpusRow {
  name: string;
  body: string;
  /** Expected `parseAdvisoryWaitFamilyMarker` family, or `null` if the body
   * is not a well-formed member of the family. */
  family: AdvisoryWaitMarkerFamily | null;
  /** Expected parsed `headSha`/`timestamp` when `family` is non-null. */
  headSha?: string;
  timestamp?: string;
  /** Expected `summarizeAdvisoryWaitMarkers` same-HEAD contribution against
   * `PR_HEAD_SHA`. */
  sameHead: boolean;
  /** Expected request-marker-count / request-subset-predicate membership. */
  isRequestMarker: boolean;
  /** Expected `advisoryWaitFamilyMarkerStart`/`advisoryMarkerComment`
   * (family-start, prefix-only) membership. */
  familyStart: boolean;
  /** Expected `parseAdvisoryWaitRequestMarker` (provider-health's matcher)
   * return value. */
  providerHealthRequestedAt: string | null;
}

const CORPUS: CorpusRow[] = [
  {
    name: 'canonical plain',
    body: `advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}`,
    family: 'advisory-wait',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'double space',
    body: `advisory-wait:  ${AGENT}  ${PR_HEAD_SHA}  ${TS}`,
    family: 'advisory-wait',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'tab separator',
    body: `advisory-wait:\t${AGENT}\t${PR_HEAD_SHA}\t${TS}`,
    family: 'advisory-wait',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'trailing whitespace',
    body: `advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}   `,
    family: 'advisory-wait',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'fractional seconds',
    body: `advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS_FRACTIONAL}`,
    family: 'advisory-wait',
    headSha: PR_HEAD_SHA,
    timestamp: TS_FRACTIONAL,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS_FRACTIONAL,
  },
  {
    name: 'canonical HTML',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS} -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'HTML, no space after <!--',
    body: `<!--advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS} -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'HTML, two spaces after <!--',
    body: `<!--  advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS} -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'HTML, extra space before -->',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}  -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    // Regression guard (Copilot review round 1 on #3338's plan): a naive
    // greedy field-extraction regex can capture the arrow itself as part
    // of the timestamp when no space precedes `-->`.
    name: 'HTML, zero space before -->',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}-->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'recovery, legacy 3-field form',
    body: `advisory-wait-recovery: ${AGENT} ${PR_HEAD_SHA} ${TS}`,
    family: 'advisory-wait-recovery',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: false,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    name: 'recovery, bound claim/attempt form',
    body: `advisory-wait-recovery: ${AGENT} ${PR_HEAD_SHA} ${TS} claim:claim-1 attempt:1`,
    family: 'advisory-wait-recovery',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: true,
    isRequestMarker: false,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    name: 'advisory-reroll',
    body: `advisory-reroll: ${AGENT} ${PR_HEAD_SHA} ${TS}`,
    family: 'advisory-reroll',
    headSha: PR_HEAD_SHA,
    timestamp: TS,
    sameHead: false,
    isRequestMarker: false,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    name: 'plain form, pending timestamp placeholder',
    body: `advisory-wait: ${AGENT} ${PR_HEAD_SHA} pending`,
    family: null,
    sameHead: false,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    name: 'HTML, non-ISO last field',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} notatimestamp -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: 'notatimestamp',
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    // Regression guard (Copilot review round 1 on PR #3380): the
    // canonical HTML pattern's last field is an unrestricted `\S+` token,
    // so it can itself contain the literal `-->` sequence. The captured
    // `timestamp` must be the FULL field up to the true final `-->`, not
    // truncated at the first occurrence.
    name: 'HTML, embedded --> inside the last field (Copilot example)',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} foo-->bar -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: 'foo-->bar',
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    // Regression guard: an ISO-shaped PREFIX followed by an embedded
    // `-->` and trailing content is a sharper trap than the previous
    // row -- a truncating extractor would return a spuriously valid ISO
    // timestamp (`2026-01-01T00:00:00Z`) instead of the true, non-ISO
    // full field. The pre-shared-grammar provider-health regex already
    // rejected this exact shape outright (its captured group required
    // an ISO timestamp immediately followed by `-->`), so a truncating
    // extractor here would be a regression, not merely a new edge case.
    name: 'HTML, ISO-prefix then embedded --> (regression trap)',
    body: `<!-- advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}-->x -->`,
    family: 'advisory-wait-html',
    headSha: PR_HEAD_SHA,
    timestamp: `${TS}-->x`,
    sameHead: true,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: null,
  },
  {
    name: 'wrong SHA',
    body: `advisory-wait: ${AGENT} ${WRONG_SHA} ${TS}`,
    family: 'advisory-wait',
    headSha: WRONG_SHA,
    timestamp: TS,
    sameHead: false,
    isRequestMarker: true,
    familyStart: true,
    providerHealthRequestedAt: TS,
  },
  {
    name: 'not at byte 0 (leading whitespace)',
    body: `  advisory-wait: ${AGENT} ${PR_HEAD_SHA} ${TS}`,
    family: null,
    sameHead: false,
    isRequestMarker: false,
    familyStart: false,
    providerHealthRequestedAt: null,
  },
];

test('parseAdvisoryWaitFamilyMarker: matches the corpus, and agrees with OPERATIONAL_MARKERS/operationalMarkerPrefix', () => {
  for (const row of CORPUS) {
    const parsed = parseAdvisoryWaitFamilyMarker(row.body);
    if (row.family === null) {
      assert.equal(parsed, null, `${row.name}: expected no parse`);
    } else {
      assert.ok(parsed, `${row.name}: expected a parse`);
      assert.equal(parsed.family, row.family, `${row.name}: family`);
      assert.equal(
        parsed.headSha,
        row.headSha?.toLowerCase(),
        `${row.name}: headSha`,
      );
      assert.equal(parsed.timestamp, row.timestamp, `${row.name}: timestamp`);
    }

    // Drift guard: this shared parser's notion of "well-formed" must never
    // diverge from the canonical OPERATIONAL_MARKERS entry it delegates to
    // for validation.
    const expectedLabel = row.family === null ? null : FAMILY_LABEL[row.family];
    const marker =
      row.family === null
        ? undefined
        : OPERATIONAL_MARKERS.find((m) => m.label === expectedLabel);
    if (row.family !== null) {
      assert.ok(
        marker,
        `${row.name}: no OPERATIONAL_MARKERS entry for ${expectedLabel}`,
      );
      assert.equal(
        marker.pattern.test(row.body.trimEnd()),
        true,
        `${row.name}: OPERATIONAL_MARKERS entry must also recognize a well-formed row`,
      );
    }
    assert.equal(
      operationalMarkerPrefix(row.body),
      expectedLabel,
      `${row.name}: operationalMarkerPrefix must agree with the shared parser`,
    );
  }
});

test('advisoryWaitFamilyMarkerStart / advisoryMarkerComment: byte-0-anchored, prefix-only family-start predicate', () => {
  for (const row of CORPUS) {
    const startFamily = advisoryWaitFamilyMarkerStart(row.body);
    assert.equal(
      startFamily !== null,
      row.familyStart,
      `${row.name}: advisoryWaitFamilyMarkerStart`,
    );
    assert.equal(
      advisoryMarkerComment(row.body),
      row.familyStart,
      `${row.name}: advisoryMarkerComment`,
    );
  }
});

test('parseAdvisoryWaitRequestMarker: provider-health.mts request-timestamp matcher', () => {
  for (const row of CORPUS) {
    assert.equal(
      parseAdvisoryWaitRequestMarker(row.body),
      row.providerHealthRequestedAt,
      row.name,
    );
  }
});

test('summarizeAdvisoryWaitMarkers: same-HEAD presence and request-marker count', () => {
  for (const row of CORPUS) {
    const summary = summarizeAdvisoryWaitMarkers(
      [
        {
          body: row.body,
          author: { login: AGENT },
          createdAt: '2026-01-02T00:00:00Z',
          lastEditedAt: null,
        },
      ],
      PR_HEAD_SHA,
      [AGENT],
    );
    assert.equal(
      summary.sameHeadMarkerPresent,
      row.sameHead,
      `${row.name}: sameHeadMarkerPresent`,
    );
    assert.equal(
      summary.requestMarkerCount,
      row.isRequestMarker ? 1 : 0,
      `${row.name}: requestMarkerCount`,
    );
  }
});

// --- jq fallback-filter agreement -------------------------------------

interface ExtractedJqPattern {
  index: number;
  source: string;
}

/** Decodes a jq string literal's raw file text (double-backslash escaped,
 * same convention as JSON) into the real string value the pattern
 * represents at runtime. */
function decodeJqStringLiteral(raw: string): string {
  return JSON.parse(`"${raw}"`) as string;
}

/**
 * Extracts every `test("...")` call from the AW2 `jq` block in
 * docs/idd-advisory-wait-shell-fallback.md, in file order, substituting the
 * fixed `PR_HEAD_SHA` for any `" + $sha + "` concatenation seam. A plain
 * `test("...")` call (no `$sha` splice) and a `test("A" + $sha + "B")` call
 * are structurally disjoint shapes (the former requires `)` to
 * immediately follow the closing quote; the latter never does), so the two
 * passes below never double-count the same call.
 */
function extractJqTestPatterns(mdText: string): ExtractedJqPattern[] {
  const results: ExtractedJqPattern[] = [];
  const literalRe = /test\("((?:[^"\\]|\\.)*)"\)/g;
  for (const m of mdText.matchAll(literalRe)) {
    results.push({ index: m.index, source: decodeJqStringLiteral(m[1]) });
  }
  const concatRe =
    /test\("((?:[^"\\]|\\.)*)"\s*\+\s*\$sha\s*\+\s*"((?:[^"\\]|\\.)*)"\)/g;
  for (const m of mdText.matchAll(concatRe)) {
    const prefix = decodeJqStringLiteral(m[1]);
    const suffix = decodeJqStringLiteral(m[2]);
    results.push({ index: m.index, source: prefix + PR_HEAD_SHA + suffix });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}

test('AW2 jq fallback filters: agree with the JS-side grammar over the corpus', () => {
  const docPath = fileURLToPath(
    new URL('../docs/idd-advisory-wait-shell-fallback.md', import.meta.url),
  );
  const docText = readFileSync(docPath, 'utf8');
  const patterns = extractJqTestPatterns(docText);

  // Fixed positional layout of the AW2 block (verified against the file's
  // own structure): [0] trust-widening filter (4-way alternation, one
  // literal); [1..3] EARLIEST_SAME_HEAD_AT (advisory-wait, recovery, HTML);
  // [4] REQUEST_MARKER_COUNT (one literal, 2-way alternation);
  // [5..6] SAME_HEAD_REQUEST_MARKER_PRESENT (advisory-wait, HTML). A change
  // to that block's own structure should fail loudly here rather than
  // silently comparing the wrong patterns.
  assert.equal(
    patterns.length,
    7,
    'expected exactly 7 test(...) calls in the AW2 block',
  );

  const [
    trustFilter,
    earliestWait,
    earliestRecovery,
    earliestHtml,
    requestCount,
    sameHeadWait,
    sameHeadHtml,
  ] = patterns.map((p) => new RegExp(p.source));

  for (const row of CORPUS) {
    assert.equal(
      trustFilter.test(row.body),
      row.familyStart,
      `${row.name}: trust-widening filter`,
    );
    assert.equal(
      earliestWait.test(row.body) ||
        earliestRecovery.test(row.body) ||
        earliestHtml.test(row.body),
      row.sameHead,
      `${row.name}: EARLIEST_SAME_HEAD_AT`,
    );
    assert.equal(
      requestCount.test(row.body),
      row.isRequestMarker,
      `${row.name}: REQUEST_MARKER_COUNT`,
    );
    assert.equal(
      sameHeadWait.test(row.body) || sameHeadHtml.test(row.body),
      row.sameHead && row.isRequestMarker,
      `${row.name}: SAME_HEAD_REQUEST_MARKER_PRESENT`,
    );
  }
});
