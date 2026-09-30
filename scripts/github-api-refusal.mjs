// idd-generated-from: src/scripts/github-api-refusal.mts
//
// The scripts/github-api-refusal.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// The error a request gets when host-local load control does not dispatch
// it (issue #3586). It has no imports on purpose: the transport wrappers,
// the load-control store, the provider adapter, and the helper CLI runner
// all recognize it, and none of them should pull in the others for that.
//
// A refusal means no `gh` process was started. A caller must treat it as
// "nothing was sent": it is never an ambiguous write and never a reason to
// re-read state to see whether a write landed.
const DETAIL_KEY = 'loadControl';
const MAX_CAUSE_DEPTH = 8;
function defineHidden(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
/**
 * Build the refusal error. Its properties are non-enumerable for the reason
 * `tagGhCommandError` documents: an enumerable property would change how
 * Node renders an uncaught error. It carries no `status`, `stdout`,
 * `stderr`, `killed`, or `code`, and its message matches no HTTP-status or
 * header pattern, so the status, timeout, and 5xx classifiers that read
 * those fields never mistake it for a transport failure worth retrying.
 */
export function createLoadControlRefusal(detail) {
  const parts = [
    `gh request not dispatched: load control ${detail.outcome} (${detail.reason})`,
  ];
  if (detail.holderPid !== undefined) {
    parts.push(`slot held by pid ${detail.holderPid}`);
  }
  if (detail.retryAt) parts.push(`retry at ${detail.retryAt}`);
  const error = new Error(parts.join('; '));
  defineHidden(error, 'name', 'GithubApiLoadControlRefusal');
  defineHidden(error, 'notDispatched', true);
  defineHidden(error, DETAIL_KEY, Object.freeze({ ...detail }));
  return error;
}
/**
 * The refusal detail carried by `error`, or by any error in its `cause`
 * chain (a wrapper such as `toProviderError` keeps the original only there).
 */
export function findLoadControlRefusal(error) {
  let current = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined;
    depth += 1
  ) {
    if (typeof current === 'object') {
      const holder = current;
      const detail = holder[DETAIL_KEY];
      if (
        holder.notDispatched === true &&
        detail &&
        typeof detail === 'object'
      ) {
        return detail;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
/** True when the request was refused before any `gh` process was started. */
export function isNotDispatchedRefusal(error) {
  return findLoadControlRefusal(error) !== undefined;
}
/**
 * Carry a refusal onto an error a wrapper had to rebuild. The tags are
 * copied, not linked through `cause`: a `cause` would make Node print the
 * original when the rebuilt error goes uncaught. The `ghCommand` tag comes
 * along so a helper still classifies the failure as `transport`. A no-op for
 * every other original error.
 */
export function preserveLoadControlRefusal(wrapper, original) {
  const detail = findLoadControlRefusal(original);
  if (detail === undefined) return wrapper;
  defineHidden(wrapper, 'notDispatched', true);
  defineHidden(wrapper, DETAIL_KEY, detail);
  if (original?.ghCommand === true) {
    defineHidden(wrapper, 'ghCommand', true);
  }
  return wrapper;
}
