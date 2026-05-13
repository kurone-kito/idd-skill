import { execSync } from 'node:child_process';

/**
 * Detects open PRs that close or reference a given issue.
 * Per A5(d): No open PR may close or reference the issue unless the branch
 * matches an inheritable claim comment.
 *
 * @param {Object} options Configuration options
 * @param {string} options.owner Repository owner
 * @param {string} options.repo Repository name
 * @param {number} options.issueNumber Issue number to check
 * @param {Object} [options.mockPRs] Optional mock PR data for testing
 * @returns {Promise<Array>} Array of conflicting PR objects with metadata
 * @throws {Error} On API failures or invalid input
 */
export async function checkConflictingPRs(options) {
  const { owner, repo, issueNumber, mockPRs } = options;

  if (!owner || !repo || !issueNumber) {
    throw new Error('owner, repo, and issueNumber are required');
  }

  const conflictingPRs = [];

  // Regex patterns for closing keywords (GitHub-recognized keywords)
  const closingKeywords = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
  const refKeywords = ['ref', 'refs', 'references', 'related to'];
  const issueRegex = new RegExp(`#${issueNumber}\\b`, 'gi');

  // Get all open PRs (paginated via gh CLI)
  let prs = [];
  if (mockPRs) {
    prs = mockPRs;
  } else {
    try {
      const json = execSync(
        `gh pr list --repo ${owner}/${repo} --state open --json number,title,headRefName,baseRefName,author,body,url --limit 1000`,
        { encoding: 'utf-8' }
      );
      prs = JSON.parse(json);
    } catch (error) {
      throw new Error(`Failed to fetch PRs: ${error.message}`);
    }
  }

  for (const pr of prs) {
    let isConflicting = false;
    const reasons = [];

    // Check PR body for closing keywords + issue reference
    if (pr.body) {
      for (const keyword of closingKeywords) {
        // Look for pattern: keyword + whitespace + #issueNumber
        if (new RegExp(`\\b${keyword}\\s+#${issueNumber}\\b`, 'i').test(pr.body)) {
          isConflicting = true;
          reasons.push(`closing-keyword: "${keyword} #${issueNumber}"`);
          break;
        }
      }

      // Also check for reference keywords
      if (!isConflicting) {
        for (const keyword of refKeywords) {
          if (new RegExp(`\\b${keyword}\\s+#${issueNumber}\\b`, 'i').test(pr.body)) {
            isConflicting = true;
            reasons.push(`ref-keyword: "${keyword} #${issueNumber}"`);
            break;
          }
        }
      }
    }

    if (isConflicting) {
      conflictingPRs.push({
        number: pr.number,
        title: pr.title,
        head_branch: pr.headRefName,
        base_branch: pr.baseRefName,
        author: pr.author?.login || pr.author?.name || 'unknown',
        html_url: pr.url,
        state: 'open',
        reasons,
      });
    }
  }

  return conflictingPRs;
}

/**
 * CLI entry point for detecting conflicting PRs.
 * Outputs results as JSON.
 */
async function main() {
  const args = process.argv.slice(2);

  const options = {
    owner: null,
    repo: null,
    issueNumber: null,
  };

  // Parse arguments: --owner X --repo Y --issue-number Z
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];

    if (flag === '--owner') options.owner = value;
    if (flag === '--repo') options.repo = value;
    if (flag === '--issue-number') options.issueNumber = parseInt(value, 10);
  }

  if (!options.owner || !options.repo || !options.issueNumber) {
    console.error('Usage: node scripts/claim-open-pr-check.mjs --owner <owner> --repo <repo> --issue-number <number>');
    process.exit(1);
  }

  try {
    const conflicting = await checkConflictingPRs(options);
    console.log(JSON.stringify(conflicting, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
