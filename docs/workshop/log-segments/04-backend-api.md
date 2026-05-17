# Backend API Log Segment

> **Note:** This segment is reconstructed from the preserved claim,
> plan, completion, and PR validation evidence in
> `kurone-kito/idd-skill` and `kurone-kito/vrc-event-calendar`. It
> keeps the workshop log format, but it does not invent terminal output
> that was never recorded verbatim.

## [2026-05-17 17:45:49 JST] Claim D1 — GET /api/events Endpoint

- Issue: `kurone-kito/idd-skill#566`
- Claim ID: `claim-20260517T084549Z-566-7f8f9c0d`
- Branch: `issue/566-implement-get-events-endpoint`
- Target repo: `kurone-kito/vrc-event-calendar`

> **Note:** D1 is shown as the representative full IDD cycle. D2–D6
> are abbreviated below to avoid repeating the same boilerplate for
> each endpoint. All six cycles follow the same claim → plan →
> implement → test → self-review → PR → merge pattern.

## [2026-05-17 17:49:20 JST] D1 — Implement GET /api/events

```shell
$ npm ci
[dependencies installed]
$ npx tsc --noEmit
[no type errors]
```

Added `src/app/api/events/route.ts` with:

- `buildEventWhere(searchParams)` — builds the Prisma `where` clause
  from `category`, `date_from`, and `date_to` query parameters
- `GET` handler — queries `db.event.findMany` with the computed
  `where`, ordered by `startAt` ascending, and returns `{ events, total }`

## [2026-05-17 17:50:00 JST] D1 — Vitest Route Tests

```shell
$ npx vitest run src/app/api/events/__tests__/route.test.ts
✓ src/app/api/events/__tests__/route.test.ts (5)
  ✓ GET /api/events (5)
    ✓ returns all events when no filters are provided
    ✓ filters events by category
    ✓ filters events by date range
    ✓ combines category and date filters
    ✓ returns an empty result when filters do not match any events
```

> **Note:** Tests mock `@/lib/db` with `vi.mock` so the filter logic
> is exercised through the real route handler without a live database.
> This pattern — mock the Prisma singleton, exercise the route —
> was reused for all later D-track endpoints.

## [2026-05-17 17:51:00 JST] D1 — Self-Review And Lint

```shell
$ npm run lint
[no lint errors]
$ git diff --check
[no whitespace issues]
```

> **Note:** The first `git commit` attempt stalled on local GPG
> signing, so the branch commit used the repository-approved
> `git commit-ssh` fallback. This recurred on D2–D5 as well.

## [2026-05-17 17:52:20 JST] Merge PR #14 — D1 GET /api/events

- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/14>
- Title: `feat(api): add events list endpoint`
- Merge commit: PR #14 landed at `2026-05-17 17:52:20 JST`

---

## [2026-05-17 23:00:00 JST] D2–D5 — Remaining CRUD Endpoints

> **Note:** After D1 merged (17:52 JST), two deferred infrastructure
> lanes completed before D2 started: B7 GitHub Actions CI (PR #16,
> 23:04 JST) and B8 npm Docker scripts (PR #17, 23:13 JST). D2
> through D5 then merged in rapid succession between 23:15 and 23:34
> JST. The frontend Track E started immediately after D5 at 23:35 JST
> (see Track E and F segment) and completed E1–E7 before D6 (Zod
> schemas) ran at 00:29 JST.

### D2 — GET /api/events/\[id\] (PR #18, issue #567)

- Endpoint: `GET /api/events/[id]`
- Returns 200 + event JSON on match, 404 when not found, 400 on
  invalid ID format (e.g., slashes)
- Test suite: 3 cases (found, not found, invalid format)
- Merged: `2026-05-17 23:15:37 JST`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/18>

### D3 — POST /api/events (PR #19, issue #568)

- Endpoint: `POST /api/events`
- Generates `creatorToken` via `crypto.randomUUID()`, returned in
  `X-Creator-Token` response header
- Validates `title`, `startAt`, `endAt`, `category`; enforces
  `endAt > startAt`
- Test suite: 5 cases (happy path, each missing field, invalid date order)
- Merged: `2026-05-17 23:23:39 JST`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/19>

### D4 — PUT /api/events/\[id\] (PR #20, issue #569)

- Endpoint: `PUT /api/events/[id]`
- Authorization: `X-Creator-Token` header compared with stored token
  using `crypto.timingSafeEqual` to prevent timing attacks
- Returns 200 + updated event, 403 on token mismatch, 404 when not found
- Test suite: 3 cases (happy path, wrong token, nonexistent event)
- Merged: `2026-05-17 23:31:03 JST`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/20>

### D5 — DELETE /api/events/\[id\] (PR #21, issue #570)

- Endpoint: `DELETE /api/events/[id]`
- Same `X-Creator-Token` + `crypto.timingSafeEqual` authorization as PUT
- Returns 204 No Content on success, 403 on mismatch, 404 when not found
- Test suite: 3 cases (happy path, wrong token, nonexistent event)
- Merged: `2026-05-17 23:34:51 JST`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/21>

---

## [2026-05-18 00:29:24 JST] D6 — Zod Validation Schemas (PR #30, issue #613)

- Issue: `kurone-kito/idd-skill#613`
- Claim ID: `claude-code-20260517T152924Z-613`
- Branch: `issue/613-define-zod-validation-schemas`

```shell
$ npm install zod
[zod installed as runtime dependency]
```

Added `src/lib/validators/event.ts` with:

- `CreateEventSchema` — validates `title` (required), `startAt`,
  `endAt`, `category`, optional `description`, `worldId`, `worldName`;
  enforces `endAt > startAt`
- `UpdateEventSchema` — partial schema for update payloads
- Exported `CreateEventInput` and `UpdateEventInput` TypeScript types

Test suite: valid inputs, missing required fields, invalid date order,
partial update payloads.

- Merged: `2026-05-18 00:40:35 JST`
- PR: <https://github.com/kurone-kito/vrc-event-calendar/pull/30>

> **Note:** D6 ran after the frontend Track E completed all seven UI
> issues (E1–E7), so D and E tracks effectively serialized in practice:
> D2–D5 (23:15-23:34), then E1–E7 (23:35-00:11), then D6 (00:29-00:40).
> For the complete E-track record, see the Track E and F segment.
