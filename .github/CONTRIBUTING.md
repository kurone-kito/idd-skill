# Contributing to this project

Language: **🇬🇧** | [🇯🇵](./CONTRIBUTING.ja.md) | [🇨🇳](./CONTRIBUTING.zh.md)

---

1. Please note we have a [code of conduct](./CODE_OF_CONDUCT.md), please
   follow it in all your interactions with the project.
2. When contributing to this repository,
   please first discuss the change you wish to make via
   [Discussions](https://github.com/kurone-kito/idd-skill/discussions) or
   any other method with the owners of this repository before making a
   change.
3. If your idea can be shown **with a minor fix, please use directly the
   [pull request](https://github.com/kurone-kito/idd-skill/pulls)**.
4. In this repository, discussion
   **[in English or Japanese](https://translate.google.com/) is recommended**.
5. This project follows
   [Conventional Commits](https://www.conventionalcommits.org/).
   Please write a user-facing subject line and, in the body, briefly cover
   why the change is needed, any important context, and what was changed.
   A suggested `.gitmessage` template is available at the repository root.
   See [copilot-instructions.md](./copilot-instructions.md#commit-rules)
   for examples and full details.

## Local development tooling

This repository uses a project-local pnpm baseline and Husky hooks so
contributors and autopilot runs can enforce the minimum lint gate
before commit. Template adopters do not need pnpm — use your project's
existing tooling instead (see
[Tooling boundary](../docs/customization.md#tooling-boundary)).

Requires Node.js `^22.23.2 || ^24.2.0 || >=26.0.0` (this repository's `engines`
floor in `package.json`).

```sh
corepack enable
pnpm install
pnpm run setup:hooks # enables the Git hooks; run once per clone and once per new worktree
pnpm run check # the full validation suite; run it before you open a pull request
```

Node.js 25+ no longer bundles corepack; if `corepack enable` fails,
install it first with `npm install -g corepack`.

The pre-commit hook runs a fast, commit-safe subset
(`pnpm run lint:precommit`: Biome, dprint, and markdownlint); the full
`pnpm run check` suite runs in CI (`pnpm run lint:minimum` is a
compatibility alias for it). The commit message hook enforces Conventional
Commits through commitlint.

`pnpm run check` runs the lint, typecheck, build artifact, test, and audit
stages. Run a single stage when you need only that one: `pnpm run lint`
(Biome, dprint, cspell, markdownlint, and the source checks),
`pnpm run typecheck`, `pnpm run test`, `pnpm run audit`, or
`pnpm run build:check`, which verifies generated artifacts without rewriting
them. `pnpm run lint:fix` applies formatter and lint fixes explicitly.
`pnpm run doctor:github` is the online GitHub diagnosis; it is separate from
`check` and needs GitHub access. Name any subset you ran in your pull request.

When you edit canonical source files in `idd-template/`, run
`pnpm run docs:sync` to propagate the changes to all mirrored
artifacts.
