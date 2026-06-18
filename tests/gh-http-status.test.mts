import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveGhHttpStatus } from '../src/scripts/gh-http-status.mts';

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
