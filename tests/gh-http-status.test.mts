import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  classifyInaccessibleIssueLookup,
  deriveGhHttpStatus,
  ghErrorText,
} from '../src/scripts/gh-http-status.mts';

const GH_ERROR_FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/gh-errors.json', import.meta.url), 'utf8'),
) as {
  cases: Record<string, { status: number; stderr?: string; stdout?: string }>;
};

function fixtureError(
  id: string,
): Error & { stderr?: string; stdout?: string } {
  const fixture = GH_ERROR_FIXTURES.cases[id];
  assert.ok(fixture, `missing gh-errors.json fixture: ${id}`);
  return Object.assign(new Error(`gh failed (fixture: ${id})`), {
    status: 1,
    stderr: fixture.stderr,
    stdout: fixture.stdout,
  });
}

// Shape of a real execFileSync('gh', ...) failure: process exit code 1
// regardless of the HTTP status, with the true status in stderr/stdout.
const ghError = (parts: {
  stderr?: string;
  stdout?: string;
  message?: string;
}) =>
  Object.assign(new Error(parts.message ?? 'Command failed'), {
    status: 1,
    ...parts,
  });

test('derives the HTTP status from gh stderr (HTTP NNN)', () => {
  assert.equal(
    deriveGhHttpStatus(ghError({ stderr: 'gh: Not Found (HTTP 404)' })),
    404,
  );
  assert.equal(
    deriveGhHttpStatus(
      ghError({ stderr: 'gh: API rate limit exceeded (HTTP 403)' }),
    ),
    403,
  );
  assert.equal(
    deriveGhHttpStatus(ghError({ stderr: 'gh: Bad credentials (HTTP 401)' })),
    401,
  );
});

test('falls back to a JSON error body "status" field', () => {
  assert.equal(
    deriveGhHttpStatus(
      ghError({ stdout: '{"message":"Not Found","status":"404"}' }),
    ),
    404,
  );
  // numeric status value, surfaced via the wrapped error message
  assert.equal(
    deriveGhHttpStatus(ghError({ message: 'failed: {"status":410}' })),
    410,
  );
});

test('prefers the (HTTP NNN) signal over the JSON body', () => {
  assert.equal(
    deriveGhHttpStatus(
      ghError({
        stderr: 'gh: Gone (HTTP 410)',
        stdout: '{"status":"403"}',
      }),
    ),
    410,
  );
});

test('returns null when no status can be determined (fail closed)', () => {
  assert.equal(
    deriveGhHttpStatus(ghError({ stderr: 'connect ETIMEDOUT 140.82.0.0:443' })),
    null,
  );
  assert.equal(deriveGhHttpStatus(ghError({})), null);
  assert.equal(deriveGhHttpStatus(null), null);
  assert.equal(deriveGhHttpStatus(undefined), null);
  assert.equal(deriveGhHttpStatus('a bare string'), null);
});

// #1521: ghErrorText was promoted from a private helper of this file to a
// shared export (reused by idd-merge-execute.mts's solo-CODEOWNER --admin
// fallback) instead of that caller hand-rolling a second, slightly
// different copy. Direct coverage locks in its exported contract.
test('ghErrorText joins stderr, stdout, and message, skipping empty parts', () => {
  // ghError's Error(parts.message ?? 'Command failed') always sets a
  // non-empty .message, so all three parts join here.
  assert.equal(
    ghErrorText(ghError({ stderr: 'stderr text', stdout: 'stdout text' })),
    'stderr text\nstdout text\nCommand failed',
  );
  // A plain object (not a real Error) has no .message at all, isolating
  // the stderr/stdout-only join.
  assert.equal(
    ghErrorText({ stderr: 'stderr text', stdout: 'stdout text' }),
    'stderr text\nstdout text',
  );
  assert.equal(
    ghErrorText(ghError({ message: 'only the message' })),
    'only the message',
  );
});

test('ghErrorText coerces a non-string field via String(...) instead of dropping it', () => {
  // A Buffer stderr (e.g. execFileSync called without { encoding: 'utf8' })
  // must still surface as readable text, not silently disappear.
  assert.equal(
    ghErrorText({ stderr: Buffer.from('buffered stderr') }),
    'buffered stderr',
  );
  assert.equal(ghErrorText({ stdout: 410 }), '410');
});

test('ghErrorText returns empty string for null/undefined/non-object input', () => {
  assert.equal(ghErrorText(null), '');
  assert.equal(ghErrorText(undefined), '');
  assert.equal(ghErrorText('a bare string'), '');
  assert.equal(ghErrorText({}), '');
});

// #3335: gh's other HTTP-status shapes -- a bare `gh: HTTP NNN` line (a
// non-JSON error body), and `HTTP NNN: <message> (<url>)` / `HTTP NNN
// (<url>)` from non-`api` subcommands. Fixture-driven against realistic
// gh 2.101.0 shapes (tests/fixtures/gh-errors.json), not hand-invented
// wording.
test('deriveGhHttpStatus recognizes the bare and URL-suffixed HTTP forms', () => {
  assert.equal(deriveGhHttpStatus(fixtureError('bare502')), 502);
  assert.equal(deriveGhHttpStatus(fixtureError('bare404')), 404);
  assert.equal(deriveGhHttpStatus(fixtureError('notFoundWithUrl404')), 404);
  assert.equal(deriveGhHttpStatus(fixtureError('deletedIssue410')), 410);
  assert.equal(deriveGhHttpStatus(fixtureError('samlEnforcement403')), 403);
  assert.equal(deriveGhHttpStatus(fixtureError('jsonBody404')), 404);
});

test('deriveGhHttpStatus does not match an unrelated number in prose', () => {
  assert.equal(
    deriveGhHttpStatus(
      Object.assign(new Error('retry HTTP 200 later'), {
        stderr: 'retry HTTP 200 later',
      }),
    ),
    null,
  );
});

test('classifyInaccessibleIssueLookup: 404 fixtures -> not-found', () => {
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('bare404')),
    'not-found',
  );
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('notFoundWithUrl404')),
    'not-found',
  );
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('jsonBody404')),
    'not-found',
  );
});

test('classifyInaccessibleIssueLookup: 410/451 -> inaccessible regardless of wording', () => {
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('deletedIssue410')),
    'inaccessible',
  );
  assert.equal(
    classifyInaccessibleIssueLookup(
      Object.assign(new Error('legal'), {
        stderr: 'gh: Repository access blocked (HTTP 451)',
      }),
    ),
    'inaccessible',
  );
});

test('classifyInaccessibleIssueLookup: 403 downgrades only on visibility/integration/SAML wording', () => {
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('samlEnforcement403')),
    'inaccessible',
  );
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('integration403')),
    'inaccessible',
  );
  // A secondary-rate-limit 403 must keep aborting/retrying, never downgrade.
  assert.equal(
    classifyInaccessibleIssueLookup(fixtureError('secondaryRateLimit403')),
    null,
  );
});

test('classifyInaccessibleIssueLookup: fails closed on auth failures and undetermined status', () => {
  assert.equal(
    classifyInaccessibleIssueLookup(
      Object.assign(new Error('auth'), {
        stderr: 'gh: Bad credentials (HTTP 401)',
      }),
    ),
    null,
  );
  assert.equal(
    classifyInaccessibleIssueLookup(
      Object.assign(new Error('timeout'), {
        stderr: 'connect ETIMEDOUT 140.82.0.0:443',
      }),
    ),
    null,
  );
  assert.equal(classifyInaccessibleIssueLookup(null), null);
});
