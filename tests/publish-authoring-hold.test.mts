import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AuthoringOwnerProvenanceComment } from '../src/scripts/authoring-owner-provenance.mts';
import { markdownItAvailable } from '../src/scripts/markdown-structure.mts';
import {
  buildLintArgs,
  carrierSetSnapshot,
  checkCarrierReviewResult,
  checkReviewResult,
  generateChildPublicationIds,
  generatePublicationIds,
  injectPublicationLine,
  markerPostSentNothing,
  parseJournalReference,
  replayAnchorHold,
  resolveAnchorGeneration,
  resolvePublishLabels,
} from '../src/scripts/publish-authoring-hold.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/publish-authoring-hold.mjs');
const TITLE = 'Add a sample orphan feature';
const NEW_ISSUE = 5000;
/** The set anchor a child is published under in the stub. */
const ANCHOR = 4000;

function draftBody(bucket = 'ready'): string {
  return [
    ...(bucket === 'ready'
      ? []
      : [`<!-- idd-skill-authoring-bucket: ${bucket} -->`, '']),
    '## Background',
    '',
    'Some background text.',
    '',
    '## Proposed change',
    '',
    'Do the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/example.test.mts` passes with the new case covered',
    '',
    '---',
    '',
    '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;',
    'below the configured floor is human-oriented._',
    '',
    '<!-- idd-skill-autopilot-suitability: 4 -->',
    '',
    '_Effort: M -- author-estimated size; a soft autopilot',
    'selection tie-breaker only._',
    '',
    '<!-- idd-skill-effort: M -->',
  ].join('\n');
}

/**
 * A stateful fake `gh`. Every call is appended to `log.jsonl`; issues,
 * labels and comments live in `state.json`, so the sibling helpers the
 * command spawns (post-idd-marker, authoring-owner-provenance) read back
 * what an earlier call wrote.
 */
const GH_STUB = String.raw`
const fs = require('node:fs');
const dir = process.env.PUBLISH_STUB_DIR;
const statePath = dir + '/state.json';
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
let stdin = '';
if (args.includes('--input')) stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ args, stdin }) + '\n');
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
const out = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
const user = 'kurone-kito';
if (args[0] === 'auth' && args[1] === 'token') out((process.env.GH_TOKEN || '') + '\n');
if (args[0] === 'label' && args[1] === 'create') {
  if (state.failLabelCreate) fail('HTTP 422: could not create label');
  state.labels.push(args[2]);
  save();
  out('');
}
if (args[0] === 'issue' && args[1] === 'create') {
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const labels = [];
  args.forEach((arg, index) => { if (arg === '--label') labels.push(args[index + 1]); });
  state.issues[${NEW_ISSUE}] = { body, labels: state.dropLabels ? [] : labels };
  if (state.claimOnCreate) {
    state.comments.push({ id: 6990, issue: ${NEW_ISSUE}, body: '<!-- claimed-by: claude-other 0f2c9a4e-1b7d-4c3a-9e8f-2d6b5a4c3e21 supersedes: none 2026-10-13T00:00:00Z branch: issue/${NEW_ISSUE}-x -->', user, createdAt: '2026-10-13T00:00:00Z' });
    if (state.claimOnCreate === 'released') {
      state.comments.push({ id: 6991, issue: ${NEW_ISSUE}, body: '<!-- unclaimed-by: claude-other 0f2c9a4e-1b7d-4c3a-9e8f-2d6b5a4c3e21 2026-10-13T00:01:00Z -->', user, createdAt: '2026-10-13T00:01:00Z' });
    }
  }
  save();
  out('https://github.com/o/r/issues/${NEW_ISSUE}\n');
}
if (args[0] === 'issue' && args[1] === 'edit') {
  const issue = state.issues[Number(args[2])];
  const removes = [];
  const adds = [];
  args.forEach((arg, index) => {
    if (arg === '--remove-label') removes.push(args[index + 1]);
    if (arg === '--add-label') adds.push(args[index + 1]);
  });
  if (removes.length > 0) {
    if (state.removeLabelFailure === 'unchanged') fail('gh: HTTP 502 Bad Gateway (label edit)');
    if (!state.keepLabelOnRemove) issue.labels = issue.labels.filter((name) => !removes.includes(name));
    if (state.dropAuthoringOnlyOnRemove) issue.labels = issue.labels.filter((name) => name !== 'status:authoring-only');
    if (state.failReadsAfterRemove) state.readsFail = true;
    state.removed = true;
    if (state.dropReleaseAfterRemove) {
      state.comments = state.comments.filter((c) => !(c.issue === Number(args[2]) && /mode=release;/.test(c.body)));
    }
    save();
    if (state.removeLabelFailure === 'landed') fail('gh: HTTP 502 Bad Gateway (label edit)');
    out('');
  }
  if (adds.length > 0) {
    if (state.failAddLabel) fail('gh: HTTP 502 Bad Gateway (label add)');
    adds.forEach((name) => { if (!issue.labels.includes(name)) issue.labels.push(name); });
    save();
    out('');
  }
  out('');
}
if (args[0] !== 'api') fail('unexpected gh call: ' + args.join(' '));
if (args.includes('graphql')) {
  const queryText = args.find((arg) => arg.startsWith('query=')) || '';
  if (state.readsFail) fail('gh: HTTP 502 Bad Gateway (read)');
  if (state.removed && state.mutateBodyOnSweep && queryText.includes('comments(first:100')) {
    state.issues[${NEW_ISSUE}].body += state.mutateBodyOnSweep;
    state.mutateBodyOnSweep = '';
    save();
  }
  if (queryText.includes('mutation')) {
    out({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
  }
  if (queryText.includes('query($ids')) out({ data: { nodes: [] } });
  if (queryText.includes('query($id:ID!)')) out({ data: { node: null } });
  if (state.failSweep && queryText.includes('comments(first:100') && !queryText.includes('lastEditedAt')) {
    fail('gh: sweep read failed');
  }
  const numberArg = args.find((arg) => arg.startsWith('number='));
  const number = Number(numberArg.slice('number='.length));
  const queryArg = args.find((arg) => arg.startsWith('query=')) || '';
  const page = (key, nodes) => out({ data: { repository: { issue: { [key]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  if (queryArg.includes('closedByPullRequestsReferences')) {
    page('closedByPullRequestsReferences', state.openPr ? [{ state: 'OPEN', number: 9, repository: { nameWithOwner: 'o/r' } }] : []);
  }
  if (queryArg.includes('timelineItems')) page('timelineItems', []);
  state.commentReads = (state.commentReads || 0) + 1;
  if (state.foreignOwnerOnRead && state.commentReads === state.foreignOwnerOnRead) {
    state.comments.push({ id: 6998, issue: number, body: '<!-- idd-skill-authoring-owner: target=o/r#' + number + '; anchor=o/r#' + number + '; mode=acquire; owner=owner-other; set=set-other; session=session-other; body-sha256=none; snapshot-sha256=none; supersedes=none -->', user, createdAt: '2026-10-13T00:10:00Z' });
  }
  save();
  const nodes = state.comments.filter((c) => c.issue === number).map((c) => ({
    id: 'IC_' + c.id,
    url: 'https://github.com/o/r/issues/' + number + '#issuecomment-' + c.id,
    databaseId: c.id,
    lastEditedAt: state.editedComments ? '2026-10-13T00:00:01Z' : null,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
    body: c.body,
    author: { login: c.user },
    isMinimized: false,
    minimizedReason: null,
  }));
  out({ data: { repository: { issue: { comments: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
}
const searchPath = args.find((arg) => arg.startsWith('search/issues'));
if (searchPath) {
  if (state.searchIncomplete) out({ total_count: 1, incomplete_results: true, items: [{ number: ${NEW_ISSUE} }] });
  const owners = [...new Set(state.comments.filter((c) => c.body.includes('authoring-owner:')).map((c) => c.issue))];
  out({ total_count: owners.length, incomplete_results: false, items: owners.map((number) => ({ number })) });
}
const path = args.find((arg) => arg === 'user' || arg.startsWith('repos/'));
if (path && path.startsWith('repos/o/r/issues?')) {
  if (state.indexLagFull) out(Array.from({ length: 100 }, (_, index) => ({ number: 9000 + index, updated_at: '2026-10-13T00:00:00Z' })));
  out(Object.keys(state.issues).map((number) => ({ number: Number(number), updated_at: '2026-10-13T00:00:00Z' })));
}
if (path === 'user') {
  state.userCalls = (state.userCalls || 0) + 1;
  save();
  if (state.userCalls === state.throttleOnUserCall) {
    // Record a secondary-rate-limit cooldown through the load-control
    // module, so the next write of this credential is refused before any
    // gh process starts.
    require('node:child_process').execFileSync(process.execPath, ['--input-type=module', '-e', [
      'const m = await import(' + JSON.stringify(state.loadControlModule) + ');',
      'const gate = m.admitRequestSync({ host: "github.com", credentialMaterial: process.env.GH_TOKEN }, { enabled: true, maxConcurrent: 4, maxWaitMs: 1000 }, { classification: "read", resource: "core" });',
      'gate.recordFailure({ stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)", stdout: "" });',
      'gate.release();',
    ].join('\n')], { stdio: 'inherit' });
  }
  out(user + '\n');
}
let match;
if ((match = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path))) {
  const number = Number(match[1]);
  if (args.includes('POST')) {
    if (number === 2674) {
      if (state.journalListFails) fail('gh: HTTP 502');
      state.journalPosts = (state.journalPosts || 0) + 1;
      save();
      if (state.journalPosts === state.ambiguousPostAt) {
        // The POST lands, but the reply is lost and every later read fails.
        const body = JSON.parse(stdin).body;
        state.comments.push({ id: 7000 + state.comments.length, issue: 2674, journalIndex: state.journalPosts, body, user, createdAt: '2026-10-13T00:20:00Z' });
        state.journalListFails = true;
        save();
        fail('gh: HTTP 502');
      }
      if (state.journalPosts === state.failJournalPostAt) fail('gh: Validation Failed (HTTP 422)');
      // From this POST on, every journal POST fails without landing.
      if (state.failJournalPostsFrom && state.journalPosts >= state.failJournalPostsFrom) fail(state.failJournalPostMessage);
      if (state.journalPosts === state.mutateBodyAt) {
        state.issues[${NEW_ISSUE}].body += state.mutateBodyText || '\nedited by someone else';
        save();
      }
    }
    if (number === ${NEW_ISSUE} && state.ambiguousOwnerPost) {
      // The owner marker lands, but the reply is lost and every later read
      // of the issue's comments fails. The failed read is what stops the
      // retry layer from posting the marker a second time.
      state.comments.push({ id: 7000 + state.comments.length, issue: number, journalIndex: 0, body: JSON.parse(stdin).body, user, createdAt: '2026-10-13T00:30:00Z' });
      state.ownerListFails = true;
      save();
      fail('gh: HTTP 502');
    }
    const body = JSON.parse(stdin).body;
    const modeMatch = /mode=([a-z-]+);/.exec(body);
    const mode = modeMatch ? modeMatch[1] : '';
    if (number === ${NEW_ISSUE} && mode === 'release-complete' && state.failReadsOnComplete) {
      state.readsFail = true;
      save();
    }
    const failSpec = number === ${NEW_ISSUE} && state.postFail && state.postFail.mode === mode ? state.postFail : (number === ${ANCHOR} && state.anchorPostFail && state.anchorPostFail.mode === mode ? state.anchorPostFail : null);
    if (failSpec && !failSpec.landed) fail('gh: Validation Failed (HTTP ' + failSpec.status + ')');
    const id = 7000 + state.comments.length;
    // A test that needs a posted anchor marker to sort after a marker seeded at
    // the real time sets anchorClockNow; every other post keeps the fixed clock.
    const stamp = state.anchorClockNow && number === ${ANCHOR} ? new Date(Date.now() + 1000 * (state.comments.length + 1)).toISOString() : new Date(Date.UTC(2026, 9, 13, 0, 0, state.comments.length)).toISOString();
    state.comments.push({ id, issue: number, journalIndex: number === 2674 ? state.journalPosts : 0, body, user, createdAt: stamp });
    save();
    if (failSpec && failSpec.landed) fail('gh: HTTP ' + failSpec.status + ' Bad Gateway');
    for (const rule of (state.afterPost || []).filter((item) => item.mode === mode)) {
      if (rule.action === 'mutateBody') state.issues[${NEW_ISSUE}].body += rule.text;
      if (rule.action === 'dropLabel') state.issues[${NEW_ISSUE}].labels = state.issues[${NEW_ISSUE}].labels.filter((name) => name !== rule.text);
      if (rule.action === 'competing') {
        state.comments.push({ id: 7100 + state.comments.length, issue: ${NEW_ISSUE}, body: '<!-- idd-skill-authoring-owner: target=o/r#${NEW_ISSUE}; anchor=o/r#${NEW_ISSUE}; mode=release; owner=owner-other; set=set-other; session=session-other; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=owner-other -->', user, createdAt: '2026-10-13T00:40:00Z' });
      }
      if (rule.action === 'anotherMember') {
        const setId = /set=([^;]+);/.exec(body)[1];
        state.comments.push({ id: 7200 + state.comments.length, issue: 6001, body: '<!-- idd-skill-authoring-owner: target=o/r#6001; anchor=o/r#6001; mode=acquire; owner=owner-x; set=' + setId + '; session=session-x; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=none -->', user, createdAt: '2026-10-13T00:41:00Z' });
      }
      if (rule.action === 'malformedRelease') {
        const owner = /owner=([^;]+);/.exec(body)[1];
        const setId = /set=([^;]+);/.exec(body)[1];
        const session = /session=([^;]+);/.exec(body)[1];
        state.comments.push({ id: 7300 + state.comments.length, issue: ${NEW_ISSUE}, body: '<!-- idd-skill-authoring-owner: target=o/r#${NEW_ISSUE}; anchor=o/r#${NEW_ISSUE}; mode=release; owner=' + owner + '; set=' + setId + '; session=' + session + '; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=' + owner + ' -->', user, createdAt: '2026-10-13T00:42:00Z' });
      }
      if (rule.action === 'anchorTakeover') {
        // Another session resumes the anchor's set right after the heartbeat.
        state.comments.push({ id: 7400 + state.comments.length, issue: ${ANCHOR}, body: '<!-- idd-skill-authoring-owner: target=o/r#${ANCHOR}; anchor=o/r#${ANCHOR}; mode=resume; owner=owner-thief; set=set-anchor; session=session-thief; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=owner-anchor -->', user, createdAt: '2026-10-13T01:00:00Z' });
      }
      if (rule.action === 'otherAnchor') {
        // A marker of the child's own owner, set and session that names another anchor.
        const owner = /owner=([^;]+);/.exec(body)[1];
        const setId = /set=([^;]+);/.exec(body)[1];
        const session = /session=([^;]+);/.exec(body)[1];
        state.comments.push({ id: 7500 + state.comments.length, issue: ${NEW_ISSUE}, body: '<!-- idd-skill-authoring-owner: target=o/r#${NEW_ISSUE}; anchor=o/r#9999; mode=heartbeat; owner=' + owner + '; set=' + setId + '; session=' + session + '; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=' + owner + ' -->', user, createdAt: '2026-10-13T00:43:00Z' });
      }
      if (rule.action === 'otherTarget') {
        // A marker hosted on the child with its owner, set, session and anchor but another target.
        const owner = /owner=([^;]+);/.exec(body)[1];
        const setId = /set=([^;]+);/.exec(body)[1];
        const session = /session=([^;]+);/.exec(body)[1];
        const anchorRef = /anchor=([^;]+);/.exec(body)[1];
        state.comments.push({ id: 7600 + state.comments.length, issue: ${NEW_ISSUE}, body: '<!-- idd-skill-authoring-owner: target=o/r#9998; anchor=' + anchorRef + '; mode=heartbeat; owner=' + owner + '; set=' + setId + '; session=' + session + '; body-sha256=' + '0'.repeat(64) + '; snapshot-sha256=none; supersedes=' + owner + ' -->', user, createdAt: '2026-10-13T00:44:00Z' });
      }
      if (rule.action === 'dropRelease') {
        state.comments = state.comments.filter((c) => !(c.issue === ${NEW_ISSUE} && /mode=release;/.test(c.body)));
      }
      save();
    }
    out({ id, html_url: 'https://github.com/o/r/issues/' + number + '#issuecomment-' + id, body });
  }
  if (number === 2674 && state.journalListFails) fail('gh: HTTP 502');
  if (number === ${NEW_ISSUE} && state.ownerListFails) fail('gh: HTTP 502');
  const rows = state.comments.filter((c) => c.issue === number).map((c) => JSON.stringify({ id: c.id, body: c.body, user: { login: c.user }, created_at: c.createdAt }));
  out(rows.join('\n') + (rows.length ? '\n' : ''));
}
if ((match = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path))) {
  const comment = state.comments.find((c) => c.id === Number(match[1]));
  if (!comment) fail('gh: Not Found (HTTP 404)');
  const corrupt = comment.journalIndex > 0 && comment.journalIndex === state.corruptReadbackAt;
  out({ id: comment.id, body: corrupt ? comment.body + ' ' : comment.body, user: { login: comment.user } });
}
if ((match = /^repos\/o\/r\/issues\/(\d+)$/.exec(path))) {
  const number = Number(match[1]);
  if (state.readsFail && number === ${NEW_ISSUE}) fail('gh: HTTP 502 Bad Gateway (read)');
  if (number === 2674) out({ number, title: 'journal', state: 'closed', body: 'journal', labels: [], html_url: 'https://github.com/o/r/issues/2674' });
  const issue = state.issues[number];
  if (!issue) fail('gh: Not Found (HTTP 404)');
  out({ number, title: 'x', state: issue.state || 'open', body: issue.body, labels: issue.labels.map((name) => ({ name })), html_url: 'https://github.com/o/r/issues/' + number });
}
if ((match = /^repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(path))) {
  const level = state.permission || 'admin';
  out({ permission: level === 'maintain' ? 'write' : level, role_name: level, user: { login: decodeURIComponent(match[1]) } });
}
if ((match = /^repos\/o\/r\/labels\/(.+)$/.exec(path))) {
  const name = decodeURIComponent(match[1]);
  if (state.labels.includes(name)) out({ name });
  fail('gh: Not Found (HTTP 404)');
}
fail('unexpected gh api call: ' + args.join(' '));
`;

/** The stored state of the stub `gh`, as far as a test changes it. */
interface StubState {
  issues: Record<string, unknown>;
  comments: {
    id: number;
    issue: number;
    body: string;
    user: string;
    createdAt: string;
  }[];
  [key: string]: unknown;
}

interface Fixture {
  dir: string;
  run: (
    args: string[],
    env?: Record<string, string>,
  ) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  log: () => { args: string[]; stdin: string }[];
  state: () => {
    comments: { issue: number; body: string }[];
    issues: Record<string, unknown>;
  };
  /** Change the stub's stored state before a run (issues, comments, flags). */
  seed: (change: (state: StubState) => void) => void;
  restore: () => void;
}

function setup(
  options: {
    journal?: string | null;
    labels?: string[];
    failLabelCreate?: boolean;
    editedComments?: boolean;
    dropLabels?: boolean;
    failJournalPostAt?: number;
    corruptReadbackAt?: number;
    mutateBodyAt?: number;
    ambiguousPostAt?: number;
    claimOnCreate?: boolean | 'released';
    openPr?: boolean;
    foreignOwnerOnRead?: number;
    trusted?: string[];
    permission?: string;
    failJournalPostsFrom?: number;
    failJournalPostMessage?: string;
    throttleOnUserCall?: number;
    ambiguousOwnerPost?: boolean;
    postFail?: { mode: string; status: number; landed: boolean };
    anchorPostFail?: { mode: string; status: number; landed: boolean };
    anchorClockNow?: boolean;
    afterPost?: { mode: string; action: string; text?: string }[];
    removeLabelFailure?: 'unchanged' | 'landed';
    keepLabelOnRemove?: boolean;
    dropReleaseAfterRemove?: boolean;
    failAddLabel?: boolean;
    failSweep?: boolean;
    searchIncomplete?: boolean;
    mutateBodyText?: string;
    failReadsOnComplete?: boolean;
    indexLagFull?: boolean;
    authoringOnlyLabelName?: string;
    dropAuthoringOnlyOnRemove?: boolean;
    failReadsAfterRemove?: boolean;
    mutateBodyOnSweep?: string;
  } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'idd-publish-authoring-hold-test-'));
  const work = join(dir, 'work');
  mkdirSync(join(work, '.github/idd'), { recursive: true });
  const config: Record<string, unknown> = {
    markerPrefix: 'idd-skill',
    trustedMarkerActors: options.trusted ?? ['kurone-kito'],
    claim: { verifySettleDelay: 'PT0S' },
  };
  if (options.throttleOnUserCall) {
    config.githubApi = {
      loadControl: { enabled: true, maxConcurrent: 4, maxWait: 'PT1S' },
    };
  }
  if (options.journal !== null) {
    config.issueAuthoring = { journalIssue: options.journal ?? 'o/r#2674' };
  }
  if (options.authoringOnlyLabelName !== undefined) {
    config.labels = { authoringOnlyLabelName: options.authoringOnlyLabelName };
  }
  writeFileSync(
    join(work, '.github/idd/config.json'),
    JSON.stringify(config, null, 2),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      labels: options.labels ?? ['status:authoring'],
      failLabelCreate: options.failLabelCreate === true,
      editedComments: options.editedComments === true,
      dropLabels: options.dropLabels === true,
      failJournalPostAt: options.failJournalPostAt ?? 0,
      corruptReadbackAt: options.corruptReadbackAt ?? 0,
      mutateBodyAt: options.mutateBodyAt ?? 0,
      ambiguousPostAt: options.ambiguousPostAt ?? 0,
      permission: options.permission ?? 'admin',
      claimOnCreate: options.claimOnCreate ?? false,
      openPr: options.openPr === true,
      foreignOwnerOnRead: options.foreignOwnerOnRead ?? 0,
      failJournalPostsFrom: options.failJournalPostsFrom ?? 0,
      failJournalPostMessage: options.failJournalPostMessage ?? 'gh: HTTP 500',
      throttleOnUserCall: options.throttleOnUserCall ?? 0,
      ambiguousOwnerPost: options.ambiguousOwnerPost === true,
      postFail: options.postFail ?? null,
      anchorPostFail: options.anchorPostFail ?? null,
      anchorClockNow: options.anchorClockNow === true,
      afterPost: options.afterPost ?? [],
      removeLabelFailure: options.removeLabelFailure ?? '',
      keepLabelOnRemove: options.keepLabelOnRemove === true,
      dropReleaseAfterRemove: options.dropReleaseAfterRemove === true,
      failAddLabel: options.failAddLabel === true,
      failSweep: options.failSweep === true,
      searchIncomplete: options.searchIncomplete === true,
      mutateBodyText: options.mutateBodyText ?? '',
      failReadsOnComplete: options.failReadsOnComplete === true,
      indexLagFull: options.indexLagFull === true,
      dropAuthoringOnlyOnRemove: options.dropAuthoringOnlyOnRemove === true,
      failReadsAfterRemove: options.failReadsAfterRemove === true,
      mutateBodyOnSweep: options.mutateBodyOnSweep ?? '',
      removed: false,
      readsFail: false,
      loadControlModule: pathToFileURL(
        join(REPO_ROOT, 'scripts/github-api-load-control.mjs'),
      ).href,
      issues: {},
      comments: [],
    }),
  );
  writeFileSync(join(dir, 'log.jsonl'), '');
  const restore = stubExecutable('gh', GH_STUB);
  const home = join(dir, 'home');
  mkdirSync(home);
  return {
    dir,
    run: (args, env = {}) => {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: work,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PUBLISH_STUB_DIR: dir,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_STATE_HOME: join(home, '.state'),
          IDD_TRUSTED_MARKER_ACTORS: '',
          IDD_HELPER_ERROR_ENVELOPE: '',
          GH_HOST: 'github.com',
          GH_TOKEN: 'credential-publish-test',
          GITHUB_TOKEN: '',
          ...env,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    log: () =>
      readFileSync(join(dir, 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    seed: (change) => {
      const path = join(dir, 'state.json');
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      change(stored);
      writeFileSync(path, JSON.stringify(stored));
    },
    restore: () => {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function files(
  fixture: Fixture,
  bucket = 'ready',
  review: unknown = { completed: true },
): string[] {
  const body = join(fixture.dir, 'body.md');
  const result = join(fixture.dir, 'review.json');
  writeFileSync(body, draftBody(bucket));
  writeFileSync(result, JSON.stringify(review));
  return [
    '--title',
    TITLE,
    '--body-file',
    body,
    '--review-result',
    result,
    '--owner',
    'o',
    '--repo',
    'r',
    '--marker-prefix',
    'idd-skill',
    ...(bucket === 'ready' ? [] : ['--bucket', bucket]),
  ];
}

/** The write calls in the gh log, in order. */
function writes(log: { args: string[] }[]): string[] {
  return log
    .filter(
      (entry) =>
        entry.args.includes('--method') ||
        entry.args.includes('-X') ||
        (['label', 'issue'].includes(entry.args[0] ?? '') &&
          !['view', 'list'].includes(entry.args[1] ?? '')),
    )
    .map((entry) => entry.args.slice(0, 4).join(' '));
}

/** The kind of one gh call, for the mutation-order check. */
function kindOf(entry: { args: string[]; stdin: string }): string | null {
  const args = entry.args;
  if (args[0] === 'label') return 'label';
  if (args[0] === 'issue' && args[1] === 'create') return 'create';
  if (args[0] === 'issue' && args[1] === 'edit') {
    return args.includes('--remove-label') ? 'remove-label' : 'add-label';
  }
  if (args.includes('graphql')) {
    return args.some((arg) => arg.startsWith('query=mutation'))
      ? 'sweep-minimize'
      : 'provenance';
  }
  const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
  if (path === 'repos/o/r/issues/2674' && !args.includes('POST')) {
    return 'journal-check';
  }
  if (path.startsWith('repos/o/r/labels/')) return 'label';
  if (path === 'repos/o/r/issues/2674/comments' && args.includes('POST')) {
    const body = JSON.parse(entry.stdin).body as string;
    if (body.includes('state=member')) return 'member';
    return body.includes('issue=none') ? 'journal-pending' : 'identity-attach';
  }
  if (path === `repos/o/r/issues/${ANCHOR}/comments` && args.includes('POST')) {
    const posted = JSON.parse(entry.stdin).body as string;
    return `anchor:${/mode=([a-z-]+);/.exec(posted)?.[1] ?? ''}`;
  }
  if (
    path === `repos/o/r/issues/${NEW_ISSUE}/comments` &&
    args.includes('POST')
  ) {
    const posted = JSON.parse(entry.stdin).body as string;
    const mode = /mode=([a-z-]+);/.exec(posted)?.[1] ?? '';
    return mode === '' || mode === 'acquire'
      ? 'owner-marker'
      : `owner-marker:${mode}`;
  }
  return null;
}

test('ids: orphan anchor equals target, and the line round-trips', () => {
  let counter = 0;
  const ids = generatePublicationIds(() => {
    counter += 1;
    return `u${counter}`;
  });
  assert.equal(ids.anchor, ids.target);
  assert.equal(ids.target, 'target-u1');
  const body = injectPublicationLine('## Background\n', 'idd-skill', ids);
  assert.equal(
    body.split('\n')[0],
    '<!-- idd-skill-authoring-publication: target=target-u1; anchor=target-u1; set=set-u2; session=session-u3; token=token-u4 -->',
  );
  assert.throws(() => injectPublicationLine(body, 'idd-skill', ids));
});

test('review result: only a completed review with no open finding passes', () => {
  assert.equal(checkReviewResult('{"completed": true}'), null);
  assert.equal(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "fixed"}, {"disposition": "rejected"}]}',
    ),
    null,
  );
  assert.notEqual(checkReviewResult('{"completed": false}'), null);
  assert.notEqual(checkReviewResult('{}'), null);
  assert.notEqual(checkReviewResult('not json'), null);
  assert.notEqual(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "deferred"}]}',
    ),
    null,
  );
});

test('lint args: a ready publish passes no bucket or label, a needs-decision publish passes both labels', () => {
  const common = {
    shape: 'orphan',
    title: 't',
    bodyFile: 'b.md',
    markerPrefix: 'idd-skill',
    currentRepo: 'o/r',
  };
  const ready = buildLintArgs({
    ...common,
    bucket: 'ready',
    labels: resolvePublishLabels({}, 'ready'),
  });
  assert.ok(ready.includes('--new-issue'));
  assert.ok(!ready.includes('--expect-bucket'));
  assert.ok(!ready.includes('--label'));
  const decision = buildLintArgs({
    ...common,
    bucket: 'needs-decision',
    labels: resolvePublishLabels(
      { labels: { needsDecisionLabelName: 'decide' } },
      'needs-decision',
    ),
  });
  assert.deepEqual(decision.slice(-6), [
    '--expect-bucket',
    'needs-decision',
    '--label',
    'status:authoring',
    '--label',
    'decide',
  ]);
});

test('journal and anchor reference parsing', () => {
  assert.deepEqual(parseJournalReference('o/r#2674'), {
    owner: 'o',
    repo: 'r',
    number: 2674,
    ref: 'o/r#2674',
  });
  assert.equal(parseJournalReference(undefined), null);
  assert.equal(parseJournalReference('o/r#0'), null);
  assert.equal(parseJournalReference('o/r#12 '), null);
  assert.equal(parseJournalReference('#12'), null);
});

test('CLI: a missing or incomplete review result exits non-zero before any write', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const without = args.filter(
      (_, index) =>
        args[index] !== '--review-result' &&
        args[index - 1] !== '--review-result',
    );
    assert.equal(fixture.run(without).status, 2);
    assert.equal(
      fixture.run(files(fixture, 'ready', { completed: false })).status,
      1,
    );
    assert.equal(
      fixture.run(
        files(fixture, 'ready', {
          completed: true,
          findings: [{ disposition: 'deferred' }],
        }),
      ).status,
      1,
    );
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an unset journal exits 2 with no label, journal record or issue', () => {
  const fixture = setup({ journal: null, labels: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).outcome, 'blocked-by-human');
    assert.deepEqual(writes(fixture.log()), []);
    assert.deepEqual(fixture.state().comments, []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a dry run lints the injected body with --new-issue and writes nothing', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run(files(fixture));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.ok(lint.detail.args.includes('--new-issue'));
    assert.ok(!lint.detail.args.includes('--expect-bucket'));
    assert.ok(!lint.detail.args.includes('--label'));
    const labels = report.steps.find(
      (s: { step: string }) => s.step === 'labels',
    );
    assert.deepEqual(labels.detail.create, ['status:authoring']);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a needs-decision dry run passes the bucket and both labels to the linter', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const result = fixture.run(files(fixture, 'needs-decision'));
    const report = JSON.parse(result.stdout);
    const lint =
      report.lint ??
      report.steps.find((s: { step: string }) => s.step === 'lint').detail;
    assert.deepEqual(lint.args.slice(-6), [
      '--expect-bucket',
      'needs-decision',
      '--label',
      'status:authoring',
      '--label',
      'status:needs-decision',
    ]);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a label that cannot be created refuses before the journal write', () => {
  const fixture = setup({ labels: [], failLabelCreate: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.deepEqual(writes(fixture.log()), [
      'label create status:authoring --repo',
    ]);
    assert.deepEqual(fixture.state().comments, []);
    assert.deepEqual(fixture.state().issues, {});
  } finally {
    fixture.restore();
  }
});

test('CLI: --apply runs the mutations in the contract order and ends at member', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'published');
    assert.equal(report.issue, `o/r#${NEW_ISSUE}`);
    const order: string[] = [];
    for (const entry of fixture.log()) {
      const kind = kindOf(entry);
      if (kind !== null && order[order.length - 1] !== kind) order.push(kind);
    }
    assert.deepEqual(order, [
      'journal-check',
      'label',
      'journal-pending',
      'create',
      'identity-attach',
      'owner-marker',
      'provenance',
      'member',
    ]);
    const created = fixture.state().issues[String(NEW_ISSUE)] as {
      body: string;
      labels: string[];
    };
    assert.match(created.body, /^<!-- idd-skill-authoring-publication: /);
    assert.deepEqual(created.labels, ['status:authoring']);
  } finally {
    fixture.restore();
  }
});

test('CLI: a failure after the create leaves the journal pending and prints the issue', () => {
  const fixture = setup({ editedComments: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'provenance');
    assert.equal(report.journalState, 'pending');
    assert.equal(report.number, NEW_ISSUE);
    assert.match(result.stderr, new RegExp(`o/r#${NEW_ISSUE}`));
    const journal = fixture
      .state()
      .comments.filter((comment) => comment.issue === 2674);
    assert.equal(journal.length, 2);
    assert.ok(
      journal.every((comment) => comment.body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: an issue created without its label gets the label back as a safe hold and exits 1', () => {
  const fixture = setup({ dropLabels: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'create-verify');
    assert.equal(report.journalState, 'pending');
    const issue = fixture.state().issues[String(NEW_ISSUE)] as {
      labels: string[];
    };
    assert.deepEqual(issue.labels, ['status:authoring']);
    assert.ok(
      !fixture.state().comments.some((comment) => comment.issue === NEW_ISSUE),
    );
  } finally {
    fixture.restore();
  }
});

/** The journal records the stub stored, in order. */
function journalRecords(fixture: Fixture): string[] {
  return fixture
    .state()
    .comments.filter((comment) => comment.issue === 2674)
    .map((comment) => comment.body);
}

test('CLI: a failed identity attach stops before the owner marker and keeps the record pending', () => {
  const fixture = setup({ failJournalPostAt: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'identity-attach');
    assert.equal(report.number, NEW_ISSUE);
    const records = journalRecords(fixture);
    assert.equal(records.length, 1);
    assert.match(
      records[0] ?? '',
      /issue=none; actor=kurone-kito; state=pending/,
    );
    assert.ok(
      !fixture.state().comments.some((comment) => comment.issue === NEW_ISSUE),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a claim that appears during acquisition stops before member', () => {
  const fixture = setup({ claimOnCreate: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /active claim/);
    const records = journalRecords(fixture);
    assert.equal(records.length, 2);
    assert.ok(records.every((body) => body.includes('state=pending')));
  } finally {
    fixture.restore();
  }
});

test('CLI: with no trusted marker actor configured, --apply writes nothing', () => {
  const fixture = setup({ trusted: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no trusted marker actor/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a member record that posts but fails its read-back reports an uncertain journal state', () => {
  const fixture = setup({ corruptReadbackAt: 3 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.match(journalRecords(fixture)[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a released claim does not block member', () => {
  const fixture = setup({ claimOnCreate: 'released' });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'published');
  } finally {
    fixture.restore();
  }
});

test('CLI: an open linked pull request stops before member', () => {
  const fixture = setup({ openPr: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /open linked pull request/);
    assert.ok(
      journalRecords(fixture).every((body) => body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a foreign owner marker that lands after provenance stops before member', () => {
  // The first GraphQL comment read is the provenance run; the second is the
  // final owner-log replay.
  const fixture = setup({ foreignOwnerOnRead: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /owner-marker replay/);
    assert.ok(
      journalRecords(fixture).every((body) => body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a pending record that posts but fails its read-back refuses with an uncertain journal state', () => {
  const fixture = setup({ corruptReadbackAt: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.deepEqual(fixture.state().issues, {});
  } finally {
    fixture.restore();
  }
});

test('CLI: a body edited before the owner marker stops before member', () => {
  // The edit lands with the identity-attach record, so the owner marker
  // hashes the edited body and only the created-body comparison catches it.
  const fixture = setup({ mutateBodyAt: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /not the body this run created/);
  } finally {
    fixture.restore();
  }
});

test('CLI: an unlabeled issue that already carries another owner marker is left untouched', () => {
  // The recovery read is the first GraphQL comment read of this run.
  const fixture = setup({ dropLabels: true, foreignOwnerOnRead: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'create-verify');
    assert.match(report.reason, /another owner marker is present/);
    const issue = fixture.state().issues[String(NEW_ISSUE)] as {
      labels: string[];
    };
    assert.deepEqual(issue.labels, []);
    assert.ok(
      !fixture
        .log()
        .some((entry) => entry.args[0] === 'issue' && entry.args[1] === 'edit'),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a member post that may have landed without a reply reports an uncertain journal state', () => {
  const fixture = setup({ ambiguousPostAt: 3 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /may have been posted/);
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.match(journalRecords(fixture)[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a trusted login without write permission writes nothing', () => {
  const fixture = setup({ permission: 'read' });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /does not have Write, Maintain or Admin permission/,
    );
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an explicit repository outside this checkout needs --marker-prefix', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const index = args.indexOf('--marker-prefix');
    args.splice(index, 2);
    const result = fixture.run([...args, '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--marker-prefix is required/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a user-global label name does not change the plan', () => {
  const fixture = setup();
  try {
    const globalDir = join(fixture.dir, 'home', '.config', 'idd-skill');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({
        labels: { needsDecisionLabelName: 'global:decide' },
        issueAuthoring: { authoringLabelName: 'global:authoring' },
      }),
    );
    const result = fixture.run(files(fixture, 'needs-decision'));
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.labels, [
      'status:authoring',
      'status:needs-decision',
    ]);
  } finally {
    fixture.restore();
  }
});

test('CLI: a user-global trusted marker actor does not admit a write', () => {
  const fixture = setup({ trusted: [] });
  try {
    const globalDir = join(fixture.dir, 'home', '.config', 'idd-skill');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'config.json'),
      JSON.stringify({ trustedMarkerActors: ['kurone-kito'] }),
    );
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no trusted marker actor/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

/** The writes in the gh log, by kind, in order. */
function writeKinds(fixture: Fixture): string[] {
  return fixture
    .log()
    .filter(
      (entry) =>
        entry.args.includes('POST') ||
        entry.args.includes('PATCH') ||
        entry.args.includes('DELETE') ||
        entry.args.some((arg) => arg.startsWith('query=mutation')) ||
        (['label', 'issue'].includes(entry.args[0] ?? '') &&
          !['view', 'list'].includes(entry.args[1] ?? '')),
    )
    .map((entry) => {
      const kind = kindOf(entry);
      if (kind === 'create') {
        const labels = entry.args.filter(
          (_, index) => entry.args[index - 1] === '--label',
        );
        return `create ${labels.join(',')}`;
      }
      return kind ?? entry.args.join(' ');
    });
}

test('CLI: the orphan shape with every label present makes exactly the five writes in order', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'published');
    assert.equal(report.journalState, 'member');
    assert.deepEqual(writeKinds(fixture), [
      'journal-pending',
      'create status:authoring',
      'identity-attach',
      'owner-marker',
      'member',
    ]);
    const records = journalRecords(fixture);
    assert.match(records[0] ?? '', /issue=none; .*state=pending/);
    assert.match(
      records[1] ?? '',
      new RegExp(`issue=o/r#${NEW_ISSUE}; .*state=pending`),
    );
    assert.match(records[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a pending post that lands while its reply and every later journal read fail stays uncertain and creates nothing', () => {
  const fixture = setup({ ambiguousPostAt: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.equal(report.nothingSent, false);
    assert.equal(report.retry, 'replay the journal first');
    assert.ok(
      !fixture
        .log()
        .some(
          (entry) => entry.args[0] === 'issue' && entry.args[1] === 'create',
        ),
      'no gh issue create call',
    );
    assert.deepEqual(fixture.state().issues, {});
    const records = journalRecords(fixture);
    assert.equal(records.length, 1, 'no second publication-intent record');
    assert.match(records[0] ?? '', /issue=none; .*state=pending/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a first-attempt 422 on the pending post reports nothing sent and permits a retry', () => {
  const fixture = setup({ failJournalPostAt: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.nothingSent, true);
    assert.equal(report.retry, 'permitted');
    assert.equal(report.journalState, undefined);
    assert.match(report.reason, /nothing was sent/);
    assert.deepEqual(journalRecords(fixture), []);
    assert.deepEqual(fixture.state().issues, {});
  } finally {
    fixture.restore();
  }
});

for (const [label, message] of [
  ['a 500', 'gh: HTTP 500'],
  ['a timeout-like failure with no status', 'read ECONNRESET'],
] as const) {
  test(`CLI: ${label} on the first pending post attempt is uncertain, even though the journal does not show the record`, () => {
    const fixture = setup({
      failJournalPostsFrom: 1,
      failJournalPostMessage: message,
    });
    try {
      const result = fixture.run([...files(fixture), '--apply']);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, 'refused');
      assert.equal(report.nothingSent, false);
      assert.equal(report.journalState, 'uncertain: replay the journal');
      assert.match(report.reason, /do not show it yet/);
      assert.deepEqual(journalRecords(fixture), []);
      assert.deepEqual(fixture.state().issues, {});
    } finally {
      fixture.restore();
    }
  });
}

test('CLI: a pending post refused by load control reports nothing sent and permits a retry', {
  skip: process.platform === 'win32',
}, () => {
  // The second `gh api user` call is post-idd-marker's own, right before its
  // POST: the parent resolved the viewer once before.
  const fixture = setup({ throttleOnUserCall: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.nothingSent, true);
    assert.equal(report.retry, 'permitted');
    assert.match(report.reason, /not dispatched/);
    assert.ok(
      !fixture.log().some((entry) => entry.args.includes('POST')),
      'the refused POST never reached gh',
    );
    // The throttle was recorded on the last gh call of the run, so the
    // refused request is the one after it: post-idd-marker's POST.
    const userCalls = fixture
      .log()
      .filter((entry) => entry.args.includes('user'));
    assert.equal(userCalls.length, 2);
    assert.deepEqual(fixture.log().at(-1)?.args, userCalls[1]?.args);
    assert.deepEqual(journalRecords(fixture), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an owner marker that may have landed reports its own uncertain state', () => {
  const fixture = setup({ ambiguousOwnerPost: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'owner-marker');
    assert.equal(report.ownerMarker, 'uncertain');
    assert.equal(report.nothingSent, false);
    assert.equal(report.journalState, 'pending');
    assert.equal(report.retry, undefined);
  } finally {
    fixture.restore();
  }
});

test('CLI: a dry run needs neither a trusted marker actor nor write permission', () => {
  for (const options of [{ trusted: [] }, { permission: 'read' }]) {
    const fixture = setup(options);
    try {
      const result = fixture.run(files(fixture));
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).outcome, 'planned');
      assert.ok(
        !fixture
          .log()
          .some((entry) =>
            entry.args.some((arg) => arg.includes('/collaborators/')),
          ),
        'a dry run reads no permission',
      );
      assert.deepEqual(writes(fixture.log()), []);
    } finally {
      fixture.restore();
    }
  }
});

test('CLI: neither IDD_TRUSTED_MARKER_ACTORS nor a flag replaces the repository trusted actors', () => {
  const fixture = setup({ trusted: [] });
  try {
    const viaEnv = fixture.run([...files(fixture), '--apply'], {
      IDD_TRUSTED_MARKER_ACTORS: 'kurone-kito',
    });
    assert.equal(viaEnv.status, 1);
    assert.match(viaEnv.stderr, /no trusted marker actor/);
    const viaFlag = fixture.run([
      ...files(fixture),
      '--trusted-marker-logins',
      'kurone-kito',
      '--apply',
    ]);
    assert.equal(viaFlag.status, 2, 'the flag is no longer accepted');
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an environment trusted-actor value does not reach the marker posts', () => {
  const fixture = setup();
  try {
    const result = fixture.run([...files(fixture), '--apply'], {
      IDD_TRUSTED_MARKER_ACTORS: 'someone-else',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).outcome, 'published');
  } finally {
    fixture.restore();
  }
});

// --- Draft carrier (#4253) --------------------------------------------------

const CARRIER_TITLE = 'Draft carrier for the follow-ups';

// The #4250 carrier fixture body. The carrier checks pass on it; the helper
// injects the authoring-publication line before the body is linted.
const CARRIER_BODY = [
  '# Draft carrier for the follow-ups',
  '',
  '<!-- idd-skill-draft-carrier: v1 -->',
  '',
  'Holds drafts that cannot yet be published as their final issues.',
  '',
  '## Release condition',
  '',
  '## Drafts',
  '',
  '### Follow-up A',
  '',
  'Review: reviewed',
  'Shape: child',
  '',
  '````md',
  '# Follow-up A',
  '',
  '<!-- idd-skill-autopilot-suitability: 4 -->',
  '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable._',
  '',
  'Blocked by #99',
  '',
  '<!-- idd-skill-authoring-bucket: needs-decision -->',
  '',
  '```text',
  'nested fence inside the draft',
  '```',
  '````',
  '',
  '### Follow-up B',
  '',
  'Review: not reviewed',
  'Shape: orphan',
  '',
  '```md',
  '# Follow-up B',
  '```',
  '',
  '## Review ledger',
  '',
  '- Follow-up A: reviewed.',
].join('\n');

// The real carrier linter needs markdown-it. The bare-node lint lane installs
// no dependencies, so the cases that reach the linter skip there, as the
// carrier linter tests do (#4250); the installed lanes run them.
const CARRIER_LINT_SKIP = markdownItAvailable()
  ? false
  : 'markdown-it is not installed (bare-node lane)';

/** A carrier case whose publish reaches the real linter. */
function carrierLintTest(name: string, fn: () => void): void {
  test(name, { skip: CARRIER_LINT_SKIP }, fn);
}

/** The arguments of one carrier publish. The review result is optional. */
function carrierFiles(fixture: Fixture, review?: unknown): string[] {
  const body = join(fixture.dir, 'carrier.md');
  writeFileSync(body, CARRIER_BODY);
  const args = [
    '--shape',
    'carrier',
    '--title',
    CARRIER_TITLE,
    '--body-file',
    body,
    '--owner',
    'o',
    '--repo',
    'r',
    '--marker-prefix',
    'idd-skill',
  ];
  if (review !== undefined) {
    const result = join(fixture.dir, 'review.json');
    writeFileSync(
      result,
      typeof review === 'string' ? review : JSON.stringify(review),
    );
    args.push('--review-result', result);
  }
  return args;
}

test('carrier review result: a boolean completed passes, and anything else that does not parse is refused', () => {
  assert.equal(checkCarrierReviewResult('{"completed": false}'), null);
  assert.equal(
    checkCarrierReviewResult(
      '{"completed": true, "findings": [{"disposition": "deferred"}]}',
    ),
    null,
  );
  assert.notEqual(checkCarrierReviewResult('not json'), null);
  assert.notEqual(checkCarrierReviewResult('[]'), null);
  assert.notEqual(checkCarrierReviewResult('{}'), null);
  assert.notEqual(checkCarrierReviewResult('{"completed": "yes"}'), null);
  assert.notEqual(
    checkCarrierReviewResult('{"completed": true, "findings": 5}'),
    null,
  );
  assert.notEqual(
    checkCarrierReviewResult('{"completed": true, "findings": [1]}'),
    null,
  );
  assert.notEqual(checkCarrierReviewResult('null'), null);
  assert.notEqual(
    checkCarrierReviewResult('{"completed": true, "findings": null}'),
    null,
  );
  assert.notEqual(
    checkCarrierReviewResult('{"completed": true, "findings": [null]}'),
    null,
  );
});

test('lint args and labels for a carrier: both labels and no bucket, even when the bucket is ready', () => {
  const labels = resolvePublishLabels({}, 'ready', 'carrier');
  assert.deepEqual(labels, ['status:authoring', 'status:authoring-only']);
  const args = buildLintArgs({
    shape: 'carrier',
    title: 't',
    bodyFile: 'b.md',
    markerPrefix: 'idd-skill',
    currentRepo: 'o/r',
    bucket: 'ready',
    labels,
  });
  assert.deepEqual(args.slice(0, 2), ['--shape', 'carrier']);
  assert.ok(!args.includes('--expect-bucket'));
  assert.deepEqual(args.slice(-4), [
    '--label',
    'status:authoring',
    '--label',
    'status:authoring-only',
  ]);
});

carrierLintTest(
  'CLI: a carrier dry run lints with both labels, plans the create, and writes nothing',
  () => {
    const fixture = setup({ labels: ['status:authoring'] });
    try {
      const result = fixture.run(carrierFiles(fixture));
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.mode, 'dry-run');
      const lint = report.steps.find(
        (s: { step: string }) => s.step === 'lint',
      );
      assert.deepEqual(lint.detail.args.slice(-4), [
        '--label',
        'status:authoring',
        '--label',
        'status:authoring-only',
      ]);
      assert.ok(!lint.detail.args.includes('--expect-bucket'));
      const labels = report.steps.find(
        (s: { step: string }) => s.step === 'labels',
      );
      assert.deepEqual(labels.detail.labels, [
        'status:authoring',
        'status:authoring-only',
      ]);
      assert.deepEqual(labels.detail.create, ['status:authoring-only']);
      assert.deepEqual(writes(fixture.log()), []);
    } finally {
      fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a carrier apply makes the orphan write sequence with both labels, with or without a review result',
  () => {
    const publishWrites = [
      'journal-pending',
      'create status:authoring,status:authoring-only',
      'identity-attach',
      'owner-marker',
      'member',
    ];
    // The carrier release (contract.md, "Carrier creation-hold exception")
    // follows member: four owner markers, one label removal, and the sweeps
    // that run no write on this fixture.
    const releaseWrites = [
      'owner-marker:release',
      'owner-marker:release-guard',
      'owner-marker:heartbeat',
      'remove-label',
      'owner-marker:release-complete',
    ];
    const expected = [...publishWrites, ...releaseWrites];
    const bare = setup({
      labels: ['status:authoring', 'status:authoring-only'],
    });
    try {
      const result = bare.run([...carrierFiles(bare), '--apply']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, 'published');
      assert.equal(report.journalState, 'member');
      assert.equal(report.release.state, 'released');
      assert.deepEqual(writeKinds(bare), expected);
      const created = bare.state().issues[String(NEW_ISSUE)] as {
        body: string;
        labels: string[];
      };
      assert.match(created.body, /^<!-- idd-skill-authoring-publication: /);
      assert.deepEqual(created.labels, ['status:authoring-only']);
    } finally {
      bare.restore();
    }
    const reviewed = setup({
      labels: ['status:authoring', 'status:authoring-only'],
    });
    try {
      const result = reviewed.run([
        ...carrierFiles(reviewed, { completed: false }),
        '--apply',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(writeKinds(reviewed), expected);
    } finally {
      reviewed.restore();
    }
  },
);

test('CLI: a carrier review result that is malformed or unreadable refuses before any write', () => {
  const fixture = setup({
    labels: ['status:authoring', 'status:authoring-only'],
  });
  try {
    const malformed: unknown[] = [
      'not json',
      [],
      { completed: 'yes' },
      { completed: true, findings: 5 },
    ];
    for (const review of malformed) {
      const result = fixture.run([...carrierFiles(fixture, review), '--apply']);
      assert.equal(result.status, 1, JSON.stringify(review));
    }
    const unreadable = [
      ...carrierFiles(fixture),
      '--review-result',
      join(fixture.dir, 'absent.json'),
      '--apply',
    ];
    assert.equal(fixture.run(unreadable).status, 1);
    assert.deepEqual(writes(fixture.log()), []);
    assert.deepEqual(fixture.state().comments, []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an orphan still needs a completed review result on --apply', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const args = files(fixture);
    const without = args.filter(
      (_, index) =>
        args[index] !== '--review-result' &&
        args[index - 1] !== '--review-result',
    );
    assert.equal(fixture.run([...without, '--apply']).status, 2);
    assert.equal(
      fixture.run([...files(fixture, 'ready', { completed: false }), '--apply'])
        .status,
      1,
    );
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a carrier refuses any bucket other than ready before any gh call', () => {
  const fixture = setup({
    labels: ['status:authoring', 'status:authoring-only'],
  });
  try {
    for (const bucket of ['needs-decision', 'blocked-by-human']) {
      const result = fixture.run([
        ...carrierFiles(fixture),
        '--bucket',
        bucket,
        '--apply',
      ]);
      assert.equal(result.status, 2, bucket);
    }
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

carrierLintTest(
  'CLI: a carrier whose authoring-only label cannot be created refuses before the journal write',
  () => {
    const fixture = setup({
      labels: ['status:authoring'],
      failLabelCreate: true,
    });
    try {
      const result = fixture.run([...carrierFiles(fixture), '--apply']);
      assert.equal(result.status, 1);
      assert.deepEqual(writes(fixture.log()), [
        'label create status:authoring-only --repo',
      ]);
      assert.deepEqual(fixture.state().comments, []);
      assert.deepEqual(fixture.state().issues, {});
    } finally {
      fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: an orphan body under --shape carrier fails the lint and writes nothing',
  () => {
    const fixture = setup({
      labels: ['status:authoring', 'status:authoring-only'],
    });
    try {
      const body = join(fixture.dir, 'orphan.md');
      writeFileSync(body, draftBody());
      const result = fixture.run([
        '--shape',
        'carrier',
        '--title',
        CARRIER_TITLE,
        '--body-file',
        body,
        '--owner',
        'o',
        '--repo',
        'r',
        '--marker-prefix',
        'idd-skill',
        '--apply',
      ]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /carrier-marker/);
      assert.deepEqual(writes(fixture.log()), []);
      assert.deepEqual(fixture.state().issues, {});
    } finally {
      fixture.restore();
    }
  },
);

test('CLI: --help says the review result is optional for a carrier', () => {
  const fixture = setup();
  try {
    const result = fixture.run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /optional for a carrier/);
    assert.match(result.stdout, /--shape orphan\|carrier\|roadmap\|child/);
    assert.match(result.stdout, /--anchor <owner>\/<repo>#<number>/);
  } finally {
    fixture.restore();
  }
});

carrierLintTest(
  'CLI: a carrier apply creates a missing authoring-only label before the journal write',
  () => {
    const fixture = setup({ labels: ['status:authoring'] });
    try {
      const result = fixture.run([...carrierFiles(fixture), '--apply']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(writeKinds(fixture), [
        'label',
        'journal-pending',
        'create status:authoring,status:authoring-only',
        'identity-attach',
        'owner-marker',
        'member',
        'owner-marker:release',
        'owner-marker:release-guard',
        'owner-marker:heartbeat',
        'remove-label',
        'owner-marker:release-complete',
      ]);
      const created = fixture.state().issues[String(NEW_ISSUE)] as {
        labels: string[];
      };
      assert.deepEqual(created.labels, ['status:authoring-only']);
    } finally {
      fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a carrier whose created issue lacks its labels gets both back as a safe hold and exits 1',
  () => {
    const fixture = setup({
      labels: ['status:authoring', 'status:authoring-only'],
      dropLabels: true,
    });
    try {
      const result = fixture.run([...carrierFiles(fixture), '--apply']);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.failedStep, 'create-verify');
      assert.equal(report.journalState, 'pending');
      const issue = fixture.state().issues[String(NEW_ISSUE)] as {
        labels: string[];
      };
      assert.deepEqual(issue.labels, [
        'status:authoring',
        'status:authoring-only',
      ]);
      assert.ok(
        !fixture
          .state()
          .comments.some((comment) => comment.issue === NEW_ISSUE),
      );
    } finally {
      fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a carrier accepts an explicit --bucket ready, which is its default',
  () => {
    const fixture = setup({
      labels: ['status:authoring', 'status:authoring-only'],
    });
    try {
      const result = fixture.run([
        ...carrierFiles(fixture),
        '--bucket',
        'ready',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
      assert.deepEqual(writes(fixture.log()), []);
    } finally {
      fixture.restore();
    }
  },
);

test('CLI: an empty --review-result path is a usage error for either shape, before any gh call', () => {
  const fixture = setup({
    labels: ['status:authoring', 'status:authoring-only'],
  });
  try {
    const carrier = fixture.run([
      ...carrierFiles(fixture),
      '--review-result',
      '',
      '--apply',
    ]);
    assert.equal(carrier.status, 2);
    const body = join(fixture.dir, 'orphan-empty.md');
    writeFileSync(body, draftBody());
    const orphan = fixture.run([
      '--title',
      TITLE,
      '--body-file',
      body,
      '--review-result',
      '',
      '--owner',
      'o',
      '--repo',
      'r',
      '--marker-prefix',
      'idd-skill',
      '--apply',
    ]);
    assert.equal(orphan.status, 2);
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

// ---------------------------------------------------------------------------
// Carrier release (contract.md, "Carrier creation-hold exception", #4254).
// ---------------------------------------------------------------------------

/** The carrier args, with the body file replaced by `body`. */
function carrierFilesWithBody(fixture: Fixture, body: string): string[] {
  const args = carrierFiles(fixture);
  writeFileSync(join(fixture.dir, 'carrier.md'), body);
  return args;
}

interface ReleaseRun {
  fixture: Fixture;
  status: number | null;
  report: {
    outcome: string;
    journalState: string;
    release: {
      state: string;
      failedStep: string | null;
      nextAction: string;
      reason: string | null;
      sweeps: { point: string; failed: boolean }[];
      backlog: { point: string; count: number | null }[];
    };
  };
}

/** One carrier apply with the release enabled. */
function releaseRun(
  options: Parameters<typeof setup>[0] = {},
  body?: string,
): ReleaseRun {
  const fixture = setup({
    labels: ['status:authoring', 'status:authoring-only'],
    ...options,
  });
  const args =
    body === undefined
      ? carrierFiles(fixture)
      : carrierFilesWithBody(fixture, body);
  const result = fixture.run([...args, '--apply']);
  return {
    fixture,
    status: result.status,
    report: JSON.parse(result.stdout),
  };
}

function labelsOf(fixture: Fixture): string[] {
  return (fixture.state().issues[String(NEW_ISSUE)] as { labels: string[] })
    .labels;
}

function countOf(kinds: string[], kind: string): number {
  return kinds.filter((entry) => entry === kind).length;
}

carrierLintTest(
  'CLI: a carrier release records the set snapshot, removes only the authoring label, and never closes',
  () => {
    const run = releaseRun();
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.outcome, 'published');
      assert.equal(run.report.journalState, 'member');
      assert.equal(run.report.release.state, 'released');
      assert.equal(run.report.release.failedStep, null);
      assert.deepEqual(writeKinds(run.fixture).slice(5), [
        'owner-marker:release',
        'owner-marker:release-guard',
        'owner-marker:heartbeat',
        'remove-label',
        'owner-marker:release-complete',
      ]);
      assert.equal(countOf(writeKinds(run.fixture), 'remove-label'), 1);
      assert.deepEqual(labelsOf(run.fixture), ['status:authoring-only']);
      assert.equal(
        run.fixture.log().some((entry) => entry.args.includes('close')),
        false,
      );
      const comments = run.fixture.state().comments;
      const acquire = comments.find((c) => c.body.includes('mode=acquire;'));
      const complete = comments.find((c) =>
        c.body.includes('mode=release-complete;'),
      );
      const bodySha = /body-sha256=([0-9a-f]{64});/.exec(acquire?.body ?? '');
      assert.ok(bodySha, 'the acquire marker carries a body digest');
      assert.match(
        complete?.body ?? '',
        new RegExp(
          `snapshot-sha256=${carrierSetSnapshot('o', 'r', NEW_ISSUE, bodySha[1])};`,
        ),
      );
      assert.equal(run.report.release.sweeps.length, 3);
      assert.equal(run.report.release.backlog.length, 3);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a carrier dry run lists the carrier release steps as planned and writes nothing',
  () => {
    const fixture = setup({
      labels: ['status:authoring', 'status:authoring-only'],
    });
    try {
      const result = fixture.run(carrierFiles(fixture));
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      const planned = report.steps.find(
        (step: { step: string }) => step.step === 'carrier-release',
      );
      assert.deepEqual(planned.detail.steps, [
        'release-preflight',
        'release-guard',
        'preconditions',
        'heartbeat',
        'label-removal',
        'release-complete',
        'closing-sweep',
      ]);
      assert.deepEqual(writeKinds(fixture), []);
    } finally {
      fixture.restore();
    }
  },
);

const CARRIER_HELD_CASES: {
  name: string;
  options: Parameters<typeof setup>[0];
  step: string;
}[] = [
  {
    name: 'another set member',
    options: { afterPost: [{ mode: 'acquire', action: 'anotherMember' }] },
    step: 'precondition-sole-member',
  },
  {
    name: 'an inconclusive sole-member result',
    options: { searchIncomplete: true },
    step: 'precondition-sole-member',
  },
  {
    name: 'an unfinished index-lag window',
    options: { indexLagFull: true },
    step: 'precondition-sole-member',
  },
  {
    name: 'a roadmap-id marker outside code',
    options: {
      mutateBodyAt: 3,
      mutateBodyText: '\n<!-- idd-skill-roadmap-id: 9 -->\n',
    },
    step: 'precondition-roadmap-id',
  },
  {
    name: 'a carrier marker that does not appear exactly once',
    options: {
      mutateBodyAt: 3,
      mutateBodyText: '\n<!-- idd-skill-draft-carrier: v1 -->\n',
    },
    step: 'precondition-audit',
  },
  {
    name: 'a body that changed before the release-guard',
    options: {
      afterPost: [
        {
          mode: 'release-guard',
          action: 'mutateBody',
          text: '\nedited by someone else\n',
        },
      ],
    },
    step: 'precondition-body-digest',
  },
  {
    name: 'a body that changed after the heartbeat',
    options: {
      afterPost: [
        {
          mode: 'heartbeat',
          action: 'mutateBody',
          text: '\nedited by someone else\n',
        },
      ],
    },
    step: 'heartbeat-replay',
  },
  {
    name: 'a missing authoring-only label',
    options: {
      afterPost: [
        { mode: 'release', action: 'dropLabel', text: 'status:authoring-only' },
      ],
    },
    step: 'precondition-labels',
  },
  {
    name: 'a failed release post',
    options: { postFail: { mode: 'release', status: 422, landed: false } },
    step: 'release-preflight',
  },
  {
    name: 'a failed release-guard post',
    options: {
      postFail: { mode: 'release-guard', status: 422, landed: false },
    },
    step: 'release-guard',
  },
  {
    name: 'a failed heartbeat post',
    options: { postFail: { mode: 'heartbeat', status: 422, landed: false } },
    step: 'heartbeat',
  },
];

for (const held of CARRIER_HELD_CASES) {
  carrierLintTest(
    `CLI: a carrier release held for ${held.name} keeps the authoring label and exits 0`,
    () => {
      const run = releaseRun(held.options);
      try {
        assert.equal(run.status, 0, JSON.stringify(run.report));
        assert.equal(run.report.outcome, 'published');
        assert.equal(run.report.release.state, 'held');
        assert.equal(run.report.release.failedStep, held.step);
        assert.notEqual(run.report.release.nextAction, '');
        assert.equal(writeKinds(run.fixture).includes('remove-label'), false);
        assert.equal(labelsOf(run.fixture).includes('status:authoring'), true);
      } finally {
        run.fixture.restore();
      }
    },
  );
}

carrierLintTest(
  'CLI: a competing owner marker after the release marker stops the release at recovery-hold with no further write',
  () => {
    const run = releaseRun({
      afterPost: [{ mode: 'release', action: 'competing' }],
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.outcome, 'recovery-hold');
      assert.equal(run.report.journalState, 'member');
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'release-guard');
      assert.equal(writeKinds(run.fixture).at(-1), 'owner-marker:release');
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a label removal that cannot be verified and still shows the label reports held without a restore',
  () => {
    const run = releaseRun({ removeLabelFailure: 'unchanged' });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'held');
      assert.equal(run.report.release.failedStep, 'label-removal');
      assert.equal(countOf(writeKinds(run.fixture), 'add-label'), 0);
      assert.equal(labelsOf(run.fixture).includes('status:authoring'), true);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a failed verification after the label removal restores the authoring label once and reports held',
  () => {
    const run = releaseRun({ dropReleaseAfterRemove: true });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'held');
      assert.equal(run.report.release.failedStep, 'label-removal-verify');
      assert.equal(countOf(writeKinds(run.fixture), 'add-label'), 1);
      assert.deepEqual([...labelsOf(run.fixture)].sort(), [
        'status:authoring',
        'status:authoring-only',
      ]);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a failed label restore after a failed verification reports recovery-hold and exits 1',
  () => {
    const run = releaseRun({
      dropReleaseAfterRemove: true,
      failAddLabel: true,
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.outcome, 'recovery-hold');
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'label-restore');
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a release-complete post that errors after landing reconciles to released',
  () => {
    const run = releaseRun({
      postFail: { mode: 'release-complete', status: 502, landed: true },
    });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'released');
      assert.deepEqual(labelsOf(run.fixture), ['status:authoring-only']);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a release-complete post that sent nothing reapplies the authoring label and reports held',
  () => {
    const run = releaseRun({
      postFail: { mode: 'release-complete', status: 422, landed: false },
    });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'held');
      assert.equal(run.report.release.failedStep, 'release-complete');
      assert.equal(countOf(writeKinds(run.fixture), 'add-label'), 1);
      assert.deepEqual([...labelsOf(run.fixture)].sort(), [
        'status:authoring',
        'status:authoring-only',
      ]);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a release-complete reapply that fails reports recovery-hold and exits 1',
  () => {
    const run = releaseRun({
      postFail: { mode: 'release-complete', status: 422, landed: false },
      failAddLabel: true,
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'label-restore');
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: an inconclusive release-complete reconciliation keeps the release guard and reports recovery-hold',
  () => {
    const run = releaseRun({
      postFail: { mode: 'release-complete', status: 500, landed: false },
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'release-complete');
      const kinds = writeKinds(run.fixture);
      assert.equal(countOf(kinds, 'owner-marker:release-guard'), 1);
      assert.equal(countOf(kinds, 'add-label'), 0);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a failing sweep is recorded and still reaches released',
  () => {
    const run = releaseRun({ failSweep: true });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'released');
      assert.ok(run.report.release.sweeps.some((sweep) => sweep.failed));
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a carrier with a roadmap-id marker and a placeholder inside its fenced draft is released',
  () => {
    const fenced = CARRIER_BODY.replace(
      'Shape: orphan',
      'Shape: roadmap',
    ).replace(
      '\n# Follow-up B\n',
      '\n# Roadmap draft\n\n<!-- idd-skill-roadmap-id: 9 -->\n\n- [ ] #<child>\n',
    );
    const run = releaseRun({}, fenced);
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'released');
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a release-complete reconciliation whose reads stay unreadable keeps the release guard and reports recovery-hold',
  () => {
    const run = releaseRun({
      postFail: { mode: 'release-complete', status: 500, landed: false },
      failReadsOnComplete: true,
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'release-complete');
      const kinds = writeKinds(run.fixture);
      assert.equal(countOf(kinds, 'owner-marker:release-guard'), 1);
      assert.equal(countOf(kinds, 'add-label'), 0);
    } finally {
      run.fixture.restore();
    }
  },
);

test('CLI: a carrier whose authoring-only label has the authoring name is refused before any write', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    authoringOnlyLabelName: 'status:authoring',
  });
  try {
    const result = fixture.run([...carrierFiles(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /must be different, non-empty names/);
    assert.deepEqual(writeKinds(fixture), []);
  } finally {
    fixture.restore();
  }
});

test('release: a notDispatched or HTTP 401, 404 or 422 envelope proves nothing was sent; other envelopes do not', () => {
  const envelope = (fields: Record<string, unknown>): string =>
    JSON.stringify({
      iddHelperError: { helper: 'post-idd-marker', message: 'x', ...fields },
    });
  assert.equal(markerPostSentNothing(envelope({ notDispatched: true })), true);
  assert.equal(markerPostSentNothing(envelope({ httpStatus: 422 })), true);
  assert.equal(markerPostSentNothing(envelope({ httpStatus: 502 })), false);
  assert.equal(markerPostSentNothing('gh: boom'), false);
});

test('release: the set snapshot normalizes the repository identity before hashing', () => {
  const bodySha = 'a'.repeat(64);
  const expected = createHash('sha256')
    .update(`kurone-kito/idd-skill#4254:${bodySha}`, 'utf8')
    .digest('hex');
  assert.equal(
    carrierSetSnapshot('Kurone-Kito', 'IDD-Skill', 4254, bodySha),
    expected,
  );
});

carrierLintTest(
  'CLI: a removal that also drops the authoring-only label restores both labels and reports held',
  () => {
    const run = releaseRun({ dropAuthoringOnlyOnRemove: true });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'held');
      assert.equal(run.report.release.failedStep, 'label-removal-verify');
      assert.equal(countOf(writeKinds(run.fixture), 'add-label'), 1);
      assert.deepEqual([...labelsOf(run.fixture)].sort(), [
        'status:authoring',
        'status:authoring-only',
      ]);
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a label removal whose follow-up reads stay unreadable reports recovery-hold and exits 1',
  () => {
    const run = releaseRun({ failReadsAfterRemove: true });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.outcome, 'recovery-hold');
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'label-removal');
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a release marker of this run with the wrong fields stops the release at recovery-hold before any release write',
  () => {
    const run = releaseRun({
      afterPost: [{ mode: 'acquire', action: 'malformedRelease' }],
    });
    try {
      assert.equal(run.status, 1, JSON.stringify(run.report));
      assert.equal(run.report.outcome, 'recovery-hold');
      assert.equal(run.report.release.state, 'recovery-hold');
      assert.equal(run.report.release.failedStep, 'release-preflight');
      assert.equal(
        writeKinds(run.fixture).includes('owner-marker:release'),
        false,
      );
    } finally {
      run.fixture.restore();
    }
  },
);

carrierLintTest(
  'CLI: a body edit that lands after the removal is caught by the completion drift check, restores the labels, and reports held',
  () => {
    const run = releaseRun({
      mutateBodyOnSweep: '\nedited after the removal\n',
    });
    try {
      assert.equal(run.status, 0, JSON.stringify(run.report));
      assert.equal(run.report.release.state, 'held');
      assert.equal(run.report.release.failedStep, 'release-complete');
      assert.equal(countOf(writeKinds(run.fixture), 'add-label'), 1);
      assert.deepEqual([...labelsOf(run.fixture)].sort(), [
        'status:authoring',
        'status:authoring-only',
      ]);
      assert.equal(
        writeKinds(run.fixture).includes('owner-marker:release-complete'),
        false,
      );
    } finally {
      run.fixture.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// Roadmap and child shapes (#4251). A roadmap is its own set anchor, like an
// orphan. A child joins the set of an existing anchor.
// ---------------------------------------------------------------------------

const ANCHOR_REF = `o/r#${ANCHOR}`;
const ANCHOR_OWNER = 'owner-anchor';
const ANCHOR_SET = 'set-anchor';
const ANCHOR_SESSION = 'session-anchor';
const SUITABILITY_FOOTER = [
  '---',
  '',
  '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;',
  'below the configured floor is human-oriented._',
  '',
  '<!-- idd-skill-autopilot-suitability: 4 -->',
  '',
  '_Effort: M -- author-estimated size; a soft autopilot',
  'selection tie-breaker only._',
  '',
  '<!-- idd-skill-effort: M -->',
];

/** A roadmap shell with an empty Tracks list, which is valid until children
 * exist. */
function roadmapDraftBody(): string {
  return [
    '## Goal',
    '',
    'Ship the sample initiative.',
    '',
    '## Background',
    '',
    'Some background text.',
    '',
    '## Tracks',
    '',
    '## Success criteria',
    '',
    '- [ ] Every child is merged',
    '',
    '<!-- idd-skill-roadmap-id: sample-roadmap -->',
    '',
    ...SUITABILITY_FOOTER,
  ].join('\n');
}

function childDraftBody(): string {
  return [
    '## Background',
    '',
    'Some background text.',
    '',
    '## Proposed change',
    '',
    'Do the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/example.test.mts` passes with the new case covered',
    '',
    '## Candidate files',
    '',
    '- `tests/example.test.mts`',
    '',
    ...SUITABILITY_FOOTER,
  ].join('\n');
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The publication line the anchor's body starts with, as the helper writes it. */
const ANCHOR_PUBLICATION_LINE = `<!-- idd-skill-authoring-publication: target=target-anchor; anchor=target-anchor; set=${ANCHOR_SET}; session=${ANCHOR_SESSION}; token=token-anchor -->`;

/** The anchor's body: its publication line, then the roadmap shell. */
function anchorBodyText(): string {
  return `${ANCHOR_PUBLICATION_LINE}\n\n${roadmapDraftBody()}`;
}

/** The arguments of a roadmap or child publication; the caller adds the
 * shape and, for a child, the anchor. */
function shapeFiles(fixture: Fixture, body: string): string[] {
  const bodyPath = join(fixture.dir, 'shape-body.md');
  const resultPath = join(fixture.dir, 'shape-review.json');
  writeFileSync(bodyPath, body);
  writeFileSync(resultPath, JSON.stringify({ completed: true }));
  return [
    '--title',
    'Add the sample issue',
    '--body-file',
    bodyPath,
    '--review-result',
    resultPath,
    '--owner',
    'o',
    '--repo',
    'r',
    '--marker-prefix',
    'idd-skill',
  ];
}

function roadmapArgs(fixture: Fixture): string[] {
  return [...shapeFiles(fixture, roadmapDraftBody()), '--shape', 'roadmap'];
}

function childArgs(fixture: Fixture, anchor = ANCHOR_REF): string[] {
  return [
    ...shapeFiles(fixture, childDraftBody()),
    '--shape',
    'child',
    '--anchor',
    anchor,
  ];
}

function ownerMarkerText(
  mode: string,
  fields: {
    owner?: string;
    set?: string;
    session?: string;
    bodySha256?: string;
    snapshotSha256?: string;
    supersedes?: string;
    target?: string;
    anchor?: string;
  } = {},
): string {
  // The anchor-only modes carry no body digest (contract.md, mode table).
  const anchorOnly = mode === 'release-guard' || mode === 'release-complete';
  return [
    `<!-- idd-skill-authoring-owner: target=${fields.target ?? ANCHOR_REF}; anchor=${fields.anchor ?? ANCHOR_REF}; mode=${mode}; owner=${fields.owner ?? ANCHOR_OWNER}; set=${fields.set ?? ANCHOR_SET}; session=${fields.session ?? ANCHOR_SESSION}; body-sha256=${fields.bodySha256 ?? (anchorOnly ? 'none' : sha256Of(anchorBodyText()))}; snapshot-sha256=${fields.snapshotSha256 ?? (mode === 'release-complete' ? 'c'.repeat(64) : 'none')}; supersedes=${fields.supersedes ?? (mode === 'acquire' || mode === 'bootstrap' ? 'none' : (fields.owner ?? ANCHOR_OWNER))} -->`,
    '_Issue-authoring ownership marker. Do not edit or delete._',
  ].join('\n');
}

/**
 * Seed the set anchor in the stub: an open, labelled roadmap whose log holds
 * the given owner markers (by default one acquire). Returns the anchor body.
 */
/** A publication-intent record of the anchor, as the helper writes it. */
function journalIntentText(
  state: string,
  fields: {
    set?: string;
    issue?: string;
    actor?: string;
    token?: string;
    journal?: string;
    anchor?: string;
  } = {},
): string {
  return [
    `<!-- idd-skill-authoring-publication-intent: target=target-anchor; anchor=${fields.anchor ?? 'target-anchor'}; set=${fields.set ?? ANCHOR_SET}; session=${ANCHOR_SESSION}; token=${fields.token ?? 'token-anchor'}; journal=${fields.journal ?? 'o/r#2674'}; issue=${fields.issue ?? ANCHOR_REF}; actor=${fields.actor ?? 'kurone-kito'}; state=${state} -->`,
    '_Issue-authoring publication-intent record. Do not edit or delete._',
  ].join('\n');
}

/** The anchor's records as the helper writes them: pending, attached, member. */
function holdSequence(
  fields: Parameters<typeof journalIntentText>[1] = {},
): string[] {
  return [
    journalIntentText('pending', { ...fields, issue: 'none' }),
    journalIntentText('pending', fields),
    journalIntentText('member', fields),
  ];
}

function seedAnchor(
  fixture: Fixture,
  options: {
    state?: string;
    labels?: string[];
    markers?: string[];
    extraComments?: string[];
    createdAt?: string;
    /** The anchor's records in the journal; by default one member record. */
    journalRecords?: string[];
    /** The anchor's body; by default its publication line and roadmap shell. */
    body?: string;
  } = {},
): string {
  const body = options.body ?? anchorBodyText();
  const markers = options.markers ?? [ownerMarkerText('acquire')];
  const hold = options.journalRecords ?? [
    journalIntentText('pending', { issue: 'none' }),
    journalIntentText('pending'),
    journalIntentText('member'),
  ];
  fixture.seed((stored) => {
    for (const [index, text] of hold.entries()) {
      stored.comments.push({
        id: 4090 + index,
        issue: 2674,
        body: text,
        user: 'kurone-kito',
        createdAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
      });
    }
    stored.issues[String(ANCHOR)] = {
      body,
      labels: options.labels ?? ['status:authoring'],
      state: options.state ?? 'open',
    };
    for (const [index, text] of [
      ...markers,
      ...(options.extraComments ?? []),
    ].entries()) {
      stored.comments.push({
        id: 4100 + index,
        issue: ANCHOR,
        body: text,
        user: 'kurone-kito',
        createdAt:
          options.createdAt ??
          new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
      });
    }
  });
  return body;
}

function anchorComments(fixture: Fixture): string[] {
  return fixture
    .state()
    .comments.filter((comment) => comment.issue === ANCHOR)
    .map((comment) => comment.body);
}

function childComments(fixture: Fixture): string[] {
  return fixture
    .state()
    .comments.filter((comment) => comment.issue === NEW_ISSUE)
    .map((comment) => comment.body);
}

function provenanceComment(
  id: number,
  mode: string,
  fields: Parameters<typeof ownerMarkerText>[1] = {},
  overrides: {
    authorLogin?: string;
    lastEditedAt?: string | null;
    body?: string;
    isMinimized?: boolean;
    minimizedReason?: string | null;
    omitMinimization?: boolean;
  } = {},
): AuthoringOwnerProvenanceComment {
  const createdAt = new Date(Date.UTC(2026, 9, 12, 0, id)).toISOString();
  return {
    id,
    authorLogin: overrides.authorLogin ?? 'kurone-kito',
    body: overrides.body ?? ownerMarkerText(mode, fields),
    createdAt,
    updatedAt: createdAt,
    lastEditedAt: overrides.lastEditedAt ?? null,
    ...(overrides.omitMinimization === true
      ? {}
      : {
          isMinimized: overrides.isMinimized ?? false,
          minimizedReason: overrides.minimizedReason ?? null,
        }),
  };
}

function replay(comments: AuthoringOwnerProvenanceComment[]) {
  return resolveAnchorGeneration({
    comments,
    anchorRef: ANCHOR_REF,
    markerPrefix: 'idd-skill',
    trusted: ['kurone-kito'],
  });
}

test('child ids: the anchor is the real reference and the set and session are the anchor`s', () => {
  let counter = 0;
  const ids = generateChildPublicationIds(
    { ref: ANCHOR_REF, set: ANCHOR_SET, session: ANCHOR_SESSION },
    () => {
      counter += 1;
      return `u${counter}`;
    },
  );
  assert.deepEqual(ids, {
    target: 'target-u1',
    anchor: ANCHOR_REF,
    set: ANCHOR_SET,
    session: ANCHOR_SESSION,
    token: 'token-u2',
    owner: 'owner-u3',
  });
  const body = injectPublicationLine('## Background\n', 'idd-skill', ids);
  assert.equal(
    body.split('\n')[0],
    `<!-- idd-skill-authoring-publication: target=target-u1; anchor=${ANCHOR_REF}; set=${ANCHOR_SET}; session=${ANCHOR_SESSION}; token=token-u2 -->`,
  );
});

test('lint args: a roadmap and a child pass their own shape', () => {
  for (const shape of ['roadmap', 'child']) {
    const args = buildLintArgs({
      shape,
      title: 't',
      bodyFile: 'b.md',
      markerPrefix: 'idd-skill',
      currentRepo: 'o/r',
      bucket: 'ready',
      labels: resolvePublishLabels({}, 'ready', shape),
    });
    assert.deepEqual(args.slice(0, 3), ['--shape', shape, '--new-issue']);
    assert.ok(!args.includes('--label'));
    assert.deepEqual(resolvePublishLabels({}, 'ready', shape), [
      'status:authoring',
    ]);
  }
});

test('anchor replay: an acquire opens a generation and heartbeats and resumes keep it open', () => {
  const opened = replay([provenanceComment(1, 'acquire')]);
  assert.ok('generation' in opened, JSON.stringify(opened));
  assert.equal(opened.generation.owner, ANCHOR_OWNER);
  assert.equal(opened.generation.set, ANCHOR_SET);
  assert.equal(opened.generation.session, ANCHOR_SESSION);
  assert.equal(opened.generation.latest.mode, 'acquire');

  const beaten = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'heartbeat', { session: 'session-other' }),
  ]);
  assert.ok('generation' in beaten, JSON.stringify(beaten));
  assert.equal(beaten.generation.session, ANCHOR_SESSION);
  assert.equal(beaten.generation.latest.mode, 'heartbeat');
  assert.equal(beaten.generation.latest.id, 2);

  const resumed = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'resume', {
      owner: 'owner-next',
      session: 'session-next',
      supersedes: ANCHOR_OWNER,
    }),
    provenanceComment(3, 'heartbeat', { owner: 'owner-next' }),
  ]);
  assert.ok('generation' in resumed, JSON.stringify(resumed));
  assert.equal(resumed.generation.owner, 'owner-next');
  assert.equal(resumed.generation.session, 'session-next');
  assert.equal(resumed.generation.set, ANCHOR_SET);
});

test('anchor replay: a resume keeps a release in progress until release-complete closes it', () => {
  const resumed = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
    provenanceComment(3, 'resume', {
      owner: 'owner-next',
      session: 'session-next',
      supersedes: ANCHOR_OWNER,
    }),
  ]);
  assert.ok('problem' in resumed, JSON.stringify(resumed));
  assert.match(resumed.problem, /being released/);

  // The resumed owner can still finish the release.
  const finished = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
    provenanceComment(3, 'resume', {
      owner: 'owner-next',
      session: 'session-next',
      supersedes: ANCHOR_OWNER,
    }),
    provenanceComment(4, 'release-complete', {
      owner: 'owner-next',
      session: 'session-next',
    }),
  ]);
  assert.ok('problem' in finished);
  assert.match(finished.problem, /no open owner generation/);
});

test('anchor replay: a bootstrap opens a generation too', () => {
  const result = replay([provenanceComment(1, 'bootstrap')]);
  assert.ok('generation' in result, JSON.stringify(result));
});

test('anchor replay: a released set is not joinable, and a new acquire after release-complete opens a fresh one', () => {
  const releasing = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
  ]);
  assert.ok('problem' in releasing);
  assert.match(releasing.problem, /being released/);

  const guarded = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release-guard'),
    provenanceComment(3, 'heartbeat'),
  ]);
  assert.ok('problem' in guarded);
  assert.match(guarded.problem, /being released/);

  const completed = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
    provenanceComment(3, 'release-complete'),
  ]);
  assert.ok('problem' in completed);
  assert.match(completed.problem, /no open owner generation/);

  const again = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
    provenanceComment(3, 'release-complete'),
    provenanceComment(4, 'acquire', { owner: 'owner-new', set: 'set-new' }),
  ]);
  assert.ok('generation' in again, JSON.stringify(again));
  assert.equal(again.generation.set, 'set-new');
  assert.equal(again.generation.owner, 'owner-new');

  // A completed set stays closed: a later acquisition needs a fresh set id.
  for (const mode of ['acquire', 'bootstrap']) {
    const reopened = replay([
      provenanceComment(1, 'acquire'),
      provenanceComment(2, 'release'),
      provenanceComment(3, 'release-complete'),
      provenanceComment(4, mode, { owner: 'owner-new' }),
    ]);
    assert.ok('problem' in reopened, `${mode}: ${JSON.stringify(reopened)}`);
    assert.match(reopened.problem, /reuses set set-anchor/);
  }
});

test('anchor replay: the terminal modes retain the session and close only a release in progress', () => {
  // A release-complete with no release before it closes nothing.
  const early = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release-complete'),
  ]);
  assert.ok('problem' in early);
  assert.match(early.problem, /no release in progress/);

  // A heartbeat does not start a release either.
  const beaten = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'heartbeat'),
    provenanceComment(3, 'release-complete'),
  ]);
  assert.ok('problem' in beaten);

  // The anchor-only terminal markers retain the current session.
  for (const mode of ['release-guard', 'release-complete']) {
    const other = replay([
      provenanceComment(1, 'acquire'),
      provenanceComment(2, 'release'),
      provenanceComment(3, mode, { session: 'session-other' }),
    ]);
    assert.ok('problem' in other, mode);
    assert.match(other.problem, /does not retain the session/);
  }

  // A release-guard after the release, then the matching complete, closes it.
  const closed = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'release'),
    provenanceComment(3, 'release-guard'),
    provenanceComment(4, 'release-complete'),
  ]);
  assert.ok('problem' in closed);
  assert.match(closed.problem, /no open owner generation/);
});

test('anchor replay: a marker that breaks the field rules of its mode is not a valid owner marker', () => {
  const cases: [string, Parameters<typeof provenanceComment>[2]][] = [
    ['acquire', { supersedes: 'owner-other' }],
    ['acquire', { bodySha256: 'none' }],
    ['bootstrap', { supersedes: 'owner-other' }],
    ['bootstrap', { bodySha256: 'none' }],
  ];
  for (const [mode, fields] of cases) {
    const result = replay([provenanceComment(1, mode, fields)]);
    assert.ok('problem' in result, `${mode}: ${JSON.stringify(result)}`);
    assert.match(result.problem, /is malformed/);
  }
  // The same rules bind the markers that extend an open generation.
  const extending: [string, Parameters<typeof provenanceComment>[2]][] = [
    ['heartbeat', { supersedes: 'owner-other' }],
    ['heartbeat', { bodySha256: 'none' }],
    ['release', { supersedes: 'none' }],
    ['release-guard', { bodySha256: sha256Of('body') }],
    ['release-complete', { snapshotSha256: 'none' }],
    ['resume', { owner: 'owner-next', supersedes: 'owner-next' }],
  ];
  for (const [mode, fields] of extending) {
    const result = replay([
      provenanceComment(1, 'acquire'),
      provenanceComment(2, mode, fields),
    ]);
    assert.ok('problem' in result, `${mode}: ${JSON.stringify(result)}`);
    assert.match(result.problem, /is malformed/);
  }
});

test('anchor replay: a log that is not exactly one owner generation fails closed', () => {
  const none = replay([]);
  assert.ok('problem' in none);
  assert.match(none.problem, /no open owner generation/);

  // The first valid opener wins; a later opener loses and so do its markers.
  const raced = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'acquire', { owner: 'owner-rival', set: 'set-rival' }),
    provenanceComment(3, 'heartbeat', {
      owner: 'owner-rival',
      set: 'set-rival',
    }),
    provenanceComment(4, 'resume', {
      owner: 'owner-rival-next',
      set: 'set-rival',
      supersedes: 'owner-rival',
    }),
    provenanceComment(5, 'heartbeat', {
      owner: 'owner-rival-next',
      set: 'set-rival',
    }),
    provenanceComment(6, 'heartbeat'),
  ]);
  assert.ok('generation' in raced, JSON.stringify(raced));
  assert.equal(raced.generation.owner, ANCHOR_OWNER);
  assert.equal(raced.generation.set, ANCHOR_SET);
  assert.equal(raced.generation.latest.id, 6);

  // A bootstrap races the same way.
  const bootRace = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'bootstrap', { owner: 'owner-rival' }),
  ]);
  assert.ok('generation' in bootRace, JSON.stringify(bootRace));
  assert.equal(bootRace.generation.owner, ANCHOR_OWNER);

  // A loser belonged to the generation that closed: it may open the next one.
  const nextGeneration = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'acquire', { owner: 'owner-rival', set: 'set-rival' }),
    provenanceComment(3, 'release'),
    provenanceComment(4, 'release-complete'),
    provenanceComment(5, 'acquire', { owner: 'owner-rival', set: 'set-next' }),
  ]);
  assert.ok('generation' in nextGeneration, JSON.stringify(nextGeneration));
  assert.equal(nextGeneration.generation.owner, 'owner-rival');
  assert.equal(nextGeneration.generation.set, 'set-next');

  // The same owner opening its own generation twice is a malformed log.
  const twice = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'acquire'),
  ]);
  assert.ok('problem' in twice);
  assert.match(twice.problem, /second time/);

  const stranger = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'heartbeat', { owner: 'owner-rival' }),
  ]);
  assert.ok('problem' in stranger);
  assert.match(stranger.problem, /does not match the open generation/);

  const badResume = replay([
    provenanceComment(1, 'acquire'),
    provenanceComment(2, 'resume', {
      owner: 'owner-next',
      supersedes: 'owner-unrelated',
    }),
  ]);
  assert.ok('problem' in badResume);

  const strayHeartbeat = replay([provenanceComment(1, 'heartbeat')]);
  assert.ok('problem' in strayHeartbeat);
});

test('anchor replay: an edited, unparseable, untrusted or mistargeted marker is handled without a guess', () => {
  const edited = replay([
    provenanceComment(
      1,
      'acquire',
      {},
      { lastEditedAt: '2026-10-12T01:00:00Z' },
    ),
  ]);
  assert.ok('problem' in edited);
  assert.match(edited.problem, /edited/);

  const unreadable = replay([
    provenanceComment(1, 'acquire', {}, { lastEditedAt: '' }),
  ]);
  assert.ok('problem' in unreadable);

  const garbled = replay([
    provenanceComment(
      1,
      'acquire',
      {},
      {
        body: '<!-- idd-skill-authoring-owner: target=oops -->',
      },
    ),
  ]);
  assert.ok('problem' in garbled);
  assert.match(garbled.problem, /does not parse/);

  const otherTarget = replay([
    provenanceComment(1, 'acquire', { target: 'o/r#9' }),
  ]);
  assert.ok('problem' in otherTarget);
  assert.match(otherTarget.problem, /not the anchor/);

  const otherAnchor = replay([
    provenanceComment(1, 'acquire', { anchor: 'o/r#9' }),
  ]);
  assert.ok('problem' in otherAnchor);

  // An untrusted author's marker is not evidence, so it is ignored.
  const untrusted = replay([
    provenanceComment(1, 'acquire', {}, { authorLogin: 'someone-else' }),
  ]);
  assert.ok('problem' in untrusted);
  assert.match(untrusted.problem, /no open owner generation/);

  // The anchor is compared without regard to case.
  const mixedCase = replay([
    provenanceComment(1, 'acquire', {
      target: ANCHOR_REF.toUpperCase(),
      anchor: ANCHOR_REF.toUpperCase(),
    }),
  ]);
  assert.ok('generation' in mixedCase, JSON.stringify(mixedCase));
});

test('anchor replay: minimization evidence is read, and a hidden latest marker proves nothing', () => {
  // History that a sweep hid still counts when a visible marker follows it.
  const swept = replay([
    provenanceComment(
      1,
      'acquire',
      {},
      {
        isMinimized: true,
        minimizedReason: 'OUTDATED',
      },
    ),
    provenanceComment(2, 'heartbeat'),
  ]);
  assert.ok('generation' in swept, JSON.stringify(swept));
  assert.equal(swept.generation.latest.mode, 'heartbeat');

  // The marker that carries the generation to now is never a hidden one.
  const hidden = replay([
    provenanceComment(
      1,
      'acquire',
      {},
      {
        isMinimized: true,
        minimizedReason: 'OUTDATED',
      },
    ),
  ]);
  assert.ok('problem' in hidden);
  assert.match(hidden.problem, /minimized as outdated/);

  // Unreadable minimization evidence fails closed.
  for (const overrides of [
    { omitMinimization: true },
    { isMinimized: true, minimizedReason: null },
    { isMinimized: true, minimizedReason: '  ' },
  ]) {
    const unreadable = replay([provenanceComment(1, 'acquire', {}, overrides)]);
    assert.ok('problem' in unreadable, JSON.stringify(overrides));
    assert.match(unreadable.problem, /no readable minimization state/);
  }
});

function intentComment(
  id: number,
  state: string,
  fields: Parameters<typeof journalIntentText>[1] = {},
  overrides: {
    authorLogin?: string;
    lastEditedAt?: string | null;
    body?: string;
  } = {},
): AuthoringOwnerProvenanceComment {
  const createdAt = new Date(Date.UTC(2026, 9, 12, 0, id)).toISOString();
  return {
    id,
    authorLogin: overrides.authorLogin ?? 'kurone-kito',
    body: overrides.body ?? journalIntentText(state, fields),
    createdAt,
    updatedAt: createdAt,
    lastEditedAt: overrides.lastEditedAt ?? null,
    isMinimized: false,
    minimizedReason: null,
  };
}

function holdReplay(comments: AuthoringOwnerProvenanceComment[]) {
  return replayAnchorHold({
    comments,
    publication: {
      target: 'target-anchor',
      anchor: 'target-anchor',
      set: ANCHOR_SET,
      session: ANCHOR_SESSION,
      token: 'token-anchor',
    },
    anchorRef: ANCHOR_REF,
    journalRef: 'o/r#2674',
    markerPrefix: 'idd-skill',
    trusted: ['kurone-kito'],
  });
}

test('hold replay: the exact token must run pending, attached, member without a gap', () => {
  const sequence = [
    intentComment(1, 'pending', { issue: 'none' }),
    intentComment(2, 'pending'),
    intentComment(3, 'member'),
  ];
  assert.equal(holdReplay(sequence), null);
  // Records of other tokens and unrelated comments do not matter.
  assert.equal(
    holdReplay([
      intentComment(10, 'member', { token: 'token-other' }),
      { ...intentComment(11, 'member'), body: 'a plain comment' },
      ...sequence,
    ]),
    null,
  );
  // A later cleanup and abandoned pair leaves the token not a member.
  assert.match(
    holdReplay([
      ...sequence,
      intentComment(4, 'cleanup'),
      intentComment(5, 'abandoned'),
    ]) ?? '',
    /is abandoned, not member/,
  );
  assert.match(holdReplay([]) ?? '', /no publication-intent record/);
  // A token that only starts with the anchor's token is another token.
  assert.equal(
    holdReplay([
      intentComment(9, 'member', { token: 'token-anchor-2' }),
      ...sequence,
    ]),
    null,
  );
  assert.match(
    holdReplay(sequence.slice(0, 2)) ?? '',
    /is pending, not member/,
  );
});

test('hold replay: a missing, repeated or reordered record fails closed', () => {
  // member straight after the pending record without an issue
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'member'),
    ]) ?? '',
    /before any record attached its issue/,
  );
  // the history does not start at the pending record
  assert.match(
    holdReplay([intentComment(1, 'member')]) ?? '',
    /not the pending record without an issue/,
  );
  // member, cleanup, then member again
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending'),
      intentComment(3, 'member'),
      intentComment(4, 'cleanup'),
      intentComment(5, 'member'),
    ]) ?? '',
    /from cleanup to member, which is out of order/,
  );
  // a pending record after member
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending'),
      intentComment(3, 'member'),
      intentComment(4, 'pending'),
    ]) ?? '',
    /from member to pending, which is out of order/,
  );
  // the contract's sequence has one pending record without an issue and one
  // that attaches it, and no other pending record
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending', { issue: 'none' }),
    ]) ?? '',
    /repeats a pending record/,
  );
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending'),
      intentComment(3, 'pending'),
      intentComment(4, 'member'),
    ]) ?? '',
    /repeats a pending record/,
  );
  // the issue is dropped, or changed, once attached
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending'),
      intentComment(3, 'pending', { issue: 'none' }),
    ]) ?? '',
    /repeats a pending record/,
  );
  assert.match(
    holdReplay([
      intentComment(1, 'pending', { issue: 'none' }),
      intentComment(2, 'pending'),
      intentComment(3, 'member', { issue: 'o/r#4001' }),
    ]) ?? '',
    /changes the issue of the token/,
  );
});

test('hold replay: a respaced record of the token is still read, and minimization is checked', () => {
  const sequence = [
    intentComment(1, 'pending', { issue: 'none' }),
    intentComment(2, 'pending'),
    intentComment(3, 'member'),
  ];
  // A record whose spacing differs from the canonical one is still this
  // token's record, so an out-of-order state in it cannot hide.
  const respaced = intentComment(
    4,
    'cleanup',
    {},
    {
      body: journalIntentText('cleanup').replace(
        'token=token-anchor',
        'token = token-anchor',
      ),
    },
  );
  assert.match(
    holdReplay([...sequence, respaced, intentComment(5, 'member')]) ?? '',
    /out of order/,
  );
  // History hidden by a sweep still counts; a hidden latest record does not.
  const hiddenHistory = sequence.map((comment, index) =>
    index < 2
      ? { ...comment, isMinimized: true, minimizedReason: 'OUTDATED' }
      : comment,
  );
  assert.equal(holdReplay(hiddenHistory), null);
  const hiddenLatest = [
    ...sequence.slice(0, 2),
    { ...sequence[2], isMinimized: true, minimizedReason: 'OUTDATED' },
  ] as AuthoringOwnerProvenanceComment[];
  assert.match(holdReplay(hiddenLatest) ?? '', /minimized as outdated/);
  // Unreadable minimization evidence fails closed.
  for (const broken of [
    { isMinimized: undefined },
    { isMinimized: true, minimizedReason: null },
  ]) {
    assert.match(
      holdReplay([
        ...sequence.slice(0, 2),
        { ...sequence[2], ...broken } as AuthoringOwnerProvenanceComment,
      ]) ?? '',
      /no readable minimization state/,
    );
  }
});

test('hold replay: an edited, untrusted, mismatched or unparseable record of the token fails closed', () => {
  const valid = [
    intentComment(1, 'pending', { issue: 'none' }),
    intentComment(2, 'pending'),
  ];
  // A pending record edited into member is not an append-only transition.
  for (const lastEditedAt of ['2026-10-12T01:00:00Z', 'not-a-time']) {
    const edited = holdReplay([
      ...valid,
      intentComment(
        3,
        'member',
        {},
        {
          lastEditedAt,
        },
      ),
    ]);
    assert.match(
      edited ?? '',
      /edited after posting|edit state/,
      String(lastEditedAt),
    );
  }
  assert.match(
    holdReplay([
      ...valid,
      intentComment(3, 'member', {}, { authorLogin: 'someone-else' }),
    ]) ?? '',
    /not a trusted marker actor/,
  );
  assert.match(
    holdReplay([
      ...valid,
      intentComment(3, 'member', { actor: 'someone-else' }),
    ]) ?? '',
    /conflicts with the anchor's publication line/,
  );
  assert.match(
    holdReplay([
      ...valid,
      intentComment(
        3,
        'member',
        {},
        {
          body: '<!-- idd-skill-authoring-publication-intent: token=token-anchor; nope -->',
        },
      ),
    ]) ?? '',
    /does not parse/,
  );
});

test('CLI: a roadmap or child usage error exits 2 before any gh call', () => {
  const fixture = setup();
  try {
    const cases: { argv: string[]; match: RegExp }[] = [
      {
        argv: [...shapeFiles(fixture, childDraftBody()), '--shape', 'child'],
        match: /--anchor .* is required for --shape child/,
      },
      {
        argv: [
          ...shapeFiles(fixture, childDraftBody()),
          '--shape',
          'child',
          '--anchor',
          '',
        ],
        match: /--anchor .* is required for --shape child/,
      },
      {
        argv: [
          ...shapeFiles(fixture, childDraftBody()),
          '--shape',
          'child',
          '--anchor',
          'not-a-reference',
        ],
        match: /--anchor must be an owner\/repo#number reference/,
      },
      {
        argv: [
          ...shapeFiles(fixture, childDraftBody()),
          '--shape',
          'child',
          '--anchor',
          'o/r#0',
        ],
        match: /--anchor must be an owner\/repo#number reference/,
      },
      {
        argv: [...roadmapArgs(fixture), '--anchor', ANCHOR_REF],
        match: /--anchor is only valid with --shape child/,
      },
      {
        argv: [...roadmapArgs(fixture), '--anchor', ''],
        match: /--anchor is only valid with --shape child/,
      },
      {
        argv: [...files(fixture), '--anchor', ANCHOR_REF],
        match: /--anchor is only valid with --shape child/,
      },
      {
        argv: [...carrierFiles(fixture), '--anchor', ANCHOR_REF],
        match: /--anchor is only valid with --shape child/,
      },
      {
        argv: [
          ...shapeFiles(fixture, childDraftBody()),
          '--shape',
          'child',
          '--anchor',
          ANCHOR_REF,
          '--bogus',
        ],
        match: /bogus/,
      },
      {
        argv: [
          ...shapeFiles(fixture, childDraftBody()).filter(
            (arg, index, all) =>
              arg !== '--review-result' && all[index - 1] !== '--review-result',
          ),
          '--shape',
          'child',
          '--anchor',
          ANCHOR_REF,
        ],
        match: /--review-result is required for --shape child/,
      },
      {
        argv: [
          ...shapeFiles(fixture, roadmapDraftBody()).filter(
            (arg, index, all) =>
              arg !== '--review-result' && all[index - 1] !== '--review-result',
          ),
          '--shape',
          'roadmap',
        ],
        match: /--review-result is required for --shape roadmap/,
      },
      {
        argv: [...shapeFiles(fixture, childDraftBody()), '--shape', 'epic'],
        match: /--shape must be one of orphan, carrier, roadmap, child/,
      },
    ];
    for (const { argv, match } of cases) {
      for (const extra of [[], ['--apply']]) {
        const result = fixture.run([...argv, ...extra]);
        assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stdout}`);
        assert.match(result.stderr, match);
        assert.deepEqual(fixture.log(), []);
      }
    }
  } finally {
    fixture.restore();
  }
});

test('CLI: an anchor in another repository exits 2 and writes nothing', () => {
  const fixture = setup();
  try {
    seedAnchor(fixture);
    const result = fixture.run(childArgs(fixture, `other/repo#${ANCHOR}`));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--anchor must name an issue in o\/r/);
    assert.deepEqual(writes(fixture.log()), []);
    assert.equal(
      fixture.log().some((entry) => entry.args.includes('graphql')),
      false,
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a roadmap dry run is not refused and lints the body as a roadmap', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run(roadmapArgs(fixture));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.outcome, 'planned');
    assert.equal(report.ids.anchor, report.ids.target);
    assert.equal(report.anchor, undefined);
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.deepEqual(lint.detail.args.slice(0, 3), [
      '--shape',
      'roadmap',
      '--new-issue',
    ]);
    assert.deepEqual(
      report.steps.map((s: { step: string }) => s.step),
      [
        'lint',
        'labels',
        'journal-pending',
        'create',
        'identity-attach',
        'owner-marker',
        'provenance',
        'member',
      ],
    );
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a roadmap apply is its own set anchor and makes the orphan writes in order', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const result = fixture.run([...roadmapArgs(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'published');
    assert.equal(report.journalState, 'member');
    assert.deepEqual(writeKinds(fixture), [
      'journal-pending',
      'create status:authoring',
      'identity-attach',
      'owner-marker',
      'member',
    ]);
    const created = fixture.state().issues[String(NEW_ISSUE)] as {
      body: string;
      labels: string[];
    };
    assert.match(
      created.body,
      /^<!-- idd-skill-authoring-publication: target=(target-[^;]+); anchor=\1; /,
    );
    assert.match(created.body, /## Tracks\n\n## Success criteria/);
    assert.deepEqual(created.labels, ['status:authoring']);
    const [marker] = childComments(fixture);
    assert.match(
      marker ?? '',
      new RegExp(
        `target=o/r#${NEW_ISSUE}; anchor=o/r#${NEW_ISSUE}; mode=acquire;`,
      ),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a child dry run checks the anchor, lints the body as a child and writes nothing', () => {
  const fixture = setup({ labels: [] });
  try {
    const anchorBody = seedAnchor(fixture);
    const result = fixture.run(childArgs(fixture));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.outcome, 'planned');
    assert.equal(report.ids.anchor, ANCHOR_REF);
    assert.equal(report.ids.set, ANCHOR_SET);
    assert.equal(report.ids.session, ANCHOR_SESSION);
    assert.notEqual(report.ids.owner, ANCHOR_OWNER);
    assert.equal(report.anchor.issue, ANCHOR_REF);
    assert.equal(report.anchor.owner, ANCHOR_OWNER);
    assert.deepEqual(
      report.steps.map((s: { step: string }) => s.step),
      [
        'anchor-check',
        'lint',
        'labels',
        'journal-pending',
        'create',
        'identity-attach',
        'anchor-heartbeat',
        'owner-marker',
        'provenance',
        'anchor-verify',
        'member',
      ],
    );
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.deepEqual(lint.detail.args.slice(0, 3), [
      '--shape',
      'child',
      '--new-issue',
    ]);
    const pending = report.steps.find(
      (s: { step: string }) => s.step === 'journal-pending',
    );
    assert.match(
      pending.detail.record,
      new RegExp(
        `anchor=${ANCHOR_REF}; set=${ANCHOR_SET}; session=${ANCHOR_SESSION};`,
      ),
    );
    assert.deepEqual(writes(fixture.log()), []);
    assert.equal(
      (fixture.state().issues[String(ANCHOR)] as { body: string }).body,
      anchorBody,
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a child apply heartbeats the anchor, joins its set and never edits the anchor', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const anchorBody = seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'published');
    assert.equal(report.journalState, 'member');
    assert.equal(report.issue, `o/r#${NEW_ISSUE}`);
    assert.equal(report.ids.anchor, ANCHOR_REF);
    assert.deepEqual(writeKinds(fixture), [
      'journal-pending',
      'create status:authoring',
      'identity-attach',
      'anchor:heartbeat',
      'owner-marker',
      'member',
    ]);
    assert.deepEqual(
      report.steps.map((s: { step: string }) => s.step),
      [
        'anchor-check',
        'lint',
        'labels',
        'journal-pending',
        'create',
        'identity-attach',
        'anchor-heartbeat',
        'owner-marker',
        'provenance',
        'anchor-verify',
        'member',
      ],
    );
    const provenance = report.steps.find(
      (s: { step: string }) => s.step === 'provenance',
    );
    assert.equal(provenance.detail.inProcess, true);

    // The anchor's body and labels are untouched, and no issue is edited.
    const state = fixture.state();
    const anchorIssue = state.issues[String(ANCHOR)] as {
      body: string;
      labels: string[];
    };
    assert.equal(anchorIssue.body, anchorBody);
    assert.deepEqual(anchorIssue.labels, ['status:authoring']);
    assert.equal(
      fixture
        .log()
        .some((entry) => entry.args[0] === 'issue' && entry.args[1] === 'edit'),
      false,
    );

    // The heartbeat is a same-owner marker on the anchor.
    const anchorLog = anchorComments(fixture);
    assert.equal(anchorLog.length, 2);
    assert.match(
      anchorLog[1] ?? '',
      new RegExp(
        `target=${ANCHOR_REF}; anchor=${ANCHOR_REF}; mode=heartbeat; owner=${ANCHOR_OWNER}; set=${ANCHOR_SET}; session=${ANCHOR_SESSION}; body-sha256=${sha256Of(anchorBody)}; snapshot-sha256=none; supersedes=${ANCHOR_OWNER}`,
      ),
    );

    // The child carries the anchor's real reference, set and session.
    const created = state.issues[String(NEW_ISSUE)] as { body: string };
    assert.match(
      created.body,
      new RegExp(
        `^<!-- idd-skill-authoring-publication: target=target-[^;]+; anchor=${ANCHOR_REF}; set=${ANCHOR_SET}; session=${ANCHOR_SESSION}; token=token-`,
      ),
    );
    const [childMarker, ...rest] = childComments(fixture);
    assert.deepEqual(rest, []);
    assert.match(
      childMarker ?? '',
      new RegExp(
        `target=o/r#${NEW_ISSUE}; anchor=${ANCHOR_REF}; mode=acquire; owner=owner-[^;]+; set=${ANCHOR_SET}; session=${ANCHOR_SESSION};`,
      ),
    );
    assert.doesNotMatch(childMarker ?? '', /owner=owner-anchor;/);
    // The first three journal records are the anchor's own, seeded by the test.
    const records = journalRecords(fixture).slice(3);
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.match(
        record,
        new RegExp(
          `anchor=${ANCHOR_REF}; set=${ANCHOR_SET}; session=${ANCHOR_SESSION}; `,
        ),
      );
    }
    assert.match(records[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a fresh matching anchor marker is reused instead of posting a heartbeat', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    seedAnchor(fixture, { createdAt: new Date().toISOString() });
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(writeKinds(fixture), [
      'journal-pending',
      'create status:authoring',
      'identity-attach',
      'owner-marker',
      'member',
    ]);
    const heartbeat = report.steps.find(
      (s: { step: string }) => s.step === 'anchor-heartbeat',
    );
    assert.equal(heartbeat.detail.reused, true);
    assert.equal(heartbeat.detail.commentId, 4100);
    assert.equal(anchorComments(fixture).length, 1);
  } finally {
    fixture.restore();
  }
});

test('CLI: a fresh anchor marker with another body digest is not reused', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    anchorClockNow: true,
  });
  try {
    // Fresh, but its body digest is not the anchor body's.
    seedAnchor(fixture, {
      createdAt: new Date().toISOString(),
      markers: [ownerMarkerText('acquire', { bodySha256: 'f'.repeat(64) })],
    });
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(writeKinds(fixture).includes('anchor:heartbeat'));
    assert.equal(anchorComments(fixture).length, 2);
  } finally {
    fixture.restore();
  }
});

const ANCHOR_REFUSALS: [string, Parameters<typeof seedAnchor>[1], RegExp][] = [
  ['a closed anchor', { state: 'closed' }, /is not open/],
  [
    'an unlabelled anchor',
    { labels: [] },
    /does not carry the authoring label/,
  ],
  [
    'an anchor with no owner marker',
    { markers: [] },
    /no open owner generation/,
  ],
  [
    'an anchor whose set was released',
    {
      markers: [
        ownerMarkerText('acquire'),
        ownerMarkerText('release'),
        ownerMarkerText('release-complete'),
      ],
    },
    /no open owner generation/,
  ],
  [
    'an anchor whose release is in progress',
    { markers: [ownerMarkerText('acquire'), ownerMarkerText('release')] },
    /being released/,
  ],
  [
    'an anchor whose acquire marker breaks the rules of its mode',
    {
      createdAt: new Date().toISOString(),
      markers: [ownerMarkerText('acquire', { supersedes: 'owner-other' })],
    },
    /is malformed/,
  ],
  [
    'an anchor that reopens a completed set',
    {
      markers: [
        ownerMarkerText('acquire'),
        ownerMarkerText('release'),
        ownerMarkerText('release-complete'),
        ownerMarkerText('acquire', { owner: 'owner-new' }),
      ],
    },
    /reuses set set-anchor/,
  ],
  [
    'an anchor whose journal holds no record of its token',
    { journalRecords: [] },
    /originating hold of the anchor o\/r#4000 is not verified in the journal/,
  ],
  [
    'an anchor whose journal record is still pending',
    { journalRecords: holdSequence().slice(0, 2) },
    /is pending, not member/,
  ],
  [
    'an anchor whose journal record later moved to cleanup',
    {
      journalRecords: [...holdSequence(), journalIntentText('cleanup')],
    },
    /is cleanup, not member/,
  ],
  [
    'an anchor whose journal history returns to member after cleanup',
    {
      journalRecords: [
        ...holdSequence(),
        journalIntentText('cleanup'),
        journalIntentText('member'),
      ],
    },
    /out of order/,
  ],
  [
    'an anchor whose journal record names another set',
    { journalRecords: holdSequence({ set: 'set-other' }) },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor whose journal records attach another issue',
    { journalRecords: holdSequence({ issue: 'o/r#4001' }) },
    /attaches the token to o\/r#4001/,
  ],
  [
    'an anchor whose journal record is not self-anchored',
    { journalRecords: holdSequence({ anchor: 'o/r#3999' }) },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor whose journal record has another session',
    {
      journalRecords: holdSequence().map((record, index) =>
        index === 2
          ? record.replace(`session=${ANCHOR_SESSION}`, 'session=session-other')
          : record,
      ),
    },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor whose journal record has another target',
    {
      journalRecords: holdSequence().map((record, index) =>
        index === 2
          ? record.replace('target=target-anchor', 'target=target-other')
          : record,
      ),
    },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor whose journal records carry another token',
    { journalRecords: holdSequence({ token: 'token-other' }) },
    /no publication-intent record of the anchor's token/,
  ],
  [
    'an anchor whose body has no publication line',
    { body: roadmapDraftBody() },
    /carries no authoring-publication line/,
  ],
  [
    'an anchor whose publication line names another set',
    {
      body: anchorBodyText().replace(`set=${ANCHOR_SET}`, 'set=set-elsewhere'),
    },
    /names set set-elsewhere/,
  ],
  [
    'an anchor whose publication line names another anchor',
    {
      body: anchorBodyText().replace('anchor=target-anchor', 'anchor=o/r#3999'),
    },
    /names another anchor/,
  ],
  [
    'an anchor whose journal record names an actor other than its author',
    { journalRecords: holdSequence({ actor: 'someone-else' }) },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor whose journal record names another journal',
    { journalRecords: holdSequence({ journal: 'o/r#9999' }) },
    /conflicts with the anchor's publication line/,
  ],
  [
    'an anchor with an active claim',
    {
      extraComments: [
        '<!-- claimed-by: claude-other 0f2c9a4e-1b7d-4c3a-9e8f-2d6b5a4c3e21 supersedes: none 2026-10-13T00:00:00Z branch: issue/4000-x -->',
      ],
    },
    /has an active claim/,
  ],
];

for (const [name, seed, match] of ANCHOR_REFUSALS) {
  test(`CLI: ${name} refuses a child before any write`, () => {
    const fixture = setup({ labels: ['status:authoring'] });
    try {
      seedAnchor(fixture, seed);
      for (const extra of [[], ['--apply']]) {
        const result = fixture.run([...childArgs(fixture), ...extra]);
        assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.outcome, 'refused');
        assert.match(report.reason, match);
        assert.deepEqual(writes(fixture.log()), []);
        assert.deepEqual(childComments(fixture), []);
        assert.equal(fixture.state().issues[String(NEW_ISSUE)], undefined);
      }
    } finally {
      fixture.restore();
    }
  });
}

test('CLI: an anchor that cannot be read refuses a child before any write', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    // Nothing is seeded, so the stub answers the anchor read with a 404.
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).reason, /cannot be read/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a failed anchor heartbeat is a recovery hold on the held, journalled child', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    anchorPostFail: { mode: 'heartbeat', status: 422, landed: false },
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'anchor-heartbeat');
    assert.equal(report.nothingSent, true);
    assert.equal(report.issue, `o/r#${NEW_ISSUE}`);
    assert.deepEqual(
      (fixture.state().issues[String(NEW_ISSUE)] as { labels: string[] })
        .labels,
      ['status:authoring'],
    );
    // The record is attached but not a member, and no owner marker was posted.
    // The first three journal records are the anchor's own, seeded by the test.
    const records = journalRecords(fixture).slice(3);
    assert.equal(records.length, 2);
    assert.match(
      records[1] ?? '',
      new RegExp(`issue=o/r#${NEW_ISSUE}; .*state=pending`),
    );
    assert.deepEqual(childComments(fixture), []);
    assert.equal(anchorComments(fixture).length, 1);
  } finally {
    fixture.restore();
  }
});

test('CLI: an anchor heartbeat that may have landed is reported as uncertain', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    anchorPostFail: { mode: 'heartbeat', status: 502, landed: true },
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'anchor-heartbeat');
    assert.equal(report.nothingSent, false);
    assert.equal(report.anchorHeartbeat, 'uncertain');
    assert.deepEqual(childComments(fixture), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an anchor taken over right after the heartbeat stops before the child acquires', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    afterPost: [{ mode: 'heartbeat', action: 'anchorTakeover' }],
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'anchor-heartbeat');
    assert.match(report.reason, /changed during the heartbeat/);
    assert.deepEqual(childComments(fixture), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an anchor taken over after the child acquires stops before member', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    afterPost: [{ mode: 'acquire', action: 'anchorTakeover' }],
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'anchor-verify');
    assert.match(report.reason, /owner generation of the anchor/);
    assert.equal(writeKinds(fixture).includes('member'), false);
    assert.equal(childComments(fixture).length, 1);
    const records = journalRecords(fixture);
    assert.doesNotMatch(records.at(-1) ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a child that gains an active claim during acquisition stops before member', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    claimOnCreate: true,
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).failedStep, 'member');
  } finally {
    fixture.restore();
  }
});

test('CLI: a competing owner marker on the child stops before member', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    afterPost: [{ mode: 'acquire', action: 'competing' }],
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /owner-marker replay failed/);
    assert.equal(writeKinds(fixture).includes('member'), false);
  } finally {
    fixture.restore();
  }
});

test('CLI: a child can take a needs-decision bucket like an orphan', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    seedAnchor(fixture);
    const body = [
      '<!-- idd-skill-authoring-bucket: needs-decision -->',
      '',
      childDraftBody(),
    ].join('\n');
    const result = fixture.run([
      ...shapeFiles(fixture, body),
      '--shape',
      'child',
      '--anchor',
      ANCHOR_REF,
      '--bucket',
      'needs-decision',
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run', result.stdout);
    assert.deepEqual(report.labels, [
      'status:authoring',
      'status:needs-decision',
    ]);
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.deepEqual(lint.detail.args.slice(-6), [
      '--expect-bucket',
      'needs-decision',
      '--label',
      'status:authoring',
      '--label',
      'status:needs-decision',
    ]);
  } finally {
    fixture.restore();
  }
});

test('CLI: an anchor with an open linked pull request refuses a child before any write', () => {
  const fixture = setup({ labels: ['status:authoring'], openPr: true });
  try {
    seedAnchor(fixture);
    for (const extra of [[], ['--apply']]) {
      const result = fixture.run([...childArgs(fixture), ...extra]);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, 'refused');
      assert.match(report.reason, /open linked pull request/);
      assert.deepEqual(writes(fixture.log()), []);
    }
  } finally {
    fixture.restore();
  }
});

test('CLI: a hold record written by an untrusted author does not verify the anchor', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    seedAnchor(fixture, { journalRecords: [] });
    fixture.seed((stored) => {
      stored.comments.push({
        id: 4090,
        issue: 2674,
        body: journalIntentText('member'),
        user: 'someone-else',
        createdAt: '2026-10-12T00:00:00Z',
      });
    });
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(JSON.parse(result.stdout).reason, /originating hold/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a marker of the child that names another anchor stops before member', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    afterPost: [{ mode: 'acquire', action: 'otherAnchor' }],
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /owner-marker replay failed/);
    assert.equal(writeKinds(fixture).includes('member'), false);
  } finally {
    fixture.restore();
  }
});

test('CLI: a marker hosted on the child that names another target stops before member', () => {
  const fixture = setup({
    labels: ['status:authoring'],
    afterPost: [{ mode: 'acquire', action: 'otherTarget' }],
  });
  try {
    seedAnchor(fixture);
    const result = fixture.run([...childArgs(fixture), '--apply']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /owner-marker replay failed/);
    assert.equal(writeKinds(fixture).includes('member'), false);
  } finally {
    fixture.restore();
  }
});
