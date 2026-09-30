# Piano — AI Agent Guide

Renders an on-screen piano keyboard as a `setRenderer` visualization for
keys/synth arrangements, with MIDI controller input, scoring, and
splitscreen-aware focus handling. Everything ships in one browser script
(`screen.js`, factory-per-instance — splitscreen mounts several).

This repo is the **reference implementation** in the ecosystem for two
contracts documented in feedBack core's `CLAUDE.md`: the full `setRenderer`
lifecycle (`contextType`/`init`/`draw`/`resize`/`destroy` +
`matchesArrangement` for Auto-mode viz selection), and splitscreen's
per-panel focus-change API. Read this file before changing either — other
plugins model themselves on this one.

## setRenderer contract implementation

`createFactory()` (near the bottom of `screen.js`) returns a fresh instance
object per call, matching core's per-panel multi-instance requirement.
Per-instance state (held MIDI notes, display range, scoring, focus) all
lives in closures over `createFactory()`, never on module-level globals —
each splitscreen panel gets its own board.

- `contextType: '2d'` — declared as required by the contract so core can
  read it before `init()` without constructing a throwaway renderer.
- `init(canvas, bundle)` — defensively tears down any prior state first (a
  belt-and-suspenders path for a re-`init()` that wasn't paired with a
  prior `destroy()` — see the comment at the top of `init()`), then builds
  the overlay canvas, hides the host highway canvas via
  `visibility:hidden` (not `display:none` — the host's rAF loop gates
  `draw()` on `canvas.offsetParent !== null`, so `display:none` would
  starve this plugin's own `draw()` calls), wires window-resize +
  host-event listeners, subscribes to splitscreen focus changes (see
  below), and calls `_midiInit()`/`_synthInit()` (module-level singletons
  — safe to call from every instance; only the first call does anything).
- `draw(bundle)` — caches the bundle (`_latestBundle`) and delegates to
  `_renderLatestBundle()`; also arms `_ensureRenderLoop()`, a self-owned
  `requestAnimationFrame` loop that repaints between host `draw()` calls
  so MIDI-triggered visual feedback (key press glow) isn't rate-limited to
  the host's own render cadence. The loop is cancellable and stops on
  `destroy()`.
- `resize(w, h)` — re-applies canvas dimensions via `_applyCanvasDims()`
  only when `_isReady`; a `resize()` that lands before `init()` completes
  (or after `destroy()`) is a no-op.
- `destroy()` — mirror image of `init()`: stops the render loop, removes
  every listener (window resize, host events, splitscreen focus), releases
  the instance from the module-level `_instances` set, and calls
  `_midiReleaseSession()` only when it was the *last* live instance (other
  panels still need MIDI events routed to them).
- `matchesArrangement(songInfo)` — a static on the factory function
  (`createFactory.matchesArrangement`), not the instance, exactly as core's
  Auto-mode evaluation requires. Matches on arrangement name
  (`KEYS_PATTERNS`) but explicitly yields to notation-only viz plugins
  (Staff View, Keys Highway 3D) for `has_notation` arrangements with zero
  wire notes — this plugin decodes `midi = s*24 + f` from guitar-wire notes
  and would render a blank board on a notation-only chart.

- `applySetting(key, value)` / `getSetting(key)` — the per-instance settings
  contract (feedBack#849). `plugin.json` declares `handFilter` (a `select`,
  ids `both` / `L` / `R`) under `capabilities.visualization.settings`, and
  each instance keeps its own `_handOverride` (null = follow the global
  `_cfg.handFilter`). Every per-instance read goes through `_handFilter()`;
  the in-canvas Settings panel still edits the global. `getSetting` returns
  the *effective* value, so a host must only re-apply values it actually
  saved — re-applying `getSetting()`'s answer would pin an override equal to
  the global (splitscreen re-applies saved values only, as of
  feedBack-plugin-splitscreen#68). An unknown value clears the override.

**Both globals are exported** — `window.slopsmithViz_piano` (legacy name)
and `window.feedBackViz_piano = window.slopsmithViz_piano`. Core's
visualization picker resolves `feedBackViz_` only (it never reads
`slopsmithViz_`); the legacy name is kept for splitscreen's
`VIZ_FACTORY_PREFIXES` fallback, which checks `feedBackViz_` first and
`slopsmithViz_` second. Keep both in sync if the factory is ever renamed
again.

## Splitscreen focus-change integration

Under splitscreen, multiple panels can run a Piano instance simultaneously,
but only one keyboard input source (MIDI, or the on-screen keyboard) should
ever be "live" at a time — the one the user is currently looking at/using.
`window.slopsmithSplitscreen` exposes a small helper surface for this;
Piano is the only plugin observed consuming it end-to-end.

Split Screen is an **optional peer** — standalone Piano consumes none of it,
and nothing in this integration is a precondition for the board to render.
The peer floor is **`feedBack-plugin-splitscreen` 1.10.6** — the repository's
earliest auditable snapshot (commit `54db8d2`) — where the full six-method
surface (`isActive` / `isCanvasFocused` / `panelChromeFor` /
`settingsAnchorFor` / `onFocusChange` / `offFocusChange`) is already
published. It was audited at that snapshot and at `main` (1.14.21,
`aefac76`): the six methods are byte-identical, and so is every version run
in between (26 of them, 1.10.6 → 1.14.21). The plugin calls nothing beyond
the six — current splitscreen publishes eight more, and the surface map in
`tests/host-compat.test.js` fails if a post-floor method is ever required.
Splitscreen tags only 1.14.20, so the manifest `version` is the identity to
compare against, the same rule core follows. **The floor is a two-snapshot
source audit plus four contract fixtures, not a runtime certification of the
builds in between** — a partial surface is a supported state, not a
violation of the floor.

`_ssActive()` (see "Splitscreen helper wrappers" in `screen.js`) validates
the **entire** surface this plugin needs before treating splitscreen as
active — `isActive`, `isCanvasFocused`, `panelChromeFor`,
`settingsAnchorFor`, `onFocusChange`, `offFocusChange` — not just
`isActive()` alone. A splitscreen build shipping a partial helper (or an
older bundled splitscreen missing a newer method) is treated as "not
active," which falls the plugin back to the main-player single-instance
fast path rather than reaching a half-broken state where focus never lands
on any instance and MIDI routing silently dies.

The fallback is fail-soft, but calling it merely *safe* undersells it. What
actually changes under a real split-panel host:

- **Focus stops being authoritative.** `_ssIsCanvasFocused()` returns `true`
  unconditionally, so every instance claims focus and the module-level
  `_activeInstance` routing slot lands on whichever panel initialised last.
  Played notes and their scoring go to that panel, not the one the user is
  looking at. Nothing is dropped and nothing throws.
- **Chrome falls back to the shared player.** `_ssPanelChrome()` and
  `_ssSettingsAnchor()` return `null`, so the overlay canvas and settings
  panel mount against `#player` (`_createOverlayCanvas`,
  `_createSettingsPanel`) and the gear docks in `ui.playerControlSlot()` /
  `#player-controls` (`_injectSettingsGear`) — N panels stack N overlays and
  N gears in the same place.
- **Chrome and focus are all-or-nothing.** `_ssActive()` gates the three
  wrappers, so a partial surface is never asked for chrome, anchoring or
  focus — only `isActive()` is called for those. The subscribe/unsubscribe
  pair is *not* gated on `_ssActive()`: `init()`/`destroy()` check only that
  both halves exist, so a surface missing something *other* than
  `offFocusChange` still subscribes (and still releases, symmetrically). What
  that pair has to guarantee is symmetry, not authority — a listener firing
  while every panel reports itself focused changes nothing. Pinned by both
  partial-surface fixtures in `tests/host-compat.test.js`, one per shape.
- **Subscribe** — `init()` calls `ss.onFocusChange(_onFocusChange)` only
  when *both* `onFocusChange` and `offFocusChange` exist on the helper. A
  subscribe without a matching unsubscribe path would leak the listener
  every init/destroy cycle.
- **Unsubscribe** — both `destroy()` and the defensive re-init path at the
  top of `init()` call `ss.offFocusChange(_onFocusChange)` before tearing
  down other state.
- **Belt-and-suspenders guard** — `_instanceDestroyed` is set `true` at the
  *start* of `destroy()`'s teardown (before the offFocusChange call even
  runs) so `_updateFocusState()` no-ops against a destroyed instance even
  if a future splitscreen build ships without an unsubscribe, or a stale
  listener fires after teardown. It's reset to `false` at the top of the
  next `init()`.
- **`_updateFocusState()`** resolves `_isFocused` via
  `_ssIsCanvasFocused(highwayCanvas)`, which returns `true` unconditionally
  when `_ssActive()` is false (main-player fast path — always focused) and
  otherwise defers to `ss.isCanvasFocused(highwayCanvas)`. Focus determines
  which instance's `_activeInstance` module-level singleton receives
  routed MIDI events (`_midiOnMessage`) — an unfocused panel's keyboard
  still renders but doesn't react to MIDI input.
- **Ordering matters at `init()` time**: focus state is resolved
  (`_updateFocusState()`) *before* `_midiResumeHandler()` runs, so
  `_activeInstance` is already populated when `onmidimessage` gets wired.
  Reversing this order would let a MIDI message arrive in the window
  between resume and the first focus-change event, route through
  `_midiOnMessage` while `_activeInstance` is still null, and get silently
  dropped.

If you're building a new plugin that wants the same "only the focused
splitscreen panel is live" behavior, copy this pattern (full surface
validation, subscribe/unsubscribe symmetry, the destroyed-instance guard)
rather than reaching for `window.slopsmithSplitscreen` directly — the
partial-surface fallback is what keeps this safe across splitscreen
version skew. **The floor is recorded in prose only.** feedBack's manifest
schema (`docs/plugin-manifest.schema.json`) has no feature-scoped
optional-dependency field, and a `capabilities.*` block is closed to unknown
keys, so `plugin.json` cannot carry the peer version; the executable record
is the absent / partial / floor / current fixture set in
`tests/host-compat.test.js`, whose surface map is the authority on which
methods the floor covers.

## Versioning

Bump `version` in `plugin.json` whenever a change is user-visible — new
rendering behavior, a scoring/MIDI fix, a changed setting — since the
version cache-busts the served JS/CSS URL. Patch (`4.x.y`) for fixes,
minor (`4.x.0`) for new features, matching normal semver conventions.
`CHANGELOG.md`'s `[Unreleased]` section should be updated alongside.

## Host compatibility (minimum core)

The declared minimum host is **feedBack core v0.3.0-alpha.1** (issue #39) —
the first core commit whose `VERSION` reads `0.3.0-alpha.1` (`803bd0c`),
the earliest snapshot carrying every host API this plugin consumes. Core
publishes no git tags, so `VERSION` is the identity to compare against.
README.md's "Requirements" section carries the full surface table, the
three independently-checked requirements (core version, Web MIDI
browser/permission support, WebAudioFont network/audio prerequisites), and
the optional Split Screen peer floor (README "Requirements" item 4,
"*Peer plugin (optional): Split Screen, for focused multi-panel MIDI*"),
which the integration below implements.

`tests/host-compat.test.js` is the executable half of that declaration: its
fixtures reproduce the alpha.1 host surface (event bus, chart bundle,
`midi-input` v1 domain, optional splitscreen helper) and the suite pins
mount/draw/resize/destroy, MIDI discovery and routing, pause/seek/song
change, the visualization-only fallback, and split-panel focus. The suite
only ever runs against those fixtures — the claim that alpha.2 (`3a4dd7a`)
is also sufficient rests on a source audit of the same APIs, not on a run
against a live core. **When you consume a new host API, add it to the fixture
and assert it there** — a newly-consumed host surface that is only exercised
in a real browser is exactly how a minimum-version claim goes stale.

The renderer and MIDI input degrade independently: a host with no
`midi-input` domain (or a non-v1 one) still renders, but MIDI-driven synth
playback and scoring are unavailable; `_mi()` returning null is the
visualization-only path, not an error state.

## Testing

```bash
node --test tests/*.test.js        # node:test — no package.json/build step in this repo
```

Two suites: `tests/screen.test.js` (helper and rendering coverage) and
`tests/host-compat.test.js` (the minimum-host and peer-floor contracts).
Both share the DOM/`window` stub in `tests/harness.js` —
`installBrowserHarness({ feedBack, slopsmith, slopsmithSplitscreen,
storage })` — so host-contract fixtures (the `midi-input` domain, the event
bus, the splitscreen helper) live in the suites rather than in the harness
itself.

`screen.js` exports a Node-only test hook (`module.exports`, guarded by
`typeof module !== 'undefined'`) alongside the browser `window.*Viz_piano`
globals — pure helpers and `_createFactory` are reachable from tests
without a DOM.

The SRI pins for the WebAudioFont player and the 128 per-GM soundfonts are
the one thing `node --test` cannot check for correctness — a well-formed
digest is indistinguishable from a wrong one without fetching the bytes. That
check lives in `tools/verify-sri.js`: run bare it re-hashes every URL and
diffs against the constants in `screen.js` (exit 1 on drift or a non-200),
`--write` regenerates the table in place. Keep it network-free out of the
`node --test` suite and let `.github/workflows/sri-drift.yml` run it on a
schedule; add new third-party script loads to `parsePins()` in the same
commit that adds their pins.
