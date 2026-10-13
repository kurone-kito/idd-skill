// idd-generated-from: src/scripts/f4-head-proof.mts
//
// The scripts/f4-head-proof.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Renders the body of the `idd-f4-head-proof` marker in the v2 format
// that the F4 Head Proof section of docs/idd-resume-detail.md defines
// (#4064). This module imports nothing and performs no I/O: no `gh` call,
// no claim lock, and no POST. The caller owns those steps.
const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const WHITESPACE_PATTERN = /\s/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
function requireString(field, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`f4-head-proof: ${field} must be a string`);
  }
  return value;
}
function requirePrNumber(value) {
  const pr = requireString('pr', value);
  if (!PR_NUMBER_PATTERN.test(pr) || Number(pr) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      'f4-head-proof: pr must be a positive decimal integer no larger than Number.MAX_SAFE_INTEGER, with no sign and no leading zero',
    );
  }
  return pr;
}
function requireFullSha(field, value) {
  const sha = requireString(field, value);
  if (!FULL_SHA_PATTERN.test(sha)) {
    throw new RangeError(
      `f4-head-proof: ${field} must be a full 40-character lowercase hexadecimal SHA`,
    );
  }
  return sha;
}
function requireToken(field, value) {
  const token = requireString(field, value);
  if (
    token.length === 0 ||
    WHITESPACE_PATTERN.test(token) ||
    CONTROL_CHARACTER_PATTERN.test(token) ||
    token.includes('>') ||
    token.includes('<!--')
  ) {
    throw new RangeError(
      `f4-head-proof: ${field} must be non-empty and contain no whitespace, no control character, no ">", and no "<!--"`,
    );
  }
  return token;
}
/**
 * Render the `idd-f4-head-proof` marker body in the v2 format: the token
 * line, a blank line, and the visible note, with no trailing newline.
 *
 * Every field is validated first, so that no value can close the HTML
 * comment token early (for example a value containing `-->`). An invalid
 * field throws a `TypeError` (not a string) or a `RangeError` (a string
 * that breaks the field's rule); the caller must treat a throw as a hold
 * and post nothing.
 */
// audit:ignore-dead-export: wired in part 2 of #4064
export function renderF4HeadProofBody(fields) {
  const pr = requirePrNumber(fields.pr);
  const claim = requireToken('claim', fields.claim);
  const branch = requireToken('branch', fields.branch);
  const f2 = requireFullSha('f2', fields.f2);
  const branchTip = requireFullSha('branchTip', fields.branchTip);
  const merge = requireFullSha('merge', fields.merge);
  const head = requireFullSha('head', fields.head);
  const agentId = requireToken('agentId', fields.agentId);
  const token = `<!-- idd-f4-head-proof: v2 pr=${pr} claim=${claim} branch=${branch} f2=${f2} branch-tip=${branchTip} merge=${merge} head=${head} -->`;
  return `${token}\n\n_${agentId}: F4 head-proof marker. Do not edit._`;
}
