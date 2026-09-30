# Slopsmith Plugin: Piano Highway

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that replaces the guitar highway with a Synthesia-style scrolling piano view, with MIDI keyboard input and a built-in software synthesizer.

![Piano Highway](screenshot.png)

## Features

- **Scrolling piano view** — notes fall from top to bottom onto a rendered keyboard, Synthesia/Openthesia-style
- **Neon rainbow colors** — each chromatic pitch gets a unique neon color with multi-layer glow effects
- **Polished keyboard** — 3D gradient shading, rounded corners, press-down animation, and approach color lerping as notes get closer
- **Dynamic zoom** — keyboard auto-scales to show only the octaves with active notes, snapping in clean octave steps
- **Auto-activate** — switches on automatically for Keys/Piano/Synth arrangements
- **MIDI keyboard input** — connect any USB MIDI keyboard via Web MIDI API to play along
- **Hit/miss feedback** — keys glow green for correct notes, blue for freestyle, red for wrong notes
- **Built-in synthesizer** — WebAudioFont-powered playback with 10 GM instruments (Grand Piano, Electric Piano, Organ, Strings, Synth, and more)
- **Accuracy scoring** — optional hit detection with accuracy %, streak counter, and best streak tracking
- **Sustain pedal** — full MIDI CC#64 sustain pedal support
- **Inline settings** — MIDI device, instrument, volume, channel, transpose, and toggles all accessible from the player

## Requirements

These are three independent requirements — satisfying one does not imply the others. Core compatibility, browser support for MIDI, and network access for the built-in synth are checked separately below.

### 1. Host: feedBack core v0.3.0-alpha.1 or newer

Piano Highway declares a **minimum host of feedBack v0.3.0-alpha.1** — the first core commit whose `VERSION` file reads `0.3.0-alpha.1` (commit `803bd0c`), and the earliest snapshot whose source carries every API this plugin consumes. Core publishes no git tags, so `VERSION` (surfaced by core's version endpoint) is the identity to compare against.

Rows are grouped by what the plugin can *do* when the host provides them, not by whether a missing one would break the board — nearly every row is read behind a `typeof` or existence check, so a dropped API degrades a feature rather than the renderer:

- **The board itself** — the factory global, the `setRenderer` lifecycle, `matchesArrangement` (and the `songInfo` fields it reads) and the chart bundle fields. Without these the visualization does not appear at all.
- **MIDI keyboard input** — the `midi-input` domain and the bus event that reconciles plugged/unplugged devices. Without these the board still renders, but there is no keyboard to play, and both the synth and hit detection are driven by played notes, so neither is available (see *Visualization-only fallback* below).
- **Host chrome** — the event bus and its `highway:` events, `uiVersion` / `ui.playerControlSlot()`, and `window.highway.resize()` *(optional)*. These affect where the settings gear sits and when the overlay re-syncs; `highway:visibility` additionally reaches the board's own visibility, since a host hiding its highway is expected to hide the overlay with it.

| Host API | Used for |
|---|---|
| `window.feedBackViz_<id>` factory global | Renderer discovery by the visualization picker — core's picker resolves this name and no other. `window.slopsmithViz_<id>` is the same function under its legacy export name, kept for splitscreen's `VIZ_FACTORY_PREFIXES` fallback, which core itself never reads |
| `setRenderer` lifecycle: `contextType`, `init`, `draw`, `resize`, `destroy` | Mounting and teardown |
| `matchesArrangement(songInfo)` | Auto-mode arrangement matching |
| Chart bundle fields: `isReady`, `currentTime`, `notes`, `chords`, `beats`, `chordTemplates`, `toneChanges`, `toneBase` | Rendering, chord labels, measure-aware retargeting, auto tone |
| `songInfo.arrangement` / `arrangements` / `arrangement_index` / `has_notation` | Auto-mode matching on the top-level arrangement name, or the active entry in `arrangements`; `has_notation` + the active entry's note count is how a notation-only keys arrangement yields to a notation visualization |
| Event bus (`window.feedBack.on` / `.off`, plus the legacy `window.slopsmith` alias) and `highway:canvas-replaced` / `highway:visibility` | Overlay re-sync on host canvas replacement and visibility changes |
| `midi-input:sources-changed` on that bus | MIDI device plug/unplug reconciliation |
| `midi-input` domain **v1** via `window.slopsmith.midiInput` — `discover`, `listSources`, `select`, `open`, `close`, `logicalSourceKey` | MIDI keyboard input |
| `feedBack.uiVersion` + `feedBack.ui.playerControlSlot()` | Settings gear placement in the v3 player |
| `window.highway.resize()` *(optional)* | Nudges the host's measure pass after the plugin changes player-control layout |

`tests/host-compat.test.js` pins this floor as an executable contract: each fake host in that file reproduces the rows above, and the renderer must mount, draw, route MIDI, survive pause/seek/song changes, and tear down against it. The 13 tests run only against those fixtures, never against a live core; the evidence for `0.3.0-alpha.2` (`3a4dd7a`) is a source audit of the same APIs, whose surface is a superset of alpha.1's — the two `setRenderer` / `matchesArrangement` sites moved from `static/app.js` to `static/js/viz.js`, with no change to the published contract. `tools/verify-host-surface.js` re-checks both audited refs and current upstream `main` on a schedule, so core drifting from this table fails loudly.

This is a source-level compatibility floor, not a runtime certification of every historical snapshot: no test here claims that all builds older than alpha.1 fail, only that alpha.1 is the earliest one examined that provides everything the plugin needs.

**Visualization-only fallback.** The renderer and MIDI input have different requirements. The scrolling piano view works on a visualization-only host — a core with no `midi-input` domain, or one whose domain is not v1, still renders the board; what is lost is everything reachable only from a played note — the MIDI device list, note-on/note-off, the synth voice it triggers, and hit detection — and the settings panel shows an empty device list. The synth is a monitor for what you play, not a backing track: nothing in the plugin sounds a note on its own. Likewise, a host with no event bus falls back to plain `window` events, and a host without the `window.slopsmithSplitscreen` helper runs the single-panel focus path.

### 2. Browser: Web MIDI support for MIDI keyboard input

MIDI input needs the **Web MIDI API**, which every implementing browser exposes only in a **secure context** (HTTPS, or `localhost`). Chrome and Edge implement it; Safari does not. Firefox implements it from version 108, where the first `requestMIDIAccess()` call with a MIDI device attached prompts the user to install a Site Permission Add-On — without it the API stays unavailable. Core's `discover()` is the permission boundary, i.e. what calls `requestMIDIAccess()`.

The permission prompt is part of the requirement: a denied or dismissed prompt leaves MIDI unavailable until the user re-allows it in the browser's site settings, and a `midi` Permissions-Policy header that excludes this origin rejects the call outright. Chrome and Edge are the browsers this plugin is tested against; Firefox is expected to work as described but is not covered by the test suite.

MIDI features are optional — the piano view works without a MIDI keyboard.

### 3. Network: WebAudioFont for the built-in synthesizer

The instrument playback is **WebAudioFont**-based. On first use the plugin loads `WebAudioFontPlayer.js` and the soundfont data from `surikov.github.io`, so built-in sound needs network access (or a reachable cache) and an `AudioContext` the browser will allow to start — most browsers block audio until a user gesture, so the first note may need a click on the player. If either the script or the soundfont fails to load, the plugin logs a warning and everything except audio keeps working; note visuals, MIDI input and scoring are unaffected.

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-piano.git piano
docker compose restart
```

A "Piano" button will appear in the player controls when you play a song. Click the gear icon next to it to configure MIDI input and sound settings.

## How It Works

The plugin reads note data from the highway renderer and draws them as colored bars falling onto a piano keyboard. Notes use the MIDI encoding convention `midi = string * 24 + fret`, which the [editor plugin](https://github.com/got-feedback/feedback-plugin-editor) uses when importing keyboard tracks from Guitar Pro files.

For any guitar arrangement, the piano view shows the notes mapped to their MIDI pitch positions, which can be a useful alternative visualization even for guitar parts.

### MIDI Keyboard

Connect a USB MIDI keyboard and select it from the settings panel. Play along and get real-time visual feedback:

- **Green keys** — you hit the correct note at the right time
- **Blue keys** — you're playing freely (no matching song note)
- **Red flash** — wrong note
- **Approach glow** — keys light up with the note's color as it approaches the now line

### Instruments

Select from 10 General MIDI sounds via the settings panel:

| Sound | GM Program |
|-------|-----------|
| Grand Piano | 0 |
| Electric Piano | 4 |
| Honky-tonk | 3 |
| Organ | 19 |
| Strings | 48 |
| Synth Lead | 80 |
| Synth Pad | 88 |
| Harpsichord | 6 |
| Vibraphone | 11 |
| Music Box | 10 |

## License

MIT
