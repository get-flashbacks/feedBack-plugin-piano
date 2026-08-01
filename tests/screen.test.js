'use strict';
// Coverage for pure helpers in screen.js: MIDI/note math, WebAudioFont
// naming, saved-MIDI-source resolution, and arrangement matching.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = { addEventListener: () => {} };
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

test('_rgbStr formats rgb() without alpha and rgba() with it', () => {
    assert.equal(mod._rgbStr(1, 0, 0), 'rgb(255,0,0)');
    assert.equal(mod._rgbStr(1, 0, 0, 0.5), 'rgba(255,0,0,0.5)');
    assert.equal(mod._rgbStr(0, 0, 0, 0), 'rgba(0,0,0,0)');
});

test('_wafFile/_wafVar/_wafUrl derive consistent names from a GM program number', () => {
    assert.equal(mod._wafFile(0), '0000_JCLive_sf2_file');
    assert.equal(mod._wafFile(19), '0190_JCLive_sf2_file');
    assert.equal(mod._wafVar(0), '_tone_0000_JCLive_sf2_file');
    assert.ok(mod._wafUrl(4).endsWith('0040_JCLive_sf2_file.js'));
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
