# Issue #123 — Add sample onboarding doctor check

## Background

New adopters can import IDD, but they need a quick way to confirm that
required files and policy markers are present before the first loop.

## Goal

Add a portable onboarding doctor command and basic documentation.

## Acceptance Criteria

1. A doctor command exists and can run from repository root.
1. The command reports missing core IDD files and unresolved placeholders.
1. README contains a short usage snippet.
