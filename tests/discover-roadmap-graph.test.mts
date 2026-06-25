import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOpenRoadmapRootsLoader,
  buildTrustedAuthorPredicate,
  classifyIssue,
  enumerateAllRoadmapsGraph,
  enumerateRoadmapGraph,
  extractKeywordReferences,
  extractRoadmapMarkerId,
  extractTaskListReferences,
  parseClaimStaleAgeMs,
  type SearchIssuesQuery,
  warnOnSearchResultCap,
} from '../src/scripts/discover-roadmap-graph.mts';

/** Run `body` with `process.stderr.write` captured; return the joined output. */
function captureStderr(body: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('extractors classify roadmap markers and outbound references', () => {
  const body = `
<!-- idd-skill-roadmap-id: root-roadmap -->
- [ ] #101
Refs #102
Depends on #103
Closes #104
Sub-issue #105
Fix #106
Resolve #107
`;

  assert.equal(extractRoadmapMarkerId(body), 'root-roadmap');
  assert.deepEqual(extractTaskListReferences(body), [
    { target: 101, relationship: 'task-list', evidence: '- [ ] #101' },
  ]);
  assert.deepEqual(extractKeywordReferences(body), [
    { target: 102, relationship: 'reference', evidence: 'Refs #102' },
    { target: 103, relationship: 'dependency', evidence: 'Depends on #103' },
    { target: 104, relationship: 'closing-keyword', evidence: 'Closes #104' },
    {
      target: 105,
      relationship: 'sub-issue-reference',
      evidence: 'Sub-issue #105',
    },
    { target: 106, relationship: 'closing-keyword', evidence: 'Fix #106' },
    { target: 107, relationship: 'closing-keyword', evidence: 'Resolve #107' },
  ]);
  assert.deepEqual(
    classifyIssue({
      body,
      labels: [{ name: 'Roadmap' }],
    }),
    { kind: 'roadmap', roadmapMarkerId: 'root-roadmap' },
  );
});

test('extractKeywordReferences parses blocked dependencies and multi-target lists', () => {
  const body = `
Refs #201, #202
Blocked by #203
Depends on #204, #205, and #206
Refs: #207
Sub issue: #208
`;

  assert.deepEqual(extractKeywordReferences(body), [
    { target: 201, relationship: 'reference', evidence: 'Refs #201, #202' },
    { target: 202, relationship: 'reference', evidence: 'Refs #201, #202' },
    { target: 203, relationship: 'dependency', evidence: 'Blocked by #203' },
    {
      target: 204,
      relationship: 'dependency',
      evidence: 'Depends on #204, #205, and #206',
    },
    {
      target: 205,
      relationship: 'dependency',
      evidence: 'Depends on #204, #205, and #206',
    },
    {
      target: 206,
      relationship: 'dependency',
      evidence: 'Depends on #204, #205, and #206',
    },
    { target: 207, relationship: 'reference', evidence: 'Refs: #207' },
    {
      target: 208,
      relationship: 'sub-issue-reference',
      evidence: 'Sub issue: #208',
    },
  ]);
});

test('extractTaskListReferences accepts uppercase checked items', () => {
  assert.deepEqual(extractTaskListReferences('- [X] #211'), [
    { target: 211, relationship: 'task-list', evidence: '- [X] #211' },
  ]);
});

test('extractKeywordReferences ignores cross-repository references but keeps same-repo qualified refs', () => {
  const body = `
Refs other/repo#301, #302
Depends on kurone-kito/idd-skill#303
`;

  assert.deepEqual(
    extractKeywordReferences(body, {
      owner: 'kurone-kito',
      repo: 'idd-skill',
    }),
    [
      {
        target: 302,
        relationship: 'reference',
        evidence: 'Refs other/repo#301, #302',
      },
      {
        target: 303,
        relationship: 'dependency',
        evidence: 'Depends on kurone-kito/idd-skill#303',
      },
    ],
  );
});

test('extractKeywordReferences stops before incidental narrative mentions', () => {
  const body = `
Refs #401; similar to #402
Depends on #403, #404 and #405
`;

  assert.deepEqual(extractKeywordReferences(body), [
    {
      target: 401,
      relationship: 'reference',
      evidence: 'Refs #401; similar to #402',
    },
    {
      target: 403,
      relationship: 'dependency',
      evidence: 'Depends on #403, #404 and #405',
    },
    {
      target: 404,
      relationship: 'dependency',
      evidence: 'Depends on #403, #404 and #405',
    },
    {
      target: 405,
      relationship: 'dependency',
      evidence: 'Depends on #403, #404 and #405',
    },
  ]);
});

test('enumerates a flat roadmap graph and separates execution candidates', async () => {
  const issues = new Map([
    [100, roadmapIssue(100, '- [ ] #101\n- [ ] #102', 'root-roadmap')],
    [101, executionIssue(101, 'alpha')],
    [102, executionIssue(102, 'beta')],
  ]);

  const graph = await enumerateRoadmapGraph(100, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, []);
  assert.deepEqual(graph.executionCandidates, [101, 102]);
  assert.deepEqual(graph.edges, [
    {
      source: 100,
      target: 101,
      relationship: 'task-list',
      evidence: '- [ ] #101',
    },
    {
      source: 100,
      target: 102,
      relationship: 'task-list',
      evidence: '- [ ] #102',
    },
  ]);
  assert.deepEqual(graph.provenancePaths, [
    { target: 100, path: [100] },
    { target: 101, path: [100, 101] },
    { target: 102, path: [100, 102] },
  ]);
  assert.equal(graph.summary.executionCandidateCount, 2);
});

test('enumerates a two-level nested roadmap graph', async () => {
  const issues = new Map([
    [150, roadmapIssue(150, '- [ ] #151', 'root-roadmap')],
    [151, roadmapIssue(151, '- [ ] #152', 'nested-roadmap')],
    [152, executionIssue(152, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(150, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, [151]);
  assert.deepEqual(graph.executionCandidates, [152]);
  assert.deepEqual(graph.provenancePaths, [
    { target: 150, path: [150] },
    { target: 151, path: [150, 151] },
    { target: 152, path: [150, 151, 152] },
  ]);
  assert.equal(graph.summary.maxDepth, 2);
});

test('enumerates a three-level nested roadmap graph', async () => {
  const issues = new Map([
    [175, roadmapIssue(175, '- [ ] #176', 'root-roadmap')],
    [176, roadmapIssue(176, '- [ ] #177', 'nested-roadmap-a')],
    [177, roadmapIssue(177, '- [ ] #178', 'nested-roadmap-b')],
    [178, executionIssue(178, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(175, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, [176, 177]);
  assert.deepEqual(graph.executionCandidates, [178]);
  assert.deepEqual(graph.provenancePaths, [
    { target: 175, path: [175] },
    { target: 176, path: [175, 176] },
    { target: 177, path: [175, 176, 177] },
    { target: 178, path: [175, 176, 177, 178] },
  ]);
  assert.equal(graph.summary.maxDepth, 3);
});

test('forces the selected root issue to remain a roadmap', async () => {
  const issues = new Map([
    [180, executionIssue(180, '- [ ] #181')],
    [181, executionIssue(181, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(180, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.equal(graph.root.classification, 'roadmap');
  assert.deepEqual(graph.roadmapNodes, []);
  assert.deepEqual(graph.executionCandidates, [181]);
});

test('keeps traversing through a closed intermediate roadmap to an open descendant', async () => {
  const issues = new Map([
    [200, roadmapIssue(200, '- [ ] #201', 'root-roadmap')],
    [201, roadmapIssue(201, '- [ ] #202', 'nested-roadmap', 'closed')],
    [202, executionIssue(202, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(200, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, [201]);
  assert.deepEqual(graph.executionCandidates, [202]);
  assert.deepEqual(graph.provenancePaths, [
    { target: 200, path: [200] },
    { target: 201, path: [200, 201] },
    { target: 202, path: [200, 201, 202] },
  ]);
});

test('records duplicate references and cycles without recursing forever', async () => {
  const issues = new Map([
    [300, roadmapIssue(300, '- [ ] #301\nRefs #301', 'root-roadmap')],
    [301, executionIssue(301, '- [ ] #300')],
  ]);

  const graph = await enumerateRoadmapGraph(300, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.equal(graph.diagnostics.duplicateReferences.length, 1);
  assert.deepEqual(graph.diagnostics.duplicateReferences[0], {
    source: 300,
    target: 301,
    relationship: 'reference',
    evidence: 'Refs #301',
    firstSeenFrom: 300,
  });
  assert.deepEqual(graph.diagnostics.cycles, [
    {
      source: 301,
      target: 300,
      relationship: 'task-list',
      path: [300, 301, 300],
    },
  ]);
});

test('counts exact duplicate references from the same issue body', async () => {
  const issues = new Map([
    [320, roadmapIssue(320, '- [ ] #321\n- [ ] #321', 'root-roadmap')],
    [321, executionIssue(321, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(320, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.edges, [
    {
      source: 320,
      target: 321,
      relationship: 'task-list',
      evidence: '- [ ] #321',
    },
  ]);
  assert.deepEqual(graph.diagnostics.duplicateReferences, [
    {
      source: 320,
      target: 321,
      relationship: 'task-list',
      evidence: '- [ ] #321',
      firstSeenFrom: 320,
    },
  ]);
});

test('keeps traversing descendants when a shared node is reached through multiple paths', async () => {
  const issues = new Map([
    [350, roadmapIssue(350, '- [ ] #351\n- [ ] #352', 'root-roadmap')],
    [351, executionIssue(351, 'Refs #353')],
    [352, executionIssue(352, 'Refs #353')],
    [353, executionIssue(353, 'Refs #354')],
    [354, executionIssue(354, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(350, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(
    graph.provenancePaths.filter((entry) => entry.target === 354),
    [
      { target: 354, path: [350, 351, 353, 354] },
      { target: 354, path: [350, 352, 353, 354] },
    ],
  );
  assert.deepEqual(graph.diagnostics.duplicateReferences, []);
});

test('re-expands descendants when a shorter ancestry path appears later', async () => {
  const issues = new Map([
    [360, roadmapIssue(360, '- [ ] #361\n- [ ] #363', 'root-roadmap')],
    [361, executionIssue(361, 'Refs #362')],
    [362, executionIssue(362, 'Refs #363')],
    [363, executionIssue(363, 'Refs #364')],
    [364, executionIssue(364, 'leaf execution')],
  ]);

  const graph = await enumerateRoadmapGraph(360, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(
    graph.provenancePaths.filter((entry) => entry.target === 364),
    [
      { target: 364, path: [360, 363, 364] },
      { target: 364, path: [360, 361, 362, 363, 364] },
    ],
  );
  assert.equal(graph.nodes.find((node) => node.number === 363)?.depth, 1);
});

test('reports inaccessible and unresolved references fail-safe', async () => {
  const issues = new Map<number, unknown>([
    [400, roadmapIssue(400, '- [ ] #401\n- [ ] #402', 'root-roadmap')],
    [401, { __iddLookupStatus: 'inaccessible' }],
  ]);

  const graph = await enumerateRoadmapGraph(400, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.executionCandidates, []);
  assert.deepEqual(graph.diagnostics.inaccessibleReferences, [
    {
      source: 400,
      target: 401,
      relationship: 'task-list',
      evidence: '- [ ] #401',
      reason: 'issue_inaccessible',
    },
  ]);
  assert.deepEqual(graph.diagnostics.unresolvedReferences, [
    {
      source: 400,
      target: 402,
      relationship: 'task-list',
      evidence: '- [ ] #402',
      reason: 'issue_not_found',
    },
  ]);
});

test('treats pull request references as unresolved issue targets', async () => {
  const issues = new Map<number, unknown>([
    [410, roadmapIssue(410, '- [ ] #411', 'root-roadmap')],
    [
      411,
      {
        number: 411,
        title: 'pull request 411',
        state: 'open',
        body: '',
        labels: [],
        pull_request: { url: 'https://example.test/pulls/411' },
      },
    ],
  ]);

  const graph = await enumerateRoadmapGraph(410, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.executionCandidates, []);
  assert.deepEqual(graph.diagnostics.unresolvedReferences, [
    {
      source: 410,
      target: 411,
      relationship: 'task-list',
      evidence: '- [ ] #411',
      reason: 'issue_not_found',
    },
  ]);
});

test('includes GitHub sub-issue relationships in the graph', async () => {
  const issues = new Map([
    [500, roadmapIssue(500, '', 'root-roadmap')],
    [501, executionIssue(501, 'sub-issue leaf')],
  ]);

  const graph = await enumerateRoadmapGraph(500, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    loadSubIssues: async (issueNumber) => (issueNumber === 500 ? [501] : []),
  });

  assert.deepEqual(graph.edges, [
    {
      source: 500,
      target: 501,
      relationship: 'sub-issue',
      evidence: 'GitHub sub-issue #501',
    },
  ]);
  assert.deepEqual(graph.executionCandidates, [501]);
});

test('surfaces incomplete descendant lookups instead of silently dropping them', async () => {
  const issues = new Map([[550, roadmapIssue(550, '', 'root-roadmap')]]);

  await assert.rejects(
    () =>
      enumerateRoadmapGraph(550, {
        loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
        loadSubIssues: async () => {
          throw new Error('subIssues connection missing for issue #550');
        },
      }),
    /subIssues connection missing for issue #550/,
  );
});

test('CLI path can enumerate GitHub sub-issues without top-level await initialization bugs', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-roadmap-graph-cli-'),
  );
  const ghPath = join(tempRoot, 'gh');

  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/700") {
  process.stdout.write(JSON.stringify({
    number: 700,
    title: "roadmap 700",
    state: "open",
    body: "<!-- idd-skill-roadmap-id: root-roadmap -->",
    labels: [{ name: "roadmap" }],
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/701") {
  process.stdout.write(JSON.stringify({
    number: 701,
    title: "issue 701",
    state: "open",
    body: "",
    labels: [],
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  const numberArg = args.find((entry) => entry.startsWith("number="));
  const issueNumber = Number.parseInt(String(numberArg ?? "").slice("number=".length), 10);
  const payload = issueNumber === 700
    ? {
        data: {
          repository: {
            issue: {
              subIssues: {
                nodes: [{ number: 701 }],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        },
      }
    : {
        data: {
          repository: {
            issue: {
              subIssues: {
                nodes: [],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        },
      };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/discover-roadmap-graph.mjs'), '--issue', '700'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
      },
    },
  );
  const parsed = JSON.parse(output);

  assert.deepEqual(parsed.roadmapNodes, []);
  assert.deepEqual(parsed.executionCandidates, [701]);
  assert.deepEqual(parsed.edges, [
    {
      source: 700,
      target: 701,
      relationship: 'sub-issue',
      evidence: 'GitHub sub-issue #701',
    },
  ]);
});

test('CLI path treats gh 404 descendants as unresolved references', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-roadmap-graph-404-'),
  );
  const ghPath = join(tempRoot, 'gh');

  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/720") {
  process.stdout.write(JSON.stringify({
    number: 720,
    title: "roadmap 720",
    state: "open",
    body: "<!-- idd-skill-roadmap-id: root-roadmap -->\\n- [ ] #721",
    labels: [{ name: "roadmap" }],
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/kurone-kito/idd-skill/issues/721") {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        issue: {
          subIssues: {
            nodes: [],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      },
    },
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/discover-roadmap-graph.mjs'), '--issue', '720'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
      },
    },
  );
  const parsed = JSON.parse(output);

  assert.deepEqual(parsed.executionCandidates, []);
  assert.deepEqual(parsed.diagnostics.unresolvedReferences, [
    {
      source: 720,
      target: 721,
      relationship: 'task-list',
      evidence: '- [ ] #721',
      reason: 'issue_not_found',
    },
  ]);
});

test('CLI path fails when an explicit policy file is invalid', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-roadmap-graph-policy-'),
  );
  const ghPath = join(tempRoot, 'gh');
  const policyPath = join(tempRoot, 'bad-policy.json');

  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  writeFileSync(policyPath, '{not-json');
  chmodSync(ghPath, 0o755);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/discover-roadmap-graph.mjs'),
          '--issue',
          '700',
          '--policy',
          policyPath,
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
          },
        },
      ),
    /failed to load policy from .*bad-policy\.json/,
  );
});

test('reports when only roadmap nodes remain open', async () => {
  const issues = new Map([
    [600, roadmapIssue(600, '- [ ] #601', 'root-roadmap')],
    [601, roadmapIssue(601, '', 'nested-roadmap')],
  ]);

  const graph = await enumerateRoadmapGraph(600, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, [601]);
  assert.deepEqual(graph.executionCandidates, []);
  assert.equal(graph.summary.executionCandidateCount, 0);
});

function roadmapIssue(
  number: number,
  body: string,
  markerId: string,
  state = 'open',
) {
  return {
    number,
    title: `roadmap ${number}`,
    state,
    body: `<!-- idd-skill-roadmap-id: ${markerId} -->\n${body}`.trim(),
    labels: [{ name: 'roadmap' }],
  };
}

function executionIssue(number: number, body: string, state = 'open') {
  return {
    number,
    title: `issue ${number}`,
    state,
    body,
    labels: [],
  };
}

test('nodes carry the authored autopilot-suitability score (null when unscored)', async () => {
  const issues = new Map([
    [500, roadmapIssue(500, '- [ ] #501\n- [ ] #502', 'score-roadmap')],
    [
      501,
      executionIssue(
        501,
        'task one\n<!-- idd-skill-autopilot-suitability: 5 -->',
      ),
    ],
    [502, executionIssue(502, 'task two with no score')],
  ]);

  const graph = await enumerateRoadmapGraph(500, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  assert.equal(byNumber.get(501)?.autopilotSuitability, 5);
  assert.equal(byNumber.get(502)?.autopilotSuitability, null);
});

function scoredExecutionIssue(number: number, score: number, state = 'open') {
  return executionIssue(
    number,
    `task ${number}\n<!-- idd-skill-autopilot-suitability: ${score} -->`,
    state,
  );
}

// Two sibling epics, one shared leaf, mixed suitability scores.
//
//   700 (epic-alpha) → 701 (score 5), 702 (score 2)
//   800 (epic-beta)  → 702 (shared),  803 (score 4), 804 (no score)
const SIBLING_EPIC_ISSUES = new Map<number, unknown>([
  [700, roadmapIssue(700, '- [ ] #701\n- [ ] #702', 'epic-alpha')],
  [800, roadmapIssue(800, '- [ ] #702\n- [ ] #803\n- [ ] #804', 'epic-beta')],
  [701, scoredExecutionIssue(701, 5)],
  [702, scoredExecutionIssue(702, 2)],
  [803, scoredExecutionIssue(803, 4)],
  [804, executionIssue(804, 'task 804 with no score')],
]);

function loadSiblingEpicIssue(issueNumber: number) {
  return SIBLING_EPIC_ISSUES.get(issueNumber) ?? null;
}

test('all-roadmaps unions open execution leaves across every open roadmap root', async () => {
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700, 800],
    loadIssue: async (issueNumber) => loadSiblingEpicIssue(issueNumber),
  });

  assert.equal(report.mode, 'all-roadmaps');
  assert.deepEqual(
    report.roots.map((root) => root.number),
    [700, 800],
  );
  // Union of leaves under both epics, deduped (702 counted once).
  assert.deepEqual(
    [...report.leaves].map((leaf) => leaf.number).sort((a, b) => a - b),
    [701, 702, 803, 804],
  );
  assert.equal(report.summary.rootCount, 2);
  assert.equal(report.summary.leafCount, 4);
});

test('all-roadmaps records source-root provenance and never double-counts shared leaves', async () => {
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700, 800],
    loadIssue: async (issueNumber) => loadSiblingEpicIssue(issueNumber),
  });

  const byNumber = new Map(report.leaves.map((leaf) => [leaf.number, leaf]));
  // 702 is reachable from both epics: one leaf entry, two source roots.
  assert.deepEqual(byNumber.get(702)?.sourceRoots, [700, 800]);
  assert.deepEqual(byNumber.get(701)?.sourceRoots, [700]);
  assert.deepEqual(byNumber.get(803)?.sourceRoots, [800]);
  assert.deepEqual(byNumber.get(804)?.sourceRoots, [800]);
  // The shared leaf appears exactly once in the union.
  assert.equal(report.leaves.filter((leaf) => leaf.number === 702).length, 1);
  assert.equal(report.summary.sharedLeafCount, 1);
  assert.equal(report.summary.scoredLeafCount, 3);
});

test('all-roadmaps ranks the union by suitability descending, tie-broken by issue number', async () => {
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700, 800],
    loadIssue: async (issueNumber) => loadSiblingEpicIssue(issueNumber),
  });

  // 701 (5) > 803 (4) > [702 (2) and 804 (unscored-floor 3)].
  // 804 is unscored: it uses the floor (3) as its effective score, so it
  // sorts above 702 (score 2), but a coherently scored leaf at the floor
  // would still outrank it.
  assert.deepEqual(
    report.leaves.map((leaf) => leaf.number),
    [701, 803, 804, 702],
  );
});

test('all-roadmaps ranks unscored leaves at the configured floor', async () => {
  // With the configured floor at 1, an unscored leaf ranks at effective 1
  // — now BELOW 702 (score 2), reversing the default-floor (3) ordering
  // where 804 sorted above 702. This pins that the comparator honors the
  // configured floor, not the hard-coded default.
  const report = await enumerateAllRoadmapsGraph({
    floor: 1,
    loadOpenRoadmapRoots: async () => [700, 800],
    loadIssue: async (issueNumber) => loadSiblingEpicIssue(issueNumber),
  });

  // 701 (5) > 803 (4) > 702 (2) > 804 (unscored, configured floor 1).
  assert.deepEqual(
    report.leaves.map((leaf) => leaf.number),
    [701, 803, 702, 804],
  );
});

function scoredEffortExecutionIssue(
  number: number,
  score: number,
  effort: string,
  state = 'open',
) {
  return executionIssue(
    number,
    `task ${number}\n<!-- idd-skill-autopilot-suitability: ${score} -->\n<!-- idd-skill-effort: ${effort} -->`,
    state,
  );
}

// One epic, four same-score leaves with mixed effort hints.
//   900 (epic-effort) → 901 (3, L), 902 (3, S), 903 (3, no hint), 904 (3, S)
const EFFORT_TIE_ISSUES = new Map<number, unknown>([
  [900, roadmapIssue(900, '- [ ] #901\n- [ ] #902\n- [ ] #903\n- [ ] #904', 'epic-effort')],
  [901, scoredEffortExecutionIssue(901, 3, 'L')],
  [902, scoredEffortExecutionIssue(902, 3, 'S')],
  [903, scoredExecutionIssue(903, 3)],
  [904, scoredEffortExecutionIssue(904, 3, 'S')],
]);

test('all-roadmaps applies the effort hint as a soft tie-breaker within a score band', async () => {
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [900],
    loadIssue: async (issueNumber) => EFFORT_TIE_ISSUES.get(issueNumber) ?? null,
  });

  // All four share suitability 3, so the effort hint orders the band: the two
  // `S` leaves first (lowest-number-tie-broken 902 < 904), then the no-hint
  // neutral 903, then `L` 901. Effort never crosses a score band and never
  // drops a leaf.
  assert.deepEqual(
    report.leaves.map((leaf) => leaf.number),
    [902, 904, 903, 901],
  );
  // The parsed hint is emitted per leaf for the cheap A4 Step 2 read.
  const byNumber = new Map(report.leaves.map((leaf) => [leaf.number, leaf]));
  assert.equal(byNumber.get(902)?.effort, 'S');
  assert.equal(byNumber.get(903)?.effort, null);
  assert.equal(byNumber.get(901)?.effort, 'L');
});

test('all-roadmaps keeps scored work above an unscored leaf at the same effective score', async () => {
  const issues = new Map<number, unknown>([
    [900, roadmapIssue(900, '- [ ] #901\n- [ ] #902', 'epic-floor')],
    // 901 carries a coherent floor-value score; 902 is unscored and thus
    // treated as the floor for ordering — scored work must sort first.
    [901, scoredExecutionIssue(901, 3)],
    [902, executionIssue(902, 'unscored leaf')],
  ]);

  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [900],
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(
    report.leaves.map((leaf) => leaf.number),
    [901, 902],
  );
});

test('all-roadmaps tie-breaks equal scores by ascending issue number', async () => {
  const issues = new Map<number, unknown>([
    [1000, roadmapIssue(1000, '- [ ] #1003\n- [ ] #1001', 'epic-ties')],
    [1003, scoredExecutionIssue(1003, 4)],
    [1001, scoredExecutionIssue(1001, 4)],
  ]);

  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [1000],
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(
    report.leaves.map((leaf) => leaf.number),
    [1001, 1003],
  );
});

test('all-roadmaps returns an empty union when no open roadmap roots exist', async () => {
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [],
    loadIssue: async () => null,
  });

  assert.deepEqual(report.roots, []);
  assert.deepEqual(report.leaves, []);
  assert.equal(report.summary.rootCount, 0);
  assert.equal(report.summary.leafCount, 0);
});

test('single-root --issue output is unchanged by the all-roadmaps addition', async () => {
  const issues = new Map([
    [100, roadmapIssue(100, '- [ ] #101\n- [ ] #102', 'root-roadmap')],
    [101, executionIssue(101, 'alpha')],
    [102, executionIssue(102, 'beta')],
  ]);

  const graph = await enumerateRoadmapGraph(100, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  // The single-root report carries no union-only fields (mode / leaves /
  // sourceRoots): its top-level shape is byte-stable with the contract.
  const graphRecord = graph as unknown as Record<string, unknown>;
  assert.equal(graphRecord.mode, undefined);
  assert.equal(graphRecord.leaves, undefined);
  assert.equal(graphRecord.roots, undefined);
  for (const node of graph.nodes) {
    assert.equal(
      Object.hasOwn(node as unknown as Record<string, unknown>, 'sourceRoots'),
      false,
    );
  }
  assert.deepEqual(graph.executionCandidates, [101, 102]);
});

test('all-roadmaps requires the open-roadmap-roots loader', async () => {
  await assert.rejects(
    () =>
      enumerateAllRoadmapsGraph({
        loadIssue: async () => null,
      }),
    /requires loadOpenRoadmapRoots/,
  );
});

test('CLI rejects combining --issue with --all-roadmaps', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-roadmap-graph-mutex-'),
  );
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/discover-roadmap-graph.mjs'),
          '--issue',
          '700',
          '--all-roadmaps',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
          },
        },
      ),
    /--all-roadmaps cannot be combined with --issue/,
  );
});

test('CLI requires --issue when --all-roadmaps is absent', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-discover-roadmap-graph-no-args-'),
  );
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/discover-roadmap-graph.mjs')],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
          },
        },
      ),
    /missing required --issue/,
  );
});

// ---------------------------------------------------------------------------
// Search-narrowed open-roadmap-root discovery (#1017).
//
// The live loader narrows root discovery to two cheap server-side searches
// (a `--label roadmap` search and a body-marker `--match body` search) and
// re-confirms marker candidates against the body the search already returned,
// instead of fetching every open issue's body. These tests inject a stubbed
// `searchIssues` runner at that seam to pin: both root kinds are discovered,
// a non-marker body hit is dropped, and no full open-issue scan happens.
// ---------------------------------------------------------------------------

test('open-roadmap-roots loader unions label roots and re-confirmed marker roots', async () => {
  const queries: SearchIssuesQuery[] = [];
  const searchIssues = (query: SearchIssuesQuery) => {
    queries.push(query);
    if (query.label === 'roadmap') {
      // Labeled roots returned out of insertion order on purpose: 702 before
      // 701 so the loader cannot rely on search/Set order for its ascending
      // contract.
      return [{ number: 702 }, { number: 701 }];
    }
    if (query.matchBody) {
      // Body-marker candidates: 703 carries a real marker (kept on
      // re-confirm); 704 is a non-marker token hit (dropped); 701 also
      // surfaces here and must dedupe against the label root.
      return [
        { number: 703, body: '<!-- idd-skill-roadmap-id: marker-only -->' },
        { number: 704, body: 'mentions roadmap-id in prose but no marker' },
        { number: 701, body: '<!-- idd-skill-roadmap-id: also-labeled -->' },
      ];
    }
    return [];
  };

  const loadRoots = buildOpenRoadmapRootsLoader(
    'kurone-kito',
    'idd-skill',
    'idd-skill',
    searchIssues,
  );
  const roots = await loadRoots();

  // 701 + 702 (label roots) ∪ 703 (re-confirmed marker root); 704 dropped
  // because its body carries no marker, 701 deduped across both searches.
  // The loader's documented contract is deduped + ASCENDING, so the raw
  // return must already be sorted even though the stub yielded 702 before 701
  // and surfaced 703 only via the marker search (no caller-side sort here).
  assert.deepEqual(roots, [701, 702, 703]);

  // Exactly two server-side searches: one exact `--label roadmap` (no body
  // requested) and one body-marker `--match body` carrying the prefixed
  // marker token. No full open-issue body scan is performed.
  assert.equal(queries.length, 2);
  const labelQuery = queries.find((query) => query.label === 'roadmap');
  assert.deepEqual(labelQuery?.fields, ['number']);
  assert.equal(labelQuery?.matchBody, undefined);
  const markerQuery = queries.find((query) => query.matchBody);
  assert.equal(markerQuery?.matchBody, 'idd-skill-roadmap-id');
  assert.deepEqual(markerQuery?.fields, ['number', 'body']);
  assert.equal(markerQuery?.label, undefined);
});

test('open-roadmap-roots loader honors a custom marker prefix in the body search', async () => {
  const queries: SearchIssuesQuery[] = [];
  const searchIssues = (query: SearchIssuesQuery) => {
    queries.push(query);
    if (query.matchBody) {
      return [{ number: 810, body: '<!-- acme-roadmap-id: scoped -->' }];
    }
    return [];
  };

  const roots = await buildOpenRoadmapRootsLoader(
    'kurone-kito',
    'idd-skill',
    'acme',
    searchIssues,
  )();

  // The custom prefix flows into both the search token and the re-confirm
  // regex, so the `acme-` marker is discovered.
  assert.deepEqual(roots, [810]);
  assert.equal(
    queries.find((query) => query.matchBody)?.matchBody,
    'acme-roadmap-id',
  );
});

test('open-roadmap-roots loader warns on the 1000-result search cap', () => {
  // Below the cap: no warning is emitted (the common case stays silent).
  const belowCap = captureStderr(() => {
    warnOnSearchResultCap(new Array(999).fill({ number: 1 }), 'label');
  });
  assert.equal(belowCap, '');

  // At the cap: a single NON-FATAL warning line goes to stderr (the JSON
  // report goes to stdout, so this never corrupts the report stream), naming
  // which search saturated so root discovery is no longer silently truncated.
  const atCap = captureStderr(() => {
    warnOnSearchResultCap(new Array(1000).fill({ number: 1 }), 'body-marker');
  });
  assert.match(atCap, /hit the 1000-result cap \(body-marker\)/u);
  assert.match(atCap, /root discovery may be incomplete/u);
  // Exactly one warning line.
  assert.equal(atCap.trimEnd().split('\n').length, 1);
});

// ---------------------------------------------------------------------------
// --with-claim-state annotation (#1008).
// ---------------------------------------------------------------------------

const CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIM_NOW = '2026-06-25T12:00:00Z';

// A claim posted recently relative to CLAIM_NOW is non-stale; one posted
// well over the 24h stale age earlier is stale.
const FRESH_CLAIM_AT = '2026-06-25T06:00:00Z';
const STALE_CLAIM_AT = '2026-06-20T06:00:00Z';

function claimComment(
  agentId: string,
  claimId: string,
  createdAt: string,
  { author = 'kurone-kito', branch = 'issue/700-task' } = {},
) {
  return {
    body: `<!-- claimed-by: ${agentId} ${claimId} supersedes: none ${createdAt} branch: ${branch} -->`,
    createdAt,
    author: { login: author },
  };
}

function buildClaimState(
  commentsByIssue: Map<number, unknown[]>,
  {
    currentClaimId = '',
    trustedActors = ['kurone-kito'],
    staleAgeMs = CLAIM_STALE_AGE_MS,
  }: {
    currentClaimId?: string;
    trustedActors?: string[];
    staleAgeMs?: number;
  } = {},
) {
  const trusted = new Set(trustedActors.map((value) => value.toLowerCase()));
  const seen: number[] = [];
  return {
    seen,
    resolution: {
      loadComments: (issueNumber: number) => {
        seen.push(issueNumber);
        return commentsByIssue.get(issueNumber) ?? [];
      },
      isTrustedAuthor: (login: string) =>
        trusted.has(String(login ?? '').toLowerCase()),
      staleAgeMs,
      nowIso: CLAIM_NOW,
      currentClaimId,
    },
  };
}

// One epic (700) → two open execution leaves (701, 702).
function claimGraphIssues() {
  return new Map<number, unknown>([
    [700, roadmapIssue(700, '- [ ] #701\n- [ ] #702', 'epic-claim')],
    [701, executionIssue(701, 'leaf 701')],
    [702, executionIssue(702, 'leaf 702')],
  ]);
}

test('without --with-claim-state, leaves carry no claim fields and fetch no comments', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { seen } = buildClaimState(commentsByIssue);

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    // claimState intentionally omitted (default path).
  });

  // No claim fields are present on any node.
  for (const node of graph.nodes) {
    const record = node as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(record, 'activeClaim'), false);
    assert.equal(Object.hasOwn(record, 'claimEligible'), false);
  }
  // No comment fetch happened — the loader was never invoked.
  assert.deepEqual(seen, []);
});

test('--all-roadmaps without claim state leaves the union shape byte-stable', async () => {
  const issues = claimGraphIssues();
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700],
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  for (const leaf of report.leaves) {
    const record = leaf as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(record, 'activeClaim'), false);
    assert.equal(Object.hasOwn(record, 'claimEligible'), false);
  }
});

test('a present non-stale claim marks the leaf claimEligible:false', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution, seen } = buildClaimState(commentsByIssue);

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: false,
    claimId: 'claim-701',
    agentId: 'agent-a',
  });
  assert.equal(leaf701?.claimEligible, false);
  // Only the open execution leaves are probed (not the roadmap root 700).
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [701, 702],
  );
});

test('a stale claim is takeover-eligible: present:true, stale:true, claimEligible:true', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', STALE_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: true,
    claimId: 'claim-701',
    agentId: 'agent-a',
  });
  assert.equal(leaf701?.claimEligible, true);
});

test('an unclaimed leaf is eligible: present:false, claimEligible:true', async () => {
  const issues = claimGraphIssues();
  // 702 has no comments at all.
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  const leaf702 = byNumber.get(702);
  assert.deepEqual(leaf702?.activeClaim, {
    present: false,
    stale: false,
    claimId: null,
    agentId: null,
  });
  assert.equal(leaf702?.claimEligible, true);
});

test('an untrusted-author claim does not block the leaf', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [
      701,
      [
        claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT, {
          author: 'random-drive-by',
        }),
      ],
    ],
  ]);
  // Only kurone-kito is trusted, so the marker is ignored → no present claim.
  const { resolution } = buildClaimState(commentsByIssue);

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  const leaf701 = byNumber.get(701);
  assert.equal(leaf701?.activeClaim?.present, false);
  assert.equal(leaf701?.claimEligible, true);
});

test('IDD_TRUSTED_MARKER_ACTORS env override honors an actor absent from policy', async () => {
  // `env-trusted-bot` is NOT in policy `trustedMarkerActors`, so a claim it
  // authors is only honored when the env override is consulted.
  const previous = process.env.IDD_TRUSTED_MARKER_ACTORS;
  process.env.IDD_TRUSTED_MARKER_ACTORS = 'env-trusted-bot';
  try {
    const issues = claimGraphIssues();
    const commentsByIssue = new Map<number, unknown[]>([
      [
        701,
        [
          claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT, {
            author: 'env-trusted-bot',
          }),
        ],
      ],
    ]);
    // Build the resolution through the real, env-aware trusted-actor
    // predicate (config trusts only `kurone-kito`).
    const { resolution } = buildClaimState(commentsByIssue);
    resolution.isTrustedAuthor = buildTrustedAuthorPredicate({
      trustedMarkerActors: ['kurone-kito'],
    });

    const graph = await enumerateRoadmapGraph(700, {
      loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
      claimState: resolution,
    });

    const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
    const leaf701 = byNumber.get(701);
    // The env-trusted author's fresh claim is now honored.
    assert.equal(leaf701?.activeClaim?.present, true);
    assert.equal(leaf701?.claimEligible, false);
  } finally {
    if (previous === undefined) {
      delete process.env.IDD_TRUSTED_MARKER_ACTORS;
    } else {
      process.env.IDD_TRUSTED_MARKER_ACTORS = previous;
    }
  }
});

test('--current-claim-id sets ownedByCurrentSession on the matching claim', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
    [702, [claimComment('agent-b', 'claim-702', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue, {
    currentClaimId: 'claim-701',
  });

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  // Matching claim id → owned by the current session.
  assert.equal(byNumber.get(701)?.activeClaim?.ownedByCurrentSession, true);
  // Non-matching claim id → not owned, but the flag is still emitted.
  assert.equal(byNumber.get(702)?.activeClaim?.ownedByCurrentSession, false);
});

test('--current-claim-id emits ownedByCurrentSession:false on an unclaimed leaf', async () => {
  const issues = claimGraphIssues();
  const { resolution } = buildClaimState(new Map(), {
    currentClaimId: 'claim-701',
  });

  const graph = await enumerateRoadmapGraph(700, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  assert.deepEqual(byNumber.get(701)?.activeClaim, {
    present: false,
    stale: false,
    claimId: null,
    agentId: null,
    ownedByCurrentSession: false,
  });
});

test('--all-roadmaps annotates union leaves and fetches each issue once', async () => {
  // Two epics share leaf 702; with claim state it must be fetched once.
  const issues = new Map<number, unknown>([
    [700, roadmapIssue(700, '- [ ] #701\n- [ ] #702', 'epic-alpha')],
    [800, roadmapIssue(800, '- [ ] #702\n- [ ] #803', 'epic-beta')],
    [701, executionIssue(701, 'leaf 701')],
    [702, executionIssue(702, 'shared leaf 702')],
    [803, executionIssue(803, 'leaf 803')],
  ]);
  const commentsByIssue = new Map<number, unknown[]>([
    [702, [claimComment('agent-a', 'claim-702', FRESH_CLAIM_AT)]],
  ]);
  const { resolution, seen } = buildClaimState(commentsByIssue);

  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700, 800],
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    claimState: resolution,
  });

  const byNumber = new Map(report.leaves.map((leaf) => [leaf.number, leaf]));
  // Shared, claimed leaf 702: present non-stale claim → not eligible.
  assert.equal(byNumber.get(702)?.activeClaim?.present, true);
  assert.equal(byNumber.get(702)?.claimEligible, false);
  // Unclaimed leaves are eligible.
  assert.equal(byNumber.get(701)?.claimEligible, true);
  assert.equal(byNumber.get(803)?.claimEligible, true);
  // The shared leaf 702 is fetched exactly once even though two roots reach it.
  assert.equal(seen.filter((issueNumber) => issueNumber === 702).length, 1);
});

test('parseClaimStaleAgeMs rejects non-positive and garbage durations', () => {
  // A non-positive stale age would configure a 0ms window that marks every
  // claim immediately stale; reject it so callers fall back to the default.
  assert.equal(parseClaimStaleAgeMs('PT0S'), null);
  assert.equal(parseClaimStaleAgeMs('PT0H0M0S'), null);
  assert.equal(parseClaimStaleAgeMs('P0D'), null);
  assert.equal(parseClaimStaleAgeMs('PT'), null);
  assert.equal(parseClaimStaleAgeMs('P'), null);
  assert.equal(parseClaimStaleAgeMs(''), null);
  assert.equal(parseClaimStaleAgeMs('garbage'), null);
  assert.equal(parseClaimStaleAgeMs(undefined), null);
  // A coherent positive duration still parses.
  assert.equal(parseClaimStaleAgeMs('PT24H'), CLAIM_STALE_AGE_MS);
  assert.equal(parseClaimStaleAgeMs('PT1S'), 1000);
});

test('a PT0S staleAge falls back to the default 24h window, not 0ms', async () => {
  const issues = claimGraphIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  // The CLI resolves the configured staleAge via parseClaimStaleAgeMs and
  // falls back to the default when it returns null. A PT0S policy must NOT
  // configure a 0ms window — a literal 0ms would mark even the fresh claim
  // stale. Mirror that fallback here and confirm the fresh claim stays
  // non-stale (eligible:false), as the default 24h behavior demands.
  for (const staleAge of ['PT0S', 'PT0H0M0S', 'garbage', '']) {
    const staleAgeMs = parseClaimStaleAgeMs(staleAge) ?? CLAIM_STALE_AGE_MS;
    assert.equal(
      staleAgeMs,
      CLAIM_STALE_AGE_MS,
      `non-positive/garbage staleAge ${JSON.stringify(staleAge)} should fall back to the default`,
    );

    const { resolution } = buildClaimState(commentsByIssue, { staleAgeMs });
    const graph = await enumerateRoadmapGraph(700, {
      loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
      claimState: resolution,
    });

    const leaf701 = new Map(graph.nodes.map((node) => [node.number, node])).get(
      701,
    );
    // The fresh claim is present and non-stale → it still blocks the leaf,
    // rather than being wrongly treated as stale by a 0ms window.
    assert.deepEqual(
      leaf701?.activeClaim,
      { present: true, stale: false, claimId: 'claim-701', agentId: 'agent-a' },
      `staleAge ${JSON.stringify(staleAge)} should not mark a fresh claim stale`,
    );
    assert.equal(leaf701?.claimEligible, false);
  }
});
