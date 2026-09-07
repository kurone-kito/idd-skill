import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateUntrustedLabelerCandidates,
  type RawIssueEvent,
  renderTable,
  sweepUntrustedLabelerCandidates,
  type UntrustedLabelerSweepResult,
} from '../src/scripts/idd-suggest-untrusted-labelers.mts';
import { readJson, stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

interface Fixture {
  input: { events: RawIssueEvent[] };
  expected: ReturnType<typeof aggregateUntrustedLabelerCandidates>;
}

function loadFixture(name: string): Fixture {
  return readJson(
    `fixtures/idd-suggest-untrusted-labelers/${name}.json`,
  ) as Fixture;
}

// ---------------------------------------------------------------------------
// aggregateUntrustedLabelerCandidates: pure, offline, fixture-driven
// ---------------------------------------------------------------------------

test('aggregateUntrustedLabelerCandidates: counts labeled events per bot login, sorted count desc then login asc', () => {
  const { input, expected } = loadFixture('basic');
  assert.deepEqual(aggregateUntrustedLabelerCandidates(input.events), expected);
});

test('aggregateUntrustedLabelerCandidates: a non-labeled event from a bot is not counted', () => {
  const { input } = loadFixture('basic');
  const candidates = aggregateUntrustedLabelerCandidates(input.events);
  // "noisy-bot" also produced one "unlabeled" event in the fixture; only
  // its 3 "labeled" events count.
  const noisyBot = candidates.find((row) => row.login === 'noisy-bot');
  assert.ok(noisyBot);
  assert.equal(noisyBot.labeledEventCount, 3);
});

test('aggregateUntrustedLabelerCandidates: a labeled event from a non-Bot actor is excluded', () => {
  const { input } = loadFixture('basic');
  const candidates = aggregateUntrustedLabelerCandidates(input.events);
  assert.equal(
    candidates.some((row) => row.login === 'kurone-kito'),
    false,
  );
});

test('aggregateUntrustedLabelerCandidates: null/empty actor and login are skipped, tie-broken candidates sort by login ascending', () => {
  const { input, expected } = loadFixture('edge-cases');
  assert.deepEqual(aggregateUntrustedLabelerCandidates(input.events), expected);
});

test('aggregateUntrustedLabelerCandidates: a missing/null event field is skipped, not treated as "labeled"', () => {
  const { input } = loadFixture('edge-cases');
  const candidates = aggregateUntrustedLabelerCandidates(input.events);
  assert.equal(
    candidates.some(
      (row) =>
        row.login === 'ignored-bot' || row.login === 'another-ignored-bot',
    ),
    false,
  );
});

test('aggregateUntrustedLabelerCandidates: empty input reports no candidates', () => {
  assert.deepEqual(aggregateUntrustedLabelerCandidates([]), []);
});

// ---------------------------------------------------------------------------
// renderTable
// ---------------------------------------------------------------------------

test('renderTable: renders one row per candidate plus a totals line', () => {
  const result: UntrustedLabelerSweepResult = {
    candidates: [
      { login: 'noisy-bot', labeledEventCount: 3 },
      { login: 'quiet-bot', labeledEventCount: 1 },
    ],
    scannedEventCount: 7,
    pageCount: 1,
  };
  const table = renderTable(result);
  assert.match(table, /\| noisy-bot \| 3 \|/);
  assert.match(table, /\| quiet-bot \| 1 \|/);
  assert.match(
    table,
    /Total: 2 distinct bot login\(s\) found across 7 scanned issue\/PR event\(s\) over 1 page\(s\)\./,
  );
});

// ---------------------------------------------------------------------------
// sweepUntrustedLabelerCandidates: pagination loop, injectable fetcher (no
// subprocess -- exercises the pagination-stop condition fast)
// ---------------------------------------------------------------------------

test('sweepUntrustedLabelerCandidates: pages until a short page, merging and aggregating across pages', () => {
  const pages: Record<number, RawIssueEvent[]> = {
    1: Array.from({ length: 100 }, () => ({
      event: 'labeled',
      actor: { login: 'prolific-bot', type: 'Bot' },
    })),
    2: [
      { event: 'labeled', actor: { login: 'prolific-bot', type: 'Bot' } },
      { event: 'labeled', actor: { login: 'second-bot', type: 'Bot' } },
      { event: 'labeled', actor: { login: 'a-human', type: 'User' } },
    ],
  };
  const calls: number[] = [];
  const result = sweepUntrustedLabelerCandidates('o', 'r', {
    fetchPage: (owner, repo, page) => {
      assert.equal(owner, 'o');
      assert.equal(repo, 'r');
      calls.push(page);
      const items = pages[page];
      assert.ok(items, `unexpected page requested: ${page}`);
      return items;
    },
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.pageCount, 2);
  assert.equal(result.scannedEventCount, 103);
  assert.deepEqual(result.candidates, [
    { login: 'prolific-bot', labeledEventCount: 101 },
    { login: 'second-bot', labeledEventCount: 1 },
  ]);
});

test('sweepUntrustedLabelerCandidates: an immediately-short first page stops after one call', () => {
  const calls: number[] = [];
  const result = sweepUntrustedLabelerCandidates('o', 'r', {
    fetchPage: (_owner, _repo, page) => {
      calls.push(page);
      return [{ event: 'labeled', actor: { login: 'only-bot', type: 'Bot' } }];
    },
  });
  assert.deepEqual(calls, [1]);
  assert.equal(result.pageCount, 1);
  assert.equal(result.scannedEventCount, 1);
  assert.deepEqual(result.candidates, [
    { login: 'only-bot', labeledEventCount: 1 },
  ]);
});

test('sweepUntrustedLabelerCandidates: no events at all reports zero candidates from one page', () => {
  const result = sweepUntrustedLabelerCandidates('o', 'r', {
    fetchPage: () => [],
  });
  assert.equal(result.pageCount, 1);
  assert.equal(result.scannedEventCount, 0);
  assert.deepEqual(result.candidates, []);
});

// ---------------------------------------------------------------------------
// CLI subprocess: stub `gh` on PATH, matched by exact argv (same technique
// as tests/gh-pagination-parsing-smoke.test.mts). Proves, against the
// COMPILED scripts/idd-suggest-untrusted-labelers.mjs: (1) the sweep pages
// to completion across a 100-item page and a short final page, merging and
// filtering correctly end-to-end; (2) no mutating (or any other) `gh` call
// is made -- the stub table below registers ONLY the two read GET calls,
// and an unmatched call fails the stub loudly instead of the test silently
// passing, so this doubles as the "no mutating call" acceptance-criterion
// proof.
// ---------------------------------------------------------------------------

const OWNER = 'o';
const REPO = 'r';
const EVENTS_PROJECTION_JQ =
  '[.[] | {event: .event, actor: {login: (.actor.login // null), type: (.actor.type // null)}}]';

function eventsPageArgv(page: number): string[] {
  return [
    'api',
    `repos/${OWNER}/${REPO}/issues/events?per_page=100&page=${page}`,
    '--jq',
    EVENTS_PROJECTION_JQ,
  ];
}

function buildStubGh(responses: Map<string, string>): string {
  const table = JSON.stringify([...responses.entries()]);
  return `const args = process.argv.slice(2);
const table = new Map(${table});
const key = JSON.stringify(args);
if (table.has(key)) {
  process.stdout.write(table.get(key));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runStubbedCli(
  cliArgs: string[],
  responses: Map<string, string>,
): string {
  const cwdRoot = mkdtempSync(
    join(tmpdir(), 'idd-suggest-untrusted-labelers-cwd-'),
  );
  const restore = stubExecutable('gh', buildStubGh(responses));
  try {
    return execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'idd-suggest-untrusted-labelers.mjs'),
        ...cliArgs,
      ],
      {
        cwd: cwdRoot,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 60_000,
      },
    );
  } finally {
    restore();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

test('idd-suggest-untrusted-labelers.mjs CLI: pages to completion across a full page and a short final page, with no other gh call made', () => {
  const page1 = Array.from({ length: 100 }, () => ({
    event: 'labeled',
    actor: { login: 'prolific-bot', type: 'Bot' },
  }));
  const page2 = [
    { event: 'labeled', actor: { login: 'prolific-bot', type: 'Bot' } },
    { event: 'labeled', actor: { login: 'second-bot', type: 'Bot' } },
    { event: 'labeled', actor: { login: 'a-human', type: 'User' } },
    { event: 'unlabeled', actor: { login: 'second-bot', type: 'Bot' } },
  ];
  const responses = new Map<string, string>([
    [JSON.stringify(eventsPageArgv(1)), JSON.stringify(page1)],
    [JSON.stringify(eventsPageArgv(2)), JSON.stringify(page2)],
  ]);

  const output = runStubbedCli(
    ['--owner', OWNER, '--repo', REPO, '--format', 'json'],
    responses,
  );

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  const report = JSON.parse(output) as UntrustedLabelerSweepResult & {
    owner: string;
    repo: string;
  };
  assert.equal(report.owner, OWNER);
  assert.equal(report.repo, REPO);
  assert.equal(report.pageCount, 2);
  assert.equal(report.scannedEventCount, 104);
  assert.deepEqual(report.candidates, [
    { login: 'prolific-bot', labeledEventCount: 101 },
    { login: 'second-bot', labeledEventCount: 1 },
  ]);
});

test('idd-suggest-untrusted-labelers.mjs CLI: table format renders the same aggregated result', () => {
  const responses = new Map<string, string>([
    [
      JSON.stringify(eventsPageArgv(1)),
      JSON.stringify([
        { event: 'labeled', actor: { login: 'only-bot', type: 'Bot' } },
      ]),
    ],
  ]);

  const output = runStubbedCli(['--owner', OWNER, '--repo', REPO], responses);

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  assert.match(output, /\| only-bot \| 1 \|/);
  assert.match(
    output,
    /Total: 1 distinct bot login\(s\) found across 1 scanned issue\/PR event\(s\) over 1 page\(s\)\./,
  );
});
