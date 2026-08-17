# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Updated the Piano renderer lifecycle so it declares its 2D canvas context and keeps overlay chrome aligned with host canvas replacement and visibility changes.
- Added a cancellable animation-frame render loop that repaints from the latest host bundle and stops during teardown.

### Changed

- Per-frame keyboard rendering no longer recomputes each key's note-approach glow twice (`_drawKeyboard` called `_approachAlpha` — an O(notes) scan — a second time per key with identical arguments); it's now computed at most once per key per frame.
- Scrolling-note rendering now looks up each note's keyboard-key geometry via a `Map` built alongside the cached key layout instead of a linear scan (`keyForMidi`) over the up-to-88-entry layout array per rendered note.
