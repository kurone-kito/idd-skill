import assert from "node:assert/strict"
import { test } from "node:test"

import {
  computeExitCode,
  isTrustedAuthor,
} from "../scripts/minimize-superseded-markers.mjs"

test("computeExitCode returns 0 when no failures", () => {
  assert.equal(
    computeExitCode({
      counts: { eligible: 2, applied: 2, failed: 0, alreadyMinimized: 0, cannotMinimize: 0, untrusted: 0 },
    }),
    0,
  )
})

test("computeExitCode returns 1 when any item failed", () => {
  assert.equal(
    computeExitCode({
      counts: { eligible: 2, applied: 1, failed: 1, alreadyMinimized: 0, cannotMinimize: 0, untrusted: 0 },
    }),
    1,
  )
})

test("computeExitCode returns 0 even when all candidates were skipped", () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 0,
        applied: 0,
        failed: 0,
        alreadyMinimized: 1,
        cannotMinimize: 1,
        untrusted: 1,
      },
    }),
    0,
  )
})

test("isTrustedAuthor matches case-insensitively", () => {
  const trusted = new Set(["kurone-kito", "copilot"])
  assert.equal(isTrustedAuthor("kurone-kito", trusted), true)
  assert.equal(isTrustedAuthor("Kurone-Kito", trusted), true)
  assert.equal(isTrustedAuthor("CoPilot", trusted), true)
})

test("isTrustedAuthor rejects unknown logins", () => {
  const trusted = new Set(["kurone-kito"])
  assert.equal(isTrustedAuthor("random-user", trusted), false)
  assert.equal(isTrustedAuthor("", trusted), false)
  assert.equal(isTrustedAuthor(null, trusted), false)
  assert.equal(isTrustedAuthor(undefined, trusted), false)
})

test("isTrustedAuthor returns false when trusted set is empty", () => {
  const trusted = new Set()
  assert.equal(isTrustedAuthor("kurone-kito", trusted), false)
})
