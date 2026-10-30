import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateFixture } from '../src/scripts/validate-schemas.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTION_SCHEMA = 'schemas/distribution-selection.schema.json';
const GIST_URL =
  'https://gist.github.com/kurone-kito/9f2d7871542cb2f7a255f92a7c1232d0';

type Verdict =
  | 'coherent-candidate'
  | 'distinct-builds'
  | 'not-verified-usable'
  | 'pin-preserved'
  | 'session-bound'
  | 'migration-required'
  | 'preparation-missing';
type SelectionIdentity = {
  sourceCommit: string;
  components: Record<string, unknown>;
};
type SelectionReport = {
  schemaVersion: 1;
  repository: string | null;
  session: { id: string; binding: 'bound' | 'unbound' };
  verdict: Verdict;
  selected: SelectionIdentity | null;
  previousVerifiedSet: SelectionIdentity | null;
  packageVersion: string | null;
  preparation: 'prepared' | 'preparation-missing' | 'not-applicable';
  compatibility: 'compatible' | 'incompatible' | 'unknown';
  source:
    | 'repository-pin'
    | 'repository-local'
    | 'global-current'
    | 'installed-bundle'
    | 'legacy-receipt'
    | 'unknown';
  recovery: 'none' | 'prepare' | 'migrate' | 'reselect';
  receipt: {
    status: 'verified' | 'absent' | 'unsupported-legacy' | 'conflict';
  };
  mutation: 'none';
};

type ManifestFile = { path: string; sha256: string };
type ManifestComponent = {
  location: string;
  provenance: { kind: string; commit: string };
  files: ManifestFile[];
  digest: string;
  invocation?: { command: string; argv: string[] };
};
type DistributionManifest = {
  sourceCommit: string;
  components: {
    instructions: ManifestComponent;
    skillBundles: Record<string, ManifestComponent>;
    helper: ManifestComponent & {
      invocation: { command: string; argv: string[] };
    };
  };
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

function checkSelectionRules(
  report: SelectionReport,
): Array<{ rule: number; message: string }> {
  const violations: Array<{ rule: number; message: string }> = [];
  const add = (rule: number, message: string) => {
    violations.push({ rule, message });
  };
  const nullSelectedVerdicts = new Set<Verdict>([
    'distinct-builds',
    'not-verified-usable',
    'migration-required',
  ]);
  if (nullSelectedVerdicts.has(report.verdict) !== (report.selected === null)) {
    add(1, 'selected must match the verdict identity requirements');
  }

  if (
    ['coherent-candidate', 'pin-preserved', 'session-bound'].includes(
      report.verdict,
    ) &&
    report.preparation !== 'prepared'
  ) {
    add(2, 'usable candidate verdicts require prepared state');
  }
  if (
    report.verdict === 'preparation-missing' &&
    report.preparation !== 'preparation-missing'
  ) {
    add(2, 'preparation-missing verdict requires missing preparation');
  }
  if (
    (report.selected === null) !==
    (report.preparation === 'not-applicable')
  ) {
    add(2, 'not-applicable preparation requires no selected identity');
  }
  if (
    report.verdict === 'session-bound' &&
    report.session.binding !== 'bound'
  ) {
    add(3, 'session-bound verdict requires a bound session');
  }
  if (
    report.verdict === 'pin-preserved' &&
    report.source !== 'repository-pin'
  ) {
    add(4, 'pin-preserved verdict requires repository-pin source');
  }
  if (
    (report.recovery === 'prepare') !==
    (report.verdict === 'preparation-missing')
  ) {
    add(5, 'prepare recovery applies exactly to preparation-missing verdict');
  }
  if (report.verdict === 'distinct-builds' && report.packageVersion === null) {
    add(6, 'distinct-builds requires a package version');
  }
  if (
    report.compatibility === 'incompatible' &&
    report.verdict !== 'not-verified-usable'
  ) {
    add(7, 'incompatible selection requires not-verified-usable');
  }
  if (
    report.recovery === 'reselect' &&
    report.verdict !== 'not-verified-usable'
  ) {
    add(8, 'reselect recovery requires not-verified-usable');
  }
  if (
    (report.recovery === 'migrate') !==
    (report.verdict === 'migration-required')
  ) {
    add(9, 'migrate recovery applies exactly to migration-required verdict');
  }
  if (
    ['legacy-receipt', 'unknown'].includes(report.source) &&
    !['migration-required', 'not-verified-usable'].includes(report.verdict)
  ) {
    add(10, 'unsupported sources require migration or unusable verdict');
  }
  if (report.compatibility === 'compatible' && report.selected === null) {
    add(11, 'compatible selection requires a selected identity');
  }
  if (
    report.receipt.status === 'unsupported-legacy' &&
    !['migration-required', 'not-verified-usable'].includes(report.verdict)
  ) {
    add(
      12,
      'unsupported legacy receipt requires migration or unusable verdict',
    );
  }
  if (
    report.receipt.status === 'conflict' &&
    report.verdict !== 'not-verified-usable'
  ) {
    add(12, 'conflicting receipt requires not-verified-usable');
  }
  if (
    report.session.binding === 'bound' &&
    ![
      'session-bound',
      'preparation-missing',
      'migration-required',
      'not-verified-usable',
    ].includes(report.verdict)
  ) {
    add(13, 'bound sessions require a supported verdict');
  }
  if (
    report.source === 'repository-pin' &&
    (report.repository === null ||
      ![
        'pin-preserved',
        'session-bound',
        'preparation-missing',
        'migration-required',
        'not-verified-usable',
      ].includes(report.verdict))
  ) {
    add(
      14,
      'repository-pin source requires a repository and supported verdict',
    );
  }
  return violations;
}

function checkManifestRules(
  manifest: DistributionManifest,
): Array<{ rule: string; message: string }> {
  const violations: Array<{ rule: string; message: string }> = [];
  const add = (rule: string, message: string) => {
    violations.push({ rule, message });
  };
  const components = [
    manifest.components.instructions,
    ...Object.values(manifest.components.skillBundles),
    manifest.components.helper,
  ];

  if (
    components.some(
      (component) => component.provenance.commit !== manifest.sourceCommit,
    )
  ) {
    add('M1', 'component provenance commits must match sourceCommit');
  }

  const commitInLocation = /\/(?:tree|blob)\/([^/]+)(?:\/|$)/u;
  if (
    components.some((component) => {
      const match = commitInLocation.exec(component.location);
      return !match || match[1] !== manifest.sourceCommit;
    })
  ) {
    add('M2', 'component URL commit segments must match sourceCommit');
  }

  if (
    components.some((component) => {
      const seen = new Set<string>();
      return component.files.some((file) => {
        const segments = file.path.split('/');
        const invalid =
          seen.has(file.path) ||
          file.path.startsWith('/') ||
          file.path.includes('\\') ||
          segments.includes('..');
        seen.add(file.path);
        return invalid;
      });
    })
  ) {
    add('M3', 'component file paths must be unique safe relative paths');
  }

  if (
    !manifest.components.helper.files.some(
      (file) => file.path === manifest.components.helper.invocation.command,
    )
  ) {
    add('M4', 'helper invocation command must name a listed helper file');
  }

  return violations;
}

function routeFixture(name: string): SelectionReport {
  return readJson<SelectionReport>(`fixtures/distribution/${name}`);
}

test('distribution selection section states route precedence and provenance', () => {
  const document = readFileSync(
    join(ROOT, 'docs/user-global-install.md'),
    'utf8',
  );
  const selectionHeading = document.indexOf('## Distribution selection');
  const activationHeading = document.indexOf(
    '## Activation gate and context cost',
  );
  const ciHeading = document.indexOf('## CI off switches');
  assert.ok(selectionHeading > activationHeading);
  assert.ok(selectionHeading < ciHeading);

  const section = document
    .slice(selectionHeading, ciHeading)
    .replace(/\s+/gu, ' ');
  const tokens = [
    'none',
    'prepare',
    'migrate',
    'reselect',
    'repository-pin',
    'repository-local',
    'global-current',
    'installed-bundle',
    'legacy-receipt',
    'unknown',
    'preparation-missing',
    'not-applicable',
    'session-bound',
    'pin-preserved',
    'previousVerifiedSet',
    'readReceipt',
    'writeReceipt',
  ];
  for (const token of tokens) {
    assert.ok(section.includes(`\`${token}\``), token);
  }
  const phrases = [
    'read-only',
    'mixed commits',
    'no automatic state rewrite',
    'no global latest upgrade',
    'run-time enforcement',
    'finding 12',
    '#4694',
    GIST_URL,
    '2026-10-25',
  ];
  for (const phrase of phrases) {
    assert.ok(section.includes(phrase), phrase);
  }
});

test('four route fixtures match their expected reports and validate', () => {
  const manifest = readJson<DistributionManifest>(
    'fixtures/schemas/distribution-manifest.valid.json',
  );
  const identity: SelectionIdentity = {
    sourceCommit: manifest.sourceCommit,
    components: manifest.components,
  };
  const expected: ReadonlyArray<{
    name: string;
    report: SelectionReport;
  }> = [
    {
      name: 'route-standalone.json',
      report: {
        schemaVersion: 1,
        repository: null,
        session: { id: 'standalone-session', binding: 'unbound' },
        verdict: 'coherent-candidate',
        selected: identity,
        previousVerifiedSet: null,
        packageVersion: null,
        preparation: 'prepared',
        compatibility: 'compatible',
        source: 'installed-bundle',
        recovery: 'none',
        receipt: { status: 'verified' },
        mutation: 'none',
      },
    },
    {
      name: 'route-inactive.json',
      report: {
        schemaVersion: 1,
        repository: 'kurone-kito/idd-skill',
        session: { id: 'inactive-session', binding: 'unbound' },
        verdict: 'coherent-candidate',
        selected: identity,
        previousVerifiedSet: null,
        packageVersion: null,
        preparation: 'prepared',
        compatibility: 'compatible',
        source: 'installed-bundle',
        recovery: 'none',
        receipt: { status: 'verified' },
        mutation: 'none',
      },
    },
    {
      name: 'route-authoring.json',
      report: {
        schemaVersion: 1,
        repository: 'kurone-kito/idd-skill',
        session: { id: 'authoring-session', binding: 'unbound' },
        verdict: 'preparation-missing',
        selected: identity,
        previousVerifiedSet: null,
        packageVersion: null,
        preparation: 'preparation-missing',
        compatibility: 'compatible',
        source: 'global-current',
        recovery: 'prepare',
        receipt: { status: 'absent' },
        mutation: 'none',
      },
    },
    {
      name: 'route-repository-local.json',
      report: {
        schemaVersion: 1,
        repository: 'kurone-kito/idd-skill',
        session: { id: 'repository-local-session', binding: 'unbound' },
        verdict: 'migration-required',
        selected: null,
        previousVerifiedSet: null,
        packageVersion: null,
        preparation: 'not-applicable',
        compatibility: 'unknown',
        source: 'repository-local',
        recovery: 'migrate',
        receipt: { status: 'unsupported-legacy' },
        mutation: 'none',
      },
    },
  ];

  for (const item of expected) {
    const actual = routeFixture(item.name);
    assert.deepEqual(actual, item.report, item.name);
    assert.deepEqual(checkSelectionRules(actual), [], item.name);
    assert.deepEqual(
      validateFixture(
        SELECTION_SCHEMA,
        `fixtures/distribution/${item.name}`,
        true,
        ROOT,
      ),
      { ok: true, errors: [] },
      item.name,
    );
  }
});

test('all fourteen selection rules reject one focused invalid report each', () => {
  const base = readJson<SelectionReport>(
    'fixtures/schemas/distribution-selection.valid.json',
  );
  const mutations: ReadonlyArray<{
    rule: number;
    mutate: (report: SelectionReport) => void;
  }> = [
    {
      rule: 1,
      mutate: (report) => {
        report.verdict = 'migration-required';
        report.recovery = 'migrate';
      },
    },
    {
      rule: 2,
      mutate: (report) => {
        report.preparation = 'not-applicable';
      },
    },
    {
      rule: 3,
      mutate: (report) => {
        report.session.binding = 'unbound';
      },
    },
    {
      rule: 4,
      mutate: (report) => {
        report.verdict = 'pin-preserved';
        report.session.binding = 'unbound';
        report.source = 'global-current';
      },
    },
    {
      rule: 5,
      mutate: (report) => {
        report.recovery = 'prepare';
      },
    },
    {
      rule: 6,
      mutate: (report) => {
        report.verdict = 'distinct-builds';
        report.selected = null;
        report.session.binding = 'unbound';
        report.packageVersion = null;
        report.preparation = 'not-applicable';
        report.compatibility = 'unknown';
        report.source = 'global-current';
      },
    },
    {
      rule: 7,
      mutate: (report) => {
        report.compatibility = 'incompatible';
      },
    },
    {
      rule: 8,
      mutate: (report) => {
        report.recovery = 'reselect';
      },
    },
    {
      rule: 9,
      mutate: (report) => {
        report.recovery = 'migrate';
      },
    },
    {
      rule: 10,
      mutate: (report) => {
        report.source = 'unknown';
      },
    },
    {
      rule: 11,
      mutate: (report) => {
        report.verdict = 'not-verified-usable';
        report.selected = null;
        report.preparation = 'not-applicable';
        report.session.binding = 'unbound';
        report.source = 'global-current';
        report.compatibility = 'compatible';
      },
    },
    {
      rule: 12,
      mutate: (report) => {
        report.receipt.status = 'unsupported-legacy';
      },
    },
    {
      rule: 13,
      mutate: (report) => {
        report.verdict = 'coherent-candidate';
        report.session.binding = 'bound';
        report.source = 'global-current';
      },
    },
    {
      rule: 14,
      mutate: (report) => {
        report.verdict = 'pin-preserved';
        report.repository = null;
        report.session.binding = 'unbound';
      },
    },
  ];

  assert.deepEqual(checkSelectionRules(base), []);
  for (const item of mutations) {
    const invalid = structuredClone(base);
    item.mutate(invalid);
    const violations = checkSelectionRules(invalid);
    assert.ok(
      violations.some((violation) => violation.rule === item.rule),
      `rule ${item.rule}`,
    );
  }
});

test('unknown compatibility permits either previousVerifiedSet value', () => {
  const base = readJson<SelectionReport>(
    'fixtures/schemas/distribution-selection.valid.json',
  );
  const unknownWithPrevious = structuredClone(base);
  unknownWithPrevious.compatibility = 'unknown';
  unknownWithPrevious.previousVerifiedSet = structuredClone(base.selected);
  assert.deepEqual(checkSelectionRules(unknownWithPrevious), []);

  const unknownWithoutPrevious = structuredClone(base);
  unknownWithoutPrevious.compatibility = 'unknown';
  unknownWithoutPrevious.previousVerifiedSet = null;
  assert.deepEqual(checkSelectionRules(unknownWithoutPrevious), []);
});

test('manifest M1 rejects a component provenance commit mismatch', () => {
  const manifest = readJson<DistributionManifest>(
    'fixtures/schemas/distribution-manifest.valid.json',
  );
  assert.deepEqual(checkManifestRules(manifest), []);
  const invalid = structuredClone(manifest);
  invalid.components.instructions.provenance.commit = 'f'.repeat(40);
  assert.deepEqual(
    checkManifestRules(invalid).map((violation) => violation.rule),
    ['M1'],
  );
});

test('manifest M2 checks the commit segment in each location', () => {
  const manifest = readJson<DistributionManifest>(
    'fixtures/schemas/distribution-manifest.valid.json',
  );
  const invalid = structuredClone(manifest);
  invalid.components.instructions.location =
    'https://github.com/kurone-kito/idd-skill/' +
    manifest.sourceCommit +
    '/tree/' +
    'f'.repeat(40) +
    '/idd-template';
  assert.deepEqual(
    checkManifestRules(invalid).map((violation) => violation.rule),
    ['M2'],
  );
});

test('manifest M3 rejects duplicate and unsafe file paths', () => {
  const manifest = readJson<DistributionManifest>(
    'fixtures/schemas/distribution-manifest.valid.json',
  );
  const duplicate = structuredClone(manifest);
  const firstDuplicateFile = duplicate.components.instructions.files[0];
  assert.ok(firstDuplicateFile);
  duplicate.components.instructions.files.push(
    structuredClone(firstDuplicateFile),
  );
  assert.deepEqual(
    checkManifestRules(duplicate).map((violation) => violation.rule),
    ['M3'],
  );

  for (const path of ['/README.md', 'docs\\README.md', 'docs/../README.md']) {
    const invalid = structuredClone(manifest);
    const firstFile = invalid.components.instructions.files[0];
    assert.ok(firstFile);
    firstFile.path = path;
    assert.deepEqual(
      checkManifestRules(invalid).map((violation) => violation.rule),
      ['M3'],
      path,
    );
  }
  const allowed = structuredClone(manifest);
  const firstAllowedFile = allowed.components.instructions.files[0];
  assert.ok(firstAllowedFile);
  firstAllowedFile.path = 'docs/a..b.md';
  assert.deepEqual(checkManifestRules(allowed), []);
});

test('manifest M4 requires the helper invocation to name a listed file', () => {
  const manifest = readJson<DistributionManifest>(
    'fixtures/schemas/distribution-manifest.valid.json',
  );
  const invalid = structuredClone(manifest);
  invalid.components.helper.invocation.command = 'bin/missing.mjs';
  assert.deepEqual(
    checkManifestRules(invalid).map((violation) => violation.rule),
    ['M4'],
  );
});
