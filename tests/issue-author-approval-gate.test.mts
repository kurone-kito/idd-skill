import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { stripGeneratedFromBanner } from '../src/scripts/consistency-helpers.mts';
import { extractSection } from './test-utils.mts';

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('discover instructions define approval-needed fallback routing', () => {
  const live = read('.github/instructions/idd-discover.instructions.md');

  assert.match(live, /approval-needed fallback bucket/i);
  assert.match(live, /skipIssueAuthorApprovalGate/);
  assert.match(live, /maintainerApprovalActorPolicy/);
  assert.match(live, /owners-and-maintainers-only/);
  assert.match(live, /all-write-permission-actors/);
  assert.match(live, /visible approval comment/i);
  assert.match(live, /IDD ready/);
  assert.match(live, /bare organization `MEMBER` association/i);
  assert.match(live, /stop before A5/i);
  assert.match(live, /do not auto-claim from the fallback[\s\S]*bucket/i);
});

test('discover approval gate section stays synced with the template mirror', () => {
  const live = extractSection(
    read('.github/instructions/idd-discover.instructions.md'),
    '## A3.5 — Apply issue-author approval gate',
    '## A4 — Gate, then pick',
  );
  const template = extractSection(
    read('idd-template/.github/instructions/idd-discover.instructions.md'),
    '## A3.5 — Apply issue-author approval gate',
    '## A4 — Gate, then pick',
  );

  assert.equal(template, live);
});

test('claim approval pre-check stays synced with the template mirror', () => {
  const live = extractSection(
    read('.github/instructions/idd-claim.instructions.md'),
    '**(a) Issue-author approval gate**',
    '**(b) Assignee and project status**',
  );
  const template = extractSection(
    read('idd-template/.github/instructions/idd-claim.instructions.md'),
    '**(a) Issue-author approval gate**',
    '**(b) Assignee and project status**',
  );

  assert.match(live, /stop without[\s\S]*claiming/i);
  assert.match(live, /bare organization `MEMBER` association/i);
  assert.equal(template, live);
});

test('suitability instructions keep issue-author approval outside A4.5 outcomes', () => {
  const live = read('.github/instructions/idd-suitability.instructions.md');
  const template = read(
    'idd-template/.github/instructions/idd-suitability.instructions.md',
  );

  assert.match(live, /Issue-author approval is a separate pre-claim gate\./);
  // The live target carries the sync-docs generated-from banner the template
  // source does not; strip it before the content-mirror equality check.
  assert.equal(template, stripGeneratedFromBanner(live));
});

test('overview documents the secure default issue-author approval config behavior', () => {
  const live = read('.github/instructions/idd-overview-core.instructions.md');
  const template = read(
    'idd-template/.github/instructions/idd-overview-core.instructions.md',
  );
  const expected =
    /Absent values keep the gate\s+enabled and default approval actors to\s+`owners-and-maintainers-only`\./;

  assert.match(live, /skipIssueAuthorApprovalGate/);
  assert.match(live, /maintainerApprovalActorPolicy/);
  assert.match(
    live,
    expected,
    'live overview is missing the secure-default note',
  );
  assert.match(
    template,
    expected,
    'template overview is missing the secure-default note',
  );
});

test('repository config keeps the issue-author approval gate enabled by default', () => {
  const config = JSON.parse(read('.github/idd/config.json'));

  assert.notEqual(
    config.skipIssueAuthorApprovalGate,
    true,
    'gate must stay enabled unless explicitly opted out with true',
  );
});

test('customization and policy docs record the non-configurable safety invariants', () => {
  const liveCustomization = extractSection(
    read('docs/customization.md'),
    '## Non-Configurable Safety Invariants',
    '## Helper Runtime Profile',
  );
  const templateCustomization = extractSection(
    read('idd-template/docs/customization.md'),
    '## Non-Configurable Safety Invariants',
    '## Helper Runtime Profile',
  );

  assert.match(
    liveCustomization,
    /Claim revalidation still runs before every mutating side effect\./,
  );
  assert.match(
    liveCustomization,
    /Marker-shaped comments from untrusted authors never gain authority\./,
  );
  assert.match(liveCustomization, /Forced handoff remains human-gated only\./);
  assert.match(
    liveCustomization,
    /Approval-needed fallback issues remain a stop condition for unattended[\s\S]*discovery\./,
  );
  assert.equal(templateCustomization, liveCustomization);

  const livePolicy = extractSection(
    read('docs/policy-constants.md'),
    '## Non-Configurable Safety Invariants',
    '## Forced Handoff Defaults',
  );
  const templatePolicy = extractSection(
    read('idd-template/docs/policy-constants.md'),
    '## Non-Configurable Safety Invariants',
    '## Forced Handoff Defaults',
  );

  assert.match(livePolicy, /These rules are fixed gates, not policy knobs/);
  assert.match(livePolicy, /Claim revalidation gate/);
  assert.match(livePolicy, /Marker trust \/ authority/);
  assert.match(livePolicy, /Forced handoff initiator/);
  assert.match(livePolicy, /Approval-needed fallback/);
  assert.equal(templatePolicy, livePolicy);
});
