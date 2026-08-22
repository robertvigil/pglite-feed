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
IndexedDB, the DOM, and the File System Access API.

The fake directory handle is a working in-memory filesystem, so `!local push`,
`pull`, `list`, `delete` and permission expiry all genuinely execute.

## What is NOT covered

PGlite, real IndexedDB semantics, whether FSA permission actually lapses across a
browser restart, and anything visual. Those still need a real browser. Keeping
that list short is the point of this directory.

## Conventions

- **Fix a bug, add a test in the same change.** Several tests here exist because
  the bug shipped once; the test comment is the durable record of why the code is
  shaped the way it is.
- `drift.test.mjs` asserts `js/cloud.js` is byte-identical to the pglite-activities
  copy, and skips when that repo is not checked out alongside. It is the only
  drift enforcement in either repo — there is no deploy hook and no git hook, by
  choice.
