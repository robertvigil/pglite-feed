// Smoke tests for setupCrud in BOTH apps.
//
// These exist because phase 3's deletion of the file-attach code accidentally took
// importJsonData with it. The app still parsed and every unit test passed — the
// failure only showed as a page stuck on "Loading...", because setupCrud threw a
// ReferenceError before the first render. A syntax check cannot catch that; calling
// the function can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './harness.mjs';

const APPS = [
  { name: 'feed', mod: '../js/crud.js', args: (db, refresh) => [db, refresh] },
  { name: 'activities', mod: '../../pglite-activities/js/crud.js',
    args: (db, refresh) => [db, refresh, { loadTitle: async () => {}, loadTheme: async () => {} }] },
];

for (const app of APPS) {
  test(`${app.name}: setupCrud initializes and returns its API`, async () => {
    installBrowser();
    const db = { query: async () => ({ rows: [] }), exec: async () => {} };
    const { setupCrud } = await import(app.mod + '?' + Math.random());
    const api = setupCrud(...app.args(db, async () => {}));
    assert.equal(typeof api.buildExportData, 'function');
    assert.equal(typeof api.importJsonData, 'function');
    assert.equal(api.syncToFile, undefined, 'always-on file sync was removed in phase 3');
  });

  test(`${app.name}: importJsonData rolls back a failed import`, async () => {
    installBrowser();
    const statements = [];
    const db = {
      query: async (sql) => {
        statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
        if (sql.includes('INSERT INTO feed') || sql.includes('INSERT INTO activities')) {
          throw new Error('simulated write failure');
        }
        return { rows: [] };
      },
      exec: async (sql) => { statements.push(sql.trim().replace(';', '')); },
    };
    const { setupCrud } = await import(app.mod + '?' + Math.random());
    const api = setupCrud(...app.args(db, async () => {}));
    const rows = app.name === 'feed'
      ? [{ feed_date: '2026-01-01', feed_content: 'x' }]
      : [{ date: '2026-01-01', distance: 1, duration: '00:10:00', comments: '' }];

    const ok = await api.importJsonData({ config: {}, entries: rows }, 'test');
    assert.equal(ok, false, 'a failed import must report failure');
    assert.ok(statements.includes('BEGIN'), 'import runs in a transaction');
    assert.ok(statements.includes('ROLLBACK'), 'a mid-import failure rolls back');
    assert.equal(statements.includes('COMMIT'), false, 'must not commit a failed import');
  });
}
