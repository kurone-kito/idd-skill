import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type DiscoverHintDeps,
  invalidateDiscoverHints,
  readDiscoverHint,
} from '../src/scripts/discover-hint-cache.mts';
import { hasEligibleOrphan } from '../src/scripts/discover-orphan-filter.mts';
import {
  enumerateAllRoadmapsGraph,
  hasStartableCandidate,
  type RoadmapGraphUnionReport,
  warnOnSearchResultCap,
} from '../src/scripts/discover-roadmap-graph.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---- in-process: the cached unit is the whole enumerated union report ----

function roadmap(number: number, body: string, markerId: string) {
  return {
    number,
    title: `roadmap ${number}`,
    state: 'open',
    body: `${body}\n<!-- idd-skill-roadmap-id: ${markerId} -->`,
    labels: [{ name: 'roadmap' }],
  };
}

function leaf(number: number, score: number, state = 'open') {
  return {
    number,
    title: `task ${number}`,
    state,
    body: `task ${number}\n<!-- idd-skill-autopilot-suitability: ${score} -->`,
    labels: [],
  };
}

interface Tracker {
  issues: Map<number, unknown>;
  loads: number[];
}

function tracker(issues: [number, unknown][]): Tracker {
  return { issues: new Map(issues), loads: [] };
}

function unionCompute(t: Tracker, roots: number[]) {
  return () =>
    enumerateAllRoadmapsGraph({
      loadOpenRoadmapRoots: async () => roots,
      loadIssue: async (number) => {
        t.loads.push(number);
        return t.issues.get(number) ?? null;
      },
    });
}

interface Fixture {
  root: string;
  deps: DiscoverHintDeps;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'idd-hint-integration-'));
  const cacheDir = join(root, 'cache');
  const workspace = join(root, 'workspace');
  mkdirSync(cacheDir);
  mkdirSync(workspace);
  return {
    root,
    deps: {
      env: {},
      cwd: workspace,
      policy: {
        enabled: true,
        maxAgeMs: 300_000,
        maxBytes: 104857600,
        retentionMs: 86_400_000,
        directory: cacheDir,
      },
      originUrl: () => 'https://github.com/o/r.git',
      credential: () => 'integration-token',
    },
  };
}

function read(
  fx: Fixture,
  compute: () => Promise<RoadmapGraphUnionReport>,
  extra: { refreshCache?: boolean; noCache?: boolean } = {},
) {
  return readDiscoverHint<RoadmapGraphUnionReport>({
    helper: 'discover-roadmap-graph',
    args: { allRoadmaps: true },
    policy: { floor: 3 },
    compute,
    hasCandidate: hasStartableCandidate,
    deps: fx.deps,
    ...extra,
  });
}

function withoutCache(report: RoadmapGraphUnionReport) {
  const { cache: _cache, ...rest } = report;
  return rest;
}

test('a warm union repeat makes zero loader reads and keeps ranking and provenance', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701\n- [ ] #702', 'epic-alpha')],
    [800, roadmap(800, '- [ ] #702\n- [ ] #803', 'epic-beta')],
    [701, leaf(701, 5)],
    [702, leaf(702, 2)],
    [803, leaf(803, 4)],
  ]);
  try {
    const cold = await read(fx, unionCompute(t, [700, 800]));
    const coldReads = t.loads.length;
    assert.ok(coldReads > 0);
    const warm = await read(fx, unionCompute(t, [700, 800]));
    assert.equal(t.loads.length, coldReads);
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(warm.cache?.enumerations, 0);
    assert.deepEqual(warm.report, cold.report);
    assert.deepEqual(
      warm.report.leaves.map((entry) => entry.number),
      [701, 803, 702],
    );
    assert.deepEqual(
      warm.report.leaves.find((entry) => entry.number === 702)?.sourceRoots,
      [700, 800],
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('cached exhaustion refreshes once and finds a newly opened leaf', async () => {
  const fx = fixture();
  const t = tracker([[700, roadmap(700, '- [ ] #701', 'epic-alpha')]]);
  try {
    const cold = await read(fx, unionCompute(t, [700]));
    assert.equal(cold.report.leaves.length, 0);
    // A leaf is opened after the empty inventory was cached.
    t.issues.set(700, roadmap(700, '- [ ] #701\n- [ ] #999', 'epic-alpha'));
    t.issues.set(999, leaf(999, 4));
    const refreshed = await read(fx, unionCompute(t, [700]));
    assert.equal(refreshed.cache?.exhaustionRefresh, true);
    assert.deepEqual(
      refreshed.report.leaves.map((entry) => entry.number),
      [999],
    );
    const warm = await read(fx, unionCompute(t, [700]));
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(warm.cache?.exhaustionRefresh, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a stale hint is superseded by an invalidation or an explicit refresh', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701\n- [ ] #702', 'epic-alpha')],
    [701, leaf(701, 5)],
    [702, leaf(702, 4)],
  ]);
  try {
    await read(fx, unionCompute(t, [700]));
    // #701 is closed elsewhere; the hint still lists it until refreshed.
    t.issues.set(701, leaf(701, 5, 'closed'));
    const stale = await read(fx, unionCompute(t, [700]));
    assert.deepEqual(
      stale.report.leaves.map((entry) => entry.number),
      [701, 702],
    );
    assert.equal(invalidateDiscoverHints({}, fx.deps), true);
    const fresh = await read(fx, unionCompute(t, [700]));
    assert.equal(fresh.cache?.source, 'live');
    assert.deepEqual(
      fresh.report.leaves.map((entry) => entry.number),
      [702],
    );
    t.issues.set(702, leaf(702, 4, 'closed'));
    const refreshed = await read(fx, unionCompute(t, [700]), {
      refreshCache: true,
    });
    assert.equal(refreshed.report.leaves.length, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function captureStderr(): { restore: () => string } {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
      return chunks.join('');
    },
  };
}

test('a capped root search is reported incomplete and never stored', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701', 'epic-alpha')],
    [701, leaf(701, 5)],
  ]);
  const compute = async () => {
    warnOnSearchResultCap(
      Array.from({ length: 1000 }, () => ({})),
      'body-marker',
    );
    return unionCompute(t, [700])();
  };
  const captured = captureStderr();
  try {
    const first = await read(fx, compute);
    const second = await read(fx, compute);
    const stderr = captured.restore();
    assert.match(stderr, /root search hit the 1000-result cap/);
    assert.equal(first.cache?.complete, false);
    assert.equal(second.cache?.complete, false);
    assert.equal(second.cache?.source, 'live');
  } finally {
    captured.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a skipped unusable root is reported incomplete and never stored', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701', 'epic-alpha')],
    [701, leaf(701, 5)],
  ]);
  // Root 999 does not exist: the union skips it with a warning.
  const captured = captureStderr();
  try {
    const first = await read(fx, unionCompute(t, [700, 999]));
    const second = await read(fx, unionCompute(t, [700, 999]));
    const stderr = captured.restore();
    assert.match(stderr, /root #999 could not be enumerated/);
    assert.equal(first.cache?.complete, false);
    assert.equal(second.cache?.source, 'live');
    assert.deepEqual(
      second.report.leaves.map((entry) => entry.number),
      [701],
    );
  } finally {
    captured.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('startable-candidate detection prefers readiness, then claim state, then presence', () => {
  assert.equal(hasStartableCandidate({ leaves: [] }), false);
  assert.equal(hasStartableCandidate({ leaves: [{ number: 1 }] }), true);
  assert.equal(
    hasStartableCandidate({ leaves: [{ number: 1, claimEligible: false }] }),
    false,
  );
  assert.equal(
    hasStartableCandidate({
      leaves: [
        { number: 1, claimEligible: false },
        { number: 2, claimEligible: true },
      ],
    }),
    true,
  );
  assert.equal(
    hasStartableCandidate({
      leaves: [
        { number: 1, claimEligible: true, readiness: { startable: false } },
      ],
    }),
    false,
  );
  assert.equal(
    hasStartableCandidate({
      leaves: [
        { number: 1, readiness: { startable: false } },
        { number: 2, readiness: { startable: true } },
      ],
    }),
    true,
  );
  // Single-root shape: only nodes listed as execution candidates count.
  assert.equal(
    hasStartableCandidate({
      nodes: [{ number: 700 }, { number: 701 }],
      executionCandidates: [701],
    }),
    true,
  );
  assert.equal(
    hasStartableCandidate({
      nodes: [{ number: 700 }],
      executionCandidates: [],
    }),
    false,
  );
  assert.equal(hasStartableCandidate(null), false);
});

// ---- CLI: the generated helper, a stubbed gh, a real local git origin ----

const GH_STUB = (logPath: string) => `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/700") {
  process.stdout.write(JSON.stringify({ number: 700, title: "roadmap 700", state: "open", body: "<!-- idd-skill-roadmap-id: root-roadmap -->", labels: [{ name: "roadmap" }] }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/701") {
  process.stdout.write(JSON.stringify({ number: 701, title: "issue 701", state: "open", body: "", labels: [] }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  const numberArg = args.find((entry) => entry.startsWith("number="));
  const n = Number.parseInt(String(numberArg ?? "").slice("number=".length), 10);
  process.stdout.write(JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: n === 700 ? [{ number: 701 }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;

interface CliFixture {
  root: string;
  workspace: string;
  cacheDir: string;
  log: string;
  restore: () => void;
}

function cliFixture(
  enabled: boolean,
  stub: (logPath: string) => string = GH_STUB,
): CliFixture {
  const root = mkdtempSync(join(tmpdir(), 'idd-hint-cli-'));
  const workspace = join(root, 'workspace');
  const cacheDir = join(root, 'cache');
  mkdirSync(join(workspace, '.github', 'idd'), { recursive: true });
  mkdirSync(cacheDir);
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/kurone-kito/idd-skill.git'],
    { cwd: workspace },
  );
  writeFileSync(
    join(workspace, '.github', 'idd', 'config.json'),
    JSON.stringify(
      enabled
        ? { githubApi: { readCache: { enabled: true, directory: cacheDir } } }
        : {},
    ),
  );
  const log = join(root, 'gh.log');
  writeFileSync(log, '');
  return {
    root,
    workspace,
    cacheDir,
    log,
    restore: stubExecutable('gh', stub(log)),
  };
}

function runCli(
  fx: CliFixture,
  args: string[],
  script = 'discover-roadmap-graph.mjs',
) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', script), ...args],
    {
      cwd: fx.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_TOKEN: 'cli-token',
        GH_HOST: 'github.com',
        HOME: fx.root,
        XDG_CACHE_HOME: join(fx.root, 'xdg'),
      },
    },
  );
}

function ghCalls(fx: CliFixture): number {
  return readFileSync(fx.log, 'utf8').split('\n').filter(Boolean).length;
}

test('CLI: a warm repeat spawns no gh process and reports the hint', () => {
  const fx = cliFixture(true);
  try {
    const cold = runCli(fx, ['--issue', '700']);
    assert.equal(cold.status, 0, cold.stderr);
    const coldReport = JSON.parse(cold.stdout);
    assert.equal(coldReport.cache.mode, 'hint');
    assert.equal(coldReport.cache.source, 'live');
    assert.equal(coldReport.cache.enumerations, 1);
    const callsAfterCold = ghCalls(fx);
    assert.ok(callsAfterCold > 0);
    const warm = runCli(fx, ['--issue', '700']);
    assert.equal(warm.status, 0, warm.stderr);
    const warmReport = JSON.parse(warm.stdout);
    assert.equal(ghCalls(fx), callsAfterCold);
    assert.equal(warmReport.cache.source, 'hint');
    assert.equal(warmReport.cache.enumerations, 0);
    assert.deepEqual(warmReport.executionCandidates, [701]);
    const { cache: _a, ...coldRest } = coldReport;
    const { cache: _b, ...warmRest } = warmReport;
    assert.deepEqual(warmRest, coldRest);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: --no-cache and --refresh-cache always enumerate live', () => {
  const fx = cliFixture(true);
  try {
    runCli(fx, ['--issue', '700']);
    const base = ghCalls(fx);
    const off = runCli(fx, ['--issue', '700', '--no-cache']);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(JSON.parse(off.stdout).cache.mode, 'off');
    const afterOff = ghCalls(fx);
    assert.ok(afterOff > base);
    const refreshed = runCli(fx, ['--issue', '700', '--refresh-cache']);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const refreshedReport = JSON.parse(refreshed.stdout);
    assert.equal(refreshedReport.cache.mode, 'refresh');
    assert.equal(refreshedReport.cache.source, 'live');
    assert.ok(ghCalls(fx) > afterOff);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: --no-cache with --refresh-cache is a usage error', () => {
  const fx = cliFixture(true);
  try {
    const result = runCli(fx, [
      '--issue',
      '700',
      '--no-cache',
      '--refresh-cache',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /--no-cache cannot be combined with --refresh-cache/,
    );
    assert.equal(ghCalls(fx), 0);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: --purge-cache needs no scope flag and empties the cache', () => {
  const fx = cliFixture(true);
  try {
    runCli(fx, ['--issue', '700']);
    assert.ok(
      readdirSync(join(fx.cacheDir, 'entries')).some((name) =>
        name.endsWith('.json'),
      ),
    );
    const purged = runCli(fx, ['--purge-cache']);
    assert.equal(purged.status, 0, purged.stderr);
    const parsed = JSON.parse(purged.stdout);
    assert.equal(parsed.cache.mode, 'purge');
    assert.equal(parsed.cache.cache, 'purged');
    assert.ok(parsed.cache.removed >= 1);
    const before = ghCalls(fx);
    const next = runCli(fx, ['--issue', '700']);
    assert.equal(JSON.parse(next.stdout).cache.source, 'live');
    assert.ok(ghCalls(fx) > before);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: with the feature off the output has no cache object and nothing is cached', () => {
  const fx = cliFixture(false);
  try {
    const first = runCli(fx, ['--issue', '700']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal('cache' in JSON.parse(first.stdout), false);
    const base = ghCalls(fx);
    runCli(fx, ['--issue', '700']);
    assert.ok(ghCalls(fx) > base);
    assert.equal(existsSync(join(fx.root, 'xdg')), false);
    assert.equal(readdirSync(fx.cacheDir).length, 0);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: a usage error is unchanged and never touches the cache', () => {
  const fx = cliFixture(true);
  try {
    const result = runCli(fx, []);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /missing required --issue/,
    );
    assert.equal(readdirSync(fx.cacheDir).length, 0);
    appendFileSync(fx.log, '');
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the union report shape gains only the optional cache object', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701', 'epic-alpha')],
    [701, leaf(701, 5)],
  ]);
  try {
    const live = await read(fx, unionCompute(t, [700]), { noCache: true });
    const plain = await unionCompute(t, [700])();
    assert.deepEqual(withoutCache(live.report), withoutCache(plain));
    assert.equal(live.cache?.mode, 'off');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---- discover-orphan-filter shares the same layer ----

const ORPHAN_STUB = (issues: string, logPath: string) => `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
if (args[0] === "api" && /issues\\?/.test(args[1] || "")) {
  process.stdout.write(${JSON.stringify(issues)});
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view" && args[2] === "900") {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;

const ORPHAN_SCRIPT = 'discover-orphan-filter.mjs';

test('orphan eligibility prefers claim state, then bare presence', () => {
  assert.equal(hasEligibleOrphan({ orphans: [] }), false);
  assert.equal(hasEligibleOrphan({ orphans: [{ number: 1 }] }), true);
  assert.equal(
    hasEligibleOrphan({ orphans: [{ number: 1, claimEligible: false }] }),
    false,
  );
  assert.equal(
    hasEligibleOrphan({
      orphans: [
        { number: 1, claimEligible: false },
        { number: 2, claimEligible: true },
      ],
    }),
    true,
  );
  assert.equal(hasEligibleOrphan(null), false);
  assert.equal(hasEligibleOrphan({}), false);
});

test('CLI orphan filter: an empty cached inventory is refreshed once, never believed', () => {
  const fx = cliFixture(true, (log) => ORPHAN_STUB('[]', log));
  try {
    const cold = runCli(fx, [], ORPHAN_SCRIPT);
    assert.equal(cold.status, 0, cold.stderr);
    const coldReport = JSON.parse(cold.stdout);
    assert.equal(coldReport.cache.source, 'live');
    assert.equal(coldReport.cache.exhaustionRefresh, false);
    const base = ghCalls(fx);
    const again = runCli(fx, [], ORPHAN_SCRIPT);
    assert.equal(again.status, 0, again.stderr);
    const againReport = JSON.parse(again.stdout);
    assert.equal(againReport.cache.exhaustionRefresh, true);
    assert.equal(againReport.cache.source, 'live');
    assert.ok(ghCalls(fx) > base);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI orphan filter: an unresolvable reference keeps its A3 meaning and does not mark the report incomplete', () => {
  const issue = `${JSON.stringify({
    number: 5,
    title: 'needs 900',
    state: 'open',
    body: 'Blocked by #900',
    labels: [],
    html_url: 'https://example.test/5',
  })}\n`;
  const fx = cliFixture(true, (log) => ORPHAN_STUB(issue, log));
  try {
    const first = runCli(fx, [], ORPHAN_SCRIPT);
    assert.equal(first.status, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout);
    assert.equal(firstReport.counts.unresolvable, 1);
    assert.equal(firstReport.cache.complete, true);
    // Nothing eligible remains, so the stored hint is refreshed once rather
    // than believed.
    const second = runCli(fx, [], ORPHAN_SCRIPT);
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.cache.exhaustionRefresh, true);
    assert.equal(secondReport.counts.unresolvable, 1);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI orphan filter: --no-cache, --refresh-cache, and --purge-cache behave like the graph helper', () => {
  const fx = cliFixture(true, (log) => ORPHAN_STUB('[]', log));
  try {
    const conflict = runCli(
      fx,
      ['--no-cache', '--refresh-cache'],
      ORPHAN_SCRIPT,
    );
    assert.notEqual(conflict.status, 0);
    assert.match(
      `${conflict.stdout}${conflict.stderr}`,
      /--no-cache cannot be combined with --refresh-cache/,
    );
    const off = runCli(fx, ['--no-cache'], ORPHAN_SCRIPT);
    assert.equal(JSON.parse(off.stdout).cache.mode, 'off');
    const refreshed = runCli(fx, ['--refresh-cache'], ORPHAN_SCRIPT);
    assert.equal(JSON.parse(refreshed.stdout).cache.mode, 'refresh');
    const purged = runCli(fx, ['--purge-cache'], ORPHAN_SCRIPT);
    assert.equal(JSON.parse(purged.stdout).cache.cache, 'purged');
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI orphan filter: the feature off leaves the output free of a cache object', () => {
  const fx = cliFixture(false, (log) => ORPHAN_STUB('[]', log));
  try {
    const result = runCli(fx, [], ORPHAN_SCRIPT);
    assert.equal(result.status, 0, result.stderr);
    assert.equal('cache' in JSON.parse(result.stdout), false);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---- local-mutation invalidation through the helper paths ----

/** The graph stub plus a comment POST that echoes the body it was sent. */
const MUTATION_STUB = (logPath: string) =>
  GH_STUB(logPath).replace(
    'process.stderr.write("unexpected gh invocation',
    `if (args[0] === "api" && args.includes("POST")) {
  const body = JSON.parse(require("node:fs").readFileSync(0, "utf8")).body;
  process.stdout.write("HTTP/2.0 201 Created\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify({ id: 1, html_url: "https://example.test/c/1", body }));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation`,
  );

const MARKER_SCRIPT = 'post-idd-marker.mjs';

function postMarkerArgs(type: string, extra: string[]): string[] {
  return [
    '--type',
    type,
    '--target',
    'issue',
    '700',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--agent-id',
    'agent-a',
    '--claim-id',
    'claim-1',
    '--timestamp',
    '2026-09-30T00:00:00Z',
    ...extra,
    '--apply',
  ];
}

test('CLI: an unclaim drops the cached hints but a non-claim marker does not', () => {
  const fx = cliFixture(true, MUTATION_STUB);
  try {
    runCli(fx, ['--issue', '700']);
    const warm = runCli(fx, ['--issue', '700']);
    assert.equal(JSON.parse(warm.stdout).cache.source, 'hint');

    const nonce = runCli(
      fx,
      postMarkerArgs('activation-nonce', ['--nonce', 'n-1']),
      MARKER_SCRIPT,
    );
    assert.equal(nonce.status, 0, nonce.stderr);
    const stillWarm = runCli(fx, ['--issue', '700']);
    assert.equal(JSON.parse(stillWarm.stdout).cache.source, 'hint');

    const unclaim = runCli(fx, postMarkerArgs('unclaim', []), MARKER_SCRIPT);
    assert.equal(unclaim.status, 0, unclaim.stderr);
    const after = runCli(fx, ['--issue', '700']);
    assert.equal(JSON.parse(after.stdout).cache.source, 'live');
    assert.equal(JSON.parse(after.stdout).cache.enumerations, 1);
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLI: a claim marker dry run posts nothing and keeps the hints', () => {
  const fx = cliFixture(true, MUTATION_STUB);
  try {
    runCli(fx, ['--issue', '700']);
    const args = postMarkerArgs('unclaim', []).filter(
      (arg) => arg !== '--apply',
    );
    const dry = runCli(fx, args, MARKER_SCRIPT);
    assert.equal(dry.status, 0, dry.stderr);
    const after = runCli(fx, ['--issue', '700']);
    assert.equal(JSON.parse(after.stdout).cache.source, 'hint');
  } finally {
    fx.restore();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Static guard: every helper that closes an issue, merges a PR, or posts a
// claim/unclaim marker must drop the cached hints, so a new mutating path
// cannot silently leave a stale hint serving a claimed or closed target.
test('every mutating helper path invalidates the discover hints', () => {
  const scriptsDir = join(REPO_ROOT, 'src', 'scripts');
  const mutators = /\.(?:closeWorkItem|mergeChangeRequest(?:Admin)?AtRepo)\(/;
  const missing: string[] = [];
  for (const name of readdirSync(scriptsDir)) {
    if (!name.endsWith('.mts') || name.startsWith('provider-')) continue;
    const source = readFileSync(join(scriptsDir, name), 'utf8');
    if (mutators.test(source) && !source.includes('invalidateDiscoverHints(')) {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, []);
  // `force-handoff` reaches the invalidation through an injectable option so
  // unit tests stay off the host cache; its two post sites call that option.
  const expectedHooks: Record<string, [token: string, count: number]> = {
    'post-idd-marker.mts': ['invalidateDiscoverHints(', 1],
    'idd-merge-execute.mts': ['invalidateDiscoverHints(', 2],
    'idd-roadmap-audit-execute.mts': ['invalidateDiscoverHints(', 2],
    'suitability-close-execute.mts': ['invalidateDiscoverHints(', 2],
    'force-handoff.mts': ['invalidateHints(', 2],
  };
  for (const [name, [token, count]] of Object.entries(expectedHooks)) {
    const source = readFileSync(join(scriptsDir, name), 'utf8');
    assert.equal(
      source.split(token).length - 1,
      count,
      `${name} should call ${token} ${count} time(s)`,
    );
  }
});

test('a warm union repeat serves claim-state annotations without a comment read', async () => {
  const fx = fixture();
  const t = tracker([
    [700, roadmap(700, '- [ ] #701', 'epic-alpha')],
    [701, leaf(701, 5)],
  ]);
  let commentReads = 0;
  const claimState = {
    loadComments: () => {
      commentReads += 1;
      return [];
    },
    isTrustedAuthor: () => true,
    staleAgeMs: 24 * 60 * 60 * 1000,
    heartbeatIntervalMs: 12 * 60 * 60 * 1000,
    nowIso: '2026-09-30T00:00:00Z',
    currentClaimId: '',
    currentSessionAgentId: null,
    currentSessionWorktreePath: null,
    currentSessionBranch: null,
    currentSessionOwnsClaimEvidence: false,
  };
  const compute = () =>
    enumerateAllRoadmapsGraph({
      loadOpenRoadmapRoots: async () => [700],
      loadIssue: async (number) => t.issues.get(number) ?? null,
      claimState,
    });
  try {
    const cold = await read(fx, compute);
    assert.equal(commentReads, 1);
    assert.equal(cold.report.leaves[0]?.claimEligible, true);
    const warm = await read(fx, compute);
    assert.equal(commentReads, 1);
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(warm.report.leaves[0]?.claimEligible, true);
    assert.deepEqual(warm.report.leaves[0]?.activeClaim, {
      present: false,
      stale: false,
      claimId: null,
      agentId: null,
      heartbeatOverdue: false,
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Static guard: the hint is a ranking aid only. The two Discover
// enumeration helpers are its sole readers, and no gate module imports the
// hint layer, so a live A3-A5 check cannot be served from it.
test('only the two Discover enumeration helpers read the hint layer', () => {
  const scriptsDir = join(REPO_ROOT, 'src', 'scripts');
  const readers: string[] = [];
  const importers: string[] = [];
  for (const name of readdirSync(scriptsDir)) {
    if (!name.endsWith('.mts') || name === 'discover-hint-cache.mts') continue;
    const source = readFileSync(join(scriptsDir, name), 'utf8');
    if (/\breadDiscoverHint\b/.test(source)) readers.push(name);
    if (source.includes("from './discover-hint-cache.mts'")) {
      importers.push(name);
    }
  }
  assert.deepEqual(readers.sort(), [
    'discover-orphan-filter.mts',
    'discover-roadmap-graph.mts',
  ]);
  assert.deepEqual(importers.sort(), [
    'discover-orphan-filter.mts',
    'discover-roadmap-graph.mts',
    'force-handoff.mts',
    'idd-merge-execute.mts',
    'idd-roadmap-audit-execute.mts',
    'post-idd-marker.mts',
    'suitability-close-execute.mts',
  ]);
});
