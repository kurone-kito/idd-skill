# Infrastructure Setup Log Segment

> **Note:** This segment is reconstructed from the preserved claim,
> plan, completion, and PR validation evidence in
> `kurone-kito/idd-skill` and `kurone-kito/vrc-event-calendar`. It
> keeps the workshop log format, but it does not invent terminal output
> that was never recorded verbatim.

## [2026-05-16 19:41:37 JST] Claim Track B1 And Frame The First Full Loop

- Issue: `kurone-kito/idd-skill#555`
- Claim ID: `a5c8cbcc-630d-473e-a5cd-d4da5c31f6f2`
- Branch: `issue/555-initialize-next-js-15-project`
- Target repo: `kurone-kito/vrc-event-calendar`

> **Note:** The linked plan for `idd-skill#555` narrowed scope on
> purpose: build the Next.js 15 scaffold first, prove it runs on the
> host and in a container, and leave long-lived Docker Compose ownership
> to the later Docker issue.

## [2026-05-16 19:55:26 JST] Build And Validate The Scaffold

```shell
$ npm install
$ npm run build
$ npm run lint
$ npx --yes cspell lint . --no-progress
# (terminal 1 — dev server, left running in foreground)
$ npm run dev -- --hostname 127.0.0.1 --port 3003
# (terminal 2 — smoke test)
$ curl -I http://127.0.0.1:3003
$ docker run --rm --name vrc-event-calendar-555 --detach \
  -p 3002:3000 -v "$PWD":/app -w /app \
  --user "$(id -u):$(id -g)" node:22-bookworm \
  bash -lc 'npm run dev -- --hostname 0.0.0.0 --port 3000'
$ docker logs vrc-event-calendar-555
$ curl -I http://127.0.0.1:3002
```

> **Note:** Host port `3000` was already occupied by another local dev
> server, so the direct host smoke test moved to `3003` and was run from
> a second terminal while the dev server stayed in the foreground. The
> container smoke test used `--name` and `--detach` so that `docker logs`
> and `curl` could run in the same terminal session; internal port `3000`
> proved the scaffold itself did not need a code change to run in the
> workshop's future Docker flow.

## [2026-05-16 19:56:22 JST] Open PR #3 For The Scaffold

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/3>
- Title: `feat(app): initialize next.js 15 scaffold`
- Head branch: `issue/555-initialize-next-js-15-project`

> **Note:** The preserved PR body carries the same validation stack as
> the issue completion digest, so later workshop readers can trace the
> branch from local commands to the review surface without re-parsing the
> whole issue thread.

## [2026-05-16 19:56:36 JST] CI Goes Green On PR #3

- Check run: `lint` (`Linting workflow`) — `SUCCESS`
- Earlier parallel check run: `lint` (`Linting workflow`) — `SUCCESS`
- Last recorded repo-owned success: `2026-05-16 19:56:36 JST`

> **Note:** The preserved PR metadata shows the last successful lint run
> finishing at `19:56:36 JST`, which is the explicit "CI goes green"
> moment for the first infrastructure loop.

## [2026-05-16 19:58:21 JST] Merge PR #3 And Unlock The Parallel Lanes

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/3>
- Head branch: `issue/555-initialize-next-js-15-project`
- Implementation commit: `baffeac3e93856d6127f2d4ad55ea5f2dffa5916`
- Merge commit: `cd18596ce9e15f4cb986d0523077f6cbea0ac33a`

> **Note:** This is the first complete Track B IDD loop: claim, plan,
> implementation, validation, PR, and merge. After this scaffold lands,
> the infrastructure slice no longer has to serialize on one branch.
> The workshop can now fan out into narrower lanes instead of editing
> the same bootstrap baseline over and over.

## [2026-05-16 20:00:17 JST] B2 Formatting Lane

- Issue: `kurone-kito/idd-skill#556`
- Branch: `issue/556-configure-eslint-prettier-consistent`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/4>
- Merged: `2026-05-16 23:13:59 JST`

> **Note:** B2 makes formatting and lint expectations explicit so later
> parallel agents stop fighting over whitespace and script conventions.
> The recorded acceptance probe deliberately removed a valid trailing
> comma, confirmed `npm run format:check` failed, then restored the
> file.

## [2026-05-16 23:18:40 JST] B3 Docker Compose Lane

- Issue: `kurone-kito/idd-skill#554`
- Branch: `issue/554-add-docker-compose-configuration-local`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/5>
- Merged: `2026-05-16 23:37:21 JST`

> **Note:** B3 adds the first reproducible local stack: a development
> Dockerfile, Docker Compose wiring, PostgreSQL, `.env.example`, health
> checks, and host-port overrides that keep the workshop runnable even
> when `3000` is already in use.

## [2026-05-17 01:54:13 JST] B4 Hardening Lane

- Issue: `kurone-kito/idd-skill#644`
- Branch: `issue/644-harden-docker-dev-stack-env-handling`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/6>
- Implementation commits:
  `00ded5ec9f0f2279bd45437600b0fb024df4f830`,
  `649f6e4bd89d2ff468c85a0c0946f3342a574a78`
- Merged: `2026-05-17 01:55:09 JST`

> **Note:** B4 is the point where the infrastructure slice's recorded
> validation stack is green again after the Docker hardening follow-up.
> The branch hardens the Docker defaults, preserves cache volumes after
> review feedback, and closes the post-merge advisory loop instead of
> pretending the first Docker pass was already perfect.

## [2026-05-17 01:55:09 JST] B5-B8 Stay Queued As Parallel Follow-Up Lanes

- B5: `idd-skill#562` — `Set up Vitest for unit testing` — `OPEN`
- B6: `idd-skill#563` — `Set up Playwright for E2E smoke testing` — `OPEN`
- B7: `idd-skill#564` — `Add GitHub Actions CI workflow` — `OPEN`
  _(depends on B5: the CI workflow runs `npm test`, which requires the
  Vitest `test` script that B5 adds)_
- B8: `idd-skill#565` — `Add npm scripts for Docker development workflow` — `OPEN`

> **Note:** The workshop's parallel-track shape is still visible even
> where the execution lane has not landed yet. B1 proves the full loop.
> B2-B4 show merged infrastructure work. B5, B6, and B8 can each be
> claimed independently of the others; B7 should wait for B5 to land so
> the CI workflow has a `test` script to invoke.
