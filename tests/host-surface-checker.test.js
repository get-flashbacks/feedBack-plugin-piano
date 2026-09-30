'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const checker = require('../tools/verify-host-surface');
const TOOL = path.join(__dirname, '..', 'tools', 'verify-host-surface.js');

test('missing required APIs make the CLI fail against a reachable local ref', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-host-test-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    try {
        git('init', '-b', 'main');
        fs.writeFileSync(path.join(dir, 'VERSION'), '0.3.0-alpha.2\n');
        git('add', 'VERSION');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'empty host');
        git('remote', 'add', 'origin', dir);
        const result = spawnSync(process.execPath, [TOOL, '--ref', 'main'], {
            env: { ...process.env, CORE_CHECKOUT: dir }, encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /required host API\(s\) not found/);
        assert.doesNotMatch(result.stderr, /could not check out/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a missing VERSION fails the ref without aborting the run', () => {
    // A dropped or renamed VERSION is a drift class of its own, and it used to
    // escape as a raw `git show` stack trace that left the refs after it
    // unprobed. The throwaway repo is reachable but has no VERSION at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-noversion-test-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    try {
        git('init', '-b', 'main');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'no VERSION', '--allow-empty');
        git('remote', 'add', 'origin', dir);
        const result = spawnSync(process.execPath, [TOOL], {
            env: { ...process.env, CORE_CHECKOUT: dir }, encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not read VERSION at main/);
        assert.doesNotMatch(result.stderr, /Command failed|at checkVersion/, 'no raw git stack trace');
        // The pinned refs are unreachable here, and main is still audited after
        // both of them fail.
        assert.match(result.stderr, /could not check out 803bd0c/);
        assert.match(result.stderr, /required host API\(s\) not found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('file discovery includes first-party Python and excludes vendor and minified files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-files-test-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    try {
        git('init');
        for (const file of ['lib/song.py', 'static/app.js', 'static/vendor/library.js', 'static/js/bundle.min.js']) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), '');
        }
        git('add', '.');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'files');
        assert.deepEqual(checker.listFiles(dir), ['lib/song.py', 'static/app.js']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('probing reports a hit for a present API and a miss for an absent one', () => {
    // The checker's whole job is this loop, so pin both outcomes: a green suite
    // has to mean "the checker still detects", not "the checker still runs".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-probe-test-'));
    try {
        const files = ['static/app.js', 'static/highway.js'];
        fs.mkdirSync(path.join(dir, 'static'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'static/app.js'),
            'window.feedBackViz_piano = createFactory;\nui.playerControlSlot().append(b);\n');
        fs.writeFileSync(path.join(dir, 'static/highway.js'),
            'function draw(b) { if (b.isReady) { b.notes = b.notes || []; } }\n');
        const result = (name) => checker.probeAll(dir, files).find((api) => api.name === name);
        assert.equal(result('feedBackViz_').hit, 'static/app.js');
        assert.equal(result('playerControlSlot').hit, 'static/app.js');
        assert.equal(result('isReady').hit, 'static/highway.js');
        assert.equal(result('notes').hit, 'static/highway.js');
        // Present path, absent pattern: the direction a rename would take.
        assert.deepEqual({ hit: result('setRenderer').hit, searched: result('setRenderer').searched },
            { hit: null, searched: 2 });
        // Absent path: a core that moved or dropped the file, reported
        // separately from a rename in the file that is still there.
        assert.deepEqual({ hit: result('logicalSourceKey').hit, searched: result('logicalSourceKey').searched },
            { hit: null, searched: 0 });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('default audit includes current main and explicit refs require a value', () => {
    assert.deepEqual(checker.requestedRefs([]).map((audit) => audit.ref),
        [...checker.AUDITED_REFS.map((audit) => audit.ref), 'main']);
    assert.deepEqual(checker.requestedRefs(['--ref', 'custom']).map((audit) => audit.ref), ['custom']);
    assert.throws(() => checker.requestedRefs(['--ref']), /requires a ref value/);
});

test('recursive probe paths cover root and nested files without matching other extensions', () => {
    const files = ['static/app.js', 'static/js/viz.js', 'static/js/viz.json', 'lib/song.py'];
    assert.deepEqual(checker.resolvePaths({ paths: ['static/**/*.js'] }, files), files.slice(0, 2));
    assert.deepEqual(checker.resolvePaths({ paths: ['lib/**/*.py'] }, files), ['lib/song.py']);
    assert.deepEqual(checker.resolvePaths({ paths: ['static/app.js'] }, files), ['static/app.js']);
});
