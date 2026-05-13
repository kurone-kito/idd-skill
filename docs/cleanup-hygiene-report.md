# cleanup-hygiene-report.mjs

Helper script for generating auditable cleanup hygiene snapshots of
merged pull requests. Produces metrics for trend reporting and continuous
integration audit purposes.

## Overview

The `cleanup-hygiene-report.mjs` helper generates a structured cleanup
hygiene report in JSON or CSV format. It produces metrics about merged
PRs, tracking how many have undergone post-merge cleanup verification and
how many still require attention.

## Metrics Schema

The JSON output follows this schema:

```json
{
  "version": "1.0",
  "timestamp": "ISO 8601 timestamp",
  "repository": {
    "owner": "github-username",
    "name": "repository-name"
  },
  "summary": {
    "totalMergedPRs": 0,
    "clean": 0,
    "needsApply": 0,
    "cleanPercentage": 0.0
  },
  "candidatesByClassifier": {
    "thresholdMissing": 0,
    "skippedWithReason": 0,
    "applied": 0,
    "failed": 0
  },
  "topSkipReasons": [
    {
      "reason": "review-thread-unresolved",
      "count": 0
    },
    {
      "reason": "operational-marker-present",
      "count": 0
    },
    {
      "reason": "held-by-maintainer",
      "count": 0
    }
  ],
  "trends": {
    "recent": {
      "days": 7,
      "data": {
        "startDate": "ISO 8601",
        "endDate": "ISO 8601",
        "metrics": {
          "totalMergedPRs": 0,
          "clean": 0,
          "needsApply": 0
        }
      }
    },
    "historical": {
      "data": {
        "beforeDate": "ISO 8601",
        "metrics": {
          "totalMergedPRs": 0,
          "clean": 0,
          "needsApply": 0
        }
      }
    }
  }
}
```

### Metric Definitions

- **summary**
  - `totalMergedPRs`: total count of merged pull requests in the analyzed scope
  - `clean`: count of PRs where cleanup audit passed or was not required
  - `needsApply`: count of PRs where cleanup audit is pending or required
  - `cleanPercentage`: percentage of clean PRs (clean / totalMergedPRs × 100)

- **candidatesByClassifier**
  - `thresholdMissing`: PRs not meeting candidate criteria (too old, no
    IDD markers, etc.)
  - `skippedWithReason`: PRs skipped due to specific conditions
    (unresolved threads, held by maintainer)
  - `applied`: PRs where cleanup has been attempted
  - `failed`: PRs where cleanup verification failed or encountered errors

- **topSkipReasons**: ranked list of common reasons PRs were skipped
  - `review-thread-unresolved`: PR has unresolved review threads or
    comments
  - `operational-marker-present`: PR contains active operational markers
    (holds, blocks)
  - `held-by-maintainer`: PR is held by maintainer decision or blocked

- **trends.recent**: metrics for the last 7 days
- **trends.historical**: metrics for periods before the recent window

## Usage

### Basic Usage

Run the script from the repository root:

```bash
node scripts/cleanup-hygiene-report.mjs
```

### Command-Line Options

- `--owner <name>`: Repository owner (defaults to current repository)
- `--repo <name>`: Repository name (defaults to current repository)
- `--since <date>`: Filter by merge date (ISO 8601 format)
- `--format <type>`: Output format: `json` (default) or `csv`
- `--help`: Show help message

### Examples

Generate JSON report for current repository:

```bash
node scripts/cleanup-hygiene-report.mjs --format json
```

Generate CSV report:

```bash
node scripts/cleanup-hygiene-report.mjs --format csv
```

Generate report for specific repository:

```bash
node scripts/cleanup-hygiene-report.mjs --owner kurone-kito --repo idd-skill --format json
```

Generate report for PRs merged since date:

```bash
node scripts/cleanup-hygiene-report.mjs --since 2024-05-01T00:00:00Z --format json
```

## Output Formats

### JSON Format (Default)

Pretty-printed JSON with full metric schema and all calculated values.

```bash
node scripts/cleanup-hygiene-report.mjs --format json
```

### CSV Format

Human-readable CSV with summary metrics and repository information:

```csv
Cleanup Hygiene Report
Repository,owner/repo
Timestamp,2024-05-13T11:00:00Z

Metric,Value
Total Merged PRs,42
Clean,38
Needs Apply,4
Clean Percentage,90.48%
```

## Integration with CI/CD

The JSON schema is designed for integration with CI/CD pipelines and
metrics aggregation systems:

1. **Metric Collection**: Use `--format json` to collect structured data
2. **Trend Tracking**: Parse `trends.recent` and `trends.historical` for
   trend analysis
3. **Alerting**: Set thresholds on `cleanPercentage` to trigger alerts
   when cleanup hygiene degrades
4. **Reporting**: Feed metrics into dashboards and audit reporting systems

## Error Handling

The script handles the following error conditions:

- **Missing `--owner` parameter**: defaults to current git repository owner
- **Missing `--repo` parameter**: defaults to current git repository name
- **Invalid git repository**: exits with error if remote URL cannot be parsed
- **Invalid date format**: exits with error for non-ISO 8601 dates
- **Unknown format**: exits with error for unsupported output formats
- **Unknown argument**: exits with error for unrecognized CLI flags

All errors output to stderr and exit with status code 1.

## Maintenance

- **Schema versioning**: The `version` field tracks schema changes for
  future compatibility
- **Timestamp accuracy**: All timestamps are server-reported ISO 8601
  values
- **Metric stability**: The top-level metric structure is stable; new
  fields may be added but existing fields are preserved

## See Also

- `idd-audit-pr-cleanup.mjs`: Post-merge comment cleanup auditor
- `idd-pre-merge-readiness.mjs`: Merge-gate evidence collection
- `.github/instructions/idd-cleanup.instructions.md`: Cleanup phase documentation
