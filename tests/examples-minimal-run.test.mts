import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  OPERATIONAL_MARKERS,
  parseActivationNonceComment,
  parseClaimComment,
  parseReviewWatermarkComment,
} from '../src/scripts/marker-helpers.mts';

// #1704 review finding: the sync-manifest `contains` guards on these sample
// files only check a hard-coded regex against the target, never the actual
// marker-helpers.mts renderer/parser -- so a real format change could drift
// silently past them. These tests close that gap by running each sample's
// marker text through the same parser/pattern production code uses.

function readMarkerLine(path: string, prefix: string): string {
  const body = readFileSync(path, 'utf8');
  const line = body
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(prefix));
  assert.ok(line, `${path} is missing a line starting with ${prefix}`);
  return (line as string).trim();
}

test('examples/minimal-run/claim-comment.md marker parses via parseClaimComment', () => {
  const line = readMarkerLine(
    'examples/minimal-run/claim-comment.md',
    '<!-- claimed-by:',
  );
  const parsed = parseClaimComment(line, '2026-05-10T09:00:00Z');
  assert.ok(parsed, `parseClaimComment rejected: ${line}`);
});

test('examples/minimal-run/activation-nonce.md marker parses via parseActivationNonceComment', () => {
  const line = readMarkerLine(
    'examples/minimal-run/activation-nonce.md',
    '<!-- activation-nonce:',
  );
  const parsed = parseActivationNonceComment(line, '2026-05-10T09:00:01Z');
  assert.ok(parsed, `parseActivationNonceComment rejected: ${line}`);
});

test('examples/minimal-run/heartbeat.md marker parses via parseClaimComment', () => {
  const line = readMarkerLine(
    'examples/minimal-run/heartbeat.md',
    '<!-- claimed-by:',
  );
  const parsed = parseClaimComment(line, '2026-05-10T11:00:00Z');
  assert.ok(parsed, `parseClaimComment rejected: ${line}`);
});

test('examples/minimal-run/review-snapshot.md watermark parses via parseReviewWatermarkComment', () => {
  const line = readMarkerLine(
    'examples/minimal-run/review-snapshot.md',
    '<!-- review-watermark:',
  );
  const parsed = parseReviewWatermarkComment(line, '2026-05-10T11:08:42Z');
  assert.ok(parsed, `parseReviewWatermarkComment rejected: ${line}`);
});

test('examples/minimal-run/review-snapshot.md baseline matches the canonical review-baseline pattern', () => {
  const line = readMarkerLine(
    'examples/minimal-run/review-snapshot.md',
    '<!-- review-baseline:',
  );
  const entry = OPERATIONAL_MARKERS.find(
    (marker) => marker.label === '<!-- review-baseline:',
  );
  assert.ok(entry, 'no review-baseline entry in OPERATIONAL_MARKERS');
  assert.ok(
    (entry as (typeof OPERATIONAL_MARKERS)[number]).pattern.test(line),
    `canonical review-baseline pattern rejected: ${line}`,
  );
});
