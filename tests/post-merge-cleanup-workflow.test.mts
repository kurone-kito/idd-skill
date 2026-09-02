import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOW_PATHS = [
  '.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
] as const;

function readWorkflow(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test("duplicate-evidence-skip guard also requires the current run's own STATUS to be converged (#2213)", () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    const guardStart = text.indexOf('if [ -n "$EXISTING" ]');
    assert.notStrictEqual(
      guardStart,
      -1,
      `${path} must keep the duplicate-evidence-skip guard`,
    );
    const guardEnd = text.indexOf('; then', guardStart);
    assert.notStrictEqual(
      guardEnd,
      -1,
      `${path} guard must be closed with "; then"`,
    );
    const guard = text.slice(guardStart, guardEnd);

    assert.match(
      guard,
      /\[ "\$EXISTING_STATUS" = "applied" \]/,
      `${path} guard must still check the prior comment's EXISTING_STATUS`,
    );
    assert.match(
      guard,
      /\[ "\$STATUS" = "applied" \]/,
      `${path} guard must also check the current run's own STATUS, not only EXISTING_STATUS`,
    );
    assert.match(
      guard,
      /\[ "\$STATUS" = "clean" \]/,
      `${path} guard must also check STATUS = clean, not only EXISTING_STATUS`,
    );
  }
});

test('duplicate-evidence-skip guard is a strict superset of the prior EXISTING_STATUS-only condition', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    // A bare "EXISTING_STATUS = applied" check with no accompanying
    // "STATUS = applied" check anywhere nearby would mean the fix
    // regressed back to comparing only the prior comment's status.
    const skipBlockStart = text.indexOf('# Avoid duplicate evidence comments');
    assert.notStrictEqual(
      skipBlockStart,
      -1,
      `${path} must keep the duplicate-evidence-skip comment block`,
    );
    const skipBlockEnd = text.indexOf('BODY=$(printf', skipBlockStart);
    assert.notStrictEqual(
      skipBlockEnd,
      -1,
      `${path} must keep the BODY=$(printf anchor after the skip block`,
    );
    const skipBlock = text.slice(skipBlockStart, skipBlockEnd);
    const statusMentions = (skipBlock.match(/"\$STATUS"/g) ?? []).length;
    assert.ok(
      statusMentions >= 2,
      `${path} skip block must reference $STATUS at least twice (applied and clean), found ${statusMentions}`,
    );
  }
});
