import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// These checks validate the instruction structure and routing only: that the
// canonical decision table exists, has its routes, and is linked from the
// phase files. They are not evidence that a live autonomous run followed it.

const readRepoText = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The rows of the "Live capability decision" table in the workflow guide. */
function decisionRows(workflow: string): string[][] {
  const start = workflow.indexOf('#### Live capability decision');
  assert.notEqual(start, -1, 'the decision section heading is present');
  const end = workflow.indexOf('#### Session scratchpad lifecycle', start);
  const section = workflow.slice(start, end);
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .map((line) =>
      line
        .slice(1, line.lastIndexOf('|'))
        .split('|')
        .map((cell) => cell.trim()),
    )
    .slice(1);
}

const WORKFLOW = 'idd-template/docs/idd-workflow.md';
const ORCHESTRATOR =
  'idd-template/.github/instructions/idd-orchestrator.instructions.md';
const OVERVIEW =
  'idd-template/.github/instructions/idd-overview-core.instructions.md';

test('the live capability decision table has seven evidence rows, each with a route', () => {
  const rows = decisionRows(readRepoText(WORKFLOW));
  assert.equal(rows.length, 7);
  for (const [evidence, route] of rows) {
    assert.ok(evidence.length > 0, 'evidence cell is filled');
    assert.ok(route.length > 0, 'route cell is filled');
  }
});

test('an unavailable mechanism and an unknown prior state take different routes', () => {
  const rows = decisionRows(readRepoText(WORKFLOW));
  const singleAgent = rows.find(([evidence]) =>
    evidence.includes('positively shows no launch was attempted'),
  );
  const unknown = rows.find(([evidence]) =>
    evidence.includes('the roster is unavailable/incomplete'),
  );
  assert.ok(singleAgent, 'the no-launch single-agent row is present');
  assert.ok(unknown, 'the unknown-roster recovery row is present');
  assert.notEqual(singleAgent[1], unknown[1]);
  assert.match(unknown[1], /do not prove that no worker exists/);
  assert.match(singleAgent[1], /not call a missing roster tool/);
});

test('ambiguous launches and live writers stay on the recovery or hold route', () => {
  const rows = decisionRows(readRepoText(WORKFLOW));
  const unresolved = rows.find(([evidence]) =>
    evidence.includes('writer remains unresolved'),
  );
  assert.ok(unresolved, 'the unresolved-writer row is present');
  assert.match(unresolved[1], /hold/);
});

test('the orchestrator phase links the decision and states that static support is not proof', () => {
  const orchestrator = readRepoText(ORCHESTRATOR);
  assert.match(
    orchestrator,
    /\.\.\/\.\.\/docs\/idd-workflow\.md#live-capability-decision/,
  );
  assert.match(
    orchestrator,
    /support or missing tools do not prove live capability/,
  );
  assert.match(orchestrator, /do not prove live capability/);
});

test('the overview routing states the live execution-mode decision before fan-out setup', () => {
  const overview = readRepoText(OVERVIEW);
  assert.match(overview, /Fan-out mode selection/);
  assert.match(overview, /before scratchpad setup, claim, or worker launch/);
});

test('the refill row switches to single-agent only on capability loss, with every worker disposed and no live writer', () => {
  const rows = decisionRows(readRepoText(WORKFLOW));
  const refill = rows.find(([evidence]) =>
    evidence.includes('At a later refill'),
  );
  assert.ok(refill, 'the refill row is present');
  const [evidence, route] = refill;
  assert.match(evidence, /capability is lost/);
  assert.match(evidence, /every prior worker is verified disposed/);
  assert.match(evidence, /potentially live writer remains/);
  assert.match(route, /single-agent/);
});

test('a healthy fan-out refill is not routed to single-agent', () => {
  const rows = decisionRows(readRepoText(WORKFLOW));
  const fanOut = rows.find(([, route]) => route.startsWith('Fan-out'));
  assert.ok(fanOut, 'the fan-out row is present');
  assert.match(fanOut[0], /known running workers continue/);
  assert.doesNotMatch(fanOut[1], /single-agent/);
});

test('the static candidacy conditions sit in the decision section, before its table', () => {
  const workflow = readRepoText(WORKFLOW);
  const start = workflow.indexOf('#### Live capability decision');
  const table = workflow.indexOf('| Evidence', start);
  const conditions = workflow.indexOf(
    'static fan-out candidate only when',
    start,
  );
  assert.ok(
    conditions > start && conditions < table,
    'the conditions precede the table',
  );
  const section = workflow.slice(conditions, table);
  assert.match(section, /`maxWorkers`/);
  assert.match(section, /`GITHUB_ACTIONS`/);
  const orchestrator = readRepoText(ORCHESTRATOR);
  assert.match(orchestrator, /static requirements in/);
  assert.match(orchestrator, /Static support or missing tools do not prove/);
});

test('the execution-mode report line is required in every report', () => {
  const workflow = readRepoText(WORKFLOW);
  assert.match(workflow, /\*\*Execution mode\.\*\*/);
  assert.match(workflow, /Required in every report\./);
});

test('the explicit-issue fallback is guarded by unresolved worker state, and the table states precedence', () => {
  const workflow = readRepoText(WORKFLOW);
  const rows = decisionRows(workflow);
  const explicit = rows.find(([evidence]) =>
    evidence.includes('one explicit issue'),
  );
  assert.ok(explicit, 'the explicit-issue fallback row is present');
  assert.match(
    explicit[1],
    /only when no launch, own claim, or potentially live writer is unresolved/,
  );
  assert.match(workflow, /takes precedence over every static\s+fallback/);
});

test('the mode decision is stated before A5, not as a claim phase', () => {
  const workflow = readRepoText(WORKFLOW);
  assert.match(workflow, /Mode decision before A5; then ordinary single-issue/);
  assert.doesNotMatch(
    workflow,
    /Ordinary single-issue Discover\/Claim\/Work before A5/,
  );
});
