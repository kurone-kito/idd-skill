import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// The hooks under test, shipped at the repository root.
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".githooks")

function git(repo, args) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" })
}

/** Run a hook script directly and return its exit code. */
function runHook(repo, hook, cwd = repo) {
  try {
    execFileSync("sh", [join(repo, ".githooks", hook)], { cwd, stdio: "pipe" })
    return 0
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1
  }
}

/** Create a throwaway git repo carrying the shipped hooks and a config. */
function setupRepo(configObj) {
  const dir = mkdtempSync(join(tmpdir(), "idd-hook-"))
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  mkdirSync(join(dir, ".github/idd"), { recursive: true })
  if (configObj !== null) {
    writeFileSync(join(dir, ".github/idd/config.json"), JSON.stringify(configObj, null, 2))
  }
  cpSync(HOOKS_DIR, join(dir, ".githooks"), { recursive: true })
  writeFileSync(join(dir, "README.md"), "placeholder\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "--no-verify", "-m", "init"])
  return dir
}

test("hook allows commit and push from the primary worktree on main", () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } })
  try {
    assert.equal(runHook(repo, "pre-commit"), 0)
    assert.equal(runHook(repo, "pre-push"), 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook blocks commit and push from the primary worktree on issue/* when enabled", () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } })
  try {
    git(repo, ["checkout", "-q", "-b", "issue/123-example"])
    assert.equal(runHook(repo, "pre-commit"), 1)
    assert.equal(runHook(repo, "pre-push"), 1)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook blocks roadmap-audit/* branches in the primary worktree", () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } })
  try {
    git(repo, ["checkout", "-q", "-b", "roadmap-audit/9-example"])
    assert.equal(runHook(repo, "pre-commit"), 1)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook is a no-op on issue/* when the guard is disabled", () => {
  const repo = setupRepo({ worktreeGuard: { enabled: false } })
  try {
    git(repo, ["checkout", "-q", "-b", "issue/123-example"])
    assert.equal(runHook(repo, "pre-commit"), 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook is a no-op on issue/* when worktreeGuard is absent (default)", () => {
  const repo = setupRepo({ markerPrefix: "idd-skill" })
  try {
    git(repo, ["checkout", "-q", "-b", "issue/123-example"])
    assert.equal(runHook(repo, "pre-commit"), 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook honors a custom worktreeGuard.branchPatterns override", () => {
  const repo = setupRepo({
    worktreeGuard: { enabled: true, branchPatterns: ["release/*"] },
  })
  try {
    git(repo, ["checkout", "-q", "-b", "release/1"])
    assert.equal(runHook(repo, "pre-commit"), 1) // matches the custom glob
    git(repo, ["checkout", "-q", "-b", "issue/9-example"])
    assert.equal(runHook(repo, "pre-commit"), 0) // default issue/* no longer applies
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("hook allows issue/* commits from a sibling worktree", () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } })
  const sibling = `${repo}-sibling`
  try {
    git(repo, ["worktree", "add", "-q", sibling, "-b", "issue/123-example"])
    assert.equal(runHook(repo, "pre-commit", sibling), 0)
  } finally {
    try {
      git(repo, ["worktree", "remove", "--force", sibling])
    } catch {
      // best-effort cleanup
    }
    rmSync(repo, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  }
})
