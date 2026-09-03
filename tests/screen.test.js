'use strict';
// Coverage for pure helpers in screen.js: MIDI/note math, WebAudioFont
// naming, saved-MIDI-source resolution, and arrangement matching.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function createStyle() {
    return {
        cssText: '',
        display: '',
        visibility: '',
        position: '',
        zIndex: '',
        width: '',
        height: '',
    };
}

function createElement(tagName, ownerDocument) {
    const el = {
        tagName: tagName.toUpperCase(),
        className: '',
        dataset: {},
        style: createStyle(),
        children: [],
        parentNode: null,
        ownerDocument,
        clientWidth: 640,
        clientHeight: 360,
        width: 0,
        height: 0,
        type: '',
        title: '',
        textContent: '',
        _innerHTML: '',
        _classLookup: new Map(),
        get innerHTML() { return this._innerHTML; },
        set innerHTML(value) {
            this._innerHTML = String(value);
            this._classLookup.clear();
            const classNames = this._innerHTML.match(/class="([^"]+)"/g) || [];
            for (const raw of classNames) {
                for (const cls of raw.slice(7, -1).split(/\s+/).filter(Boolean)) {
                    if (!this._classLookup.has(cls)) {
                        const child = createElement('input', ownerDocument);
                        child.className = cls;
                        child.value = '';
                        child.checked = false;
                        this._classLookup.set(cls, child);
                    }
                }
            }
        },
        onclick: null,
        attributes: {},
        appendChild(child) {
            if (child.parentNode) child.remove();
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        insertBefore(child, before) {
            if (child.parentNode) child.remove();
            child.parentNode = this;
            const idx = this.children.indexOf(before);
            if (idx === -1) this.children.push(child);
            else this.children.splice(idx, 0, child);
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            const siblings = this.parentNode.children;
            const idx = siblings.indexOf(this);
            if (idx >= 0) siblings.splice(idx, 1);
            this.parentNode = null;
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        querySelectorAll(selector) {
            if (selector === ':scope > button') return this.children.filter(c => c.tagName === 'BUTTON');
            return [];
        },
        querySelector(selector) {
            if (selector && selector.startsWith('.')) return this._classLookup.get(selector.slice(1)) || null;
            return null;
        },
        getContext(type) {
            if (tagName !== 'canvas' || type !== '2d') return null;
            return {
                canvas: this,
                setTransform() {},
                fillRect() {},
                fillText() {},
                measureText(text) { return { width: String(text).length * 6 }; },
                createLinearGradient() { return { addColorStop() {} }; },
                beginPath() {},
                moveTo() {},
                lineTo() {},
                quadraticCurveTo() {},
                closePath() {},
                fill() {},
                stroke() {},
            };
        },
    };
    return el;
}

function createDocument() {
    const doc = {
        elementsById: {},
        listeners: new Map(),
        createElement(tag) { return createElement(tag, doc); },
        getElementById(id) { return this.elementsById[id] || null; },
        querySelector() { return null; },
        querySelectorAll(selector) {
            if (!selector || !selector.startsWith('.')) return [];
            const cls = selector.slice(1);
            const out = [];
            const visit = (el) => {
                if (!el) return;
                if (String(el.className || '').split(/\s+/).includes(cls)) out.push(el);
                for (const child of el.children || []) visit(child);
                for (const child of el._classLookup ? el._classLookup.values() : []) visit(child);
            };
            for (const el of Object.values(this.elementsById)) visit(el);
            return out;
        },
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = this.listeners.get(type);
            if (set) set.delete(fn);
        },
    };
    const player = doc.createElement('div');
    player.clientWidth = 640;
    player.clientHeight = 360;
    doc.head = doc.createElement('head');
    const controls = doc.createElement('div');
    controls.clientWidth = 640;
    controls.clientHeight = 48;
    const close = doc.createElement('button');
    doc.elementsById.player = player;
    doc.elementsById['player-controls'] = controls;
    player.appendChild(controls);
    controls.appendChild(close);
    return doc;
}

function installBrowserHarness(options = {}) {
    const doc = createDocument();
    const windowListeners = new Map();
    let rafId = 0;
    const rafs = new Map();
    global.window = {
        devicePixelRatio: 1,
        feedBack: options.feedBack,
        highway: { resize() {} },
        addEventListener(type, fn) {
            if (!windowListeners.has(type)) windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = windowListeners.get(type);
            if (set) set.delete(fn);
        },
        dispatchEvent(ev) {
            for (const fn of windowListeners.get(ev.type) || []) fn(ev);
        },
        requestAnimationFrame(fn) {
            const id = ++rafId;
            rafs.set(id, fn);
            return id;
        },
        cancelAnimationFrame(id) { rafs.delete(id); },
    };
    global.document = doc;
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.requestAnimationFrame = global.window.requestAnimationFrame;
    global.cancelAnimationFrame = global.window.cancelAnimationFrame;
    global.performance = { now: () => 0 };
    return { doc, windowListeners, rafs };
}

function freshPlugin(options = {}) {
    installBrowserHarness(options);
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

const mod = freshPlugin();

test('noteToMidi maps string/fret to a MIDI number (24 semitones per string)', () => {
    assert.equal(mod.noteToMidi(0, 0), 0);
    assert.equal(mod.noteToMidi(1, 5), 29);
    assert.equal(mod.noteToMidi(2, 12), 60);
});

test('midiToNoteName maps chromatic index + octave', () => {
    assert.equal(mod.midiToNoteName(60), 'C4');
    assert.equal(mod.midiToNoteName(61), 'C#4');
    assert.equal(mod.midiToNoteName(69), 'A4');
    assert.equal(mod.midiToNoteName(0), 'C-1');
});

test('isBlackKey flags the five chromatic black-key pitch classes', () => {
    const black = new Set([1, 3, 6, 8, 10]);
    for (let pc = 0; pc < 12; pc++) {
        assert.equal(mod.isBlackKey(60 + pc), black.has(pc), `pc=${pc}`);
    }
});

test('_neonRGB cycles through 12 entries by pitch class', () => {
    assert.deepEqual(mod._neonRGB(60), mod._neonRGB(72)); // same pitch class, different octave
    assert.notDeepEqual(mod._neonRGB(60), mod._neonRGB(61));
});

test('midiToNoteName, isBlackKey, and _neonRGB tolerate negative midi from malformed chart data', () => {
    // A crafted chart/GP import with out-of-range string/fret values can
    // produce a negative `midi` (noteToMidi = s*24+f). JS's `%` returns a
    // negative remainder for that, which must not throw or index out of
    // bounds — it should fold to the same pitch class as the positive
    // equivalent (-1 === pitch class 11, one octave down from 11).
    assert.doesNotThrow(() => mod.midiToNoteName(-1));
    assert.doesNotThrow(() => mod.isBlackKey(-1));
    assert.doesNotThrow(() => mod._neonRGB(-1));
    // -1 is pitch class 11 (B), one octave below midi 11 ('B-1').
    assert.equal(mod.midiToNoteName(-1), 'B-2');
    assert.equal(mod.isBlackKey(-1), mod.isBlackKey(11));
    assert.deepEqual(mod._neonRGB(-1), mod._neonRGB(11));
});

test('_rgbStr formats rgb() without alpha and rgba() with it', () => {
    assert.equal(mod._rgbStr(1, 0, 0), 'rgb(255,0,0)');
    assert.equal(mod._rgbStr(1, 0, 0, 0.5), 'rgba(255,0,0,0.5)');
    assert.equal(mod._rgbStr(0, 0, 0, 0), 'rgba(0,0,0,0)');
});

test('_controllerRangeOverlayBounds maps a detected range onto visible keys', () => {
    const layout = [
        {midi: 48, x: 0, w: 10}, {midi: 60, x: 100, w: 10}, {midi: 72, x: 200, w: 10}
    ];
    assert.deepEqual(mod._controllerRangeOverlayBounds(layout, 55, 70), {
        x1: 100, x2: 110, lo: 55, hi: 70
    });
    assert.equal(mod._controllerRangeOverlayBounds(layout, 0, 20), null);
});

test('_wafFile/_wafVar/_wafUrl derive consistent names from a GM program number', () => {
    assert.equal(mod._wafFile(0), '0000_JCLive_sf2_file');
    assert.equal(mod._wafFile(19), '0190_JCLive_sf2_file');
    assert.equal(mod._wafVar(0), '_tone_0000_JCLive_sf2_file');
    assert.ok(mod._wafUrl(4).endsWith('0040_JCLive_sf2_file.js'));
});

test('_gmForToneName maps tone/rig names to GM program numbers, most-specific first', () => {
    assert.equal(mod._gmForToneName('Violin'), 40);
    assert.equal(mod._gmForToneName('lead violin section'), 40);
    assert.equal(mod._gmForToneName('Keys'), 0);
    assert.equal(mod._gmForToneName('Grand Piano'), 0);
    // "Electric Piano" must not fall through to the bare "piano" match.
    assert.equal(mod._gmForToneName('Electric Piano'), 4);
    assert.equal(mod._gmForToneName('Rhodes'), 4);
    assert.equal(mod._gmForToneName('Clean Guitar'), null); // unmapped, not guessed
    assert.equal(mod._gmForToneName(''), null);
    assert.equal(mod._gmForToneName(null), null);
    // Word-boundary regressions caught in review: "string" must not match
    // as a bare prefix (e.g. "substring"), and a lone "pad" must not match
    // outside a "synth pad" context (e.g. "footpad").
    assert.equal(mod._gmForToneName('Substring Theory'), null);
    assert.equal(mod._gmForToneName('String Section'), 48);
    assert.equal(mod._gmForToneName('Strings'), 48);
    assert.equal(mod._gmForToneName('Footpad'), null);
    assert.equal(mod._gmForToneName('Synth Pad'), 88);
});

test('_activeToneNameAt resolves the most recent tone_changes entry at or before t', () => {
    const changes = [
        { t: 0, name: 'Keys' },
        { t: 10, name: 'Violin' },
        { t: 20, name: 'Strings' },
    ];
    assert.equal(mod._activeToneNameAt(changes, 'Base Tone', 5), 'Keys');
    assert.equal(mod._activeToneNameAt(changes, 'Base Tone', 10), 'Violin');
    assert.equal(mod._activeToneNameAt(changes, 'Base Tone', 15), 'Violin');
    assert.equal(mod._activeToneNameAt(changes, 'Base Tone', 999), 'Strings');
    // Before the first entry (or no entries at all) -- falls back to base.
    assert.equal(mod._activeToneNameAt(changes, 'Base Tone', -1), 'Base Tone');
    assert.equal(mod._activeToneNameAt([], 'Base Tone', 5), 'Base Tone');
    assert.equal(mod._activeToneNameAt(null, 'Base Tone', 5), 'Base Tone');
    assert.equal(mod._activeToneNameAt(null, null, 5), null);
});

test('_midiResolveSaved matches by stored key first, falls back to legacy bare id', () => {
    const sources = [{ id: 'dev1', key: 'webmidi:dev1' }, { id: 'dev2', key: 'webmidi:dev2' }];
    assert.equal(mod._midiResolveSaved('webmidi:dev2', sources), 'webmidi:dev2');
    assert.equal(mod._midiResolveSaved('dev1', sources), 'webmidi:dev1'); // legacy bare id
    assert.equal(mod._midiResolveSaved('nope', sources), null);
    assert.equal(mod._midiResolveSaved(null, sources), null);
    assert.equal(mod._midiResolveSaved('', sources), null);
});

test('_computeOctaveShift is a no-op without a detected controller range or target', () => {
    assert.equal(mod._computeOctaveShift(null, null, 48, 95), 0);
    assert.equal(mod._computeOctaveShift(36, 60, null, null), 0);
});

function _bestOctaveOverflow(controllerLo, controllerHi, targetLo, targetHi) {
    let best = Infinity;
    for (let oct = -8; oct <= 8; oct++) {
        const s = oct * 12;
        const overflow = Math.max(0, targetLo - (controllerLo + s)) + Math.max(0, (controllerHi + s) - targetHi);
        if (overflow < best) best = overflow;
    }
    return best;
}

test('_computeOctaveShift shifts a narrow low controller up toward a higher target passage', () => {
    // 25-key controller starting at C2 (36..60), upcoming passage sits at C6..B6 (84..95).
    const shift = mod._computeOctaveShift(36, 60, 84, 95);
    assert.ok(shift > 0, 'should shift upward toward the higher passage');
    const overflow = Math.max(0, 84 - (36 + shift)) + Math.max(0, (60 + shift) - 95);
    assert.equal(overflow, _bestOctaveOverflow(36, 60, 84, 95));
});

test('_computeOctaveShift shifts a narrow high controller down toward a lower target passage', () => {
    // 25-key controller starting at C6 (84..108), upcoming passage sits at C2..C3 (36..48).
    const shift = mod._computeOctaveShift(84, 108, 36, 48);
    assert.ok(shift < 0, 'should shift downward toward the lower passage');
    const overflow = Math.max(0, 36 - (84 + shift)) + Math.max(0, (108 + shift) - 48);
    assert.equal(overflow, _bestOctaveOverflow(84, 108, 36, 48));
});

test('_computeOctaveShift picks the smallest shift among equally-good fits', () => {
    // A 12-key span fits with zero overflow at many multiples of an octave;
    // the smallest absolute shift should win over an equally-valid larger one.
    const shift = mod._computeOctaveShift(48, 59, 48, 95);
    assert.equal(shift, 0);
});

test('_computeOctaveShift has no "wide controller, skip" shortcut — a wide but misplaced controller still shifts', () => {
    // Regression test: an earlier version short-circuited to 0 whenever the
    // controller's span was >= the target's span, on the theory that a wide
    // controller "already covers" the song. That's wrong once the target is a
    // short near-term lookahead rather than the whole song: a 61-key
    // controller sitting at C2..C6 (36..84, span 48) is plenty wide, but if
    // the very next notes are up at C7..C8 (96..108, span 12) it still needs
    // a shift — span comparison alone can't tell you it's positioned wrong.
    const shift = mod._computeOctaveShift(36, 84, 96, 108);
    assert.notEqual(shift, 0);
    assert.ok(36 + shift <= 108 && 84 + shift >= 96, 'shifted controller should overlap the target passage');
});

test('_computeOctaveShift minimizes overflow when no shift fits fully', () => {
    // Controller (0..20, 21 keys) is narrower than the target span (48..95,
    // 48 semitones) but no whole-octave shift can land it fully inside —
    // the best available shift should still land it as close as possible.
    const shift = mod._computeOctaveShift(0, 20, 48, 95);
    const lo = 0 + shift, hi = 20 + shift;
    const overflow = Math.max(0, 48 - lo) + Math.max(0, hi - 95);
    // No smaller-overflow shift should exist among whole octaves.
    for (let oct = -8; oct <= 8; oct++) {
        const s = oct * 12;
        const altOverflow = Math.max(0, 48 - (0 + s)) + Math.max(0, (20 + s) - 95);
        assert.ok(altOverflow >= overflow, `oct=${oct} beat the chosen shift`);
    }
});

test('_nearTermMidiRange only considers notes within the lookahead window', () => {
    const notes = [
        { t: 0.0, s: 0, f: 0 },   // midi 0, before the window start (t=1 - 0.1 slack = 0.9) -> excluded
        { t: 1.0, s: 2, f: 0 },   // midi 48, inside [1.0, 2.0]
        { t: 1.9, s: 3, f: 0 },   // midi 72, inside
        { t: 2.5, s: 5, f: 0 },   // midi 120, after the window -> excluded
    ];
    const range = mod._nearTermMidiRange(notes, null, 1.0, 1.0);
    assert.deepEqual(range, { lo: 48, hi: 72 });
});

test('_nearTermMidiRange returns null when nothing falls in the lookahead (a rest)', () => {
    const notes = [{ t: 10.0, s: 2, f: 0 }];
    assert.equal(mod._nearTermMidiRange(notes, null, 0.0, 1.0), null);
});

test('_nearTermMidiRange considers chord notes too', () => {
    const chords = [{ t: 1.0, notes: [{ s: 1, f: 0 }, { s: 4, f: 0 }] }]; // midi 24, midi 96
    const range = mod._nearTermMidiRange(null, chords, 1.0, 0.5);
    assert.deepEqual(range, { lo: 24, hi: 96 });
});

test('matchesArrangement rejects a falsy songInfo', () => {
    assert.equal(mod.matchesArrangement(null), false);
    assert.equal(mod.matchesArrangement(undefined), false);
});

test('matchesArrangement matches on the top-level arrangement name', () => {
    assert.equal(mod.matchesArrangement({ arrangement: 'Piano' }), true);
    assert.equal(mod.matchesArrangement({ arrangement: 'Keys' }), true);
    assert.equal(mod.matchesArrangement({ arrangement: 'Lead Guitar' }), false);
});

test('matchesArrangement matches via the active entry in an arrangements list', () => {
    const songInfo = {
        arrangement_index: 1,
        arrangements: [{ index: 0, name: 'Guitar' }, { index: 1, name: 'Keyboard' }],
    };
    assert.equal(mod.matchesArrangement(songInfo), true);
});

test('matchesArrangement yields to notation viz plugins for notation-only keys arrangements', () => {
    const songInfo = {
        has_notation: true,
        arrangement_index: 0,
        arrangements: [{ index: 0, name: 'Piano', notes: 0 }],
    };
    assert.equal(mod.matchesArrangement(songInfo), false);
});

test('matchesArrangement keeps legacy keys sloppaks that still carry wire notes', () => {
    const songInfo = {
        has_notation: true,
        arrangement_index: 0,
        arrangements: [{ index: 0, name: 'Piano', notes: 42 }],
    };
    assert.equal(mod.matchesArrangement(songInfo), true);
});

function initRendererWithHarness(options = {}) {
    const harness = installBrowserHarness(options);
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const plugin = require(file);
    const renderer = plugin._createFactory();
    const canvas = harness.doc.createElement('canvas');
    canvas.clientWidth = 640;
    canvas.clientHeight = 360;
    harness.doc.elementsById.player.appendChild(canvas);
    renderer.init(canvas);
    return { harness, renderer, canvas };
}

function listenerCount(harness, type) {
    return (harness.windowListeners.get(type) || new Set()).size;
}

function openSettingsPanel(harness) {
    const gear = harness.doc.elementsById['player-controls'].children.find(el => el.className.includes('btn-piano-settings'));
    assert.ok(gear, 'settings gear should be mounted');
    gear.onclick();
    const panel = harness.doc.elementsById.player.children.find(el => el.className === 'piano-settings-panel');
    assert.ok(panel, 'settings panel should be open');
    return panel;
}

function replaceCanvas(harness, oldCanvas) {
    const player = harness.doc.elementsById.player;
    const next = harness.doc.createElement('canvas');
    next.clientWidth = 640;
    next.clientHeight = 360;
    player.appendChild(next);
    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas, canvas: next } });
    return next;
}

test('renderer lifecycle events register and remove through the window backend', () => {
    const { harness, renderer } = initRendererWithHarness();
    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 1);
    assert.equal(listenerCount(harness, 'highway:visibility'), 1);

    renderer.destroy();

    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 0);
    assert.equal(listenerCount(harness, 'highway:visibility'), 0);
});

test('renderer lifecycle events register and remove through the feedBack backend when on/off are both present', () => {
    const listeners = new Map();
    const feedBack = {
        on(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        off(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
    };
    const { renderer } = initRendererWithHarness({ feedBack });

    assert.equal((listeners.get('highway:canvas-replaced') || new Set()).size, 1);
    assert.equal((listeners.get('highway:visibility') || new Set()).size, 1);

    renderer.destroy();

    assert.equal((listeners.get('highway:canvas-replaced') || new Set()).size, 0);
    assert.equal((listeners.get('highway:visibility') || new Set()).size, 0);
});

test('renderer lifecycle removes listeners from the subscribed backend if feedBack changes', () => {
    const originalListeners = new Map();
    const replacementListeners = new Map();
    const createFeedBack = (listeners) => ({
        on(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        off(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
    });
    const originalFeedBack = createFeedBack(originalListeners);
    const { renderer } = initRendererWithHarness({ feedBack: originalFeedBack });

    assert.equal((originalListeners.get('highway:canvas-replaced') || new Set()).size, 1);
    assert.equal((originalListeners.get('highway:visibility') || new Set()).size, 1);

    window.feedBack = createFeedBack(replacementListeners);
    renderer.destroy();

    assert.equal((originalListeners.get('highway:canvas-replaced') || new Set()).size, 0);
    assert.equal((originalListeners.get('highway:visibility') || new Set()).size, 0);
    assert.equal((replacementListeners.get('highway:canvas-replaced') || new Set()).size, 0);
    assert.equal((replacementListeners.get('highway:visibility') || new Set()).size, 0);
});

test('renderer lifecycle falls back to window events unless feedBack has both on and off', () => {
    const feedBack = { on() { throw new Error('feedBack.on should not be used without off'); } };
    const { harness, renderer } = initRendererWithHarness({ feedBack });

    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 1);
    assert.equal(listenerCount(harness, 'highway:visibility'), 1);

    renderer.destroy();

    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 0);
    assert.equal(listenerCount(harness, 'highway:visibility'), 0);
});

test('canvas replacement ignores unrelated canvases and rebuilds overlays for the targeted canvas', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const player = harness.doc.elementsById.player;
    const originalOverlay = player.children.find(el => el.className === 'piano-highway-canvas');
    assert.ok(originalOverlay, 'initial overlay should exist');

    const unrelated = harness.doc.createElement('canvas');
    const next = harness.doc.createElement('canvas');
    next.clientWidth = 800;
    next.clientHeight = 400;
    player.appendChild(next);

    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas: unrelated, canvas: next } });
    assert.equal(player.children.includes(originalOverlay), true, 'unrelated event should leave overlay alone');

    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas: canvas, canvas: next } });

    const overlays = player.children.filter(el => el.className === 'piano-highway-canvas');
    assert.equal(overlays.length, 1);
    assert.notEqual(overlays[0], originalOverlay);
    assert.equal(canvas.style.visibility, '');
    assert.equal(next.style.visibility, 'hidden');

    renderer.destroy();
});

test('canvas replacement preserves an open settings panel and closed-panel behavior', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const player = harness.doc.elementsById.player;
    const panel = openSettingsPanel(harness);

    let panels = player.children.filter(el => el.className === 'piano-settings-panel');
    assert.equal(panels.length, 1);
    assert.equal(panel.style.display, '');

    const next = harness.doc.createElement('canvas');
    next.clientWidth = 640;
    next.clientHeight = 360;
    player.appendChild(next);
    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas: canvas, canvas: next } });

    panels = player.children.filter(el => el.className === 'piano-settings-panel');
    assert.equal(panels.length, 1, 'open settings panel should be recreated');
    assert.equal(panels[0].style.display, '');

    const nextGear = harness.doc.elementsById['player-controls'].children.find(el => el.className.includes('btn-piano-settings'));
    nextGear.onclick();
    assert.equal(player.children.filter(el => el.className === 'piano-settings-panel').length, 1);
    assert.equal(player.children.find(el => el.className === 'piano-settings-panel').style.display, 'none');

    const finalCanvas = harness.doc.createElement('canvas');
    player.appendChild(finalCanvas);
    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas: next, canvas: finalCanvas } });
    assert.equal(player.children.filter(el => el.className === 'piano-settings-panel').length, 0, 'closed panel should stay closed');

    renderer.destroy();
});

test('canvas replacement preserves range detection while waiting for the low key', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const panel = openSettingsPanel(harness);
    panel.querySelector('.piano-octave-detect').onclick();
    assert.equal(panel.querySelector('.piano-octave-status').textContent, 'Press your LOWEST key…');

    replaceCanvas(harness, canvas);

    const restoredPanel = harness.doc.elementsById.player.children.find(el => el.className === 'piano-settings-panel');
    assert.equal(restoredPanel.querySelector('.piano-octave-status').textContent, 'Press your LOWEST key…');

    renderer.destroy();
});

test('canvas replacement preserves range detection after capturing the low key', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const panel = openSettingsPanel(harness);
    panel.querySelector('.piano-octave-detect').onclick();
    renderer._handleNoteOn(48, 100);
    assert.equal(panel.querySelector('.piano-octave-status').textContent, 'Now press your HIGHEST key…');

    replaceCanvas(harness, canvas);

    const restoredPanel = harness.doc.elementsById.player.children.find(el => el.className === 'piano-settings-panel');
    assert.equal(restoredPanel.querySelector('.piano-octave-status').textContent, 'Now press your HIGHEST key…');
    renderer._handleNoteOn(72, 100);
    assert.equal(restoredPanel.querySelector('.piano-octave-status').textContent, 'Detected C3–C5 (25 keys)');

    renderer.destroy();
});

test('visibility events hide and restore overlay chrome for targeted canvases only', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const player = harness.doc.elementsById.player;
    const overlay = player.children.find(el => el.className === 'piano-highway-canvas');
    const panel = openSettingsPanel(harness);
    const gear = harness.doc.elementsById['player-controls'].children.find(el => el.className.includes('btn-piano-settings'));

    window.dispatchEvent({ type: 'highway:visibility', detail: { canvas, visible: false } });
    assert.equal(overlay.style.display, 'none');
    assert.equal(gear.style.display, 'none');
    assert.equal(panel.style.display, 'none');

    window.dispatchEvent({ type: 'highway:visibility', detail: { canvas: harness.doc.createElement('canvas'), visible: true } });
    assert.equal(overlay.style.display, 'none', 'unrelated visibility event should be ignored');

    window.dispatchEvent({ type: 'highway:visibility', detail: { canvas, hidden: false } });
    assert.equal(overlay.style.display, '');
    assert.equal(gear.style.display, '');
    assert.equal(panel.style.display, '');

    renderer.destroy();
});

test('destroy and defensive re-init clean up prior listeners and overlays', () => {
    const { harness, renderer, canvas } = initRendererWithHarness();
    const player = harness.doc.elementsById.player;
    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 1);
    assert.equal(player.children.filter(el => el.className === 'piano-highway-canvas').length, 1);

    const secondCanvas = harness.doc.createElement('canvas');
    secondCanvas.clientWidth = 640;
    secondCanvas.clientHeight = 360;
    player.appendChild(secondCanvas);
    renderer.init(secondCanvas);

    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 1, 're-init should not leak canvas listeners');
    assert.equal(listenerCount(harness, 'highway:visibility'), 1, 're-init should not leak visibility listeners');
    assert.equal(player.children.filter(el => el.className === 'piano-highway-canvas').length, 1, 're-init should remove prior overlay');
    assert.equal(canvas.style.visibility, '');

    renderer.destroy();

    assert.equal(listenerCount(harness, 'highway:canvas-replaced'), 0);
    assert.equal(listenerCount(harness, 'highway:visibility'), 0);
    assert.equal(player.children.filter(el => el.className === 'piano-highway-canvas').length, 0);

    const thirdCanvas = harness.doc.createElement('canvas');
    player.appendChild(thirdCanvas);
    window.dispatchEvent({ type: 'highway:canvas-replaced', detail: { oldCanvas: secondCanvas, canvas: thirdCanvas } });
    assert.equal(player.children.filter(el => el.className === 'piano-highway-canvas').length, 0, 'callbacks should stop after destroy');
});

test('destroy and defensive re-init cancel pending init animation frames', () => {
    const { harness, renderer } = initRendererWithHarness();
    const player = harness.doc.elementsById.player;
    assert.equal(harness.rafs.size, 1, 'init should schedule one follow-up layout frame');

    renderer.destroy();
    assert.equal(harness.rafs.size, 0, 'destroy should cancel the pending init frame');

    const canvas = harness.doc.createElement('canvas');
    player.appendChild(canvas);
    renderer.init(canvas);
    assert.equal(harness.rafs.size, 1);

    const secondCanvas = harness.doc.createElement('canvas');
    player.appendChild(secondCanvas);
    renderer.init(secondCanvas);
    assert.equal(harness.rafs.size, 1, 're-init should cancel the old init frame before scheduling a new one');

    renderer.destroy();
    assert.equal(harness.rafs.size, 0);
});
