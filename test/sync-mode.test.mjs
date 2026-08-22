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
    syncToFile: async () => {},
  });
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
