# GitHub Pages Readiness Strategy

This page records the low-cost path for turning the `docs/` reference
manual into a public GitHub Pages site later. It is a planning note, not
an instruction to enable Pages in this issue.

## Decision

Use GitHub Pages as the preferred primary public reference surface when
the documentation is ready for publication. Keep the repository Wiki as
an optional scratch or maintainer note surface, not the canonical manual.

Pages is the better fit for the primary reference because:

- documentation changes can keep using pull requests, review, CI, and
  the existing Markdown linting workflow
- stable URLs can be planned alongside file names in the repository
- public docs can be easier to discover and share than Wiki pages
- the same source files can remain useful inside GitHub before Pages is
  enabled

## Lowest-Cost First Path

The first publication path should stay Markdown-first:

1. Publish from the `docs/` directory when the manual is mature enough.
2. Use [docs/index.md](index.md) as the Pages entry point.
3. Keep the current plain Markdown pages and avoid a generated site until
   the manual needs capabilities that plain Pages cannot provide.
4. Continue validating docs with dprint, markdownlint, cspell, and the
   documentation audit before publication.

This path avoids enabling a custom domain, theme, generated navigation,
or separate build pipeline at the start.

## URL and Link Rules

To keep a future Pages move low-friction:

- Prefer stable lowercase-hyphen file names for new reference pages.
- Avoid renaming existing `idd-*.md` files unless a redirect or
  migration plan exists.
- Use relative links for pages that live inside `docs/`.
- When a docs page must link to a repository file outside `docs/`, use a
  GitHub repository URL or plan to copy that file into the Pages source
  in a later issue.
- Keep the README as the adopter landing page and `docs/index.md` as the
  reference-manual entry point.

## SEO and Navigation Needs

Plain Pages is enough for the first version if readers can answer these
questions from `docs/index.md`:

- How do I import IDD into a repository?
- How do I run the IDD loop?
- Where are the workflow internals and maintenance policies?
- What is optional, adopter-facing, or maintainer-facing?

A later site-generation issue becomes reasonable when the project needs
features such as generated side navigation, page descriptions, richer
metadata, redirects, or search.

## Deferred Work

Defer these decisions until after the Markdown reference manual has more
traffic or maintainer feedback:

- choosing a static-site generator
- adding a custom domain
- designing generated navigation
- publishing API-like reference pages from generated sources
- translating the deeper reference manual beyond the bilingual README

## Non-Goals

This strategy does not:

- enable GitHub Pages
- add a custom domain
- add a site framework or generated build step
- replace `idd-template/` as the portable package
- make the repository Wiki the canonical public manual
