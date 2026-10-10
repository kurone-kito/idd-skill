import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AuthoringOwnerProvenanceComment } from '../src/scripts/authoring-owner-provenance.mts';
import {
  buildOwnerMarkerSearchQuery,
  collectIndexLagIssueNumbers,
  collectSearchedIssueNumbers,
  evaluateAuthoringSetMembers,
  type IssueSearchPage,
  SEARCH_RESULT_CAP,
  type SetMemberComment,
  selectSetBoundMarker,
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
  id = 1,
  extra?: Partial<Pick<SetMemberComment, 'isMinimized' | 'minimizedReason'>>,
): SetMemberComment {
  return { authorLogin, body, lastEditedAt, issueNumber, id, ...extra };
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3469, rewritten, 'kurone-kito', '2026-09-25T18:00:00Z', 8675),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.reason,
    'edited trusted authoring-owner marker (kurone-kito/idd-skill#3469, comment id 8675); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan',
  );
});

test('an edited trusted marker for a different set fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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

test('an unedited unparseable trusted marker fails closed', () => {
  const rewritten = marker(3469).replace('<!--', '');
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3469, rewritten, 'kurone-kito', null, 9142),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.reason,
    'unparseable trusted authoring-owner marker (kurone-kito/idd-skill#3469, comment id 9142); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan',
  );
});

test('a trusted marker whose target is a different issue fails closed', () => {
  const misplaced = marker(3469);
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468)),
      comment(3468, misplaced, 'kurone-kito', null, 7301),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.reason,
    'authoring-owner marker target does not match its host issue (kurone-kito/idd-skill#3468, comment id 7301); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan',
  );
});

test('a target match is case-insensitive on owner and repo', () => {
  const folded = marker(3468).replaceAll(
    'kurone-kito/idd-skill#3468',
    'Kurone-Kito/IDD-Skill#3468',
  );
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [comment(3468, folded)],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

test('an unfinished enumeration is not a sole member', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
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

test('CLI: a repeated comments cursor exits non-zero', {
  timeout: 5000,
}, () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
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
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: 'CURSOR' }
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
    const failure = error as { status?: number; stderr?: string };
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr ?? '', /repeated comments cursor/);
  } finally {
    restore();
  }
});

// ── isMinimized + outdated tests (issue #3553) ──────────────────────────────

function minimizedMarker(issue: number): string {
  // Mirrors the observed incident: empty body-sha256, minimized as "outdated".
  // Comment 5577810398 on closed issue #2689. We craft the raw body directly
  // because renderAuthoringOwnerMarker validates bodySha256 format.
  const target = `kurone-kito/idd-skill#${issue}`;
  return (
    `<!-- ${PREFIX}-authoring-owner: target=${target}; anchor=${target}; ` +
    `mode=acquire; owner=9e59701c-d1da-4b07-ba66-1ca3f025cfe5; set=${SET}; ` +
    `session=3dad4bd4-7bde-40ed-b6da-0b0cf94cdfa9; body-sha256=; ` +
    `snapshot-sha256=none; supersedes=none -->`
  );
}

test('an outdated-minimized trusted marker is skipped rather than failing closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      // The minimized marker (empty body-sha256, isMinimized=true/outdated)
      comment(2689, minimizedMarker(2689), 'kurone-kito', null, 5577810398, {
        isMinimized: true,
        minimizedReason: 'outdated',
      }),
      // A fresh, valid marker on a different issue
      comment(3468, marker(3468)),
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

test('minimizedReason match is case-insensitive (Outdated, OUTDATED)', () => {
  for (const reason of ['Outdated', 'OUTDATED']) {
    const result = evaluateAuthoringSetMembers({
      set: SET,
      markerPrefix: PREFIX,
      repository: { owner: 'kurone-kito', repo: 'idd-skill' },
      trustedMarkerLogins: ['kurone-kito'],
      enumerationComplete: true,
      comments: [
        comment(2689, minimizedMarker(2689), 'kurone-kito', null, 1, {
          isMinimized: true,
          minimizedReason: reason,
        }),
        comment(3468, marker(3468)),
      ],
    });
    assert.equal(result.complete, true, `failed for reason="${reason}"`);
    assert.equal(result.soleMember, true, `failed for reason="${reason}"`);
  }
});

test('a minimized marker with a non-outdated reason still fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(2689, minimizedMarker(2689), 'kurone-kito', null, 9999, {
        isMinimized: true,
        minimizedReason: 'resolved',
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('a minimized marker with minimizedReason null still fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(2689, minimizedMarker(2689), 'kurone-kito', null, 9999, {
        isMinimized: true,
        minimizedReason: null,
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('a minimized marker with empty minimizedReason string still fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(2689, minimizedMarker(2689), 'kurone-kito', null, 9999, {
        isMinimized: true,
        minimizedReason: '',
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('a minimized marker with omitted minimizedReason still fails closed', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(2689, minimizedMarker(2689), 'kurone-kito', null, 9999, {
        isMinimized: true,
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('a non-minimized marker with empty body-sha256 fails closed as unparseable', () => {
  // Without isMinimized=true, the fail-closed path must still fire
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [comment(2689, minimizedMarker(2689), 'kurone-kito', null, 9999)],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
});

test('a parseable marker minimized as outdated is not a set member, and fails the scan when it is the only marker on its issue', () => {
  // A well-formed, correctly-targeted marker is never counted when it is
  // minimized as outdated (#3553). When it is the set's only marker on its
  // issue, the scan is incomplete instead of reporting a smaller set (#3880).
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468), 'kurone-kito', null, 1, {
        isMinimized: true,
        minimizedReason: 'outdated',
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.reason,
    "hidden authoring-owner marker is the set's only marker on its issue (kurone-kito/idd-skill#3468, comment id 1); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan",
  );
  assert.deepEqual(result.skippedMarkers, [
    { issueNumber: 3468, commentId: 1, kind: 'requested-set', mode: 'acquire' },
  ]);
  assert.equal(result.skippedElsewhere, 0);
});

test('a parseable minimized-resolved marker counts as a set member (resolved is not outdated)', () => {
  // minimizedReason=resolved does NOT trigger the skip -- the comment
  // is still evaluated as a set member if it parses correctly.
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments: [
      comment(3468, marker(3468), 'kurone-kito', null, 1, {
        isMinimized: true,
        minimizedReason: 'resolved',
      }),
    ],
  });
  // resolved minimization does not skip -- the marker counts normally
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, true);
  assert.deepEqual(result.issues, [3468]);
});

// ── hidden requested-set markers and the skip report (issue #3880) ─────────

const OTHER_SET = '0b7f0e5a-1c2d-4e3f-9a8b-7c6d5e4f3a2b';
const REPOSITORY = { owner: 'kurone-kito', repo: 'idd-skill' };
const HIDDEN = { isMinimized: true, minimizedReason: 'outdated' };

function markerWithMode(
  issue: number,
  mode: 'acquire' | 'heartbeat',
  set = SET,
): string {
  const target = `kurone-kito/idd-skill#${issue}`;
  return renderAuthoringOwnerMarker({
    markerPrefix: PREFIX,
    target,
    anchor: target,
    mode,
    owner: '9e59701c-d1da-4b07-ba66-1ca3f025cfe5',
    set,
    session: '3dad4bd4-7bde-40ed-b6da-0b0cf94cdfa9',
    bodySha256: DIGEST,
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function evaluate(comments: SetMemberComment[]) {
  return evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: REPOSITORY,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
    comments,
  });
}

test('#3880: a lone hidden marker on a sibling fails the scan and names the sibling', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 1),
    comment(20, marker(20), 'kurone-kito', null, 2, HIDDEN),
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.reason,
    "hidden authoring-owner marker is the set's only marker on its issue (kurone-kito/idd-skill#20, comment id 2); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan",
  );
});

test('#3880: a hidden marker with a later visible marker of the set keeps the members', () => {
  const result = evaluate([
    comment(20, marker(20), 'kurone-kito', null, 1, HIDDEN),
    comment(20, marker(20), 'kurone-kito', null, 2),
    comment(10, marker(10), 'kurone-kito', null, 3),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, false);
  assert.deepEqual(result.issues, [10, 20]);
  assert.deepEqual(result.skippedMarkers, [
    { issueNumber: 20, commentId: 1, kind: 'requested-set', mode: 'acquire' },
  ]);
});

test('#3880: the lost-race shape (hidden acquire and heartbeat, then a visible marker of another set) fails naming the last hidden comment', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 9),
    comment(20, markerWithMode(20, 'acquire'), 'kurone-kito', null, 1, HIDDEN),
    comment(
      20,
      markerWithMode(20, 'heartbeat'),
      'kurone-kito',
      null,
      2,
      HIDDEN,
    ),
    comment(20, marker(20, OTHER_SET), 'kurone-kito', null, 3),
  ]);
  assert.equal(result.complete, false);
  assert.equal(
    result.reason,
    "hidden authoring-owner marker is the set's only marker on its issue (kurone-kito/idd-skill#20, comment id 2); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan",
  );
  assert.deepEqual(result.skippedMarkers, [
    { issueNumber: 20, commentId: 1, kind: 'requested-set', mode: 'acquire' },
    { issueNumber: 20, commentId: 2, kind: 'requested-set', mode: 'heartbeat' },
  ]);
});

test('#3880: an unparseable hidden marker (the #3553 shape) does not fail and names the set', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 1),
    comment(
      2689,
      minimizedMarker(2689),
      'kurone-kito',
      null,
      5577810398,
      HIDDEN,
    ),
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, [10]);
  assert.deepEqual(result.skippedMarkers, [
    {
      issueNumber: 2689,
      commentId: 5577810398,
      kind: 'unattributable',
      namesRequestedSet: true,
    },
  ]);
  assert.equal(result.skippedElsewhere, 0);
});

test('#3880: an edited hidden marker is unattributable; namesRequestedSet reads its current text', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 1),
    comment(20, marker(20), 'kurone-kito', '2026-10-01T00:00:00Z', 4, HIDDEN),
    comment(
      30,
      marker(30, OTHER_SET),
      'kurone-kito',
      '2026-10-01T00:00:00Z',
      5,
      HIDDEN,
    ),
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.skippedMarkers, [
    {
      issueNumber: 20,
      commentId: 4,
      kind: 'unattributable',
      namesRequestedSet: true,
    },
    {
      issueNumber: 30,
      commentId: 5,
      kind: 'unattributable',
      namesRequestedSet: false,
    },
  ]);
});

test('#3880: a hidden marker targeting another issue is unattributable; the flag is its parsed set', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 1),
    comment(20, marker(30), 'kurone-kito', null, 5, HIDDEN),
    comment(20, marker(30, OTHER_SET), 'kurone-kito', null, 6, HIDDEN),
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.skippedMarkers, [
    {
      issueNumber: 20,
      commentId: 5,
      kind: 'unattributable',
      namesRequestedSet: true,
    },
    {
      issueNumber: 20,
      commentId: 6,
      kind: 'unattributable',
      namesRequestedSet: false,
    },
  ]);
});

test('#3880: a hidden marker of another set is counted, not listed', () => {
  const result = evaluate([
    comment(10, marker(10), 'kurone-kito', null, 1),
    comment(20, marker(20, OTHER_SET), 'kurone-kito', null, 7, HIDDEN),
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, [10]);
  assert.deepEqual(result.skippedMarkers, []);
  assert.equal(result.skippedElsewhere, 1);
});

test('#3880: a run with no skipped marker reports an empty list and zero', () => {
  const result = evaluate([comment(10, marker(10), 'kurone-kito', null, 1)]);
  assert.deepEqual(result.skippedMarkers, []);
  assert.equal(result.skippedElsewhere, 0);
});

test('#3880: a fail-closed result for another reason still carries the skipped markers', () => {
  const result = evaluate([
    comment(10, minimizedMarker(10), 'kurone-kito', null, 2),
    comment(20, marker(20), 'kurone-kito', null, 1, HIDDEN),
  ]);
  assert.equal(result.complete, false);
  assert.match(result.reason, /^unparseable trusted authoring-owner marker/);
  assert.deepEqual(result.skippedMarkers, [
    { issueNumber: 20, commentId: 1, kind: 'requested-set', mode: 'acquire' },
  ]);
});

test('#3880: the verdict and the sorted skipped list do not depend on the order of issues', () => {
  const block20 = [
    comment(20, marker(20), 'kurone-kito', null, 2, HIDDEN),
    comment(20, marker(20), 'kurone-kito', null, 3, HIDDEN),
  ];
  const block30 = [comment(30, marker(30), 'kurone-kito', null, 4, HIDDEN)];
  const block10 = [comment(10, marker(10), 'kurone-kito', null, 1)];
  const forward = evaluate([...block10, ...block20, ...block30]);
  const reversed = evaluate([...block30, ...block20, ...block10]);
  assert.deepEqual(reversed, forward);
  assert.equal(forward.complete, false);
  assert.equal(
    forward.reason,
    "hidden authoring-owner marker is the set's only marker on its issue (kurone-kito/idd-skill#20, comment id 3); see docs/idd-comment-minimization.md#clearing-a-comment-that-blocks-the-scan",
  );
});

test('#3880: enumeration that did not finish reports an empty skip list', () => {
  const result = evaluateAuthoringSetMembers({
    set: SET,
    markerPrefix: PREFIX,
    repository: REPOSITORY,
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: false,
    comments: [comment(20, marker(20), 'kurone-kito', null, 1, HIDDEN)],
  });
  assert.equal(result.reason, 'enumeration incomplete');
  assert.deepEqual(result.skippedMarkers, []);
  assert.equal(result.skippedElsewhere, 0);
});

function skipCliScript(comments: Record<number, string>, items: number[]) {
  return `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: ${items.length},
        incomplete_results: false,
        items: ${JSON.stringify(items.map((number) => ({ number })))}
      }));
      process.exit(0);
    }
    if (joined.includes('state=all')) {
      process.stdout.write('[]');
      process.exit(0);
    }
    if (args.includes('graphql')) {
      const table = ${JSON.stringify(comments)};
      const issue = Number((joined.match(/number=(\\d+)/) || [])[1]);
      const nodes = (table[issue] ? JSON.parse(table[issue]) : []);
      process.stdout.write(JSON.stringify({
        data: { repository: { issue: { comments: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }));
      process.exit(0);
    }
    process.stderr.write('unexpected gh ' + joined);
    process.exit(2);
  `;
}

function cliNode(body: string, id: number, hidden: boolean): string {
  return JSON.stringify([
    {
      databaseId: id,
      lastEditedAt: null,
      createdAt: '2026-09-25T18:00:00Z',
      updatedAt: '2026-09-25T18:00:00Z',
      body,
      author: { login: 'kurone-kito' },
      isMinimized: hidden,
      minimizedReason: hidden ? 'outdated' : null,
    },
  ]);
}

function runSetMembers(args: string[]) {
  return execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/authoring-set-members.mjs'), ...args],
    { encoding: 'utf8' },
  );
}

test('#3880 CLI: a hidden requested-set marker fails the run and prints both fields', () => {
  const restore = stubExecutable(
    'gh',
    skipCliScript(
      {
        3468: cliNode(marker(3468), 1, false),
        3469: cliNode(marker(3469), 9, true),
      },
      [3468, 3469],
    ),
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
    assert.match(output.reason, /#3469, comment id 9\)/);
    assert.deepEqual(output.skippedMarkers, [
      {
        issueNumber: 3469,
        commentId: 9,
        kind: 'requested-set',
        mode: 'acquire',
      },
    ]);
    assert.equal(output.skippedElsewhere, 0);
  } finally {
    restore();
  }
});

test('#3880 CLI: a hidden marker of another set is counted and the run passes', () => {
  const restore = stubExecutable(
    'gh',
    skipCliScript(
      {
        3468: cliNode(marker(3468), 1, false),
        3469: cliNode(marker(3469, OTHER_SET), 9, true),
      },
      [3468, 3469],
    ),
  );
  try {
    const output = JSON.parse(
      runSetMembers([
        '--set',
        SET,
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
        '--trusted-marker-logins',
        'kurone-kito',
      ]),
    );
    assert.equal(output.complete, true);
    assert.deepEqual(output.issues, [3468]);
    assert.deepEqual(output.skippedMarkers, []);
    assert.equal(output.skippedElsewhere, 1);
  } finally {
    restore();
  }
});

test('#3880 CLI: --help lists the skip fields in its output schema', () => {
  const help = runSetMembers(['--help']);
  assert.match(help, /"skippedMarkers"/);
  assert.match(help, /"skippedElsewhere"/);
});

test('#3881: the heading that the fail-closed reasons point to exists in the docs', () => {
  const docs = readFileSync(
    join(REPO_ROOT, 'docs/idd-comment-minimization.md'),
    'utf8',
  );
  assert.match(docs, /^### Clearing a comment that blocks the scan$/m);
});

// #3901: the search and index-lag pages are read through the unbounded gh
// reader, so a page over the 1 MiB ghApiJson buffer still yields a verdict.
test('CLI: a search page larger than 1 MiB still yields the verdict (#3901)', () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues') && !joined.includes('authoring-owner')) {
      process.stderr.write('search query is not the owner-marker token\\n');
      process.exit(2);
    } else if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ number: 3468, body: 'x'.repeat(1100000) }]
      }), () => process.exit(0));
    } else if (joined.includes('state=all')) {
      process.stdout.write('[]');
      process.exit(0);
    } else if (args.includes('graphql')) {
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
    } else {
      process.stderr.write('unexpected gh ' + joined);
      process.exit(2);
    }
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

test('CLI: an index-lag page larger than 1 MiB still yields the verdict (#3901)', () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues') && !joined.includes('authoring-owner')) {
      process.stderr.write('search query is not the owner-marker token\\n');
      process.exit(2);
    } else if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ number: 3468 }]
      }));
      process.exit(0);
    } else if (joined.includes('state=all')) {
      process.stdout.write(JSON.stringify([{ number: 3470, body: 'y'.repeat(1100000) }]), () => process.exit(0));
    } else if (args.includes('graphql')) {
      const nodes = joined.includes('number=3470')
        ? []
        : [{
            databaseId: 1,
            lastEditedAt: null,
            createdAt: '2026-09-25T18:00:00Z',
            updatedAt: '2026-09-25T18:00:00Z',
            body: ${JSON.stringify(marker(3468))},
            author: { login: 'kurone-kito' }
          }];
      process.stdout.write(JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      }));
      process.exit(0);
    } else {
      process.stderr.write('unexpected gh ' + joined);
      process.exit(2);
    }
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

test('CLI: a failed search exits non-zero even after it wrote a valid page (#3901)', () => {
  const script = `
    const args = process.argv.slice(2);
    const joined = args.join(' ');
    if (joined.includes('search/issues') && !joined.includes('authoring-owner')) {
      process.stderr.write('search query is not the owner-marker token\\n');
      process.exit(2);
    } else if (joined.includes('search/issues')) {
      process.stdout.write(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ number: 3468 }]
      }), () => process.exit(1));
    } else if (joined.includes('state=all')) {
      process.stdout.write('[]');
      process.exit(0);
    } else if (args.includes('graphql')) {
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
    } else {
      process.stderr.write('unexpected gh ' + joined);
      process.exit(2);
    }
  `;
  const restore = stubExecutable('gh', script);
  try {
    const failure = spawnSync(
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
    assert.equal(failure.status, 1);
    assert.doesNotMatch(failure.stdout, /"complete": true/);
  } finally {
    restore();
  }
});

const TARGET = 3916;
const SELF = `kurone-kito/idd-skill#${TARGET}`;
const BOUND_SELECT = {
  set: SET,
  markerPrefix: PREFIX,
  repository: { owner: 'kurone-kito', repo: 'idd-skill' },
  target: TARGET,
  trustedMarkerLogins: ['kurone-kito'],
};

function ownerMarker(anchor: string, set = SET): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: PREFIX,
    target: SELF,
    anchor,
    mode: 'acquire',
    owner: '9e59701c-d1da-4b07-ba66-1ca3f025cfe5',
    set,
    session: '3dad4bd4-7bde-40ed-b6da-0b0cf94cdfa9',
    bodySha256: DIGEST,
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function provenance(
  body: string,
  createdAt: string,
  id: number,
  extra: Partial<
    Pick<
      AuthoringOwnerProvenanceComment,
      'lastEditedAt' | 'isMinimized' | 'minimizedReason'
    >
  > = {},
): AuthoringOwnerProvenanceComment {
  return {
    id,
    authorLogin: 'kurone-kito',
    body,
    createdAt,
    updatedAt: createdAt,
    lastEditedAt: null,
    ...extra,
  };
}

test('the bound is the earliest trusted marker naming the set, even when hidden (#3916)', () => {
  const result = selectSetBoundMarker({
    ...BOUND_SELECT,
    comments: [
      provenance(ownerMarker(SELF), '2026-10-09T12:00:00Z', 12),
      provenance(ownerMarker(SELF), '2026-10-09T10:00:00Z', 10, {
        isMinimized: true,
        minimizedReason: 'outdated',
      }),
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, true);
  assert.equal(result.bound?.commentId, 10);
  assert.equal(result.bound?.createdAt, '2026-10-09T10:00:00Z');
});

test('an edited bound marker makes the bounded run incomplete (#3916)', () => {
  const result = selectSetBoundMarker({
    ...BOUND_SELECT,
    comments: [
      provenance(ownerMarker(SELF), '2026-10-09T10:00:00Z', 10, {
        lastEditedAt: '2026-10-09T11:00:00Z',
      }),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.soleMember, false);
  assert.equal(result.bound, null);
  assert.match(result.reason, /edited bound authoring-owner marker/);
});

test('a target with no trusted marker for the set makes the bounded run incomplete (#3916)', () => {
  const result = selectSetBoundMarker({
    ...BOUND_SELECT,
    comments: [
      provenance(ownerMarker(SELF, 'another-set'), '2026-10-09T10:00:00Z', 10),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.bound, null);
  assert.match(result.reason, /no trusted authoring-owner marker for set/);
});

test('a bound marker that names another anchor is complete but not a sole member (#3916)', () => {
  const result = selectSetBoundMarker({
    ...BOUND_SELECT,
    comments: [
      provenance(
        ownerMarker('kurone-kito/idd-skill#3744'),
        '2026-10-09T10:00:00Z',
        10,
      ),
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.soleMember, false);
  assert.equal(result.bound?.anchor, 'kurone-kito/idd-skill#3744');
  assert.match(result.reason, /names another anchor/);
});

test('the bounded query adds updated:>= at the bound and the unbounded query is unchanged (#3916)', () => {
  const unbounded = buildOwnerMarkerSearchQuery({
    owner: 'kurone-kito',
    repo: 'idd-skill',
    markerPrefix: PREFIX,
  });
  assert.equal(
    unbounded,
    'repo:kurone-kito/idd-skill is:issue "idd-skill-authoring-owner:"',
  );
  const bounded = buildOwnerMarkerSearchQuery({
    owner: 'kurone-kito',
    repo: 'idd-skill',
    markerPrefix: PREFIX,
    boundCreatedAt: '2026-10-09T10:00:00Z',
  });
  assert.equal(bounded, `${unbounded} updated:>=2026-10-09T10:00:00Z`);
});

test('a bounded window over the search cap reports the cap and is not split (#3916)', () => {
  const result = collectSearchedIssueNumbers([page(SEARCH_RESULT_CAP + 1, [])]);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'search result cap exceeded');
});

test('an edited or unparseable trusted marker inside a bounded window still fails closed (#3916)', () => {
  const base = {
    set: SET,
    markerPrefix: PREFIX,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    trustedMarkerLogins: ['kurone-kito'],
    enumerationComplete: true,
  };
  const edited = evaluateAuthoringSetMembers({
    ...base,
    comments: [
      comment(
        TARGET,
        ownerMarker(SELF),
        'kurone-kito',
        '2026-10-09T11:00:00Z',
        20,
      ),
    ],
  });
  assert.equal(edited.complete, false);
  assert.match(edited.reason, /edited trusted authoring-owner marker/);
  const unparseable = evaluateAuthoringSetMembers({
    ...base,
    comments: [
      comment(
        TARGET,
        `${PREFIX}-authoring-owner: not a marker`,
        'kurone-kito',
        null,
        21,
      ),
    ],
  });
  assert.equal(unparseable.complete, false);
  assert.match(
    unparseable.reason,
    /unparseable trusted authoring-owner marker/,
  );
});
