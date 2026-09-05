import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAuthoringOwnerComment,
  parseAuthoringPublicationComment,
  parseAuthoringPublicationIntentComment,
} from '../src/scripts/marker-helpers.mts';

// --- parseAuthoringOwnerComment ---

test('parseAuthoringOwnerComment parses a well-formed marker', () => {
  const body =
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#9001; anchor=kurone-kito/idd-skill#9001; mode=acquire; owner=owner-tok1; set=set-xyz789; session=sess-1; body-sha256=none; snapshot-sha256=none; supersedes=none -->\n\n_Issue-authoring ownership marker. Do not edit or delete._';
  const parsed = parseAuthoringOwnerComment(body, 'idd-skill');
  assert.deepEqual(parsed, {
    target: 'kurone-kito/idd-skill#9001',
    anchor: 'kurone-kito/idd-skill#9001',
    mode: 'acquire',
    owner: 'owner-tok1',
    set: 'set-xyz789',
    session: 'sess-1',
    bodySha256: 'none',
    snapshotSha256: 'none',
    supersedes: 'none',
  });
});

test('parseAuthoringOwnerComment returns null when a required field is missing', () => {
  const body =
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#9001; anchor=kurone-kito/idd-skill#9001; mode=acquire; owner=owner-tok1; set=set-xyz789; session=sess-1 -->';
  assert.equal(parseAuthoringOwnerComment(body, 'idd-skill'), null);
});

test('parseAuthoringOwnerComment returns null on an invalid mode', () => {
  const body =
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#9001; anchor=kurone-kito/idd-skill#9001; mode=not-a-real-mode; owner=owner-tok1; set=set-xyz789; session=sess-1; body-sha256=none; snapshot-sha256=none; supersedes=none -->';
  assert.equal(parseAuthoringOwnerComment(body, 'idd-skill'), null);
});

test('parseAuthoringOwnerComment returns null when the marker prefix does not match', () => {
  const body =
    '<!-- other-prefix-authoring-owner: target=kurone-kito/idd-skill#9001; anchor=kurone-kito/idd-skill#9001; mode=acquire; owner=owner-tok1; set=set-xyz789; session=sess-1; body-sha256=none; snapshot-sha256=none; supersedes=none -->';
  assert.equal(parseAuthoringOwnerComment(body, 'idd-skill'), null);
});

test('parseAuthoringOwnerComment returns null on a comment with no marker at all', () => {
  assert.equal(
    parseAuthoringOwnerComment('just a regular comment', 'idd-skill'),
    null,
  );
});

// --- parseAuthoringPublicationComment ---

test('parseAuthoringPublicationComment parses a well-formed marker', () => {
  const body =
    '<!-- idd-skill-authoring-publication: target=target-bcc0eda161bb750b; anchor=kurone-kito/idd-skill#2606; set=set-6c69b1881138f0df; session=claude-idd1-268c8f142825; token=pub-f1c89630be3de2b3 -->';
  const parsed = parseAuthoringPublicationComment(body, 'idd-skill');
  assert.deepEqual(parsed, {
    target: 'target-bcc0eda161bb750b',
    anchor: 'kurone-kito/idd-skill#2606',
    set: 'set-6c69b1881138f0df',
    session: 'claude-idd1-268c8f142825',
    token: 'pub-f1c89630be3de2b3',
  });
});

test('parseAuthoringPublicationComment returns null when a required field is missing', () => {
  const body =
    '<!-- idd-skill-authoring-publication: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz -->';
  assert.equal(parseAuthoringPublicationComment(body, 'idd-skill'), null);
});

// --- parseAuthoringPublicationIntentComment ---

test('parseAuthoringPublicationIntentComment parses a well-formed member-state record', () => {
  const body =
    '<!-- idd-skill-authoring-publication-intent: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok; journal=kurone-kito/idd-skill#2606; issue=kurone-kito/idd-skill#2621; actor=kurone-kito; state=member -->';
  const parsed = parseAuthoringPublicationIntentComment(body, 'idd-skill');
  assert.deepEqual(parsed, {
    target: 'target-abc',
    anchor: 'kurone-kito/idd-skill#2606',
    set: 'set-xyz',
    session: 'sess-1',
    token: 'pub-tok',
    journal: 'kurone-kito/idd-skill#2606',
    issue: 'kurone-kito/idd-skill#2621',
    actor: 'kurone-kito',
    state: 'member',
  });
});

test('parseAuthoringPublicationIntentComment accepts the issue=none / state=pending pre-creation shape', () => {
  const body =
    '<!-- idd-skill-authoring-publication-intent: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok; journal=kurone-kito/idd-skill#2606; issue=none; actor=kurone-kito; state=pending -->';
  const parsed = parseAuthoringPublicationIntentComment(body, 'idd-skill');
  assert.equal(parsed?.issue, 'none');
  assert.equal(parsed?.state, 'pending');
});

test('parseAuthoringPublicationIntentComment returns null on an invalid state', () => {
  const body =
    '<!-- idd-skill-authoring-publication-intent: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok; journal=kurone-kito/idd-skill#2606; issue=none; actor=kurone-kito; state=not-a-real-state -->';
  assert.equal(parseAuthoringPublicationIntentComment(body, 'idd-skill'), null);
});

test('parseAuthoringPublicationIntentComment returns null when a required field is missing', () => {
  const body =
    '<!-- idd-skill-authoring-publication-intent: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok; journal=kurone-kito/idd-skill#2606; state=member -->';
  assert.equal(parseAuthoringPublicationIntentComment(body, 'idd-skill'), null);
});

test('parseAuthoringOwnerComment returns null when the marker follows other prose (not first bytes)', () => {
  const body =
    'Some preamble.\n<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#9001; anchor=kurone-kito/idd-skill#9001; mode=acquire; owner=owner-tok1; set=set-xyz789; session=sess-1; body-sha256=none; snapshot-sha256=none; supersedes=none -->';
  assert.equal(parseAuthoringOwnerComment(body, 'idd-skill'), null);
});

test('parseAuthoringPublicationComment returns null when the opener spans a newline', () => {
  const body =
    '<!--\nidd-skill-authoring-publication: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok -->';
  assert.equal(parseAuthoringPublicationComment(body, 'idd-skill'), null);
});

test('parseAuthoringPublicationComment returns null when preceded by a leading blank line', () => {
  const body =
    '\n<!-- idd-skill-authoring-publication: target=target-abc; anchor=kurone-kito/idd-skill#2606; set=set-xyz; session=sess-1; token=pub-tok -->';
  assert.equal(parseAuthoringPublicationComment(body, 'idd-skill'), null);
});

test('parseAuthoringOwnerComment returns null when the payload itself spans a newline', () => {
  const body =
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#9001;\nanchor=kurone-kito/idd-skill#9001; mode=acquire; owner=owner-tok1; set=set-xyz789; session=sess-1; body-sha256=none; snapshot-sha256=none; supersedes=none -->';
  assert.equal(parseAuthoringOwnerComment(body, 'idd-skill'), null);
});
