'use strict';
// Host-compatibility suite (issue #39).
//
// The declared minimum host is feedBack v0.3.0-alpha.1 — the first core
// commit whose `VERSION` reads `0.3.0-alpha.1` (`803bd0c`), and the
// earliest snapshot whose source carries every API this plugin consumes
// (`window.feedBackViz_<id>` factory lookup, the setRenderer lifecycle,
// the chart-bundle fields, the `midi-input` v1 domain, and the legacy
// `window.slopsmith` alias). This suite pins that floor as an executable
// contract: each fake host below reproduces every required row of README.md's
// host surface table as core defines it at that ref, and the renderer must
// mount, draw, route MIDI, and tear down against it. A host that drops any
// of these surfaces is expected to degrade, not crash — see the
// visualization-only fallback tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserHarness, loadScreen, initRendererWithHarness } = require('./harness');

// ── Core host surface fixtures ────────────────────────────────────────────

// A minimal stand-in for core's `window.feedBack` public global (plus the
// `window.slopsmith` alias core assigns to the same object at app.js
// `window.slopsmith = window.feedBack;`). `on`/`off` are the event bus the
// renderer subscribes to; `midiInput` is the v1 domain object the plugin
// reads through the legacy alias; `uiVersion` + `ui.playerControlSlot()`
// are the v3 chrome rail the settings gear mounts into instead of
// `#player-controls`.
function createCoreHost(options = {}) {
    const listeners = new Map();
    const host = {
        version: 1,
        uiVersion: 'v3',
        ui: {
            // The slot node is created lazily: createCoreHost() runs before
            // installBrowserHarness() has installed the current `document`.
            playerControlSlot() {
                return host.v3ControlSlot || (host.v3ControlSlot = document.createElement('div'));
            },
        },
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        off(name, fn) {
            const set = listeners.get(name);
            if (set) set.delete(fn);
        },
        emit(name, detail) {
            for (const fn of listeners.get(name) || []) fn({ detail });
        },
        listenerCount(name) { return (listeners.get(name) || new Set()).size; },
    };
    if (options.midiInput !== null) host.midiInput = options.midiInput || createMidiDomain();
    return host;
}

// The `midi-input` v1 domain surface, as core's static/capabilities/midi-input.js
// exposes it: version, listSources(), discover(), select(), open(), close().
// `discover` is the permission boundary; `open` yields a handle with
// addListener/removeListener.
function createMidiDomain(devices = [{ sourceId: 'd1', label: 'Test Keys', logicalSourceKey: 'web-midi::d1' }]) {
    const handleListeners = new Set();
    const handle = {
        addListener(fn) { handleListeners.add(fn); },
        removeListener(fn) { handleListeners.delete(fn); },
        emit(data) { for (const fn of handleListeners) fn(data); },
        listenerCount() { return handleListeners.size; },
    };
    const calls = [];
    return {
        version: 1,
        calls,
        handle,
        listSources: () => devices,
        async discover() { calls.push(['discover']); return { outcome: 'handled' }; },
        async select(key) { calls.push(['select', key]); return { outcome: 'handled' }; },
        async open(opts) { calls.push(['open', opts && opts.logicalSourceKey]); return { handle }; },
        close(opts) { calls.push(['close', opts && opts.logicalSourceKey]); },
    };
}

// A split-panel host helper exposing the six-method surface the plugin
// validates. `focused` is mutable so a test can move focus between panels.
// `extras` publishes the methods a later splitscreen snapshot added on top of
// the six, `omit` removes one, and every call is recorded in `calls` so a test
// can assert which methods the plugin actually reached for. `registerPanel`
// gives a panel its own chrome/bar, mirroring the real canvas -> panel index
// -> panel.div / panel.bar resolution.
function createSplitscreenHelper(options = {}) {
    const focusListeners = new Set();
    const panels = new Map();
    const calls = [];
    const chromeOf = (canvas, key) => (panels.get(canvas) || {})[key] || helper.chrome;
    const helper = {
        active: options.active !== false,
        focusedCanvas: options.focusedCanvas || null,
        chrome: options.chrome || null,
        calls,
        isActive() { calls.push(['isActive']); return helper.active; },
        isCanvasFocused(canvas) {
            calls.push(['isCanvasFocused', canvas]);
            return helper.focusedCanvas === canvas;
        },
        panelChromeFor(canvas) { calls.push(['panelChromeFor', canvas]); return chromeOf(canvas, 'panelDiv'); },
        settingsAnchorFor(canvas) { calls.push(['settingsAnchorFor', canvas]); return chromeOf(canvas, 'bar'); },
        onFocusChange(fn) { calls.push(['onFocusChange', fn]); focusListeners.add(fn); },
        offFocusChange(fn) { calls.push(['offFocusChange', fn]); focusListeners.delete(fn); },
        focusListenerCount() { return focusListeners.size; },
        setFocused(canvas) { helper.focusedCanvas = canvas; for (const fn of focusListeners) fn(); },
        registerPanel(canvas, chrome) { panels.set(canvas, chrome); return helper; },
    };
    for (const name of options.extras || []) {
        helper[name] = (...args) => { calls.push([name, ...args]); };
    }
    for (const name of options.omit || []) delete helper[name];
    return helper;
}

const BUNDLE = {
    isReady: true,
    currentTime: 1,
    notes: [{ t: 1, s: 2, f: 12, sus: 1, hand: 'R' }],
    chords: [],
    beats: [{ time: 0, measure: 1 }],
    chordTemplates: [],
    toneBase: 'Keys',
    toneChanges: [{ t: 0, name: 'Keys' }],
};

// Mounts `count` panels laid out the way Split Screen lays them out: a panel
// div per panel (its chrome / overlay host) holding that panel's control bar
// and its own highway canvas, all under #player. Panels are registered with
// `split` before `init()` because that is the order the real host uses — the
// renderer resolves its panel chrome during init(). `split` may be null for
// the no-peer case, where nothing resolves per panel.
function mountSplitPanels(plugin, harness, split, count) {
    const player = harness.doc.elementsById.player;
    return Array.from({ length: count }, () => {
        const panelDiv = harness.doc.createElement('div');
        const bar = harness.doc.createElement('div');
        const canvas = harness.doc.createElement('canvas');
        canvas.clientWidth = 640;
        canvas.clientHeight = 360;
        panelDiv.appendChild(bar);
        panelDiv.appendChild(canvas);
        player.appendChild(panelDiv);
        if (split) split.registerPanel(canvas, { panelDiv, bar });
        const renderer = plugin._createFactory();
        renderer.init(canvas);
        return { panelDiv, bar, canvas, renderer };
    });
}

// Counts note-ons per panel (by the `keys` label) so a MIDI-routing claim can
// be asserted on *which* instance received the stream.
function countNoteOns(panels, keys) {
    const seen = Object.fromEntries(keys.map(key => [key, 0]));
    panels.forEach((panel, i) => {
        const original = panel.renderer._handleNoteOn;
        panel.renderer._handleNoteOn = (midi, velocity) => {
            seen[keys[i]] += 1;
            return original(midi, velocity);
        };
    });
    return seen;
}

function mount(options = {}) {
    const host = createCoreHost(options);
    const result = initRendererWithHarness({
        feedBack: host,
        slopsmith: host,
        slopsmithSplitscreen: options.splitscreen,
        storage: options.storage,
    });
    return { ...result, host };
}

// ── Renderer lifecycle ────────────────────────────────────────────────────

test('mounts, draws, resizes and tears down against the minimum-host surface', () => {
    const { renderer, harness, canvas, plugin, host } = mount();

    // Core's picker resolves `feedBackViz_`; the legacy `slopsmithViz_` name
    // is the export splitscreen falls back to. Both must name one function.
    assert.equal(typeof window.feedBackViz_piano, 'function');
    assert.equal(window.slopsmithViz_piano, window.feedBackViz_piano);
    assert.equal(plugin._createFactory().contextType, '2d',
        'core reads contextType off the factory result before calling init()');

    assert.equal(canvas.style.visibility, 'hidden', 'host canvas is hidden in favour of the overlay');
    const overlay = harness.doc.elementsById.player.children
        .find(el => el.className === 'piano-highway-canvas');
    assert.ok(overlay, 'overlay canvas mounted');

    // The v3 chrome rail wins over #player-controls as the gear's host.
    const gearsIn = (el) => el.children.filter(child => child.className.startsWith('btn-piano-settings'));
    assert.equal(gearsIn(host.v3ControlSlot).length, 1, 'settings gear mounted into ui.playerControlSlot()');
    assert.equal(gearsIn(harness.doc.elementsById['player-controls']).length, 0,
        'settings gear did not fall back to #player-controls');

    // Auto tone is on by default, so this draw also reads the bundle's
    // declared toneChanges/toneBase rather than the no-tone fallback.
    const ctx = overlay.getContext('2d');
    ctx.fillTextCalls.length = 0;
    renderer.draw(BUNDLE);
    assert.ok(ctx.fillTextCalls.some(call => /^[A-G]$|^C-?\d+$/.test(call.text)),
        'draw() should paint the keyboard labels');

    assert.doesNotThrow(() => renderer.resize(800, 400));

    renderer.destroy();
    assert.equal(canvas.style.visibility, '', 'host canvas visibility restored on teardown');
    assert.equal(harness.rafs.size, 0, 'render loop cancelled on destroy');
});

test('subscribes to host highway events through the core event bus and unsubscribes on destroy', () => {
    const { renderer, host } = mount();

    assert.equal(host.listenerCount('highway:canvas-replaced'), 1);
    assert.equal(host.listenerCount('highway:visibility'), 1);

    renderer.destroy();

    assert.equal(host.listenerCount('highway:canvas-replaced'), 0);
    assert.equal(host.listenerCount('highway:visibility'), 0);
});

test('a draw() before init and a resize() after destroy are no-ops rather than throws', () => {
    const { renderer, plugin } = mount();

    // Nothing has been initialised on this instance yet: both calls must
    // bail out rather than reaching for the overlay that doesn't exist.
    const unprimed = plugin._createFactory();
    assert.doesNotThrow(() => unprimed.draw(BUNDLE));
    assert.doesNotThrow(() => unprimed.resize(640, 360));

    renderer.destroy();
    assert.doesNotThrow(() => renderer.draw(BUNDLE));
    assert.doesNotThrow(() => renderer.resize(640, 360));
});

// ── Pause / seek / song change ────────────────────────────────────────────

test('a seek backwards re-renders from the new position without losing the keyboard', () => {
    const { renderer, harness } = mount();
    const overlay = harness.doc.elementsById.player.children
        .find(el => el.className === 'piano-highway-canvas');
    const ctx = overlay.getContext('2d');

    renderer.draw(BUNDLE);
    renderer.draw(Object.assign({}, BUNDLE, { currentTime: 0.2 }));
    // Seeking back must not blank the board: a key label is still painted.
    ctx.fillTextCalls.length = 0;
    renderer.draw(Object.assign({}, BUNDLE, { currentTime: 30 }));
    ctx.fillTextCalls.length = 0;
    renderer.draw(Object.assign({}, BUNDLE, { currentTime: 5 }));
    assert.ok(ctx.fillTextCalls.some(call => /^[A-G]$|^C-?\d+$/.test(call.text)),
        'keyboard should still be drawn after a seek');

    renderer.destroy();
});

test('isReady false blanks the board and the false->true edge resets per-song state', () => {
    const { renderer, harness } = mount({ storage: { piano_hit_detect: 'true', piano_auto_tone: 'false' } });
    const overlay = harness.doc.elementsById.player.children
        .find(el => el.className === 'piano-highway-canvas');
    const ctx = overlay.getContext('2d');

    renderer.draw(BUNDLE);
    renderer._handleNoteOn(60, 100);
    renderer.draw(BUNDLE);
    const accuracy = () => ctx.fillTextCalls
        .map(call => call.text)
        .findLast(text => String(text).startsWith('Accuracy:'));

    assert.match(accuracy(), /Accuracy: 100%/);

    // Song change: the host drops isReady while the new chart streams in.
    ctx.fillTextCalls.length = 0;
    renderer.draw({ isReady: false, currentTime: 0, notes: [], chords: [], beats: [] });
    assert.equal(ctx.fillTextCalls.length, 0, 'an unready chart paints nothing');
    assert.doesNotThrow(() => renderer.draw(BUNDLE));

    // Scoring for the new song starts clean. The HUD is only painted once
    // there is something to score, so re-hit the chart's note and pin the
    // exact counters: a stale 100% from the old chart would read 2/2 with a
    // streak of 2, and a HUD that stopped rendering would read `undefined`.
    ctx.fillTextCalls.length = 0;
    renderer._handleNoteOn(60, 100);
    renderer.draw(BUNDLE);
    assert.match(accuracy(), /Accuracy: 100%.*Streak: 1.*Best: 1.*1\/1$/,
        'scoring must reset on a new chart');

    renderer.destroy();
});

// ── MIDI input ────────────────────────────────────────────────────────────

test('discovers, opens and routes notes from a v1 midi-input domain', async () => {
    const midiInput = createMidiDomain();
    const { renderer, host } = mount({ midiInput, storage: { piano_auto_tone: 'false' } });

    // Discovery is async; drain the microtask queue the way the host's own
    // event loop would before the test asserts.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(midiInput.calls.some(([name]) => name === 'discover'), 'discover() is the permission boundary');
    assert.ok(midiInput.calls.some(([name]) => name === 'open'), 'open-source session requested');
    // The domain identifies a device by its logicalSourceKey, so opening a
    // session without one selects nothing.
    assert.deepEqual(
        midiInput.calls.filter(([name]) => name === 'open'),
        [['open', 'web-midi::d1']],
        'the session is opened by the source key the host published');
    assert.equal(midiInput.handle.listenerCount(), 1, 'handle listener installed once the session is open');
    assert.equal(host.listenerCount('midi-input:sources-changed'), 1,
        'plug/unplug reconciliation subscribed on the bus once discovery resolved');

    const seen = [];
    const noteOn = renderer._handleNoteOn;
    const noteOff = renderer._handleNoteOff;
    renderer._handleNoteOn = (midi, velocity) => { seen.push(['on', midi, velocity]); return noteOn(midi, velocity); };
    renderer._handleNoteOff = (midi) => { seen.push(['off', midi]); return noteOff(midi); };
    midiInput.handle.emit([0x90, 60, 100]);
    midiInput.handle.emit([0x80, 60, 0]);
    assert.deepEqual(seen, [['on', 60, 100], ['off', 60]], 'note-on and note-off reach the focused instance');

    renderer.destroy();
});

test('releasing the last instance closes the domain session', async () => {
    const midiInput = createMidiDomain();
    const { renderer } = mount({ midiInput });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(midiInput.handle.listenerCount(), 1);

    renderer.destroy();

    assert.equal(midiInput.handle.listenerCount(), 0, 'handle listener removed');
    assert.ok(midiInput.calls.some(([name]) => name === 'close'), 'domain session closed on last teardown');
});

test('a second instance keeps the session alive; the last destroy closes it', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    const mountOne = () => {
        const canvas = harness.doc.createElement('canvas');
        canvas.clientWidth = 640;
        canvas.clientHeight = 360;
        harness.doc.elementsById.player.appendChild(canvas);
        const renderer = plugin._createFactory();
        renderer.init(canvas);
        return renderer;
    };
    const a = mountOne();
    const b = mountOne();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const closesBefore = midiInput.calls.filter(([name]) => name === 'close').length;
    a.destroy();
    assert.equal(midiInput.calls.filter(([name]) => name === 'close').length, closesBefore,
        'a non-final instance must not close the shared session');
    assert.equal(midiInput.handle.listenerCount(), 1, 'MIDI keeps flowing to the surviving panel');

    b.destroy();
    assert.ok(midiInput.calls.filter(([name]) => name === 'close').length > closesBefore,
        'the last instance closes the session');
});

// ── Visualization-only fallback ───────────────────────────────────────────

test('renders with no midi-input domain at all (visualization-only fallback)', () => {
    const { renderer, harness } = mount({ midiInput: null });

    const overlay = harness.doc.elementsById.player.children
        .find(el => el.className === 'piano-highway-canvas');
    assert.ok(overlay, 'the board still mounts without a MIDI domain');
    assert.doesNotThrow(() => renderer.draw(BUNDLE));
    assert.doesNotThrow(() => renderer.resize(640, 360));
    assert.doesNotThrow(() => renderer.destroy());
});

test('a non-v1 midi domain is treated as absent, not mis-consumed', () => {
    // _mi() gates on version === 1, so a v2/legacy shape must fail soft.
    const legacyDomain = Object.assign(createMidiDomain(), { version: 2 });
    const { renderer } = mount({ midiInput: legacyDomain });
    assert.doesNotThrow(() => renderer.draw(BUNDLE));
    renderer.destroy();
    assert.equal(legacyDomain.calls.length, 0, 'no discover/open attempted against a non-v1 domain');
});

test('renders on a host with no event bus at all (window-event fallback)', () => {
    // A host that publishes no bus at all: the plugin must route through
    // plain `window` events. (A bus that offers `on` but no `off` takes the
    // same path — that half-surface is covered in screen.test.js.)
    const harness = installBrowserHarness({ feedBack: { version: 1 } });
    const plugin = loadScreen();
    const renderer = plugin._createFactory();
    const canvas = harness.doc.createElement('canvas');
    canvas.clientWidth = 640;
    canvas.clientHeight = 360;
    harness.doc.elementsById.player.appendChild(canvas);
    renderer.init(canvas);

    assert.equal((harness.windowListeners.get('highway:canvas-replaced') || new Set()).size, 1);
    renderer.draw(BUNDLE);
    renderer.destroy();
    assert.equal((harness.windowListeners.get('highway:canvas-replaced') || new Set()).size, 0);
});

// ── Optional split-panel host ─────────────────────────────────────────────

test('subscribes to focus changes only when the helper exposes the full surface', () => {
    const partial = { isActive: () => true, isCanvasFocused: () => true };
    const withPartial = mount({ splitscreen: partial });
    withPartial.renderer.destroy();
    // A partial helper is reported as "not active", so the plugin must not
    // have subscribed to a focus API it cannot later unsubscribe from.
    assert.equal(typeof partial.onFocusChange, 'undefined', 'fixture has no focus API to call');

    const full = createSplitscreenHelper();
    const withFull = mount({ splitscreen: full });
    assert.equal(full.focusListenerCount(), 1, 'subscribed on init');
    withFull.renderer.destroy();
    assert.equal(full.focusListenerCount(), 0, 'unsubscribed on destroy');
});

test('only the focused panel receives routed MIDI in split-panel mode', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    const split = createSplitscreenHelper();
    window.slopsmithSplitscreen = split;

    const panels = mountSplitPanels(plugin, harness, split, 2);
    const [left, right] = panels;
    split.setFocused(left.canvas);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const seen = countNoteOns(panels, ['left', 'right']);

    midiInput.handle.emit([0x90, 60, 100]);
    assert.deepEqual(seen, { left: 1, right: 0 }, 'focused panel is the routing target');

    split.setFocused(right.canvas);
    midiInput.handle.emit([0x90, 62, 100]);
    assert.deepEqual(seen, { left: 1, right: 1 }, 'routing follows focus');

    for (const panel of panels) panel.renderer.destroy();
});

// ── Peer floor: the Split Screen focus API (issue #40) ─────────────────────
//
// Piano is standalone-compatible — with no split-panel host at all it mounts,
// draws and routes MIDI. What it cannot do without the peer is route that
// MIDI by *focus*: with several panels up, only the one the user is looking
// at may react, and only that one may own the shared synth. That needs Split
// Screen's focus API, so the peer carries a floor of its own.
//
// The floor is feedBack-plugin-splitscreen **1.10.6** — the repository's
// earliest auditable snapshot (commit `54db8d2`) — where the six focus
// methods already exist, byte-identical to how they read on `main` today
// (1.14.21, `aefac76`). Every version run in between (1.10.6 → 1.14.21, 26
// of them) was also checked to carry the six. Only 1.14.20 carries a git
// tag, so the manifest `version` is the identity to compare against, the same
// rule core follows. The two surfaces below are hand-built from the
// `window.slopsmithSplitscreen = {` literal in each snapshot, extras
// included.
//
// `extras` is the whole post-floor surface a snapshot published beyond the
// six. The guard is a positive one — the set of methods the plugin actually
// calls must be a subset of the six — so the property is a fact about
// observed calls rather than about a hand-typed exclusion list, and it can
// only ever get stronger as a snapshot adds methods.
const SPLITSCREEN_PEER_FLOOR = '1.10.6';
const SPLITSCREEN_CURRENT = '1.14.21';
const SPLITSCREEN_FOCUS_API = [
    'isActive', 'isCanvasFocused', 'panelChromeFor',
    'settingsAnchorFor', 'onFocusChange', 'offFocusChange',
];
const SPLITSCREEN_SURFACES = {
    '1.10.6': { extras: ['panelIndexFor'] },
    '1.14.21': {
        extras: [
            'panelIndexFor', 'getPanels', 'panelName', 'setPanelName', 'setPlayerContext',
            'beginOfflineRender', 'renderFrameAt', 'endOfflineRender',
        ],
    },
};

test('peer floor: the 1.10.6 surface alone drives per-panel chrome, gear anchoring and focus-routed MIDI', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    const floor = SPLITSCREEN_SURFACES[SPLITSCREEN_PEER_FLOOR];
    const split = createSplitscreenHelper({ extras: floor.extras });
    window.slopsmithSplitscreen = split;
    const panels = mountSplitPanels(plugin, harness, split, 2);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Chrome is resolved per panel rather than against the whole player: each
    // overlay lands in its own panel div, each gear in its own panel bar.
    for (const panel of panels) {
        assert.ok(panel.panelDiv.children.some(el => el.className === 'piano-highway-canvas'),
            'overlay mounted into the panel chrome panelChromeFor() returned');
        assert.equal(panel.bar.children.filter(el => el.className.startsWith('btn-piano-settings')).length, 1,
            'settings gear docked in the panel bar settingsAnchorFor() returned');
    }
    assert.equal(harness.doc.elementsById.player.children.filter(el => el.className === 'piano-highway-canvas').length, 0,
        'no overlay fell back to the whole-player mount point');
    assert.deepEqual(
        [...new Set(split.calls.filter(([name]) => name === 'panelChromeFor').map(([, canvas]) => canvas))],
        panels.map(panel => panel.canvas),
        'each panel asked the helper about its own canvas');

    // Each live instance holds a focus subscription, and releases it on teardown.
    assert.equal(split.focusListenerCount(), panels.length, 'one focus subscription per panel');

    const seen = countNoteOns(panels, ['left', 'right']);
    split.setFocused(panels[0].canvas);
    midiInput.handle.emit([0x90, 60, 100]);
    assert.deepEqual(seen, { left: 1, right: 0 }, 'only the focused panel takes the note');

    for (const panel of panels) panel.renderer.destroy();
    assert.equal(split.focusListenerCount(), 0, 'every subscription released on teardown');
});

test('the current 1.14.21 surface is consumed no further than the floor', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    const current = SPLITSCREEN_SURFACES[SPLITSCREEN_CURRENT];
    const split = createSplitscreenHelper({ extras: current.extras });
    window.slopsmithSplitscreen = split;
    const panels = mountSplitPanels(plugin, harness, split, 2);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const seen = countNoteOns(panels, ['left', 'right']);
    split.setFocused(panels[1].canvas);
    midiInput.handle.emit([0x90, 62, 100]);
    assert.deepEqual(seen, { left: 0, right: 1 }, 'routing follows focus on the current surface too');

    // What makes 1.10.6 the floor: the plugin reaches for nothing at all
    // outside the six methods the floor already ships, so the current
    // snapshot's extra eight methods are inert to it. Stated as positive
    // containment of the observed calls rather than as an exclusion list, so
    // the guarantee is a fact about what the plugin did — a post-floor
    // dependency fails here instead of being excused by the current
    // snapshot, and the 1.10.6 test above already shows the same routing with
    // only the floor's surface present.
    const called = [...new Set(split.calls.map(([name]) => name))];
    assert.ok(called.length > 0, 'the plugin did consult the helper at all');
    for (const name of called) {
        assert.ok(SPLITSCREEN_FOCUS_API.includes(name),
            `the plugin called \`${name}\`, which the ${SPLITSCREEN_PEER_FLOOR} floor does not publish`);
    }

    for (const panel of panels) panel.renderer.destroy();
});

test('a partial focus surface is probed and then left alone, with chrome falling back to the shared rail', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    // Five of the six: `offFocusChange` is missing, so a subscribe could not
    // be undone. This is the version skew the full-surface check exists for.
    const split = createSplitscreenHelper({ omit: ['offFocusChange'] });
    assert.equal(typeof split.offFocusChange, 'undefined', 'fixture really is missing the unsubscribe half');
    window.slopsmithSplitscreen = split;
    const panels = mountSplitPanels(plugin, harness, split, 2);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Nothing on a partial surface is half-consumed: the plugin asks
    // isActive(), decides the surface is not trustworthy, and stops there —
    // no chrome lookup, no focus probe, no subscription.
    assert.deepEqual([...new Set(split.calls.map(([name]) => name))], ['isActive'],
        'a partial surface is probed with isActive() and then left entirely alone');
    assert.equal(split.focusListenerCount(), 0, 'no focus subscription without a matching unsubscribe');

    // Degradation, stated as behavior rather than as "safe": the overlays fall
    // back to the whole-player mount and the gears to the shared control rail
    // instead of each panel's own chrome and bar.
    assert.equal(harness.doc.elementsById.player.children.filter(el => el.className === 'piano-highway-canvas').length,
        panels.length, 'each overlay fell back to the whole-player mount point');
    const gearsIn = (el) => el.children.filter(child => child.className.startsWith('btn-piano-settings')).length;
    assert.equal(gearsIn(host.ui.playerControlSlot()), panels.length, 'gears stacked in the shared control rail');
    for (const panel of panels) {
        assert.equal(gearsIn(panel.panelDiv) + gearsIn(panel.bar), 0, 'nothing docked inside the panel');
    }

    for (const panel of panels) panel.renderer.destroy();
});

test('with no split-panel host at all the board still renders, but MIDI follows mount order', async () => {
    const midiInput = createMidiDomain();
    const host = createCoreHost({ midiInput });
    const harness = installBrowserHarness({ feedBack: host, slopsmith: host });
    const plugin = loadScreen();

    // No helper on window at all — the standalone case, which must keep working.
    const panels = mountSplitPanels(plugin, harness, null, 2);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(window.slopsmithSplitscreen, undefined, 'no peer on window');

    for (const panel of panels) assert.doesNotThrow(() => panel.renderer.draw(BUNDLE));

    // Every instance resolves itself as focused (the main-player fast path),
    // so the routing slot lands on whichever panel initialised last. With one
    // panel that is the only panel and the answer is right; with several it is
    // why the peer is required for focused multi-panel MIDI rather than merely
    // nice to have.
    const seen = countNoteOns(panels, ['left', 'right']);
    midiInput.handle.emit([0x90, 60, 100]);
    assert.deepEqual(seen, { left: 0, right: 1 }, 'the last-mounted panel takes the stream');

    for (const panel of panels) panel.renderer.destroy();
});

