import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  classifyReviewThreadForGate,
  diffReviewSnapshot,
  routeRejectedChangesRequestedReview,
  summarizeReviewThreadsForGate,
} from '../scripts/protocol-helpers.mjs';

const changesRequestedRoutes = readJson(
  'fixtures/review-gate/changes-requested-routes.json',
);
const snapshotDiffRoutes = readJson(
  'fixtures/review-gate/snapshot-diff-routes.json',
);
const threadGateRoutes = readJson(
  'fixtures/review-gate/thread-gate-routes.json',
);

test('routes rejected CHANGES_REQUESTED review-body scenarios', () => {
  for (const fixture of changesRequestedRoutes) {
    assert.deepEqual(
      routeRejectedChangesRequestedReview(fixture.input),
      fixture.expected,
      fixture.name,
    );
  }
});

test('routes F2/F3 snapshot-vs-live diff scenarios', () => {
  for (const fixture of snapshotDiffRoutes) {
    assert.deepEqual(
      diffReviewSnapshot(fixture.snapshot, fixture.live),
      fixture.expected,
      fixture.name,
    );
  }
});

test('classifies unresolved threads for awaiting-reviewer and conversation-resolution gates', () => {
  for (const fixture of threadGateRoutes) {
    assert.deepEqual(
      summarizeReviewThreadsForGate(fixture.threads, fixture.options),
      fixture.expected,
      fixture.name,
    );

    if (fixture.threads.length === 1) {
      const expectedClassification =
        fixture.expected.classifications[0]?.classification ?? 'resolved';
      assert.equal(
        classifyReviewThreadForGate(fixture.threads[0], fixture.options)
          .classification,
        expectedClassification,
        `${fixture.name} single-thread classification`,
      );
    }
  }
});

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  );
}
