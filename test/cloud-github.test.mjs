// The !cloud transport: plain JSON files in a private GitHub repo at <app>/<name>.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, installGitHub, settle } from './harness.mjs';

const ENTRIES = { config: { site_title: 'x' }, entries: [{ feed_date: '2026-01-01', feed_content: 'a' }] };
const REPO = 'me/snapshots';

async function boot({ files, imported = [] } = {}) {
  const env = installBrowser();
  const gh = installGitHub({ files });
  env.idb.set('pglite-feed-cloud', new Map([['token', 'ghp_test']])); // skip the masked prompt
  localStorage.setItem('feed.cloud.config', JSON.stringify({ backend: 'github', repo: REPO }));
  localStorage.setItem('feed.cloud.device', 'laptop');
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed',
    buildExportData: async () => ENTRIES,
    importJsonData: async (d) => { imported.push(d); return true; },
    refresh: async () => {},
  });
  return { ...env, ...gh, api, imported, alerts: env.calls.alerts };
}

test('push writes plain JSON to <app>/<name>.json', async () => {
  const { api, repo, calls } = await boot();
  await api.command('cloud', ['push']);
  const written = repo.get('feed/main.json');
  assert.ok(written, 'wrote feed/main.json');
  const obj = JSON.parse(written);
  assert.equal(obj.ct, undefined, 'no encryption envelope');
  assert.deepEqual({ config: obj.config, entries: obj.entries }, ENTRIES);
  assert.equal(obj.app, 'feed');
  assert.equal(obj.name, 'main');
  assert.equal(obj.device, 'laptop');
  const put = calls.find((c) => c.method === 'PUT');
  assert.match(put.body.message, /add feed\/main\.json \(1 entries, from laptop\)/);
  assert.equal(put.body.sha, undefined, 'a new file must not send a sha');
});

test('a second push sends the current sha so GitHub accepts the replace', async () => {
  const { api, repo, calls } = await boot({ files: {} });
  await api.command('cloud', ['push']);
  await api.command('cloud', ['push']);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.ok(puts[1].body.sha, 'the replace carried a sha');
  assert.match(puts[1].body.message, /update feed\/main\.json/);
  assert.ok(repo.get('feed/main.json'));
});

test('pull loads a snapshot and refuses one belonging to another app', async () => {
  const good = JSON.stringify({ app: 'feed', name: 'main', savedAt: '2026-08-23T10:00:00Z', device: 'phone', ...ENTRIES });
  const wrong = JSON.stringify({ app: 'activities', name: 'main', savedAt: '2026-08-23T10:00:00Z', device: 'phone', entries: [] });
  const imported = [];
  const { api, calls } = await boot({ files: { 'feed/main.json': good, 'feed/other.json': wrong }, imported });
  await api.command('cloud', ['pull']);
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].entries, ENTRIES.entries);

  await api.command('cloud', ['pull', 'other']);
  assert.equal(imported.length, 1, 'the activities snapshot was refused, not imported');
  void calls;
});

test('list reads the directory in one request, not one per snapshot', async () => {
  const mk = (n) => JSON.stringify({ app: 'feed', name: n, savedAt: '2026-08-23T10:00:00Z', device: 'laptop', ...ENTRIES });
  const { api, calls, alerts } = await boot({
    files: { 'feed/main.json': mk('main'), 'feed/trip.json': mk('trip'), 'activities/main.json': mk('main') },
  });
  await api.command('cloud', ['list']);
  const contentGets = calls.filter((c) => c.method === 'GET' && c.url.includes('/contents/'));
  assert.equal(contentGets.length, 1, 'one directory read, no per-file fetches');
  const msg = alerts.at(-1);
  assert.match(msg, /main/); assert.match(msg, /trip/);
  assert.doesNotMatch(msg, /activities/, "the other app's directory is not listed");
});

test('delete removes the file and needs its sha', async () => {
  const body = JSON.stringify({ app: 'feed', name: 'old', savedAt: '2026-08-23T10:00:00Z', device: 'laptop', ...ENTRIES });
  const { api, repo, calls } = await boot({ files: { 'feed/old.json': body } });
  await api.command('cloud', ['delete', 'old']);
  assert.equal(repo.has('feed/old.json'), false);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del.body.sha, 'delete carried the blob sha');
});

test('an old encrypted snapshot is reported, not silently mangled', async () => {
  const legacy = JSON.stringify({ v: 1, app: 'feed', name: 'main', ct: 'QUJD', iv: 'x', cipher: 'AES-GCM' });
  const imported = [];
  const { api, alerts } = await boot({ files: { 'feed/main.json': legacy }, imported });
  await api.command('cloud', ['pull']);
  assert.equal(imported.length, 0, 'nothing was imported');
  assert.match(alerts.at(-1), /old encrypted format/);
});

// --- one-shot connect: !cloud github <owner>/<repo> <pat> ---

test('an inline token is stored without a prompt', async () => {
  const env = installBrowser();
  const gh = installGitHub({ token: 'github_pat_inline' });
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed', buildExportData: async () => ENTRIES,
    importJsonData: async () => true, refresh: async () => {},
  });

  await api.command('cloud', ['github', 'me/snapshots', 'github_pat_inline']);
  assert.deepEqual(JSON.parse(localStorage.getItem('feed.cloud.config')),
    { backend: 'github', repo: 'me/snapshots' });
  assert.equal(env.idb.get('pglite-feed-cloud').get('token'), 'github_pat_inline',
    'the token went straight to the secrets store');

  // and it works end to end without ever prompting
  await api.command('cloud', ['push']);
  assert.ok(gh.repo.get('feed/main.json'), 'pushed with the inline token');
  const auth = gh.calls.find((c) => c.method === 'PUT').auth;
  assert.equal(auth, 'Bearer github_pat_inline');
});

test('the success message never echoes the token back', async () => {
  const env = installBrowser();
  installGitHub({ token: 'github_pat_secret_value' });
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed', buildExportData: async () => ENTRIES,
    importJsonData: async () => true, refresh: async () => {},
  });
  await api.command('cloud', ['github', 'me/snapshots', 'github_pat_secret_value']);
  for (const m of env.calls.alerts) {
    assert.ok(!m.includes('github_pat_secret_value'), `token leaked into an alert: ${m}`);
  }
  assert.match(env.calls.alerts.at(-1), /Cloud configured/);
});

test('a token of an unexpected shape is accepted but flagged', async () => {
  const env = installBrowser();
  installGitHub({ token: 'not-a-pat' });
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed', buildExportData: async () => ENTRIES,
    importJsonData: async () => true, refresh: async () => {},
  });
  await api.command('cloud', ['github', 'me/snapshots', 'not-a-pat']);
  assert.equal(env.idb.get('pglite-feed-cloud').get('token'), 'not-a-pat',
    'stored anyway — GitHub may mint new prefixes, so never block on shape');
  assert.match(env.calls.alerts.at(-1), /doesn't look like a GitHub PAT/);
});

test('omitting the token still routes through the masked prompt', async () => {
  const env = installBrowser();
  installGitHub();
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed', buildExportData: async () => ENTRIES,
    importJsonData: async () => true, refresh: async () => {},
  });
  // the fake DOM never resolves the modal, so the prompt path is what we detect:
  // config is saved, no token lands, and nothing throws
  const done = api.command('cloud', ['github', 'me/snapshots']);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(localStorage.getItem('feed.cloud.config')),
    { backend: 'github', repo: 'me/snapshots' }, 'repo saved before the prompt');
  assert.equal(env.idb.get('pglite-feed-cloud')?.get('token'), undefined,
    'no token stored — it is being asked for, not typed');
  void done;
});

test('usage text documents the token as optional', async () => {
  const env = installBrowser();
  installGitHub();
  const { setupCloud } = await import('../js/cloud.js?' + Math.random());
  const api = setupCloud({
    appKind: 'feed', buildExportData: async () => ENTRIES,
    importJsonData: async () => true, refresh: async () => {},
  });
  await api.command('cloud', ['github']);          // no repo -> usage
  assert.match(env.calls.alerts.at(-1), /\[token\]/);
  assert.match(env.calls.alerts.at(-1), /masked prompt/);
});
