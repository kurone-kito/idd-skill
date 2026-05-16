Output ../issue-authoring.gif

Set Shell "bash"
Set FontSize 16
Set Width 900
Set Height 506
Set Framerate 15
Set TypingSpeed 0ms
Set PlaybackSpeed 1.0

Hide
Type 'scene() { clear; printf "%b\n" "$1"; }'
Enter

Type 'scene "Issue authoring: intake\n\nUser request:\nBuild a workshop-ready VRChat event calendar.\n\nGoal: create IDD-ready issues before any agent starts coding."'
Enter
Show
Sleep 2500ms

Hide
Type 'scene "Agent clarification\n\nI can draft this safely after 3 details:\n1. target stack and hosting assumptions\n2. required verification commands\n3. whether external VRChat APIs are available now"'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "User answers\n\nStack: Next.js 15, Prisma, PostgreSQL, Tailwind.\nVerification: lint, unit tests, Playwright smoke test.\nAPI access: not yet; mock/import data first."'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "Decompose and route\n\nroadmap: VRChat event calendar MVP\nready: local import pipeline\nready: calendar UI shell\nblocked-by-human: live API integration\n\nRule: do not hide non-ready work."'
Enter
Show
Sleep 3500ms

Hide
Type 'scene "Structured issue output\n\nIssue: add local event import pipeline\nScope: parse checked-in sample JSON into normalized events\nAcceptance:\n- fixture import is deterministic\n- unit tests cover date and timezone parsing\n- no network credentials required"'
Enter
Show
Sleep 4000ms

Hide
Type 'scene "Ready for IDD discover\n\nlabels: roadmap, idd:ready\nblocked-by: none for the first implementation issue\nverification: pnpm lint && pnpm test\n\nNext: claim one ready issue, work small, review deeply."'
Enter
Show
Sleep 4000ms
