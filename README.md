# pglite-feed

A browser-only microblog/feed powered by [PGlite](https://pglite.dev/) (PostgreSQL compiled to WebAssembly). No backend, no accounts. Data lives in your browser's IndexedDB.

<img src="screenshots/mobile.jpg" alt="Mobile screenshot" width="300">

**Live demo:** [robertvigil.com/feed](https://robertvigil.com/public/feed)

## How it works

A static web app loaded in your browser. Entries live in the browser's IndexedDB via PGlite. A `feed.json` file auto-loads as sample content on first visit.

## Modes

The app automatically detects its mode on page load — no URL parameters or toggles:

```
Page load
  ├── content.json exists on server → READ-ONLY
  │   └── Public-facing site, content managed externally
  │
  └── content.json not found → READ-WRITE
      └── Full CRUD, import/export, commands — all controls always visible
```

- **Read-write** — the default when you clone and run. All editing controls are always visible. `feed.json` seeds the DB on first visit.
- **Read-only** — activated by deploying a `content.json` file alongside `index.html`. The app refreshes from `content.json` automatically. No editing controls, no `!` commands. Used for public-facing sites whose content is maintained externally.

## Features

- **Date filtering** — use `after:2026-04-01` and `before:2026-04-14` in the search bar for date ranges.
- **Search** — multi-word AND with exclusion: `"pglite feed"` matches both terms, `"-exclude"` filters out a term.
- **Hashtag categories** — use `#tags` in content for categories (e.g., `#links`, `#notes`), then search for `#tag` to filter.
- **Smart default view** — empty search shows entries without hashtags, plus any entry tagged `#pin`. Tagged reference data stays hidden until you search for it. Use `#pin` to force important tagged entries onto the front page.
- **Pin to front page** — tag any entry with `#pin` and it appears on the default view regardless of other tags (e.g., `server setup guide #sysadmin #pin`).
- **Tag cloud** — type `#` in the search bar to see all hashtags with counts. Click any tag to search for it.
- **Search via URL** — `?search=%23git` pre-fills the search bar. Enables clickable links in content that trigger searches.
- **Clear button (×)** — clears the search and returns to the default view. Acts as a "home" button.
- **Inline CRUD** — create (✚), edit (✎), and delete (✕) entries directly. Always visible in read-write mode.
- **Configurable title** — type `!title My Site` in the search bar to customize the `[feed]` header. Included in JSON exports.
- **Theme support** — type `!theme amber`, `!theme white`, or `!theme green` in the search bar to switch the accent color. Persists across sessions and is included in JSON exports.
- **Markdown-style links** — `[display text](url)` in content becomes a clickable link. Bare URLs are also auto-linked.
- **Persistence** — on Chromium browsers (Chrome/Edge/Brave/Arc) over HTTPS or `localhost`, two icons attach the feed to a real JSON file on disk: `🔗` opens an existing file (safe — read-then-decide), `📝` creates a new file or overwrites a chosen one. After attach, every edit live-syncs. On Firefox/Safari, falls back to traditional `↓ Save` / `↑ Open` buttons. Capability-gated — the UI shows one flow or the other, never both.
- **Auto-load on empty DB** — first visit loads `feed.json` (sample/help content). After that, you manage everything yourself.
- **Keyboard-friendly** — Esc cancels create/edit, Ctrl+Enter or Shift+Enter submits forms.
- **Mobile responsive** — compact cards on small screens, tables on desktop.
- **Retro terminal aesthetic** — green-on-black by default, with amber and white alternatives.

## Search behavior

| Search input | Behavior |
|---|---|
| *(empty)* | Show entries with NO hashtags, plus any tagged `#pin` |
| `#` | Show tag cloud with counts |
| `#git` | Normal search — entries containing "#git" |
| `git` | Normal search — entries containing "git" (tagged or not) |
| `git #` | Strip the lone `#`, treat as just `git` |
| `chmod #permissions` | Normal AND search — entries with both |
| `-#git` | Normal exclude — entries NOT containing "#git" |
| `after:2026-04-01` | Entries on or after this date |
| `before:2026-04-14` | Entries on or before this date |
| `after:2026-04-01 before:2026-04-14 #git` | Date range + tag search combined |

### Linkable searches

Content can include clickable links that trigger searches using URL-encoded `?search=` parameters:

```
[files](?search=%23files)                          → searches for #files
[chmod](?search=chmod)                              → searches for chmod
[ssh tunnel](?search=ssh%20-L)                     → searches for ssh -L
[april entries](?search=after%3A2026-04-01)        → searches for after:2026-04-01
[april git](?search=after%3A2026-04-01%20%23git)   → searches for after:2026-04-01 #git
```

These URLs can be shared directly — the recipient loads the app with the search pre-filled.

This lets non-tagged "index" entries link to tagged content without being hidden by the default view filter.

## Schema

```sql
CREATE TABLE feed (
  id SERIAL PRIMARY KEY,
  feed_date DATE NOT NULL,
  feed_content TEXT NOT NULL,
  UNIQUE (feed_date, feed_content)
);
```

- Categories are handled via `#tags` in `feed_content`, searchable with the built-in search
- The `UNIQUE` constraint prevents duplicate entries

## Running it

### Local: serve via any static file server

PGlite loads as an ES module from a CDN, which browsers block over `file://` — so you need a web server:

```bash
python3 -m http.server 8767
```

Then open `http://localhost:8767/`.

### Deploy to a real server

It's two files: `index.html` + `feed.json`. Drop them behind any web server — nginx, Caddy, Vercel, GitHub Pages, etc.

## Persistence

The app picks one of two flows based on browser capability — only one is shown at a time.

### 🔗 / 📝 Attach (Chromium + HTTPS / localhost)

Two icons replace the manual save/load flow:

- **🔗 Open** — pick an *existing* JSON file and attach. The app reads it as-is. If the file has entries, it asks whether to load them into the feed or keep the current feed (file is preserved until the first edit). Safe — never destructive.
- **📝 Create** — pick a path (or filename to overwrite) and attach. The app immediately writes the current feed to disk. The OS shows its own "Replace?" warning if the file already exists; confirming it means you've opted into overwriting.

After attaching, every edit (create / edit / delete) writes the current feed back to disk. No manual save.

- The icon shows the attached filename, e.g. `🔗 feed.json`.
- The handle persists across reloads. On a new browser session, the icon shows in amber with a `⚠` — click it once to re-grant write permission, then sync resumes silently.
- Click the icon again while attached → confirm-detach.

This uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — the picked file is on the *visitor's* machine, not the server's.

> **Why two icons?** Linux's GTK Save dialog truncates the chosen file before the browser hands it back to JavaScript, which makes a unified "open or create" button unsafe. Splitting them into 🔗 (read-then-decide) and 📝 (intentional overwrite) keeps the destructive path opt-in.

### ↓ Save / ↑ Open (Firefox / Safari / non-secure HTTP)

**Save (↓):** exports ALL entries as a JSON file via download. User picks the filename. Default: `feed.json`.

**Open (↑):** replaces ALL existing content with the contents of a JSON file. Prompts with a warning before replacing. Complete replacement, not a merge.

Traditional "Open File" / "Save File" mental model.

### feed.json format

Flat array (simple):
```json
[
  {"feed_date": "2026-04-12", "feed_content": "Hello world"},
  {"feed_date": "2026-04-12", "feed_content": "A note about links #links"}
]
```

Object with config (includes site title and other settings):
```json
{
  "config": {"site_title": "my site", "theme": "amber"},
  "entries": [
    {"feed_date": "2026-04-12", "feed_content": "Hello world"}
  ]
}
```

Both formats are supported on import. Export uses the object format when config exists.

## Content formatting

Two types of links are supported in `feed_content`:

- **Markdown-style:** `[click here](https://example.com)` → "click here" as a clickable link
- **Bare URLs:** `https://example.com` → the URL itself as a clickable link

Both can be mixed in one entry.

## Linked pages (optional)

Entries can link to static pages hosted alongside the feed:

- `/assets/page.html` — accessible by anyone
- `/private/page.html` — behind basic auth (nginx `auth_basic`)

The feed app has no awareness of these pages — they're just URLs in the content. The auth boundary is the web server's job.

## Data privacy

- All data lives in your browser's IndexedDB
- Nothing is sent to any server
- Other visitors get their own empty database (or the sample `feed.json` content on first visit)
- There's no admin login — editing controls are always visible in read-write mode, but each visitor only edits their own browser's data

## Forking

Clone the repo, deploy to your own domain, and you get the full workflow:

1. Create entries, tag them with #hashtags
2. Save to `feed.json` (↓ button), upload to your server
3. To make it public/read-only: rename your export to `content.json` and deploy alongside `index.html`
4. Visitors see your content, refreshed automatically when you update `content.json`

## Built with

- [PGlite](https://pglite.dev/) — PostgreSQL compiled to WebAssembly, by ElectricSQL
- [marked](https://marked.js.org/) — Markdown parser and compiler
- [marked-gfm-heading-id](https://github.com/markedjs/marked-gfm-heading-id) — GitHub-style heading anchors for marked
- [KaTeX](https://katex.org/) — Fast math typesetting (`$E = mc^2$` → rendered equations)
- [marked-katex-extension](https://github.com/UziTech/marked-katex-extension) — KaTeX integration for marked

No frameworks, no build tools, no package manager. All dependencies loaded as ES modules from CDN.

## Browser support

Needs a modern browser with ES modules, IndexedDB, WebAssembly, and `:has()` CSS selector (2023+).

The live-sync `🔗` flow additionally requires the [File System Access API](https://caniuse.com/native-filesystem-api) and a secure context (HTTPS or `localhost`):

- ✅ **Chrome / Edge / Arc / Opera** — works out of the box.
- ⚠️ **Brave** — disabled by default. Enable via `brave://flags/#file-system-access-api` → set to **Enabled** → relaunch.
- ❌ **Firefox / Safari** — not available; falls back to `↓ ↑` (same data, manual save/load).

To verify in DevTools: `'showSaveFilePicker' in window && window.isSecureContext` should return `true`.

## License

MIT — see `LICENSE`.

---

*This project was vibe-coded with [Claude Code](https://claude.ai/claude-code).*
