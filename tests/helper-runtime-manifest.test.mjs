import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildHelperRuntimeManifest,
  collectVendoredFiles,
  detectPackageManager,
} from "../scripts/helper-runtime-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("package-manager profile emits manager-specific install commands without hard-coded pnpm", () => {
  const expectedInstall = {
    npm: "npm install --save-dev github:kurone-kito/idd-skill",
    pnpm: "pnpm add -D github:kurone-kito/idd-skill",
    yarn: "yarn add --dev github:kurone-kito/idd-skill",
  };

  for (const packageManager of ["npm", "pnpm", "yarn"]) {
    const manifest = buildHelperRuntimeManifest({
      profile: "package-manager",
      packageManager,
      targetRoot: REPO_ROOT,
    });
    const profile = manifest.profiles["package-manager"];

    assert.equal(profile.packageManager, packageManager);
    assert.equal(profile.installCommand, expectedInstall[packageManager]);
    if (packageManager !== "pnpm") {
      assert.doesNotMatch(profile.installCommand, /\bpnpm\b/);
    }
    for (const command of Object.values(profile.managedPackageJsonScripts)) {
      assert.doesNotMatch(command, /\bpnpm\b/);
    }
  }
});

test("instructions-only profile omits helper files, scripts, and dependencies", () => {
  const manifest = buildHelperRuntimeManifest({
    profile: "instructions-only",
    targetRoot: REPO_ROOT,
  });
  const profile = manifest.profiles["instructions-only"];

  assert.deepEqual(profile.managedFiles, []);
  assert.deepEqual(profile.managedPackageJsonScripts, {});
  assert.deepEqual(profile.managedDependencies, {
    devDependencies: {},
  });
  assert.deepEqual(profile.commands, {});
});

test("vendored-node managed files match the canonical helper import closure", () => {
  const manifest = buildHelperRuntimeManifest({
    profile: "vendored-node",
    targetRoot: REPO_ROOT,
  });
  const managedFiles = manifest.profiles["vendored-node"].managedFiles.map((file) => file.targetPath);
  const expectedFiles = collectVendoredFiles(REPO_ROOT).map((file) => file.targetPath);

  assert.deepEqual(managedFiles, expectedFiles);
  assert.ok(managedFiles.includes("scripts/protocol-helpers.mjs"));
  assert.ok(managedFiles.includes("scripts/idd-doctor.mjs"));
  assert.ok(managedFiles.includes("schemas/pre-merge-readiness.schema.json"));
  assert.ok(managedFiles.includes("schemas/advisory-wait-state.schema.json"));
  for (const relativePath of managedFiles) {
    assert.equal(existsSync(join(REPO_ROOT, relativePath)), true, relativePath);
  }
});

test("detectPackageManager respects package metadata and lockfiles", () => {
  const packageJsonRoot = mkdtempSync(join(tmpdir(), "idd-helper-runtime-package-json-"));
  writeFileSync(join(packageJsonRoot, "package.json"), JSON.stringify({ packageManager: "npm@10.9.0" }));
  assert.equal(detectPackageManager(packageJsonRoot), "npm");

  const lockfileRoot = mkdtempSync(join(tmpdir(), "idd-helper-runtime-lockfile-"));
  writeFileSync(join(lockfileRoot, "yarn.lock"), "# lockfile");
  assert.equal(detectPackageManager(lockfileRoot), "yarn");
});

test("switching away from vendored-node enumerates removal paths", () => {
  const manifest = buildHelperRuntimeManifest({
    profile: "instructions-only",
    fromProfile: "vendored-node",
    targetRoot: REPO_ROOT,
  });

  assert.ok(manifest.switching.removeFiles.length > 0);
  assert.deepEqual(manifest.switching.removePackageJsonScripts, []);
});

test("helper bundle manifest bin wrapper produces JSON output", () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, "bin/idd-helper-bundle-manifest.mjs"), "--profile", "instructions-only"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output);

  assert.equal(parsed.packageSpec, "github:kurone-kito/idd-skill");
  assert.ok(parsed.profiles["instructions-only"]);

  const launcher = readFileSync(join(REPO_ROOT, "bin/idd-helper-bundle-manifest.mjs"), "utf8");
  assert.ok(launcher.startsWith("#!/usr/bin/env node"));
});
