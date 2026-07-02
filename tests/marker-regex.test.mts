import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMarkerRegex,
  escapeRegex,
} from '../src/scripts/marker-regex.mts';

test('escapeRegex escapes every RegExp metacharacter', () => {
  assert.equal(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} chars under test, not a forgotten template placeholder.
    escapeRegex('.*+?^${}()|[]\\'),
    '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\',
  );
});

test('escapeRegex leaves a string with no metacharacters unchanged', () => {
  assert.equal(escapeRegex('roadmap-id'), 'roadmap-id');
});

test('escapeRegex leaves an empty string unchanged', () => {
  assert.equal(escapeRegex(''), '');
});

test('escapeRegex makes a namespaced prefix safe to interpolate', () => {
  const escaped = escapeRegex('org.project');
  const regex = new RegExp(escaped);
  assert.ok(regex.test('org.project'));
  // Without escaping, `.` would also match "orgXproject"; the escaped form must not.
  assert.ok(!regex.test('orgXproject'));
});

test('createMarkerRegex detects a well-formed marker case-insensitively', () => {
  const regex = createMarkerRegex('idd-skill', 'roadmap-id');
  assert.ok(regex.test('<!-- idd-skill-roadmap-id: my-roadmap -->'));
  assert.ok(regex.test('<!-- IDD-SKILL-ROADMAP-ID: my-roadmap -->'));
});

test('createMarkerRegex matches mid-string, not just at position 0', () => {
  const regex = createMarkerRegex('idd-skill', 'roadmap-id');
  const text = 'Some prose before.\n<!-- idd-skill-roadmap-id: x -->\nAfter.';
  assert.ok(regex.test(text));
});

test('createMarkerRegex escapes a prefix containing regex metacharacters', () => {
  const regex = createMarkerRegex('org.project', 'roadmap-id');
  assert.ok(regex.test('<!-- org.project-roadmap-id: x -->'));
  // A literal dot must not act as a wildcard for an unrelated character.
  assert.ok(!regex.test('<!-- orgXproject-roadmap-id: x -->'));
});

test('createMarkerRegex requires a word boundary after the suffix', () => {
  const regex = createMarkerRegex('idd-skill', 'roadmap-id');
  // `\b` blocks a word-character extension of the suffix (no transition
  // between two word characters), e.g. "roadmap-id" gluing onto "x".
  assert.ok(!regex.test('<!-- idd-skill-roadmap-idx: x -->'));
  // A hyphen is not a word character, so it already forms a boundary on
  // its own; `\b` does not additionally block a hyphen-separated suffix.
  assert.ok(regex.test('<!-- idd-skill-roadmap-id-2: x -->'));
});

test('createMarkerRegex does not match a wrong prefix or suffix', () => {
  const regex = createMarkerRegex('idd-skill', 'roadmap-id');
  assert.ok(!regex.test('<!-- other-roadmap-id: x -->'));
  assert.ok(!regex.test('<!-- idd-skill-blocked-by: x -->'));
});

test('createMarkerRegex has no capture group and is not global', () => {
  const regex = createMarkerRegex('idd-skill', 'roadmap-id');
  const match = regex.exec('<!-- idd-skill-roadmap-id: x -->');
  assert.ok(match);
  assert.equal(match.length, 1);
  assert.equal(regex.global, false);
});
