import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAYLOAD_PLACEHOLDER_FIELDS } from '../src/scripts/payload-placeholders.mts';
import {
  BEGIN_MARKER,
  type HarnessName,
  runUserGlobalInstall,
  runUserGlobalUninstall,
  type UserGlobalOptions,
} from '../src/scripts/user-global-install.mts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ALL: HarnessName[] = ['claude', 'codex', 'opencode'];
// Matches the #3822 placeholder scan in payload-placeholders.test.mts.
const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

interface Sandbox {
  root: string;
  home: string;
  claudeFile: string;
  agentsFile: string;
  opencodeFile: string;
  payloadRoot: string;
  options(harnesses?: HarnessName[], dryRun?: boolean): UserGlobalOptions;
  cleanup(): void;
}

/**
 * A throwaway home and XDG roots. The env is built from scratch rather than
 * inherited, so no CODEX_HOME or CLAUDE_CONFIG_DIR from the operator leaks in.
 */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'user-global-install-'));
  const home = join(root, 'home');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    claudeFile: join(home, '.claude', 'CLAUDE.md'),
    agentsFile: join(home, '.codex', 'AGENTS.md'),
    opencodeFile: join(root, 'config', 'opencode', 'opencode.json'),
    payloadRoot: join(root, 'data', 'idd-skill', 'current'),
    options: (harnesses = ALL, dryRun = false) => ({
      bundleRoot: REPO_ROOT,
      env,
      homedir: home,
      harnesses,
      dryRun,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every path and byte under `dir`, for before-and-after comparisons. */
function snapshot(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(dir)) return found;
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name);
      const stat = lstatSync(abs);
      if (stat.isDirectory()) {
        found.set(relative(dir, abs), 'dir');
        visit(abs);
      } else if (stat.isSymbolicLink()) {
        found.set(relative(dir, abs), `link:${readlinkSync(abs)}`);
      } else {
        found.set(relative(dir, abs), readFileSync(abs).toString('base64'));
      }
    }
  };
  visit(dir);
  return found;
}

/** The real home must never be written by a sandboxed test. */
function realHomeFingerprint(): string {
  const real = homedir();
  return [
    join(real, '.claude', 'CLAUDE.md'),
    join(real, '.codex', 'AGENTS.md'),
    join(real, '.config', 'opencode', 'opencode.json'),
    join(real, '.agents', 'skills'),
    join(real, '.local', 'share', 'idd-skill'),
  ]
    .map((path) => `${path}:${existsSync(path) ? 'present' : 'absent'}`)
    .join('\n');
}

function writeFixture(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

// Non-canonical on purpose: no trailing newline, CRLF, 4-space indent, and a
// key after `instructions`. A round trip through JSON.stringify would fail
// these, so a passing test here proves the splice keeps every byte.
const CLAUDE_BEFORE = '# mine\nno trailing newline';
const AGENTS_BEFORE = 'line1\r\nline2\r\n';
const OPENCODE_BEFORE =
  '{\n    "theme": "x",\n    "instructions": [\n        "foo.md"\n    ],\n    "zeta": 1}';

test('round-trips pre-existing content in all three entry files byte for byte (#3825)', () => {
  const before = realHomeFingerprint();
  const box = sandbox();
  try {
    writeFixture(box.claudeFile, CLAUDE_BEFORE);
    writeFixture(box.agentsFile, AGENTS_BEFORE);
    writeFixture(box.opencodeFile, OPENCODE_BEFORE);

    const installed = runUserGlobalInstall(box.options());
    assert.ok(installed.changed > 0);
    const claudeAfter = readFileSync(box.claudeFile, 'utf8');
    assert.ok(claudeAfter.startsWith(CLAUDE_BEFORE));
    const opencodeAfter = JSON.parse(
      readFileSync(box.opencodeFile, 'utf8'),
    ) as {
      theme: string;
      zeta: number;
      instructions: string[];
    };
    assert.equal(opencodeAfter.theme, 'x');
    assert.equal(opencodeAfter.zeta, 1);
    assert.ok(opencodeAfter.instructions.includes('foo.md'));
    assert.ok(
      opencodeAfter.instructions.includes(
        `${box.payloadRoot}/user-global/entry.md`,
      ),
    );

    runUserGlobalUninstall(box.options());
    assert.equal(readFileSync(box.claudeFile, 'utf8'), CLAUDE_BEFORE);
    assert.equal(readFileSync(box.agentsFile, 'utf8'), AGENTS_BEFORE);
    assert.equal(readFileSync(box.opencodeFile, 'utf8'), OPENCODE_BEFORE);
  } finally {
    box.cleanup();
  }
  assert.equal(realHomeFingerprint(), before);
});

test('a second install changes nothing (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const first = snapshot(box.root);
    const second = runUserGlobalInstall(box.options());
    assert.equal(second.changed, 0);
    assert.deepEqual(snapshot(box.root), first);
  } finally {
    box.cleanup();
  }
});

test('--dry-run writes nothing and reports the same plan as apply (#3825)', () => {
  const box = sandbox();
  try {
    writeFixture(box.claudeFile, CLAUDE_BEFORE);
    const before = snapshot(box.root);
    const dry = runUserGlobalInstall(box.options(ALL, true));
    assert.deepEqual(snapshot(box.root), before);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.changed > 0);

    const applied = runUserGlobalInstall(box.options(ALL, false));
    const relativeChanges = (changes: typeof dry.changes): string[] =>
      changes.map(
        (change) => `${change.action} ${relative(box.root, change.path)}`,
      );
    assert.deepEqual(
      relativeChanges(dry.changes),
      relativeChanges(applied.changes),
    );
  } finally {
    box.cleanup();
  }
});

test('the Codex managed block stays under 2 KiB (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options(['codex']));
    assert.ok(statSync(box.agentsFile).size < 2048);
  } finally {
    box.cleanup();
  }
});

test('every placeholder in the installed payload is mapped (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const names = new Set<string>();
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          visit(abs);
          continue;
        }
        for (const match of readFileSync(abs, 'utf8').matchAll(PLACEHOLDER)) {
          names.add(match[0].slice(2, -2));
        }
      }
    };
    visit(box.payloadRoot);
    assert.ok(names.size > 0, 'the scan must find at least one placeholder');
    for (const name of names) {
      assert.ok(
        Object.hasOwn(PAYLOAD_PLACEHOLDER_FIELDS, name),
        `{{${name}}} is not mapped in PAYLOAD_PLACEHOLDER_FIELDS`,
      );
    }
  } finally {
    box.cleanup();
  }
});

test('every relative link in a payload instruction resolves inside the payload (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const broken: string[] = [];
    const instructions = join(box.payloadRoot, '.github', 'instructions');
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          visit(abs);
          continue;
        }
        if (!name.endsWith('.md')) continue;
        for (const match of readFileSync(abs, 'utf8').matchAll(
          /\]\(([^)\s#]+)(?:#[^)]*)?\)/g,
        )) {
          const target = match[1] as string;
          if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
          if (!existsSync(resolve(dir, target))) {
            broken.push(`${relative(box.payloadRoot, abs)} -> ${target}`);
          }
        }
      }
    };
    visit(instructions);
    assert.deepEqual(broken, []);
  } finally {
    box.cleanup();
  }
});

test('refuses an unmarked skill directory without writing anything (#3825)', () => {
  const box = sandbox();
  try {
    const userSkill = join(box.home, '.claude', 'skills', 'issue-authoring');
    writeFixture(join(userSkill, 'mine.md'), 'user content');
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /without the \.idd-user-global marker/,
    );
    assert.equal(existsSync(box.payloadRoot), false);
    assert.equal(
      readFileSync(join(userSkill, 'mine.md'), 'utf8'),
      'user content',
    );
  } finally {
    box.cleanup();
  }
});

test('refuses a current link that points at a non-IDD directory (#3825)', () => {
  const box = sandbox();
  try {
    const other = join(box.root, 'data', 'other');
    mkdirSync(other, { recursive: true });
    mkdirSync(join(box.root, 'data', 'idd-skill'), { recursive: true });
    symlinkSync(other, box.payloadRoot);
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /not an IDD payload version/,
    );
    assert.equal(readlinkSync(box.payloadRoot), other);
  } finally {
    box.cleanup();
  }
});

test('refuses a half-written managed block and leaves the file as it was (#3825)', () => {
  const box = sandbox();
  try {
    const broken = `keep me\n${BEGIN_MARKER}\nno end marker\n`;
    writeFixture(box.claudeFile, broken);
    assert.throws(
      () => runUserGlobalInstall(box.options(['claude'])),
      /malformed managed block/,
    );
    assert.equal(readFileSync(box.claudeFile, 'utf8'), broken);
  } finally {
    box.cleanup();
  }
});

test('refuses a JSONC opencode.json and a non-array instructions value (#3825)', () => {
  const box = sandbox();
  try {
    const jsonc = '// a comment\n{"theme": "x"}\n';
    writeFixture(box.opencodeFile, jsonc);
    assert.throws(
      () => runUserGlobalInstall(box.options(['opencode'])),
      /JSONC is not supported/,
    );
    assert.equal(readFileSync(box.opencodeFile, 'utf8'), jsonc);

    writeFixture(box.opencodeFile, '{"instructions": "x"}');
    assert.throws(
      () => runUserGlobalInstall(box.options(['opencode'])),
      /non-array "instructions"/,
    );
  } finally {
    box.cleanup();
  }
});

test('uninstall keeps user text appended after the managed block (#3825)', () => {
  const box = sandbox();
  try {
    writeFixture(box.claudeFile, '# mine\n');
    runUserGlobalInstall(box.options(['claude']));
    writeFileSync(
      box.claudeFile,
      `${readFileSync(box.claudeFile, 'utf8')}user line\n`,
    );
    runUserGlobalUninstall(box.options(['claude']));
    assert.equal(readFileSync(box.claudeFile, 'utf8'), '# mine\nuser line\n');
  } finally {
    box.cleanup();
  }
});

test('a partial uninstall removes only the named harness wiring (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    runUserGlobalUninstall(box.options(['claude']));
    assert.equal(existsSync(box.claudeFile), false);
    assert.ok(readFileSync(box.agentsFile, 'utf8').includes(BEGIN_MARKER));
    assert.ok(readFileSync(box.opencodeFile, 'utf8').includes('entry.md'));
    assert.ok(existsSync(box.payloadRoot));

    runUserGlobalUninstall(box.options());
    assert.equal(existsSync(box.agentsFile), false);
    assert.equal(existsSync(box.opencodeFile), false);
    assert.equal(existsSync(box.payloadRoot), false);
    assert.equal(
      existsSync(
        join(box.root, 'data', 'idd-skill', 'user-global-receipt.json'),
      ),
      false,
    );
  } finally {
    box.cleanup();
  }
});

test('writes through a dotfile symlink and keeps the link (#3825)', () => {
  const box = sandbox();
  try {
    const dotfile = join(box.root, 'dotfiles', 'CLAUDE.md');
    writeFixture(dotfile, '# dotfile\n');
    mkdirSync(join(box.home, '.claude'), { recursive: true });
    symlinkSync(dotfile, box.claudeFile);
    runUserGlobalInstall(box.options(['claude']));
    assert.equal(lstatSync(box.claudeFile).isSymbolicLink(), true);
    assert.ok(readFileSync(dotfile, 'utf8').includes(BEGIN_MARKER));
    runUserGlobalUninstall(box.options(['claude']));
    assert.equal(lstatSync(box.claudeFile).isSymbolicLink(), true);
    assert.equal(readFileSync(dotfile, 'utf8'), '# dotfile\n');
  } finally {
    box.cleanup();
  }
});

test('a single-harness install wires only that harness and its shared skills (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options(['codex']));
    assert.ok(existsSync(box.agentsFile));
    assert.equal(existsSync(box.claudeFile), false);
    assert.equal(existsSync(join(box.home, '.claude', 'skills')), false);
    assert.ok(
      existsSync(
        join(box.home, '.agents', 'skills', 'issue-authoring', 'SKILL.md'),
      ),
    );
  } finally {
    box.cleanup();
  }
});

test('refuses an existing version directory that lacks the payload marker (#3825)', () => {
  const box = sandbox();
  try {
    const versionDir = join(box.root, 'data', 'idd-skill', '0.14.0');
    writeFixture(join(versionDir, 'mine.md'), 'user content');
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /exists without the \.idd-user-global-payload marker/,
    );
    assert.equal(
      readFileSync(join(versionDir, 'mine.md'), 'utf8'),
      'user content',
    );
  } finally {
    box.cleanup();
  }
});

test('refuses to write a skill through a symlink inside its directory (#3825)', () => {
  const box = sandbox();
  try {
    const skillDir = join(box.home, '.claude', 'skills', 'issue-authoring');
    writeFixture(join(skillDir, '.idd-user-global'), '{}\n');
    const outside = join(box.root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    symlinkSync(outside, join(skillDir, 'references', 'contract.md'));
    assert.throws(
      () => runUserGlobalInstall(box.options(['claude'])),
      /symlink inside a skill directory/,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    box.cleanup();
  }
});

test('uninstall without a receipt removes no payload and no skills (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    rmSync(join(box.root, 'data', 'idd-skill', 'user-global-receipt.json'));
    runUserGlobalUninstall(box.options());
    assert.ok(existsSync(box.payloadRoot));
    assert.ok(
      existsSync(
        join(box.home, '.claude', 'skills', 'issue-authoring', 'SKILL.md'),
      ),
    );
    assert.ok(readFileSync(box.claudeFile, 'utf8').includes(BEGIN_MARKER));
  } finally {
    box.cleanup();
  }
});

test('uninstall keeps a skill file the user edited after install (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const edited = join(
      box.home,
      '.claude',
      'skills',
      'issue-authoring',
      'SKILL.md',
    );
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nuser note\n`);
    runUserGlobalUninstall(box.options());
    assert.ok(readFileSync(edited, 'utf8').endsWith('user note\n'));
    // The unedited copies go; the empty references/ directory goes with them.
    assert.equal(
      existsSync(
        join(box.home, '.claude', 'skills', 'issue-authoring', 'references'),
      ),
      false,
    );
  } finally {
    box.cleanup();
  }
});

test('uninstall removes every payload version the receipt records (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const older = join(box.root, 'data', 'idd-skill', '0.13.0');
    writeFixture(join(older, '.idd-user-global-payload'), '{}\n');
    const receiptPath = join(
      box.root,
      'data',
      'idd-skill',
      'user-global-receipt.json',
    );
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      payloadVersions: string[];
    };
    receipt.payloadVersions.push('0.13.0');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    runUserGlobalUninstall(box.options());
    assert.equal(existsSync(older), false);
    assert.equal(existsSync(box.payloadRoot), false);
  } finally {
    box.cleanup();
  }
});

test('uninstall leaves a Markdown block that the receipt does not name (#3825)', () => {
  const box = sandbox();
  try {
    const block = `${BEGIN_MARKER}\n@/elsewhere/entry.md\n<!-- idd-skill:user-global end -->\n`;
    writeFixture(box.claudeFile, `# mine\n\n${block}`);
    runUserGlobalUninstall(box.options(['claude']));
    assert.equal(readFileSync(box.claudeFile, 'utf8'), `# mine\n\n${block}`);
  } finally {
    box.cleanup();
  }
});

test('re-install refuses to overwrite a skill file the user edited (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    const edited = join(
      box.home,
      '.claude',
      'skills',
      'issue-authoring',
      'SKILL.md',
    );
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nuser note\n`);
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /edited after install/,
    );
    assert.ok(readFileSync(edited, 'utf8').endsWith('user note\n'));
  } finally {
    box.cleanup();
  }
});

test('re-install refuses a version directory that holds files install did not write (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options());
    writeFixture(
      join(box.root, 'data', 'idd-skill', '0.14.0', 'mine.md'),
      'user content',
    );
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /holds files install did not write/,
    );
    assert.equal(
      readFileSync(
        join(box.root, 'data', 'idd-skill', '0.14.0', 'mine.md'),
        'utf8',
      ),
      'user content',
    );
  } finally {
    box.cleanup();
  }
});

test('install refuses a harness whose recorded wiring is at another path (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options(['claude']));
    const moved = {
      ...box.options(['claude']),
      env: { ...box.options().env, CLAUDE_CONFIG_DIR: join(box.root, 'alt') },
    };
    assert.throws(
      () => runUserGlobalInstall(moved),
      /uninstall that wiring before installing/,
    );
  } finally {
    box.cleanup();
  }
});

test('uninstall refuses a recorded path that the current environment does not reach (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options(['claude']));
    const different = {
      ...box.options(['claude']),
      env: { ...box.options().env, CLAUDE_CONFIG_DIR: join(box.root, 'alt') },
    };
    assert.throws(() => runUserGlobalUninstall(different), /does not reach/);
    assert.equal(existsSync(box.claudeFile), true);
  } finally {
    box.cleanup();
  }
});

test('uninstalling the last recorded harness removes the shared payload and skills (#3825)', () => {
  const box = sandbox();
  try {
    runUserGlobalInstall(box.options(['claude']));
    runUserGlobalUninstall(box.options(['claude']));
    assert.equal(existsSync(box.claudeFile), false);
    assert.equal(existsSync(box.payloadRoot), false);
    assert.equal(existsSync(join(box.home, '.claude', 'skills')), false);
    assert.equal(
      existsSync(
        join(box.root, 'data', 'idd-skill', 'user-global-receipt.json'),
      ),
      false,
    );
  } finally {
    box.cleanup();
  }
});

test('a receipt cannot point a harness record at an unrelated file (#3825)', () => {
  const box = sandbox();
  try {
    const bystander = join(box.root, 'notes.md');
    const block = `${BEGIN_MARKER}\n@/elsewhere/entry.md\n<!-- idd-skill:user-global end -->\n`;
    writeFixture(bystander, `# notes\n${block}`);
    writeFixture(
      join(box.root, 'data', 'idd-skill', 'user-global-receipt.json'),
      JSON.stringify({
        schema: 1,
        version: '0.14.0',
        payloadRoot: box.payloadRoot,
        payloadVersions: [],
        skillDirs: [],
        skillFiles: [],
        dirsCreated: [],
        harnesses: {
          claude: {
            file: bystander,
            fileCreated: false,
            entryAdded: true,
            keyCreated: false,
          },
        },
      }),
    );
    assert.throws(
      () => runUserGlobalUninstall(box.options(['claude'])),
      /does not reach/,
    );
    assert.equal(readFileSync(bystander, 'utf8'), `# notes\n${block}`);
  } finally {
    box.cleanup();
  }
});

test('install refuses a bundle version that would escape the data root (#3825)', () => {
  const box = sandbox();
  const bundle = join(box.root, 'bundle');
  try {
    for (const dir of ['idd-template', 'skills', 'audit']) {
      cpSync(join(REPO_ROOT, dir), join(bundle, dir), { recursive: true });
    }
    writeFixture(
      join(bundle, 'package.json'),
      JSON.stringify({ name: 'bundle', version: '../../escape' }),
    );
    assert.throws(
      () => runUserGlobalInstall({ ...box.options(), bundleRoot: bundle }),
      /invalid package version/,
    );
    assert.equal(existsSync(join(box.root, 'escape')), false);
  } finally {
    box.cleanup();
  }
});

test('uninstall refuses a same-basename bystander recorded as a harness file (#3825)', () => {
  const box = sandbox();
  try {
    const bystander = join(box.root, 'other', 'CLAUDE.md');
    const block = `${BEGIN_MARKER}\n@/elsewhere/entry.md\n<!-- idd-skill:user-global end -->\n`;
    writeFixture(bystander, `# theirs\n${block}`);
    writeFixture(
      join(box.root, 'data', 'idd-skill', 'user-global-receipt.json'),
      JSON.stringify({
        schema: 1,
        version: '0.14.0',
        payloadRoot: box.payloadRoot,
        payloadVersions: [],
        skillDirs: [],
        skillFiles: [],
        dirsCreated: [],
        harnesses: {
          claude: {
            file: bystander,
            fileCreated: false,
            entryAdded: true,
            keyCreated: false,
          },
        },
      }),
    );
    assert.throws(
      () => runUserGlobalUninstall(box.options(['claude'])),
      /does not reach/,
    );
    assert.equal(readFileSync(bystander, 'utf8'), `# theirs\n${block}`);
  } finally {
    box.cleanup();
  }
});

test('install refuses a managed block that no receipt records (#3825)', () => {
  const box = sandbox();
  try {
    const block = `${BEGIN_MARKER}\n@/elsewhere/entry.md\n<!-- idd-skill:user-global end -->\n`;
    writeFixture(box.claudeFile, `# mine\n\n${block}`);
    assert.throws(
      () => runUserGlobalInstall(box.options(['claude'])),
      /no receipt records/,
    );
    assert.equal(readFileSync(box.claudeFile, 'utf8'), `# mine\n\n${block}`);
  } finally {
    box.cleanup();
  }
});

test('install and uninstall refuse a receipt path that is a symlink (#3825)', () => {
  const box = sandbox();
  try {
    const target = join(box.root, 'elsewhere.json');
    writeFixture(target, 'keep me\n');
    const receiptPath = join(
      box.root,
      'data',
      'idd-skill',
      'user-global-receipt.json',
    );
    mkdirSync(join(box.root, 'data', 'idd-skill'), { recursive: true });
    symlinkSync(target, receiptPath);
    assert.throws(
      () => runUserGlobalInstall(box.options()),
      /receipt .*symlink/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'keep me\n');
    assert.throws(
      () => runUserGlobalUninstall(box.options()),
      /receipt .*symlink/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'keep me\n');
  } finally {
    box.cleanup();
  }
});
