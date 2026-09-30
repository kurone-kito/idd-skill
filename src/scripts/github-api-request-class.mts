// idd-generated-from: src/scripts/github-api-request-class.mts
//
// The scripts/github-api-request-class.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Pure classification of one `gh` argument vector for host-local load
// control (issue #3586). It reads only the argv shape: never a response,
// a token, or a quota. A request is `read` only for a positively verified
// shape. Anything it cannot verify is `unclassified`, which load control
// treats like a write: admitted immediately or refused, never queued.

export type GhRequestClassification = 'read' | 'write' | 'unclassified';

/** GitHub primary-limit resource a request draws on, when the argv names it. */
export type GhRequestResource = 'core' | 'search' | 'code_search' | 'graphql';

export interface GhRequestDescription {
  classification: GhRequestClassification;
  /** Absent for a `gh` subcommand: its underlying endpoint is not visible. */
  resource?: GhRequestResource;
  /**
   * The host the argv names, lower-cased, when present: `--hostname` for
   * `gh api`, the `HOST` of a `HOST/OWNER/REPO` `-R` or `--repo` otherwise.
   */
  host?: string;
}

/** `gh api` options that consume the next argument as their value. */
const API_VALUE_FLAGS = new Set([
  '--method',
  '-X',
  '--field',
  '-F',
  '--raw-field',
  '-f',
  '--header',
  '-H',
  '--jq',
  '-q',
  '--template',
  '-t',
  '--hostname',
  '--input',
  '--cache',
  '--preview',
  '-p',
]);

/** `gh api` options with no value. Any other option makes the request unclassified. */
const API_BOOLEAN_FLAGS = new Set([
  '--paginate',
  '--slurp',
  '--silent',
  '--verbose',
  '--include',
  '-i',
]);

/** Short flags whose value may be attached, with or without a leading `=`. */
const ATTACHED_SHORT_FLAGS = new Set(['X', 'F', 'f', 'H', 'q', 't', 'p']);

const FIELD_FLAGS = new Set(['--field', '-F', '--raw-field', '-f']);

/** Read-only `gh` subcommands, as `group -> verbs`. Everything else is unclassified. */
const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['view', 'list', 'checks', 'diff', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
  search: new Set(['issues', 'prs', 'repos', 'commits', 'code']),
};

interface ParsedApiArgs {
  endpoint: string | undefined;
  method: string | undefined;
  hasFields: boolean;
  hasInput: boolean;
  fields: string[];
  host: string | undefined;
  /** An option this parser does not know: its effect on the request is not verified. */
  unknownOption: boolean;
}

function parseApiArgs(args: readonly string[]): ParsedApiArgs {
  const parsed: ParsedApiArgs = {
    endpoint: undefined,
    method: undefined,
    hasFields: false,
    hasInput: false,
    fields: [],
    host: undefined,
    unknownOption: false,
  };
  const take = (flag: string, value: string | undefined): void => {
    if (value === undefined) {
      parsed.unknownOption = true;
      return;
    }
    if (flag === '--method' || flag === '-X') parsed.method = value;
    else if (flag === '--hostname') parsed.host = value.trim().toLowerCase();
    else if (flag === '--input') parsed.hasInput = true;
    else if (FIELD_FLAGS.has(flag)) {
      parsed.hasFields = true;
      parsed.fields.push(value);
    }
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals > 0 ? arg.slice(0, equals) : arg;
      if (equals > 0 && API_VALUE_FLAGS.has(name)) {
        take(name, arg.slice(equals + 1));
      } else if (equals < 0 && API_VALUE_FLAGS.has(arg)) {
        take(arg, args[index + 1]);
        index += 1;
      } else if (!API_BOOLEAN_FLAGS.has(arg)) {
        parsed.unknownOption = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg.length === 2) {
        if (API_VALUE_FLAGS.has(arg)) {
          take(arg, args[index + 1]);
          index += 1;
        } else if (!API_BOOLEAN_FLAGS.has(arg)) {
          parsed.unknownOption = true;
        }
      } else if (ATTACHED_SHORT_FLAGS.has(arg[1])) {
        const attached = arg.slice(2);
        take(
          `-${arg[1]}`,
          attached.startsWith('=') ? attached.slice(1) : attached,
        );
      } else {
        parsed.unknownOption = true;
      }
      continue;
    }
    if (parsed.endpoint === undefined) parsed.endpoint = arg;
  }
  return parsed;
}

/**
 * A full-URL endpoint names its own host, and the API host maps back to the
 * host `gh` authenticates against: `api.github.com` is github.com, and a
 * GitHub Enterprise Server URL carries an `/api/v3` or `/api/graphql`
 * prefix on its own host.
 */
function parseApiUrl(
  endpoint: string,
): { path: string; host: string } | undefined {
  if (!/^https?:\/\//i.test(endpoint)) return undefined;
  try {
    const url = new URL(endpoint);
    let host = url.host.toLowerCase();
    if (host === 'api.github.com') host = 'github.com';
    else if (host.startsWith('api.') && host.endsWith('.ghe.com')) {
      host = host.slice('api.'.length);
    }
    const path = url.pathname
      .replace(/^\/api\/v3(?=\/|$)/, '')
      .replace(/^\/api\/graphql$/, '/graphql');
    return { path: path.replace(/^\/+/, '').toLowerCase(), host };
  } catch {
    return undefined;
  }
}

function endpointPath(endpoint: string): string {
  return endpoint.replace(/^\/+/, '').split('?')[0]?.toLowerCase() ?? '';
}

function restResource(path: string): GhRequestResource {
  if (path === 'graphql') return 'graphql';
  if (path.startsWith('search/code')) return 'code_search';
  if (path.startsWith('search/')) return 'search';
  return 'core';
}

/**
 * A GraphQL document is a read only when the `query` field is on the argv
 * and the document is verifiably free of `mutation` and `subscription`
 * (even in a comment). A value read from a file or stdin (`@...`), a
 * missing field, and a request body sent with `--input` are not
 * verifiable.
 */
function graphqlClassification(parsed: ParsedApiArgs): GhRequestClassification {
  if (parsed.hasInput || parsed.unknownOption) return 'unclassified';
  let query: string | undefined;
  for (const field of parsed.fields) {
    if (field.startsWith('query=')) query = field.slice('query='.length);
  }
  if (query === undefined || query.startsWith('@')) return 'unclassified';
  if (/\bmutation\b/i.test(query)) return 'write';
  if (/\bsubscription\b/i.test(query)) return 'unclassified';
  return 'read';
}

function apiDescription(args: readonly string[]): GhRequestDescription {
  const parsed = parseApiArgs(args);
  if (!parsed.endpoint) {
    return {
      classification: 'unclassified',
      ...(parsed.host ? { host: parsed.host } : {}),
    };
  }
  const url = parseApiUrl(parsed.endpoint);
  // An explicit --hostname still wins over the URL's own host.
  const host = parsed.host ?? url?.host;
  const base = host ? { host } : {};
  const resource = restResource(url ? url.path : endpointPath(parsed.endpoint));
  if (resource === 'graphql') {
    return { classification: graphqlClassification(parsed), resource, ...base };
  }
  if (parsed.unknownOption) {
    return { classification: 'unclassified', resource, ...base };
  }
  // gh sends the request as POST when fields or an input body are present
  // and no method is named; an explicit method always wins.
  const method = (
    parsed.method ?? (parsed.hasFields || parsed.hasInput ? 'POST' : 'GET')
  ).toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    return { classification: 'unclassified', resource, ...base };
  }
  if (method === 'GET' || method === 'HEAD') {
    // A body on a GET is not a shape this classifier verifies.
    return {
      classification: parsed.hasInput ? 'unclassified' : 'read',
      resource,
      ...base,
    };
  }
  return { classification: 'write', resource, ...base };
}

/**
 * The host a `HOST/OWNER/REPO` value of `-R` or `--repo` names, lower-cased.
 * A bare `OWNER/REPO` names no host: it resolves against the default one.
 */
function repoFlagHost(args: readonly string[]): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    let value: string | undefined;
    if (arg === '-R' || arg === '--repo') value = args[index + 1];
    else if (arg.startsWith('--repo=')) value = arg.slice('--repo='.length);
    else if (arg.startsWith('-R') && arg.length > 2) {
      value = arg.startsWith('-R=') ? arg.slice(3) : arg.slice(2);
    }
    if (value === undefined) continue;
    if (/^https?:\/\//i.test(value)) {
      // The URL form of a repository: its host is the request's host.
      try {
        return new URL(value).host.toLowerCase();
      } catch {
        return undefined;
      }
    }
    const segments = value.split('/');
    if (segments.length >= 3 && segments[0]) return segments[0].toLowerCase();
  }
  return undefined;
}

/** Describe one `gh` argument vector. Never throws. */
export function describeGhRequest(
  args: readonly string[],
): GhRequestDescription {
  const group = args[0];
  if (group === 'api') return apiDescription(args);
  const verb = args[1];
  const host = repoFlagHost(args);
  const base = host ? { host } : {};
  if (
    group !== undefined &&
    verb !== undefined &&
    READ_ONLY_SUBCOMMANDS[group]?.has(verb)
  ) {
    return { classification: 'read', ...base };
  }
  return { classification: 'unclassified', ...base };
}
