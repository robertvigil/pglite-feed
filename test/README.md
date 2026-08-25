# test/

A headless suite for `js/cloud.js` — the `!cloud` / `!local` sync layer.

**These exist for whoever (or whatever) is editing this code, not for the repo
owner.** There is deliberately no Node install on the development machine, no
package.json, no dependencies, and no CI. The suite is a way to verify sync
behavior without a browser round-trip to the production server.

## Running

There is no JS runtime on the dev machine by design. Fetch one into a temp dir:

```bash
cd /tmp && curl -sL -o node.tar.xz \
  https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz && tar xf node.tar.xz
```

Then, from the `pglite-feed` root:

```bash
/tmp/node-v22.14.0-linux-x64/bin/node --test 'test/*.test.mjs'
```

Note the glob — `--test test/` does not work. The same binary gives you
`node --check file.mjs` for a real syntax check.

## How it works

`js/cloud.js` imports nothing and receives every app dependency by injection
(`buildExportData`, `importJsonData`, `refresh`, `syncToFile`). That makes it
runnable outside a browser once `harness.mjs` supplies fakes for `localStorage`,
IndexedDB, the DOM, the File System Access API, and `fetch` (a fake GitHub Contents API backed by an in-memory repo).

The fake directory handle is a working in-memory filesystem, so `!local push`,
`pull`, `list`, `delete` and permission expiry all genuinely execute.

## Files

| File | Covers |
|---|---|
| `cloud-github.test.mjs` | The `!cloud` transport against a fake GitHub Contents API: push/pull/list/delete, SHA handling on replace, cross-app refusal, legacy encrypted files |
| `sync-mode.test.mjs` | `!cloud` / `!local` behavior: mode exclusivity, the indicator, push/pull/list/delete, the no-FSA and no-folder fallbacks |
| `crud-smoke.test.mjs` | `setupCrud` actually initializes in both apps and returns its API; `importJsonData` rolls back a failed import |
| `hashtag-parity.test.mjs` | The default-view filter in `app.js` and the tag-cloud extractor in `search.js` classify hashtags identically |
| `dom-contract.test.mjs` | Every `getElementById` target exists in `index.html`, no orphan ids, and the UI deleted in phases 3–4 stays deleted |
| `drift.test.mjs` | `js/cloud.js` is byte-identical to the pglite-activities copy |
| `harness.mjs` | Fake `localStorage`, IndexedDB, DOM and File System Access API |

## What is NOT covered

PGlite, real IndexedDB semantics, whether FSA permission actually lapses across a
browser restart, and anything visual.

In practice that leaves **one** manual step after a deploy: load the page and see
that it renders. Everything else is reachable from here — including the class of bug
that produced a page stuck on "Loading...", which `crud-smoke.test.mjs` now catches
by calling `setupCrud` rather than merely parsing it.

Booting the whole app headlessly is possible (PGlite runs in Node) but both apps
import it from a jsdelivr URL, so it would need an import shim and a real dependency.
Judged not worth it — the cheap checks above cover the same failures.

## Conventions

- **Fix a bug, add a test in the same change.** Several tests here exist because
  the bug shipped once; the test comment is the durable record of why the code is
  shaped the way it is.
- `drift.test.mjs` asserts `js/cloud.js` is byte-identical to the pglite-activities
  copy, and skips when that repo is not checked out alongside. It is the only
  drift enforcement in either repo — there is no deploy hook and no git hook, by
  choice.
