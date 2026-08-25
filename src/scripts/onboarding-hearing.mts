// idd-generated-from: src/scripts/onboarding-hearing.mts
//
// The scripts/onboarding-hearing.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Onboarding hearing catalog loader (#2279). Reads the canonical catalog
// from the package root, type-checks it against
// schemas/onboarding-hearing-catalog.schema.json, and exports the item
// list. Later CLI issues import this module instead of parsing the JSON
// ad hoc. Not a HELPER_COMMANDS entry.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadJson, validate } from './validate-schemas.mts';

/** Onboarding step a catalog item belongs to. */
export type HearingCatalogStep = '0' | '1A' | '1B' | '1C';

/** Kind of hearing item. */
export type HearingCatalogKind = 'check' | 'placeholder' | 'policy';

/** One enum choice on a policy or confirmation item. */
export interface HearingCatalogOption {
  value: string;
  isDefault?: boolean;
}

/** One catalog item. */
export interface HearingCatalogItem {
  id: string;
  step: HearingCatalogStep;
  kind: HearingCatalogKind;
  prompt: string;
  explanation: string;
  options?: readonly HearingCatalogOption[];
  derivationHook?: string;
  mapsToPlaceholder?: string;
  mapsToConfig?: string;
}

/** Canonical hearing catalog document. */
export interface OnboardingHearingCatalog {
  version: string;
  items: readonly HearingCatalogItem[];
}

/** Confirmed answer for one catalog item. */
export interface OnboardingHearingAnswer {
  id: string;
  value: string;
}

/** Confirmed onboarding hearing transcript. */
export interface OnboardingHearingTranscript {
  version: string;
  confirmedAt?: string;
  answers: readonly OnboardingHearingAnswer[];
}

/** Catalog path relative to the package root. */
export const ONBOARDING_HEARING_CATALOG_RELATIVE_PATH =
  'idd-template/docs/onboarding/hearing-catalog.json';

function resolveRepoRoot(fromDir: string): string {
  let dir = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}

const ROOT = resolveRepoRoot(import.meta.dirname);

function isHearingCatalogStep(value: unknown): value is HearingCatalogStep {
  return value === '0' || value === '1A' || value === '1B' || value === '1C';
}

function isHearingCatalogKind(value: unknown): value is HearingCatalogKind {
  return value === 'check' || value === 'placeholder' || value === 'policy';
}

function parseOption(value: unknown): HearingCatalogOption {
  if (typeof value !== 'object' || value === null) {
    throw new Error('hearing catalog option is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.value !== 'string' || record.value.length === 0) {
    throw new Error('hearing catalog option is missing value');
  }
  const option: HearingCatalogOption = { value: record.value };
  if (record.isDefault === true) {
    option.isDefault = true;
  }
  return option;
}

function parseItem(value: unknown): HearingCatalogItem {
  if (typeof value !== 'object' || value === null) {
    throw new Error('hearing catalog item is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error('hearing catalog item is missing id');
  }
  if (!isHearingCatalogStep(record.step)) {
    throw new Error(`hearing catalog item ${record.id} has invalid step`);
  }
  if (!isHearingCatalogKind(record.kind)) {
    throw new Error(`hearing catalog item ${record.id} has invalid kind`);
  }
  if (typeof record.prompt !== 'string' || record.prompt.length === 0) {
    throw new Error(`hearing catalog item ${record.id} is missing prompt`);
  }
  if (
    typeof record.explanation !== 'string' ||
    record.explanation.length === 0
  ) {
    throw new Error(`hearing catalog item ${record.id} is missing explanation`);
  }
  const item: HearingCatalogItem = {
    id: record.id,
    step: record.step,
    kind: record.kind,
    prompt: record.prompt,
    explanation: record.explanation,
  };
  if (Array.isArray(record.options)) {
    item.options = record.options.map(parseOption);
  }
  if (typeof record.derivationHook === 'string') {
    item.derivationHook = record.derivationHook;
  }
  if (typeof record.mapsToPlaceholder === 'string') {
    item.mapsToPlaceholder = record.mapsToPlaceholder;
  }
  if (typeof record.mapsToConfig === 'string') {
    item.mapsToConfig = record.mapsToConfig;
  }
  return item;
}

/**
 * Load and type-check the canonical hearing catalog from the package
 * root. Throws when the file is missing, not JSON, fails schema
 * validation, or cannot be narrowed to OnboardingHearingCatalog.
 */
export function loadOnboardingHearingCatalog(): OnboardingHearingCatalog {
  const catalogPath = join(ROOT, ONBOARDING_HEARING_CATALOG_RELATIVE_PATH);
  const schema = loadJson('schemas/onboarding-hearing-catalog.schema.json');
  const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
  const errors = validate(raw, schema);
  if (errors.length > 0) {
    throw new Error(
      `hearing catalog failed schema validation: ${errors.join('; ')}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('hearing catalog is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.version !== 'string') {
    throw new Error('hearing catalog is missing version');
  }
  if (!Array.isArray(record.items)) {
    throw new Error('hearing catalog is missing items');
  }
  return {
    version: record.version,
    items: record.items.map(parseItem),
  };
}

/** Item list from the canonical catalog. */
export function loadOnboardingHearingItems(): readonly HearingCatalogItem[] {
  return loadOnboardingHearingCatalog().items;
}
