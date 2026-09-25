import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectIndexLagIssueNumbers,
  collectSearchedIssueNumbers,
  evaluateAuthoringSetMembers,
  type IssueSearchPage,
  type SetMemberComment,
} from '../src/scripts/authoring-set-members.mts';
import { renderAuthoringOwnerMarker } from '../src/scripts/marker-helpers.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SET = 'a5c89829-902b-4a81-b626-193d425ea812';
const PREFIX = 'idd-skill';
const DIGEST = 'ab'.repeat(32);

function marker(issue: number, set = SET): string {
  const target = `kurone-kito/idd-skill#${issue}`;
  return renderAuthoringOwnerMarker({
    markerPrefix: PREFIX,
    target,
    anchor: target,
    mode: 'acquire',
    owner: '9e59701c-d1da-4b07-ba66-1ca3f025cfe5',
    set,
    session: '3dad4bd4-7bde-40ed-b6da-0b0cf94cdfa9',
    bodySha256: DIGEST,
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function comment(
  issueNumber: number,
  body: string,
  authorLogin = 'kurone-kito',
  lastEditedAt: string | null = null,
): SetMemberComment {
  return { authorLogin, body, lastEditedAt, issueNumber };
}

function page(
  totalCount: number,
  items: IssueSearchPage['items'],
  incompleteResults = false,
): IssueSearchPage {
  return { totalCount, incompleteResults, items };
}

test('two trusted markers for the same set on two issues are not a sole member', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [comment(3468, marker(3468)), comment(3469, marker(3469))],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, [3468, 3469]);
});

test('one trusted marker for the set is a sole member', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [comment(3468, marker(3468))],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

test('several markers on one issue stay a single sole member', () => {
  const heartbeat = marker(3468).replace('mode=acquire', 'mode=heartbeat');
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [comment(3468, marker(3468)), comment(3468, heartbeat)],
  });
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

test('an untrusted marker and a different set do not count', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3470, marker(3470), 'someone-else'),
      comment(3471, marker(3471, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb')),
    ],
  });
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

test('an edited trusted marker for the set fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3469, marker(3469), 'kurone-kito', '2026-09-25T18:00:00Z'),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('an edited trusted marker that no longer parses fails closed', () => {
  const rewritten = marker(3469).replace('<!--', '');
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3469, rewritten, 'kurone-kito', '2026-09-25T18:00:00Z'),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reason, 'edited trusted authoring-owner marker');
});

test('an edited trusted marker for a different set fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(
        3469,
        marker(3469, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'),
        'kurone-kito',
        '2026-09-25T18:00:00Z',
      ),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('an unfinished enumeration is not a sole member', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: false,
    comments: [comment(3468, marker(3468))],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('incomplete_results does not finish the search listing', () => {
  const result = collectSearchedIssueNumbers([
    page(2, [{ number: 3468, pullRequest: false }], true),
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'incomplete_results');
  assert.deepEqual(result.numbers, []);
});

test('a short collection is unfinished even when incomplete_results is false', () => {
  const result = collectSearchedIssueNumbers([
    page(2, [{ number: 3468, pullRequest: false }]),
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'collected count does not match total_count');
});

test('duplicate search hits are unfinished even when the raw count matches', () => {
  const result = collectSearchedIssueNumbers([
    page(2, [
      { number: 3468, pullRequest: false },
      { number: 3468, pullRequest: false },
    ]),
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'unique count does not match total_count');
  assert.deepEqual(result.numbers, []);
});

test('a finished search drops pull requests and lists issue numbers', () => {
  const result = collectSearchedIssueNumbers([
    page(2, [
      { number: 12, pullRequest: true },
      { number: 3468, pullRequest: false },
    ]),
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.numbers, [3468]);
});

test('a full index-lag page is unfinished and drops every number', () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    number: index + 1,
    pullRequest: false,
  }));
  const result = collectIndexLagIssueNumbers(items, true);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'index-lag window exceeded');
  assert.deepEqual(result.numbers, []);
});

test('an index-lag page drops pull requests', () => {
  const result = collectIndexLagIssueNumbers(
    [
      { number: 12, pullRequest: true },
      { number: 3469, pullRequest: false },
    ],
    false,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.numbers, [3469]);
});

test('CLI: --set exits non-zero when search reports incomplete_results', () => {
  const restore = stubExecutable(
    'gh',
    `process.stdout.write(JSON.stringify({
      total_count: 2,
      incomplete_results: true,
      items: [{ number: 3468 }]
    }));`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/authoring-set-members.mjs'),
        '--set',
        SET,
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
        '--trusted-marker-logins',
        'kurone-kito',
      ],
      { encoding: 'utf8' },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    assert.equal(failure.status, 1);
    const output = JSON.parse(failure.stdout ?? '');
    assert.equal(output.complete, false);
    assert.equal(output.soleMember, false);
    assert.equal(output.reason, 'incomplete_results');
    assert.deepEqual(output.issues, []);
  } finally {
    restore();
  }
});

test('CLI: one verified marker prints that issue and soleMember true', () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues') && !joined.includes('authoring-owner')) {
      process.stderr.write('search query is not the owner-marker token\\n');
      process.exit(2);
    }
    if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ number: 3468 }]
      }));
      process.exit(0);
    }
    if (joined.includes('state=all')) {
      process.stdout.write('[]');
      process.exit(0);
    }
    if (args.includes('graphql')) {
      process.stdout.write(JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [{
                  databaseId: 1,
                  lastEditedAt: null,
                  createdAt: '2026-09-25T18:00:00Z',
                  updatedAt: '2026-09-25T18:00:00Z',
                  body: ${JSON.stringify(marker(3468))},
                  author: { login: 'kurone-kito' }
                }],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      }));
      process.exit(0);
    }
    process.stderr.write('unexpected gh ' + joined);
    process.exit(2);
  `;
  const restore = stubExecutable('gh', script);
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-set-members.mjs'),
          '--set',
          SET,
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--trusted-marker-logins',
          'kurone-kito',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.complete, true);
    assert.equal(output.soleMember, true);
    assert.deepEqual(output.issues, [3468]);
  } finally {
    restore();
  }
});

test('CLI: a sibling only in the index-lag window is not a sole member', () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues') && !joined.includes('authoring-owner')) {
      process.stderr.write('search query is not the owner-marker token\\n');
      process.exit(2);
    }
    if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ number: 3468 }]
      }));
      process.exit(0);
    }
    if (joined.includes('state=all')) {
      process.stdout.write(JSON.stringify([{ number: 3469 }]));
      process.exit(0);
    }
    if (args.includes('graphql')) {
      const body = joined.includes('number=3469')
        ? ${JSON.stringify(marker(3469))}
        : ${JSON.stringify(marker(3468))};
      process.stdout.write(JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [{
                  databaseId: 1,
                  lastEditedAt: null,
                  createdAt: '2026-09-25T18:00:00Z',
                  updatedAt: '2026-09-25T18:00:00Z',
                  body,
                  author: { login: 'kurone-kito' }
                }],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      }));
      process.exit(0);
    }
    process.stderr.write('unexpected gh ' + joined);
    process.exit(2);
  `;
  const restore = stubExecutable('gh', script);
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-set-members.mjs'),
          '--set',
          SET,
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--trusted-marker-logins',
          'kurone-kito',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.complete, true);
    assert.equal(output.soleMember, false);
    assert.deepEqual(output.issues, [3468, 3469]);
  } finally {
    restore();
  }
});
