import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyResumeRoutingCase } from '../scripts/protocol-helpers.mjs';

const FIXTURE_DIR = new URL('./fixtures/resume-recovery', import.meta.url);
const fixtures = loadFixtures(FIXTURE_DIR);

for (const fixture of fixtures) {
  test(`resume routing: ${fixture.name}`, () => {
    const result = classifyResumeRoutingCase(fixture.input, {
      staleHours: 24,
      stallMinutes: 30,
      pendingCiStates: ['queued', 'in_progress', 'waiting', 'pending'],
    });

    assert.equal(result.route, fixture.expected.route);
    assert.match(
      result.reason,
      new RegExp(fixture.expected.reasonContains, 'i'),
    );
  });
}

function loadFixtures(url) {
  const directory = fileURLToPath(url);
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => {
      const fullPath = join(directory, fileName);
      return JSON.parse(readFileSync(fullPath, 'utf8'));
    });
}
