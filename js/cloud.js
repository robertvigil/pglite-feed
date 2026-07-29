// cloud.js — encrypted remote snapshots ("cloud") for the pglite apps.
//
// This file is BYTE-IDENTICAL across pglite-activities and pglite-feed (like the
// leafwiki custom.css). All the app-specific bits are injected via setupCloud():
// the app hands in its own buildExportData / importJsonData and an appKind, so the
// crypto + transport here stay app-agnostic.
//
// Model: the remote holds a namespace of NAMED snapshots (default "main"). Each
// snapshot is a jsonbin "bin" inside one Collection. What we store per bin is an
// ENVELOPE — cleartext metadata {v,app,name,savedAt,device} wrapping an AES-GCM
// ciphertext of the app's normal JSON export. The cleartext `app` field lets us
// reject a feed backup loaded into activities BEFORE asking for a passphrase.
//
// Crypto: WebCrypto PBKDF2(250k, SHA-256) -> AES-GCM-256. No dependencies; runs
// only in a secure context (https / localhost), same requirement as the FSA code.
//
// Secrets (encryption passphrase + jsonbin master key) are persisted per-device in
// IndexedDB — set once, not re-prompted every session (the user's call: reaching
// IndexedDB already requires the unlocked device + origin). `!cloud off` forgets
// them.
//
// Commands (wired from each app's handleCommand):
//   !cloud                      status
//   !cloud jsonbin <collId>     configure backend (prompts, masked, for master key)
//   !cloud list                 list this app's remote snapshots (no passphrase needed)
//   !cloud delete <name>        permanently delete a remote snapshot
//   !cloud device <label>       set this device's label ("laptop", "phone")
//   !cloud off                  disconnect + forget secrets on this device
//   !cloud push [name]          encrypt + upload snapshot (default "main")
//   !cloud pull [name]          download + decrypt + load snapshot (default "main")

const API = 'https://api.jsonbin.io/v3';
const enc = new TextEncoder();
const dec = new TextDecoder();

// --- base64 that survives large buffers (spread would overflow the call stack) ---
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// --- stable JSON (sorted object keys) so the dirty-hash doesn't flip on key order ---
function stable(o) {
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}
async function sha256Hex(str) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- crypto envelope ---
async function deriveKey(passphrase, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
// --- gzip the PLAINTEXT before encrypting (ciphertext is incompressible, so the
//     order matters). Markdown/JSON compresses ~3-5x, which is what keeps the
//     base64 envelope under jsonbin's per-bin size limit. jsonbin never sees any
//     of this — gzip lives inside the encrypted `ct` string. ---
const canGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
async function gzip(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encryptEnvelope(obj, passphrase, meta) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iter = 250000;
  const key = await deriveKey(passphrase, salt, iter);
  let bytes = enc.encode(JSON.stringify(obj));
  let zip = 'none';
  if (canGzip) { bytes = await gzip(bytes); zip = 'gzip'; }
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return {
    v: 1, app: meta.app, name: meta.name, cipher: 'AES-GCM', zip,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter, salt: toB64(salt) },
    iv: toB64(iv), ct: toB64(ct),
    savedAt: meta.savedAt, device: meta.device,
  };
}
async function decryptEnvelope(env, passphrase) {
  const key = await deriveKey(passphrase, fromB64(env.kdf.salt), env.kdf.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct));
  let bytes = new Uint8Array(pt);
  if (env.zip === 'gzip') bytes = await gunzip(bytes); // undefined/'none' = uncompressed (back-compat)
  return JSON.parse(dec.decode(bytes));
}

// --- tiny IndexedDB key/value store for the two device-persisted secrets ---
function idbOpen(dbName) {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(dbName, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbGet(dbName, key) {
  const db = await idbOpen(dbName);
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result ?? null);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbSet(dbName, key, val) {
  const db = await idbOpen(dbName);
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(val, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(dbName, key) {
  const db = await idbOpen(dbName);
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- masked (password) modal prompt; resolves to string on OK, null on cancel ---
function maskedPrompt(title, message, { value = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;' +
      'justify-content:center;z-index:9999;font-family:inherit;';
    const box = document.createElement('div');
    box.style.cssText =
      'background:#1b1f2a;color:#eaedf4;border:1px solid rgba(255,255,255,.18);border-radius:10px;' +
      'padding:18px 18px 14px;max-width:min(420px,92vw);width:420px;box-shadow:0 10px 40px rgba(0,0,0,.5);';
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:bold;margin-bottom:6px;font-size:15px;';
    const p = document.createElement('div');
    p.textContent = message;
    p.style.cssText = 'font-size:12px;opacity:.75;margin-bottom:12px;line-height:1.4;';
    const input = document.createElement('input');
    input.type = 'password';
    input.value = value;
    input.autocomplete = 'off';
    input.style.cssText =
      'width:100%;padding:8px 10px;font-size:14px;font-family:inherit;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,.2);background:#232838;color:#eaedf4;box-sizing:border-box;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'padding:6px 14px;font-size:13px;font-family:inherit;border-radius:8px;cursor:pointer;' +
        (primary
          ? 'background:#38e1ff;color:#0b0e14;border:1px solid #38e1ff;font-weight:bold;'
          : 'background:transparent;color:#c7cdda;border:1px solid rgba(255,255,255,.22);');
      return b;
    };
    const cancel = mkBtn('Cancel', false);
    const ok = mkBtn('OK', true);
    row.append(cancel, ok);
    box.append(h, p, input, row);
    overlay.append(box);
    document.body.append(overlay);
    input.focus();
    input.select();

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const submit = () => close(input.value);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}

// --- jsonbin.io v3 transport ---
async function jbErr(r) {
  try { const j = await r.json(); return `jsonbin ${r.status}: ${j.message || JSON.stringify(j)}`; }
  catch { return `jsonbin ${r.status}`; }
}
function jbHeaders(masterKey, extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Master-Key': masterKey, ...extra };
}
async function jbCreate(masterKey, collectionId, name, body) {
  const r = await fetch(`${API}/b`, {
    method: 'POST',
    headers: jbHeaders(masterKey, { 'X-Collection-Id': collectionId, 'X-Bin-Name': name, 'X-Bin-Private': 'true' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await jbErr(r));
  return (await r.json()).metadata.id;
}
async function jbUpdate(masterKey, binId, body) {
  const r = await fetch(`${API}/b/${binId}`, {
    method: 'PUT',
    headers: jbHeaders(masterKey, { 'X-Bin-Versioning': 'false' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await jbErr(r));
}
async function jbRead(masterKey, binId) {
  const r = await fetch(`${API}/b/${binId}/latest`, { headers: jbHeaders(masterKey) });
  if (!r.ok) throw new Error(await jbErr(r));
  return (await r.json()).record;
}
async function jbDelete(masterKey, binId) {
  const r = await fetch(`${API}/b/${binId}`, { method: 'DELETE', headers: jbHeaders(masterKey) });
  if (!r.ok) throw new Error(await jbErr(r));
}
async function jbListBins(masterKey, collectionId) {
  const r = await fetch(`${API}/c/${collectionId}/bins`, { headers: jbHeaders(masterKey) });
  if (!r.ok) throw new Error(await jbErr(r));
  return r.json(); // [{ record: <binId>, createdAt, snippetMeta, private }]
}

export function setupCloud({ appKind, buildExportData, importJsonData, refresh, syncToFile }) {
  const NS = `${appKind}.cloud`;
  const K = { config: `${NS}.config`, bins: `${NS}.bins`, state: `${NS}.state`, device: `${NS}.device` };
  const SDB = `pglite-${appKind}-cloud`; // IndexedDB name for the secrets kv store
  const DEFAULT = 'main';

  // --- non-secret persistence (localStorage) ---
  const loadConfig = () => { try { const c = JSON.parse(localStorage.getItem(K.config) || 'null'); return (c && c.collectionId) ? c : null; } catch { return null; } };
  const saveConfig = (c) => localStorage.setItem(K.config, JSON.stringify(c));
  const loadBins = () => { try { return JSON.parse(localStorage.getItem(K.bins) || '{}'); } catch { return {}; } };
  const saveBins = (m) => localStorage.setItem(K.bins, JSON.stringify(m));
  const loadState = () => { try { return JSON.parse(localStorage.getItem(K.state) || 'null'); } catch { return null; } };
  const saveState = (s) => localStorage.setItem(K.state, JSON.stringify(s));

  // --- device label (persisted, editable via !cloud device) ---
  let device = localStorage.getItem(K.device);
  if (!device) {
    device = 'dev-' + [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(K.device, device);
  }

  const fmt = (iso) => {
    if (!iso) return 'unknown';
    try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  const secureOk = () => {
    if (window.isSecureContext && window.crypto && crypto.subtle) return true;
    alert('Cloud needs a secure context (https or localhost) for encryption. This page is not secure.');
    return false;
  };

  // --- secrets (IndexedDB, per device) ---
  async function ensureMasterKey() {
    let k = await idbGet(SDB, 'masterKey');
    if (k) return k;
    k = await maskedPrompt('jsonbin.io Master Key', 'Paste your X-Master-Key. Stored on this device only.');
    if (!k) return null;
    await idbSet(SDB, 'masterKey', k);
    return k;
  }
  async function ensurePassphrase() {
    let p = await idbGet(SDB, 'passphrase');
    if (p) return p;
    p = await maskedPrompt('Encryption passphrase', 'Encrypts/decrypts your cloud snapshots. Stored on this device only — jsonbin never sees it. Use the SAME passphrase on every device.');
    if (!p) return null;
    await idbSet(SDB, 'passphrase', p);
    return p;
  }

  // --- dirty indicator, mounted under the search bar ---
  let ind = null;
  (function mountIndicator() {
    const bar = document.querySelector('.search-bar');
    if (!bar) return;
    ind = document.createElement('div');
    ind.id = 'cloud-indicator';
    ind.style.cssText = 'display:none;font-size:12px;margin:-4px 0 8px;opacity:.8;cursor:pointer;user-select:none;';
    bar.insertAdjacentElement('afterend', ind);
    ind.addEventListener('click', () => {
      // Push to the snapshot you're currently synced with (not always "main"),
      // so the one-click follows your named-snapshot workflow.
      if (ind.dataset.state === 'dirty') doPush(loadState()?.name || DEFAULT);
      else doStatus();
    });
  })();
  function setInd(state, title, name) {
    if (!ind) return;
    ind.dataset.state = state || '';
    if (state === 'busy') { ind.style.display = ''; ind.textContent = '☁ …'; ind.style.color = '#888'; ind.title = 'Working…'; }
    else if (state === 'synced') { ind.style.display = ''; ind.textContent = '☁ synced'; ind.style.color = '#888'; ind.title = title || 'In sync with the cloud.'; }
    else if (state === 'dirty') {
      ind.style.display = '';
      // Name the target snapshot when it isn't the default, so a click is never a surprise.
      ind.textContent = (name && name !== DEFAULT) ? `☁ unsaved — click to push "${name}"` : '☁ unsaved — click to push';
      ind.style.color = '#ffb000';
      ind.title = `Local changes not pushed. Click to push to "${name || DEFAULT}".`;
    }
    else { ind.style.display = 'none'; }
  }

  let busy = false; // true only while an op holds the spinner; the op clears it before settling
  let dirtyTimer = null;
  function updateDirty() { clearTimeout(dirtyTimer); dirtyTimer = setTimeout(_updateDirty, 300); }
  async function _updateDirty() {
    if (busy) return; // a refresh()-driven tick fired mid-op — don't clobber the spinner
    if (!loadConfig()) { setInd(); return; }
    let data;
    try { data = await buildExportData(); } catch { return; }
    const hash = await sha256Hex(stable(data));
    const st = loadState();
    if (st && st.hash === hash) setInd('synced', `In sync with "${st.name}" (${fmt(st.savedAt)}).`);
    else setInd('dirty', null, st?.name || DEFAULT);
  }

  // --- resolve a snapshot name -> { binId, env } for THIS app, warming the cache ---
  async function resolveBin(masterKey, collectionId, name) {
    const cache = loadBins();
    if (cache[name]) {
      try {
        const env = await jbRead(masterKey, cache[name]);
        if (env && env.app === appKind && env.name === name) return { binId: cache[name], env };
      } catch { /* stale cache entry — fall through to a full scan */ }
    }
    const bins = await jbListBins(masterKey, collectionId);
    const map = loadBins();
    let found = null;
    for (const b of bins) {
      const binId = b.record;
      let env;
      try { env = await jbRead(masterKey, binId); } catch { continue; }
      if (env && env.app === appKind && env.name) {
        map[env.name] = binId;
        if (env.name === name) found = { binId, env };
      }
    }
    saveBins(map);
    return found;
  }

  async function listSnapshots(masterKey, collectionId) {
    const bins = await jbListBins(masterKey, collectionId);
    const map = loadBins();
    const out = [];
    for (const b of bins) {
      const binId = b.record;
      let env;
      try { env = await jbRead(masterKey, binId); } catch { continue; }
      if (env && env.app === appKind && env.name) {
        map[env.name] = binId;
        out.push({ name: env.name, savedAt: env.savedAt, device: env.device, binId });
      }
    }
    saveBins(map);
    out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    return out;
  }

  // --- commands ---
  async function doConfigure(collectionId) {
    if (!collectionId) {
      alert('Usage: !cloud jsonbin <collectionId>\n\nIn your jsonbin.io dashboard create a Collection and paste its ID here.');
      return;
    }
    saveConfig({ backend: 'jsonbin', collectionId });
    const k = await ensureMasterKey();
    if (!k) alert(`Saved collection ${collectionId}. Master key not entered yet — you'll be prompted on your first !cloud push.`);
    else alert(`Cloud configured — jsonbin collection ${collectionId}.\n\nNext:  !cloud push   uploads the "${DEFAULT}" snapshot.`);
    updateDirty();
  }

  async function doStatus() {
    const cfg = loadConfig();
    if (!cfg) {
      alert('Cloud: not configured.\n\nSet up:\n  !cloud jsonbin <collectionId>\nThen:\n  !cloud push  /  !cloud pull  /  !cloud list');
      return;
    }
    const hasKey = !!(await idbGet(SDB, 'masterKey'));
    const hasPass = !!(await idbGet(SDB, 'passphrase'));
    const st = loadState();
    let dirty = '—';
    try { const h = await sha256Hex(stable(await buildExportData())); dirty = (st && st.hash === h) ? 'in sync' : 'unsaved changes'; } catch { /* ignore */ }
    alert(
      `Cloud status — ${appKind}\n\n` +
      `Backend:      jsonbin.io\n` +
      `Collection:   ${cfg.collectionId}\n` +
      `Device:       ${device}\n` +
      `Master key:   ${hasKey ? 'stored' : 'not stored'}\n` +
      `Passphrase:   ${hasPass ? 'stored' : 'not stored'}\n` +
      `Last sync:    ${st ? `"${st.name}" ${fmt(st.savedAt)}` : 'never'}\n` +
      `State:        ${dirty}\n\n` +
      `!cloud push · !cloud pull · !cloud list · !cloud delete <name> · !cloud device <label> · !cloud off`
    );
  }

  async function doList() {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud jsonbin <collectionId>'); return; }
    if (!secureOk()) return;
    const masterKey = await ensureMasterKey();
    if (!masterKey) return;
    busy = true; setInd('busy');
    try {
      const arr = await listSnapshots(masterKey, cfg.collectionId);
      if (!arr.length) alert(`No ${appKind} snapshots in this collection yet.\n\nCreate one with:  !cloud push`);
      else alert(
        `${appKind} snapshots (${arr.length}):\n\n` +
        arr.map((s) => `• ${s.name} — ${fmt(s.savedAt)} (${s.device})`).join('\n') +
        `\n\nPull:  !cloud pull <name>    ·    Delete:  !cloud delete <name>`
      );
    } catch (e) { alert('List failed: ' + e.message); }
    finally { busy = false; updateDirty(); }
  }

  async function doPush(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud jsonbin <collectionId>'); return; }
    if (!secureOk()) return;
    const masterKey = await ensureMasterKey();
    if (!masterKey) return;
    const passphrase = await ensurePassphrase();
    if (!passphrase) return;
    busy = true; setInd('busy');
    try {
      const data = await buildExportData();
      const count = Array.isArray(data) ? data.length : (data.entries ? data.entries.length : 0);
      const existing = await resolveBin(masterKey, cfg.collectionId, name);
      if (existing && existing.env) {
        const st = loadState();
        const remoteNewer = existing.env.savedAt && existing.env.device !== device &&
          (!st || !st.savedAt || existing.env.savedAt > st.savedAt);
        if (remoteNewer && !confirm(
          `Remote snapshot "${name}" was updated ${fmt(existing.env.savedAt)} from ${existing.env.device}.\n\n` +
          `Overwrite it with this device's data?`)) { updateDirty(); return; }
      }
      const savedAt = new Date().toISOString();
      const env = await encryptEnvelope(data, passphrase, { app: appKind, name, savedAt, device });
      let binId;
      if (existing) { await jbUpdate(masterKey, existing.binId, env); binId = existing.binId; }
      else { binId = await jbCreate(masterKey, cfg.collectionId, name, env); }
      const map = loadBins(); map[name] = binId; saveBins(map);
      saveState({ name, hash: await sha256Hex(stable(data)), savedAt });
      alert(`Pushed "${name}" — ${count} entries.`);
    } catch (e) {
      alert('Push failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doPull(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud jsonbin <collectionId>'); return; }
    if (!secureOk()) return;
    const masterKey = await ensureMasterKey();
    if (!masterKey) return;
    busy = true; setInd('busy');
    try {
      const found = await resolveBin(masterKey, cfg.collectionId, name);
      if (!found) { alert(`No snapshot named "${name}" for ${appKind}.\n\nSee what's there:  !cloud list`); updateDirty(); return; }
      if (found.env.app !== appKind) { alert(`"${name}" is a ${found.env.app} backup — it can't be loaded into ${appKind}.`); updateDirty(); return; }
      if (!confirm(
        `Replace ALL local ${appKind} data with snapshot "${name}"\n(saved ${fmt(found.env.savedAt)} from ${found.env.device})?\n\nThis cannot be undone.`)) { updateDirty(); return; }
      const passphrase = await ensurePassphrase();
      if (!passphrase) { updateDirty(); return; }
      let data;
      try { data = await decryptEnvelope(found.env, passphrase); }
      catch { await idbDel(SDB, 'passphrase'); alert('Decryption failed — wrong passphrase? It has been forgotten; try again.'); updateDirty(); return; }
      const ok = await importJsonData(data, `cloud:${name}`);
      if (ok) {
        await refresh();
        if (syncToFile) await syncToFile();
        saveState({ name, hash: await sha256Hex(stable(data)), savedAt: found.env.savedAt });
      }
    } catch (e) {
      alert('Pull failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doDelete(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud jsonbin <collectionId>'); return; }
    if (!name) { alert(`Usage: !cloud delete <name>\n\nList snapshots:  !cloud list`); return; }
    if (!secureOk()) return;
    const masterKey = await ensureMasterKey();
    if (!masterKey) return;
    busy = true; setInd('busy');
    try {
      const found = await resolveBin(masterKey, cfg.collectionId, name);
      if (!found) { alert(`No snapshot named "${name}" for ${appKind}.\n\nSee what's there:  !cloud list`); updateDirty(); return; }
      if (!confirm(`Permanently DELETE remote snapshot "${name}" (saved ${fmt(found.env.savedAt)} from ${found.env.device})?\n\nThis deletes only the cloud copy — your local data is untouched. Cannot be undone.`)) { updateDirty(); return; }
      await jbDelete(masterKey, found.binId);
      const map = loadBins(); delete map[name]; saveBins(map);
      // If we were tracking this snapshot, forget the sync state so the indicator recomputes.
      if (loadState()?.name === name) localStorage.removeItem(K.state);
      alert(`Deleted snapshot "${name}".`);
    } catch (e) {
      alert('Delete failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doOff() {
    if (!confirm('Disconnect cloud on this device and forget the stored master key + passphrase?\n\n(Your remote snapshots are not deleted.)')) return;
    localStorage.removeItem(K.config);
    localStorage.removeItem(K.bins);
    localStorage.removeItem(K.state);
    await idbDel(SDB, 'masterKey');
    await idbDel(SDB, 'passphrase');
    updateDirty();
    alert('Cloud disconnected on this device.');
  }

  function doDevice(label) {
    if (!label) { alert(`Current device label: ${device}\nUsage: !cloud device <label>`); return; }
    device = label;
    localStorage.setItem(K.device, label);
    alert(`Device label set to "${label}".`);
  }

  // A CORS/offline failure surfaces as a bare "Failed to fetch" TypeError — add a hint.
  function describeNetworkError(e) {
    if (e && e.name === 'TypeError' && /fetch/i.test(e.message || '')) {
      return '\n\n(Network/CORS error — check connectivity and that jsonbin.io is reachable from this origin.)';
    }
    return '';
  }

  async function command(cmd, args) {
    try {
      if (cmd === 'cloud') {
        const sub = (args[0] || '').toLowerCase();
        if (!sub) await doStatus();
        else if (sub === 'push') await doPush(args[1] || DEFAULT);
        else if (sub === 'pull') await doPull(args[1] || DEFAULT);
        else if (sub === 'jsonbin') await doConfigure(args[1]);
        else if (sub === 'list') await doList();
        else if (sub === 'delete') await doDelete(args[1]);
        else if (sub === 'off') await doOff();
        else if (sub === 'device') doDevice(args.slice(1).join(' '));
        else alert(`Unknown !cloud subcommand: "${sub}"\n\nTry:  !cloud · !cloud push · !cloud pull · !cloud list · !cloud delete <name> · !cloud jsonbin <id> · !cloud device <label> · !cloud off`);
        return true;
      }
    } catch (e) { alert('Cloud error: ' + e.message); return true; }
    return false;
  }

  updateDirty(); // reflect any existing config at startup
  return { command, updateDirty };
}
