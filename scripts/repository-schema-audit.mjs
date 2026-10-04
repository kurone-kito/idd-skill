// idd-generated-from: src/scripts/repository-schema-audit.mts
//
// The scripts/repository-schema-audit.mjs copy is generated from this source
// by `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// Local source-repository audit (#3751, roadmap #3744) for the schema and
// onboarding catalogs. It owns the repository-wide agreements that five test
// suites used to enforce by scanning the real checkout: the schema-file to
// exported-type catalog, the output-roundtrip coverage ledger, the policy
// journal-issue pattern, the hearing catalog's placeholder and Step 1B
// documentation agreements, and the phase graph and resume-route agreements.
// `validate-schemas` owns the schema and instance validation itself.
//
// Each rule keeps its detector as a pure function and reads the repository
// only through a root argument, so a scratch tree exercises the same code the
// real tree does. `audit-docs --check` runs `collectRepositorySchemaViolations`
// for the source repository, which puts these rules in the bare-node lane, the
// installed aggregate and the IDD pre-push chain. Behavioral builders still
// execute in the tests: the ledger below only proves catalog completeness.
//
// Rule families (a violation prints as `<RULE-ID> <path>: <message>`):
//
// - SCHEMA-TYPE-CATALOG: every `*.schema.json` file in `schemas/` is mapped
//   to an exported type and owning module exactly once, and the only
//   non-schema file there is the `phase-graph.json` data file.
// - SCHEMA-OUTPUT-COVERAGE: the output-roundtrip ledger covers every schema
//   exactly once; a covered entry names a builder, an uncovered one a reason.
// - SCHEMA-JOURNAL-PATTERN: the issue-authoring reference pattern in
//   `audit-authored-issue.mts` equals the policy schema's
//   `issueAuthoring.journalIssue.pattern`.
// - HEARING-PLACEHOLDER-DOC: the hearing catalog's placeholder items equal,
//   in order, the placeholder rows documented in `placeholders.md`.
// - HEARING-STEP1B-COMPANION: every Step 1B item has its companion heading
//   in the policy-decisions guide.
// - PHASE-GRAPH-NORMALIZED: phase-graph node ids stay unique, and every edge
//   resolves, once normalized by the phase-id resolver.
// - RESUME-ROUTE-ENUM: the resume-route selection helper's documented route
//   enum and decision table agree and resolve through the phase-id resolver.
//
// A `<RULE-ID>-INSPECTION` violation means a rule could not finish: an
// unreadable or malformed input, or an inventory that came back empty (a rule
// that inspects nothing would otherwise pass vacuously). Never writes, makes
// no GitHub call, and imports only `node:` builtins plus the phase-id
// resolver and the bundle-root resolver, whose own closures are node-only.
// #3240: keep the runtime check first so an unsupported Node version fails
// loudly before import.meta.main is evaluated.
import './node-runtime-guard.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import { normalizePhaseIdToken, resolvePhaseId } from './phase-id-resolver.mjs';
export const SCHEMA_TYPE_CATALOG_RULE = 'SCHEMA-TYPE-CATALOG';
export const SCHEMA_OUTPUT_COVERAGE_RULE = 'SCHEMA-OUTPUT-COVERAGE';
export const SCHEMA_JOURNAL_PATTERN_RULE = 'SCHEMA-JOURNAL-PATTERN';
export const HEARING_PLACEHOLDER_DOC_RULE = 'HEARING-PLACEHOLDER-DOC';
export const HEARING_STEP1B_COMPANION_RULE = 'HEARING-STEP1B-COMPANION';
export const PHASE_GRAPH_NORMALIZED_RULE = 'PHASE-GRAPH-NORMALIZED';
export const RESUME_ROUTE_ENUM_RULE = 'RESUME-ROUTE-ENUM';
/**
 * The schema-file to exported-type to owning-module mapping (#874). A schema
 * file on disk that is missing here, or an entry whose file is gone, fails
 * SCHEMA-TYPE-CATALOG. The type-reconciliation suite joins each entry with its
 * test-only key list and canonical fixture, so the typed `satisfies` witnesses
 * stay in the test while this catalog stays importable by the audit.
 */
export const SCHEMA_TYPE_CATALOG = [
  {
    schemaFile: 'disposition-non-review-notices.schema.json',
    exportedType: 'DispositionReport',
    owningModule: 'src/scripts/disposition-non-review-notices.mts',
  },
  {
    schemaFile: 'resolve-review-thread.schema.json',
    exportedType: 'ResolveReviewThreadReport',
    owningModule: 'src/scripts/resolve-review-thread.mts',
  },
  {
    schemaFile: 'post-idd-marker.schema.json',
    exportedType: 'PostIddMarkerResult',
    owningModule: 'src/scripts/post-idd-marker.mts',
  },
  {
    schemaFile: 'advisory-convergence.schema.json',
    exportedType: 'AdvisoryConvergenceVerdict',
    owningModule: 'src/scripts/advisory-convergence.mts',
  },
  {
    schemaFile: 'advisory-wait-state.schema.json',
    exportedType: 'AdvisoryWaitStateReport',
    owningModule: 'src/scripts/advisory-wait-state.mts',
  },
  {
    schemaFile: 'branch-conflict-state.schema.json',
    exportedType: 'BranchConflictResult',
    owningModule: 'src/scripts/branch-conflict-state.mts',
  },
  {
    schemaFile: 'provider-health.schema.json',
    exportedType: 'ProviderHealthReport',
    owningModule: 'src/scripts/provider-health.mts',
  },
  {
    schemaFile: 'claim-marker.schema.json',
    exportedType: 'ParsedClaimMarker',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'provider-outage-declaration.schema.json',
    exportedType: 'ParsedProviderOutageDeclaration',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'provider-outage-park.schema.json',
    exportedType: 'ParsedProviderOutagePark',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'local-validation-evidence.schema.json',
    exportedType: 'ParsedLocalValidationEvidence',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'token-cost-event.schema.json',
    exportedType: 'TokenCostEvent',
    owningModule: 'src/scripts/token-cost-core.mts',
  },
  {
    schemaFile: 'token-cost-sample.schema.json',
    exportedType: 'TokenCostSample',
    owningModule: 'src/scripts/token-cost-core.mts',
  },
  {
    schemaFile: 'token-cost-snapshot.schema.json',
    exportedType: 'TokenCostSnapshot',
    owningModule: 'src/scripts/token-cost-core.mts',
  },
  {
    schemaFile: 'discover-roadmap-union.schema.json',
    exportedType: 'RoadmapGraphUnionReport',
    owningModule: 'src/scripts/discover-roadmap-graph.mts',
  },
  {
    schemaFile: 'discover-roadmap-incomplete.schema.json',
    exportedType: 'DiscoverIncompleteReport',
    owningModule: 'src/scripts/discover-roadmap-graph.mts',
  },
  {
    schemaFile: 'forced-handoff-marker.schema.json',
    exportedType: 'ParsedForcedHandoffMarker',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'idd-merge-execute.schema.json',
    exportedType: 'IddMergeExecuteVerdict',
    owningModule: 'src/scripts/idd-merge-execute.mts',
  },
  {
    schemaFile: 'idd-roadmap-audit-execute.schema.json',
    exportedType: 'IddRoadmapAuditExecuteVerdict',
    owningModule: 'src/scripts/idd-roadmap-audit-execute.mts',
  },
  {
    schemaFile: 'live-status-digest.schema.json',
    exportedType: 'LiveStatusDigestFields',
    owningModule: 'src/scripts/protocol-helpers.mts',
  },
  {
    schemaFile: 'phase-graph.schema.json',
    exportedType: 'PhaseGraphDocument (test-local; no runtime type)',
    owningModule:
      'schemas/phase-graph.json via src/scripts/validate-schemas.mts',
  },
  {
    schemaFile: 'issue-authoring-review-input.schema.json',
    exportedType: 'IssueAuthoringReviewInput (test-local; no runtime type)',
    owningModule:
      'docs/issue-authoring-skill.md (caller-composed stdin payload)',
  },
  {
    schemaFile: 'onboarding-hearing-catalog.schema.json',
    exportedType: 'OnboardingHearingCatalog',
    owningModule: 'src/scripts/onboarding-hearing.mts',
  },
  {
    schemaFile: 'onboarding-hearing-transcript.schema.json',
    exportedType: 'OnboardingHearingTranscript',
    owningModule: 'src/scripts/onboarding-hearing.mts',
  },
  {
    schemaFile: 'policy.schema.json',
    exportedType: 'PolicyConfigFile (test-local; no runtime type)',
    owningModule: 'src/scripts/policy-helpers.mts',
  },
  {
    schemaFile: 'pre-merge-readiness.schema.json',
    exportedType: 'PreMergeReadinessReport',
    owningModule: 'src/scripts/pre-merge-readiness.mts',
  },
  {
    schemaFile: 'stalled-session-quiet-check.schema.json',
    exportedType: 'StalledSessionQuietCheckReport',
    owningModule: 'src/scripts/stalled-session-quiet-check.mts',
  },
];
export const SCHEMA_OUTPUT_COVERAGE = [
  {
    schema: 'advisory-convergence.schema.json',
    status: 'covered',
    builder: 'computeAdvisoryConvergenceVerdict (advisory-convergence.mts)',
  },
  {
    schema: 'advisory-wait-state.schema.json',
    status: 'uncovered',
    reason:
      'advisory-wait-state.mts has no exported function that builds the ' +
      'full envelope -- the exported helpers (buildCopilotRecoverySummary, ' +
      'evaluateStaleRequestRecoveryAction, ...) each build only a nested ' +
      'sub-object, and the root envelope is assembled inline inside the ' +
      "CLI's own non-exported main path. Extracting a pure builder is out " +
      'of scope for this test-only change (#1723 proposed change #2).',
  },
  {
    schema: 'branch-conflict-state.schema.json',
    status: 'covered',
    builder: 'classifyBranchConflictState (branch-conflict-state.mts)',
  },
  {
    schema: 'claim-marker.schema.json',
    status: 'covered',
    builder:
      'parseClaimComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'issue-authoring-review-input.schema.json',
    status: 'uncovered',
    reason:
      'issue-authoring-review-input.schema.json is the stdin payload the ' +
      'issue-authoring caller composes for the configured draft-review ' +
      'delegate, not a helper stdout envelope -- no helper builds it and ' +
      'the resolver never invokes the command, so fixture coverage lives ' +
      'in discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'token-cost-event.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-event.schema.json is a source-repo measurement contract, ' +
      'not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'token-cost-sample.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-sample.schema.json is a source-repo measurement contract, ' +
      'not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'token-cost-snapshot.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-snapshot.schema.json is a source-repo measurement ' +
      'contract, not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'discover-roadmap-union.schema.json',
    status: 'covered',
    builder: 'enumerateAllRoadmapsGraph (discover-roadmap-graph.mts)',
  },
  {
    schema: 'discover-roadmap-incomplete.schema.json',
    status: 'covered',
    builder:
      'enumerateAllRoadmapsGraphWithRecovery (discover-roadmap-graph.mts)',
  },
  {
    schema: 'disposition-non-review-notices.schema.json',
    status: 'covered',
    builder: 'buildDispositionPlan (disposition-non-review-notices.mts)',
  },
  {
    schema: 'forced-handoff-marker.schema.json',
    status: 'covered',
    builder:
      'parseForcedHandoffComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'idd-merge-execute.schema.json',
    status: 'covered',
    builder: 'runMergeExecute (idd-merge-execute.mts)',
  },
  {
    schema: 'idd-roadmap-audit-execute.schema.json',
    status: 'covered',
    builder: 'runRoadmapAuditExecute (idd-roadmap-audit-execute.mts)',
  },
  {
    schema: 'live-status-digest.schema.json',
    status: 'uncovered',
    reason:
      'live-status-digest.mts builds the report entirely inside its ' +
      'non-exported main() using direct gh network calls (fetchIssueComments, ' +
      'createIssueComment, updateIssueComment); no exported pure builder ' +
      'produces the full envelope. Extraction is out of scope for this ' +
      'test-only change (#1723 proposed change #2).',
  },
  {
    schema: 'onboarding-hearing-catalog.schema.json',
    status: 'uncovered',
    reason:
      'onboarding-hearing-catalog.schema.json describes the static ' +
      'idd-template/docs/onboarding/hearing-catalog.json source artifact, ' +
      'not a helper stdout envelope -- it is already validated by ' +
      'validate-schemas (LIVE_INSTANCE_CASES), and its Step 1B and ' +
      'placeholder document agreements are the HEARING-* rules of this audit.',
  },
  {
    schema: 'onboarding-hearing-transcript.schema.json',
    status: 'uncovered',
    reason:
      'onboarding-hearing-transcript.schema.json describes a confirmed ' +
      'hearing transcript document later CLI stages will write, not a ' +
      'current helper stdout envelope -- the valid/invalid fixture pair is ' +
      'exercised by discoverSchemaCases / scripts/validate-schemas.mjs, ' +
      'which enumerates schemas/*.schema.json against ' +
      'fixtures/schemas/*.{valid,invalid}.json.',
  },
  {
    schema: 'phase-graph.schema.json',
    status: 'uncovered',
    reason:
      'schemas/phase-graph.json is a static generated data file, not a ' +
      "helper's stdout envelope -- it is already validated directly by " +
      'validate-schemas (LIVE_INSTANCE_CASES).',
  },
  {
    schema: 'policy.schema.json',
    status: 'uncovered',
    reason:
      'policy.schema.json describes the input config document ' +
      '(.github/idd/config.json), not a helper stdout output -- it is ' +
      'already validated directly by validate-schemas (LIVE_INSTANCE_CASES).',
  },
  {
    schema: 'post-idd-marker.schema.json',
    status: 'uncovered',
    reason:
      'post-idd-marker.mts assembles PostIddMarkerResult only inside its ' +
      'non-exported main() CLI path, which performs direct gh network ' +
      'calls (the in-process collectReviewActivitySnapshot() capture and ' +
      'the required-check read); no exported pure builder produces the ' +
      'full envelope. Extraction is out of scope for this test-only ' +
      'change (#1723 proposed change #2).',
  },
  {
    schema: 'pre-merge-readiness.schema.json',
    status: 'covered',
    builder: 'buildPreMergeReadinessSummary (protocol-helpers.mts)',
  },
  {
    schema: 'provider-health.schema.json',
    status: 'uncovered',
    reason:
      'buildProviderHealthReport (provider-health.mts) assembles the full ' +
      'envelope but calls collectAdvisoryReviewEvidence/' +
      'collectCiActionsEvidence internally (live gh network reads); the ' +
      'pure per-service builder classifyProviderHealth is exercised ' +
      "directly against the schema by tests/provider-health.test.mts's " +
      'own fixture-driven tests instead.',
  },
  {
    schema: 'provider-outage-declaration.schema.json',
    status: 'covered',
    builder:
      'parseProviderOutageDeclarationComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'provider-outage-park.schema.json',
    status: 'covered',
    builder:
      'parseProviderOutageParkComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'local-validation-evidence.schema.json',
    status: 'covered',
    builder:
      'parseLocalValidationEvidenceComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'resolve-review-thread.schema.json',
    status: 'covered',
    builder: 'applyResolveReviewThread (resolve-review-thread.mts)',
  },
  {
    schema: 'stalled-session-quiet-check.schema.json',
    status: 'covered',
    builder: 'evaluateQuietWindow (stalled-session-quiet-check.mts)',
  },
];
/**
 * Step 1B hearing items and the companion heading (or phrase) each must have in
 * `idd-template/docs/onboarding/policy-decisions.md`, in the two sections the
 * guide uses for confirmed decisions. Insertion order is the catalog order.
 */
export const ONBOARDING_STEP1B_COMPANIONS = {
  'merge-policy': '### Merge policy',
  'review-policy': '### PR review policy profile',
  'thread-resolution-policy': '### Review-thread resolution policy',
  'critique-loop-profile': '### Critique-loop profile',
  'credential-scope': '### Credential scope',
  'claim-timing': 'claim-stale-age',
  'ci-wait-policy': '### CI wait policy',
  'issue-author-approval-gate': '### Issue-author approval gate',
  'maintainer-approval-actor-policy': '### `maintainer-approval-actors` policy',
  'issue-authoring-companion': '### Issue-authoring companion',
  'helper-runtime-profile': '### Helper runtime profile',
  'idd-label-names': '### IDD label names',
  'up-to-date-head-ruleset': 'up to date before merging',
  'bootstrap-execution-mode': '### Bootstrap execution mode',
  'development-branch': '### Development branch',
};
const SCHEMAS_DIRECTORY = 'schemas';
const POLICY_SCHEMA_PATH = 'schemas/policy.schema.json';
const PHASE_GRAPH_PATH = 'schemas/phase-graph.json';
const HEARING_CATALOG_PATH =
  'idd-template/docs/onboarding/hearing-catalog.json';
const PLACEHOLDERS_DOC_PATH = 'idd-template/docs/onboarding/placeholders.md';
const POLICY_DECISIONS_DOC_PATH =
  'idd-template/docs/onboarding/policy-decisions.md';
const AUTHORED_ISSUE_SOURCE_PATH = 'src/scripts/audit-authored-issue.mts';
const RESUME_ROUTE_SOURCE_PATH = 'src/scripts/resume-route-selection.mts';
/** The two policy-decisions sections that hold Step 1B companion headings. */
export const STEP1B_COMPANION_SECTIONS = [
  'Decisions that require explicit operator confirmation',
  'Related default policies to confirm',
];
/** A resume route that is a terminal stop signal, not a phase. */
const RESUME_TERMINAL_SENTINELS = new Set(['stop']);
/** The collapsed routing-graph-only node, intentionally not canonical. */
const BARE_COLLAPSED_PHASE = 'A';
const DEFAULT_DEPENDENCIES = {
  normalizePhaseId: normalizePhaseIdToken,
  resolvePhase: (input) => resolvePhaseId(input),
};
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function violation(ruleId, path, message) {
  return { ruleId, path, message };
}
function inspectionViolation(ruleId, path, message) {
  return violation(`${ruleId}-INSPECTION`, path, message);
}
/** Reads `path` as UTF-8, or records why it could not be read. */
function readText(ruleId, root, path, violations) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    violations.push(
      inspectionViolation(
        ruleId,
        path,
        `cannot read the file: ${describeError(error)}`,
      ),
    );
    return null;
  }
}
/** Reads `path` as JSON, or records why it could not be read or parsed. */
function readJson(ruleId, root, path, violations) {
  const text = readText(ruleId, root, path, violations);
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    violations.push(
      inspectionViolation(
        ruleId,
        path,
        `cannot parse the file as JSON: ${describeError(error)}`,
      ),
    );
    return undefined;
  }
}
/** Entry names of `schemas/`, or records why they could not be listed. */
function listSchemaDirectory(ruleId, root, violations) {
  try {
    return readdirSync(join(root, SCHEMAS_DIRECTORY));
  } catch (error) {
    violations.push(
      inspectionViolation(
        ruleId,
        SCHEMAS_DIRECTORY,
        `cannot list the directory: ${describeError(error)}`,
      ),
    );
    return null;
  }
}
function schemaFileNames(entries) {
  return entries.filter((name) => name.endsWith('.schema.json')).sort();
}
/**
 * SCHEMA-TYPE-CATALOG detector: `entries` are the names inside `schemas/`,
 * `catalog` the mapping that must cover its `*.schema.json` files exactly.
 */
export function detectSchemaCatalogDrift(entries, catalog) {
  const violations = [];
  const onDisk = schemaFileNames(entries);
  const onDiskSet = new Set(onDisk);
  const mapped = new Set(catalog.map((entry) => entry.schemaFile));
  for (const name of onDisk) {
    if (!mapped.has(name)) {
      violations.push(
        violation(
          SCHEMA_TYPE_CATALOG_RULE,
          `${SCHEMAS_DIRECTORY}/${name}`,
          'is not mapped to an exported type; add an entry (schema file, ' +
            'exported type, owning module) to SCHEMA_TYPE_CATALOG in ' +
            'src/scripts/repository-schema-audit.mts',
        ),
      );
    }
  }
  const seen = new Set();
  for (const { schemaFile } of catalog) {
    const path = `${SCHEMAS_DIRECTORY}/${schemaFile}`;
    if (!onDiskSet.has(schemaFile)) {
      violations.push(
        violation(
          SCHEMA_TYPE_CATALOG_RULE,
          path,
          'SCHEMA_TYPE_CATALOG references a schema file that does not exist',
        ),
      );
    }
    if (seen.has(schemaFile)) {
      violations.push(
        violation(
          SCHEMA_TYPE_CATALOG_RULE,
          path,
          'SCHEMA_TYPE_CATALOG lists this schema file more than once',
        ),
      );
    }
    seen.add(schemaFile);
  }
  // schemas/phase-graph.json is DATA (an instance of phase-graph.schema.json),
  // intentionally outside the `*.schema.json` mapping glob; any other stray
  // file is reported.
  const nonSchema = entries
    .filter((name) => !name.endsWith('.schema.json'))
    .sort();
  for (const name of nonSchema) {
    if (name !== 'phase-graph.json') {
      violations.push(
        violation(
          SCHEMA_TYPE_CATALOG_RULE,
          `${SCHEMAS_DIRECTORY}/${name}`,
          'is not a schema; the only non-schema file in schemas/ is the ' +
            'phase-graph.json data file',
        ),
      );
    }
  }
  if (!nonSchema.includes('phase-graph.json')) {
    violations.push(
      violation(
        SCHEMA_TYPE_CATALOG_RULE,
        PHASE_GRAPH_PATH,
        'the phase-graph.json data file is missing from schemas/',
      ),
    );
  }
  return violations;
}
/** SCHEMA-TYPE-CATALOG over `<root>/schemas`. */
export function checkSchemaTypeCatalog(root) {
  const violations = [];
  const entries = listSchemaDirectory(
    SCHEMA_TYPE_CATALOG_RULE,
    root,
    violations,
  );
  if (entries === null) {
    return { ruleId: SCHEMA_TYPE_CATALOG_RULE, inspected: 0, violations };
  }
  const schemas = schemaFileNames(entries);
  if (schemas.length === 0) {
    violations.push(
      inspectionViolation(
        SCHEMA_TYPE_CATALOG_RULE,
        SCHEMAS_DIRECTORY,
        'no *.schema.json file to inspect; an empty inventory would pass vacuously',
      ),
    );
  }
  violations.push(...detectSchemaCatalogDrift(entries, SCHEMA_TYPE_CATALOG));
  return {
    ruleId: SCHEMA_TYPE_CATALOG_RULE,
    inspected: schemas.length,
    violations,
  };
}
/**
 * SCHEMA-OUTPUT-COVERAGE detector: `schemaFiles` are the `*.schema.json` names
 * on disk, `ledger` the output-roundtrip coverage entries.
 */
export function detectOutputCoverageDrift(schemaFiles, ledger) {
  const violations = [];
  const onDisk = new Set(schemaFiles);
  const listed = new Set(ledger.map((entry) => entry.schema));
  for (const file of [...schemaFiles].sort()) {
    if (!listed.has(file)) {
      violations.push(
        violation(
          SCHEMA_OUTPUT_COVERAGE_RULE,
          `${SCHEMAS_DIRECTORY}/${file}`,
          'has no SCHEMA_OUTPUT_COVERAGE entry; add a covered or ' +
            'uncovered-with-reason entry in src/scripts/repository-schema-audit.mts',
        ),
      );
    }
  }
  const seen = new Set();
  for (const entry of ledger) {
    const path = `${SCHEMAS_DIRECTORY}/${entry.schema}`;
    if (!onDisk.has(entry.schema)) {
      violations.push(
        violation(
          SCHEMA_OUTPUT_COVERAGE_RULE,
          path,
          'SCHEMA_OUTPUT_COVERAGE names a schema file that does not exist',
        ),
      );
    }
    if (seen.has(entry.schema)) {
      violations.push(
        violation(
          SCHEMA_OUTPUT_COVERAGE_RULE,
          path,
          'SCHEMA_OUTPUT_COVERAGE must not list the same schema twice',
        ),
      );
    }
    seen.add(entry.schema);
    if (entry.status === 'covered' && entry.builder.trim().length === 0) {
      violations.push(
        violation(
          SCHEMA_OUTPUT_COVERAGE_RULE,
          path,
          'a covered entry must name a builder',
        ),
      );
    }
    if (entry.status === 'uncovered' && entry.reason.trim().length === 0) {
      violations.push(
        violation(
          SCHEMA_OUTPUT_COVERAGE_RULE,
          path,
          'an uncovered entry must give a one-line reason',
        ),
      );
    }
  }
  return violations;
}
/** SCHEMA-OUTPUT-COVERAGE over `<root>/schemas`. */
export function checkSchemaOutputCoverage(root) {
  const violations = [];
  const entries = listSchemaDirectory(
    SCHEMA_OUTPUT_COVERAGE_RULE,
    root,
    violations,
  );
  if (entries === null) {
    return { ruleId: SCHEMA_OUTPUT_COVERAGE_RULE, inspected: 0, violations };
  }
  const schemas = schemaFileNames(entries);
  if (schemas.length === 0) {
    violations.push(
      inspectionViolation(
        SCHEMA_OUTPUT_COVERAGE_RULE,
        SCHEMAS_DIRECTORY,
        'no *.schema.json file to inspect; an empty inventory would pass vacuously',
      ),
    );
  }
  violations.push(
    ...detectOutputCoverageDrift(schemas, SCHEMA_OUTPUT_COVERAGE),
  );
  return {
    ruleId: SCHEMA_OUTPUT_COVERAGE_RULE,
    inspected: schemas.length,
    violations,
  };
}
/**
 * `text` with every comment that starts a line blanked out (the line structure
 * is kept), so a commented-out declaration is never read as live code: a line
 * that starts with `//`, and a block comment that starts a line, through its
 * closing marker. Only comments that begin a line are masked, so a comment
 * marker inside a string or a regex literal is left alone.
 */
export function maskLeadingComments(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      let rest = line;
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          return '';
        }
        inBlock = false;
        rest = rest.slice(end + 2);
      }
      const trimmed = rest.trimStart();
      if (trimmed.startsWith('//')) {
        return '';
      }
      if (trimmed.startsWith('/*')) {
        const end = trimmed.indexOf('*/', 2);
        if (end === -1) {
          inBlock = true;
          return '';
        }
        return trimmed.slice(end + 2);
      }
      return rest;
    })
    .join('\n');
}
/**
 * The source text of every regex literal the constant `name` is declared with
 * (the characters between the slashes), skipping declarations inside comments
 * that start a line. Character classes and escaped characters may contain a
 * slash. A comment that opens after code is not recognized, so a stale
 * declaration inside one is returned too: callers must treat more than one
 * result as ambiguous instead of picking one.
 */
export function findRegexLiteralDeclarations(sourceText, name) {
  const declaration = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*(?::[^=\\n]+)?=\\s*/((?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^/\\\\\\n\\[])+)/[a-z]*\\s*;`,
    'gm',
  );
  return [...maskLeadingComments(sourceText).matchAll(declaration)].map(
    (match) => match[1],
  );
}
/**
 * SCHEMA-JOURNAL-PATTERN detector. A regex literal's source escapes the `/`
 * a JSON string pattern never needs to, so normalize before comparing: the two
 * only drift when their actual matching behavior does.
 */
export function detectJournalPatternDrift(literalSource, schemaPattern) {
  const normalized = literalSource.replace(/\\\//g, '/');
  if (normalized === schemaPattern) {
    return [];
  }
  return [
    violation(
      SCHEMA_JOURNAL_PATTERN_RULE,
      AUTHORED_ISSUE_SOURCE_PATH,
      'REAL_ISSUE_REFERENCE_PATTERN and schemas/policy.schema.json ' +
        'issueAuthoring.journalIssue.pattern drifted -- update both together ' +
        `(source: ${normalized}; schema: ${schemaPattern})`,
    ),
  ];
}
/** SCHEMA-JOURNAL-PATTERN over the authored-issue source and the policy schema. */
export function checkSchemaJournalPattern(root) {
  const violations = [];
  const source = readText(
    SCHEMA_JOURNAL_PATTERN_RULE,
    root,
    AUTHORED_ISSUE_SOURCE_PATH,
    violations,
  );
  const schema = readJson(
    SCHEMA_JOURNAL_PATTERN_RULE,
    root,
    POLICY_SCHEMA_PATH,
    violations,
  );
  if (source === null || schema === undefined) {
    return { ruleId: SCHEMA_JOURNAL_PATTERN_RULE, inspected: 0, violations };
  }
  const declarations = findRegexLiteralDeclarations(
    source,
    'REAL_ISSUE_REFERENCE_PATTERN',
  );
  const literal = declarations.length === 1 ? declarations[0] : null;
  if (declarations.length !== 1) {
    violations.push(
      inspectionViolation(
        SCHEMA_JOURNAL_PATTERN_RULE,
        AUTHORED_ISSUE_SOURCE_PATH,
        declarations.length === 0
          ? 'cannot find the REAL_ISSUE_REFERENCE_PATTERN regex literal'
          : `found ${declarations.length} declarations of ` +
              'REAL_ISSUE_REFERENCE_PATTERN and cannot tell which is live; ' +
              'remove the stale one (a comment that opens after code is not ' +
              'recognized as a comment)',
      ),
    );
  }
  const pattern =
    schema?.properties?.issueAuthoring?.properties?.journalIssue?.pattern;
  if (typeof pattern !== 'string') {
    violations.push(
      inspectionViolation(
        SCHEMA_JOURNAL_PATTERN_RULE,
        POLICY_SCHEMA_PATH,
        'cannot find issueAuthoring.journalIssue.pattern',
      ),
    );
  }
  if (literal !== null && typeof pattern === 'string') {
    violations.push(...detectJournalPatternDrift(literal, pattern));
  }
  return { ruleId: SCHEMA_JOURNAL_PATTERN_RULE, inspected: 1, violations };
}
/** The placeholder names the documented placeholder table lists, in order. */
export function extractDocumentedPlaceholders(docText) {
  return [
    ...docText.matchAll(/^\| `\{\{([A-Z0-9_]+)\}\}`\s+\| (.+?)\s+\|/gmu),
  ].map((row) => row[1]);
}
/** HEARING-PLACEHOLDER-DOC detector: catalog placeholder names vs the table. */
export function detectPlaceholderDocDrift(catalogNames, documented) {
  if (JSON.stringify(catalogNames) === JSON.stringify(documented)) {
    return [];
  }
  return [
    violation(
      HEARING_PLACEHOLDER_DOC_RULE,
      PLACEHOLDERS_DOC_PATH,
      `the hearing catalog's placeholder items (${JSON.stringify(catalogNames)}) ` +
        `differ, in names or order, from the documented placeholder rows ` +
        `(${JSON.stringify(documented)})`,
    ),
  ];
}
/** HEARING-PLACEHOLDER-DOC over the live hearing catalog and its guide. */
export function checkHearingPlaceholderDoc(root) {
  const violations = [];
  const catalog = readJson(
    HEARING_PLACEHOLDER_DOC_RULE,
    root,
    HEARING_CATALOG_PATH,
    violations,
  );
  const doc = readText(
    HEARING_PLACEHOLDER_DOC_RULE,
    root,
    PLACEHOLDERS_DOC_PATH,
    violations,
  );
  if (catalog === undefined || doc === null) {
    return { ruleId: HEARING_PLACEHOLDER_DOC_RULE, inspected: 0, violations };
  }
  const items = Array.isArray(catalog?.items) ? catalog.items : null;
  if (items === null) {
    violations.push(
      inspectionViolation(
        HEARING_PLACEHOLDER_DOC_RULE,
        HEARING_CATALOG_PATH,
        'the catalog has no items array',
      ),
    );
    return { ruleId: HEARING_PLACEHOLDER_DOC_RULE, inspected: 0, violations };
  }
  const names = items
    .filter((item) => item?.kind === 'placeholder')
    .map((item) => item.mapsToPlaceholder);
  const documented = extractDocumentedPlaceholders(doc);
  if (names.length === 0 || documented.length === 0) {
    violations.push(
      inspectionViolation(
        HEARING_PLACEHOLDER_DOC_RULE,
        names.length === 0 ? HEARING_CATALOG_PATH : PLACEHOLDERS_DOC_PATH,
        'no placeholder to compare; an empty list would pass vacuously',
      ),
    );
  }
  violations.push(...detectPlaceholderDocDrift(names, documented));
  return {
    ruleId: HEARING_PLACEHOLDER_DOC_RULE,
    inspected: names.length,
    violations,
  };
}
/** The text of the `## heading` section, up to the next `## `, or null. */
export function extractH2Section(doc, heading) {
  const marker = `## ${heading}`;
  const start = doc.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const after = doc.slice(start + marker.length);
  const next = after.search(/^## /mu);
  return next === -1 ? after : after.slice(0, next);
}
/** HEARING-STEP1B-COMPANION detector over the policy-decisions guide text. */
export function detectStep1bCompanionDrift(policyDoc, companions) {
  const violations = [];
  const sections = [];
  for (const heading of STEP1B_COMPANION_SECTIONS) {
    const section = extractH2Section(policyDoc, heading);
    if (section === null) {
      violations.push(
        violation(
          HEARING_STEP1B_COMPANION_RULE,
          POLICY_DECISIONS_DOC_PATH,
          `missing heading "## ${heading}"`,
        ),
      );
    } else {
      sections.push(section);
    }
  }
  const corpus = sections.join('\n');
  for (const [id, needle] of Object.entries(companions)) {
    if (!corpus.includes(needle)) {
      violations.push(
        violation(
          HEARING_STEP1B_COMPANION_RULE,
          POLICY_DECISIONS_DOC_PATH,
          `Step 1B id ${id} has no companion heading ${needle}`,
        ),
      );
    }
  }
  return violations;
}
/**
 * HEARING-STEP1B-COMPANION detector over the catalog: the Step 1B item ids the
 * root's hearing catalog declares must be exactly the keys of the companion
 * table, so a new Step 1B item cannot stay undocumented because nobody added
 * it to the table, and the table cannot keep an id the catalog dropped.
 */
export function detectStep1bCatalogDrift(catalogIds, companions) {
  const violations = [];
  const known = new Set(Object.keys(companions));
  const declared = new Set(catalogIds);
  for (const id of catalogIds) {
    if (!known.has(id)) {
      violations.push(
        violation(
          HEARING_STEP1B_COMPANION_RULE,
          HEARING_CATALOG_PATH,
          `Step 1B item ${id} has no entry in ONBOARDING_STEP1B_COMPANIONS; ` +
            'add its companion heading in src/scripts/repository-schema-audit.mts',
        ),
      );
    }
  }
  for (const id of known) {
    if (!declared.has(id)) {
      violations.push(
        violation(
          HEARING_STEP1B_COMPANION_RULE,
          HEARING_CATALOG_PATH,
          `ONBOARDING_STEP1B_COMPANIONS names ${id}, which is not a Step 1B ` +
            'item of the hearing catalog',
        ),
      );
    }
  }
  return violations;
}
/** HEARING-STEP1B-COMPANION over the hearing catalog and the policy-decisions guide. */
export function checkHearingStep1bCompanion(root) {
  const violations = [];
  const catalog = readJson(
    HEARING_STEP1B_COMPANION_RULE,
    root,
    HEARING_CATALOG_PATH,
    violations,
  );
  const doc = readText(
    HEARING_STEP1B_COMPANION_RULE,
    root,
    POLICY_DECISIONS_DOC_PATH,
    violations,
  );
  if (catalog === undefined || doc === null) {
    return { ruleId: HEARING_STEP1B_COMPANION_RULE, inspected: 0, violations };
  }
  const items = Array.isArray(catalog?.items) ? catalog.items : null;
  if (items === null) {
    violations.push(
      inspectionViolation(
        HEARING_STEP1B_COMPANION_RULE,
        HEARING_CATALOG_PATH,
        'the catalog has no items array',
      ),
    );
    return { ruleId: HEARING_STEP1B_COMPANION_RULE, inspected: 0, violations };
  }
  const catalogIds = items
    .filter((item) => item?.step === '1B' && typeof item.id === 'string')
    .map((item) => item.id);
  if (catalogIds.length === 0) {
    violations.push(
      inspectionViolation(
        HEARING_STEP1B_COMPANION_RULE,
        HEARING_CATALOG_PATH,
        'no Step 1B item to inspect; an empty inventory would pass vacuously',
      ),
    );
  }
  violations.push(
    ...detectStep1bCatalogDrift(catalogIds, ONBOARDING_STEP1B_COMPANIONS),
    ...detectStep1bCompanionDrift(doc, ONBOARDING_STEP1B_COMPANIONS),
  );
  return {
    ruleId: HEARING_STEP1B_COMPANION_RULE,
    inspected: catalogIds.length,
    violations,
  };
}
/**
 * PHASE-GRAPH-NORMALIZED detector: node ids stay unique, and every edge still
 * names a node, once each id and edge is normalized.
 */
export function detectPhaseGraphNormalizationDrift(nodes, normalize) {
  const violations = [];
  const normalizedIds = nodes.map((node) => normalize(node.id));
  const nodeSet = new Set(normalizedIds);
  if (nodeSet.size !== normalizedIds.length) {
    violations.push(
      violation(
        PHASE_GRAPH_NORMALIZED_RULE,
        PHASE_GRAPH_PATH,
        'phase-graph IDs must stay unique after normalization',
      ),
    );
  }
  for (const node of nodes) {
    for (const edge of node.next) {
      const normalizedEdge = normalize(edge);
      if (!nodeSet.has(normalizedEdge)) {
        violations.push(
          violation(
            PHASE_GRAPH_NORMALIZED_RULE,
            PHASE_GRAPH_PATH,
            `normalized edge ${edge} -> ${normalizedEdge} is not defined in graph nodes`,
          ),
        );
      }
    }
  }
  return violations;
}
/** PHASE-GRAPH-NORMALIZED over the live phase graph. */
export function checkPhaseGraphNormalized(root, dependencies) {
  const violations = [];
  const graph = readJson(
    PHASE_GRAPH_NORMALIZED_RULE,
    root,
    PHASE_GRAPH_PATH,
    violations,
  );
  if (graph === undefined) {
    return { ruleId: PHASE_GRAPH_NORMALIZED_RULE, inspected: 0, violations };
  }
  const nodes = graph?.nodes;
  const wellFormed =
    Array.isArray(nodes) &&
    nodes.every(
      (node) =>
        typeof node?.id === 'string' &&
        Array.isArray(node?.next) &&
        node.next.every((edge) => typeof edge === 'string'),
    );
  if (!wellFormed || nodes.length === 0) {
    violations.push(
      inspectionViolation(
        PHASE_GRAPH_NORMALIZED_RULE,
        PHASE_GRAPH_PATH,
        'expected a non-empty nodes array of { id: string, next: string[] }',
      ),
    );
    return { ruleId: PHASE_GRAPH_NORMALIZED_RULE, inspected: 0, violations };
  }
  violations.push(
    ...detectPhaseGraphNormalizationDrift(nodes, dependencies.normalizePhaseId),
  );
  return {
    ruleId: PHASE_GRAPH_NORMALIZED_RULE,
    inspected: nodes.length,
    violations,
  };
}
/** The first documented `"route": "A|B|..."` enum of the resume helper. */
export function extractResumeRouteEnum(sourceText) {
  const match = sourceText.match(/"route":\s*"([^"]+)"/);
  if (match === null) {
    return null;
  }
  return (match[1] ?? '')
    .split('|')
    .map((route) => route.trim())
    .filter(Boolean);
}
/** Every `route: '...'` literal of the resume helper's decision table. */
export function extractResumeDecisionRoutes(sourceText) {
  return [...sourceText.matchAll(/route:\s*'([^']+)'/g)].map(
    (entry) => entry[1],
  );
}
function resolverErrorCode(error) {
  return error?.code;
}
/**
 * RESUME-ROUTE-ENUM detector. The documented enum and the decision table must
 * list the same routes (as sets) and include `Esync`; every phase route must
 * resolve canonically to itself; the terminal `stop` sentinel and the bare `A`
 * routing-graph node must stay unresolvable (`unknown_phase_id`).
 */
export function detectResumeRouteDrift(documentedRoutes, tableRoutes, resolve) {
  const violations = [];
  const report = (message) => {
    violations.push(
      violation(RESUME_ROUTE_ENUM_RULE, RESUME_ROUTE_SOURCE_PATH, message),
    );
  };
  const documented = [...new Set(documentedRoutes)].sort();
  const table = [...new Set(tableRoutes)].sort();
  if (JSON.stringify(documented) !== JSON.stringify(table)) {
    report(
      'resume-route-selection help enum and decision table must list the ' +
        `same routes (help enum: ${documented.join('|')}; decision table: ` +
        `${table.join('|')})`,
    );
  }
  if (!documentedRoutes.includes('Esync')) {
    report('resume-route-selection route enum must include Esync');
  }
  const expectUnknown = (route, why) => {
    try {
      resolve(route);
    } catch (error) {
      if (resolverErrorCode(error) === 'unknown_phase_id') {
        return;
      }
    }
    report(`${route} must not resolve as a canonical phase id (${why})`);
  };
  for (const route of documentedRoutes) {
    if (RESUME_TERMINAL_SENTINELS.has(route)) {
      expectUnknown(route, 'a terminal stop sentinel, not a phase');
      continue;
    }
    let resolution;
    try {
      resolution = resolve(route);
    } catch (error) {
      report(
        `resume route ${route} must resolve through the phase-id resolver: ${describeError(error)}`,
      );
      continue;
    }
    // Assert canonical self-resolution, not merely "resolves to some canonical
    // id": resume routes are themselves canonical phases, so a route wired up
    // as a legacy alias must fail rather than silently pass.
    if (resolution.matchedBy !== 'canonical') {
      report(
        `resume route ${route} must stay canonical in the phase-id resolver`,
      );
    }
    if (resolution.canonicalPhaseId !== route) {
      report(`resume route ${route} must resolve to itself`);
    }
  }
  expectUnknown(BARE_COLLAPSED_PHASE, 'the collapsed routing-graph-only node');
  return violations;
}
/** RESUME-ROUTE-ENUM over the resume-route selection helper's source. */
export function checkResumeRouteEnum(root, dependencies) {
  const violations = [];
  const source = readText(
    RESUME_ROUTE_ENUM_RULE,
    root,
    RESUME_ROUTE_SOURCE_PATH,
    violations,
  );
  if (source === null) {
    return { ruleId: RESUME_ROUTE_ENUM_RULE, inspected: 0, violations };
  }
  const documented = extractResumeRouteEnum(source);
  const table = extractResumeDecisionRoutes(source);
  if (documented === null || documented.length === 0) {
    violations.push(
      inspectionViolation(
        RESUME_ROUTE_ENUM_RULE,
        RESUME_ROUTE_SOURCE_PATH,
        'the helper must document its route enum as "route": "..."',
      ),
    );
  }
  if (table.length === 0) {
    violations.push(
      inspectionViolation(
        RESUME_ROUTE_ENUM_RULE,
        RESUME_ROUTE_SOURCE_PATH,
        'decisionTable() must list route literals',
      ),
    );
  }
  if (documented === null || documented.length === 0 || table.length === 0) {
    return { ruleId: RESUME_ROUTE_ENUM_RULE, inspected: 0, violations };
  }
  violations.push(
    ...detectResumeRouteDrift(documented, table, dependencies.resolvePhase),
  );
  return {
    ruleId: RESUME_ROUTE_ENUM_RULE,
    inspected: documented.length,
    violations,
  };
}
/** Runs every rule family against the repository at `root`. */
export function runSchemaAuditRules(root, dependencies = DEFAULT_DEPENDENCIES) {
  return [
    checkSchemaTypeCatalog(root),
    checkSchemaOutputCoverage(root),
    checkSchemaJournalPattern(root),
    checkHearingPlaceholderDoc(root),
    checkHearingStep1bCompanion(root),
    checkPhaseGraphNormalized(root, dependencies),
    checkResumeRouteEnum(root, dependencies),
  ];
}
/** Code-unit order, so the report never depends on the process locale. */
function compareText(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
/** Every violation of the given rule results, ordered by rule, path and message. */
export function sortSchemaAuditViolations(results) {
  return results
    .flatMap((result) => result.violations)
    .sort(
      (a, b) =>
        compareText(a.ruleId, b.ruleId) ||
        compareText(a.path, b.path) ||
        compareText(a.message, b.message),
    );
}
/** Runs every rule once and returns every violation, in report order. */
// audit:ignore-dead-export: audit-docs loads this through a guarded dynamic import of the generated artifact, which the static audit cannot follow
export function collectRepositorySchemaViolations(
  root,
  dependencies = DEFAULT_DEPENDENCIES,
) {
  return sortSchemaAuditViolations(runSchemaAuditRules(root, dependencies));
}
const USAGE =
  'usage: node scripts/repository-schema-audit.mjs [--root <repository>] [--help]\n';
/** CLI entry: exit 0 clean, 1 on any violation, 2 on a usage error. */
export function runRepositorySchemaAuditCli(argv = process.argv.slice(2)) {
  let root = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        process.stderr.write(
          'repository-schema-audit: --root requires a directory path\n',
        );
        return 2;
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    process.stderr.write(
      `repository-schema-audit: unknown argument: ${argument}\n`,
    );
    return 2;
  }
  // The default root is resolved only when no --root was given, so a copy of
  // this script outside a checkout can still inspect an explicit tree.
  try {
    root = root ?? resolveBundleRoot(import.meta.dirname);
  } catch (error) {
    process.stderr.write(`repository-schema-audit: ${describeError(error)}\n`);
    return 2;
  }
  const results = runSchemaAuditRules(root);
  const violations = sortSchemaAuditViolations(results);
  if (violations.length > 0) {
    for (const item of violations) {
      process.stderr.write(`${item.ruleId} ${item.path}: ${item.message}\n`);
    }
    process.stderr.write(
      `repository-schema-audit: ${violations.length} violation(s)\n`,
    );
    return 1;
  }
  for (const result of results) {
    process.stdout.write(
      `repository-schema-audit: ${result.ruleId} inspected ${result.inspected}\n`,
    );
  }
  process.stdout.write(
    'repository-schema-audit: all schema agreements passed\n',
  );
  return 0;
}
if (import.meta.main) {
  process.exitCode = runRepositorySchemaAuditCli();
}
