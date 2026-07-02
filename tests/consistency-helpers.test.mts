import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractGeneratedFromBanner,
  generatedFromBanner,
} from '../src/scripts/consistency-helpers.mts';

// extractGeneratedFromBanner is the only export of this module without
// direct dedicated coverage: it is only ever called internally by
// stripGeneratedFromBanner/parseGeneratedFromBannerSource, never asserted
// on directly. The other 12 exports already have direct, named test()
// blocks in tests/consistency.test.mts, plus
// collectRootMarkdownAllowlistViolations (tests/root-markdown-allowlist.test.mts)
// and collectTypeSuppressionViolations (tests/type-suppression-budgets.test.mts).
// The 3 re-exported policy-helpers.mts functions have their own
// tests/policy-helpers.test.mts.

const BANNER = generatedFromBanner('src/example.mts');

test('extractGeneratedFromBanner returns the banner at the top when there is no frontmatter', () => {
  const body = `${BANNER}\n\n# Heading\n\nBody.\n`;
  assert.equal(extractGeneratedFromBanner(body), BANNER);
});

test('extractGeneratedFromBanner returns the banner immediately after a frontmatter block', () => {
  const body = `---\napplyTo: "**"\n---\n\n${BANNER}\n\n# Heading\n\nBody.\n`;
  assert.equal(extractGeneratedFromBanner(body), BANNER);
});

test('extractGeneratedFromBanner returns null when no banner is present', () => {
  assert.equal(extractGeneratedFromBanner('# Heading\n\nBody.\n'), null);
});

test('extractGeneratedFromBanner returns null when frontmatter is present but no banner follows', () => {
  const body = '---\napplyTo: "**"\n---\n\n# Heading\n\nBody.\n';
  assert.equal(extractGeneratedFromBanner(body), null);
});

test('extractGeneratedFromBanner does not match a banner-shaped comment out of position', () => {
  // The function deliberately only matches at the very top or immediately
  // after frontmatter; a banner-shaped block elsewhere in the body must be
  // reported as missing rather than silently accepted.
  const body = `# Heading\n\nBody.\n\n${BANNER}\n`;
  assert.equal(extractGeneratedFromBanner(body), null);
});
