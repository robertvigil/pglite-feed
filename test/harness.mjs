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

// --- fake GitHub Contents API ---
//
// Backs a repo with an in-memory { path: content } map and implements only the
// endpoints cloud.js calls. Records every request so a test can assert on what the
// app actually sent (method, path, commit message, whether a SHA was included).
export function installGitHub({ files = {}, token = 'ghp_test' } = {}) {
  const repo = new Map(Object.entries(files));
  const calls = [];
  const shaOf = (text) => 'sha' + [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const auth = (opts.headers || {})['Authorization'];
    calls.push({ method: opts.method || 'GET', url: u.pathname + u.search, auth,
                 body: opts.body ? JSON.parse(opts.body) : null });
    if (auth !== `Bearer ${token}`) return json({ message: 'Bad credentials' }, 401);

    let m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.*)$/);
    if (m) {
      const path = decodeURIComponent(m[2]);
      const method = opts.method || 'GET';
      if (method === 'GET') {
        // directory listing when nothing is stored at that exact path
        if (!repo.has(path)) {
          const kids = [...repo.keys()].filter((k) => k.startsWith(path + '/'));
          if (!kids.length) return json({ message: 'Not Found' }, 404);
          return json(kids.map((k) => ({
            type: 'file', name: k.split('/').pop(), path: k,
            size: repo.get(k).length, sha: shaOf(repo.get(k)),
          })));
        }
        const text = repo.get(path);
        return json({ type: 'file', path, sha: shaOf(text), content: b64(text) });
      }
      if (method === 'PUT') {
        const body = JSON.parse(opts.body);
        const cur = repo.get(path);
        if (cur && body.sha !== shaOf(cur)) return json({ message: 'sha does not match' }, 409);
        if (!cur && body.sha) return json({ message: 'sha given for a new file' }, 422);
        const text = unb64(body.content);
        repo.set(path, text);
        return json({ content: { path, sha: shaOf(text) } });
      }
      if (method === 'DELETE') {
        const body = JSON.parse(opts.body);
        if (!repo.has(path)) return json({ message: 'Not Found' }, 404);
        if (body.sha !== shaOf(repo.get(path))) return json({ message: 'sha does not match' }, 409);
        repo.delete(path);
        return json({ commit: {} });
      }
    }
    m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/commits$/);
    if (m) return json([{ commit: { committer: { date: '2026-08-23T12:00:00Z' } } }]);

    return json({ message: 'no fake route for ' + u.pathname }, 404);
  };
  return { repo, calls };
}
