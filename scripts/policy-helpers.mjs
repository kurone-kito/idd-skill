const HELPER_RUNTIME_PROFILES = new Set([
  "package-manager",
  "vendored-node",
  "ephemeral-npx",
  "instructions-only",
]);

export function parseProjectCommandRows(text) {
  const commands = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!match) {
      continue;
    }
    commands.set(match[1].trim(), match[2].trim());
  }
  return commands;
}

export function inspectHelperRuntimeConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { status: "invalid", reason: "config must be a non-null object" };
  }

  if (!hasOwn(config, "helperRuntime")) {
    return { status: "absent" };
  }

  const helperRuntime = config.helperRuntime;
  if (typeof helperRuntime !== "object" || helperRuntime === null || Array.isArray(helperRuntime)) {
    return { status: "invalid", reason: "helperRuntime must be an object when present" };
  }

  const profile = helperRuntime.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    return { status: "invalid", reason: "helperRuntime.profile must be a non-empty string" };
  }

  if (!HELPER_RUNTIME_PROFILES.has(profile)) {
    return {
      status: "invalid",
      reason: `unsupported helperRuntime.profile "${profile}"`,
    };
  }

  return { status: "ok", profile };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}
