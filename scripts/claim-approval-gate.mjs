#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { normalizePolicyConfig } from "./policy-helpers.mjs";

const APPROVAL_POLICIES = new Set([
  "owners-and-maintainers-only",
  "all-write-permission-actors",
]);
const APPROVAL_POLICY_DEFAULT = "owners-and-maintainers-only";

if (isCliExecution()) {
  runCli();
}

export function evaluateClaimApprovalGate(input, options = {}) {
  const issue = normalizeIssue(input.issue);
  const comments = normalizeComments(input.comments);
  const timelineState = normalizeTimeline(input.timeline);
  const policyState = normalizePolicy(input.policy);
  const generatedPlanState = detectGeneratedPlanUpdateAt({
    comments,
    override: input.generatedPlanUpdatedAt,
  });
  const resolvePermission = typeof options.resolvePermission === "function"
    ? options.resolvePermission
    : () => ({ known: false, permission: "", error: "permission resolver missing" });

  const checks = [];
  const gateEnabled = !policyState.skipIssueAuthorApprovalGate;
  checks.push({
    id: "gate_enabled",
    name: "Issue-author gate enabled",
    result: gateEnabled ? "pass" : "fail",
    evidence: gateEnabled
      ? "skipIssueAuthorApprovalGate is not true."
      : "skipIssueAuthorApprovalGate=true; gate bypassed.",
  });

  if (!gateEnabled) {
    return {
      approved: true,
      reason: "gate-disabled",
      gateEnabled: false,
      policy: {
        skipIssueAuthorApprovalGate: true,
        maintainerApprovalActorPolicy: policyState.maintainerApprovalActorPolicy,
        approvalSignals: policyState.approvalSignals,
        source: policyState.source,
      },
      checks,
    };
  }

  const ambiguity = [];
  let permissionAmbiguity = false;
  const issueAuthor = issue.authorLogin;
  const authorPermission = issueAuthor
    ? normalizePermissionResult(resolvePermission(issueAuthor))
    : { known: false, permission: "", error: "issue author missing" };
  const authorSelfAuthorized = isAuthorizedByPolicy(
    authorPermission.permission,
    policyState.maintainerApprovalActorPolicy,
  );
  if (!authorPermission.known) {
    ambiguity.push("issue-author-permission-unavailable");
    permissionAmbiguity = true;
  }
  checks.push({
    id: "author_self_authorized",
    name: "Issue author self-authorized",
    result: authorSelfAuthorized ? "pass" : "fail",
    evidence: authorSelfAuthorized
      ? `Issue author ${issueAuthor} satisfies policy ${policyState.maintainerApprovalActorPolicy}.`
      : `Issue author ${issueAuthor || "(missing)"} does not satisfy policy ${policyState.maintainerApprovalActorPolicy}.`,
  });

  const latestSubstantiveEditAt = resolveLatestSubstantiveEditAt(issue, timelineState);
  const freshnessAnchor = maxTimestamp(latestSubstantiveEditAt, generatedPlanState.updatedAt);
  const freshnessDeterminable = latestSubstantiveEditAt !== null && generatedPlanState.known;
  const readyLabelState = resolveReadyLabelApproval({
    issue,
    timelineState,
    policy: policyState,
    freshnessAnchor,
    freshnessDeterminable,
  });
  if (readyLabelState.freshnessUnknown) {
    ambiguity.push("ready-label-freshness-unavailable");
  }
  checks.push({
    id: "ready_label_present",
    name: "Configured ready label approval",
    result: readyLabelState.approved ? "pass" : "fail",
    evidence: readyLabelState.evidence,
  });

  const approvalCommentState = findLatestReadyApprovalComment({
    comments,
    policy: policyState.maintainerApprovalActorPolicy,
    resolvePermission,
  });
  if (approvalCommentState.permissionUnknown) {
    ambiguity.push("approval-comment-permission-unavailable");
    permissionAmbiguity = true;
  }

  let readyCommentFresh = false;
  if (approvalCommentState.comment && freshnessDeterminable && freshnessAnchor) {
    readyCommentFresh = compareIso(approvalCommentState.comment.createdAt, freshnessAnchor) > 0;
  }
  checks.push({
    id: "ready_comment_fresh",
    name: "Fresh maintainer approval comment",
    result: readyCommentFresh ? "pass" : "fail",
    evidence: buildReadyCommentEvidence({
      approvalCommentState,
      freshnessDeterminable,
      freshnessAnchor,
    }),
  });

  const timelineKnown = timelineState.known;
  if (!timelineKnown) {
    ambiguity.push("issue-timeline-unavailable");
  }
  if (!generatedPlanState.known) {
    ambiguity.push("generated-plan-freshness-unavailable");
  }

  const ambiguityBlocking = ambiguity.length > 0
    && !authorSelfAuthorized
    && !readyLabelState.approved
    && !readyCommentFresh;
  checks.push({
    id: "ambiguity_guard",
    name: "Fail-closed ambiguity guard",
    result: ambiguityBlocking ? "fail" : "pass",
    evidence: ambiguityBlocking
        ? `Approval state is ambiguous: ${ambiguity.join(", ")}`
        : ambiguity.length > 0
          ? `Ambiguity present but bypassed by explicit/author approval: ${ambiguity.join(", ")}`
          : "No ambiguity detected.",
  });

  const approved = authorSelfAuthorized || readyLabelState.approved || (readyCommentFresh && !ambiguityBlocking);
  return {
    approved,
    reason: deriveReason({
      approved,
      authorSelfAuthorized,
      readyLabelApproved: readyLabelState.approved,
      readyLabelFreshnessUnknown: readyLabelState.freshnessUnknown,
      readyCommentFresh,
      hasAuthorizedReadyComment: Boolean(approvalCommentState.comment),
      ambiguityBlocking,
      permissionAmbiguity,
      freshnessDeterminable,
    }),
    gateEnabled: true,
    policy: {
      skipIssueAuthorApprovalGate: false,
      maintainerApprovalActorPolicy: policyState.maintainerApprovalActorPolicy,
      approvalSignals: policyState.approvalSignals,
      source: policyState.source,
    },
    checks,
  };
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error("--issue is required and must be a positive integer");
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
  const repoRef = `${owner}/${repo}`;
  const issue = ghJson(["api", `repos/${repoRef}/issues/${args.issue}`]);
  const comments = ghApiJson(`repos/${repoRef}/issues/${args.issue}/comments`, true);
  const timelineState = fetchIssueTimeline(repoRef, args.issue);
  const policy = loadPolicy(args.policy);
  const permissionCache = new Map();
  const resolvePermission = (login) => resolveCollaboratorPermission({
    owner,
    repo,
    login,
    cache: permissionCache,
  });

  const result = evaluateClaimApprovalGate(
    {
      issue,
      comments,
      timeline: timelineState.events,
      policy: policy.config,
      generatedPlanUpdatedAt: args.generatedPlanUpdatedAt,
    },
    { resolvePermission },
  );
  const output = {
    repository: { owner, repo },
    issue: {
      number: Number.parseInt(String(issue.number), 10),
      title: String(issue.title ?? ""),
      state: String(issue.state ?? ""),
      url: String(issue.html_url ?? issue.url ?? ""),
      author: String(issue.user?.login ?? ""),
    },
    approved: result.approved,
    reason: result.reason,
    gateEnabled: result.gateEnabled,
    policy: result.policy,
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
        id: check.id,
        name: check.name,
        result: check.result,
      })),
    timelineAvailable: timelineState.known,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {
    issue: null,
    owner: "",
    repo: "",
    policy: "",
    token: "",
    generatedPlanUpdatedAt: "",
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === "--issue") {
      parsed.issue = Number.parseInt(String(requireValue()), 10);
      index += 1;
      continue;
    }
    if (token === "--owner") {
      parsed.owner = requireValue();
      index += 1;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = requireValue();
      index += 1;
      continue;
    }
    if (token === "--policy") {
      parsed.policy = requireValue();
      index += 1;
      continue;
    }
    if (token === "--token") {
      parsed.token = requireValue();
      index += 1;
      continue;
    }
    if (token === "--generated-plan-updated-at") {
      parsed.generatedPlanUpdatedAt = requireValue();
      index += 1;
      continue;
    }
    if (token === "--verbose") {
      parsed.verbose = true;
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
  node scripts/claim-approval-gate.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--generated-plan-updated-at <ISO8601>] [--verbose]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 393, "title": "...", "state": "OPEN", "url": "...", "author": "..."},
  "approved": true,
  "reason": "gate-disabled|author-self-authorized|ready-label-present|ready-comment-fresh|approval-missing|approval-ambiguous|approval-comment-stale|freshness-undetermined",
  "gateEnabled": true,
  "policy": {"skipIssueAuthorApprovalGate": false, "maintainerApprovalActorPolicy": "owners-and-maintainers-only", "approvalSignals": {"readyLabelName": "idd:ready", "labelFreshnessMode": "presence-only"}, "source": ".github/idd/config.json"},
  "checks": [{"id":"gate_enabled","name":"Issue-author gate enabled","result":"pass|fail","evidence":"..."}],
  "timelineAvailable": true
}
`);
}

function normalizeIssue(issue) {
  return {
    authorLogin: String(issue?.user?.login ?? "").trim().toLowerCase(),
    labels: normalizeLabels(issue?.labels),
    createdAt: normalizeIso(issue?.created_at),
    updatedAt: normalizeIso(issue?.updated_at),
  };
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments.map((comment) => ({
    authorLogin: String(comment?.user?.login ?? "").trim().toLowerCase(),
    body: String(comment?.body ?? ""),
    createdAt: normalizeIso(comment?.created_at),
  })).filter((comment) => comment.createdAt !== null);
}

function normalizeTimeline(timeline) {
  if (!Array.isArray(timeline)) {
    return { known: false, events: [] };
  }
  return { known: true, events: timeline };
}

function normalizePolicy(policy) {
  const normalized = normalizePolicyConfig(policy);
  return {
    skipIssueAuthorApprovalGate: normalized.skipIssueAuthorApprovalGate,
    maintainerApprovalActorPolicy: APPROVAL_POLICIES.has(normalized.maintainerApprovalActorPolicy)
      ? normalized.maintainerApprovalActorPolicy
      : APPROVAL_POLICY_DEFAULT,
    approvalSignals: {
      readyLabelName: String(normalized.approvalSignals.readyLabelName ?? "").trim().toLowerCase(),
      labelFreshnessMode: String(normalized.approvalSignals.labelFreshnessMode ?? "presence-only"),
    },
    source: String(policy?.source ?? ".github/idd/config.json"),
  };
}

function resolveReadyLabelApproval({ issue, timelineState, policy, freshnessAnchor, freshnessDeterminable }) {
  const readyLabelName = policy.approvalSignals.readyLabelName;
  const labelDisplayName = readyLabelName || "idd:ready";
  const hasReadyLabel = issue.labels.includes(readyLabelName);

  if (!hasReadyLabel) {
    return {
      approved: false,
      present: false,
      freshnessUnknown: false,
      evidence: `Configured ready label ${labelDisplayName} is absent.`,
    };
  }

  if (policy.approvalSignals.labelFreshnessMode !== "event-freshness") {
    return {
      approved: true,
      present: true,
      freshnessUnknown: false,
      evidence: `Configured ready label ${labelDisplayName} is present; labelFreshnessMode=presence-only.`,
    };
  }

  if (!timelineState.known) {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but the issue timeline is unavailable for label freshness checks.`,
    };
  }

  if (!freshnessDeterminable || !freshnessAnchor) {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but the freshness anchor could not be determined.`,
    };
  }

  const latestLabelEvent = findLatestReadyLabelEvent(timelineState.events, readyLabelName);
  if (!latestLabelEvent || latestLabelEvent.event !== "labeled") {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but no matching label application event was found in the issue timeline.`,
    };
  }

  const fresh = compareIso(latestLabelEvent.createdAt, freshnessAnchor) > 0;
  return {
    approved: fresh,
    present: true,
    freshnessUnknown: false,
    evidence: `Configured ready label ${labelDisplayName} was last applied at ${latestLabelEvent.createdAt}; freshness anchor is ${freshnessAnchor}.`,
  };
}

function detectGeneratedPlanUpdateAt({ comments, override }) {
  const overrideIso = normalizeIso(override);
  if (override && !overrideIso) {
    return { known: false, updatedAt: null };
  }
  if (overrideIso) {
    return { known: true, updatedAt: overrideIso };
  }
  if (!Array.isArray(comments)) {
    return { known: false, updatedAt: null };
  }
  const generatedPlanComments = comments
    .filter((comment) => /\bgenerated[- ]plan\b/i.test(comment.body))
    .map((comment) => comment.createdAt)
    .filter(Boolean);
  return { known: true, updatedAt: maxTimestamp(...generatedPlanComments) };
}

function resolveLatestSubstantiveEditAt(issue, timelineState) {
  if (!timelineState.known) {
    return null;
  }
  const editedAt = timelineState.events
    .filter((event) => String(event?.event ?? "") === "edited")
    .filter((event) => event?.changes?.title || event?.changes?.body)
    .map((event) => normalizeIso(event?.created_at))
    .filter(Boolean);
  return maxTimestamp(issue.createdAt, ...editedAt);
}

function findLatestReadyLabelEvent(events, readyLabelName) {
  if (!Array.isArray(events)) {
    return null;
  }
  const relevant = events
    .map((event) => ({
      event: String(event?.event ?? "").trim().toLowerCase(),
      labelName: normalizeLabelName(event?.label),
      createdAt: normalizeIso(event?.created_at),
    }))
    .filter((event) => event.createdAt !== null)
    .filter((event) => (event.event === "labeled" || event.event === "unlabeled"))
    .filter((event) => event.labelName === readyLabelName)
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  return relevant.length > 0 ? relevant[relevant.length - 1] : null;
}

function normalizeLabelName(value) {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return String(value?.name ?? "").trim().toLowerCase();
}

function findLatestReadyApprovalComment({ comments, policy, resolvePermission }) {
  const readyCandidates = comments.filter((comment) => hasReadySignal(comment.body));
  let permissionUnknown = false;
  const authorized = [];

  for (const candidate of readyCandidates) {
    const permission = normalizePermissionResult(resolvePermission(candidate.authorLogin));
    if (!permission.known) {
      permissionUnknown = true;
      continue;
    }
    if (isAuthorizedByPolicy(permission.permission, policy)) {
      authorized.push(candidate);
    }
  }

  authorized.sort((left, right) => compareIso(left.createdAt, right.createdAt));
  return {
    comment: authorized.length > 0 ? authorized[authorized.length - 1] : null,
    permissionUnknown,
    totalCandidates: readyCandidates.length,
  };
}

function hasReadySignal(body) {
  const trimmed = String(body ?? "").trim();
  if (trimmed === "IDD ready") {
    return true;
  }
  return String(body ?? "")
    .split(/\r?\n/)
    .some((line) => line.trim() === "IDD ready");
}

function buildReadyCommentEvidence({ approvalCommentState, freshnessDeterminable, freshnessAnchor }) {
  if (!approvalCommentState.comment) {
    return approvalCommentState.totalCandidates > 0
      ? "Ready comments exist but none came from an authorized actor."
      : "No standalone IDD ready comment found.";
  }
  if (!freshnessDeterminable || !freshnessAnchor) {
    return "Ready comment found, but freshness anchor could not be determined.";
  }
  return `Latest authorized ready comment at ${approvalCommentState.comment.createdAt}; freshness anchor is ${freshnessAnchor}.`;
}

function deriveReason(state) {
  if (!state.approved) {
    if (state.permissionAmbiguity) {
      return "approval-ambiguous";
    }
    if (state.readyLabelFreshnessUnknown) {
      return "freshness-undetermined";
    }
    if (!state.freshnessDeterminable) {
      return "freshness-undetermined";
    }
    if (state.ambiguityBlocking) {
      return "approval-ambiguous";
    }
    if (state.hasAuthorizedReadyComment && state.readyCommentFresh === false) {
      return "approval-comment-stale";
    }
    return "approval-missing";
  }
  if (state.authorSelfAuthorized) {
    return "author-self-authorized";
  }
  if (state.readyLabelApproved) {
    return "ready-label-present";
  }
  if (state.readyCommentFresh) {
    return "ready-comment-fresh";
  }
  return "gate-disabled";
}

function isAuthorizedByPolicy(permission, policy) {
  if (policy === "all-write-permission-actors") {
    return permission === "admin" || permission === "maintain" || permission === "write";
  }
  return permission === "admin" || permission === "maintain";
}

function normalizePermissionResult(value) {
  if (!value || typeof value !== "object") {
    return { known: false, permission: "", error: "invalid permission result" };
  }
  const permission = String(value.permission ?? "").trim().toLowerCase();
  return {
    known: Boolean(value.known),
    permission,
    error: String(value.error ?? ""),
  };
}

function normalizeIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function compareIso(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return 0;
  }
  return leftTime - rightTime;
}

function maxTimestamp(...values) {
  const normalized = values.filter(Boolean).map((value) => normalizeIso(value)).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  normalized.sort(compareIso);
  return normalized[normalized.length - 1];
}

function fetchIssueTimeline(repoRef, issueNumber) {
  try {
    const events = ghApiJson(
      `repos/${repoRef}/issues/${issueNumber}/timeline`,
      true,
      ["-H", "Accept: application/vnd.github+json"],
    );
    return { known: true, events };
  } catch {
    return { known: false, events: [] };
  }
}

function resolveCollaboratorPermission({ owner, repo, login, cache }) {
  const normalized = String(login ?? "").trim().toLowerCase();
  if (!normalized) {
    return { known: false, permission: "", error: "empty login" };
  }
  if (cache.has(normalized)) {
    return cache.get(normalized);
  }
  const result = ghApiJsonWithStatus(
    `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalized)}/permission`,
  );
  if (result.status === 404) {
    const notCollaborator = { known: true, permission: "none", error: "" };
    cache.set(normalized, notCollaborator);
    return notCollaborator;
  }
  if (result.status !== 200) {
    const unknown = { known: false, permission: "", error: `permission lookup failed: ${result.status}` };
    cache.set(normalized, unknown);
    return unknown;
  }
  const permission = String(result.body?.permission ?? "").trim().toLowerCase();
  const known = permission.length > 0;
  const resolved = { known, permission, error: known ? "" : "permission missing in response" };
  cache.set(normalized, resolved);
  return resolved;
}

function loadPolicy(policyPath) {
  const source = policyPath || ".github/idd/config.json";
  try {
    const raw = JSON.parse(readFileSync(source, "utf8"));
    const normalized = normalizePolicyConfig(raw);
    return {
      source,
      config: {
        ...normalized,
        source,
      },
    };
  } catch {
    return {
      source,
      config: {
        skipIssueAuthorApprovalGate: false,
        maintainerApprovalActorPolicy: APPROVAL_POLICY_DEFAULT,
        source,
      },
    };
  }
}

function ghApiJson(path, paginate = false, extraArgs = []) {
  const args = ["api", path, ...extraArgs];
  if (paginate) {
    args.push("--paginate");
  }
  return JSON.parse(runGh(args).trim() || "[]");
}

function ghApiJsonWithStatus(path) {
  try {
    const body = JSON.parse(runGh(["api", path]).trim() || "{}");
    return { status: 200, body };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const httpStatus = Number.parseInt((/HTTP\s+(\d+)/.exec(stderr)?.[1] ?? "0"), 10);
    if (httpStatus > 0) {
      return { status: httpStatus, body: null };
    }
    return { status: 0, body: null };
  }
}

function ghJson(args) {
  return JSON.parse(runGh(args).trim() || "{}");
}

function ghText(args) {
  return runGh(args).trim();
}

function runGh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    if (stderr) {
      const wrapped = new Error(`gh command failed: ${stderr}`);
      wrapped.stderr = stderr;
      throw wrapped;
    }
    throw error;
  }
}

function isCliExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
