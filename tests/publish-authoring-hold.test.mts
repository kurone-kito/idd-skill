import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildLintArgs,
  checkReviewResult,
  generatePublicationIds,
  injectPublicationLine,
  parseJournalReference,
  requestsChildShape,
  resolvePublishLabels,
} from '../src/scripts/publish-authoring-hold.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/publish-authoring-hold.mjs');
const TITLE = 'Add a sample orphan feature';

function draftBody(bucket = 'ready'): string {
  return [
    ...(bucket === 'ready'
      ? []
      : [`<!-- idd-skill-authoring-bucket: ${bucket} -->`, '']),
    '## Background',
    '',
    'Some background text.',
    '',
    '## Proposed change',
    '',
    'Do the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/example.test.mts` passes with the new case covered',
    '',
    '---',
    '',
    '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;',
    'below the configured floor is human-oriented._',
    '',
    '<!-- idd-skill-autopilot-suitability: 4 -->',
    '',
    '_Effort: M -- author-estimated size; a soft autopilot',
    'selection tie-breaker only._',
    '',
    '<!-- idd-skill-effort: M -->',
  ].join('\n');
}

/**
 * A fake `gh` that answers the read-only calls the command makes. Every call
 * is appended to `log.jsonl`, and any call it does not expect fails, so a
 * write the narrowed command must not make fails the run.
 */
const GH_STUB = String.raw`
const fs = require('node:fs');
const dir = process.env.PUBLISH_STUB_DIR;
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ args }) + '\n');
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
const out = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
if (args[0] !== 'api' || args.includes('--method') || args.includes('-X')) {
  fail('unexpected gh call: ' + args.join(' '));
}
const path = args.find((arg) => arg === 'user' || arg.startsWith('repos/'));
if (path === 'user') out('kurone-kito\n');
if (path === 'repos/o/r/issues/2674') {
  out({ number: 2674, title: 'journal', state: 'closed', body: 'journal', labels: [] });
}
const label = /^repos\/o\/r\/labels\/(.+)$/.exec(path || '');
if (label) {
  if (state.labels.includes(decodeURIComponent(label[1]))) out({ name: decodeURIComponent(label[1]) });
  fail('gh: Not Found (HTTP 404)');
}
fail('unexpected gh api call: ' + args.join(' '));
`;

interface Fixture {
  dir: string;
  run: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  log: () => { args: string[] }[];
  restore: () => void;
}

function setup(
  options: { journal?: string | null; labels?: string[] } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'idd-publish-authoring-hold-test-'));
  const work = join(dir, 'work');
  mkdirSync(join(work, '.github/idd'), { recursive: true });
  const config: Record<string, unknown> = { markerPrefix: 'idd-skill' };
  if (options.journal !== null) {
    config.issueAuthoring = { journalIssue: options.journal ?? 'o/r#2674' };
  }
  writeFileSync(
    join(work, '.github/idd/config.json'),
    JSON.stringify(config, null, 2),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ labels: options.labels ?? ['status:authoring'] }),
  );
  writeFileSync(join(dir, 'log.jsonl'), '');
  const restore = stubExecutable('gh', GH_STUB);
  const home = join(dir, 'home');
  mkdirSync(home);
  return {
    dir,
    run: (args) => {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: work,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PUBLISH_STUB_DIR: dir,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_STATE_HOME: join(home, '.state'),
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    log: () =>
      readFileSync(join(dir, 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    restore: () => {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function files(
  fixture: Fixture,
  bucket = 'ready',
  review: unknown = { completed: true },
): string[] {
  const body = join(fixture.dir, 'body.md');
  const result = join(fixture.dir, 'review.json');
  writeFileSync(body, draftBody(bucket));
  writeFileSync(result, JSON.stringify(review));
  return [
    '--title',
    TITLE,
    '--body-file',
    body,
    '--review-result',
    result,
    '--owner',
    'o',
    '--repo',
    'r',
    '--marker-prefix',
    'idd-skill',
    ...(bucket === 'ready' ? [] : ['--bucket', bucket]),
  ];
}

test('ids: orphan anchor equals target, and the line round-trips', () => {
  let counter = 0;
  const ids = generatePublicationIds(() => {
    counter += 1;
    return `u${counter}`;
  });
  assert.equal(ids.anchor, ids.target);
  assert.equal(ids.target, 'target-u1');
  const body = injectPublicationLine('## Background\n', 'idd-skill', ids);
  assert.equal(
    body.split('\n')[0],
    '<!-- idd-skill-authoring-publication: target=target-u1; anchor=target-u1; set=set-u2; session=session-u3; token=token-u4 -->',
  );
  assert.throws(() => injectPublicationLine(body, 'idd-skill', ids));
});

test('review result: only a completed review with no open finding passes', () => {
  assert.equal(checkReviewResult('{"completed": true}'), null);
  assert.equal(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "fixed"}, {"disposition": "rejected"}]}',
    ),
    null,
  );
  assert.notEqual(checkReviewResult('{"completed": false}'), null);
  assert.notEqual(checkReviewResult('{}'), null);
  assert.notEqual(checkReviewResult('not json'), null);
  assert.notEqual(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "deferred"}]}',
    ),
    null,
  );
});

test('lint args: a ready publish passes no bucket or label, a needs-decision publish passes both labels', () => {
  const common = {
    shape: 'orphan',
    title: 't',
    bodyFile: 'b.md',
    markerPrefix: 'idd-skill',
    currentRepo: 'o/r',
  };
  const ready = buildLintArgs({
    ...common,
    bucket: 'ready',
    labels: resolvePublishLabels({}, 'ready'),
  });
  assert.ok(ready.includes('--new-issue'));
  assert.ok(!ready.includes('--expect-bucket'));
  assert.ok(!ready.includes('--label'));
  const decision = buildLintArgs({
    ...common,
    bucket: 'needs-decision',
    labels: resolvePublishLabels(
      { labels: { needsDecisionLabelName: 'decide' } },
      'needs-decision',
    ),
  });
  assert.deepEqual(decision.slice(-6), [
    '--expect-bucket',
    'needs-decision',
    '--label',
    'status:authoring',
    '--label',
    'decide',
  ]);
});

test('journal reference and child shape parsing', () => {
  assert.deepEqual(parseJournalReference('o/r#2674'), {
    owner: 'o',
    repo: 'r',
    number: 2674,
    ref: 'o/r#2674',
  });
  assert.equal(parseJournalReference(undefined), null);
  assert.equal(parseJournalReference('o/r#0'), null);
  assert.equal(requestsChildShape(['--shape', 'child']), true);
  assert.equal(requestsChildShape(['--shape=child']), true);
  assert.equal(requestsChildShape(['--shape', 'orphan']), false);
});

test('CLI: --shape child exits 2 and makes no gh call, even with a bad flag', () => {
  const fixture = setup();
  try {
    const result = fixture.run(['--shape', 'child', '--bogus']);
    assert.equal(result.status, 2);
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: --apply is refused with exit 2 before any gh call', () => {
  const fixture = setup();
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--apply is not yet supported/);
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a missing or incomplete review result exits non-zero before any gh call', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const without = args.filter(
      (_, index) =>
        args[index] !== '--review-result' &&
        args[index - 1] !== '--review-result',
    );
    assert.equal(fixture.run(without).status, 2);
    assert.equal(
      fixture.run(files(fixture, 'ready', { completed: false })).status,
      1,
    );
    assert.equal(
      fixture.run(
        files(fixture, 'ready', {
          completed: true,
          findings: [{ disposition: 'deferred' }],
        }),
      ).status,
      1,
    );
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an unset journal exits 2 with the blocked-by-human outcome and no gh call', () => {
  const fixture = setup({ journal: null });
  try {
    const result = fixture.run(files(fixture));
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).outcome, 'blocked-by-human');
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: the plan lints the injected body with --new-issue and lists a missing label', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run(files(fixture));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.ok(lint.detail.args.includes('--new-issue'));
    assert.ok(!lint.detail.args.includes('--expect-bucket'));
    assert.ok(!lint.detail.args.includes('--label'));
    const labels = report.steps.find(
      (s: { step: string }) => s.step === 'labels',
    );
    assert.deepEqual(labels.detail.create, ['status:authoring']);
    const pending = report.steps.find(
      (s: { step: string }) => s.step === 'journal-pending',
    );
    assert.match(
      pending.detail.record,
      /issue=none; actor=kurone-kito; state=pending/,
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a needs-decision plan passes the bucket and both labels to the linter', () => {
  const fixture = setup();
  try {
    const result = fixture.run(files(fixture, 'needs-decision'));
    const report = JSON.parse(result.stdout);
    const lint =
      report.lint ??
      report.steps.find((s: { step: string }) => s.step === 'lint').detail;
    assert.deepEqual(lint.args.slice(-6), [
      '--expect-bucket',
      'needs-decision',
      '--label',
      'status:authoring',
      '--label',
      'status:needs-decision',
    ]);
    assert.equal(result.status, 0, result.stdout);
  } finally {
    fixture.restore();
  }
});

test('CLI: an explicit repository outside this checkout needs --marker-prefix', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const index = args.indexOf('--marker-prefix');
    args.splice(index, 2);
    const result = fixture.run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--marker-prefix is required/);
  } finally {
    fixture.restore();
  }
});
