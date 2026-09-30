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
const READ_ONLY_SUBCOMMANDS = {
  pr: new Set(['view', 'list', 'checks', 'diff', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
  search: new Set(['issues', 'prs', 'repos', 'commits', 'code']),
};
function parseApiArgs(args) {
  const parsed = {
    endpoint: undefined,
    method: undefined,
    hasFields: false,
    hasInput: false,
    fields: [],
    host: undefined,
    unknownOption: false,
  };
  const take = (flag, value) => {
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
function endpointPath(endpoint) {
  return endpoint.replace(/^\/+/, '').split('?')[0]?.toLowerCase() ?? '';
}
function restResource(path) {
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
function graphqlClassification(parsed) {
  if (parsed.hasInput || parsed.unknownOption) return 'unclassified';
  let query;
  for (const field of parsed.fields) {
    if (field.startsWith('query=')) query = field.slice('query='.length);
  }
  if (query === undefined || query.startsWith('@')) return 'unclassified';
  if (/\bmutation\b/i.test(query)) return 'write';
  if (/\bsubscription\b/i.test(query)) return 'unclassified';
  return 'read';
}
function apiDescription(args) {
  const parsed = parseApiArgs(args);
  const base = parsed.host ? { host: parsed.host } : {};
  if (!parsed.endpoint) {
    return { classification: 'unclassified', ...base };
  }
  const resource = restResource(endpointPath(parsed.endpoint));
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
/** Describe one `gh` argument vector. Never throws. */
export function describeGhRequest(args) {
  const group = args[0];
  if (group === 'api') return apiDescription(args);
  const verb = args[1];
  if (
    group !== undefined &&
    verb !== undefined &&
    READ_ONLY_SUBCOMMANDS[group]?.has(verb)
  ) {
    return { classification: 'read' };
  }
  return { classification: 'unclassified' };
}
