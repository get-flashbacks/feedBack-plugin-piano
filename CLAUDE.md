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

**Both globals are exported** — `window.slopsmithViz_piano` (legacy name)
and `window.feedBackViz_piano = window.slopsmithViz_piano` (the
slopsmith→feedBack rename core's `vizFactory()` resolution walks). Keep
both in sync if the factory is ever renamed again; splitscreen's
`VIZ_FACTORY_PREFIXES` lookup checks `feedBackViz_` first, `slopsmithViz_`
as a fallback.

## Splitscreen focus-change integration

Under splitscreen, multiple panels can run a Piano instance simultaneously,
but only one keyboard input source (MIDI, or the on-screen keyboard) should
ever be "live" at a time — the one the user is currently looking at/using.
`window.slopsmithSplitscreen` exposes a small helper surface for this;
Piano is the only plugin observed consuming it end-to-end. The full
six-method surface (`isActive`/`isCanvasFocused`/`panelChromeFor`/
`settingsAnchorFor`/`onFocusChange`/`offFocusChange`) is verified present
as of `feedback-plugin-splitscreen` **v1.14.5**; not a hard requirement
per the full-surface-validation design described next — but this is the
minimum version this integration has actually been checked against.

`_ssActive()` (see "Splitscreen helper wrappers" in `screen.js`) validates
the **entire** surface this plugin needs before treating splitscreen as
active — `isActive`, `isCanvasFocused`, `panelChromeFor`,
`settingsAnchorFor`, `onFocusChange`, `offFocusChange` — not just
`isActive()` alone. A splitscreen build shipping a partial helper (or an
older bundled splitscreen missing a newer method) is treated as "not
active," which falls the plugin back to the main-player single-instance
fast path rather than reaching a half-broken state where focus never lands
on any instance and MIDI routing silently dies.

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
version skew.

## Versioning

Bump `version` in `plugin.json` whenever a change is user-visible — new
rendering behavior, a scoring/MIDI fix, a changed setting — since the
version cache-busts the served JS/CSS URL. Patch (`4.x.y`) for fixes,
minor (`4.x.0`) for new features, matching normal semver conventions.
`CHANGELOG.md`'s `[Unreleased]` section should be updated alongside.

## Testing

```bash
node --test tests/screen.test.js   # node:test — no package.json/build step in this repo
```

`screen.js` exports a Node-only test hook (`module.exports`, guarded by
`typeof module !== 'undefined'`) alongside the browser `window.*Viz_piano`
globals — pure helpers and `_createFactory` are reachable from tests
without a DOM.
