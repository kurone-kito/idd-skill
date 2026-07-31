#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-code-span-wrap.mts
//
// The scripts/audit-code-span-wrap.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Repository-local authoring guardrail (idd-skill issue #1677): fails when
// a Markdown file contains an inline code span whose line break falls
// mid-token (see code-span-wrap.mts for the exact rule and rationale).
// This is dogfood-only tooling -- the lint configuration is not part of
// the distributed idd-template/ (see docs/typescript-sources.md and this
// script's registration in tests/helper-runtime-manifest.test.mts's
// DOGFOOD_ONLY_CONCRETE_TOOLS set).
//
// Scope matches the existing `markdownlint-cli2 "**/*.md"` command: every
// tracked Markdown file, minus .markdownlint-cli2.yaml's own `ignores`
// list (including idd-template/**/*.md, which is not itself excluded --
// this check re-uses that scope, it does not add a new one).
//
// Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  type CodeSpanWrapViolation,
  findCorruptingCodeSpanWraps,
} from './code-span-wrap.mts';

const ROOT = process.cwd();
const MARKDOWNLINT_CONFIG_PATH = '.markdownlint-cli2.yaml';

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listMarkdownFiles(): string[] {
  const output = git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  return output
    .split(/\r?\n/)
    .filter((file) => file.length > 0 && file.endsWith('.md'));
}

/**
 * Minimal parser for `.markdownlint-cli2.yaml`'s flat `ignores:` list --
 * this repo's config only ever uses that one simple shape (a top-level
 * `ignores:` key followed by `  - <glob>` lines), so a full YAML parser
 * would be an unused-surface dependency the bare-node boundary does not
 * need. Returns an empty array if the file or key is absent.
 */
export function parseMarkdownlintIgnores(configText: string): string[] {
  const lines = configText.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^ignores:\s*$/.test(line));
  if (startIndex === -1) {
    return [];
  }
  const ignores: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const match = line.match(/^\s+-\s*(.+?)\s*$/);
    if (!match) {
      break;
    }
    ignores.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return ignores;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function readText(file: string): string {
  return readFileSync(`${ROOT}/${file}`, 'utf8');
}

interface FileViolations {
  file: string;
  violations: CodeSpanWrapViolation[];
}

/** Scan every non-ignored Markdown file for corrupting code-span wraps. */
export function auditCodeSpanWraps(): FileViolations[] {
  const ignorePatterns = parseMarkdownlintIgnores(
    readText(MARKDOWNLINT_CONFIG_PATH),
  ).map(globToRegExp);
  const files = listMarkdownFiles().filter(
    (file) => !ignorePatterns.some((pattern) => pattern.test(file)),
  );

  const results: FileViolations[] = [];
  for (const file of files) {
    const violations = findCorruptingCodeSpanWraps(readText(file));
    if (violations.length > 0) {
      results.push({ file, violations });
    }
  }
  return results;
}

if (import.meta.main) {
  const results = auditCodeSpanWraps();
  if (results.length > 0) {
    console.error(
      'audit-code-span-wrap: mid-token inline code span line break(s) found:',
    );
    for (const { file, violations } of results) {
      for (const violation of violations) {
        console.error(
          `- ${file}:${violation.line}  ...${violation.before}|${violation.after}...`,
        );
      }
    }
    console.error(
      '\nCommonMark renders the line break as a literal space, corrupting ' +
        'the token. Rewrap so the break falls at a word boundary instead, ' +
        'or move the value into a fenced code block if it is too long to ' +
        'fit on one line. See .github/copilot-instructions.md for the ' +
        'convention.',
    );
    process.exit(1);
  }
  console.log('audit-code-span-wrap: no mid-token code span wraps found.');
}
