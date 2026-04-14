// Main app — PGlite init, refresh loop, event wiring

import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';
import { iso, getCurrentWeek, getCurrentMonth, getCurrentYear, getAllTime } from './dates.js';
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
    // content.json exists — check freshness
    const serverModified = headResp.headers.get('Last-Modified') || '';
    const localResult = await db.query("SELECT value FROM config WHERE key = 'content_loaded'");
    const localModified = localResult.rows[0]?.value || '';

    if (serverModified !== localModified) {
      document.getElementById('output').textContent = 'Loading...';
      const resp = await fetch('content.json');
      const data = await resp.json();

      // Full replace — wipe and reload
      await db.exec('DELETE FROM feed;');
      for (const row of data) {
        await db.query(
          'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
          [row.feed_date, row.feed_content]
        );
      }

      // Store timestamp
      await db.query(
        "INSERT INTO config (key, value) VALUES ('content_loaded', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [serverModified]
      );
    }
  } else {
    // No content.json — fall back to feed.json (one-time, no tracking)
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
  const begin = document.getElementById('begin-date').value;
  const end = document.getElementById('end-date').value;
  if (!begin || !end) return;

  localStorage.setItem('feed.begin', begin);
  localStorage.setItem('feed.end', end);

  const searchQuery = document.getElementById('search').value;
  const parsed = parseSearch(searchQuery);

  const outputEl = document.getElementById('output');
  const totalsEl = document.getElementById('totals');
  const searchEl = document.getElementById('search');

  // Tag cloud mode
  if (parsed.mode === 'tagcloud') {
    await showTagCloud(db, begin, end, outputEl, totalsEl, searchEl);
    return;
  }

  // Build WHERE clause
  const search = buildSearchClauses(parsed, 3);

  // Default mode: hide entries with hashtags
  let noTagFilter = '';
  if (parsed.mode === 'default') {
    noTagFilter = " AND feed_content NOT SIMILAR TO '%#[a-zA-Z]%'";
  }

  // Totals
  const totalsResult = await db.query(`
    SELECT COUNT(*) AS n
    FROM feed
    WHERE feed_date BETWEEN $1 AND $2
      ${noTagFilter}
      ${search.where};
  `, [begin, end, ...search.params]);

  const cnt = Number(totalsResult.rows[0].n);

  totalsEl.style.display = 'flex';
  totalsEl.innerHTML = `
    <div class="item"><span class="label">#:</span><span class="value">${cnt}</span></div>
  `;

  if (cnt === 0) {
    outputEl.innerHTML = '<p style="color:#666">No entries in this range.</p>';
    return;
  }

  const result = await db.query(`
    SELECT id, feed_date, feed_content
    FROM feed
    WHERE feed_date BETWEEN $1 AND $2
      ${noTagFilter}
      ${search.where}
    ORDER BY feed_date DESC, feed_content ASC;
  `, [begin, end, ...search.params]);

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

    // Load marked.js from CDN if not already loaded
    if (!window.marked) {
      await import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js').then(m => {
        window.marked = m.marked;
      });
    }

    const html = window.marked(md);
    outputEl.innerHTML = `
      <div class="md-back"></div>
      <div class="md-view">${html}</div>
    `;
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

// --- Wire up controls ---
document.getElementById('begin-date').addEventListener('change', refresh);
document.getElementById('end-date').addEventListener('change', refresh);
document.getElementById('search').addEventListener('input', refresh);

function setRange({ begin, end }) {
  document.getElementById('begin-date').value = begin;
  document.getElementById('end-date').value = end;
  refresh();
}

document.getElementById('this-week').addEventListener('click', () => setRange(getCurrentWeek()));
document.getElementById('this-month').addEventListener('click', () => setRange(getCurrentMonth()));
document.getElementById('this-year').addEventListener('click', () => setRange(getCurrentYear()));
document.getElementById('all-time').addEventListener('click', () => setRange(getAllTime()));

// --- Pre-fill search from URL parameter ?search=... ---
const searchParam = params.get('search');
if (searchParam) {
  document.getElementById('search').value = searchParam;
}

// --- Init: restore saved range or default to all time ---
const savedBegin = localStorage.getItem('feed.begin');
const savedEnd = localStorage.getItem('feed.end');
if (savedBegin && savedEnd) {
  setRange({ begin: savedBegin, end: savedEnd });
} else {
  setRange(getAllTime());
}
