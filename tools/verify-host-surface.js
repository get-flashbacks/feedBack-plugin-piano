'use strict';
// Verify that the host API surface declared in README.md ("Requirements" →
// "1. Host") still exists in feedBack core, at the refs we audited.
//
//   node tools/verify-host-surface.js              verify, exit 1 on drift
//   node tools/verify-host-surface.js --ref main   verify against another ref
//   node tools/verify-host-surface.js --list       print the surface and exit
//
// tests/host-compat.test.js pins the plugin's *behavior* against hand-written
// fixtures, so it cannot notice core changing: rename `logicalSourceKey`, drop
// `setRenderer` from every file core ships it in, or drop
// `ui.playerControlSlot()` and all 13 tests still pass. This script closes
// that gap from the other side — it checks core's own source for each declared
// API, so a minimum-version claim degrades loudly instead of silently.
//
// It needs a core checkout, which this repo does not carry, so it clones (or
// reuses) one under a temp dir. That needs the network, hence the scheduled
// CI job (`.github/workflows/host-surface-drift.yml`) rather than a per-PR
// gate — the same reasoning as sri-drift.yml. The per-PR half is the network-
// free parity check in tests/host-compat.test.js, which asserts the same
// probe table and README table agree.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE_REPO = 'https://github.com/get-flashbacks/feedBack.git';

// The refs this plugin's declared floor was audited against. The first is the
// declared minimum; the second is the current head at the time of writing.
// `VERSION` is the identity core publishes (it ships no git tags).
const AUDITED_REFS = [
    { ref: '803bd0cdf3b5b004e9057a109b7c0b0ef3688fed', version: '0.3.0-alpha.1', role: 'declared minimum host' },
    { ref: '3a4dd7ad6eea30edc6217f5dd1bf1f595c9e6c88', version: '0.3.0-alpha.2', role: 'current head when audited' },
];

// Files under core's static/ and lib/ that are first-party. `static/vendor/`
// and `static/js/*.min.js` bundle third-party code that mentions plenty of the
// words we probe for (`resize`, `notes`, `chordTemplates`), so matching into
// them would turn a renamed core API into a false pass. listFiles() has already
// narrowed to `static/` and `lib/`, so the vendor check only needs the prefix
// `static/` to anchor on.
const FIRST_PARTY = /^(?:static\/(?!vendor\/)|lib\/)/;

// Each entry: the API as README.md names it, and a probe for it. `paths` are
// file globs under core's repo root; `pattern` is matched against file
// contents. `optional: true` mirrors README's "optional" rows — those are
// consumed behind a `typeof` guard, so a miss is reported but does not fail.
//
// Keep `name` byte-identical to the token README.md's table uses for it:
// checkTableParity() below fails the run if the two drift apart, which is
// what stops this table from rotting into a second, unmaintained copy of the
// README's.
const SURFACE = [
    {
        name: 'feedBackViz_',
        paths: ['static/app.js', 'static/js/viz.js', 'static/capabilities/visualization.js'],
        pattern: /feedBackViz_/,
    },
    {
        name: 'slopsmithViz_',
        paths: ['static/app.js', 'static/js/viz.js', 'static/capabilities/visualization.js'],
        pattern: /slopsmithViz_/,
        optional: true,
    },
    {
        name: 'contextType',
        paths: ['static/**/*.js'],
        pattern: /contextType/,
    },
    {
        name: 'setRenderer',
        paths: ['static/**/*.js'],
        pattern: /setRenderer/,
    },
    {
        name: 'init',
        paths: ['static/highway.js', 'static/js/viz.js', 'static/app.js'],
        pattern: /\binit\b/,
    },
    {
        name: 'draw',
        paths: ['static/highway.js', 'static/js/viz.js', 'static/app.js'],
        pattern: /\bdraw\b/,
    },
    {
        name: 'resize',
        paths: ['static/highway.js', 'static/js/viz.js', 'static/app.js'],
        pattern: /\bresize\b/,
    },
    {
        name: 'destroy',
        paths: ['static/highway.js', 'static/js/viz.js', 'static/app.js'],
        pattern: /\bdestroy\b/,
    },
    {
        name: 'matchesArrangement',
        paths: ['static/app.js', 'static/js/viz.js', 'static/highway.js', 'static/capabilities/visualization.js'],
        pattern: /matchesArrangement/,
    },
    // Bundle fields. `isReady`/`currentTime`/`notes`/`chords`/`beats` are
    // assigned onto the bundle object core hands renderers; the rest are
    // module-level state in highway.js that ends up on it.
    { name: 'isReady', paths: ['static/highway.js'], pattern: /b\.isReady|isReady\s*:/ },
    { name: 'currentTime', paths: ['static/highway.js'], pattern: /currentTime/ },
    { name: 'notes', paths: ['static/highway.js'], pattern: /b\.notes|notes\s*=/ },
    { name: 'chords', paths: ['static/highway.js'], pattern: /b\.chords|chords\s*=/ },
    { name: 'beats', paths: ['static/highway.js'], pattern: /b\.beats|beats\s*=/ },
    { name: 'chordTemplates', paths: ['static/highway.js'], pattern: /chordTemplates/ },
    { name: 'toneChanges', paths: ['static/highway.js'], pattern: /b\.toneChanges|toneChanges\s*=/ },
    { name: 'toneBase', paths: ['static/highway.js'], pattern: /toneBase/ },
    { name: 'has_notation', paths: ['static/**/*.py', 'static/**/*.js', 'lib/**/*.py'], pattern: /has_notation/ },
    // `songInfo.arrangement` is the top-level name matchesArrangement checks
    // first, before falling back to the `arrangements` list.
    { name: 'arrangement', paths: ['static/app.js', 'static/js/viz.js', 'static/highway.js', 'lib/**/*.py'], pattern: /arrangement/ },
    { name: 'arrangements', paths: ['static/**/*.js', 'lib/**/*.py'], pattern: /arrangements/ },
    { name: 'arrangement_index', paths: ['static/**/*.js', 'lib/**/*.py'], pattern: /arrangement_index/ },
    { name: 'highway:canvas-replaced', paths: ['static/highway.js', 'static/app.js', 'static/js/viz.js'], pattern: /highway:canvas-replaced/ },
    { name: 'highway:visibility', paths: ['static/highway.js', 'static/app.js', 'static/js/viz.js'], pattern: /highway:visibility/ },
    { name: 'midi-input:sources-changed', paths: ['static/capabilities/midi-input.js', 'static/capabilities.js'], pattern: /sources-changed/ },
    { name: 'midiInput', paths: ['static/capabilities/midi-input.js'], pattern: /window\.feedBack\.midiInput/ },
    { name: 'discover', paths: ['static/capabilities/midi-input.js'], pattern: /discover:/ },
    { name: 'listSources', paths: ['static/capabilities/midi-input.js'], pattern: /listSources/ },
    { name: 'select', paths: ['static/capabilities/midi-input.js'], pattern: /select:/ },
    { name: 'open', paths: ['static/capabilities/midi-input.js'], pattern: /open:/ },
    { name: 'close', paths: ['static/capabilities/midi-input.js'], pattern: /close:/ },
    { name: 'logicalSourceKey', paths: ['static/capabilities/midi-input.js'], pattern: /logicalSourceKey/ },
    { name: 'uiVersion', paths: ['static/v3/player-chrome.js', 'static/app.js', 'static/js/viz.js'], pattern: /uiVersion/ },
    { name: 'playerControlSlot', paths: ['static/v3/player-chrome.js', 'static/app.js', 'static/js/viz.js'], pattern: /playerControlSlot/ },
    { name: 'highway.resize', paths: ['static/highway.js'], pattern: /resize\(\)/, optional: true },
    // The event bus the renderer subscribes to, and the legacy alias it reads
    // the MIDI domain through (`_mi()` reads window.slopsmith.midiInput).
    { name: 'feedBack.on', paths: ['static/app.js', 'static/capabilities.js'], pattern: /window\.feedBack\.on|^\s*on\s*\(/m },
    { name: 'off', paths: ['static/app.js', 'static/capabilities.js'], pattern: /window\.feedBack\.off|^\s*off\s*\(/m },
    { name: 'window.slopsmith', paths: ['static/app.js'], pattern: /window\.slopsmith\s*=\s*window\.feedBack/ },
];

const README = path.join(__dirname, '..', 'README.md');

// README's own "1. Host" table, used for the parity check. Anchored on the
// heading so a future "2. Browser"/"3. Network" restructure can't silently
// repoint it at the wrong table.
function readmeHostTable() {
    const src = fs.readFileSync(README, 'utf8');
    const start = src.indexOf('### 1. Host');
    if (start === -1) throw new Error('could not find the "### 1. Host" section in README.md');
    const rest = src.slice(start + 1);
    const end = rest.search(/\n### /);
    return end === -1 ? rest : rest.slice(0, end);
}

// Fail if the probe table and README's table name different APIs. Two lists
// that must be kept in sync by hand is one list too many; this is what makes
// the README the source of truth rather than a stale copy of it.
function checkTableParity() {
    const table = readmeHostTable();
    const tokens = [...table.matchAll(/`([^`]+)`/g)].map((match) =>
        match[1].replace(/<[^>]*>/g, '').replace(/\(.*$/, ''));
    const missing = SURFACE.filter((api) => !tokens.some((token) =>
        token === api.name || token.endsWith('.' + api.name))).map((api) => api.name);
    if (missing.length) {
        console.error('README.md\'s host table does not name: ' + missing.join(', '));
        console.error('Add the row to README.md ("Requirements" → "1. Host") and a probe to SURFACE in tools/verify-host-surface.js.');
        return false;
    }
    return true;
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Clone core once per run, shallow per ref, into a temp dir. Reuses a caller-
// supplied CORE_CHECKOUT so a local run can skip the network entirely.
function withCore(fn) {
    if (process.env.CORE_CHECKOUT) return fn(process.env.CORE_CHECKOUT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-core-'));
    try {
        console.log('cloning ' + CORE_REPO + '…');
        git(['clone', '--quiet', '--filter=blob:none', CORE_REPO, dir], process.cwd());
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function checkout(repo, ref) {
    git(['fetch', '--quiet', '--depth', '1', 'origin', ref], repo);
    git(['checkout', '--quiet', 'FETCH_HEAD'], repo);
}

function listFiles(repo) {
    return git(['ls-tree', '-r', '--name-only', 'HEAD'], repo)
        .split('\n')
        .filter(Boolean)
        .filter((f) => f.startsWith('static/') || f.startsWith('lib/'))
        .filter((f) => FIRST_PARTY.test(f))
        .filter((f) => !f.endsWith('.min.js'));
}

// Probes use exact paths or a recursive directory prefix plus extension.
// Compare those strings directly rather than compiling dynamic regexes.
function matchesPath(glob, file) {
    const marker = glob.indexOf('/**/');
    if (marker === -1) return glob === file;
    const prefix = glob.slice(0, marker + 1);
    const suffix = glob.slice(marker + 4);
    if (!suffix.startsWith('*.')) throw new Error('unsupported probe glob: ' + glob);
    return file.startsWith(prefix) && file.endsWith(suffix.slice(1));
}

function resolvePaths(api, files) {
    return files.filter((file) => api.paths.some((glob) => matchesPath(glob, file)));
}

function probeAll(repo, files) {
    const results = [];
    for (const api of SURFACE) {
        const targets = resolvePaths(api, files);
        let hit = null;
        for (const file of targets) {
            let src;
            try { src = fs.readFileSync(path.join(repo, file), 'utf8'); } catch (_) { continue; }
            if (api.pattern.test(src)) { hit = file; break; }
        }
        results.push({ ...api, hit, searched: targets.length });
    }
    return results;
}

function requestedRefs(args) {
    const index = args.indexOf('--ref');
    if (index === -1) {
        return [...AUDITED_REFS, { ref: 'main', version: null, role: 'current upstream main' }];
    }
    const ref = args[index + 1];
    if (!ref || ref.startsWith('-')) throw new Error('--ref requires a ref value');
    return [{ ref, version: null, role: 'requested via --ref' }];
}

function checkVersion(repo, audit) {
    let live;
    try {
        live = git(['show', 'HEAD:VERSION'], repo).trim();
    } catch (error) {
        console.error('could not read VERSION at ' + audit.ref + ':\n' + String(error.stderr || error.message).trim());
        return false;
    }
    if (audit.version && live !== audit.version) {
        console.error('VERSION at ' + audit.ref + ' is ' + live + ', expected ' + audit.version);
        return false;
    }
    console.log('VERSION ' + live + ' (' + audit.role + ')');
    return true;
}

function reportProbe(result) {
    let status = 'MISS';
    if (result.optional) status = 'warn';
    if (result.hit) status = 'ok  ';
    let detail = '';
    if (result.hit) detail = '  (' + result.hit + ')';
    else if (!result.searched) detail = '  (no file matched the probe path — has core moved it?)';
    console.log('  ' + status + '  ' + result.name + detail);
}

function reportMissing(ref, results) {
    const missing = results.filter((result) => !result.hit);
    const required = missing.filter((result) => !result.optional);
    const optional = missing.filter((result) => result.optional);
    if (required.length) {
        console.error('\n' + ref + ': ' + required.length + ' required host API(s) not found: '
            + required.map((result) => result.name).join(', '));
        console.error('Either core drifted from the surface README.md declares, or the probe path needs updating.');
    }
    if (optional.length) {
        console.warn(ref + ': optional surface absent: ' + optional.map((result) => result.name).join(', '));
    }
    return required.length === 0;
}

function auditRef(repo, audit) {
    console.log('\n== ' + audit.ref + ' (' + audit.role + ')');
    try {
        checkout(repo, audit.ref);
    } catch (error) {
        console.error('could not check out ' + audit.ref + ':\n' + String(error.stderr || error.message).trim());
        return false;
    }
    const versionMatches = checkVersion(repo, audit);
    const results = probeAll(repo, listFiles(repo));
    results.forEach(reportProbe);
    const surfaceMatches = reportMissing(audit.ref, results);
    return versionMatches && surfaceMatches;
}

function main() {
    if (process.argv.includes('--list')) {
        for (const api of SURFACE) {
            console.log((api.optional ? '[optional] ' : '') + api.name + '  —  ' + api.paths.join(', '));
        }
        return;
    }
    const tableMatches = checkTableParity();
    const refs = requestedRefs(process.argv);
    withCore((repo) => {
        // Map first so all refs are audited even after one fails.
        const results = refs.map((audit) => auditRef(repo, audit));
        if (!tableMatches || results.includes(false)) process.exitCode = 1;
        else console.log('\nhost surface intact at every checked ref');
    });
}

if (require.main === module) main();
module.exports = { AUDITED_REFS, SURFACE, listFiles, resolvePaths, probeAll, requestedRefs, main };
