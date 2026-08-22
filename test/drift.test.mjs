// js/cloud.js is shared verbatim with pglite-activities and is kept in sync by
// hand — there is no build step and no deploy hook to enforce it. This makes the
// check free: it runs whenever both repos are checked out side by side, and skips
// when they aren't (a fresh clone of one app alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const SIBLING = new URL('../../pglite-activities/js/cloud.js', import.meta.url);

test('cloud.js is byte-identical to the copy in pglite-activities', { skip: !existsSync(SIBLING) && 'sibling app not checked out' }, () => {
  const mine = readFileSync(new URL('../js/cloud.js', import.meta.url));
  const theirs = readFileSync(SIBLING);
  assert.equal(theirs.equals(mine), true,
    'cloud.js has drifted. Copy the corrected file over the other app before committing.');
});
