import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyIssue,
  extractBlockedByReferences,
  filterOrphanIssues,
  getOrphanFirstPolicy,
} from "../scripts/discover-orphan-filter.mjs";

test("extractBlockedByReferences parses visible blocker lines", () => {
  const body = `
Blocked by #12
notes
  Blocked by #34 because dependency
blocked by #56
`;
  assert.deepEqual(extractBlockedByReferences(body), [12, 34, 56]);
});

test("getOrphanFirstPolicy reads commands row and falls back to none", () => {
  assert.equal(getOrphanFirstPolicy({ commands: { "orphan-first-policy": "maintainer-approved" } }), "maintainer-approved");
  assert.equal(getOrphanFirstPolicy({ orphanFirstPolicy: "public-disabled" }), "public-disabled");
  assert.equal(getOrphanFirstPolicy({}), "none");
});

test("classifyIssue rejects roadmap and blocked marker issues", () => {
  const roadmap = classifyIssue(
    {
      number: 1,
      title: "roadmap",
      state: "OPEN",
      labels: [],
      body: "<!-- idd-skill-roadmap-id: x -->",
    },
    { issueStateByNumber: new Map(), fetchIssueStateByNumber: () => "UNRESOLVABLE" },
  );
  assert.equal(roadmap.reason, "roadmap_marker");

  const blocked = classifyIssue(
    {
      number: 2,
      title: "blocked",
      state: "OPEN",
      labels: [],
      body: "<!-- idd-skill-blocked-by: x -->",
    },
    { issueStateByNumber: new Map(), fetchIssueStateByNumber: () => "UNRESOLVABLE" },
  );
  assert.equal(blocked.reason, "blocked_by_marker");
});

test("classifyIssue accepts marker forms without colon", () => {
  const roadmap = classifyIssue(
    {
      number: 3,
      title: "roadmap marker without payload",
      state: "OPEN",
      labels: [],
      body: "<!-- idd-skill-roadmap-id -->",
    },
    { issueStateByNumber: new Map(), fetchIssueStateByNumber: () => "UNRESOLVABLE" },
  );
  assert.equal(roadmap.reason, "roadmap_marker");

  const blocked = classifyIssue(
    {
      number: 4,
      title: "blocked marker without payload",
      state: "OPEN",
      labels: [],
      body: "<!-- idd-skill-blocked-by -->",
    },
    { issueStateByNumber: new Map(), fetchIssueStateByNumber: () => "UNRESOLVABLE" },
  );
  assert.equal(blocked.reason, "blocked_by_marker");
});

test("classifyIssue supports custom marker prefix", () => {
  const roadmap = classifyIssue(
    {
      number: 5,
      title: "custom roadmap marker",
      state: "OPEN",
      labels: [],
      body: "<!-- custom-roadmap-id: phase-a -->",
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => "UNRESOLVABLE",
      markerPrefix: "custom",
    },
  );
  assert.equal(roadmap.reason, "roadmap_marker");

  const blocked = classifyIssue(
    {
      number: 6,
      title: "custom blocked marker",
      state: "OPEN",
      labels: [],
      body: "<!-- custom-blocked-by: phase-a -->",
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => "UNRESOLVABLE",
      markerPrefix: "custom",
    },
  );
  assert.equal(blocked.reason, "blocked_by_marker");
});

test("filterOrphanIssues excludes blocked labels and open blockers", () => {
  const issues = [
    {
      number: 10,
      title: "candidate",
      state: "OPEN",
      labels: [],
      body: "Blocked by #20",
      url: "https://example.com/10",
    },
    {
      number: 11,
      title: "human blocked",
      state: "OPEN",
      labels: [{ name: "status:blocked-by-human" }],
      body: "",
      url: "https://example.com/11",
    },
    {
      number: 12,
      title: "orphan",
      state: "OPEN",
      labels: [],
      body: "",
      url: "https://example.com/12",
    },
  ];

  const result = filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[20, "OPEN"]]),
    fetchIssueStateByNumber: () => "UNRESOLVABLE",
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 12);
  assert.equal(result.filtered.blocked_by_open_reference.length, 1);
  assert.equal(result.filtered.blocked_label.length, 1);
});

test("filterOrphanIssues keeps closed-blocker issues as orphan candidates", () => {
  const issues = [
    {
      number: 30,
      title: "blocked by closed issue",
      state: "OPEN",
      labels: [],
      body: "Blocked by #31",
      url: "https://example.com/30",
    },
  ];

  const result = filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[31, "CLOSED"]]),
    fetchIssueStateByNumber: () => "UNRESOLVABLE",
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].reason, "blocked_references_closed");
});

test("filterOrphanIssues reports unresolvable and circular references", () => {
  const issues = [
    {
      number: 40,
      title: "missing ref",
      state: "OPEN",
      labels: [],
      body: "Blocked by #99",
      url: "https://example.com/40",
    },
    {
      number: 41,
      title: "cycle a",
      state: "OPEN",
      labels: [],
      body: "Blocked by #42",
      url: "https://example.com/41",
    },
    {
      number: 42,
      title: "cycle b",
      state: "OPEN",
      labels: [],
      body: "Blocked by #41",
      url: "https://example.com/42",
    },
  ];

  const result = filterOrphanIssues(issues, {
    issueStateByNumber: new Map([
      [41, "OPEN"],
      [42, "OPEN"],
    ]),
    fetchIssueStateByNumber: (number) => (number === 99 ? "UNRESOLVABLE" : "UNRESOLVABLE"),
  });

  assert.equal(result.filtered.unresolvable_reference.length, 1);
  assert.equal(result.filtered.blocked_by_open_reference.length, 2);
  assert.equal(result.unresolvable.length, 1);
  assert.deepEqual(result.unresolvable[0], {
    issue: 40,
    reason: "issue-not-found-or-inaccessible",
    reference: 99,
  });
});

test("classifyIssue handles lowercase state casing", () => {
  const issue = {
    number: 50,
    title: "blocked by open issue with lowercase state",
    state: "open",
    labels: [],
    body: "Blocked by #51",
    url: "https://example.com/50",
  };

  const result = filterOrphanIssues([issue], {
    issueStateByNumber: new Map([[51, "open"]]),
    fetchIssueStateByNumber: () => "UNRESOLVABLE",
  });

  assert.equal(result.orphans.length, 0, "Issue should not be orphan when blocked by open reference");
  assert.equal(result.filtered.blocked_by_open_reference.length, 1, "Should classify as blocked_by_open_reference");
});

test("classifyIssue supports custom marker prefix in filtering", () => {
  const issue = {
    number: 60,
    title: "issue with custom marker",
    state: "OPEN",
    labels: [],
    body: "<!-- my-org-idd-blocked-by: gap-123 -->",
    url: "https://example.com/60",
  };

  const result = filterOrphanIssues([issue], {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => "UNRESOLVABLE",
    markerPrefix: "my-org-idd",
  });

  assert.equal(result.orphans.length, 0, "Issue should not be orphan when has custom-prefix blocked marker");
  assert.equal(result.filtered.blocked_by_marker.length, 1, "Should detect custom marker");
});

test("filterOrphanIssues handles pagination with PR-heavy pages", () => {
  const mockFetchIssueStateByNumber = (number) => {
    return number === 100 ? "CLOSED" : "UNRESOLVABLE";
  };

  const issues = [
    {
      number: 70,
      title: "issue on pr-heavy page",
      state: "OPEN",
      labels: [],
      body: "Blocked by #100",
      url: "https://example.com/70",
    },
  ];

  const result = filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[100, "CLOSED"]]),
    fetchIssueStateByNumber: mockFetchIssueStateByNumber,
  });

  assert.equal(result.orphans.length, 1, "Issue should be orphan when blocker is closed");
  assert.equal(result.orphans[0].reason, "blocked_references_closed");
});
