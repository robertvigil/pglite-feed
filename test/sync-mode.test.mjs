// Phase 2: one mode at a time, and an indicator that says which one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, fakeDir, settle } from './harness.mjs';

const ENTRIES = { config: { site_title: 'x' }, entries: [{ feed_date: '2026-01-01', feed_content: 'a' }] };

async function boot(opts = {}) {
  const env = installBrowser(opts);
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed',
    buildExportData: async () => ENTRIES,
    importJsonData: async () => true,
    refresh: async () => {},
  }); // note: no syncToFile — phase 3 removed the always-on file attach
  return { ...env, api };
}

const cloudCfg = () => localStorage.setItem('feed.cloud.config', JSON.stringify({ backend: 'jsonbin', collectionId: 'c1' }));
const localCfg = () => localStorage.setItem('feed.local.config', JSON.stringify({ backend: 'fsdir', dirName: 'snapshots' }));
const mode = () => localStorage.getItem('feed.sync.mode');

test('disconnected: indicator hidden, no mode', async () => {
  const { api, indicator } = await boot();
  api.updateDirty(); await settle();
  assert.equal(indicator().style.display, 'none');
  assert.equal(mode(), null);
});

test('cloud only: cloud glyph, tooltip names the transport', async () => {
  const { api, indicator } = await boot();
  cloudCfg();
  api.updateDirty(); await settle();
  assert.match(indicator().textContent, /^☁/);
  assert.match(indicator().title, /cloud/i);
  assert.equal(mode(), 'cloud');
});

test('local only: floppy glyph, tooltip names the folder', async () => {
  const { api, indicator } = await boot();
  localCfg();
  localStorage.setItem('feed.local.state', JSON.stringify({ name: 'feed', hash: 'nope', savedAt: '2026-08-22T20:00:00Z' }));
  api.updateDirty(); await settle();
  assert.match(indicator().textContent, /^💾/);
  assert.match(indicator().title, /snapshots/);
  assert.equal(mode(), 'local');
});

test('both configured (a phase-1 install): most recently used wins, nothing destroyed', async () => {
  const { api } = await boot();
  cloudCfg(); localCfg();
  localStorage.setItem('feed.cloud.state', JSON.stringify({ name: 'main', hash: 'h', savedAt: '2026-08-22T09:01:00Z' }));
  localStorage.setItem('feed.local.state', JSON.stringify({ name: 'math', hash: 'h', savedAt: '2026-08-22T15:34:00Z' }));
  api.updateDirty(); await settle();
  assert.equal(mode(), 'local', 'the later savedAt wins');
  assert.ok(localStorage.getItem('feed.cloud.config'), 'cloud config must survive');
  assert.ok(localStorage.getItem('feed.local.config'), 'local config must survive');
});

test('both configured: status warns about the overlap', async () => {
  const { api, calls } = await boot();
  cloudCfg(); localCfg();
  await api.command('cloud', []);
  assert.match(calls.alerts.at(-1), /Both transports are configured/);
});

test('switching to local detaches cloud after an explicit confirm', async () => {
  const { api, calls } = await boot({ confirmAnswers: [true] });
  cloudCfg();
  await api.command('local', ['attach']);
  assert.match(calls.confirms[0], /one transport at a time/i);
  assert.equal(localStorage.getItem('feed.cloud.config'), null, 'cloud detached');
  assert.ok(localStorage.getItem('feed.local.config'), 'local attached');
  assert.equal(mode(), 'local');
});

test('declining the switch changes nothing', async () => {
  const { api } = await boot({ confirmAnswers: [false] });
  cloudCfg();
  await api.command('local', ['attach']);
  assert.ok(localStorage.getItem('feed.cloud.config'), 'cloud still connected');
  assert.equal(localStorage.getItem('feed.local.config'), null, 'local not attached');
});

test('cancelling the folder picker leaves cloud untouched', async () => {
  // Regression: claimMode() used to run BEFORE the picker, so confirming the
  // switch and then cancelling deleted the cloud master key and left you on
  // neither transport.
  const { api, calls } = await boot({ confirmAnswers: [true] });
  cloudCfg();
  window.showDirectoryPicker = async () => { throw new Error('AbortError'); };
  await api.command('local', ['attach']);
  assert.ok(localStorage.getItem('feed.cloud.config'), 'cloud must survive a cancelled picker');
  assert.equal(localStorage.getItem('feed.local.config'), null);
  assert.equal(calls.confirms.length, 0, 'must not even ask before a folder is chosen');
});

test('attach repaints the indicator immediately, before any push', async () => {
  // Regression: doLocalAttach() had no updateDirty(), so the glyph kept showing
  // the old transport until the first local push forced a tick.
  const { api, indicator } = await boot();
  await api.command('local', ['attach']);
  await settle();
  assert.match(indicator().textContent, /^💾/);
});

test('lapsed folder permission is its own amber state, and never prompts on a tick', async () => {
  const { api, indicator, calls } = await boot();
  const dir = fakeDir('snapshots');
  dir._setPermission('prompt');
  window.showDirectoryPicker = async () => dir;
  await api.command('local', ['attach']);
  dir._setPermission('prompt'); // expires when the browser session ends
  api.updateDirty(); await settle();
  assert.match(indicator().textContent, /⚠/);
  assert.match(indicator().textContent, /re-grant/);
  assert.equal(indicator().style.color, '#ffb000');
});

test('dirty state names a non-default snapshot so a click is never a surprise', async () => {
  const { api, indicator } = await boot();
  window.showDirectoryPicker = async () => fakeDir('snapshots');
  await api.command('local', ['attach']); // a real handle, so we get dirty not perm
  localStorage.setItem('feed.local.state', JSON.stringify({ name: 'before-trip', hash: 'stale', savedAt: '2026-08-22T15:00:00Z' }));
  api.updateDirty(); await settle();
  assert.match(indicator().textContent, /unsaved — click to push "before-trip"/);
});

test('push writes the file, list sees it, delete removes it', async () => {
  const { api, calls } = await boot();
  const dir = fakeDir('snapshots');
  window.showDirectoryPicker = async () => dir;
  await api.command('local', ['attach']);
  await api.command('local', ['push']);
  assert.ok(dir._files.has('feed.json'), 'push wrote feed.json');
  assert.deepEqual(JSON.parse(dir._files.get('feed.json').text), ENTRIES, 'plain {config, entries}, unencrypted');

  await api.command('local', ['list']);
  assert.match(calls.alerts.at(-1), /feed/);

  await api.command('local', ['delete', 'feed']);
  assert.equal(dir._files.has('feed.json'), false, 'delete removed it');
});

// --- phase 3: no File System Access API (Firefox / Safari / plain HTTP) ---

test('no-FSA: attach still activates local mode, so the indicator can work', async () => {
  // Phase-2 gap: the download fallback never recorded a config, so localOn() was
  // false, local mode could never activate, and the indicator stayed hidden even
  // after a successful push.
  const { api, calls, indicator } = await boot({ hasFSA: false });
  await api.command('local', ['attach']);
  assert.equal(JSON.parse(localStorage.getItem('feed.local.config')).backend, 'download');
  assert.equal(mode(), 'local');
  assert.match(calls.alerts.at(-1), /download|file picker/i);
  await settle();
  assert.match(indicator().textContent, /^💾/);
});

test('no-FSA: the download backend never reports a permission problem', async () => {
  // The amber state is meaningful only for a real folder handle. A download-mode
  // install has nothing to grant, so it must fall through to dirty/synced.
  const { api, indicator } = await boot({ hasFSA: false });
  await api.command('local', ['attach']);
  api.updateDirty(); await settle();
  assert.doesNotMatch(indicator().textContent, /⚠/);
  assert.match(indicator().textContent, /unsaved/);
});

test('no-FSA: status reports the transport instead of a folder', async () => {
  const { api, calls } = await boot({ hasFSA: false });
  await api.command('local', ['attach']);
  await api.command('local', []);
  assert.match(calls.alerts.at(-1), /download \/ file-picker/);
  assert.match(calls.alerts.at(-1), /ACTIVE/);
});

test('no-FSA: switching from cloud still requires a confirm', async () => {
  const { api, calls } = await boot({ hasFSA: false, confirmAnswers: [false] });
  cloudCfg();
  await api.command('local', ['attach']);
  assert.match(calls.confirms[0], /one transport at a time/i);
  assert.ok(localStorage.getItem('feed.cloud.config'), 'declined: cloud survives');
  assert.equal(localStorage.getItem('feed.local.config'), null);
});

// --- phase 4: !local push/pull replace the ↓ / ↑ buttons ---

test('no folder attached: push downloads instead of failing', async () => {
  // Phase 4 deleted the ↓ button. A push with local mode not set up must still
  // produce a file, or that capability is simply gone on FSA browsers.
  const { api } = await boot();
  const downloads = [];
  document.createElement = ((orig) => (tag) => {
    const el = orig(tag);
    if (tag === 'a') Object.defineProperty(el, 'download', {
      set(v) { downloads.push(v); }, get() { return downloads.at(-1); }, configurable: true });
    return el;
  })(document.createElement);
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

  await api.command('local', ['push']);
  assert.deepEqual(downloads, ['feed.json'], 'push fell back to a download');
});

test('a one-off download must not claim local mode or fake a snapshot', async () => {
  // The ↓ button never changed how the app synced. Its replacement must not either:
  // a throwaway export cannot silently disconnect !cloud or claim to be in sync.
  const { api, indicator } = await boot();
  cloudCfg();
  globalThis.Blob = class {}; globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

  await api.command('local', ['push']);
  assert.equal(localStorage.getItem('feed.local.config'), null, 'mode not claimed');
  assert.equal(localStorage.getItem('feed.local.state'), null, 'no snapshot recorded');
  assert.ok(localStorage.getItem('feed.cloud.config'), 'cloud still connected');
  assert.equal(mode(), 'cloud');
  await settle();
  assert.match(indicator().textContent, /^☁/, 'still showing the cloud transport');
});

test('list and delete explain themselves when there is no folder', async () => {
  const { api, calls } = await boot();
  await api.command('local', ['list']);
  assert.match(calls.alerts.at(-1), /no folder to list/i);
  assert.match(calls.alerts.at(-1), /!local attach/);
  await api.command('local', ['delete', 'x']);
  assert.match(calls.alerts.at(-1), /no folder to delete from/i);
});

test('no folder attached: pull opens a file picker and imports what you choose', async () => {
  // Phase 4 deleted the ↑ button; this is its replacement. The picked file is not a
  // snapshot the app can find again, so no state may be recorded for it.
  const { api } = await boot();
  cloudCfg();
  const PICKED = { config: {}, entries: [{ feed_date: '2026-02-02', feed_content: 'picked' }] };

  let inputEl = null;
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'input') {
      inputEl = el;
      el.files = [{ name: 'from-anywhere.json', text: async () => JSON.stringify(PICKED) }];
      // the real element fires 'change' once the user picks; do that on click()
      el.click = () => queueMicrotask(() => el._h?.change?.());
    }
    return el;
  };

  let imported = null;
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api2 = setupCloud({
    appKind: 'feed',
    buildExportData: async () => ENTRIES,
    importJsonData: async (data) => { imported = data; return true; },
    refresh: async () => {},
  });

  await api2.command('local', ['pull']);
  assert.ok(inputEl, 'a file input was created — the picker fallback ran');
  assert.deepEqual(imported, PICKED, 'the chosen file was imported');
  assert.equal(localStorage.getItem('feed.local.state'), null, 'a one-off import is not a snapshot');
  assert.equal(localStorage.getItem('feed.local.config'), null, 'mode not claimed');
  assert.ok(localStorage.getItem('feed.cloud.config'), 'cloud untouched');
  document.createElement = origCreate;
  void api;
});
