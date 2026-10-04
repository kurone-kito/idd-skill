import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AUDIT_CLI = join(REPO_ROOT, 'scripts/lint-source-contracts.mjs');

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-source-contracts-'));
  const root = join(tempRoot, 'repository');
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO_ROOT, 'src/scripts'), join(root, 'src/scripts'), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), {
    recursive: true,
  });
  return {
    root,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function runAudit(root: string) {
  return spawnSync(process.execPath, [AUDIT_CLI, '--root', root], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function snapshot(root: string): string {
  const entries: string[] = [];
  visit(root);
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const name = relative(root, path).split('\\').join('/');
        const content = readFileSync(path);
        entries.push(
          `${name}\0${createHash('sha256').update(content).digest('hex')}\0${content.length}`,
        );
      }
    }
  }
}

test('bare-Node audit passes a positive scratch fixture without GitHub calls or writes', () => {
  const fixture = makeFixture();
  const sentinel = join(fixture.root, '..', 'unexpected-gh-call.log');
  const restoreGh = stubExecutable(
    'gh',
    'require("node:fs").appendFileSync(process.env.IDD_GH_SENTINEL, process.argv.slice(2).join(" ") + "\\n"); process.exit(19);',
  );
  const before = snapshot(fixture.root);
  try {
    const result = spawnSync(
      process.execPath,
      [AUDIT_CLI, '--root', fixture.root],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, IDD_GH_SENTINEL: sentinel },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all source contracts passed/);
    assert.equal(existsSync(sentinel), false, 'the audit must not invoke gh');
    assert.equal(snapshot(fixture.root), before, 'the audit must be read-only');
  } finally {
    restoreGh();
    fixture.cleanup();
    rmSync(sentinel, { force: true });
  }
});

test('entry-order violation fails from the CLI with a rule ID and relative path', () => {
  const fixture = makeFixture();
  const sourcePath = join(fixture.root, 'src/scripts/contract-entry.mts');
  try {
    writeFileSync(
      sourcePath,
      [
        "import './node-runtime-guard.mts';",
        'if (import.meta.main) {',
        '  await run(LATE);',
        '}',
        'const LATE = 1;',
        '',
      ].join('\n'),
    );
    const before = snapshot(fixture.root);
    const result = runAudit(fixture.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /CLI-ENTRY-ORDER src\/scripts\/contract-entry\.mts:/,
    );
    assert.equal(snapshot(fixture.root), before, 'the audit must be read-only');
  } finally {
    fixture.cleanup();
  }
});

test('Discover mutator violation fails from the CLI with a rule ID and relative path', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.root, 'src/scripts/contract-mutator.mts'),
      'client.closeWorkItem();\n',
    );
    const before = snapshot(fixture.root);
    const result = runAudit(fixture.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /DISCOVER-HINT-MUTATOR-INVALIDATION src\/scripts\/contract-mutator\.mts:/,
    );
    assert.equal(snapshot(fixture.root), before, 'the audit must be read-only');
  } finally {
    fixture.cleanup();
  }
});

test('near-miss flag violation fails from the CLI with a rule ID and relative path', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.root, 'scripts/contract-flags.mjs'),
      "export const flags = { '--pr-number': true };\n",
    );
    const before = snapshot(fixture.root);
    const result = runAudit(fixture.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /CLI-FLAG-NEAR-MISS scripts\/contract-flags\.mjs:/,
    );
    assert.equal(snapshot(fixture.root), before, 'the audit must be read-only');
  } finally {
    fixture.cleanup();
  }
});
