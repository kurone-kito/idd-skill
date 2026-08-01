import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  type CollaboratorPermissionCache,
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
  readForcedHandoffPolicy,
  resolveTrustedCollaboratorMarkerLogins,
} from '../src/scripts/collaborator-permission.mts';

// collaboratorPermission and isAuthorizedForcedHandoffActor's UNCACHED path
// shells out to `gh api repos/{owner}/{repo}/collaborators/{login}/permission`.
// Per #1212's scope note ("do NOT mock `gh` subprocess calls"), that path
// stays untested here — it is exercised instead via the cache-seeding seam
// below, which is the pure surface these functions actually expose.

const configFileDirs: string[] = [];

after(() => {
  for (const dir of configFileDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'forced-handoff-policy-'));
  configFileDirs.push(dir);
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
  // Isolates roleName === 'admin' as the sole cause: permission is 'write'
  // here, so this only passes if the roleName clause is actually checked.
  ['write', 'admin', true],
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
  // Isolates permission === 'admin' as the sole cause: roleName matches
  // none of the roleName clauses, so this only passes if the legacy
  // permission field is actually checked.
  ['admin', 'custom-role', true],
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

// --- resolveTrustedCollaboratorMarkerLogins (#1693) ---------------------
//
// #1693: this is the single canonical "marker-authors-first" filter
// force-handoff.mts and external-check-waiver.mts now call instead of
// each hand-rolling a copy that permission-checked every unique comment
// author regardless of whether they ever posted anything marker-shaped.
// Coverage stays on the cache-seeding seam (#1212: no `gh` subprocess
// mocking), which also proves a non-marker-shaped author's comment never
// even reaches a permission lookup: seeding the cache for a login that is
// never queried would go unnoticed, but seeding it and asserting the
// login is still excluded (cases below) proves the filter, not the cache.

const ADVISORY_WAIT_SHA = 'a'.repeat(40);
const MARKER_BODY = `advisory-wait: some-agent ${ADVISORY_WAIT_SHA} 2026-05-10T00:00:00Z`;

test('resolveTrustedCollaboratorMarkerLogins excludes a write+ author whose comment is not marker-shaped', () => {
  const cache = seededCache('o', 'r', 'random-write-actor', 'write', 'write');
  const trusted = resolveTrustedCollaboratorMarkerLogins(
    'o',
    'r',
    [
      {
        body: 'just an ordinary comment',
        user: { login: 'random-write-actor' },
      },
    ],
    { cache },
  );
  assert.deepEqual(trusted, []);
});

test('resolveTrustedCollaboratorMarkerLogins includes a write+ author whose comment is marker-shaped', () => {
  const cache = seededCache('o', 'r', 'marker-author', 'write', 'write');
  const trusted = resolveTrustedCollaboratorMarkerLogins(
    'o',
    'r',
    [{ body: MARKER_BODY, author: { login: 'marker-author' } }],
    { cache },
  );
  assert.deepEqual(trusted, ['marker-author']);
});

test('resolveTrustedCollaboratorMarkerLogins still excludes a marker-shaped author without write+ permission', () => {
  const cache = seededCache('o', 'r', 'read-only-actor', 'read', 'read');
  const trusted = resolveTrustedCollaboratorMarkerLogins(
    'o',
    'r',
    [{ body: MARKER_BODY, user: { login: 'read-only-actor' } }],
    { cache },
  );
  assert.deepEqual(trusted, []);
});

test('resolveTrustedCollaboratorMarkerLogins dedupes repeated marker-shaped authors to one permission lookup', () => {
  const cache = seededCache('o', 'r', 'repeat-author', 'admin', 'admin');
  const trusted = resolveTrustedCollaboratorMarkerLogins(
    'o',
    'r',
    [
      { body: MARKER_BODY, user: { login: 'repeat-author' } },
      { body: MARKER_BODY, user: { login: 'Repeat-Author' } },
    ],
    { cache },
  );
  assert.deepEqual(trusted, ['repeat-author']);
});

test('resolveTrustedCollaboratorMarkerLogins accepts a custom isMarkerShaped predicate', () => {
  const cache = seededCache('o', 'r', 'advisory-actor', 'write', 'write');
  const trusted = resolveTrustedCollaboratorMarkerLogins(
    'o',
    'r',
    [
      { body: MARKER_BODY, user: { login: 'advisory-actor' } },
      // A different recognized operational marker (claimed-by-shaped) that
      // the narrower custom predicate below must reject even though the
      // default operationalMarkerPrefix predicate would accept it.
      {
        body: '<!-- claimed-by: agent claim-1 supersedes: none 2026-05-10T00:00:00Z branch: issue/1 -->',
        user: { login: 'claim-actor' },
      },
    ],
    {
      cache,
      isMarkerShaped: (body) => body.startsWith('advisory-wait:'),
    },
  );
  assert.deepEqual(trusted, ['advisory-actor']);
});
