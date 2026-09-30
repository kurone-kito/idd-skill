import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeGhRequest } from '../src/scripts/github-api-request-class.mts';

test('describeGhRequest treats a plain gh api GET as a core read', () => {
  assert.deepEqual(describeGhRequest(['api', 'repos/o/r/issues/1']), {
    classification: 'read',
    resource: 'core',
  });
  assert.deepEqual(
    describeGhRequest(['api', '/repos/o/r/issues?state=open', '--paginate']),
    { classification: 'read', resource: 'core' },
  );
});

test('describeGhRequest keeps an explicit GET a read even with fields', () => {
  for (const args of [
    ['api', 'repos/o/r/issues', '--method', 'GET', '-f', 'state=open'],
    ['api', 'repos/o/r/issues', '-X', 'GET', '-F', 'per_page=100'],
    ['api', 'repos/o/r/issues', '--method=GET', '--field', 'a=b'],
    ['api', 'repos/o/r/issues', '-X=GET', '-f', 'a=b'],
    ['api', 'repos/o/r/issues', '--method=get'],
    ['api', 'repos/o/r/issues', '--method', 'HEAD'],
    ['api', 'repos/o/r/issues', '--paginate', '--jq', '.[]', '-i'],
  ]) {
    assert.equal(
      describeGhRequest(args).classification,
      'read',
      args.join(' '),
    );
  }
});

test('describeGhRequest classifies fields or --input without a method as a write', () => {
  for (const args of [
    ['api', 'repos/o/r/issues/1/comments', '-f', 'body=x'],
    ['api', 'repos/o/r/issues/1/comments', '--input', '-'],
    ['api', 'repos/o/r/issues/1/comments', '--raw-field', 'body=x'],
    ['api', 'repos/o/r/issues/1/comments', '-fa=b'],
  ]) {
    assert.equal(
      describeGhRequest(args).classification,
      'write',
      args.join(' '),
    );
  }
});

test('describeGhRequest classifies every explicit non-GET method as a write', () => {
  for (const method of ['POST', 'PATCH', 'put', 'DELETE']) {
    for (const args of [
      ['api', 'repos/o/r/issues/comments/1', '--method', method],
      ['api', 'repos/o/r/issues/comments/1', '-X', method, '--input', '-'],
      ['api', 'repos/o/r/issues/comments/1', `--method=${method}`],
      ['api', 'repos/o/r/issues/comments/1', `-X${method}`],
      ['api', 'repos/o/r/issues/comments/1', `-X=${method}`],
      // The method and body options may follow the path or lead it.
      ['api', '-X', method, 'repos/o/r/issues/comments/1'],
    ]) {
      assert.equal(
        describeGhRequest(args).classification,
        'write',
        args.join(' '),
      );
    }
  }
});

test('describeGhRequest reads a GraphQL query and writes a mutation', () => {
  const read = describeGhRequest([
    'api',
    'graphql',
    '-f',
    'query=query($n:Int!){ repository(owner:"o",name:"r"){ issue(number:$n){ id } } }',
    '-F',
    'n=1',
  ]);
  assert.deepEqual(read, { classification: 'read', resource: 'graphql' });
  const shorthand = describeGhRequest([
    'api',
    'graphql',
    '-f',
    'query={ viewer { login } }',
  ]);
  assert.equal(shorthand.classification, 'read');
  for (const query of [
    'mutation($id:ID!){ minimizeComment(input:{subjectId:$id}){ clientMutationId } }',
    '  Mutation { x }',
    '# mutation only in a comment\nquery { viewer { login } }',
  ]) {
    assert.deepEqual(
      describeGhRequest(['api', 'graphql', '-f', `query=${query}`]),
      { classification: 'write', resource: 'graphql' },
      query,
    );
  }
});

test('describeGhRequest does not guess a GraphQL document it cannot read', () => {
  for (const args of [
    ['api', 'graphql'],
    ['api', 'graphql', '-f', 'query=@query.graphql'],
    ['api', 'graphql', '--input', '-'],
    ['api', 'graphql', '-F', 'n=1'],
  ]) {
    assert.equal(
      describeGhRequest(args).classification,
      'unclassified',
      args.join(' '),
    );
    assert.equal(describeGhRequest(args).resource, 'graphql');
  }
});

test('describeGhRequest names the primary-limit resource from the endpoint', () => {
  assert.equal(
    describeGhRequest(['api', 'search/issues?q=x']).resource,
    'search',
  );
  assert.equal(
    describeGhRequest(['api', 'search/code?q=x']).resource,
    'code_search',
  );
  assert.equal(describeGhRequest(['api', 'repos/o/r']).resource, 'core');
  assert.equal(
    describeGhRequest(['api', 'graphql', '-f', 'query={a}']).resource,
    'graphql',
  );
});

test('describeGhRequest carries a --hostname, skipping option values when finding the endpoint', () => {
  assert.deepEqual(
    describeGhRequest([
      'api',
      '--hostname',
      'GHE.Example.com',
      '-H',
      'Accept: application/json',
      '--jq',
      '.login',
      'user',
    ]),
    { classification: 'read', resource: 'core', host: 'ghe.example.com' },
  );
  assert.equal(
    describeGhRequest(['api', 'user', '--hostname=ghe.example.com']).host,
    'ghe.example.com',
  );
});

test('describeGhRequest reads only an allowlisted gh subcommand and leaves it resource-less', () => {
  for (const args of [
    ['pr', 'view', '1', '--json', 'state'],
    ['issue', 'list', '--repo', 'o/r'],
    ['repo', 'view'],
    ['search', 'issues', 'x'],
    ['run', 'list'],
  ]) {
    assert.deepEqual(
      describeGhRequest(args),
      { classification: 'read' },
      args.join(' '),
    );
  }
  for (const args of [
    ['pr', 'merge', '1'],
    ['issue', 'comment', '1'],
    ['issue', 'edit', '1'],
    ['pr', 'create'],
    ['auth', 'token'],
    ['--version'],
    [],
  ]) {
    assert.deepEqual(
      describeGhRequest(args),
      { classification: 'unclassified' },
      args.join(' '),
    );
  }
});

test('describeGhRequest leaves unverified shapes unclassified instead of reading them', () => {
  for (const args of [
    // A body on a GET, an option this parser does not know, and no endpoint.
    ['api', 'repos/o/r/issues', '--method', 'GET', '--input', '-'],
    ['api', 'repos/o/r/issues', '--future-flag'],
    ['api', 'repos/o/r/issues', '-Z'],
    ['api'],
    ['api', ''],
    ['api', 'graphql', '-f', 'query={ a }', '--future-flag'],
    ['api', 'graphql', '-f', 'query=subscription { a }'],
  ]) {
    assert.equal(
      describeGhRequest(args).classification,
      'unclassified',
      args.join(' '),
    );
  }
});

test('describeGhRequest never throws on a hostile or truncated argv', () => {
  for (const args of [
    ['api', '--method'],
    ['api', '-X'],
    ['api', '--', 'x'],
    ['api', 'user', '-f'],
    ['api', 'repos/o/r', '--method', '???'],
    ['api', ''],
  ]) {
    assert.doesNotThrow(() => describeGhRequest(args), args.join(' '));
  }
  assert.equal(
    describeGhRequest(['api', 'repos/o/r', '--method', '???']).classification,
    'unclassified',
  );
});

test('describeGhRequest reads the host of a HOST/OWNER/REPO repo flag, never a bare OWNER/REPO', () => {
  for (const args of [
    ['issue', 'list', '-R', 'GHE.example.com/o/r'],
    ['issue', 'list', '--repo', 'ghe.example.com/o/r'],
    ['issue', 'list', '--repo=ghe.example.com/o/r'],
    ['pr', 'view', '1', '-R=ghe.example.com/o/r'],
  ]) {
    assert.deepEqual(
      describeGhRequest(args),
      { classification: 'read', host: 'ghe.example.com' },
      args.join(' '),
    );
  }
  assert.deepEqual(describeGhRequest(['issue', 'list', '-R', 'o/r']), {
    classification: 'read',
  });
  assert.deepEqual(
    describeGhRequest(['pr', 'merge', '1', '-R', 'h.example.com/o/r']),
    {
      classification: 'unclassified',
      host: 'h.example.com',
    },
  );
});

test('describeGhRequest reads the host of a URL-form repo flag', () => {
  assert.deepEqual(
    describeGhRequest(['issue', 'list', '-R', 'https://ghes.example.com/o/r']),
    { classification: 'read', host: 'ghes.example.com' },
  );
});

test('describeGhRequest scopes a full-URL api endpoint to the host gh authenticates against', () => {
  assert.deepEqual(
    describeGhRequest(['api', 'https://api.github.com/repos/o/r']),
    {
      classification: 'read',
      resource: 'core',
      host: 'github.com',
    },
  );
  assert.deepEqual(
    describeGhRequest([
      'api',
      'https://api.github.com/graphql',
      '-f',
      'query={ viewer { login } }',
    ]),
    { classification: 'read', resource: 'graphql', host: 'github.com' },
  );
  assert.deepEqual(
    describeGhRequest([
      'api',
      'https://ghes.example.com/api/v3/search/issues?q=x',
    ]),
    { classification: 'read', resource: 'search', host: 'ghes.example.com' },
  );
  assert.deepEqual(
    describeGhRequest(['api', 'https://api.acme.ghe.com/repos/o/r']),
    { classification: 'read', resource: 'core', host: 'acme.ghe.com' },
  );
  assert.equal(
    describeGhRequest([
      'api',
      'https://api.github.com/repos/o/r',
      '--hostname',
      'other.example.com',
    ]).host,
    'other.example.com',
    'an explicit --hostname wins',
  );
});
