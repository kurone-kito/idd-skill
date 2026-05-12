#!/usr/bin/env node

const DEFAULT_CANONICAL_PHASE_IDS = [
  "A0",
  "A0_O",
  "A0_T",
  "A1",
  "A1_5",
  "A2",
  "A3",
  "A3_5",
  "A4",
  "A4_5",
  "A5",
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "D1",
  "D2",
  "D3",
  "D4",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "E7",
  "E8",
  "E9",
  "E10",
  "E11",
  "E12",
  "E13",
  "E14",
  "E15",
  "F1",
  "F2",
  "F2_5",
  "F3",
  "F4",
  "F5",
];

const DEFAULT_LEGACY_ALIASES = {
  A0_O: ["A0-O", "A0O"],
  A0_T: ["A0-T", "A0T"],
  A1_5: ["A1.5", "A1-5", "A15"],
  A3_5: ["A3.5", "A3-5", "A35"],
  A4_5: ["A4.5", "A4-5", "A45"],
  F2_5: ["F2.5", "F2-5", "F25"],
};

if (isCliExecution()) {
  runCli();
}

export function resolvePhaseId(input, options = {}) {
  const resolver = createPhaseIdResolver(options);
  return resolver.resolve(input);
}

export function createPhaseIdResolver({
  canonicalPhaseIds = DEFAULT_CANONICAL_PHASE_IDS,
  legacyAliases = DEFAULT_LEGACY_ALIASES,
} = {}) {
  const canonicalByKey = new Map();
  const aliasHits = new Map();
  const canonicalOrder = [];
  const legacyAliasMap = {};

  for (const candidate of canonicalPhaseIds) {
    const normalized = normalizePhaseIdToken(candidate, { allowEmpty: false });
    if (!isCanonicalToken(normalized)) {
      throw buildResolverError(
        "invalid_canonical_phase_id",
        `Canonical phase ID must be alphanumeric with underscores: ${candidate}`,
      );
    }
    if (canonicalByKey.has(normalized)) {
      continue;
    }
    canonicalByKey.set(normalized, normalized);
    canonicalOrder.push(normalized);
  }

  for (const [canonical, aliases] of Object.entries(legacyAliases ?? {})) {
    const normalizedCanonical = normalizePhaseIdToken(canonical, { allowEmpty: false });
    if (!canonicalByKey.has(normalizedCanonical)) {
      throw buildResolverError(
        "unknown_canonical_phase_id",
        `Legacy aliases reference unknown canonical phase ID: ${canonical}`,
      );
    }
    const list = Array.isArray(aliases) ? aliases : [aliases];
    for (const alias of list) {
      const normalizedAlias = normalizeAliasToken(alias);
      if (normalizedAlias === normalizedCanonical) {
        continue;
      }
      const owners = aliasHits.get(normalizedAlias) ?? new Set();
      owners.add(normalizedCanonical);
      aliasHits.set(normalizedAlias, owners);
      if (!legacyAliasMap[normalizedCanonical]) {
        legacyAliasMap[normalizedCanonical] = [];
      }
      if (!legacyAliasMap[normalizedCanonical].includes(normalizedAlias)) {
        legacyAliasMap[normalizedCanonical].push(normalizedAlias);
      }
    }
  }

  const ambiguousAliases = [...aliasHits.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([alias, owners]) => ({
      alias,
      canonicalPhaseIds: [...owners].sort(),
    }));
  if (ambiguousAliases.length > 0) {
    throw buildResolverError(
      "ambiguous_alias_configuration",
      `Legacy alias map contains ambiguous entries: ${ambiguousAliases
        .map((entry) => `${entry.alias}=>${entry.canonicalPhaseIds.join("|")}`)
        .join(", ")}`,
      { ambiguousAliases },
    );
  }

  const aliasToCanonical = new Map(
    [...aliasHits.entries()].map(([alias, owners]) => [alias, [...owners][0]]),
  );

  return {
    canonicalPhaseIds: canonicalOrder,
    legacyAliasMap,
    resolve(rawInput) {
      const aliasInputKey = normalizeAliasToken(rawInput);
      const normalizedInput = normalizePhaseIdToken(rawInput, { allowEmpty: false });
      if (!isSupportedInputToken(String(rawInput ?? ""))) {
        throw buildResolverError(
          "invalid_phase_id",
          `Phase ID contains unsupported characters: ${String(rawInput)}`,
        );
      }

      if (isCanonicalToken(aliasInputKey) && canonicalByKey.has(aliasInputKey)) {
        return {
          canonicalPhaseId: canonicalByKey.get(aliasInputKey),
          matchedBy: "canonical",
          normalizedInput,
        };
      }

      const aliasCanonical = aliasToCanonical.get(aliasInputKey);
      if (aliasCanonical) {
        return {
          canonicalPhaseId: aliasCanonical,
          matchedBy: "legacy-alias",
          normalizedInput,
        };
      }

      throw buildResolverError(
        "unknown_phase_id",
        `Unknown phase ID: ${String(rawInput)} (normalized: ${normalizedInput})`,
        { normalizedInput },
      );
    },
  };
}

export function normalizePhaseIdToken(input, { allowEmpty = true } = {}) {
  const source = String(input ?? "");
  const normalized = source
    .trim()
    .toUpperCase()
    .replace(/[.\-/:\\\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!allowEmpty && normalized.length === 0) {
    throw buildResolverError("invalid_phase_id", "Phase ID must not be empty.");
  }
  return normalized;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.phaseId) {
    throw new Error("--phase-id is required");
  }

  const resolver = createPhaseIdResolver();
  const result = resolver.resolve(args.phaseId);
  const output = {
    input: args.phaseId,
    normalizedInput: result.normalizedInput,
    canonicalPhaseId: result.canonicalPhaseId,
    matchedBy: result.matchedBy,
    canonicalPhaseIds: args.verbose ? resolver.canonicalPhaseIds : undefined,
    legacyAliasMap: args.verbose ? resolver.legacyAliasMap : undefined,
  };
  process.stdout.write(`${JSON.stringify(compactObject(output), null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {
    phaseId: "",
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === "--phase-id") {
      parsed.phaseId = requireValue();
      index += 1;
      continue;
    }
    if (token === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/phase-id-resolver.mjs --phase-id <value> [--verbose]",
      "",
      "Resolve an IDD phase identifier to its canonical machine-facing ID.",
      "Legacy aliases (e.g. A4.5, A4-5) are normalized to canonical IDs (e.g. A4_5).",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function isCanonicalToken(token) {
  return /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(token);
}

function isSupportedInputToken(rawInput) {
  return /^[A-Za-z0-9.\-/:\\_\s]+$/.test(rawInput.trim());
}

function normalizeAliasToken(input) {
  return String(input ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildResolverError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function compactObject(value) {
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = entry;
    }
  }
  return output;
}

function isCliExecution() {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}
