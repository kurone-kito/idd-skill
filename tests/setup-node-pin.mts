import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SetupNodeWorkflowSource = Readonly<{
  path: string;
  contents: string;
}>;

export const SETUP_NODE_USE_LINE =
  /^\s*(?:-\s+)?uses:\s*actions\/setup-node@([0-9a-fA-F]{40}) # v\d+\.\d+\.\d+\s*$/;

export function sharedSetupNodePinFromSources(
  sources: readonly SetupNodeWorkflowSource[],
): string {
  const pins: string[] = [];
  for (const source of sources) {
    for (const [index, line] of source.contents.split(/\r?\n/).entries()) {
      if (line.trimStart().startsWith('#')) {
        continue;
      }
      if (!line.includes('actions/setup-node@')) {
        continue;
      }
      const match = SETUP_NODE_USE_LINE.exec(line);
      const pin = match?.[1];
      assert.ok(
        pin,
        `${source.path}:${index + 1}: setup-node uses must pin a 40-hex SHA with a same-line semver comment`,
      );
      pins.push(pin);
    }
  }

  assert.ok(pins.length > 0, 'at least one real setup-node use must exist');
  const uniquePins = new Set(pins);
  assert.equal(uniquePins.size, 1, 'all setup-node uses must share one SHA');
  const sharedPin = [...uniquePins].at(0);
  assert.ok(sharedPin, 'the shared setup-node pin must be present');
  return sharedPin;
}

export function readSharedSetupNodePin(): string {
  const workflowsDirectory = fileURLToPath(
    new URL('../.github/workflows/', import.meta.url),
  );
  const sources = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((name) => ({
      path: `.github/workflows/${name}`,
      contents: readFileSync(join(workflowsDirectory, name), 'utf8'),
    }));
  return sharedSetupNodePinFromSources(sources);
}

export function setupNodeUseLine(sha: string): string {
  return `        uses: actions/setup-node@${sha} # v1.2.3`;
}
