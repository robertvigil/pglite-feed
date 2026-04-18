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
      document.getElementById('output').textContent = localModified ? 'Refreshing content...' : 'Loading content...';
      const resp = await fetch('content.json');
      const raw = await resp.json();

      // Support both formats: flat array (old) or {config, entries} object (new)
      const entries = Array.isArray(raw) ? raw : (raw.entries || []);
      const jsonConfig = Array.isArray(raw) ? {} : (raw.config || {});

      await db.exec('DELETE FROM feed;');
      for (const row of entries) {
        await db.query(
          'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
          [row.feed_date, row.feed_content]
        );
      }

      // Apply config from JSON
      if (jsonConfig.site_title) {
        await db.query(
          "INSERT INTO config (key, value) VALUES ('site_title', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
          [jsonConfig.site_title]
        );
      }

      await db.query(
        "INSERT INTO config (key, value) VALUES ('content_loaded', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [serverModified]
      );
      await loadTitle();
      await loadTheme();
      showLastUpdated();
    }
  } else {
    const count = await db.query('SELECT COUNT(*) AS n FROM feed;');
    if (count.rows[0].n === 0n || count.rows[0].n === 0) {
      document.getElementById('output').textContent = 'Loading...';
      const resp = await fetch('feed.json');
      if (resp.ok) {
        const raw = await resp.json();
        const entries = Array.isArray(raw) ? raw : (raw.entries || []);
        const jsonConfig = Array.isArray(raw) ? {} : (raw.config || {});
        for (const row of entries) {
          await db.query(
            'INSERT INTO feed (feed_date, feed_content) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
            [row.feed_date, row.feed_content]
          );
        }
        if (jsonConfig.site_title) {
          await db.query(
            "INSERT INTO config (key, value) VALUES ('site_title', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
            [jsonConfig.site_title]
          );
          await loadTitle();
        }
      }
    }
  }
} catch (e) {
  // fetch failed — use whatever's in the DB
}

// --- Theme from config ---
const VALID_THEMES = ['green', 'amber', 'white'];
async function loadTheme() {
  const result = await db.query("SELECT value FROM config WHERE key = 'theme'");
  const theme = result.rows[0]?.value || 'green';
  document.documentElement.setAttribute('data-theme', theme);
}

// --- Site title from config ---
async function loadTitle() {
  const result = await db.query("SELECT value FROM config WHERE key = 'site_title'");
  const title = result.rows[0]?.value || 'feed';
  document.getElementById('home-link').textContent = `[${title}]`;
}

// --- Search bar commands (! prefix, admin only) ---
async function handleCommand(input) {
  const raw = input.trim();
  if (!raw.startsWith('!')) return false;
  if (!isAdmin) return false;

  const parts = raw.substring(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === 'title') {
    const newTitle = parts.slice(1).join(' ');
    if (newTitle) {
      await db.query(
        "INSERT INTO config (key, value) VALUES ('site_title', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [newTitle]
      );
    } else {
      await db.query("DELETE FROM config WHERE key = 'site_title';");
    }
    await loadTitle();
    document.getElementById('search').value = '';
    return true;
  }

  if (cmd === 'theme') {
    const theme = parts[1]?.toLowerCase();
    if (theme && VALID_THEMES.includes(theme)) {
      await db.query(
        "INSERT INTO config (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [theme]
      );
    } else {
      await db.query("DELETE FROM config WHERE key = 'theme';");
    }
    await loadTheme();
    document.getElementById('search').value = '';
    return true;
  }

  return false;
}

// --- Show last updated timestamp ---
async function showLastUpdated() {
  const result = await db.query("SELECT value FROM config WHERE key = 'content_loaded'");
  const el = document.getElementById('last-updated');
  if (result.rows[0]?.value) {
    const d = new Date(result.rows[0].value);
    el.textContent = `updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  }
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
      const [markedMod, headingIdMod] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js'),
        import('https://cdn.jsdelivr.net/npm/marked-gfm-heading-id/+esm'),
      ]);
      window.marked = markedMod.marked;
      window.marked.use(headingIdMod.gfmHeadingId());
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

// --- Wire up search (with command interception) ---
document.getElementById('search').addEventListener('input', async (e) => {
  const val = e.target.value.trim();
  // Don't search while typing a command
  if (val.startsWith('!')) return;
  refresh();
});

// Enter key executes commands
document.getElementById('search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const val = e.target.value.trim();
  if (val.startsWith('!')) {
    e.preventDefault();
    await handleCommand(val);
  }
});

// --- Pre-fill search from URL parameter ?search=... ---
const searchParam = params.get('search');
if (searchParam) {
  document.getElementById('search').value = searchParam;
}

// --- Init ---
loadTheme();
loadTitle();
showLastUpdated();
refresh();
