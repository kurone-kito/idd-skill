// Verbatim CodeRabbit review body from PR #1897 review 4863787336,
// captured for #2197 and reused by #2559 / #3341. Not a test entry.
export const PR_1897_REVIEW_4863787336 = `

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/scripts/markdown-code.mts (1)</summary><blockquote>

\`399-407\`: _📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _⚡ Quick win_

**Extract the repeated block-start predicate.**

The same four-way test (\`isMarkdownBlockStart\`, \`MARKDOWN_HTML_BLOCK_START_PATTERN\`, \`MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN\`, valid fence opener) now appears three times: here, in \`openingIsParagraph\` (Lines 462-466), and in the main loop (Lines 491-495). A shared helper keeps the three sites in sync when the set of recognized block starts changes.

<details>
<summary>♻️ Proposed helper</summary>

\`\`\`diff
+function startsMarkdownBlock(content: string, raw: string): boolean {
+  return true;
+}
\`\`\`

</details>

<!-- cr-comment:v1:2db3b7119b3fcf0ccf6d0499 -->

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

\`\`\`
Nitpick comments:
In \`@src/scripts/markdown-code.mts\`:
- Around line 399-407: Extract the repeated four-condition block-start check.
\`\`\`

</details>
`;
