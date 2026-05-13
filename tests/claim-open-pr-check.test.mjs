import assert from 'assert';
import test from 'node:test';
import { checkConflictingPRs } from '../scripts/claim-open-pr-check.mjs';

test('checkConflictingPRs: happy path - no matching PRs', async () => {
  const mockPRs = [
    {
      number: 100,
      title: 'Unrelated PR',
      body: 'This PR does something else',
      headRefName: 'feature/unrelated',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/100',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 0, 'Should find no conflicting PRs');
});

test('checkConflictingPRs: detects closing keyword (Closes)', async () => {
  const mockPRs = [
    {
      number: 101,
      title: 'Fix issue #42',
      body: 'This PR Closes #42 with the fix',
      headRefName: 'fix/issue-42',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/101',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1, 'Should find one conflicting PR');
  assert.strictEqual(result[0].number, 101);
  assert(result[0].reasons.some((r) => r.includes('closing-keyword')));
});

test('checkConflictingPRs: detects closing keyword (Fixes)', async () => {
  const mockPRs = [
    {
      number: 102,
      title: 'Fix bug',
      body: 'Fixes #42 by patching the code',
      headRefName: 'bugfix/issue',
      baseRefName: 'main',
      author: { login: 'user2' },
      url: 'https://github.com/owner/repo/pull/102',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('closing-keyword')));
});

test('checkConflictingPRs: detects reference keyword (Refs)', async () => {
  const mockPRs = [
    {
      number: 103,
      title: 'Enhancement',
      body: 'Refs #42 for related context',
      headRefName: 'enhancement/feature',
      baseRefName: 'main',
      author: { login: 'user3' },
      url: 'https://github.com/owner/repo/pull/103',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('ref-keyword')));
});

test('checkConflictingPRs: direct reference with ref keyword', async () => {
  const mockPRs = [
    {
      number: 104,
      title: 'Related work',
      body: 'This is related to #42 but not closing it',
      headRefName: 'related/work',
      baseRefName: 'main',
      author: { login: 'user4' },
      url: 'https://github.com/owner/repo/pull/104',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('ref-keyword')));
});

test('checkConflictingPRs: handles multiple PRs, returns all conflicts', async () => {
  const mockPRs = [
    {
      number: 201,
      title: 'First fix',
      body: 'Closes #42',
      headRefName: 'fix/first',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/201',
    },
    {
      number: 202,
      title: 'Unrelated',
      body: 'No reference here',
      headRefName: 'feature/other',
      baseRefName: 'main',
      author: { login: 'user2' },
      url: 'https://github.com/owner/repo/pull/202',
    },
    {
      number: 203,
      title: 'Another ref',
      body: 'Fixes #42 with additional context',
      headRefName: 'fix/second',
      baseRefName: 'main',
      author: { login: 'user3' },
      url: 'https://github.com/owner/repo/pull/203',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 2, 'Should find 2 conflicting PRs');
  assert(result.some((pr) => pr.number === 201));
  assert(result.some((pr) => pr.number === 203));
  assert(!result.some((pr) => pr.number === 202));
});

test('checkConflictingPRs: pagination across multiple pages', async () => {
  // Create mock with 35 PRs to test pagination (more than 30 per page)
  const prs = [];
  for (let i = 0; i < 35; i++) {
    prs.push({
      number: 300 + i,
      title: `PR ${i}`,
      body: i === 32 ? 'Closes #42' : `No reference`,
      headRefName: `branch/pr${i}`,
      baseRefName: 'main',
      author: { login: 'user' },
      url: `https://github.com/owner/repo/pull/${300 + i}`,
    });
  }

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs: prs,
  });

  // Should find the PR with "Closes #42" even if on second page
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].number, 332);
});

test('checkConflictingPRs: ignores wrong issue numbers', async () => {
  const mockPRs = [
    {
      number: 400,
      title: 'Wrong issue',
      body: 'Closes #41 (not #42)',
      headRefName: 'fix/wrong',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/400',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 0);
});

test('checkConflictingPRs: requires owner, repo, issueNumber', async () => {
  // Missing issueNumber
  await assert.rejects(
    async () => {
      await checkConflictingPRs({
        owner: 'owner',
        repo: 'repo',
      });
    },
    /owner, repo, and issueNumber are required/,
  );

  // Missing repo
  await assert.rejects(
    async () => {
      await checkConflictingPRs({
        owner: 'owner',
        issueNumber: 42,
      });
    },
    /owner, repo, and issueNumber are required/,
  );

  // Missing owner
  await assert.rejects(
    async () => {
      await checkConflictingPRs({
        repo: 'repo',
        issueNumber: 42,
      });
    },
    /owner, repo, and issueNumber are required/,
  );
});

test('checkConflictingPRs: returns correct metadata structure', async () => {
  const mockPRs = [
    {
      number: 500,
      title: 'Test PR',
      body: 'Closes #42',
      headRefName: 'feature/test',
      baseRefName: 'develop',
      author: { login: 'testuser' },
      url: 'https://github.com/owner/repo/pull/500',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  const pr = result[0];
  assert.strictEqual(pr.number, 500);
  assert.strictEqual(pr.title, 'Test PR');
  assert.strictEqual(pr.head_branch, 'feature/test');
  assert.strictEqual(pr.base_branch, 'develop');
  assert.strictEqual(pr.author, 'testuser');
  assert.strictEqual(pr.html_url, 'https://github.com/owner/repo/pull/500');
  assert.strictEqual(pr.state, 'open');
  assert(Array.isArray(pr.reasons));
});

test('checkConflictingPRs: handles author with name fallback', async () => {
  const mockPRs = [
    {
      number: 501,
      title: 'Test PR',
      body: 'Closes #42',
      headRefName: 'feature/test',
      baseRefName: 'develop',
      author: { name: 'Test User' },
      url: 'https://github.com/owner/repo/pull/501',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].author, 'Test User');
});

test('checkConflictingPRs: case-insensitive keyword matching', async () => {
  const mockPRs = [
    {
      number: 600,
      title: 'Test PR',
      body: 'CLOSES #42',
      headRefName: 'feature/test',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/600',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('closing-keyword')));
});

test('checkConflictingPRs: detects Resolve keyword', async () => {
  const mockPRs = [
    {
      number: 700,
      title: 'Resolve issue',
      body: 'This PR resolves #42',
      headRefName: 'resolve/issue',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/700',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('closing-keyword')));
});

test('checkConflictingPRs: detects Related to keyword', async () => {
  const mockPRs = [
    {
      number: 800,
      title: 'Related work',
      body: 'Related to #42 in some way',
      headRefName: 'related/feature',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/800',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert(result[0].reasons.some((r) => r.includes('ref-keyword')));
});

test('checkConflictingPRs: handles PR with null body', async () => {
  const mockPRs = [
    {
      number: 900,
      title: 'No body PR',
      body: null,
      headRefName: 'feature/no-body',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/900',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 0);
});

test('checkConflictingPRs: handles PR with empty body', async () => {
  const mockPRs = [
    {
      number: 1000,
      title: 'Empty body PR',
      body: '',
      headRefName: 'feature/empty-body',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/1000',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 0);
});

test('checkConflictingPRs: records multiple reasons for same PR', async () => {
  const mockPRs = [
    {
      number: 1100,
      title: 'Complex PR',
      body: 'Closes #42 and also Fixes #42',
      headRefName: 'fix/complex',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/1100',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  // Should record the first keyword found (Closes)
  assert(result[0].reasons.some((r) => r.includes('closing-keyword')));
});

test('checkConflictingPRs: distinguishes between issue numbers', async () => {
  const mockPRs = [
    {
      number: 1200,
      title: 'PR mentioning multiple issues',
      body: 'Fixes #41, Closes #42, and Resolves #43',
      headRefName: 'fix/multiple',
      baseRefName: 'main',
      author: { login: 'user1' },
      url: 'https://github.com/owner/repo/pull/1200',
    },
  ];

  const result = await checkConflictingPRs({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    mockPRs,
  });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].number, 1200);
});
