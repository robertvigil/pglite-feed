# About pglite-feed

A browser-only microblog that runs a real PostgreSQL database entirely in your browser via [PGlite](https://pglite.dev/).

![Mila the pug](public/mila.png)

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Search tips](#search-tips)
- [Content formatting](#content-formatting)
- [Math (KaTeX)](#math-katex)
- [Diagrams (Mermaid)](#diagrams-mermaid)
- [Task list example](#task-list-example)
- [Code example](#code-example)
- [Tech stack](#tech-stack)
- [Links](#links)

## How it works

- No backend, no server-side database
- Data is stored in your browser's IndexedDB
- Each visitor gets their own private database
- Nothing is sent to any server

## Quick start

1. The default view shows non-tagged entries
2. Type `#` in the search bar to browse all hashtag categories
3. Create, edit, and delete entries using the toolbar buttons (✚ ✎ ✕)
4. Use the down-arrow to save a JSON backup, up-arrow to load one

## Search tips

| Search | What it does |
|---|---|
| `ssh tunnel` | Finds entries containing both words |
| `-docker` | Excludes entries with "docker" |
| `#git` | Finds entries tagged with #git |
| `#` | Shows tag cloud with counts |

## Content formatting

You can use two types of links in entries:

- `[display text](https://example.com)` — markdown-style, custom link text
- `https://example.com` — bare URLs, auto-linked

> External links open in a new tab. Relative links open in the same tab.

## Math (KaTeX)

Inline math: $E = mc^2$, or $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$

Block equations:

$$f(x) = \frac{1}{\sigma\sqrt{2\pi}} e^{-\frac{1}{2}\left(\frac{x-\mu}{\sigma}\right)^2}$$

Matrix multiplication:

$$\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix} \begin{bmatrix} 5 \\ 6 \end{bmatrix} = \begin{bmatrix} 17 \\ 39 \end{bmatrix}$$

## Diagrams (Mermaid)

Diagrams render from fenced code blocks — the library only loads when a diagram is present on the page.

```mermaid
graph LR
    A[Browser] --> B[PGlite]
    B --> C[(IndexedDB)]
    C --> D[feed table]
    C --> E[config table]
```

```mermaid
graph TD
    F[Page Load] --> G{content.json?}
    G -->|exists| H[Read-Only]
    G -->|404| I[Read-Write]
    I --> J[feed.json seeds empty DB]
    H --> K[DB refreshes from content.json]
```

## Task list example

- [x] PGlite database working
- [x] Search with AND/exclude
- [x] Tag cloud
- [x] Markdown viewer
- [ ] World domination

## Code example

```sql
CREATE TABLE feed (
  id SERIAL PRIMARY KEY,
  feed_date DATE NOT NULL,
  feed_content TEXT NOT NULL,
  UNIQUE (feed_date, feed_content)
);
```

## Tech stack

| Component | What |
|---|---|
| **PGlite** | PostgreSQL compiled to WebAssembly |
| **IndexedDB** | Browser-native persistent storage |
| **marked.js** | Markdown rendering |
| **KaTeX** | Math/equation typesetting |
| **Mermaid** | Diagrams from text (lazy-loaded) |
| **Vanilla JS** | No frameworks, no build tools |

---

~~This text is struck through~~ — just showing off strikethrough support.

**Bold text**, *italic text*, and `inline code` all work as expected.

## Links

- [GitHub repo](https://github.com/robertvigil/pglite-feed)
- [PGlite documentation](https://pglite.dev/)
- [Live demo](https://robertvigil.com/feed/)
