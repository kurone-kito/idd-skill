// idd-generated-from: src/scripts/readline-prompt.mts
//
// The scripts/readline-prompt.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared interactive stdin/stdout prompt, extracted from identical
// hand-rolled copies in force-handoff.mts and external-check-waiver.mts
// (see #1448). `node:readline/promises`'s `question` already resolves a
// `Promise<string>`, so no manual `new Promise` wrapping is needed here.
//
// Consumed by:
//
// - scripts/force-handoff.mjs
// - scripts/external-check-waiver.mjs

import { createInterface } from 'node:readline/promises';

/** Interactive prompt function with an optional readline close hook. */
export type PromptFn = ((question: string) => Promise<string>) & {
  close?: () => void;
};

/**
 * Create an interactive stdin/stdout prompt. The returned function asks
 * `question` and resolves with the operator's answer; `.close` releases the
 * underlying readline interface, matching the interface every caller of the
 * former hand-rolled `makeReadlinePrompt` already expects.
 */
export function makeReadlinePrompt(): PromptFn {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: PromptFn = (question) => rl.question(question);
  ask.close = () => rl.close();
  return ask;
}
