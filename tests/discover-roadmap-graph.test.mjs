import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  classifyIssue,
  enumerateRoadmapGraph,
  extractKeywordReferences,
  extractRoadmapMarkerId,
  extractTaskListReferences,
} from "../scripts/discover-roadmap-graph.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("extractors classify roadmap markers and outbound references", () => {
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

  assert.equal(extractRoadmapMarkerId(body), "root-roadmap");
  assert.deepEqual(extractTaskListReferences(body), [
    { target: 101, relationship: "task-list", evidence: "- [ ] #101" },
  ]);
  assert.deepEqual(extractKeywordReferences(body), [
    { target: 102, relationship: "reference", evidence: "Refs #102" },
    { target: 103, relationship: "dependency", evidence: "Depends on #103" },
    { target: 104, relationship: "closing-keyword", evidence: "Closes #104" },
    { target: 105, relationship: "sub-issue-reference", evidence: "Sub-issue #105" },
    { target: 106, relationship: "closing-keyword", evidence: "Fix #106" },
    { target: 107, relationship: "closing-keyword", evidence: "Resolve #107" },
  ]);
  assert.deepEqual(
    classifyIssue({
      body,
      labels: [{ name: "Roadmap" }],
    }),
    { kind: "roadmap", roadmapMarkerId: "root-roadmap" },
  );
});

test("extractKeywordReferences parses blocked dependencies and multi-target lists", () => {
  const body = `
Refs #201, #202
Blocked by #203
Depends on #204, #205, and #206
Refs: #207
Sub issue: #208
`;

  assert.deepEqual(extractKeywordReferences(body), [
    { target: 201, relationship: "reference", evidence: "Refs #201, #202" },
    { target: 202, relationship: "reference", evidence: "Refs #201, #202" },
    { target: 203, relationship: "dependency", evidence: "Blocked by #203" },
    { target: 204, relationship: "dependency", evidence: "Depends on #204, #205, and #206" },
    { target: 205, relationship: "dependency", evidence: "Depends on #204, #205, and #206" },
    { target: 206, relationship: "dependency", evidence: "Depends on #204, #205, and #206" },
    { target: 207, relationship: "reference", evidence: "Refs: #207" },
    { target: 208, relationship: "sub-issue-reference", evidence: "Sub issue: #208" },
  ]);
});

test("extractTaskListReferences accepts uppercase checked items", () => {
  assert.deepEqual(extractTaskListReferences("- [X] #211"), [
    { target: 211, relationship: "task-list", evidence: "- [X] #211" },
  ]);
});

test("extractKeywordReferences ignores cross-repository references but keeps same-repo qualified refs", () => {
  const body = `
Refs other/repo#301, #302
Depends on kurone-kito/idd-skill#303
`;

  assert.deepEqual(extractKeywordReferences(body, {
    owner: "kurone-kito",
    repo: "idd-skill",
  }), [
    { target: 302, relationship: "reference", evidence: "Refs other/repo#301, #302" },
    { target: 303, relationship: "dependency", evidence: "Depends on kurone-kito/idd-skill#303" },
  ]);
});

test("extractKeywordReferences stops before incidental narrative mentions", () => {
  const body = `
Refs #401; similar to #402
Depends on #403, #404 and #405
`;

  assert.deepEqual(extractKeywordReferences(body), [
    { target: 401, relationship: "reference", evidence: "Refs #401; similar to #402" },
    { target: 403, relationship: "dependency", evidence: "Depends on #403, #404 and #405" },
    { target: 404, relationship: "dependency", evidence: "Depends on #403, #404 and #405" },
    { target: 405, relationship: "dependency", evidence: "Depends on #403, #404 and #405" },
  ]);
});

test("enumerates a flat roadmap graph and separates execution candidates", async () => {
  const issues = new Map([
    [100, roadmapIssue(100, "- [ ] #101\n- [ ] #102", "root-roadmap")],
    [101, executionIssue(101, "alpha")],
    [102, executionIssue(102, "beta")],
  ]);

  const graph = await enumerateRoadmapGraph(100, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, []);
  assert.deepEqual(graph.executionCandidates, [101, 102]);
  assert.deepEqual(graph.edges, [
    { source: 100, target: 101, relationship: "task-list", evidence: "- [ ] #101" },
    { source: 100, target: 102, relationship: "task-list", evidence: "- [ ] #102" },
  ]);
  assert.deepEqual(graph.provenancePaths, [
    { target: 100, path: [100] },
    { target: 101, path: [100, 101] },
    { target: 102, path: [100, 102] },
  ]);
  assert.equal(graph.summary.executionCandidateCount, 2);
});

test("enumerates a two-level nested roadmap graph", async () => {
  const issues = new Map([
    [150, roadmapIssue(150, "- [ ] #151", "root-roadmap")],
    [151, roadmapIssue(151, "- [ ] #152", "nested-roadmap")],
    [152, executionIssue(152, "leaf execution")],
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

test("enumerates a three-level nested roadmap graph", async () => {
  const issues = new Map([
    [175, roadmapIssue(175, "- [ ] #176", "root-roadmap")],
    [176, roadmapIssue(176, "- [ ] #177", "nested-roadmap-a")],
    [177, roadmapIssue(177, "- [ ] #178", "nested-roadmap-b")],
    [178, executionIssue(178, "leaf execution")],
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

test("forces the selected root issue to remain a roadmap", async () => {
  const issues = new Map([
    [180, executionIssue(180, "- [ ] #181")],
    [181, executionIssue(181, "leaf execution")],
  ]);

  const graph = await enumerateRoadmapGraph(180, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.equal(graph.root.classification, "roadmap");
  assert.deepEqual(graph.roadmapNodes, []);
  assert.deepEqual(graph.executionCandidates, [181]);
});

test("keeps traversing through a closed intermediate roadmap to an open descendant", async () => {
  const issues = new Map([
    [200, roadmapIssue(200, "- [ ] #201", "root-roadmap")],
    [201, roadmapIssue(201, "- [ ] #202", "nested-roadmap", "closed")],
    [202, executionIssue(202, "leaf execution")],
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

test("records duplicate references and cycles without recursing forever", async () => {
  const issues = new Map([
    [300, roadmapIssue(300, "- [ ] #301\nRefs #301", "root-roadmap")],
    [301, executionIssue(301, "- [ ] #300")],
  ]);

  const graph = await enumerateRoadmapGraph(300, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.equal(graph.diagnostics.duplicateReferences.length, 1);
  assert.deepEqual(graph.diagnostics.duplicateReferences[0], {
    source: 300,
    target: 301,
    relationship: "reference",
    evidence: "Refs #301",
    firstSeenFrom: 300,
  });
  assert.deepEqual(graph.diagnostics.cycles, [
    {
      source: 301,
      target: 300,
      relationship: "task-list",
      path: [300, 301, 300],
    },
  ]);
});

test("counts exact duplicate references from the same issue body", async () => {
  const issues = new Map([
    [320, roadmapIssue(320, "- [ ] #321\n- [ ] #321", "root-roadmap")],
    [321, executionIssue(321, "leaf execution")],
  ]);

  const graph = await enumerateRoadmapGraph(320, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.edges, [
    { source: 320, target: 321, relationship: "task-list", evidence: "- [ ] #321" },
  ]);
  assert.deepEqual(graph.diagnostics.duplicateReferences, [
    {
      source: 320,
      target: 321,
      relationship: "task-list",
      evidence: "- [ ] #321",
      firstSeenFrom: 320,
    },
  ]);
});

test("keeps traversing descendants when a shared node is reached through multiple paths", async () => {
  const issues = new Map([
    [350, roadmapIssue(350, "- [ ] #351\n- [ ] #352", "root-roadmap")],
    [351, executionIssue(351, "Refs #353")],
    [352, executionIssue(352, "Refs #353")],
    [353, executionIssue(353, "Refs #354")],
    [354, executionIssue(354, "leaf execution")],
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

test("re-expands descendants when a shorter ancestry path appears later", async () => {
  const issues = new Map([
    [360, roadmapIssue(360, "- [ ] #361\n- [ ] #363", "root-roadmap")],
    [361, executionIssue(361, "Refs #362")],
    [362, executionIssue(362, "Refs #363")],
    [363, executionIssue(363, "Refs #364")],
    [364, executionIssue(364, "leaf execution")],
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

test("reports inaccessible and unresolved references fail-safe", async () => {
  const issues = new Map([
    [400, roadmapIssue(400, "- [ ] #401\n- [ ] #402", "root-roadmap")],
    [401, { __iddLookupStatus: "inaccessible" }],
  ]);

  const graph = await enumerateRoadmapGraph(400, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.executionCandidates, []);
  assert.deepEqual(graph.diagnostics.inaccessibleReferences, [
    {
      source: 400,
      target: 401,
      relationship: "task-list",
      evidence: "- [ ] #401",
      reason: "issue_inaccessible",
    },
  ]);
  assert.deepEqual(graph.diagnostics.unresolvedReferences, [
    {
      source: 400,
      target: 402,
      relationship: "task-list",
      evidence: "- [ ] #402",
      reason: "issue_not_found",
    },
  ]);
});

test("treats pull request references as unresolved issue targets", async () => {
  const issues = new Map([
    [410, roadmapIssue(410, "- [ ] #411", "root-roadmap")],
    [411, {
      number: 411,
      title: "pull request 411",
      state: "open",
      body: "",
      labels: [],
      pull_request: { url: "https://example.test/pulls/411" },
    }],
  ]);

  const graph = await enumerateRoadmapGraph(410, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.executionCandidates, []);
  assert.deepEqual(graph.diagnostics.unresolvedReferences, [
    {
      source: 410,
      target: 411,
      relationship: "task-list",
      evidence: "- [ ] #411",
      reason: "issue_not_found",
    },
  ]);
});

test("includes GitHub sub-issue relationships in the graph", async () => {
  const issues = new Map([
    [500, roadmapIssue(500, "", "root-roadmap")],
    [501, executionIssue(501, "sub-issue leaf")],
  ]);

  const graph = await enumerateRoadmapGraph(500, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
    loadSubIssues: async (issueNumber) => (
      issueNumber === 500 ? [501] : []
    ),
  });

  assert.deepEqual(graph.edges, [
    {
      source: 500,
      target: 501,
      relationship: "sub-issue",
      evidence: "GitHub sub-issue #501",
    },
  ]);
  assert.deepEqual(graph.executionCandidates, [501]);
});

test("surfaces incomplete descendant lookups instead of silently dropping them", async () => {
  const issues = new Map([
    [550, roadmapIssue(550, "", "root-roadmap")],
  ]);

  await assert.rejects(
    () => enumerateRoadmapGraph(550, {
      loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
      loadSubIssues: async () => {
        throw new Error("subIssues connection missing for issue #550");
      },
    }),
    /subIssues connection missing for issue #550/,
  );
});

test("CLI path can enumerate GitHub sub-issues without top-level await initialization bugs", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "idd-discover-roadmap-graph-cli-"));
  const ghPath = join(tempRoot, "gh");

  writeFileSync(ghPath, `#!/usr/bin/env node
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
`);
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/discover-roadmap-graph.mjs"), "--issue", "700"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
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
      relationship: "sub-issue",
      evidence: "GitHub sub-issue #701",
    },
  ]);
});

test("CLI path treats gh 404 descendants as unresolved references", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "idd-discover-roadmap-graph-404-"));
  const ghPath = join(tempRoot, "gh");

  writeFileSync(ghPath, `#!/usr/bin/env node
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
`);
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/discover-roadmap-graph.mjs"), "--issue", "720"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
      },
    },
  );
  const parsed = JSON.parse(output);

  assert.deepEqual(parsed.executionCandidates, []);
  assert.deepEqual(parsed.diagnostics.unresolvedReferences, [
    {
      source: 720,
      target: 721,
      relationship: "task-list",
      evidence: "- [ ] #721",
      reason: "issue_not_found",
    },
  ]);
});

test("CLI path fails when an explicit policy file is invalid", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "idd-discover-roadmap-graph-policy-"));
  const ghPath = join(tempRoot, "gh");
  const policyPath = join(tempRoot, "bad-policy.json");

  writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  writeFileSync(policyPath, "{not-json");
  chmodSync(ghPath, 0o755);

  assert.throws(
    () => execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/discover-roadmap-graph.mjs"), "--issue", "700", "--policy", policyPath],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
        },
      },
    ),
    /failed to load policy from .*bad-policy\.json/,
  );
});

test("reports when only roadmap nodes remain open", async () => {
  const issues = new Map([
    [600, roadmapIssue(600, "- [ ] #601", "root-roadmap")],
    [601, roadmapIssue(601, "", "nested-roadmap")],
  ]);

  const graph = await enumerateRoadmapGraph(600, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  assert.deepEqual(graph.roadmapNodes, [601]);
  assert.deepEqual(graph.executionCandidates, []);
  assert.equal(graph.summary.executionCandidateCount, 0);
});

function roadmapIssue(number, body, markerId, state = "open") {
  return {
    number,
    title: `roadmap ${number}`,
    state,
    body: `<!-- idd-skill-roadmap-id: ${markerId} -->\n${body}`.trim(),
    labels: [{ name: "roadmap" }],
  };
}

function executionIssue(number, body, state = "open") {
  return {
    number,
    title: `issue ${number}`,
    state,
    body,
    labels: [],
  };
}

test("nodes carry the authored autopilot-suitability score (null when unscored)", async () => {
  const issues = new Map([
    [500, roadmapIssue(500, "- [ ] #501\n- [ ] #502", "score-roadmap")],
    [501, executionIssue(501, "task one\n<!-- idd-skill-autopilot-suitability: 5 -->")],
    [502, executionIssue(502, "task two with no score")],
  ]);

  const graph = await enumerateRoadmapGraph(500, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });

  const byNumber = new Map(graph.nodes.map((node) => [node.number, node]));
  assert.equal(byNumber.get(501).autopilotSuitability, 5);
  assert.equal(byNumber.get(502).autopilotSuitability, null);
});
