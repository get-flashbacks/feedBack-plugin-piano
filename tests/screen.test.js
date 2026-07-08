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
