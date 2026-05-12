import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildHelperRuntimeManifest } from "../scripts/helper-runtime-manifest.mjs";
import { runDoctor } from "../scripts/idd-doctor.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_ROOT = new URL("./fixtures/helper-runtime-config/", import.meta.url);
const REQUIRED_INSTRUCTION_FILES = [
  ".github/instructions/idd-overview.instructions.md",
  ".github/instructions/idd-discover.instructions.md",
  ".github/instructions/idd-suitability.instructions.md",
  ".github/instructions/idd-claim.instructions.md",
  ".github/instructions/idd-work.instructions.md",
  ".github/instructions/idd-pr-submit.instructions.md",
  ".github/instructions/idd-ci.instructions.md",
  ".github/instructions/idd-review-snapshot.instructions.md",
  ".github/instructions/idd-review-triage.instructions.md",
  ".github/instructions/idd-review-fix.instructions.md",
  ".github/instructions/idd-pre-merge.instructions.md",
  ".github/instructions/idd-merge-handoff.instructions.md",
  ".github/instructions/idd-merge.instructions.md",
  ".github/instructions/idd-resume.instructions.md",
  ".github/instructions/idd-resume-stall.instructions.md",
  ".github/instructions/idd-advisory-wait.instructions.md",
];
const REQUIRED_DOC_FILES = [
  "docs/getting-started.md",
  "docs/concepts.md",
  "docs/customization.md",
  "docs/reference.md",
  "docs/idd-workflow.md",
  "docs/idd-review-policy-profiles.md",
  "docs/idd-helper-scripts.md",
  "docs/idd-comment-minimization.md",
  "docs/permissions.md",
  "docs/policy-constants.md",
];
const PROFILE_FIXTURE_FILES = [
  "profiles/README.md",
  "profiles/human-required/README.md",
  "profiles/no-advisory/README.md",
  "profiles/external-bot/README.md",
];
const OVERVIEW_TEXT = `# IDD overview

<!-- helper-runtime-fixture-roadmap-id: value -->
<!-- helper-runtime-fixture-blocked-by: value -->

| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`node --test tests/*.mjs\` |
| **pre-push-validate** | \`node --test tests/*.mjs\` |
| **post-fix-validate** | \`node --test tests/*.mjs\` |
| **install-deps** | \`true\` |
| **issue-scope** | \`roadmap\` |
| **orphan-first-policy** | \`none\` |
`;
const DISCOVER_TEXT = `# IDD discover

<!-- helper-runtime-fixture-roadmap-id: value -->
<!-- helper-runtime-fixture-blocked-by: value -->
`;

test("idd-doctor accepts missing helperRuntime as instructions-only fallback fixture", (t) => {
  const root = createDoctorFixtureRepo("absent.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.deepEqual(report.errors, []);
  assert.ok(
    report.passes.includes(".github/idd/config.json leaves helperRuntime unset (instructions-only fallback)"),
  );
});

test("instructions-only fixture emits no helper commands or dependencies", (t) => {
  const root = createDoctorFixtureRepo("instructions-only.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildHelperRuntimeManifest({
    profile: "instructions-only",
    targetRoot: root,
  });
  const profile = manifest.profiles["instructions-only"];

  assert.deepEqual(profile.managedDependencies, {
    devDependencies: {},
  });
  assert.deepEqual(profile.managedPackageJsonScripts, {});
  assert.deepEqual(profile.commands, {});
  assert.deepEqual(profile.managedFiles, []);
});

test("package-manager fixture can run idd-doctor through the helper bin", (t) => {
  const root = createDoctorFixtureRepo("package-manager.json", {
    packageJson: {
      name: "fixture-package-manager",
      packageManager: "npm@10.9.0",
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildHelperRuntimeManifest({
    profile: "package-manager",
    targetRoot: root,
  });
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, "bin/idd-doctor.mjs"), "--json", "--repo-root", root],
      { encoding: "utf8" },
    ),
  );

  assert.equal(manifest.packageManager, "npm");
  assert.ok(
    manifest.profiles["package-manager"].commands["idd:doctor"],
    "package-manager profile should emit a doctor command",
  );
  assert.deepEqual(report.errors, []);
  assert.ok(
    report.passes.includes('.github/idd/config.json declares helper runtime profile "package-manager"'),
  );
});

test("idd-doctor fixture rejects unsupported helperRuntime profiles", (t) => {
  const root = createDoctorFixtureRepo("invalid-profile.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.ok(
    report.errors.includes('.github/idd/config.json: unsupported helperRuntime.profile "bun"'),
  );
});

test("idd-doctor fixture rejects unsupported helperRuntime keys", (t) => {
  const root = createDoctorFixtureRepo("invalid-extra-key.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.ok(
    report.errors.includes(".github/idd/config.json: unsupported helperRuntime keys: manager"),
  );
});

function createDoctorFixtureRepo(configFixtureName, { packageJson = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idd-helper-runtime-profile-"));
  const configText = readFileSync(new URL(configFixtureName, FIXTURE_ROOT), "utf8");

  for (const file of REQUIRED_INSTRUCTION_FILES) {
    const contents = file.endsWith("idd-overview.instructions.md")
      ? OVERVIEW_TEXT
      : file.endsWith("idd-discover.instructions.md")
        ? DISCOVER_TEXT
        : `# ${file}\n`;
    writeFixtureFile(root, file, contents);
  }
  for (const file of REQUIRED_DOC_FILES) {
    writeFixtureFile(root, file, `# ${file}\n`);
  }
  for (const file of PROFILE_FIXTURE_FILES) {
    writeFixtureFile(root, file, `# ${file}\n`);
  }

  writeFixtureFile(
    root,
    ".github/copilot-instructions.md",
    "This fixture uses fully_autonomous_merge and copilot advisory.\n",
  );
  writeFixtureFile(root, ".github/idd/config.json", configText);
  writeFixtureFile(root, "AGENTS.md", "See docs/idd-workflow.md.\n");
  writeFixtureFile(root, "CLAUDE.md", "See docs/idd-workflow.md.\n");
  writeFixtureFile(root, "GEMINI.md", "See docs/idd-workflow.md.\n");
  if (packageJson) {
    writeFixtureFile(root, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  return root;
}

function writeFixtureFile(root, relativePath, contents) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}
