# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Third-party WebAudioFont scripts are now loaded with Subresource Integrity (issue #12): `WebAudioFontPlayer.js` and the per-GM `JCLive_sf2_file` soundfont data are pinned with `sha384` digests and fetched with `crossorigin="anonymous"`, so a compromised `surikov.github.io` can no longer inject arbitrary JS into the plugin's page. The pin table covers the full GM 0–127 range (tone-change auto-follow can request instruments outside the dropdown). Regenerate `WAF_PLAYER_INTEGRITY` / `WAF_SOUNDFONT_INTEGRITY` in `screen.js` with `node tools/verify-sri.js --write` when intentionally bumping the WebAudioFont version, and check them without `--write` to catch a wrong row or upstream republish; `.github/workflows/sri-drift.yml` runs that check on a schedule, because validating a digest requires fetching the bytes and would only flake a per-PR gate. An SRI mismatch fails closed, though not identically: a rejected `WebAudioFontPlayer.js` leaves the synth silent, while a rejected soundfont leaves the previously loaded instrument playing and stops tone auto-follow from updating.

### Documentation

- Establish the **Split Screen peer floor of 1.10.6** (issue #40). Piano is standalone-compatible, but focused multi-panel MIDI routing depends on Split Screen's six-method `window.slopsmithSplitscreen` focus API, and the repo carried two unresolved numbers for it: the earliest auditable provider snapshot (1.10.6, commit `54db8d2`) and a later version a maintainer had hand-verified (1.14.5). The six methods are byte-identical at those two snapshots, and all 26 version runs in between (1.10.6 → 1.14.21) carry them, so 1.10.6 is published as the floor — superseding the 1.14.5 "checked floor" note below. Only 1.14.20 carries a git tag, so the manifest `version` is the identity, the same rule core follows. README.md's "Requirements" gains a fourth entry declaring Split Screen as an *optional peer*: not needed for the board, MIDI input, or scoring, but required for focused multi-panel MIDI routing, with the six helper methods tabled and the degraded behavior on a partial or older surface stated as behavior rather than as "fail-soft" — focus stops being authoritative (routed notes and their scoring follow panel mount order, not the panel the user is looking at) and chrome falls back to the shared player mount and control rail. `tests/host-compat.test.js` pins every state — absent, partial in each of its two shapes, the 1.10.6 floor, and the current 1.14.21 surface. The current-surface test drives each panel through its whole lifecycle (mount, draw, resize, the first settings open, a host canvas replacement) before reading the helper's call log, so a dependency on a method the floor does not publish fails the test from whichever code path introduced it. The two partial fixtures pin that the three wrappers (`panelChromeFor` / `settingsAnchorFor` / `isCanvasFocused`) are all-or-nothing on the full-surface check while the subscribe/unsubscribe pair is gated only on its own two halves existing — they degrade identically and are consumed differently. The floor is not recorded in `plugin.json`: feedBack's manifest schema has no feature-scoped optional-dependency field and closes `capabilities.*` to unknown keys (audited at `af29496`), so the tests are the executable record until a host learns to read one.
- Declare and document the tested minimum host, **feedBack core v0.3.0-alpha.1** (issue #39) — the first core commit whose `VERSION` reads `0.3.0-alpha.1` (`803bd0c`), and the earliest snapshot whose source carries every API this plugin consumes. Core publishes no git tags, so `VERSION` is the identity to compare against. README.md's "Requirements" section now splits the three independent prerequisites: the core version (with a per-API surface table, marking `window.highway.resize()` as optional), Web MIDI browser/permission support, and the WebAudioFont network/audio prerequisites for the built-in synth. Documents the visualization-only fallback (no `midi-input` domain, or a non-v1 one, still renders) as a supported state rather than an error. This is a source-level compatibility floor, not a runtime certification of every older snapshot.
- Add `tests/host-compat.test.js`: the executable half of the minimum-host declaration. Its fixtures reproduce the alpha.1 host surface (event bus, chart bundle, `midi-input` v1 domain, optional splitscreen helper) and pin mount/draw/resize/destroy, MIDI discovery and routing, session release, pause/seek/song change, the visualization-only and no-event-bus fallbacks, and split-panel focus routing. The 13 tests run only against those fixtures, never a live core; the matching `0.3.0-alpha.2` (`3a4dd7a`) evidence is a source audit of the same APIs, whose surface is a superset of alpha.1's.
- Extract the shared DOM/`window` stub from `tests/screen.test.js` into `tests/harness.js` so both suites share one browser harness (`installBrowserHarness({ feedBack, slopsmith, slopsmithSplitscreen, storage })`); host-contract fixtures stay in the suites.

### Added

- Per-instance hand filter (feedback-plugin-splitscreen#66): `plugin.json` declares a `handFilter` select (Both / LH / RH) under `capabilities.visualization.settings`, and each renderer instance implements `applySetting` / `getSetting`. Splitscreen's per-panel "Viz ⚙" popover can now show a different hand in each panel. Without an override, an instance follows the global Settings value as before. Scoring (hits/misses/streak and note-key coloring) resets whenever the effective filter actually changes, but not when the same value is re-applied.

### Documentation

- Add `CLAUDE.md` (issue #3): documents the `setRenderer` viz-renderer contract implementation and the `window.slopsmithSplitscreen` focus-change integration, since this plugin is the ecosystem's reference example for both.
- Add `.coderabbit.yaml` (issue #3).
- Pin the verified `feedback-plugin-splitscreen` version (**v1.14.5**) the six-method focus-change surface was checked against, as a checked floor rather than a hard requirement — see [feedback-plugin-splitscreen#47](https://github.com/get-flashbacks/feedback-plugin-splitscreen/issues/47).

### Added

- Practice-mode gate for display-range retargeting (issue #32): a new "Practice mode (free retarget)" setting, off by default. When off ("performance" behavior), the visible keyboard range may only start a new re-target after crossing a measure boundary (via the chart's `beats` data) since the last shift, and never while the player currently has a note physically held down — so the keyboard doesn't re-center mid-phrase or out from under a held note during a performance take. When on, or when the chart carries no measure/beat data, retargeting behaves as before (issue #17's eased retarget fires as soon as the visible-range hysteresis calls for it).
- Floating chord-name labels (issue #19): a chart's named chords (e.g. "Cmaj7") now float above the highway while sustaining, positioned over the chord's leftmost hand-filtered, currently-sounding note. Reuses the existing "Show note names" toggle and requires the host bundle to provide a `chordTemplates` table indexed by each chord's `id`; without it, rendering is unaffected.
- Smoothed keyboard display-range transitions (issue #17): the visible keyboard range now eases toward a new target with a frame-rate-independent exponential lerp instead of snapping instantly, so an octave re-target during playback no longer jump-cuts the keyboard.
- Tone-change awareness (issue #9): the chart's `tone_changes` now drive which WebAudioFont instrument plays on the focused playback panel, so a mid-song tone change (e.g. Keys → Violin) is reflected in playback instead of staying on whatever instrument was loaded at song start. (Under splitscreen, only the focused panel drives the shared synth — background panels don't fight over which instrument is loaded.) On by default; toggle "Auto tone" in settings to disable and keep the manually-selected Sound dropdown instrument regardless of tone changes.

### Fixed

- Updated the Piano renderer lifecycle so it declares its 2D canvas context and keeps overlay chrome aligned with host canvas replacement and visibility changes.
- Added a cancellable animation-frame render loop that repaints from the latest host bundle and stops during teardown.
- A script tag that fails to load (including an SRI mismatch) is now removed from `<head>` instead of lingering, so a later load of the same URL gets a real attempt rather than short-circuiting on the dead tag.

### Changed

- Per-frame keyboard rendering no longer recomputes each key's note-approach glow twice (`_drawKeyboard` called `_approachAlpha` — an O(notes) scan — a second time per key with identical arguments); it's now computed at most once per key per frame.
- Scrolling-note rendering now looks up each note's keyboard-key geometry via a `Map` built alongside the cached key layout instead of a linear scan (`keyForMidi`) over the up-to-88-entry layout array per rendered note.
