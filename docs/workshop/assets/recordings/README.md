# Workshop Recording Toolchain

This directory stores source tapes for workshop terminal recordings.
Commit `.tape` files so recordings can be reproduced, but keep generated
GIF files out of git.

## Prerequisites

- [VHS](https://github.com/charmbracelet/vhs)
- FFmpeg, installed automatically by most VHS package-manager options

On macOS or Linux with Homebrew:

```shell
brew install vhs
```

## Smoke Test

Render the smoke-test recording from this directory:

```shell
cd docs/workshop/assets/recordings
vhs test.tape
```

The command writes `test.gif` next to `test.tape`. The generated GIF is
ignored by git because recordings are build artifacts; only the tape
source should be committed.

The first VHS run on a new machine may take longer while it prepares a
browser cache. After that one-time setup, the smoke test should render
in a few seconds.

Use this smoke test before creating longer workshop animations so local
font, terminal, and encoder settings are known to work.
