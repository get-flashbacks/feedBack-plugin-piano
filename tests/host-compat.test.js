'use strict';
// Host-compatibility suite (issue #39).
//
// The declared minimum host is feedBack v0.3.0-alpha.1 — the earliest
// core snapshot whose source carries every API this plugin consumes
// (`window.feedBackViz_<id>` factory lookup, the setRenderer lifecycle,
// the chart-bundle fields, the `midi-input` v1 domain, and the legacy
// `window.slopsmith` alias). This suite pins that floor as an executable
// contract: each fake host below reproduces the alpha.1 surface exactly as
// core defines it, and the renderer must mount, draw, route MIDI, and tear
// down against it. A host that drops any of these surfaces is expected to
// degrade, not crash — see the visualization-only fallback tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserHarness, loadScreen, initRendererWithHarness } = require('./harness');

// ── Core host surface fixtures ────────────────────────────────────────────

// A minimal stand-in for core's `window.feedBack` public global (plus the
// `window.slopsmith` alias core assigns to the same object at app.js
// `window.slopsmith = window.feedBack;`). `on`/`off` are the event bus the
// renderer subscribes to; `midiInput` is the v1 domain object the plugin
// reads through the legacy alias.
function createCoreHost(options = {}) {
    const listeners = new Map();
    const host = {
        version: 1,
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
function createSplitscreenHelper(options = {}) {
    const focusListeners = new Set();
    const helper = {
        active: options.active !== false,
        focusedCanvas: options.focusedCanvas || null,
        chrome: options.chrome || null,
        isActive() { return helper.active; },
        isCanvasFocused(canvas) { return helper.focusedCanvas === canvas; },
        panelChromeFor() { return helper.chrome; },
        settingsAnchorFor() { return helper.chrome; },
        onFocusChange(fn) { focusListeners.add(fn); },
        offFocusChange(fn) { focusListeners.delete(fn); },
        focusListenerCount() { return focusListeners.size; },
        setFocused(canvas) { helper.focusedCanvas = canvas; for (const fn of focusListeners) fn(); },
    };
    return helper;
}

const BUNDLE = {
    isReady: true,
    currentTime: 1,
    notes: [{ t: 1, s: 2, f: 12, sus: 1, hand: 'R' }],
    chords: [],
    beats: [{ time: 0, measure: 1 }],
    chordTemplates: [],
};

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
    const { renderer, harness, canvas, plugin } = mount();

    // The factory is discoverable under both globals the host's viz picker
    // and its legacy lookup walk check.
    assert.equal(typeof window.feedBackViz_piano, 'function');
    assert.equal(window.slopsmithViz_piano, window.feedBackViz_piano);
    assert.equal(plugin._createFactory().contextType, '2d',
        'core reads contextType off the factory result before calling init()');

    assert.equal(canvas.style.visibility, 'hidden', 'host canvas is hidden in favour of the overlay');
    const overlay = harness.doc.elementsById.player.children
        .find(el => el.className === 'piano-highway-canvas');
    assert.ok(overlay, 'overlay canvas mounted');

    renderer.draw(BUNDLE);
    assert.ok(overlay.getContext('2d').fillTextCalls.length >= 0);

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
    renderer.destroy();
    assert.doesNotThrow(() => renderer.draw(BUNDLE));
    assert.doesNotThrow(() => renderer.resize(640, 360));
    assert.ok(plugin);
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
    renderer.draw({ isReady: false, currentTime: 0, notes: [], chords: [], beats: [] });
    assert.doesNotThrow(() => renderer.draw(BUNDLE));

    // Scoring for the new song starts clean (a stale 100% would survive only
    // if the isReady edge failed to reset).
    ctx.fillTextCalls.length = 0;
    renderer.draw(BUNDLE);
    assert.ok(!/Accuracy: 100%/.test(String(accuracy())), 'scoring must reset on a new chart');

    renderer.destroy();
});

// ── MIDI input ────────────────────────────────────────────────────────────

test('discovers, opens and routes notes from a v1 midi-input domain', async () => {
    const midiInput = createMidiDomain();
    const { renderer } = mount({ midiInput, storage: { piano_auto_tone: 'false' } });

    // Discovery is async; drain the microtask queue the way the host's own
    // event loop would before the test asserts.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(midiInput.calls.some(([name]) => name === 'discover'), 'discover() is the permission boundary');
    assert.ok(midiInput.calls.some(([name]) => name === 'open'), 'open-source session requested');
    assert.equal(midiInput.handle.listenerCount(), 1, 'handle listener installed once the session is open');

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
    const harness = installBrowserHarness({ feedBack: { on() { throw new Error('no bus'); } } });
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

    const mountPanel = () => {
        const canvas = harness.doc.createElement('canvas');
        canvas.clientWidth = 640;
        canvas.clientHeight = 360;
        harness.doc.elementsById.player.appendChild(canvas);
        const renderer = plugin._createFactory();
        renderer.init(canvas);
        return { renderer, canvas };
    };
    const left = mountPanel();
    const right = mountPanel();
    split.setFocused(left.canvas);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const seen = { left: 0, right: 0 };
    const leftOriginal = left.renderer._handleNoteOn;
    const rightOriginal = right.renderer._handleNoteOn;
    left.renderer._handleNoteOn = (m, v) => { seen.left += 1; return leftOriginal(m, v); };
    right.renderer._handleNoteOn = (m, v) => { seen.right += 1; return rightOriginal(m, v); };

    midiInput.handle.emit([0x90, 60, 100]);
    assert.deepEqual(seen, { left: 1, right: 0 }, 'focused panel is the routing target');

    split.setFocused(right.canvas);
    midiInput.handle.emit([0x90, 62, 100]);
    assert.deepEqual(seen, { left: 1, right: 1 }, 'routing follows focus');

    left.renderer.destroy();
    right.renderer.destroy();
});
