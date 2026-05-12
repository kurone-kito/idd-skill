# Issue #326: test(cleanup) cover post-merge cleanup boundaries

## Problem statement

The `audit-pr-cleanup.mjs` script classifies PR comments as safe cleanup
candidates (RESOLVED, OUTDATED) or intentional skips (keep unresolved
decisions, holds, failed CI, missing dispositions). The policy boundary
needs fixture-backed tests to prevent future regressions when the policy
or script logic changes.

## Approach

Add test fixtures and test cases to `tests/cleanup-boundaries.test.mjs`:

1. Safe candidate fixtures:
   - resolved known-bot review comment with fresh IDD disposition
   - bot review parent with resolved child threads + dispositions
   - stale IDD operational marker on merged PR
   - CodeRabbit completed summary with IDD disposition

2. Unsafe (skip) fixtures:
   - unresolved maintainer decision
   - active hold note
   - failed CI context needed by maintainers
   - unresolved thread (new reviewer activity)
   - missing accept/reject disposition
   - orphan bot review parent (no children, no policy narrowing)

3. Test assertions:
   - safe candidates classified correctly
   - unsafe candidates remain skipped
   - new completion summary fields from #325 are recognized
   - script output format is stable

## Acceptance criteria checklist

- [x] `tests/cleanup-boundaries.test.mjs` created with
      fixture-backed test cases
- [x] All fixture categories (safe/unsafe) covered with realistic
      PR comment shapes
- [x] New completion summary fields from #325 tested
- [x] All existing tests pass: `node --test tests/*.mjs`
- [x] Documentation audit passes
- [x] Markdown lint and spellcheck pass
- [ ] Implementation ready for C1 self-review

## Files modified

- `tests/cleanup-boundaries.test.mjs` (new file)
- `PLAN.md` (this file, for B2 planning)

## Notes

- Fixtures use realistic PR comment JSON shapes from GitHub API
- Test names clearly document the boundary being tested
- Uses same test harness as `tests/claim-parser.test.mjs`
  and `tests/advisory-wait.test.mjs`
- All 113 protocol helper tests pass
