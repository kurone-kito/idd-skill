#!/usr/bin/env node
// idd-generated-from: src/scripts/review-comment-origin.mts
//
// The scripts/review-comment-origin.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Classify a review-thread comment as IDD-originated vs ordinary human
// chatter (#2136). Used by the non-required comment-refresh workflow so
// a casual LGTM does not rerun the required idd-advisory-convergence
// check, while an E6/E13 disposition, reply-identity stamp, or other
// operational marker still can.

import { appendFileSync } from 'node:fs';

import { parseCliArgs } from './cli-args.mts';
import { loadIddConfig } from './idd-config.mts';
import { isIddOriginatedReply } from './marker-helpers.mts';
import {
  isDispositionComment,
  isRejectionConfirmedDisposition,
  operationalMarkerPrefix,
} from './protocol-helpers.mts';

const REVIEW_COMMENT_ORIGIN_FLAG_SPEC = {
  '--body': { type: 'string', default: '' },
  '--marker-prefix': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

export interface ReviewCommentOriginVerdict {
  iddOriginated: boolean;
  reasons: string[];
}

/**
 * True when `body` is an IDD-originated review-thread utterance.
 *
 * Order is independent: any one signal is sufficient. Human prose
 * (`LGTM`, `thanks`) matches none of these.
 */
export function classifyReviewCommentOrigin(
  body: string,
  markerPrefix?: string,
): ReviewCommentOriginVerdict {
  const text = body ?? '';
  const reasons: string[] = [];
  if (isIddOriginatedReply(text, markerPrefix)) {
    reasons.push('review-reply-stamp');
  }
  if (isDispositionComment({ body: text })) {
    reasons.push('disposition-prefix');
  }
  if (isRejectionConfirmedDisposition({ body: text })) {
    reasons.push('rejection-confirmed');
  }
  if (operationalMarkerPrefix(text)) {
    reasons.push('operational-marker');
  }
  return { iddOriginated: reasons.length > 0, reasons };
}

export function isIddOriginatedReviewComment(
  body: string,
  markerPrefix?: string,
): boolean {
  return classifyReviewCommentOrigin(body, markerPrefix).iddOriginated;
}

const USAGE = `Usage:
  node scripts/review-comment-origin.mjs [--body <text>] [--marker-prefix <prefix>]

Classify a review-thread comment as IDD-originated. Prints JSON
{iddOriginated, reasons} to stdout. --body defaults to $COMMENT_BODY
so a GitHub Actions env: pass does not have to put the comment on the
argv. Exit 0 always on a successful classify (including "not
originated"); a non-zero exit is a usage or parse error.
`;

/**
 * Resolve the effective markerPrefix: an explicit non-empty `flagValue`
 * wins; otherwise fall back to `.github/idd/config.json`'s configured
 * value. Exported so sibling companion-workflow helpers (e.g.
 * `advisory-comment-debounce.mts`) resolve the identical effective
 * prefix this file's own CLI uses, rather than re-deriving the
 * fallback and risking drift between two classification passes over
 * the same PR.
 */
export function resolveMarkerPrefix(flagValue: string): string | undefined {
  const trimmed = flagValue.trim();
  if (trimmed) {
    return trimmed;
  }
  const fromConfig = loadIddConfig()?.markerPrefix;
  return typeof fromConfig === 'string' && fromConfig.trim()
    ? fromConfig.trim()
    : undefined;
}

if (import.meta.main) {
  const args = parseCliArgs(
    process.argv.slice(2),
    REVIEW_COMMENT_ORIGIN_FLAG_SPEC,
  );
  if (args.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
  } else {
    const flaggedBody =
      typeof args.values.body === 'string' ? args.values.body : '';
    const body =
      flaggedBody.length > 0 ? flaggedBody : (process.env.COMMENT_BODY ?? '');
    const verdict = classifyReviewCommentOrigin(
      body,
      resolveMarkerPrefix(
        typeof args.values['marker-prefix'] === 'string'
          ? args.values['marker-prefix']
          : '',
      ),
    );
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      appendFileSync(
        githubOutput,
        `idd_originated=${verdict.iddOriginated ? 'true' : 'false'}\n`,
      );
    }
    process.exitCode = 0;
  }
}
