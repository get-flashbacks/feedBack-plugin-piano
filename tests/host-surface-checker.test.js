'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const checker = require('../tools/verify-host-surface');

test('missing required APIs make the CLI fail against a reachable local ref', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-host-test-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    try {
        git('init', '-b', 'main');
        fs.writeFileSync(path.join(dir, 'VERSION'), '0.3.0-alpha.2\n');
        git('add', 'VERSION');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'empty host');
        git('remote', 'add', 'origin', dir);
        const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/verify-host-surface.js'), '--ref', 'main'], {
            env: { ...process.env, CORE_CHECKOUT: dir }, encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /required host API\(s\) not found/);
        assert.doesNotMatch(result.stderr, /could not check out/);
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
