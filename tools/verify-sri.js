'use strict';
// Re-hash the SRI pins in screen.js against what upstream actually serves.
//
//   node tools/verify-sri.js           verify: diff every pin, exit 1 on drift
//   node tools/verify-sri.js --write   regenerate the pins in screen.js
//
// The pins cover WebAudioFontPlayer.js plus 128 per-GM soundfont files on a
// third-party host (see the constants in screen.js). Nothing in `node --test`
// can tell a correct digest from a well-formed wrong one, so the correctness
// check has to fetch the bytes. The shape check lives in tests/screen.test.js;
// this script is the one that needs the network, hence the scheduled CI job
// rather than a per-PR gate.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const GM_MAX = 127;

function parsePins(src) {
    const base = /const WAF_BASE = '([^']+)'/.exec(src);
    const playerUrl = /const WAF_PLAYER_URL = '([^']+)'/.exec(src);
    const playerPin = /const WAF_PLAYER_INTEGRITY = '([^']+)'/.exec(src);
    const table = /const WAF_SOUNDFONT_INTEGRITY = \{([^}]*)\}/.exec(src);
    if (!base || !playerUrl || !playerPin || !table) {
        throw new Error('could not find the WAF SRI constants in screen.js — has the table moved or been renamed?');
    }
    const soundfonts = {};
    for (const [, gm, digest] of table[1].matchAll(/(\d+):\s*'([^']+)'/g)) soundfonts[gm] = digest;

    const missing = [];
    for (let gm = 0; gm <= GM_MAX; gm++) if (!soundfonts[gm]) missing.push(gm);
    if (missing.length) throw new Error('WAF_SOUNDFONT_INTEGRITY is missing GM ' + missing.join(', '));

    return {
        base: base[1],
        player: { url: playerUrl[1], digest: playerPin[1] },
        soundfonts,
        // Every URL the pins claim to cover, in the order --write emits them.
        urls: [playerUrl[1]],
        file: (gm) => String(gm * 10).padStart(4, '0') + '_JCLive_sf2_file',
    };
}

async function sha384(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return 'sha384-' + createHash('sha384').update(Buffer.from(await res.arrayBuffer())).digest('base64');
}

async function hashAll(urls) {
    // Bounded concurrency: 129 requests, but a plain Promise.all would look like
    // an attack to the host and make transient failures likelier.
    const out = new Array(urls.length);
    const CONCURRENCY = 8;
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < urls.length) {
            const i = next++;
            out[i] = await sha384(urls[i]);
        }
    }));
    return out;
}

function renderTable(digests) {
    // 4 spaces of indent plus the right-aligned 3-wide GM number, matching the
    // table as hand-written.
    return digests
        .map((digest, gm) => '    ' + String(gm).padStart(3) + ": '" + digest + "',")
        .join('\n');
}

function rewrite(src, playerDigest, soundfontDigests) {
    return src
        .replace(/(const WAF_PLAYER_INTEGRITY = ')[^']+(')/, '$1' + playerDigest + '$2')
        .replace(/(const WAF_SOUNDFONT_INTEGRITY = \{)[\s\S]*?(\n};)/,
            (_, head, tail) => head + '\n' + renderTable(soundfontDigests) + tail);
}

async function main() {
    const write = process.argv.includes('--write');
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    const pins = parsePins(src);
    const urls = [pins.player.url];
    for (let gm = 0; gm <= GM_MAX; gm++) urls.push(pins.base + pins.file(gm) + '.js');

    console.log('hashing ' + urls.length + ' upstream files…');
    const live = await hashAll(urls);
    const [playerDigest, ...soundfontDigests] = live;

    if (!write) {
        const drift = [];
        if (playerDigest !== pins.player.digest) {
            drift.push('WebAudioFontPlayer.js\n  pinned: ' + pins.player.digest + '\n  live:   ' + playerDigest);
        }
        soundfontDigests.forEach((digest, gm) => {
            if (digest !== pins.soundfonts[gm]) {
                drift.push('GM ' + gm + ' (' + pins.file(gm) + '.js)\n  pinned: ' + pins.soundfonts[gm] + '\n  live:   ' + digest);
            }
        });
        if (drift.length) {
            console.error('\n' + drift.length + ' pin(s) do not match upstream:\n\n' + drift.join('\n\n'));
            console.error('\nIf the bump is intentional, run: node tools/verify-sri.js --write');
            process.exitCode = 1;
            return;
        }
        console.log('all ' + urls.length + ' pins match upstream');
        return;
    }

    const updated = rewrite(src, playerDigest, soundfontDigests);
    if (updated === src) {
        console.log('pins already up to date — screen.js unchanged');
        return;
    }
    fs.writeFileSync(SCREEN_JS, updated);
    console.log('rewrote WAF_PLAYER_INTEGRITY and ' + soundfontDigests.length + ' soundfont pins in screen.js');
}

main().catch((e) => {
    console.error('[verify-sri] ' + e.message);
    process.exitCode = 1;
});
