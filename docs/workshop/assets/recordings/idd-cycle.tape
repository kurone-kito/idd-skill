Output ../idd-cycle.gif

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

Type 'scene "IDD loop: one issue to merged PR\n\nA phase: discover\n$ idd discover --priority roadmap\nready: #598 Set up terminal recording toolchain\nchoice: small docs asset, current repo, low merge risk"'
Enter
Show
Sleep 2500ms

Hide
Type 'scene "A phase: claim\n$ idd claim #598\nclaimed-by: codex-20260516-01\nbranch: issue/598-set-up-terminal-recording-toolchain-gif\nclaim verified: active and fresh"'
Enter
Show
Sleep 2500ms

Hide
Type 'scene "B/C phases: work + self-review\n$ vhs test.tape\nrender_ms=2371  bytes=8391\n$ pnpm lint:minimum\n539 tests passed, markdown clean, spelling clean"'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "D phase: pull request\n$ gh pr create --base main --head issue/598-...\nopened: PR #624\nCI: lint PASS, pnpm-boundary PASS, CodeQL PASS\nCodeRabbit: no actionable comments"'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "E phase: review triage\n$ idd review-snapshot #624\nactivity: CodeRabbit summary + Copilot advisory\nPATH B accepted: no code action required\nC-phase self-review remained clean"'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "F phase: pre-merge gates\n$ idd pre-merge #624\nreview currency: current\nthreads: 0 unresolved\nadvisory wait: SATISFIED\nCODEOWNER self-check: clear via PR bypass"'
Enter
Show
Sleep 3000ms

Hide
Type 'scene "F phase: merge\n$ gh pr merge 624 --merge --match-head-commit 64432ce\nmerged: 9b0b64c\ncleanup: 6 stale review markers minimized\nnext: return to A phase and repeat"'
Enter
Show
Sleep 4000ms
