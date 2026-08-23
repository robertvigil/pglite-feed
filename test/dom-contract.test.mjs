// Static DOM contract for BOTH apps.
//
// Every getElementById('x') in js/ must have a matching id="x" in index.html, and
// every id in index.html should be reachable from JS or CSS. Deleting UI (phases 3
// and 4 removed the attach icons and the ↓/↑ buttons) is exactly when these drift:
// a handler left behind on a deleted element throws at setup and the page never
// renders, which is invisible to a syntax check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APPS = ['../.', '../../pglite-activities'];

function load(appDir) {
  const root = fileURLToPath(new URL(appDir + '/', import.meta.url));
  const html = readFileSync(root + 'index.html', 'utf8');
  const js = readdirSync(root + 'js')
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, readFileSync(root + 'js/' + f, 'utf8')]);
  const css = existsSync(root + 'css')
    ? readdirSync(root + 'css').map((f) => readFileSync(root + 'css/' + f, 'utf8')).join('\n')
    : '';
  return { root, html, js, css };
}

const idsIn = (html) => [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const lookupsIn = (src) => [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);

for (const appDir of APPS) {
  const { html, js, css } = load(appDir);
  const name = appDir.includes('activities') ? 'activities' : 'feed';
  const ids = new Set(idsIn(html));

  test(`${name}: every getElementById target exists in index.html`, () => {
    const missing = [];
    for (const [file, src] of js) {
      for (const id of lookupsIn(src)) {
        if (!ids.has(id)) missing.push(`${file} → #${id}`);
      }
    }
    assert.deepEqual(missing, [], 'JS reaches for elements that are not in the HTML');
  });

  test(`${name}: no element id is orphaned`, () => {
    const allJs = js.map(([, s]) => s).join('\n');
    const orphans = [...ids].filter(
      (id) => !allJs.includes(`'${id}'`) && !allJs.includes(`"${id}"`) && !css.includes(`#${id}`)
    );
    assert.deepEqual(orphans, [], 'ids in index.html that nothing references');
  });

  test(`${name}: the deleted persistence UI stays deleted`, () => {
    // Phases 3 and 4. Reintroducing any of these means reintroducing always-on file
    // sync or a second export path — both deliberately removed. See ROADMAP.
    for (const gone of ['attach-file', 'create-file', 'attach-name',
                        'save-json', 'open-json', 'json-input',
                        'export-csv', 'import-csv', 'csv-input']) {
      assert.equal(ids.has(gone), false, `#${gone} is back in index.html`);
    }
    const allJs = js.map(([, s]) => s).join('\n');
    for (const gone of ['syncToFile', 'attachedHandle', 'updateAttachUI']) {
      assert.equal(allJs.includes(`function ${gone}`), false, `${gone}() is back`);
    }
  });
}
