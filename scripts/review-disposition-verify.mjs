#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MARKER_ACCEPTED_RE = /^\*\*Accepted\*\*\s+—/;
const MARKER_REJECTED_RE = /^\*\*Rejected\*\*\s+—/;
const MARKER_REJECTION_CONFIRMED_RE = /^\*\*Rejection confirmed by maintainer\*\*\s+—/;
const MARKER_AMD_RE = /^\*\*Awaiting maintainer decision\*\*\s+—/;

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.items === null) {
    throw new Error("--items is required");
  }

  let rawItems;
  try {
    const parsed = JSON.parse(args.items);
    if (Array.isArray(parsed)) {
      rawItems = parsed;
    } else if (parsed !== null && typeof parsed === "object" && "items" in parsed) {
      if (parsed.items === null) {
        throw new Error("--items JSON object has 'items: null'; expected an array");
      }
      rawItems = parsed.items ?? [];
    } else {
      throw new Error("--items JSON object must have an 'items' key");
    }
  } catch (err) {
    if (err.message.includes("--items")) {
      throw err;
    }
    throw new Error("--items must be a valid JSON array or object with an 'items' key");
  }

  const result = verifyDispositions(rawItems);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Verify E7 disposition evidence for a set of ReviewItems_snapshot items.
 *
 * Returns:
 * {
 *   passed: boolean,
 *   summary: string,
 *   totalCount: number,
 *   passedCount: number,
 *   failedCount: number,
 *   items: Array<{
 *     id: string,
 *     path: "A"|"B",
 *     checks: {
 *       decisionRecorded: boolean,
 *       markerPresent: boolean|null,
 *       markerMatchesDecision: boolean|null,
 *       threadResolutionCorrect: boolean|null
 *     },
 *     passed: boolean,
 *     issues: string[]
 *   }>
 * }
 */
export function verifyDispositions(items) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  if (items.length === 0) {
    return {
      passed: true,
      summary: "No items to verify.",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      items: [],
    };
  }

  const results = items.map((item) => {
    const normalized = normalizeItem(item);
    if (normalized.path === "A") {
      return checkPathAItem(normalized);
    }
    if (normalized.path === "B") {
      return checkPathBItem(normalized);
    }
    return {
      id: normalized.id,
      path: normalized.path,
      checks: {
        decisionRecorded: false,
        markerPresent: null,
        markerMatchesDecision: null,
        threadResolutionCorrect: null,
      },
      passed: false,
      issues: [`Unknown path value: ${JSON.stringify(normalized.path)}. Expected "A" or "B".`],
    };
  });

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;
  const passed = failedCount === 0;
  const summary = passed
    ? `All ${results.length} item${results.length === 1 ? "" : "s"} verified.`
    : `${failedCount} of ${results.length} item${results.length === 1 ? "" : "s"} failed E7 verification.`;

  return {
    passed,
    summary,
    totalCount: results.length,
    passedCount,
    failedCount,
    items: results,
  };
}

/**
 * Classify a disposition marker reply.
 * Returns "accepted" | "rejected" | "awaiting_maintainer" | null.
 */
export function classifyMarker(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  const trimmed = text.trim();
  if (MARKER_ACCEPTED_RE.test(trimmed)) {
    return "accepted";
  }
  if (MARKER_REJECTED_RE.test(trimmed) || MARKER_REJECTION_CONFIRMED_RE.test(trimmed)) {
    return "rejected";
  }
  if (MARKER_AMD_RE.test(trimmed)) {
    return "awaiting_maintainer";
  }
  return null;
}

/**
 * Verify a PATH A item per E7 rules.
 *
 * PATH A Accepted: decision must be recorded; no marker required at triage.
 * PATH A Rejected: decision must be recorded + marker must be present + if review_thread then resolved.
 * PATH A AMD: decision must be recorded + AMD marker must be present + if review_thread then NOT resolved.
 */
export function checkPathAItem(item) {
  const normalized = normalizeItem(item);
  const { id, type, decision, markerReply, threadResolved } = normalized;
  const checks = {
    decisionRecorded: false,
    markerPresent: null,
    markerMatchesDecision: null,
    threadResolutionCorrect: null,
  };
  const issues = [];

  const validDecisions = new Set(["accepted", "rejected", "awaiting_maintainer"]);
  if (decision === null) {
    checks.decisionRecorded = false;
    issues.push("PATH A item has no recorded decision (null).");
    return makeResult(id, "A", checks, issues);
  }
  if (!validDecisions.has(decision)) {
    checks.decisionRecorded = false;
    issues.push(`Unknown decision value: ${JSON.stringify(decision)}.`);
    return makeResult(id, "A", checks, issues);
  }
  checks.decisionRecorded = true;

  if (decision === "accepted") {
    return makeResult(id, "A", checks, issues);
  }

  const markerType = classifyMarker(markerReply ?? "");

  if (decision === "rejected") {
    const markerPresent = markerType === "rejected";
    checks.markerPresent = markerPresent;
    checks.markerMatchesDecision = markerPresent;
    if (!markerPresent) {
      issues.push("PATH A Rejected item is missing the required `**Rejected** — {reason}` marker reply.");
    }

    if (type === "review_thread") {
      const resolutionCorrect = threadResolved === true;
      checks.threadResolutionCorrect = resolutionCorrect;
      if (!resolutionCorrect) {
        issues.push("PATH A Rejected review_thread must be resolved after posting the rejection reply.");
      }
    } else {
      if (threadResolved !== null) {
        checks.threadResolutionCorrect = false;
        issues.push(`Non-thread item (type: ${type}) has unexpected non-null threadResolved: ${JSON.stringify(threadResolved)}.`);
      } else {
        checks.threadResolutionCorrect = true;
      }
    }
    return makeResult(id, "A", checks, issues);
  }

  if (decision === "awaiting_maintainer") {
    const markerPresent = markerType === "awaiting_maintainer";
    checks.markerPresent = markerPresent;
    checks.markerMatchesDecision = markerPresent;
    if (!markerPresent) {
      issues.push("PATH A AMD item is missing the required `**Awaiting maintainer decision** — {reasoning}` marker reply.");
    }

    if (type === "review_thread") {
      const resolutionCorrect = threadResolved === false;
      checks.threadResolutionCorrect = resolutionCorrect;
      if (!resolutionCorrect) {
        issues.push("PATH A AMD review_thread must NOT be resolved (leave unresolved so F2 gate blocks merge).");
      }
    } else {
      if (threadResolved !== null) {
        checks.threadResolutionCorrect = false;
        issues.push(`Non-thread AMD item (type: ${type}) has unexpected non-null threadResolved: ${JSON.stringify(threadResolved)}.`);
      } else {
        checks.threadResolutionCorrect = true;
      }
    }
    return makeResult(id, "A", checks, issues);
  }

  return makeResult(id, "A", checks, issues);
}

/**
 * Verify a PATH B item per E7 rules.
 *
 * PATH B: decision must be accepted or rejected + marker must be present
 *         + if review_thread then resolved; otherwise threadResolved must be null.
 */
export function checkPathBItem(item) {
  const normalized = normalizeItem(item);
  const { id, type, decision, markerReply, threadResolved } = normalized;
  const checks = {
    decisionRecorded: false,
    markerPresent: null,
    markerMatchesDecision: null,
    threadResolutionCorrect: null,
  };
  const issues = [];

  const validDecisions = new Set(["accepted", "rejected"]);
  if (decision === null) {
    checks.decisionRecorded = false;
    issues.push("PATH B item has no recorded decision (null).");
    return makeResult(id, "B", checks, issues);
  }
  if (!validDecisions.has(decision)) {
    checks.decisionRecorded = false;
    issues.push(`PATH B decision must be "accepted" or "rejected"; got: ${JSON.stringify(decision)}.`);
    return makeResult(id, "B", checks, issues);
  }
  checks.decisionRecorded = true;

  const markerType = classifyMarker(markerReply ?? "");
  const markerPresent = markerType === "accepted" || markerType === "rejected";
  const markerMatchesDecision = markerType === decision;
  checks.markerPresent = markerPresent;
  checks.markerMatchesDecision = markerMatchesDecision;
  if (!markerPresent) {
    issues.push("PATH B item is missing the required `**Accepted** — ...` or `**Rejected** — ...` marker reply.");
  } else if (!markerMatchesDecision) {
    issues.push(`PATH B marker type (${markerType}) does not match recorded decision (${decision}).`);
  }

  if (type === "review_thread") {
    const resolutionCorrect = threadResolved === true;
    checks.threadResolutionCorrect = resolutionCorrect;
    if (!resolutionCorrect) {
      issues.push("PATH B review_thread must be resolved immediately after posting the marker.");
    }
  } else {
    if (threadResolved !== null) {
      checks.threadResolutionCorrect = false;
      issues.push(`Non-thread PATH B item (type: ${type}) has unexpected non-null threadResolved: ${JSON.stringify(threadResolved)}.`);
    } else {
      checks.threadResolutionCorrect = true;
    }
  }

  return makeResult(id, "B", checks, issues);
}

function makeResult(id, path, checks, issues) {
  return {
    id,
    path,
    checks,
    passed: issues.length === 0,
    issues,
  };
}

function normalizeItem(item) {
  return {
    id: String(item?.id ?? ""),
    path: typeof item?.path === "string" ? item.path.toUpperCase() : item?.path,
    type: typeof item?.type === "string" ? item.type : null,
    decision: typeof item?.decision === "string" ? item.decision.toLowerCase() : null,
    markerReply: typeof item?.markerReply === "string" ? item.markerReply : null,
    threadResolved: item?.threadResolved === true ? true
      : item?.threadResolved === false ? false
        : null,
  };
}

function parseArgs(argv) {
  const parsed = { items: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--items") {
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--items requires a JSON value");
      }
      parsed.items = value;
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/review-disposition-verify.mjs --items '<json>' [--help]

Input: JSON array of items or object with an 'items' key.

Item shape:
{
  "id": "string",
  "path": "A" | "B",
  "type": "review_thread" | "regular_comment" | "changes_requested" | "critique_finding",
  "decision": "accepted" | "rejected" | "awaiting_maintainer" | null,
  "markerReply": "string | null",
  "threadResolved": true | false | null
}

Output schema:
{
  "passed": true,
  "summary": "All 3 items verified.",
  "totalCount": 3,
  "passedCount": 3,
  "failedCount": 0,
  "items": [{
    "id": "...",
    "path": "A",
    "checks": {
      "decisionRecorded": true,
      "markerPresent": true,
      "markerMatchesDecision": true,
      "threadResolutionCorrect": true
    },
    "passed": true,
    "issues": []
  }]
}
`);
}

function isMainModule(metaUrl) {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  return metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
