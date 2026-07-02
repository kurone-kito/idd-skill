import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type CollaboratorPermissionCache,
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
  readForcedHandoffPolicy,
} from '../src/scripts/collaborator-permission.mts';

// collaboratorPermission and isAuthorizedForcedHandoffActor's UNCACHED path
// shells out to `gh api repos/{owner}/{repo}/collaborators/{login}/permission`.
// Per #1212's scope note ("do NOT mock `gh` subprocess calls"), that path
// stays untested here — it is exercised instead via the cache-seeding seam
// below, which is the pure surface these functions actually expose.

function makeConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'forced-handoff-policy-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

test('readForcedHandoffPolicy falls back to defaults when the file is missing', () => {
  assert.deepEqual(
    readForcedHandoffPolicy('/nonexistent/path/does-not-exist.json'),
    { mode: 'disabled', authorityPolicy: 'owners-and-maintainers-only' },
  );
});

test('readForcedHandoffPolicy falls back to defaults on malformed JSON', () => {
  const path = makeConfigFile('{ not valid json');
  assert.deepEqual(readForcedHandoffPolicy(path), {
    mode: 'disabled',
    authorityPolicy: 'owners-and-maintainers-only',
  });
});

test('readForcedHandoffPolicy reads explicit values from a valid file', () => {
  const path = makeConfigFile(
    JSON.stringify({
      forcedHandoff: {
        mode: 'human-gated',
        authorityPolicy: 'all-write-permission-actors',
      },
    }),
  );
  assert.deepEqual(readForcedHandoffPolicy(path), {
    mode: 'human-gated',
    authorityPolicy: 'all-write-permission-actors',
  });
});

test('readForcedHandoffPolicy falls back per-field on an unrecognized value', () => {
  const path = makeConfigFile(
    JSON.stringify({ forcedHandoff: { mode: 'sometimes' } }),
  );
  assert.deepEqual(readForcedHandoffPolicy(path), {
    mode: 'disabled',
    authorityPolicy: 'owners-and-maintainers-only',
  });
});

test('readForcedHandoffMode and readForcedHandoffAuthorityPolicy are convenience accessors', () => {
  const path = makeConfigFile(
    JSON.stringify({
      forcedHandoff: {
        mode: 'human-gated',
        authorityPolicy: 'all-write-permission-actors',
      },
    }),
  );
  assert.equal(readForcedHandoffMode(path), 'human-gated');
  assert.equal(
    readForcedHandoffAuthorityPolicy(path),
    'all-write-permission-actors',
  );
});

function seededCache(
  owner: string,
  repo: string,
  login: string,
  permission: string,
  roleName: string,
): CollaboratorPermissionCache {
  const cache: CollaboratorPermissionCache = new Map();
  cache.set(`${owner}/${repo}:${login}`, { permission, roleName });
  return cache;
}

test('collaboratorPermission returns the seeded cache entry without shelling out', () => {
  // A real (uncached) call for this owner/repo/login would fail closed to
  // empty strings (nonexistent repo/user); getting the seeded sentinel
  // back instead is the proof the cache short-circuited before
  // execFileSync('gh', ...) would ever run.
  const cache = seededCache(
    'nonexistent-owner-xyz',
    'nonexistent-repo-xyz',
    'nonexistent-user-xyz',
    'admin',
    'admin',
  );
  assert.deepEqual(
    collaboratorPermission(
      'nonexistent-owner-xyz',
      'nonexistent-repo-xyz',
      'nonexistent-user-xyz',
      cache,
    ),
    { permission: 'admin', roleName: 'admin' },
  );
});

test('collaboratorPermission normalizes the login before the cache lookup', () => {
  const cache = seededCache('o', 'r', 'someuser', 'write', 'write');
  assert.deepEqual(collaboratorPermission('o', 'r', ' SomeUser ', cache), {
    permission: 'write',
    roleName: 'write',
  });
});

test('isAuthorizedForcedHandoffActor rejects an empty or blank login without touching the cache', () => {
  const cache: CollaboratorPermissionCache = new Map();
  assert.equal(
    isAuthorizedForcedHandoffActor(
      'o',
      'r',
      '',
      'owners-and-maintainers-only',
      cache,
    ),
    false,
  );
  assert.equal(
    isAuthorizedForcedHandoffActor(
      'o',
      'r',
      '   ',
      'owners-and-maintainers-only',
      cache,
    ),
    false,
  );
  assert.equal(cache.size, 0);
});

// owners-and-maintainers-only: role_name admin/maintain, or legacy
// permission admin as a backstop. write/read/none are all rejected, and
// maintain specifically requires role_name (the legacy permission field
// collapses maintain to write).
const DEFAULT_POLICY_CASES: [string, string, boolean][] = [
  ['admin', 'admin', true],
  ['write', 'maintain', true],
  ['admin', '', true],
  ['write', 'write', false],
  ['read', 'read', false],
  ['none', 'none', false],
  ['write', '', false],
];

for (const [permission, roleName, expected] of DEFAULT_POLICY_CASES) {
  test(`isAuthorizedForcedHandoffActor under owners-and-maintainers-only: permission=${permission} roleName=${roleName || '(empty)'} -> ${expected}`, () => {
    const cache = seededCache('o', 'r', 'actor', permission, roleName);
    assert.equal(
      isAuthorizedForcedHandoffActor(
        'o',
        'r',
        'actor',
        'owners-and-maintainers-only',
        cache,
      ),
      expected,
    );
  });
}

// all-write-permission-actors: everything above, plus role_name write or
// legacy permission write (so a custom write-base role_name still
// satisfies the loose policy via the legacy field).
const LOOSE_POLICY_CASES: [string, string, boolean][] = [
  ['admin', 'admin', true],
  ['write', 'maintain', true],
  ['write', 'write', true],
  ['write', 'custom-role', true],
  ['read', 'read', false],
  ['none', 'none', false],
];

for (const [permission, roleName, expected] of LOOSE_POLICY_CASES) {
  test(`isAuthorizedForcedHandoffActor under all-write-permission-actors: permission=${permission} roleName=${roleName} -> ${expected}`, () => {
    const cache = seededCache('o', 'r', 'actor', permission, roleName);
    assert.equal(
      isAuthorizedForcedHandoffActor(
        'o',
        'r',
        'actor',
        'all-write-permission-actors',
        cache,
      ),
      expected,
    );
  });
}
