// CRUD operations — create, edit, delete, JSON open/save.
//
// Snapshots to disk are NOT here: they live behind !local in cloud.js. The
// always-on 🔗/📝 attach that wrote the file on every edit was removed in
// phase 3 — IndexedDB is the store, a file is a backup, and a backup you did
// not ask for is just a write on every keystroke.

import { escapeHtml } from './render.js';

// One-time cleanup: phase 3 deleted the always-on file attach, orphaning the
// IndexedDB store that held its FileSystemFileHandle. Drop it so an old handle
// (and the file permission the browser associates with it) does not linger.
// Guarded by a flag so this costs nothing after the first load.
try {
  if (!localStorage.getItem('feed.handles.purged')) {
    indexedDB.deleteDatabase('pglite-feed-handles');
    localStorage.setItem('feed.handles.purged', '1');
  }
} catch { /* private mode or storage disabled — nothing to clean up */ }

export function setupCrud(db, refreshFn) {
  const createForm = document.getElementById('create-form');
  const createToggle = document.getElementById('create-toggle');
  const createCancel = document.getElementById('create-cancel');
  const outputEl = document.getElementById('output');

  document.getElementById('action-bar').style.display = 'flex';

  async function buildExportData() {
    const result = await db.query(`
      SELECT feed_date, feed_content
      FROM feed
      ORDER BY feed_date DESC, feed_content ASC;
    `);
    const entries = result.rows.map(row => ({
      feed_date: new Date(row.feed_date).toISOString().split('T')[0],
      feed_content: row.feed_content,
    }));
    // 'content_loaded' is a leftover from the removed read-only mode. Nothing
    // writes it any more, but databases created before that removal still carry
    // one — keep excluding it so it never leaks into an export.
    const configResult = await db.query(
      "SELECT key, value FROM config WHERE key NOT IN ('content_loaded')"
    );
    const config = {};
    for (const row of configResult.rows) config[row.key] = row.value;
    return Object.keys(config).length > 0 ? { config, entries } : entries;
  }

  async function importJsonData(raw, sourceLabel) {
    const entries = Array.isArray(raw) ? raw : (raw.entries || []);
    const jsonConfig = Array.isArray(raw) ? {} : (raw.config || {});

    if (!Array.isArray(entries)) {
      alert('JSON must be an array of entries or {config, entries} object.');
      return false;
    }

    const searchInput = document.getElementById('search');
    const savedSearch = searchInput.value;
    const savedPlaceholder = searchInput.placeholder;
    searchInput.disabled = true;
    searchInput.value = '';

    // The DELETE and the reload are one transaction: a failure part-way through
    // must not leave the feed table emptied or half-populated. Every import route
    // (!local pull, !cloud pull, the legacy file-open) lands here.
    const total = entries.length;
    await db.exec('BEGIN;');
    try {
      await db.exec('DELETE FROM feed;');
      for (let i = 0; i < entries.length; i++) {
        const row = entries[i];
        await db.query(
          'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
          [row.feed_date, row.feed_content]
        );
        if (i % 25 === 0 || i === entries.length - 1) {
          searchInput.placeholder = `Loading ${i + 1} / ${total}...`;
          await new Promise(r => setTimeout(r, 0));
        }
      }

      for (const [key, value] of Object.entries(jsonConfig)) {
        await db.query(
          "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2;",
          [key, value]
        );
      }

      await db.exec('COMMIT;');
    } catch (err) {
      await db.exec('ROLLBACK;');
      searchInput.disabled = false;
      searchInput.value = savedSearch;
      searchInput.placeholder = savedPlaceholder;
      alert('Import failed: ' + err.message);
      return false;
    }

    searchInput.disabled = false;
    searchInput.value = savedSearch;
    searchInput.placeholder = savedPlaceholder;

    if (jsonConfig.site_title !== undefined) {
      const titleEl = document.getElementById('home-link');
      titleEl.textContent = `[${jsonConfig.site_title || 'feed'}]`;
    }
    if (jsonConfig.theme) {
      document.documentElement.setAttribute('data-theme', jsonConfig.theme);
    }
    alert(`Loaded ${total} entries from ${sourceLabel}.`);
    return true;
  }

  // --- Create form ---
  function showCreateForm() {
    createForm.classList.add('open');
    document.getElementById('new-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('new-content').focus();
  }

  function hideCreateForm() {
    createForm.classList.remove('open');
    createForm.reset();
  }

  if (createToggle) {
    createToggle.addEventListener('click', () => {
      createForm.classList.contains('open') ? hideCreateForm() : showCreateForm();
    });
  }

  if (createCancel) {
    createCancel.addEventListener('click', hideCreateForm);
  }

  // --- Ctrl+Enter submits create form ---
  createForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      createForm.requestSubmit();
    }
  });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('new-date').value;
    const content = document.getElementById('new-content').value;
    try {
      await db.query(
        'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2);',
        [date, content]
      );
      hideCreateForm();
      await refreshFn();
    } catch (err) {
      alert('Failed to create entry: ' + err.message);
    }
  });

  // --- Row edit/delete via event delegation ---
  outputEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;

    if (btn.classList.contains('delete')) {
      if (!confirm('Delete this entry?')) return;
      await db.query('DELETE FROM feed WHERE id = $1;', [id]);
      await refreshFn();
      return;
    }

    if (btn.classList.contains('edit')) {
      const alreadyEditing = document.querySelector('tr.editing');
      if (alreadyEditing && alreadyEditing !== tr) {
        await refreshFn();
        const newTr = document.querySelector(`tr[data-id="${id}"]`);
        if (newTr) newTr.querySelector('.edit').click();
        return;
      }
      tr.classList.add('editing');
      tr.innerHTML = `
        <td class="edit-row-1"><textarea class="edit-content" rows="10">${tr.dataset.content}</textarea></td>
        <td class="edit-row-2">
          <input type="date" class="edit-date" value="${tr.dataset.date}">
          <button class="save" title="Save">✓</button>
          <button class="cancel" title="Cancel">↺</button>
        </td>
      `;
      return;
    }

    if (btn.classList.contains('save')) {
      const date = tr.querySelector('.edit-date').value;
      const content = tr.querySelector('.edit-content').value;
      try {
        await db.query(
          'UPDATE feed SET feed_date = $1, feed_content = $2 WHERE id = $3;',
          [date, content, id]
        );
        await refreshFn();
      } catch (err) {
        alert('Update failed: ' + err.message);
      }
      return;
    }

    if (btn.classList.contains('cancel')) {
      await refreshFn();
      return;
    }
  });

  // --- Ctrl+Enter or Shift+Enter saves inline edit (Enter alone adds newline in textarea) ---
  outputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || (!e.ctrlKey && !e.shiftKey)) return;
    const tr = e.target.closest('tr.editing');
    if (!tr) return;
    e.preventDefault();
    tr.querySelector('.save').click();
  });

  // --- Esc key cancels ---
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (createForm.classList.contains('open')) {
      hideCreateForm();
      return;
    }
    if (document.querySelector('tr.editing')) {
      refreshFn();
      return;
    }
  });

  // --- JSON Save (exports config + entries) ---
  document.getElementById('save-json')?.addEventListener('click', async () => {
    const data = await buildExportData();
    const entries = Array.isArray(data) ? data : data.entries;
    if (entries.length === 0) {
      alert('No entries to save.');
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'feed.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- JSON Open ---
  document.getElementById('open-json')?.addEventListener('click', () => {
    document.getElementById('json-input').click();
  });
  document.getElementById('json-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm(`You are about to replace all existing content with "${file.name}".\n\nThis cannot be undone. Continue?`)) {
      e.target.value = '';
      return;
    }

    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      alert('Invalid JSON file: ' + err.message);
      return;
    }

    const ok = await importJsonData(raw, file.name);
    if (ok) {
      await refreshFn();
    }
    e.target.value = '';
  });

  return { buildExportData, importJsonData };
}
