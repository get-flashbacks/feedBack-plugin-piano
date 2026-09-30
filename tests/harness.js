'use strict';
// Shared browser/DOM harness for the plugin's node:test suites.
//
// The stub is deliberately minimal — enough of `window`, `document` and the
// canvas 2D context for screen.js to mount, draw and tear down. Suites that
// care about a specific *host* contract (core version, MIDI domain, splitscreen
// helper) layer the extra globals on top via `installBrowserHarness({ ... })`.
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
        _classElements: [],
        _context: null,
        get innerHTML() { return this._innerHTML; },
        set innerHTML(value) {
            this._innerHTML = String(value);
            this._classLookup.clear();
            this._classElements.length = 0;
            const tags = this._innerHTML.matchAll(/<([a-z][\w-]*)\b([^>]*\bclass="([^"]+)"[^>]*)>/gi);
            for (const [, tag, attrs, className] of tags) {
                const child = createElement(tag, ownerDocument);
                child.className = className;
                child.value = (attrs.match(/\bvalue="([^"]*)"/) || [])[1] || '';
                child.checked = /\bchecked(?:\s|>|$)/.test(attrs);

                for (const [, key, attrValue] of attrs.matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
                    child.dataset[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attrValue;
                }
                const inlineStyle = (attrs.match(/\bstyle="([^"]*)"/) || [])[1];
                if (inlineStyle) {
                    child.style.cssText = inlineStyle;
                    for (const declaration of inlineStyle.split(';')) {
                        const colon = declaration.indexOf(':');
                        if (colon === -1) continue;
                        const property = declaration.slice(0, colon).trim()
                            .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                        if (property) child.style[property] = declaration.slice(colon + 1).trim();
                    }
                }

                this._classElements.push(child);
                for (const cls of className.split(/\s+/).filter(Boolean)) {
                    if (!this._classLookup.has(cls)) this._classLookup.set(cls, child);
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
            if (selector && selector.startsWith('.')) {
                const cls = selector.slice(1);
                return this._classElements.filter(child => child.className.split(/\s+/).includes(cls));
            }
            return [];
        },
        querySelector(selector) {
            if (selector && selector.startsWith('.')) return this._classLookup.get(selector.slice(1)) || null;
            return null;
        },
        getContext(type) {
            if (tagName !== 'canvas' || type !== '2d') return null;
            if (this._context) return this._context;
            this._context = {
                canvas: this,
                fillTextCalls: [],
                setTransform() {},
                fillRect() {},
                fillText(text, x, y) { this.fillTextCalls.push({ text, x, y }); },
                measureText(text) { return { width: String(text).length * 6 }; },
                createLinearGradient() { return { addColorStop() {} }; },
                beginPath() {},
                arc() {},
                moveTo() {},
                lineTo() {},
                quadraticCurveTo() {},
                closePath() {},
                fill() {},
                stroke() {},
            };
            return this._context;
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
                for (const child of el._classElements || []) visit(child);
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
    // Host-provided globals a suite may want to exercise directly. `slopsmith`
    // is the legacy alias core assigns to `window.feedBack`; the MIDI domain
    // and the splitscreen helper are read through it / off window directly.
    if ('slopsmith' in options) global.window.slopsmith = options.slopsmith;
    if ('slopsmithSplitscreen' in options) {
        global.window.slopsmithSplitscreen = options.slopsmithSplitscreen;
    }
    global.document = doc;
    const storage = new Map(Object.entries(options.storage || {}));
    global.localStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
    };
    global.requestAnimationFrame = global.window.requestAnimationFrame;
    global.cancelAnimationFrame = global.window.cancelAnimationFrame;
    // Pinned at 0 by default (existing timing-sensitive tests, e.g.
    // wrong-note-flash expiry, rely on a motionless clock); a test that
    // needs real elapsed time can advance it via the returned `clock`
    // object (see advanceClock below) without affecting any other test.
    const clock = { now: 0 };
    global.performance = { now: () => clock.now };
    return { doc, windowListeners, rafs, storage, clock };
}

function advanceClock(harness, ms) {
    harness.clock.now += ms;
}

// Re-require screen.js from a clean module cache. Every suite that mounts a
// renderer needs this: screen.js is an IIFE whose module-level singletons
// (MIDI session, synth, live-instance registry) are shared across renderers,
// so a cached copy would leak the previous test's host globals into the next.
// The specifier is a literal so static analysis can see the dependency.
function loadScreen() {
    delete require.cache[require.resolve('../screen.js')];
    return require('../screen.js');
}

function freshPlugin(options = {}) {
    installBrowserHarness(options);
    return loadScreen();
}

function initRendererWithHarness(options = {}) {
    const harness = installBrowserHarness(options);
    const plugin = loadScreen();
    const renderer = plugin._createFactory();
    const canvas = harness.doc.createElement('canvas');
    canvas.clientWidth = 640;
    canvas.clientHeight = 360;
    harness.doc.elementsById.player.appendChild(canvas);
    renderer.init(canvas);
    return { harness, renderer, canvas, plugin };
}

module.exports = {
    createStyle,
    createElement,
    createDocument,
    installBrowserHarness,
    advanceClock,
    loadScreen,
    freshPlugin,
    initRendererWithHarness,
};
