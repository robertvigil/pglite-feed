// Main app — PGlite init, refresh loop, event wiring

import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';
import { escapeHtml, renderContent } from './render.js';
import { parseSearch, buildSearchClauses, showTagCloud } from './search.js';
import { setupCrud } from './crud.js';

// --- URL parameter parsing ---
const params = new URLSearchParams(location.search);
const isAdmin = params.has('admin');

// --- Init PGlite ---
const db = new PGlite('idb://feed-v3');

await db.exec(`
  CREATE TABLE IF NOT EXISTS feed (
    id SERIAL PRIMARY KEY,
    feed_date DATE NOT NULL,
    feed_content TEXT NOT NULL,
    UNIQUE (feed_date, feed_content)
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Load content: content.json (with freshness check) or feed.json (one-time fallback) ---
try {
  const headResp = await fetch('content.json', { method: 'HEAD' });
  if (headResp.ok) {
    const serverModified = headResp.headers.get('Last-Modified') || '';
    const localResult = await db.query("SELECT value FROM config WHERE key = 'content_loaded'");
    const localModified = localResult.rows[0]?.value || '';

    if (serverModified !== localModified) {
      document.getElementById('output').textContent = 'Loading...';
      const resp = await fetch('content.json');
      const data = await resp.json();

      await db.exec('DELETE FROM feed;');
      for (const row of data) {
        await db.query(
          'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
          [row.feed_date, row.feed_content]
        );
      }

      await db.query(
        "INSERT INTO config (key, value) VALUES ('content_loaded', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [serverModified]
      );
    }
  } else {
    const count = await db.query('SELECT COUNT(*) AS n FROM feed;');
    if (count.rows[0].n === 0n || count.rows[0].n === 0) {
      document.getElementById('output').textContent = 'Loading...';
      const resp = await fetch('feed.json');
      if (resp.ok) {
        const data = await resp.json();
        for (const row of data) {
          await db.query(
            'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
            [row.feed_date, row.feed_content]
          );
        }
      }
    }
  }
} catch (e) {
  // fetch failed — use whatever's in the DB
}

// --- Main refresh ---
async function refresh() {
  const searchQuery = document.getElementById('search').value;
  const parsed = parseSearch(searchQuery);

  const outputEl = document.getElementById('output');
  const totalsEl = document.getElementById('totals');
  const searchEl = document.getElementById('search');

  // Tag cloud mode
  if (parsed.mode === 'tagcloud') {
    await showTagCloud(db, outputEl, totalsEl, searchEl, parsed.after, parsed.before);
    return;
  }

  // Build WHERE clause — starts at $1 (no fixed date params anymore)
  const search = buildSearchClauses(parsed, 1);

  // Default mode: hide entries with hashtags
  let noTagFilter = '';
  if (parsed.mode === 'default') {
    noTagFilter = " AND feed_content NOT SIMILAR TO '%#[a-zA-Z]%'";
  }

  // Totals
  const totalsResult = await db.query(`
    SELECT COUNT(*) AS n
    FROM feed
    WHERE 1=1
      ${noTagFilter}
      ${search.where};
  `, [...search.params]);

  const cnt = Number(totalsResult.rows[0].n);

  totalsEl.style.display = 'flex';
  totalsEl.innerHTML = `
    <div class="item"><span class="label">#:</span><span class="value">${cnt}</span></div>
  `;

  if (cnt === 0) {
    outputEl.innerHTML = '<p style="color:#666">No entries found.</p>';
    return;
  }

  const result = await db.query(`
    SELECT id, feed_date, feed_content
    FROM feed
    WHERE 1=1
      ${noTagFilter}
      ${search.where}
    ORDER BY feed_date DESC, feed_content ASC;
  `, [...search.params]);

  const dayNames = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

  let html = '<table><tr><th>Content</th><th>Date</th>';
  if (isAdmin) html += '<th></th>';
  html += '</tr>';

  for (const row of result.rows) {
    const dateStr = new Date(row.feed_date).toISOString().split('T')[0];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayName = dayNames[new Date(y, m - 1, d).getDay()];
    const displayDate = `${m}/${d}/${String(y).slice(-2)}`;

    html += `<tr data-id="${row.id}" data-date="${dateStr}" data-content="${escapeHtml(row.feed_content)}">
      <td class="content-cell">${renderContent(row.feed_content)}</td>
      <td>${displayDate} (${dayName})</td>`;

    if (isAdmin) {
      html += `<td class="actions">
          <button class="edit" title="Edit">✎</button>
          <button class="delete" title="Delete">✕</button>
        </td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  outputEl.innerHTML = html;
}

// --- Setup CRUD (admin controls, create form, edit/delete, JSON open/save) ---
setupCrud(db, isAdmin, refresh);

// --- Markdown viewer: intercept clicks on .md links ---
document.addEventListener('click', async (e) => {
  const link = e.target.closest('a[href$=".md"]');
  if (!link) return;
  e.preventDefault();

  const outputEl = document.getElementById('output');
  const totalsEl = document.getElementById('totals');
  totalsEl.style.display = 'none';

  try {
    outputEl.innerHTML = '<p style="color:#666">Loading...</p>';
    const resp = await fetch(link.getAttribute('href'));
    if (!resp.ok) {
      outputEl.innerHTML = `<p style="color:#f66">Failed to load: ${resp.status}</p>`;
      return;
    }
    const md = await resp.text();

    if (!window.marked) {
      await import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js').then(m => {
        window.marked = m.marked;
      });
    }

    const html = window.marked(md);
    outputEl.innerHTML = `
      <span class="md-back" id="md-back">← back</span>
      <div class="md-view">${html}</div>
    `;
    document.getElementById('md-back').addEventListener('click', () => refresh());
  } catch (err) {
    outputEl.innerHTML = `<p style="color:#f66">Error: ${err.message}</p>`;
  }
});

// --- Clear search / home ---
function goHome() {
  document.getElementById('search').value = '';
  if (params.has('search')) {
    const url = new URL(location);
    url.searchParams.delete('search');
    history.replaceState(null, '', url);
  }
  refresh();
}
document.getElementById('clear-search').addEventListener('click', goHome);
document.getElementById('home-link').addEventListener('click', goHome);

// --- Wire up search ---
document.getElementById('search').addEventListener('input', refresh);

// --- Pre-fill search from URL parameter ?search=... ---
const searchParam = params.get('search');
if (searchParam) {
  document.getElementById('search').value = searchParam;
}

// --- Init ---
refresh();
