// cloud.js — remote and local snapshots for the pglite apps.
//
// This file is BYTE-IDENTICAL across pglite-activities and pglite-feed. All the
// app-specific bits are injected via setupCloud(): the app hands in its own
// buildExportData / importJsonData and an appKind, so everything here is
// app-agnostic.
//
// Model: a namespace of NAMED snapshots (default "main"), reachable through two
// transports that are mutually exclusive — exactly one is connected at a time.
//
//   !cloud  → plain JSON files in a private GitHub repo, at <app>/<name>.json
//   !local  → plain JSON files in a folder on disk, at <name>.json
//
// Both write the same shape: {app, name, savedAt, device, config, entries}. The
// leading metadata is what `!cloud list` reports and what the overwrite guard
// compares; importJsonData ignores the extra keys, so a snapshot from either
// transport loads into either one, and files written before this format still work.
//
// NO ENCRYPTION, deliberately. Privacy comes from the repo being private (the
// GitHub API requires auth to read it) — not from ciphertext. Encrypting would also
// destroy the main reason to be on git at all: a diff between two revisions of an
// opaque blob tells you nothing, while a diff of plain JSON tells you exactly what
// changed. Snapshots written by the older AES-GCM format are detected and reported,
// not silently mangled.
//
// The token is a fine-grained PAT scoped to the one snapshots repo (Contents:
// read/write). It is persisted per-device in IndexedDB — set once, not re-prompted
// each session (reaching IndexedDB already requires the unlocked device + origin).
// `!cloud off` forgets it.
//
// Commands (wired from each app's handleCommand):
//   !cloud                      status
//   !cloud github <owner/repo>  configure backend (prompts, masked, for the token)
//   !cloud list                 list this app's remote snapshots
//   !cloud delete <name>        permanently delete a remote snapshot
//   !cloud device <label>       set this device's label ("laptop", "phone")
//   !cloud off                  disconnect + forget the token on this device
//   !cloud push [name]          upload snapshot (default "main")
//   !cloud pull [name]          download + load snapshot (default "main")

const enc = new TextEncoder();
const dec = new TextDecoder();

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

// --- GitHub Contents API transport ---
//
// Snapshots are plain JSON files in a private repo: <app>/<name>.json. That makes a
// directory the container (the same shape !local uses on disk), gives real version
// history with readable diffs, and lets the token be a fine-grained PAT scoped to
// this one repo. Content is base64 in the API payload only — at rest it is plain
// text, which is the whole point: `git diff` has to mean something.
//
// Updating or deleting a file needs its blob SHA, so pushes cache name -> sha.
const API = 'https://api.github.com';

async function ghErr(r) {
  try { const j = await r.json(); return `GitHub ${r.status}: ${j.message || JSON.stringify(j)}`; }
  catch { return `GitHub ${r.status}`; }
}
function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}
// base64 for UTF-8 payloads, chunked so a large snapshot cannot overflow the stack
function b64encode(str) {
  const bytes = enc.encode(str);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

// Read one snapshot. Returns { obj, sha } or null when the file does not exist.
async function ghRead(token, repo, path) {
  const r = await fetch(`${API}/repos/${repo}/contents/${path}`, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await ghErr(r));
  const j = await r.json();
  // Files over ~1MB come back with content omitted and truncated set.
  if (!j.content && j.download_url) {
    const raw = await fetch(j.download_url);
    if (!raw.ok) throw new Error(`GitHub ${raw.status} fetching ${path}`);
    return { obj: JSON.parse(await raw.text()), sha: j.sha };
  }
  return { obj: JSON.parse(b64decode(j.content)), sha: j.sha };
}

// Create or update. `sha` must be the current blob SHA when replacing, absent when new.
async function ghWrite(token, repo, path, obj, sha, message) {
  const body = { message, content: b64encode(JSON.stringify(obj, null, 2)) };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await ghErr(r));
  return (await r.json()).content.sha;
}

async function ghDelete(token, repo, path, sha, message) {
  const r = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    method: 'DELETE', headers: ghHeaders(token), body: JSON.stringify({ message, sha }),
  });
  if (!r.ok) throw new Error(await ghErr(r));
}

// One request for the whole collection — no per-file reads, unlike the old backend.
// Returns [] for a directory that does not exist yet.
async function ghList(token, repo, dir) {
  const r = await fetch(`${API}/repos/${repo}/contents/${dir}`, { headers: ghHeaders(token) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(await ghErr(r));
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`${dir} is not a directory in ${repo}`);
  return j.filter((e) => e.type === 'file' && /\.json$/i.test(e.name));
}

// Commit timestamp for one path — only fetched for `!cloud list`, one call per file.
async function ghLastCommit(token, repo, path) {
  const r = await fetch(`${API}/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
    { headers: ghHeaders(token) });
  if (!r.ok) return null;
  const j = await r.json();
  return j[0]?.commit?.committer?.date || null;
}

export function setupCloud({ appKind, buildExportData, importJsonData, refresh }) {
  const NS = `${appKind}.cloud`;
  const K = { config: `${NS}.config`, bins: `${NS}.bins`, state: `${NS}.state`, device: `${NS}.device` };
  const SDB = `pglite-${appKind}-cloud`; // IndexedDB name for the secrets kv store
  const DEFAULT = 'main';
  const MODE_KEY = `${appKind}.sync.mode`; // 'cloud' | 'local' | absent — see "One mode at a time"

  // --- non-secret persistence (localStorage) ---
  const loadConfig = () => { try { const c = JSON.parse(localStorage.getItem(K.config) || 'null'); return (c && c.repo) ? c : null; } catch { return null; } };
  const saveConfig = (c) => localStorage.setItem(K.config, JSON.stringify(c));
  // name -> blob SHA. A PUT that replaces an existing file must send its current
  // SHA, so cache what we last saw and re-read on a miss.
  const loadShas = () => { try { return JSON.parse(localStorage.getItem(K.bins) || '{}'); } catch { return {}; } };
  const saveShas = (m) => localStorage.setItem(K.bins, JSON.stringify(m));
  const pathFor = (name) => `${appKind}/${name}.json`;
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


  // --- the one secret this app stores, per device (IndexedDB) ---
  // A fine-grained PAT scoped to the snapshots repo. Set once, not re-prompted each
  // session: reaching IndexedDB already requires the unlocked device and this origin.
  async function ensureToken() {
    let t = await idbGet(SDB, 'token');
    if (t) return t;
    t = await maskedPrompt(
      'GitHub token',
      'Fine-grained personal access token with Contents: read and write on the snapshots repo. Stored on this device only.'
    );
    if (!t) return null;
    await idbSet(SDB, 'token', t);
    return t;
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
    ind.addEventListener('click', async () => {
      // Push to the snapshot you're currently synced with (not always the default),
      // so the one-click follows your named-snapshot workflow — and to whichever
      // transport is active, since only one can be.
      const mode = activeMode();
      if (ind.dataset.state === 'perm') { await ensureDir(); updateDirty(); return; }
      if (ind.dataset.state === 'dirty') {
        if (mode === 'local') await doLocalPush(loadLocalState()?.name || LOCAL_DEFAULT);
        else await doPush(loadState()?.name || DEFAULT);
        return;
      }
      if (mode === 'local') await doLocalStatus(); else await doStatus();
    });
  })();
  // The indicator is one line under the search bar, shared by both transports.
  // Only the glyph and the wording change with the mode — position, colors and
  // click-to-push are identical.
  //
  // A tooltip that says only «In sync with "main"» is ambiguous once there are two
  // backends, so every message names its transport. (This bit once: the tooltip
  // reported a 9:01am cloud push while a local push had just completed at 3:20pm,
  // with nothing to say the two numbers described different things.)
  function setInd(state, title, name) {
    if (!ind) return;
    const mode = activeMode();
    const glyph = mode === 'local' ? '💾' : '☁';
    const dflt = mode === 'local' ? LOCAL_DEFAULT : DEFAULT;
    const where = mode === 'local' ? (loadLocalCfg()?.dirName || 'the local folder') : 'the cloud';
    ind.dataset.state = state || '';
    ind.dataset.mode = mode || '';
    if (state === 'busy') {
      ind.style.display = ''; ind.textContent = `${glyph} …`;
      ind.style.color = '#888'; ind.title = 'Working…';
    } else if (state === 'synced') {
      ind.style.display = ''; ind.textContent = `${glyph} synced`;
      ind.style.color = '#888'; ind.title = title || `In sync with ${where}.`;
    } else if (state === 'perm') {
      // Local only. FSA permission does not survive a browser session; that is a
      // distinct condition from "unsaved" — we cannot write, so we do not claim to.
      ind.style.display = ''; ind.textContent = `${glyph} ${where} ⚠ — click to re-grant`;
      ind.style.color = '#ffb000';
      ind.title = title || 'Folder permission expired. Click to grant it again.';
    } else if (state === 'dirty') {
      ind.style.display = '';
      // Name the target snapshot when it isn't the default, so a click is never a surprise.
      ind.textContent = (name && name !== dflt)
        ? `${glyph} unsaved — click to push "${name}"`
        : `${glyph} unsaved — click to push`;
      ind.style.color = '#ffb000';
      ind.title = `Local changes not pushed to ${where}. Click to push to "${name || dflt}".`;
    } else {
      ind.style.display = 'none';
    }
  }

  let busy = false; // true only while an op holds the spinner; the op clears it before settling
  let dirtyTimer = null;
  function updateDirty() { clearTimeout(dirtyTimer); dirtyTimer = setTimeout(_updateDirty, 300); }
  async function _updateDirty() {
    if (busy) return; // a refresh()-driven tick fired mid-op — don't clobber the spinner
    const mode = activeMode();
    if (!mode) { setInd(); return; } // disconnected — indicator hidden entirely
    let data;
    try { data = await buildExportData(); } catch { return; }
    const hash = await sha256Hex(stable(data));

    if (mode === 'local') {
      const cfg = loadLocalCfg();
      const st = loadLocalState();
      // Check permission without prompting: a background dirty tick must never
      // pop a permission dialog the user did not ask for.
      if (cfg?.backend === 'fsdir' && !(await ensureDir({ prompt: false }))) {
        setInd('perm', `Folder "${cfg.dirName}" needs permission again (new browser session). Click to re-grant.`);
        return;
      }
      if (st && st.hash === hash) {
        setInd('synced', `In sync with local snapshot "${st.name}"${cfg?.dirName ? ` in ${cfg.dirName}` : ''} (${fmt(st.savedAt)}).`);
      } else {
        setInd('dirty', null, st?.name || LOCAL_DEFAULT);
      }
      return;
    }

    const st = loadState();
    if (st && st.hash === hash) setInd('synced', `In sync with cloud snapshot "${st.name}" (${fmt(st.savedAt)}).`);
    else setInd('dirty', null, st?.name || DEFAULT);
  }

  // A snapshot's identity is its path, so there is nothing to resolve — one read
  // either finds the file or does not. (The old backend had no way to look up a
  // snapshot by name, which forced reading every bin in the collection.)
  async function readSnapshot(token, repo, name) {
    const got = await ghRead(token, repo, pathFor(name));
    if (!got) return null;
    const shas = loadShas(); shas[name] = got.sha; saveShas(shas);
    return got;
  }

  // Everything written carries its own provenance, so a snapshot is self-describing
  // wherever it lands — a repo, a folder, or a downloaded file.
  async function wrap(name) {
    const data = await buildExportData();
    const body = Array.isArray(data) ? { entries: data } : data;
    return { app: appKind, name, savedAt: new Date().toISOString(), device, ...body };
  }

  // --- commands ---
  async function doConfigure(repo) {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      alert(
        'Usage: !cloud github <owner>/<repo>\n\n' +
        'Create a PRIVATE repo to hold snapshots, then paste owner/name here.\n' +
        'You will be prompted for a fine-grained personal access token with\n' +
        'Contents: read and write, scoped to that one repo.\n\n' +
        `Snapshots are written to ${appKind}/<name>.json inside it, so one repo can\n` +
        'serve both apps.'
      );
      return;
    }
    if (!(await claimMode('cloud'))) return;
    saveConfig({ backend: 'github', repo });
    const t = await ensureToken();
    if (!t) alert(`Saved ${repo}. No token yet — you'll be prompted on your first !cloud push.`);
    else alert(`Cloud configured — ${repo}.\n\nNext:  !cloud push   writes ${pathFor(DEFAULT)}.`);
    updateDirty();
  }

  // A phase-1 install can have both transports configured at once. Say so plainly
  // in whichever status the user asks for, rather than silently favouring one.
  const overlapNote = () => bothOn()
    ? `\n⚠ Both transports are configured on this device. "${activeMode()}" is active.\n` +
      `   Turn the other off:  !${activeMode() === 'cloud' ? 'local' : 'cloud'} off\n`
    : '';

  async function doStatus() {
    const cfg = loadConfig();
    if (!cfg) {
      alert('Cloud: not configured.\n\nSet up:\n  !cloud github <owner>/<repo>\nThen:\n  !cloud push  /  !cloud pull  /  !cloud list');
      return;
    }
    const hasToken = !!(await idbGet(SDB, 'token'));
    const st = loadState();
    let dirty = '—';
    try { const h = await sha256Hex(stable(await buildExportData())); dirty = (st && st.hash === h) ? 'in sync' : 'unsaved changes'; } catch { /* ignore */ }
    alert(
      `Cloud status — ${appKind}\n` +
      `Mode:         ${activeMode() === 'cloud' ? 'ACTIVE' : 'inactive — !local is the active transport'}\n` +
      overlapNote() + `\n` +
      `Backend:      GitHub — ${cfg.repo}\n` +
      `Path:         ${pathFor('<name>')}\n` +
      `Device:       ${device}\n` +
      `Token:        ${hasToken ? 'stored' : 'not stored'}\n` +
      `Encryption:   off — snapshots are plain JSON; the repo is the privacy boundary\n` +
      `Last sync:    ${st ? `"${st.name}" ${fmt(st.savedAt)}` : 'never'}\n` +
      `State:        ${dirty}\n\n` +
      `!cloud push · !cloud pull · !cloud list · !cloud delete <name> · !cloud device <label> · !cloud off`
    );
  }

  async function doList() {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud github <owner>/<repo>'); return; }
    const token = await ensureToken();
    if (!token) return;
    busy = true; setInd('busy');
    try {
      const files = await ghList(token, cfg.repo, appKind);
      if (!files.length) {
        alert(`No ${appKind} snapshots in ${cfg.repo} yet.\n\nCreate one with:  !cloud push`);
        return;
      }
      // The listing gives name and size for free; the commit date costs one call per
      // file, which is fine for a handful of snapshots and is what makes the list
      // readable ("when, and from where").
      const rows = await Promise.all(files.map(async (f) => {
        const name = f.name.replace(/\.json$/i, '');
        return { name, size: f.size, savedAt: await ghLastCommit(token, cfg.repo, f.path) };
      }));
      rows.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      const shas = loadShas();
      for (const f of files) shas[f.name.replace(/\.json$/i, '')] = f.sha;
      saveShas(shas);
      alert(
        `${appKind} snapshots in ${cfg.repo} (${rows.length}):\n\n` +
        rows.map((r) => `• ${r.name} — ${fmt(r.savedAt)}${r.size != null ? ` (${Math.round(r.size / 1024)} KB)` : ''}`).join('\n') +
        `\n\nPull:  !cloud pull <name>    ·    Delete:  !cloud delete <name>`
      );
    } catch (e) { alert('List failed: ' + e.message + describeNetworkError(e)); }
    finally { busy = false; updateDirty(); }
  }

  async function doPush(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud github <owner>/<repo>'); return; }
    const token = await ensureToken();
    if (!token) return;
    busy = true; setInd('busy');
    try {
      const body = await wrap(name);
      const count = body.entries ? body.entries.length : 0;

      // Read first: we need the SHA to replace a file, and the read doubles as the
      // "has another device pushed since I last did?" check.
      const existing = await readSnapshot(token, cfg.repo, name);
      if (existing) {
        const prev = existing.obj || {};
        const st = loadState();
        const remoteNewer = prev.savedAt && prev.device !== device &&
          (!st || !st.savedAt || prev.savedAt > st.savedAt);
        if (remoteNewer && !confirm(
          `Remote snapshot "${name}" was updated ${fmt(prev.savedAt)} from ${prev.device}.\n\n` +
          `Overwrite it with this device's data?`)) { updateDirty(); return; }
      }

      const sha = await ghWrite(token, cfg.repo, pathFor(name), body, existing?.sha,
        `${existing ? 'update' : 'add'} ${pathFor(name)} (${count} entries, from ${device})`);
      const shas = loadShas(); shas[name] = sha; saveShas(shas);
      saveState({ name, hash: await sha256Hex(stable(await buildExportData())), savedAt: body.savedAt });
      alert(`Pushed "${name}" — ${count} entries → ${cfg.repo}/${pathFor(name)}`);
    } catch (e) {
      alert('Push failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doPull(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud github <owner>/<repo>'); return; }
    const token = await ensureToken();
    if (!token) return;
    busy = true; setInd('busy');
    try {
      const found = await readSnapshot(token, cfg.repo, name);
      if (!found) { alert(`No snapshot named "${name}" for ${appKind}.\n\nSee what's there:  !cloud list`); updateDirty(); return; }
      const body = found.obj || {};
      // Snapshots live under <app>/, so a cross-app mixup takes a deliberate edit —
      // but check the tag anyway for files moved by hand.
      if (body.app && body.app !== appKind) {
        alert(`"${name}" is a ${body.app} snapshot — it can't be loaded into ${appKind}.`); updateDirty(); return;
      }
      if (body.ct) {
        alert(`"${name}" is in the old encrypted format, which is no longer supported.\n\nPush a fresh snapshot to replace it.`);
        updateDirty(); return;
      }
      if (!confirm(
        `Replace ALL local ${appKind} data with snapshot "${name}"\n(saved ${fmt(body.savedAt)} from ${body.device || 'unknown'})?\n\nThis cannot be undone.`)) { updateDirty(); return; }
      const ok = await importJsonData(body, `cloud:${name}`);
      if (ok) {
        await refresh();
        saveState({ name, hash: await sha256Hex(stable(await buildExportData())), savedAt: body.savedAt });
      }
    } catch (e) {
      alert('Pull failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doDelete(name) {
    const cfg = loadConfig();
    if (!cfg) { alert('Cloud not configured. Run: !cloud github <owner>/<repo>'); return; }
    if (!name) { alert(`Usage: !cloud delete <name>\n\nList snapshots:  !cloud list`); return; }
    const token = await ensureToken();
    if (!token) return;
    busy = true; setInd('busy');
    try {
      const found = await readSnapshot(token, cfg.repo, name);
      if (!found) { alert(`No snapshot named "${name}" for ${appKind}.\n\nSee what's there:  !cloud list`); updateDirty(); return; }
      const body = found.obj || {};
      if (!confirm(
        `Permanently DELETE remote snapshot "${name}" (saved ${fmt(body.savedAt)} from ${body.device || 'unknown'})?\n\n` +
        `This removes the file from ${cfg.repo} — your local data is untouched, and the\n` +
        `content stays in the repo's git history.`)) { updateDirty(); return; }
      await ghDelete(token, cfg.repo, pathFor(name), found.sha, `delete ${pathFor(name)} (from ${device})`);
      const shas = loadShas(); delete shas[name]; saveShas(shas);
      if (loadState()?.name === name) localStorage.removeItem(K.state);
      alert(`Deleted snapshot "${name}".`);
    } catch (e) {
      alert('Delete failed: ' + e.message + describeNetworkError(e));
    } finally { busy = false; updateDirty(); }
  }

  async function doOff() {
    if (!confirm('Disconnect cloud on this device and forget the stored GitHub token?\n\n(Your remote snapshots are not deleted.)')) return;
    await detachCloud();
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
      return '\n\n(Network/CORS error — check connectivity and that api.github.com is reachable from this origin.)';
    }
    return '';
  }

  // ==========================================================================
  // !local — the second transport. Same verbs as !cloud, a directory on disk
  // instead of a repo directory. Same verbs, same hashing helpers, same
  // indicator — the transport is the only thing that differs. See CLAUDE.md for why
  // local snapshots are written unencrypted.
  //
  // PHASE 2: mutual exclusion is enforced at the activation points (see claimMode),
  // and the indicator now follows the active mode — 💾 for local, ☁ for cloud, with
  // a local-only "permission expired" state. Deleting the 🔗/📝 attach UI and the
  // ↓/↑ buttons is phases 3 and 4.
  // ==========================================================================

  // Local snapshots are files, so the default name is the app's own filename
  // (activities.json / feed.json) rather than cloud's "main". That makes
  // `!local push` land on exactly the file the app has always written.
  const LOCAL_DEFAULT = appKind;
  const LK = { config: `${appKind}.local.config`, state: `${appKind}.local.state` };
  const DIR_KEY = 'localDir'; // FileSystemDirectoryHandle in the module's IDB store

  const hasFSDir = () => 'showDirectoryPicker' in window && window.isSecureContext;
  const fileFor = (name) => `${nameOf(name)}.json`;
  const nameOf = (filename) => filename.replace(/\.json$/i, '');

  const loadLocalCfg = () => { try { return JSON.parse(localStorage.getItem(LK.config) || 'null'); } catch { return null; } };
  const saveLocalCfg = (c) => localStorage.setItem(LK.config, JSON.stringify(c));
  const loadLocalState = () => { try { return JSON.parse(localStorage.getItem(LK.state) || 'null'); } catch { return null; } };
  const saveLocalState = (s) => localStorage.setItem(LK.state, JSON.stringify(s));

  // --- one mode at a time ---------------------------------------------------
  // A single sync.mode ('cloud' | 'local' | null)
  // replaces two overlapping state machines. It is stored explicitly rather than
  // inferred on every read, so the indicator never has to guess which transport a
  // "synced" claim describes.
  const loadMode = () => localStorage.getItem(MODE_KEY);
  const saveMode = (m) => { if (m) localStorage.setItem(MODE_KEY, m); else localStorage.removeItem(MODE_KEY); };

  const cloudOn = () => !!loadConfig();
  const localOn = () => !!loadLocalCfg();
  const bothOn = () => cloudOn() && localOn();

  // Resolve the active transport, healing a missing or stale mode key.
  function activeMode() {
    const c = cloudOn(), l = localOn();
    const m = loadMode();
    if (m === 'cloud' && c) return 'cloud';
    if (m === 'local' && l) return 'local';
    if (c && !l) { saveMode('cloud'); return 'cloud'; }
    if (l && !c) { saveMode('local'); return 'local'; }
    if (c && l) {
      // A phase-1 install can legitimately have both configured. Destroying one
      // without asking would be rude, so pick whichever was used most recently and
      // let the status commands point out the overlap.
      const pick = (loadLocalState()?.savedAt || '') > (loadState()?.savedAt || '') ? 'local' : 'cloud';
      saveMode(pick);
      return pick;
    }
    saveMode(null);
    return null;
  }

  // Silent detach halves — the interactive !cloud off / !local off wrap these.
  async function detachCloud() {
    localStorage.removeItem(K.config);
    localStorage.removeItem(K.bins);
    localStorage.removeItem(K.state);
    await idbDel(SDB, 'token');
    if (loadMode() === 'cloud') saveMode(null);
  }
  async function detachLocal() {
    localStorage.removeItem(LK.config);
    localStorage.removeItem(LK.state);
    await idbDel(SDB, DIR_KEY);
    if (loadMode() === 'local') saveMode(null);
  }

  // Activation gate. Turning one transport on turns the other off — with consent,
  // never silently. Returns false if the user declined, in which case the caller
  // must not activate.
  async function claimMode(target) {
    const other = target === 'cloud' ? 'local' : 'cloud';
    const otherOn = other === 'cloud' ? cloudOn() : localOn();
    if (otherOn) {
      const what = other === 'cloud'
        ? 'the GitHub cloud connection (its token is forgotten on this device; remote snapshots are kept)'
        : `the local folder "${loadLocalCfg()?.dirName || ''}" (the files in it are kept)`;
      if (!confirm(
        `${appKind} syncs with one transport at a time.\n\n` +
        `Turning on !${target} disconnects ${what}.\n\nSwitch to !${target}?`
      )) return false;
      if (other === 'cloud') await detachCloud(); else await detachLocal();
    }
    saveMode(target);
    return true;
  }

  // Returns a directory handle with readwrite permission, or null. Permission does
  // NOT survive a browser session, so this may prompt — that is normal, not an error.
  async function ensureDir({ prompt = true } = {}) {
    const h = await idbGet(SDB, DIR_KEY);
    if (!h) return null;
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && prompt) perm = await h.requestPermission({ mode: 'readwrite' });
    return perm === 'granted' ? h : null;
  }

  // --- no-FSA fallbacks: what ↓ and ↑ used to do, behind the same command ---
  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function pickJsonViaInput() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json,application/json';
      inp.style.display = 'none';
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return resolve(null);
        try { resolve({ name: nameOf(f.name), text: await f.text() }); }
        catch { resolve(null); }
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }

  // Decision 2: written plain, read either way. An envelope is recognised by `ct`.
  async function decodeLocal(text) {
    const obj = JSON.parse(text);
    // Snapshots written before encryption was dropped cannot be read any more. Say
    // so rather than handing importJsonData a base64 blob it would silently ignore.
    if (obj && obj.ct) {
      throw new Error('that file is in the old encrypted format, which is no longer supported');
    }
    if (obj && obj.app && obj.app !== appKind) throw new Error(`that file is a ${obj.app} snapshot`);
    return obj; // {app, name, savedAt, device, config, entries}, {config, entries}, or a bare array
  }

  async function doLocalAttach() {
    if (!hasFSDir()) {
      // No folder to attach, but local mode still means something here: push
      // downloads and pull opens a file picker. Record a config anyway so the mode
      // machinery and the indicator have something to see — without this, local
      // mode could never activate on Firefox/Safari.
      if (!(await claimMode('local'))) return;
      saveLocalCfg({ backend: 'download' });
      updateDirty();
      alert(
        'This browser has no File System Access API, so there is no folder to attach.\n\n' +
        'Local mode is on and works through the browser instead:\n' +
        '  !local push   downloads the JSON\n' +
        '  !local pull   opens a file picker'
      );
      return;
    }
    // Pick the folder BEFORE claiming the mode. claimMode() detaches the other
    // transport (forgetting the cloud token), so it must not
    // run until the user has actually committed to a directory — otherwise
    // confirming the switch and then cancelling the picker leaves you disconnected
    // from both.
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch { return; } // user cancelled — nothing has changed
    if (!(await claimMode('local'))) return; // declined the switch — folder not attached
    await idbSet(SDB, DIR_KEY, dir);
    saveLocalCfg({ backend: 'fsdir', dirName: dir.name });
    updateDirty(); // the glyph has to follow the mode change, not wait for the first push
    alert(`Local folder attached: ${dir.name}\n\nNext:  !local push   writes ${fileFor(LOCAL_DEFAULT)} there.`);
  }

  async function doLocalStatus() {
    const cfg = loadLocalCfg();
    const st = loadLocalState();
    // No File System Access API here (Firefox / Safari / plain HTTP): there is no
    // folder, but local mode is still a real mode — it just transports through the
    // browser's download and file-picker instead.
    if (cfg?.backend === 'download' || (!cfg && !hasFSDir())) {
      alert(
        `Local status — ${appKind}\n` +
        `Mode:      ${activeMode() === 'local' ? 'ACTIVE' : cfg ? 'inactive — !cloud is the active transport' : 'not set up — run !local attach'}\n` +
        overlapNote() + `\n` +
        `Transport: download / file-picker (no File System Access API here)\n` +
        `Last sync: ${st ? `"${st.name}" ${fmt(st.savedAt)}` : 'never'}\n\n` +
        `!local push · !local pull · !local off`
      );
      return;
    }
    if (!cfg) {
      alert('Local: no folder attached.\n\nSet up:\n  !local attach\nThen:\n  !local push  /  !local pull  /  !local list');
      return;
    }
    const dir = await ensureDir({ prompt: false });
    let dirty = '—';
    try { const h = await sha256Hex(stable(await buildExportData())); dirty = (st && st.hash === h) ? 'in sync' : 'unsaved changes'; } catch { /* ignore */ }
    alert(
      `Local status — ${appKind}\n` +
      `Mode:       ${activeMode() === 'local' ? 'ACTIVE' : 'inactive — !cloud is the active transport'}\n` +
      overlapNote() + `\n` +
      `Folder:     ${cfg.dirName}\n` +
      `Permission: ${dir ? 'granted' : 'needs re-grant (new browser session)'}\n` +
      `Encryption: off — files are plain JSON\n` +
      `Last sync:  ${st ? `"${st.name}" ${fmt(st.savedAt)}` : 'never'}\n` +
      `State:      ${dirty}\n\n` +
      `!local push · !local pull · !local list · !local delete <name> · !local off`
    );
  }

  async function doLocalList() {
    if (localTransport() !== 'folder') {
      alert(
        'There is no folder to list.\n\n' +
        (hasFSDir()
          ? 'Attach one with:  !local attach'
          : 'This browser has no File System Access API, so !local transports through\n' +
            'download / file-picker instead. Snapshots exist as files you saved, but the\n' +
            'app cannot browse or manage them — use !local push / !local pull.')
      );
      return;
    }
    const dir = await ensureDir();
    if (!dir) { alert('Folder permission declined. Click the 💾 indicator to grant it.'); return; }
    busy = true; setInd('busy');
    try {
      const out = [];
      for await (const [fname, h] of dir.entries()) {
        if (h.kind !== 'file' || !/\.json$/i.test(fname)) continue;
        let size = null, mtime = null;
        try { const f = await h.getFile(); size = f.size; mtime = new Date(f.lastModified).toISOString(); } catch { /* ignore */ }
        out.push({ name: nameOf(fname), size, savedAt: mtime });
      }
      out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      if (!out.length) alert(`No .json files in ${dir.name} yet.\n\nCreate one with:  !local push`);
      else alert(
        `Local snapshots in ${dir.name} (${out.length}):\n\n` +
        out.map((s) => `• ${s.name} — ${fmt(s.savedAt)}${s.size != null ? ` (${Math.round(s.size / 1024)} KB)` : ''}`).join('\n') +
        `\n\nPull:  !local pull <name>    ·    Delete:  !local delete <name>`
      );
    } catch (e) { alert('List failed: ' + e.message); }
    finally { busy = false; updateDirty(); }
  }

  // Which transport should a push/pull use, and does it count as a snapshot?
  //
  //   'folder'   — a directory is attached; read/write files in it, record state
  //   'browser'  — local mode is on but there is no directory (no File System
  //                Access API here); download / file-picker, still record state
  //   'oneoff'   — local mode is not set up at all. Download / file-picker, but do
  //                NOT record state and do NOT claim the mode: this is the one-off
  //                export/import that the ↓ / ↑ buttons used to provide, and a
  //                throwaway download must not silently disconnect !cloud.
  function localTransport() {
    const cfg = loadLocalCfg();
    if (!cfg) return 'oneoff';
    return cfg.backend === 'fsdir' && hasFSDir() ? 'folder' : 'browser';
  }

  async function doLocalPush(name) {
    busy = true; setInd('busy');
    try {
      // Same shape !cloud writes, so a snapshot is self-describing wherever it lands.
      const data = await wrap(name);
      const count = data.entries ? data.entries.length : 0;
      const savedAt = data.savedAt;

      const via = localTransport();
      if (via !== 'folder') {
        downloadJson(data, fileFor(name));
        if (via === 'browser') saveLocalState({ name, hash: await sha256Hex(stable(await buildExportData())), savedAt });
        return;
      }
      const dir = await ensureDir();
      if (!dir) { alert('Folder permission declined. Click the 💾 indicator to grant it, or run:  !local attach'); return; }

      // Warn before clobbering a file this device did not write most recently.
      let existed = false;
      try { await dir.getFileHandle(fileFor(name)); existed = true; } catch { /* new file */ }
      if (existed) {
        const st = loadLocalState();
        if (!st || st.name !== name) {
          if (!confirm(`${fileFor(name)} already exists in ${dir.name}.\n\nOverwrite it with this device's data?`)) return;
        }
      }
      const fh = await dir.getFileHandle(fileFor(name), { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(data, null, 2));
      await w.close();
      saveLocalState({ name, hash: await sha256Hex(stable(await buildExportData())), savedAt });
      alert(`Pushed "${name}" — ${count} entries → ${dir.name}/${fileFor(name)}`);
    } catch (e) { alert('Push failed: ' + e.message); }
    finally { busy = false; updateDirty(); }
  }

  async function doLocalPull(name) {
    busy = true; setInd('busy');
    try {
      let text = null, pulledName = name;

      const via = localTransport();
      if (via !== 'folder') {
        const picked = await pickJsonViaInput();
        if (!picked) return;
        text = picked.text; pulledName = picked.name;
      } else {
        const dir = await ensureDir();
        if (!dir) { alert('Folder permission declined. Click the 💾 indicator to grant it, or run:  !local attach'); return; }
        let fh;
        try { fh = await dir.getFileHandle(fileFor(name)); }
        catch { alert(`No file named ${fileFor(name)} in ${dir.name}.\n\nSee what's there:  !local list`); return; }
        text = await (await fh.getFile()).text();
      }

      if (!confirm(`Replace ALL local ${appKind} data with "${pulledName}"?\n\nThis cannot be undone.`)) return;

      let data;
      try { data = await decodeLocal(text); }
      catch (e) { alert('Pull failed: ' + e.message); return; }
      if (data == null) return;

      const ok = await importJsonData(data, `local:${pulledName}`);
      if (ok) {
        await refresh();
        // A one-off import is not a snapshot — don't claim to be in sync with a file
        // the app has no way to find again.
        if (via !== 'oneoff') {
          saveLocalState({ name: pulledName, hash: await sha256Hex(stable(await buildExportData())), savedAt: new Date().toISOString() });
        }
      }
    } catch (e) { alert('Pull failed: ' + e.message); }
    finally { busy = false; updateDirty(); }
  }

  async function doLocalDelete(name) {
    if (localTransport() !== 'folder') {
      alert(
        'There is no folder to delete from.\n\n' +
        (hasFSDir()
          ? 'Attach one with:  !local attach'
          : 'This browser has no File System Access API, so !local transports through\n' +
            'download / file-picker instead. Snapshots exist as files you saved, but the\n' +
            'app cannot browse or manage them — use !local push / !local pull.')
      );
      return;
    }
    if (!name) { alert('Usage: !local delete <name>\n\nList snapshots:  !local list'); return; }
    const dir = await ensureDir();
    if (!dir) { alert('Folder permission declined. Click the 💾 indicator to grant it.'); return; }
    try { await dir.getFileHandle(fileFor(name)); }
    catch { alert(`No file named ${fileFor(name)} in ${dir.name}.`); return; }
    if (!confirm(`Permanently DELETE ${dir.name}/${fileFor(name)}?\n\nThis deletes only that file — your local data is untouched. Cannot be undone.`)) return;
    try {
      await dir.removeEntry(fileFor(name));
      if (loadLocalState()?.name === name) localStorage.removeItem(LK.state);
      alert(`Deleted ${fileFor(name)}.`);
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  async function doLocalOff() {
    if (!confirm('Detach the local folder on this device?\n\n(The files in it are not deleted.)')) return;
    await detachLocal();
    updateDirty();
    alert('Local folder detached on this device.');
  }

  async function command(cmd, args) {
    try {
      if (cmd === 'local') {
        const sub = (args[0] || '').toLowerCase();
        if (!sub) await doLocalStatus();
        else if (sub === 'attach') await doLocalAttach();
        else if (sub === 'push') await doLocalPush(args[1] || LOCAL_DEFAULT);
        else if (sub === 'pull') await doLocalPull(args[1] || LOCAL_DEFAULT);
        else if (sub === 'list') await doLocalList();
        else if (sub === 'delete') await doLocalDelete(args[1]);
        else if (sub === 'off') await doLocalOff();
        else alert(`Unknown !local subcommand: "${sub}"\n\nTry:  !local · !local attach · !local push · !local pull · !local list · !local delete <name> · !local off`);
        return true;
      }
      if (cmd === 'cloud') {
        const sub = (args[0] || '').toLowerCase();
        if (!sub) await doStatus();
        else if (sub === 'push') await doPush(args[1] || DEFAULT);
        else if (sub === 'pull') await doPull(args[1] || DEFAULT);
        else if (sub === 'github') await doConfigure(args[1]);
        else if (sub === 'list') await doList();
        else if (sub === 'delete') await doDelete(args[1]);
        else if (sub === 'off') await doOff();
        else if (sub === 'device') doDevice(args.slice(1).join(' '));
        else alert(`Unknown !cloud subcommand: "${sub}"\n\nTry:  !cloud · !cloud push · !cloud pull · !cloud list · !cloud delete <name> · !cloud github <owner/repo> · !cloud device <label> · !cloud off`);
        return true;
      }
    } catch (e) { alert('Cloud error: ' + e.message); return true; }
    return false;
  }

  updateDirty(); // reflect any existing config at startup
  return { command, updateDirty };
}
