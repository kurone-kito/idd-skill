# Data Layer Log Segment

> **Note:** This segment is reconstructed from the preserved claim,
> plan, completion, and PR validation evidence in
> `kurone-kito/idd-skill` and `kurone-kito/vrc-event-calendar`. It
> keeps the workshop log format, but it does not invent terminal output
> that was never recorded verbatim.

## [2026-05-17 17:15:00 JST] Claim Track C1 — Prisma Bootstrap

- Issue: `kurone-kito/idd-skill#557`
- Claim ID: `claim-20260517T081500Z-557-7f8f9c0d`
- Branch: `issue/557-set-up-prisma-orm-postgresql-connection`
- Target repo: `kurone-kito/vrc-event-calendar`

## [2026-05-17 17:20:00 JST] Install Prisma And Bootstrap The Schema File

```shell
npm install --save-dev prisma @prisma/client
npx prisma init --datasource-provider postgresql
```

> **Note:** `prisma init` creates `prisma/schema.prisma` with a
> PostgreSQL datasource and `.env` with a placeholder `DATABASE_URL`.
> The Prisma 6.19.3 pinned release was used to match the workshop's
> `package.json` lockfile.

## [2026-05-17 17:22:00 JST] Validate The Bootstrap Schema

```shell
$ npx prisma format
$ npx prisma generate
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma db push
```

> **Note:** The bootstrap schema at this stage contained only the
> datasource and generator blocks — no models. The `db push` smoke
> check confirmed the PostgreSQL connection worked against the Docker
> service before any model was defined.

## [2026-05-17 17:25:06 JST] Merge PR #10 — Prisma Bootstrap

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/10>
- Title: `build(prisma): add postgres bootstrap`
- Merge commit: PR #10 landed at `2026-05-17 17:25:06 JST`

## [2026-05-17 17:27:00 JST] Claim Track C1 Extension — Define Event Schema

- Issue: `kurone-kito/idd-skill#558`
- Claim ID: `claim-20260517T082726Z-558-7f8f9c0d`
- Branch: `issue/558-define-prisma-schema-for-event-model`

## [2026-05-17 17:29:00 JST] Add EventCategory Enum And Event Model

```prisma
enum EventCategory {
  PARTY
  MUSIC
  ART
  GAME
  SOCIAL
  OTHER
}

model Event {
  id           String        @id @default(cuid())
  title        String
  description  String?
  startAt      DateTime
  endAt        DateTime
  category     EventCategory
  worldId      String?
  worldName    String?
  creatorToken String
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
}
```

## [2026-05-17 17:30:00 JST] Validate The Schema

```shell
$ npm ci
$ npx prisma format
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma validate
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma generate
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma db push
$ npm run lint
```

> **Note:** The first `git commit` attempt stalled on local GPG
> signing, so this branch commit used the repository-approved
> `git commit-ssh` fallback. `npm ci` was required in the dedicated
> worktree before `npx prisma ...` would resolve the pinned Prisma 6
> toolchain.

## [2026-05-17 17:32:51 JST] Merge PR #11 — Event Schema

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/11>
- Title: `build(prisma): define event schema`
- Merge commit: PR #11 landed at `2026-05-17 17:32:51 JST`

> **Note:** The schema change was kept intentionally model-only so
> that #559 owns the first migration and #560 owns seed data — each
> issue stays atomically reviewable.

## [2026-05-17 17:34:10 JST] Claim Track C2 — Initial Migration

- Issue: `kurone-kito/idd-skill#559`
- Claim ID: `claim-20260517T083410Z-559-7f8f9c0d`
- Branch: `issue/559-create-initial-database-migration`

## [2026-05-17 17:35:00 JST] Generate And Apply The Init Migration

```shell
$ npm ci
$ docker compose up -d db
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma migrate dev --name init
```

> **Note:** The first `prisma migrate dev` attempt raced the database
> startup and failed with `P1001` (connection refused). Rerunning
> after the container reached `healthy` succeeded cleanly. The
> migration folder is recorded as `20260517083535_init`.

## [2026-05-17 17:35:35 JST] Migration SQL Applied

```sql
-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM (
    'PARTY', 'MUSIC', 'ART', 'GAME', 'SOCIAL', 'OTHER'
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "category" "EventCategory" NOT NULL,
    "worldId" TEXT,
    "worldName" TEXT,
    "creatorToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);
```

## [2026-05-17 17:36:30 JST] Confirm Migration Status And Replay Deploy

```shell
$ docker compose down -v && docker compose up -d db
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma migrate deploy
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma migrate status
```

> **Note:** `prisma migrate deploy` ran cleanly against a freshly
> wiped database, confirming the migration is self-contained.
> `prisma migrate status` reported no pending migrations after the
> replay.

## [2026-05-17 17:37:39 JST] Merge PR #12 — Init Migration

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/12>
- Title: `build(prisma): add init migration`
- Migration folder: `prisma/migrations/20260517083535_init/`
- Merge commit: PR #12 landed at `2026-05-17 17:37:39 JST`

## [2026-05-17 17:38:30 JST] Claim Track C2 Extension — Prisma Singleton

- Issue: `kurone-kito/idd-skill#561`
- Branch: `issue/561-create-prisma-client-singleton`

## [2026-05-17 17:40:00 JST] Add PrismaClient Singleton

```typescript
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  __prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}
```

> **Note:** Production keeps a fresh `new PrismaClient()` on each
> cold start. Development caches the instance on `globalThis.__prisma`
> to survive hot-module reloads without exhausting connection pool
> limits.

## [2026-05-17 17:42:31 JST] Merge PR #13 — DB Singleton

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/13>
- Title: `build(prisma): add db singleton`
- Merge commit: PR #13 landed at `2026-05-17 17:42:31 JST`

## [2026-05-17 22:40:00 JST] Claim Track C3 — Database Seed

- Issue: `kurone-kito/idd-skill#560`
- Branch: `issue/560-add-database-seed-script`

## [2026-05-17 22:50:00 JST] Add Seed Script With 10 Sample VRC Events

```shell
npm install --save-dev tsx
```

> **Note:** `tsx` was added as a dev dependency so `prisma/seed.ts`
> can run directly with the TypeScript seed file without a separate
> compile step. The seed command was registered under
> `prisma.seed` in `package.json`.

## [2026-05-17 22:52:00 JST] Execute Database Seed

```shell
$ DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/vrc_event_calendar?schema=public' \
  npx prisma db seed
```

```text
Seeding database...
Seeded 10 events.
```

> **Note:** The seed script uses `upsert` with stable string IDs
> (e.g., `seed-vrc-party-001`) so rerunning it never creates
> duplicate rows. The 10 sample events cover all six
> `EventCategory` values: `PARTY`, `MUSIC`, `ART`, `GAME`,
> `SOCIAL`, and `OTHER`.

## [2026-05-17 22:55:57 JST] Merge PR #15 — Seed Script

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/15>
- Title: `feat(prisma): add seed script with 10 sample vrc events`
- Merge commit: PR #15 landed at `2026-05-17 22:55:57 JST`

> **Note:** After this merge, the data layer is fully in place: the
> PostgreSQL schema is version-controlled via Prisma migrations, the
> `Event` table is live in the Docker-based development database, and
> 10 representative VRC events populate it for local development and
> API testing.
