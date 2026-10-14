#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as verdictModule from '../src/scripts/f4-head-proof-verdict.mts';

const { classifyReread, decideAfterPost, decideBeforePost } = verdictModule;

type Input = Parameters<typeof decideBeforePost>[0];
type Entry = Input['markers'][number];
type MarkerFields = Exclude<Entry, { unparseable: true }>;
type PostResult = Parameters<typeof decideAfterPost>[0];
type Reread = ReturnType<typeof classifyReread>;

const CLAIM_ID = '9b40b5ea-0bac-4278-b322-fe0451ea966a';
const BRANCH = 'issue/4094-feat-merge-add-f4-head-proof-verdict';
const PR = 3741;
const F2 = '1'.repeat(40);
const TIP = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const HEAD = '4'.repeat(40);
const OTHER = '5'.repeat(40);
const ACTIVATED = '2026-10-14T07:00:00Z';
const CREATED = '2026-10-14T07:30:00Z';

/** The base input is a fully valid, post-eligible state; tests override one field. */
function baseInput(overrides: Partial<Input> = {}): Input {
  return {
    claimId: CLAIM_ID,
    prNumber: PR,
    branch: BRANCH,
    claimOk: true,
    livePr: {
      merged: true,
      readable: true,
      mergeCommitSha: MERGE,
      headSha: HEAD,
      mergeParentHeadSha: null,
    },
    refNameValid: true,
    localRef: { state: 'present', tip: TIP },
    claimActivatedAt: ACTIVATED,
    markers: [],
    markersRead: true,
    watermarkAuthenticated: true,
    ...overrides,
  };
}

function marker(overrides: Partial<MarkerFields> = {}): Entry {
  return {
    claimId: CLAIM_ID,
    prNumber: PR,
    branch: BRANCH,
    merge: MERGE,
    head: HEAD,
    f2: F2,
    branchTip: TIP,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

/** The canonical identity string, pinned exactly so the token format cannot drift. */
const EXPECTED_IDENTITY = JSON.stringify({
  prNumber: PR,
  claimId: CLAIM_ID,
  branch: BRANCH,
  f2: F2,
  branchTip: TIP,
  merge: MERGE,
  head: HEAD,
});

const REUSABLE: Reread = { result: 'reusable', identity: EXPECTED_IDENTITY };
const NONE: Reread = { result: 'none', identity: null };
const FAILED: Reread = { result: 'failed', identity: null };
const NOT_REUSABLE: Reread = { result: 'trusted-not-reusable', identity: null };

function assertVerdict(
  actual: ReturnType<typeof decideBeforePost>,
  expected: {
    disposition: string;
    exitCode: 0 | 1 | null;
    reason: string | null;
  },
): void {
  assert.deepEqual(actual, expected);
}

describe('module surface', () => {
  it('exports exactly the three verdict functions', () => {
    assert.deepEqual(Object.keys(verdictModule).sort(), [
      'classifyReread',
      'decideAfterPost',
      'decideBeforePost',
    ]);
  });
});

describe('decideBeforePost: verdict rows', () => {
  it('row 1: a failed claim check stops with exit 1 and no POST', () => {
    assertVerdict(decideBeforePost(baseInput({ claimOk: false })), {
      disposition: 'stop',
      exitCode: 1,
      reason: 'claim-or-lock',
    });
  });

  it('row 1 precedes the PR checks', () => {
    const input = baseInput({
      claimOk: false,
      livePr: { ...baseInput().livePr, merged: false },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'stop',
      exitCode: 1,
      reason: 'claim-or-lock',
    });
  });

  it('row 2: an unmerged PR holds with pr-state', () => {
    const input = baseInput({
      livePr: { ...baseInput().livePr, merged: false },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'pr-state',
    });
  });

  it('row 2: an unreadable PR holds with pr-state', () => {
    const input = baseInput({
      livePr: { ...baseInput().livePr, readable: false },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'pr-state',
    });
  });

  it('row 2: a merge commit SHA that is not full lowercase hex holds', () => {
    for (const mergeCommitSha of [null, 'A'.repeat(40), MERGE.slice(1)]) {
      const input = baseInput({
        livePr: { ...baseInput().livePr, mergeCommitSha },
      });
      assertVerdict(decideBeforePost(input), {
        disposition: 'hold',
        exitCode: 1,
        reason: 'pr-state',
      });
    }
  });

  it('row 2: a head SHA that is not full lowercase hex holds', () => {
    const input = baseInput({
      livePr: { ...baseInput().livePr, headSha: null },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'pr-state',
    });
  });

  it('row 2: a two-parent merge whose second parent differs from the head holds', () => {
    const input = baseInput({
      livePr: { ...baseInput().livePr, mergeParentHeadSha: OTHER },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'pr-state',
    });
  });

  it('row 2: a two-parent merge whose second parent equals the head passes', () => {
    const input = baseInput({
      livePr: { ...baseInput().livePr, mergeParentHeadSha: HEAD },
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'post',
      exitCode: null,
      reason: null,
    });
  });

  it('row 3: an invalid ref name holds with ref-read', () => {
    assertVerdict(decideBeforePost(baseInput({ refNameValid: false })), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'ref-read',
    });
  });

  it('row 3: a ref read error holds with ref-read', () => {
    const input = baseInput({ localRef: { state: 'error', tip: null } });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'ref-read',
    });
  });

  it('row 3a: an unreadable marker set holds with no POST', () => {
    const input = baseInput({ markersRead: false });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'marker-read-failed',
    });
  });

  it('row 4: an absent ref with no marker holds with branch-absent', () => {
    const input = baseInput({ localRef: { state: 'absent', tip: null } });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'branch-absent',
    });
  });

  it('row 4: an absent ref with only non-reusable markers holds with branch-absent', () => {
    const input = baseInput({
      localRef: { state: 'absent', tip: null },
      markers: [marker({ branchTip: 'not-a-sha' })],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'branch-absent',
    });
  });

  it('row 4 precedes row 6: an absent ref with an unparseable entry holds with branch-absent', () => {
    const input = baseInput({
      localRef: { state: 'absent', tip: null },
      markers: [{ unparseable: true }],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'branch-absent',
    });
  });

  it('row 4 does not fire when an absent ref has a reusable marker: it proceeds on row 5', () => {
    const input = baseInput({
      localRef: { state: 'absent', tip: null },
      markers: [marker()],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('row 5: a single reusable marker proceeds with exit 0', () => {
    assertVerdict(decideBeforePost(baseInput({ markers: [marker()] })), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('row 5: identical duplicate markers proceed', () => {
    const input = baseInput({ markers: [marker(), marker()] });
    assertVerdict(decideBeforePost(input), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('row 5: a reusable proof with a full f2 proceeds with no watermark and no POST', () => {
    const input = baseInput({
      markers: [marker()],
      watermarkAuthenticated: false,
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('row 5: markers that differ only in createdAt and updatedAt are identical', () => {
    const later = '2026-10-14T08:15:00Z';
    const input = baseInput({
      markers: [
        marker({ createdAt: CREATED, updatedAt: CREATED }),
        marker({ createdAt: later, updatedAt: later }),
      ],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('row 6: markers whose token fields differ hold with conflicting-marker', () => {
    const input = baseInput({
      markers: [marker(), marker({ f2: OTHER })],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: a marker whose branch tip differs from the present ref holds', () => {
    const input = baseInput({ markers: [marker({ branchTip: OTHER })] });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: an unparseable trusted entry holds with conflicting-marker', () => {
    const input = baseInput({ markers: [{ unparseable: true }] });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: a reusable marker beside an unparseable entry holds with conflicting-marker', () => {
    const input = baseInput({
      markers: [marker(), { unparseable: true }],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: a null claim activation makes a present marker non-reusable and holds', () => {
    const input = baseInput({
      claimActivatedAt: null,
      markers: [marker()],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: a null claim activation with an absent ref holds with branch-absent (row 4)', () => {
    const input = baseInput({
      claimActivatedAt: null,
      localRef: { state: 'absent', tip: null },
      markers: [marker()],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'branch-absent',
    });
  });

  it('row 6: a marker created before the claim activation is not reusable', () => {
    const input = baseInput({
      markers: [
        marker({
          createdAt: '2026-10-14T06:59:59Z',
          updatedAt: '2026-10-14T06:59:59Z',
        }),
      ],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 6: a marker whose updatedAt differs from createdAt is not reusable', () => {
    const input = baseInput({
      markers: [marker({ updatedAt: '2026-10-14T07:45:00Z' })],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('timestamps compare as instants, so an offset and a fraction still match', () => {
    const input = baseInput({
      claimActivatedAt: '2026-10-14T16:00:00+09:00',
      markers: [
        marker({ createdAt: CREATED, updatedAt: '2026-10-14T07:30:00.000Z' }),
      ],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reusable',
    });
  });

  it('a marker whose f2 is not a full lowercase SHA is not reusable', () => {
    for (const f2 of ['A'.repeat(40), F2.slice(1), 'z'.repeat(40)]) {
      const input = baseInput({ markers: [marker({ f2 })] });
      assertVerdict(decideBeforePost(input), {
        disposition: 'hold',
        exitCode: 1,
        reason: 'conflicting-marker',
      });
    }
  });

  it('a marker whose branch tip is not a full SHA is not reusable with the ref absent', () => {
    const input = baseInput({
      localRef: { state: 'absent', tip: null },
      markers: [marker({ branchTip: TIP.slice(1) })],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'branch-absent',
    });
  });

  it('a marker whose branch tip is not a full SHA is not reusable with the ref present', () => {
    const input = baseInput({
      markers: [marker({ branchTip: 'B'.repeat(40) })],
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'conflicting-marker',
    });
  });

  it('row 7: no marker, present ref, unauthenticated watermark holds', () => {
    const input = baseInput({ watermarkAuthenticated: false });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'watermark-unauthenticated',
    });
  });

  it('row 7 precedes row 7a: an unauthenticated watermark with a null claim activation holds on row 7', () => {
    const input = baseInput({
      watermarkAuthenticated: false,
      claimActivatedAt: null,
    });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'watermark-unauthenticated',
    });
  });

  it('row 7a: no marker, authenticated watermark, null claim activation holds with no POST', () => {
    const input = baseInput({ claimActivatedAt: null });
    assertVerdict(decideBeforePost(input), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'claim-activation-unknown',
    });
  });

  it('row 8: no marker, present ref, authenticated watermark asks for a POST', () => {
    assertVerdict(decideBeforePost(baseInput()), {
      disposition: 'post',
      exitCode: null,
      reason: null,
    });
  });
});

describe('classifyReread', () => {
  it('returns failed for a failed read', () => {
    assert.deepEqual(classifyReread(null, baseInput()), FAILED);
  });

  it('returns none for an empty read', () => {
    assert.deepEqual(classifyReread([], baseInput()), NONE);
  });

  it('returns reusable with the canonical identity for one reusable marker', () => {
    assert.deepEqual(classifyReread([marker()], baseInput()), REUSABLE);
  });

  it('pins the identity string to the seven token fields in canonical order', () => {
    const reread = classifyReread([marker()], baseInput());
    assert.equal(
      reread.identity,
      '{"prNumber":3741,"claimId":"9b40b5ea-0bac-4278-b322-fe0451ea966a",' +
        '"branch":"issue/4094-feat-merge-add-f4-head-proof-verdict",' +
        '"f2":"1111111111111111111111111111111111111111",' +
        '"branchTip":"2222222222222222222222222222222222222222",' +
        '"merge":"3333333333333333333333333333333333333333",' +
        '"head":"4444444444444444444444444444444444444444"}',
    );
  });

  it('returns reusable for identical duplicates, ignoring timestamps', () => {
    const later = '2026-10-14T08:15:00Z';
    const reread = classifyReread(
      [marker(), marker({ createdAt: later, updatedAt: later })],
      baseInput(),
    );
    assert.deepEqual(reread, REUSABLE);
  });

  it('returns trusted-not-reusable for two trusted markers that differ', () => {
    const reread = classifyReread(
      [marker(), marker({ f2: OTHER })],
      baseInput(),
    );
    assert.deepEqual(reread, NOT_REUSABLE);
  });

  it('returns trusted-not-reusable for an unparseable entry', () => {
    assert.deepEqual(
      classifyReread([{ unparseable: true }], baseInput()),
      NOT_REUSABLE,
    );
  });

  it('returns trusted-not-reusable for a single non-reusable marker', () => {
    const reread = classifyReread([marker({ branchTip: OTHER })], baseInput());
    assert.deepEqual(reread, NOT_REUSABLE);
  });

  it('returns trusted-not-reusable when one of several markers is non-reusable', () => {
    const reread = classifyReread(
      [marker(), { unparseable: true }],
      baseInput(),
    );
    assert.deepEqual(reread, NOT_REUSABLE);
  });
});

describe('decideAfterPost: successful write', () => {
  it('proceeds when the re-fetch confirms the posted identity', () => {
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: REUSABLE,
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'posted-confirmed',
    });
  });

  it('holds when the re-fetch identity differs from the posted identity', () => {
    const other = EXPECTED_IDENTITY.replace(TIP, OTHER);
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: { result: 'reusable', identity: other },
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'posted-disagreed',
    });
  });

  it('holds when the re-fetch finds no trusted marker', () => {
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: NONE,
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'posted-disagreed',
    });
  });

  it('holds when the re-fetch fails to read', () => {
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: FAILED,
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'posted-disagreed',
    });
  });

  it('holds when there is no re-fetch result at all', () => {
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: null,
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'posted-disagreed',
    });
  });

  it('never reads rereads when the write succeeded', () => {
    const result: PostResult = {
      writeOk: true,
      postedIdentity: EXPECTED_IDENTITY,
      refetch: REUSABLE,
    };
    assert.doesNotThrow(() => decideAfterPost(result));
  });
});

describe('decideAfterPost: ambiguous write', () => {
  it('throws unless rereads has exactly three entries', () => {
    const missing: PostResult = { writeOk: false, postedIdentity: null };
    const two: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, REUSABLE],
    };
    const four: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, REUSABLE, REUSABLE, REUSABLE],
    };
    assert.throws(() => decideAfterPost(missing));
    assert.throws(() => decideAfterPost(two));
    assert.throws(() => decideAfterPost(four));
  });

  it('holds with reread-failed when one re-read is reusable and another failed', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, FAILED, REUSABLE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-failed',
    });
  });

  it('holds with reread-failed when a none and a failed are mixed', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [NONE, FAILED, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-failed',
    });
  });

  it('checks failed before conflict, so a failed read holds on reread-failed', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [NOT_REUSABLE, FAILED, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-failed',
    });
  });

  it('holds with reread-conflict when one re-read is reusable and another trusted-not-reusable', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, NOT_REUSABLE, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-conflict',
    });
  });

  it('holds with reread-conflict when two re-reads return different reusable markers', () => {
    const other = EXPECTED_IDENTITY.replace(TIP, OTHER);
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, { result: 'reusable', identity: other }, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-conflict',
    });
  });

  it('holds with reread-conflict when a reusable and two nones are mixed', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, NONE, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'reread-conflict',
    });
  });

  it('proceeds with reread-reusable when every re-read is reusable with one identity', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [REUSABLE, REUSABLE, REUSABLE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'proceed',
      exitCode: 0,
      reason: 'reread-reusable',
    });
  });

  it('holds with post-unconfirmed when every re-read is none', () => {
    const result: PostResult = {
      writeOk: false,
      postedIdentity: null,
      rereads: [NONE, NONE, NONE],
    };
    assertVerdict(decideAfterPost(result), {
      disposition: 'hold',
      exitCode: 1,
      reason: 'post-unconfirmed',
    });
  });
});
