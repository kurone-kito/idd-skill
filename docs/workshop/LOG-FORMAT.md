# Workshop Log Format

Workshop logs use the conventions below so separately captured segments
can be assembled, rendered, and reviewed without reformatting. Treat each
literal form as canonical unless a later workshop document explicitly
changes it.

## Timestamp Token

Use this token anywhere a captured moment needs a timestamp:

```text
[YYYY-MM-DD HH:mm:ss JST]
```

Rules:

- Use a four-digit year, two-digit month, two-digit day, and 24-hour
  time.
- Zero-pad every numeric field.
- Use `JST` exactly; it means UTC+09:00 for workshop logs.
- Do not replace the space with `T`, and do not replace `JST` with
  `Z`, `+09:00`, or a local time zone name.

Example:

```text
[2026-05-16 14:32:15 JST]
```

## Agent Response Block

Wrap each captured agent response in a fenced code block with the
`agent` info string. Do not add a prompt, speaker label, or timestamp
inside the block.

Example:

````markdown
```agent
I will verify the claim before editing.
```
````

## Command Block

Wrap terminal commands and their relevant output in a fenced code block
with the `shell` info string. Prefix every command entered by the
operator with a dollar sign followed by one U+0020 space. Output lines,
when included, immediately follow the command without a prompt prefix.

Example:

````markdown
```shell
$ git status --short --branch
## issue/582-define-workshop-log-format-capture
```
````

## Section Header

Start each major captured segment with a level-two heading that combines
the timestamp token and a concise title:

```text
## [YYYY-MM-DD HH:mm:ss JST] Section Title
```

Use title case for the section title. Keep the timestamp in the same
line as the heading text.

Example:

```markdown
## [2026-05-16 14:35:00 JST] Claim Verification
```

## Abridgment Marker

Use this marker when omitting consecutive output lines from a captured
block:

```text
[... output truncated — N lines omitted ...]
```

Replace `N` with the exact decimal count of omitted lines. Keep the
three dots, spaces, and em dash exactly as shown.

Example:

```text
[... output truncated — 42 lines omitted ...]
```

## Annotation Note

Use a blockquote note for short editorial comments that explain capture
context without becoming part of the command or agent output:

```text
> **Note:** ...
```

Keep `Note` capitalized, keep the colon inside the bold text, and place
one space after the colon before the note body.

Example:

```markdown
> **Note:** The command was rerun after rebasing.
```
