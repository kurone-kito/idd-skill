import assert from 'node:assert/strict';
import test from 'node:test';

import { isSourceRepositoryOriginUrl } from '../src/scripts/audit-docs.mts';

test('source repository identity accepts HTTPS and SSH GitHub origins', () => {
  for (const originUrl of [
    'https://github.com/kurone-kito/idd-skill',
    'https://github.com/kurone-kito/idd-skill.git',
    'git@github.com:kurone-kito/idd-skill.git',
    'ssh://git@github.com/kurone-kito/idd-skill.git',
    'ssh://git@github.com:2222/kurone-kito/idd-skill.git',
  ]) {
    assert.equal(isSourceRepositoryOriginUrl(originUrl), true, originUrl);
  }
});

test('source repository identity rejects different GitHub repositories', () => {
  for (const originUrl of [
    'https://github.com/kurone-kito/another-repo.git',
    'ssh://git@github.com/another-owner/idd-skill.git',
    'git@github.com:kurone-kito/idd-skill-fork.git',
  ]) {
    assert.equal(isSourceRepositoryOriginUrl(originUrl), false, originUrl);
  }
});
