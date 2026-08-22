// Headless test harness for js/cloud.js.
//
// cloud.js is self-contained (no imports) and takes every app dependency by
// injection, so it runs outside a browser once these five globals exist:
// localStorage, indexedDB, document, window, and alert/confirm. The File System
// Access API is faked with an in-memory directory, which makes the whole !local
// transport — push, pull, list, delete, permission expiry — testable without a
// browser or a real folder.
//
// Run:  node --test test/
import { webcrypto } from 'node:crypto';

export function installBrowser({ confirmAnswers = [], hasFSA = true, secure = true } = {}) {
  const calls = { alerts: [], confirms: [] };

  // --- localStorage ---
  const ls = new Map();
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
    clear: () => ls.clear(),
  };

  // --- IndexedDB (only the kv shape cloud.js uses) ---
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  globalThis.indexedDB = {
    open(name) {
      const rq = {};
      later(() => {
        if (!dbs.has(name)) dbs.set(name, new Map());
        const store = dbs.get(name);
        rq.result = {
          createObjectStore: () => {},
          transaction: () => ({
            objectStore: () => ({
              get(k) { const r = {}; later(() => { r.result = store.get(k) ?? null; r.onsuccess?.(); }); return r; },
              put(v, k) { store.set(k, v); const r = {}; later(() => r.onsuccess?.()); return r; },
              delete(k) { store.delete(k); const r = {}; later(() => r.onsuccess?.()); return r; },
            }),
            set oncomplete(fn) { later(fn); },
            set onerror(_) {},
          }),
        };
        rq.onupgradeneeded?.();
        rq.onsuccess?.();
      });
      return rq;
    },
  };

  // --- DOM: only what the indicator and the passphrase prompt touch ---
  const mkEl = () => {
    const el = {
      style: {}, dataset: {}, title: '', textContent: '', id: '',
      children: [],
      set cssText(v) {}, // via style.cssText below
      appendChild(c) { this.children.push(c); return c; },
      append(...c) { this.children.push(...c); },
      insertAdjacentElement(_pos, e) { this.children.push(e); return e; },
      addEventListener(type, fn) { (this._h ||= {})[type] = fn; },
      removeEventListener() {},
      remove() {},
      focus() {}, click() {},
      querySelector: () => null,
      classList: { add() {}, remove() {} },
    };
    el.style.cssText = '';
    return el;
  };
  const indicatorHost = mkEl();
  globalThis.document = {
    createElement: mkEl,
    body: mkEl(),
    documentElement: mkEl(),
    getElementById: () => mkEl(),
    querySelector: (sel) => (sel === '.search-bar' ? indicatorHost : null),
    addEventListener() {}, removeEventListener() {},
  };

  // --- window / crypto / dialogs ---
  // Node 18+ already exposes webcrypto as a getter-only globalThis.crypto.
  globalThis.window = { isSecureContext: secure, crypto: webcrypto };
  if (hasFSA) globalThis.window.showDirectoryPicker = async () => fakeDir('snapshots');
  globalThis.alert = (m) => { calls.alerts.push(String(m)); };
  globalThis.confirm = (m) => {
    calls.confirms.push(String(m));
    return confirmAnswers.length ? confirmAnswers.shift() : true;
  };

  // the indicator element cloud.js mounts, once it exists
  const indicator = () => indicatorHost.children.find((c) => c.id === 'cloud-indicator') || null;
  return { calls, indicator, indicatorHost, localStorageMap: ls, idb: dbs };
}

// --- in-memory FileSystemDirectoryHandle ---
export function fakeDir(name, files = new Map()) {
  let perm = 'granted';
  const dir = {
    name, kind: 'directory', _files: files,
    _setPermission(p) { perm = p; },
    async queryPermission() { return perm; },
    async requestPermission() { perm = 'granted'; return perm; },
    async getFileHandle(fname, opts = {}) {
      if (!files.has(fname)) {
        if (!opts.create) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
        files.set(fname, { text: '', lastModified: Date.parse('2026-08-22T12:00:00Z') });
      }
      const rec = files.get(fname);
      return {
        kind: 'file', name: fname,
        async createWritable() {
          let buf = '';
          return { async write(chunk) { buf += chunk; }, async close() { rec.text = buf; } };
        },
        async getFile() {
          return { size: rec.text.length, lastModified: rec.lastModified, async text() { return rec.text; } };
        },
      };
    },
    async removeEntry(fname) {
      if (!files.has(fname)) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
      files.delete(fname);
    },
    async *entries() {
      for (const [fname] of files) yield [fname, { kind: 'file' }];
    },
  };
  return dir;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// _updateDirty is debounced 300ms; give it room to settle.
export const settle = () => sleep(400);
