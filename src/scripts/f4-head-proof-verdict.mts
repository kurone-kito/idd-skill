// idd-generated-from: src/scripts/f4-head-proof-verdict.mts
//
// The scripts/f4-head-proof-verdict.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// The F4 head-proof verdict table (#4094). It decides, from inputs the
// caller has already read, whether F4 may proceed, must stop or hold, or
// must post a new idd-f4-head-proof marker. The rules come from the F4
// Head Proof section of idd-template/docs/idd-resume-detail.md, with the
// verdict rows as settled on #4094.
//
// This module imports nothing and performs no I/O: no git call, no `gh`
// call, no claim lock, and no POST. The caller reads the inputs, performs
// the POST when the verdict says `post`, and passes the results back in.
// Each function returns a disposition only; the caller posts any hold note.

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

type Disposition = 'proceed' | 'stop' | 'hold' | 'post';

type Reason =
  | 'claim-or-lock'
  | 'pr-state'
  | 'ref-read'
  | 'marker-read-failed'
  | 'branch-absent'
  | 'reusable'
  | 'conflicting-marker'
  | 'watermark-unauthenticated'
  | 'claim-activation-unknown'
  | 'posted-confirmed'
  | 'posted-disagreed'
  | 'reread-failed'
  | 'reread-conflict'
  | 'reread-reusable'
  | 'post-unconfirmed';

interface Verdict {
  readonly disposition: Disposition;
  readonly exitCode: 0 | 1 | null;
  readonly reason: Reason | null;
}

interface LivePr {
  readonly merged: boolean;
  readonly readable: boolean;
  readonly mergeCommitSha: string | null;
  readonly headSha: string | null;
  readonly mergeParentHeadSha: string | null;
}

interface LocalRef {
  readonly state: 'present' | 'absent' | 'error';
  readonly tip: string | null;
}

interface Marker {
  readonly claimId: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly merge: string;
  readonly head: string;
  readonly f2: string;
  readonly branchTip: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A trusted same-claim marker entry; `unparseable` entries are never reusable. */
type TrustedMarker = Marker | { readonly unparseable: true };

interface ProofInput {
  readonly claimId: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly claimOk: boolean;
  readonly livePr: LivePr;
  readonly refNameValid: boolean;
  readonly localRef: LocalRef;
  readonly claimActivatedAt: string | null;
  readonly markers: readonly TrustedMarker[];
  readonly markersRead: boolean;
  readonly watermarkAuthenticated: boolean;
}

interface Reread {
  readonly result: 'reusable' | 'trusted-not-reusable' | 'none' | 'failed';
  readonly identity: string | null;
}

interface PostResult {
  readonly writeOk: boolean;
  readonly postedIdentity: string | null;
  /** Read only when `writeOk` is true. */
  readonly refetch?: Reread | null;
  /** Read only when `writeOk` is false; must hold exactly three entries. */
  readonly rereads?: readonly Reread[] | null;
}

function isFullSha(value: string | null): value is string {
  return value !== null && FULL_SHA_PATTERN.test(value);
}

function isUnparseable(
  entry: TrustedMarker,
): entry is { readonly unparseable: true } {
  return 'unparseable' in entry;
}

function terminal(
  disposition: 'proceed' | 'stop' | 'hold',
  reason: Reason,
): Verdict {
  return {
    disposition,
    exitCode: disposition === 'proceed' ? 0 : 1,
    reason,
  };
}

/**
 * The identity of a reusable marker: its seven token fields in the
 * canonical order, with SHA fields lowercased. Timestamps are not part of
 * identity. Derive a posted marker's identity with
 * `classifyReread([postedMarker], input).identity`, never by hand, so that
 * no caller re-implements this format.
 */
function identityOf(marker: Marker): string {
  return JSON.stringify({
    prNumber: marker.prNumber,
    claimId: marker.claimId,
    branch: marker.branch,
    f2: marker.f2.toLowerCase(),
    branchTip: marker.branchTip.toLowerCase(),
    merge: marker.merge.toLowerCase(),
    head: marker.head.toLowerCase(),
  });
}

function timestampsPass(
  marker: Marker,
  claimActivatedAt: string | null,
): boolean {
  if (claimActivatedAt === null) {
    return false;
  }
  const activated = Date.parse(claimActivatedAt);
  const created = Date.parse(marker.createdAt);
  const updated = Date.parse(marker.updatedAt);
  if (
    Number.isNaN(activated) ||
    Number.isNaN(created) ||
    Number.isNaN(updated)
  ) {
    return false;
  }
  return created >= activated && updated === created;
}

/**
 * A marker is reusable when it belongs to the active claim, PR, and branch;
 * its merge and head equal the live PR; its branch tip and F2 are full
 * SHAs, and the tip equals the local ref when one is present; and its
 * timestamps pass `timestampsPass`.
 */
function isReusable(entry: TrustedMarker, input: ProofInput): entry is Marker {
  if (isUnparseable(entry)) {
    return false;
  }
  if (
    entry.claimId !== input.claimId ||
    entry.prNumber !== input.prNumber ||
    entry.branch !== input.branch
  ) {
    return false;
  }
  if (
    entry.merge !== input.livePr.mergeCommitSha ||
    entry.head !== input.livePr.headSha
  ) {
    return false;
  }
  if (!isFullSha(entry.branchTip) || !isFullSha(entry.f2)) {
    return false;
  }
  if (
    input.localRef.state !== 'absent' &&
    entry.branchTip !== input.localRef.tip
  ) {
    return false;
  }
  return timestampsPass(entry, input.claimActivatedAt);
}

function livePrPasses(livePr: LivePr): boolean {
  if (livePr.merged !== true || !livePr.readable) {
    return false;
  }
  if (!isFullSha(livePr.mergeCommitSha) || !isFullSha(livePr.headSha)) {
    return false;
  }
  return (
    livePr.mergeParentHeadSha === null ||
    livePr.mergeParentHeadSha === livePr.headSha
  );
}

/**
 * Classify one post-write or pre-write read of the trusted same-claim
 * markers. `null` means the read failed; an empty list means no marker.
 */
// audit:ignore-dead-export: the caller that wires this verdict table into the F4 cleanup gate is not yet filed; this implements the decision recorded on #4094
export function classifyReread(
  readMarkers: readonly TrustedMarker[] | null,
  input: ProofInput,
): Reread {
  if (readMarkers === null) {
    return { result: 'failed', identity: null };
  }
  if (readMarkers.length === 0) {
    return { result: 'none', identity: null };
  }
  let identity: string | null = null;
  for (const entry of readMarkers) {
    if (!isReusable(entry, input)) {
      return { result: 'trusted-not-reusable', identity: null };
    }
    const entryIdentity = identityOf(entry);
    if (identity !== null && entryIdentity !== identity) {
      return { result: 'trusted-not-reusable', identity: null };
    }
    identity = entryIdentity;
  }
  return { result: 'reusable', identity };
}

/**
 * Apply the verdict rows, in order, before any marker POST. The first
 * matching row wins. Returns `post` only when a marker POST is needed;
 * the caller then reports the result to `decideAfterPost`.
 */
// audit:ignore-dead-export: the caller that wires this verdict table into the F4 cleanup gate is not yet filed; this implements the decision recorded on #4094
export function decideBeforePost(input: ProofInput): Verdict {
  if (!input.claimOk) {
    return terminal('stop', 'claim-or-lock');
  }
  if (!livePrPasses(input.livePr)) {
    return terminal('hold', 'pr-state');
  }
  if (!input.refNameValid || input.localRef.state === 'error') {
    return terminal('hold', 'ref-read');
  }
  if (!input.markersRead) {
    return terminal('hold', 'marker-read-failed');
  }
  const anyReusable = input.markers.some((entry) => isReusable(entry, input));
  if (input.localRef.state === 'absent' && !anyReusable) {
    return terminal('hold', 'branch-absent');
  }
  if (input.markers.length > 0) {
    const reread = classifyReread(input.markers, input);
    if (reread.result === 'reusable') {
      return terminal('proceed', 'reusable');
    }
    return terminal('hold', 'conflicting-marker');
  }
  if (!input.watermarkAuthenticated) {
    return terminal('hold', 'watermark-unauthenticated');
  }
  if (input.claimActivatedAt === null) {
    return terminal('hold', 'claim-activation-unknown');
  }
  return { disposition: 'post', exitCode: null, reason: null };
}

/**
 * Decide after a marker POST. A confirmed write needs one re-fetch that
 * matches the posted identity. An ambiguous write (`writeOk` false) needs
 * exactly three re-reads; this throws when they are missing, and it never
 * reads `rereads` on the success path.
 */
// audit:ignore-dead-export: the caller that wires this verdict table into the F4 cleanup gate is not yet filed; this implements the decision recorded on #4094
export function decideAfterPost(postResult: PostResult): Verdict {
  if (postResult.writeOk) {
    const refetch = postResult.refetch ?? null;
    const confirmed =
      refetch !== null &&
      refetch.result === 'reusable' &&
      refetch.identity !== null &&
      refetch.identity === postResult.postedIdentity;
    return confirmed
      ? terminal('proceed', 'posted-confirmed')
      : terminal('hold', 'posted-disagreed');
  }

  const rereads = postResult.rereads;
  if (rereads?.length !== 3) {
    throw new Error(
      'f4-head-proof-verdict: decideAfterPost needs exactly three re-reads after an ambiguous write',
    );
  }
  if (rereads.some((reread) => reread.result === 'failed')) {
    return terminal('hold', 'reread-failed');
  }
  const reusable = rereads.filter((reread) => reread.result === 'reusable');
  const hasNone = rereads.some((reread) => reread.result === 'none');
  const hasNotReusable = rereads.some(
    (reread) => reread.result === 'trusted-not-reusable',
  );
  const identities = new Set(reusable.map((reread) => reread.identity));
  if (
    hasNotReusable ||
    identities.size > 1 ||
    (reusable.length > 0 && hasNone)
  ) {
    return terminal('hold', 'reread-conflict');
  }
  if (reusable.length > 0) {
    return terminal('proceed', 'reread-reusable');
  }
  return terminal('hold', 'post-unconfirmed');
}
