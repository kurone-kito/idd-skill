# Build a VRChat Event Calendar with IDD

<!-- cspell:words Defang VRChat -->

This workshop follows an end-to-end IDD session that builds a realistic
VRChat event calendar example. This page is currently a skeleton: later
issues will replace the `[TODO]` stubs with edited log segments, visual
assets, and full prose.

Use the [workshop log format](LOG-FORMAT.md) when adding captured agent
session excerpts.

## What You Will Build

By the end of the workshop, you will have watched IDD turn a blank
repository into a working VRChat Event Calendar MVP. The app lists
events, shows event details, supports creator-owned edits, and gives
readers enough local infrastructure to run tests before each merge.

The planned example repository URL is
[`kurone-kito/vrc-event-calendar`](https://github.com/kurone-kito/vrc-event-calendar),
the real artifact produced by the workshop roadmap after #547 publishes
it. Treat that repository as the "look over the shoulder" companion to
the edited narrative once Track A is complete: the workshop explains the
IDD decisions, while the repository shows the app those loops created.

Screenshot placeholder for #601: the final event-list screenshot will be
inserted here after the example app screenshots are captured.

Build overview placeholder for #589: the unified workshop log link will
be inserted here after the master log is compiled.

## Prerequisites

Before starting, make sure you can run the same baseline tools the
agents use during the workshop:

- Docker Desktop, or an equivalent Docker Engine setup with Docker
  Compose support, for PostgreSQL and the local app stack.
- Node.js 22.22.2 or newer on the 22.x line, or Node.js 24 or newer,
  matching this repository's supported runtime.
- Corepack with pnpm 10 enabled for this repository's validation
  commands; Node.js also includes npm for example-app commands that use
  npm.
- Git and a GitHub account that can create branches, open pull requests,
  post issue and PR comments for IDD markers, request reviews, and read
  CI results.
- GitHub CLI (`gh`), authenticated for the account you will use during
  the workshop.
- `jq` and `curl`, or equivalent JSON and REST-client tools, for the IDD
  phases that inspect GitHub API responses or post operational markers
  directly.
- Copilot, Codex, or another coding agent that can follow the IDD phase
  instructions and operate through GitHub issues and pull requests.

The workshop also introduces PostgreSQL, Prisma, Tailwind CSS, Vitest,
and Playwright as it builds the app. You do not need to install each of
those separately before reading; the setup steps explain where they enter
the project.

## Prologue: Bootstrap

This section will explain the chicken-and-egg bootstrap flow for applying
idd-skill to a new example repository.

Log segment: [TODO: link the Track A bootstrap log after #583].

## Step 1: Development Environment

This section will establish the local development foundation: Docker
Compose, Next.js, TypeScript, Tailwind CSS, Prisma, tests, and CI.

Log segment: [TODO: link the Track B infrastructure log after #584].

## Step 2: Data Layer

This section will introduce the event model, database migration, seed
data, and Prisma client utility.

Log segment: [TODO: link the Track C data layer log after #585].

## Step 3: Backend API

This section will walk through the event API routes, validation, creator
token behavior, and update/delete flow.

Log segment: [TODO: link the Track D backend API log after #586].

## Step 4: Frontend

This section will cover the event list, detail view, create/edit forms,
delete behavior, filters, calendar view, and quality hardening work.

Log segment: [TODO: link the Tracks E and F frontend log after #587].

## Conclusion: What Was Built

This section will summarize the finished application, the IDD loop
metrics, and the example repository outcome.

Metrics: [TODO: add final implementation metrics in #595].

## What's Next

Once the local MVP is running, you can either ship it somewhere real or
keep using it as a practice ground for future IDD loops. The core
workshop stops at a working local app; everything below is optional and
can become its own small, claimable issue.

For deployment practice, follow the
[Defang deployment bonus](bonus-defang-deployment.md). It shows how to
turn the Docker Compose app into a hosted service while keeping human
account choices, browser login, and production secrets explicit.

Feature extension ideas:

- Add RSVP and attendance tracking so event hosts can estimate turnout
  before the event starts.
- Support recurring events so weekly meetups can be created once and
  expanded into future calendar entries.
- Store VRChat world thumbnails so each event card gives readers a quick
  visual cue before they open the detail page.
- Add notifications so creators can remind followers before an event
  begins or when event details change.
- Export events to Google Calendar so readers can keep their VRChat plans
  beside the rest of their schedule.
- Add moderation tools so maintainers can hide spam, fix broken event
  details, and keep the public calendar trustworthy.

For deeper IDD reference material, continue with the
[full idd-skill documentation](../index.md). If you want to suggest a
workshop improvement or share what you built, use the
[project issue queue](https://github.com/kurone-kito/idd-skill/issues)
as the community starting point.
