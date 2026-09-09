import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as direct from '../src/scripts/marker-helpers.mts';
import * as facade from '../src/scripts/protocol-helpers.mts';

// Wave 1 of the protocol-helpers split (#1209) moved every operational-marker
// render/parse primitive into marker-helpers.mts and made protocol-helpers.mts
// re-export all of it (`export * from './marker-helpers.mts'`) so existing
// call sites keep importing from '../src/scripts/protocol-helpers.mts'
// unchanged. This test is the facade-identity assertion the issue's
// acceptance criteria calls for: a sample of moved names, imported from BOTH
// paths, must resolve to the exact same binding -- proving a re-export, not a
// duplicated copy that could drift.
const SAMPLE_NAMES = [
  'parseClaimComment',
  'parseReleaseComment',
  'renderClaimedByMarker',
  'renderUnclaimedByMarker',
  'renderActivationNonceMarker',
  'parseActivationNonceComment',
  'findActivationNonceWinner',
  'renderReviewWatermarkMarker',
  'renderReviewBaselineMarker',
  'renderAdvisoryWaitMarker',
  'renderAdvisoryWaitRecoveryMarker',
  'parseAdvisoryRecoveryComment',
  'renderCopilotUnavailableMarker',
  'parseCopilotUnavailableComment',
  'parseForcedHandoffComment',
  'normalizeForcedHandoffPayload',
  'renderForcedHandoffComment',
  'renderForcedHandoffConsentNote',
  'renderExternalCheckWaiverComment',
  'parseExternalCheckWaiverComment',
  'renderProviderOutageDeclarationComment',
  'parseProviderOutageDeclarationComment',
  'renderProviderOutageAdvancedComment',
  'parseProviderOutageAdvancedComment',
  'renderProviderOutageParkComment',
  'parseProviderOutageParkComment',
  'parseReviewWatermarkComment',
  'operationalMarkerPrefix',
  'operationalMarkerPrefixByStart',
  'detectMalformedOperationalMarker',
  'IDD_AGENT_DERIVED_MARKERS',
  'isValidIsoTimestamp',
  'OPERATIONAL_MARKERS',
  'REVIEW_REPLY_STAMP_SUFFIX',
  'hasReviewReplyStamp',
  'appendReviewReplyStamp',
  'isIddOriginatedReply',
  'renderAuthoringOwnerMarker',
  'renderAuthoringPublicationIntentMarker',
  'matchCanonicalAuthoringMarkerFamily',
] as const;

test('protocol-helpers re-exports every sampled marker-helpers name by identity', () => {
  for (const name of SAMPLE_NAMES) {
    const viaFacade = (facade as Record<string, unknown>)[name];
    const viaDirect = (direct as Record<string, unknown>)[name];
    assert.notStrictEqual(
      viaDirect,
      undefined,
      `marker-helpers.mts must export ${name}`,
    );
    assert.strictEqual(
      viaFacade,
      viaDirect,
      `protocol-helpers.mts's ${name} must be the same binding as marker-helpers.mts's (re-export, not a copy)`,
    );
  }
});

// #2752: guards against the drift issue #1705 hit -- a new marker family
// shipped with zero hide-at-post-time wiring and zero record of that gap,
// so F4 cleanup silently missed it. This asserts every OPERATIONAL_MARKERS
// entry has exactly one MARKER_HIDE_POLICY classification: a future new
// entry with no classification fails this test instead of drifting quietly.
// (A `policyLabels.length === new Set(policyLabels).size` duplicate check
// was considered here and dropped: `MARKER_HIDE_POLICY.keys()` can never
// contain a duplicate -- Map key sets are unique by construction -- so
// that comparison could never fail here. A duplicate label in the *source*
// array is instead caught at construction time by
// `buildMarkerHidePolicyMap` throwing, exercised directly below -- a
// duplicate that still names every required label would otherwise pass
// this coverage check silently, since it only verifies label-set
// membership, not per-label uniqueness in the source array. Caught by
// chatgpt-codex-connector review on PR #2759.)
test('MARKER_HIDE_POLICY classifies every OPERATIONAL_MARKERS entry exactly once', () => {
  const markerLabels = direct.OPERATIONAL_MARKERS.map((marker) => marker.label);
  const policyLabels = [...direct.MARKER_HIDE_POLICY.keys()];

  assert.deepStrictEqual(
    new Set(policyLabels),
    new Set(markerLabels),
    'MARKER_HIDE_POLICY must classify exactly the OPERATIONAL_MARKERS label set (no missing, no stale, no extra entries)',
  );

  for (const marker of direct.OPERATIONAL_MARKERS) {
    const entry = direct.MARKER_HIDE_POLICY.get(marker.label);
    assert.ok(
      entry,
      `MARKER_HIDE_POLICY is missing a classification for ${marker.label}`,
    );
    assert.match(
      entry.policy,
      /^(wired|f4-only|excluded)$/,
      `${marker.label}: unexpected hide-policy kind "${entry.policy}"`,
    );
    assert.ok(
      entry.reason.trim().length > 0,
      `${marker.label}: hide-policy entry must carry a non-empty reason`,
    );
  }
});

// #2759 (chatgpt-codex-connector review): a duplicate `label` in the source
// entries must fail loudly at construction time, not silently let the later
// row win. Exercises `buildMarkerHidePolicyMap` directly with a synthetic
// duplicate so this does not require corrupting the real production entries.
test('buildMarkerHidePolicyMap throws on a duplicate label', () => {
  assert.throws(
    () =>
      direct.buildMarkerHidePolicyMap([
        { label: '<!-- dup:', policy: 'f4-only', reason: 'first' },
        { label: '<!-- dup:', policy: 'wired', reason: 'second' },
      ]),
    /duplicate.*label/i,
    'buildMarkerHidePolicyMap must reject two entries sharing the same label',
  );
});

// #2759 (chatgpt-codex-connector review): `ReadonlyMap<K, V>` is a
// compile-time-only guard, so this asserts the actual exported object
// rejects mutation, not just its declared type. `MARKER_HIDE_POLICY` is a
// closure-backed plain object exposing only the `ReadonlyMap` surface (see
// `freezeMap` in marker-helpers.mts), so `set`/`delete`/`clear` are not
// merely rejected -- they do not exist on it at all, and calling a
// property that is `undefined` throws `TypeError` for that reason on its
// own.
test('MARKER_HIDE_POLICY rejects runtime mutation', () => {
  const mutable = direct.MARKER_HIDE_POLICY as unknown as Map<string, unknown>;
  const sizeBefore = direct.MARKER_HIDE_POLICY.size;

  assert.throws(() => mutable.set('<!-- injected:', {}), TypeError);
  assert.throws(() => mutable.delete('<!-- claimed-by:'), TypeError);
  assert.throws(() => mutable.clear(), TypeError);
  assert.strictEqual(
    direct.MARKER_HIDE_POLICY.size,
    sizeBefore,
    'a failed mutation attempt must not change the map contents',
  );
  assert.strictEqual(
    direct.MARKER_HIDE_POLICY.get('<!-- claimed-by:')?.policy,
    'wired',
    'read access must keep working after rejected mutation attempts',
  );
});

// #2759 E10 self-critique: an earlier `Proxy`-based implementation of
// `freezeMap` bound `forEach` to the real underlying `Map`, whose native
// implementation invokes the callback with its own receiver as the third
// argument -- handing callers that mutable `Map` as `forEach`'s third
// argument, an escape hatch around the freeze. The current closure-backed
// implementation substitutes the frozen lookup itself for that argument.
// Asserts the third argument is the frozen lookup, not a mutable map, and
// that there is no mutating method to call through it.
test('MARKER_HIDE_POLICY.forEach never exposes the underlying mutable map', () => {
  let sawThirdArg = false;
  direct.MARKER_HIDE_POLICY.forEach((_value, _key, mapArg) => {
    sawThirdArg = true;
    assert.strictEqual(
      mapArg,
      direct.MARKER_HIDE_POLICY,
      "forEach's third argument must be the frozen lookup, not the raw map",
    );
    const mutableArg = mapArg as unknown as Map<string, unknown>;
    assert.throws(
      () => mutableArg.set('<!-- injected-via-forEach:', {}),
      TypeError,
    );
  });
  assert.ok(sawThirdArg, 'forEach must invoke its callback at least once');
});

// #2759 (chatgpt-codex-connector review, second round): an earlier
// `Proxy`-based `freezeMap` forwarded a brand-new own-property assignment
// straight to its underlying `Map` target (no `defineProperty`/`set` trap
// intercepted it), so a caller could define
// `MARKER_HIDE_POLICY.leak = function () { return this; }` and read it back
// bound to the mutable target. The current closure-backed implementation is
// a plain frozen object, so `Object.freeze` is fully effective against new
// own-property definition -- this asserts that path stays closed.
test('MARKER_HIDE_POLICY refuses reflective property injection', () => {
  const mutable = direct.MARKER_HIDE_POLICY as unknown as Record<
    string,
    unknown
  >;
  // This test file is an ES module, which is always strict mode, so the
  // assignment below throws directly rather than silently no-op'ing the
  // way it would in a sloppy-mode caller.
  assert.throws(() => {
    mutable.leak = function (this: unknown) {
      return this;
    };
  }, TypeError);
  assert.strictEqual(
    mutable.leak,
    undefined,
    'the injected property must never actually attach to the frozen map',
  );
  assert.throws(
    () =>
      Object.defineProperty(mutable, 'leak2', {
        value: function (this: unknown) {
          return this;
        },
        configurable: true,
      }),
    TypeError,
  );
});

// #2759 (advisor review, third round): an earlier `freezeMap` implementation
// bound *any* inherited function property read off the underlying `Map` to
// that same mutable target, not just the methods it intended to expose.
// `Object.prototype.valueOf` is one such property -- every object inherits
// it, and it returns `this` -- so `MARKER_HIDE_POLICY.valueOf()` handed back
// the raw, mutable `Map`, bypassing both the mutator denylist and
// `Object.preventExtensions` from the two prior rounds. The current
// closure-backed implementation has no `target` for `valueOf` (inherited
// from `Object.prototype`) to be bound to: it returns the frozen lookup
// itself, which is what this asserts, alongside `toString` staying a
// harmless primitive rather than exposing anything mutable.
test('MARKER_HIDE_POLICY does not leak the underlying map through inherited Object.prototype methods', () => {
  const leaked = (
    direct.MARKER_HIDE_POLICY as unknown as { valueOf(): unknown }
  ).valueOf();
  assert.strictEqual(
    leaked,
    direct.MARKER_HIDE_POLICY,
    'valueOf() must return the frozen lookup itself, never a distinct mutable object',
  );
  assert.strictEqual(
    typeof (leaked as unknown as Record<string, unknown>).set,
    'undefined',
    'whatever valueOf() returns must not expose a set() method',
  );
  assert.strictEqual(
    typeof direct.MARKER_HIDE_POLICY.toString(),
    'string',
    'toString() must stay a harmless primitive, not expose the underlying map',
  );
});

// #2750: renderAuthoringOwnerMarker / renderAuthoringPublicationIntentMarker
// exist so a candidate comment's canonical rendering can be compared
// byte-for-byte against its live body (matchCanonicalAuthoringMarkerFamily,
// tested further below) -- these renderers themselves round-trip through
// the existing parseAuthoringOwnerComment / parseAuthoringPublicationIntentComment
// functions, and reject a payload missing/invalid fields the same way every
// other renderer in this module does.

const AUTHORING_OWNER_PAYLOAD = {
  markerPrefix: 'idd-skill',
  target: 'kurone-kito/idd-skill#2750',
  anchor: 'kurone-kito/idd-skill#2750',
  mode: 'acquire',
  owner: 'owner-9ffa338d8a416b86',
  set: 'set-1e23beadb3e60e42',
  session: 'claude-idd3-5201e45ac16c',
  bodySha256:
    'f370d4b220dd04d2d896a6c1d7841ecb261a7825bed8e68f07452073972fe389',
  snapshotSha256: 'none',
  supersedes: 'none',
} as const;

const AUTHORING_PUBLICATION_INTENT_PAYLOAD = {
  markerPrefix: 'idd-skill',
  target: 'target-720705e9015f0dda',
  anchor: 'target-720705e9015f0dda',
  set: 'set-74bec4d0d29e21ae',
  session: 'claude-idd1-9f3a2b7c1e4d',
  token: 'pub-7e1361eb1b96bc36',
  journal: 'kurone-kito/idd-skill#2674',
  issue: 'none',
  actor: 'kurone-kito',
  state: 'pending',
} as const;

test('renderAuthoringOwnerMarker matches the live-posted canonical shape and round-trips through the parser', () => {
  const body = direct.renderAuthoringOwnerMarker(AUTHORING_OWNER_PAYLOAD);
  assert.strictEqual(
    body,
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#2750; anchor=kurone-kito/idd-skill#2750; mode=acquire; owner=owner-9ffa338d8a416b86; set=set-1e23beadb3e60e42; session=claude-idd3-5201e45ac16c; body-sha256=f370d4b220dd04d2d896a6c1d7841ecb261a7825bed8e68f07452073972fe389; snapshot-sha256=none; supersedes=none -->\n' +
      '_Issue-authoring ownership marker. Do not edit or delete._',
  );
  const parsed = direct.parseAuthoringOwnerComment(body, 'idd-skill');
  assert.deepStrictEqual(parsed, {
    target: AUTHORING_OWNER_PAYLOAD.target,
    anchor: AUTHORING_OWNER_PAYLOAD.anchor,
    mode: AUTHORING_OWNER_PAYLOAD.mode,
    owner: AUTHORING_OWNER_PAYLOAD.owner,
    set: AUTHORING_OWNER_PAYLOAD.set,
    session: AUTHORING_OWNER_PAYLOAD.session,
    bodySha256: AUTHORING_OWNER_PAYLOAD.bodySha256,
    snapshotSha256: AUTHORING_OWNER_PAYLOAD.snapshotSha256,
    supersedes: AUTHORING_OWNER_PAYLOAD.supersedes,
  });
});

test('renderAuthoringOwnerMarker throws on a missing/invalid field', () => {
  assert.throws(
    () =>
      direct.renderAuthoringOwnerMarker({
        ...AUTHORING_OWNER_PAYLOAD,
        mode: 'not-a-real-mode',
      }),
    /invalid authoring-owner marker payload.*invalid "mode"/s,
  );
  assert.throws(
    () =>
      direct.renderAuthoringOwnerMarker({
        ...AUTHORING_OWNER_PAYLOAD,
        target: undefined,
      }),
    /invalid authoring-owner marker payload.*missing "target"/s,
  );
});

test('renderAuthoringPublicationIntentMarker matches the live-posted canonical shape and round-trips through the parser', () => {
  const body = direct.renderAuthoringPublicationIntentMarker(
    AUTHORING_PUBLICATION_INTENT_PAYLOAD,
  );
  assert.strictEqual(
    body,
    '<!-- idd-skill-authoring-publication-intent: target=target-720705e9015f0dda; anchor=target-720705e9015f0dda; set=set-74bec4d0d29e21ae; session=claude-idd1-9f3a2b7c1e4d; token=pub-7e1361eb1b96bc36; journal=kurone-kito/idd-skill#2674; issue=none; actor=kurone-kito; state=pending -->\n' +
      '_Issue-authoring publication-intent record. Do not edit or delete._',
  );
  const parsed = direct.parseAuthoringPublicationIntentComment(
    body,
    'idd-skill',
  );
  assert.deepStrictEqual(parsed, {
    target: AUTHORING_PUBLICATION_INTENT_PAYLOAD.target,
    anchor: AUTHORING_PUBLICATION_INTENT_PAYLOAD.anchor,
    set: AUTHORING_PUBLICATION_INTENT_PAYLOAD.set,
    session: AUTHORING_PUBLICATION_INTENT_PAYLOAD.session,
    token: AUTHORING_PUBLICATION_INTENT_PAYLOAD.token,
    journal: AUTHORING_PUBLICATION_INTENT_PAYLOAD.journal,
    issue: AUTHORING_PUBLICATION_INTENT_PAYLOAD.issue,
    actor: AUTHORING_PUBLICATION_INTENT_PAYLOAD.actor,
    state: AUTHORING_PUBLICATION_INTENT_PAYLOAD.state,
  });
});

test('renderAuthoringPublicationIntentMarker throws on a missing/invalid field', () => {
  assert.throws(
    () =>
      direct.renderAuthoringPublicationIntentMarker({
        ...AUTHORING_PUBLICATION_INTENT_PAYLOAD,
        state: 'not-a-real-state',
      }),
    /invalid authoring-publication-intent marker payload.*invalid "state"/s,
  );
});

// #2750: matchCanonicalAuthoringMarkerFamily is the exact-template-match
// primitive the issue-authoring contract's hide-on-supersede step relies
// on -- a byte-exact canonical marker body is a positive match; the same
// body with one appended or altered character is a negative match (never
// minimized).
test('matchCanonicalAuthoringMarkerFamily: byte-exact canonical bodies match their own family', () => {
  const ownerBody = direct.renderAuthoringOwnerMarker(AUTHORING_OWNER_PAYLOAD);
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(ownerBody, 'idd-skill'),
    'authoring-owner',
  );

  const intentBody = direct.renderAuthoringPublicationIntentMarker(
    AUTHORING_PUBLICATION_INTENT_PAYLOAD,
  );
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(intentBody, 'idd-skill'),
    'authoring-publication-intent',
  );
});

test('matchCanonicalAuthoringMarkerFamily: an appended character is a negative match', () => {
  const ownerBody = direct.renderAuthoringOwnerMarker(AUTHORING_OWNER_PAYLOAD);
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(`${ownerBody}x`, 'idd-skill'),
    null,
  );
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(`${ownerBody}\n`, 'idd-skill'),
    null,
    'a trailing newline is still an appended character, not a match',
  );
});

test('matchCanonicalAuthoringMarkerFamily: an altered field value is a negative match', () => {
  const ownerBody = direct.renderAuthoringOwnerMarker(AUTHORING_OWNER_PAYLOAD);
  const altered = ownerBody.replace('mode=acquire', 'mode=acquire ');
  assert.notStrictEqual(altered, ownerBody);
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(altered, 'idd-skill'),
    null,
  );
});

test('matchCanonicalAuthoringMarkerFamily: a different marker prefix is a negative match', () => {
  const ownerBody = direct.renderAuthoringOwnerMarker(AUTHORING_OWNER_PAYLOAD);
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(ownerBody, 'other-prefix'),
    null,
  );
});

test('matchCanonicalAuthoringMarkerFamily: non-marker prose is a negative match', () => {
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(
      'Just a regular comment.',
      'idd-skill',
    ),
    null,
  );
});

// A field value carrying an embedded space parses successfully (the
// semicolon/equals splitter only trims leading/trailing whitespace) but
// fails renderAuthoringOwnerMarker's own stricter no-internal-whitespace
// validation -- matchCanonicalAuthoringMarkerFamily must treat that thrown
// render error as a non-match (fail closed) rather than propagating it.
test('matchCanonicalAuthoringMarkerFamily: a parsed field that cannot be re-rendered is a negative match, not a thrown error', () => {
  const body =
    '<!-- idd-skill-authoring-owner: target=kurone-kito/idd-skill#2750 extra; anchor=kurone-kito/idd-skill#2750; mode=acquire; owner=owner-9ffa338d8a416b86; set=set-1e23beadb3e60e42; session=claude-idd3-5201e45ac16c; body-sha256=f370d4b220dd04d2d896a6c1d7841ecb261a7825bed8e68f07452073972fe389; snapshot-sha256=none; supersedes=none -->\n' +
    '_Issue-authoring ownership marker. Do not edit or delete._';
  assert.ok(
    direct.parseAuthoringOwnerComment(body, 'idd-skill'),
    'the malformed target value must still parse (sanity check for this test itself)',
  );
  assert.doesNotThrow(() =>
    direct.matchCanonicalAuthoringMarkerFamily(body, 'idd-skill'),
  );
  assert.strictEqual(
    direct.matchCanonicalAuthoringMarkerFamily(body, 'idd-skill'),
    null,
  );
});
