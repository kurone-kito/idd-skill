# Build a VRChat Event Calendar with IDD

<!-- cspell:words Defang VRChat -->

This workshop follows an end-to-end IDD session that builds a realistic
VRChat event calendar example. This page is currently a skeleton: later
issues will replace the `[TODO]` stubs with edited log segments, visual
assets, and full prose.

Use the [workshop log format](LOG-FORMAT.md) when adding captured agent
session excerpts.

## What You Will Build

By the end of the workshop, readers will understand how IDD turns a
blank repository into a working event calendar application.

Screenshot: [TODO: add example app screenshot from #601].

Log segment: [TODO: link the unified build overview after #589].

## Prerequisites

This section will list the required local tools, GitHub access, and IDD
setup assumptions before readers begin the workshop.

Checklist: [TODO: fill in prerequisites in #591].

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
