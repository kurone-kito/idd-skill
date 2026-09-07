#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-suggest-untrusted-labelers.mts
//
// The scripts/idd-suggest-untrusted-labelers.mjs copy is generated from
// the .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// #2670: automates `docs/customization.md`'s Reserved-label guard
// recipe's "full-history sweep" technique for building the
// untrusted-labeler login list -- a paginated `GET
// /repos/{owner}/{repo}/issues/events` read, filtered to `event ==
// "labeled"` entries whose actor `type == "Bot"`, deduplicated by
// login and counted. This is a read-only reporting tool only: it never
// edits `.github/idd/config.json` and never mutates GitHub state (no
// label removal, no comments, no other write call of any kind). Adding
// an accepted candidate's login as one of the recipe's
// `<labeler-bot-login-N>` placeholders in
// `.github/workflows/strip-untrusted-labels.yml` stays a manual,
// adopter-owned edit after reviewing this report.
import { parseCliArgs } from './cli-args.mjs';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghApiJson, ghText } from './gh-exec.mjs';
/**
 * Filter `events` to `event === 'labeled'` entries whose actor `type ===
 * 'Bot'`, deduplicate by `actor.login`, and count occurrences per login.
 * Pure and offline: takes already-fetched events, never calls `gh` itself
 * (the paginated fetch lives in {@link sweepUntrustedLabelerCandidates}
 * below), matching `actions-usage-report.mts`'s aggregate/fetch split so
 * this function is the one covered by an offline fixture test.
 *
 * An event whose `actor` is `null`/absent (GitHub omits `actor` for some
 * system-generated events), or whose `actor.login` is empty/whitespace, is
 * skipped rather than counted under an empty-string login.
 */
export function aggregateUntrustedLabelerCandidates(events) {
  const counts = new Map();
  for (const event of events) {
    if (event?.event !== 'labeled') {
      continue;
    }
    if (event.actor?.type !== 'Bot') {
      continue;
    }
    const login = event.actor?.login?.trim();
    if (!login) {
      continue;
    }
    counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([login, labeledEventCount]) => ({ login, labeledEventCount }))
    .sort(
      (a, b) =>
        b.labeledEventCount - a.labeledEventCount ||
        a.login.localeCompare(b.login),
    );
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export function renderTable(result) {
  const lines = [
    '| Bot login | Labeled events |',
    '| --- | --- |',
    ...result.candidates.map(
      (row) => `| ${row.login} | ${row.labeledEventCount} |`,
    ),
    '',
    `Total: ${result.candidates.length} distinct bot login(s) found across ` +
      `${result.scannedEventCount} scanned issue/PR event(s) over ` +
      `${result.pageCount} page(s).`,
  ];
  return lines.join('\n');
}
// ---------------------------------------------------------------------------
// GitHub fetch (I/O -- not exercised by the offline fixture test)
// ---------------------------------------------------------------------------
/** Events requested per page. GitHub's REST list endpoints accept up to
 * 100 per `per_page`. */
const EVENTS_PER_PAGE = 100;
/** Hard ceiling on pages fetched in one sweep -- a fail-closed guard
 * against a runaway loop (a malformed injected `fetchPage`, or a paged
 * endpoint that never returns a short final page), not a limit this
 * repository's real event history is expected to approach. */
const MAX_SWEEP_PAGES = 100_000;
/**
 * Fetch one page of `GET /repos/{owner}/{repo}/issues/events`, projected
 * down to just `event`/`actor.login`/`actor.type` via a server-side `--jq`
 * filter (the repository-level endpoint embeds the full parent `issue`
 * object -- including its body -- in every event, so a page fetched
 * without this projection, from a repository with thousands of
 * issues/PRs, can run to several MB).
 *
 * Deliberately **not** `ghApiJson(path, { paginate: true })`: that call
 * walks every page inside one `gh` subprocess via its own synchronous
 * `execFileSync`, whose `GhApiJsonOptions` exposes no `maxBuffer`
 * override (only the async `ghTextAsync`'s `GhTextAsyncOptions` does)
 * -- so even a well-projected single `--paginate` call is hard-capped
 * at Node's default 1 MiB *total* accumulated stdout across every
 * page, with no override available through this repository's sync
 * `gh`-exec primitives. This helper's
 * sweep is repository-wide and unbounded by design (unlike every other
 * paginated caller in this repository, which is PR/issue-scoped and
 * bounded in practice to a few pages -- see `DEFAULT_GH_PAGINATED_TIMEOUT_MS`'s
 * own doc comment in `gh-exec.mts`), so this fetches one page at a time
 * instead: each page is independently bounded (a few KB after
 * projection) and results accumulate in JS memory rather than one
 * subprocess's stdout buffer.
 *
 * `page`/`per_page` MUST stay in the URL query string, never passed via
 * `gh api -F`/`-f` -- `gh api` silently switches the request method to
 * POST the instant any `-F`/`-f` parameter is added, which would turn
 * this read-only sweep into a write call and violate its no-mutation
 * contract.
 */
function fetchLabeledBotEventsPage(owner, repo, page) {
  const raw = ghApiJson(
    `repos/${owner}/${repo}/issues/events?per_page=${EVENTS_PER_PAGE}&page=${page}`,
    {
      extraArgs: [
        '--jq',
        '[.[] | {event: .event, actor: {login: (.actor.login // null), type: (.actor.type // null)}}]',
      ],
    },
  );
  return raw;
}
/**
 * Sweep `GET /repos/{owner}/{repo}/issues/events` to completion (paging
 * manually -- see {@link fetchLabeledBotEventsPage}'s doc comment for
 * why), then aggregate the result via
 * {@link aggregateUntrustedLabelerCandidates}. Stops at the first page
 * shorter than {@link EVENTS_PER_PAGE} (the last page); a page fetch
 * itself never mutates anything -- see {@link fetchLabeledBotEventsPage}.
 */
export function sweepUntrustedLabelerCandidates(owner, repo, deps = {}) {
  const fetchPage = deps.fetchPage ?? fetchLabeledBotEventsPage;
  const events = [];
  let page = 1;
  let pageCount = 0;
  for (;;) {
    const items = fetchPage(owner, repo, page);
    pageCount += 1;
    events.push(...items);
    if (items.length < EVENTS_PER_PAGE) {
      break;
    }
    if (pageCount >= MAX_SWEEP_PAGES) {
      throw new Error(
        `idd-suggest-untrusted-labelers: exceeded ${MAX_SWEEP_PAGES} pages without reaching a short final page -- aborting instead of looping forever`,
      );
    }
    page += 1;
  }
  return {
    candidates: aggregateUntrustedLabelerCandidates(events),
    scannedEventCount: events.length,
    pageCount,
  };
}
/** Resolves `{owner, repo}` the same way other CLI helpers in this
 * repository do: explicit flags first, else `gh repo view` auto-detection
 * (matching `stalled-session-quiet-check.mts`'s inline style rather than
 * importing the heavier `provider-adapter-github.mts` module just for
 * this one lookup). */
function resolveOwnerRepo(owner, repo) {
  return {
    owner:
      owner ||
      ghText(
        ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      ),
    repo:
      repo ||
      ghText(
        ['repo', 'view', '--json', 'name', '--jq', '.name'],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      ),
  };
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const IDD_SUGGEST_UNTRUSTED_LABELERS_FLAG_SPEC = {
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--format': { type: 'string', default: 'table' },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-suggest-untrusted-labelers.mjs [--owner <owner>] [--repo <repo>] [--format table|json]

  --owner <owner>     Repository owner (default: auto-detected via gh repo view).
  --repo <repo>       Repository name (default: auto-detected via gh repo view).
  --format <format>   Output format: table (default) or json.
  --help, -h          Show this help.

Paginates GET /repos/{owner}/{repo}/issues/events to completion, filters to
event == "labeled" entries whose actor type == "Bot", deduplicates by
login, and prints each distinct bot login with its labeled-event count.
Read-only: performs no write or mutating GitHub call of any kind.
`);
}
if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    IDD_SUGGEST_UNTRUSTED_LABELERS_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const format = values.format;
  if (format !== 'table' && format !== 'json') {
    process.stderr.write(
      `idd-suggest-untrusted-labelers: --format must be table or json, got: ${format}\n`,
    );
    process.exit(2);
  }
  const { owner, repo } = resolveOwnerRepo(values.owner, values.repo);
  const result = sweepUntrustedLabelerCandidates(owner, repo);
  process.stdout.write(
    format === 'json'
      ? `${JSON.stringify({ owner, repo, ...result }, null, 2)}\n`
      : `${renderTable(result)}\n`,
  );
}
