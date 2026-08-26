// Entries are undated by default. feed_date is NOT NULL and is half of
// UNIQUE(feed_date, feed_content), so a real NULL would mean an ALTER TABLE against
// every existing browser database. Instead a sentinel (1900-01-01) is stored and
// rendered blank at both ends.
//
// The sentinel is deliberately far in the PAST: the sort is
// (feed_date DESC, feed_content ASC), so undated entries sink below dated ones AND
// fall through to the secondary key — meaning a #tag pull of reference notes comes
// back alphabetically by content, which the author controls, rather than by an entry
// date they don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowser } from './harness.mjs';

const crud = readFileSync(new URL('../js/crud.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const SENTINEL = '1900-01-01';

test('both sides agree on the same sentinel value', () => {
  assert.match(crud, /const UNDATED = '1900-01-01'/, 'crud.js defines the sentinel');
  assert.ok(app.includes(`'${SENTINEL}'`), 'app.js renders against the same literal');
});

test('the sentinel is in the past, so undated entries sink rather than pin to the top', () => {
  assert.ok(new Date(SENTINEL) < new Date('2000-01-01'),
    'a future sentinel would pin undated entries above everything, permanently');
  assert.match(app, /ORDER BY feed_date DESC, feed_content ASC/,
    'the secondary sort is what makes undated entries order alphabetically');
});

test('the date field is optional and hidden behind the toggle', () => {
  assert.doesNotMatch(html, /<input type="date" id="new-date"[^>]*\brequired\b/,
    'a required date would block saving an undated entry');
  assert.match(html, /id="new-date-toggle"/, 'the reveal button exists');
  assert.match(html, /<input type="date" id="new-date"[^>]*\bhidden\b/,
    'the field starts hidden — undated is the default');
});

test('a blank date becomes the sentinel on save, in both create and edit', () => {
  const fn = crud.match(/const dateOrSentinel = \(v\) => \(([^;]+)\);/)?.[1];
  assert.ok(fn, 'dateOrSentinel is defined');
  const dateOrSentinel = new Function('v', 'UNDATED', `return (${fn});`).bind(null);
  const call = (v) => dateOrSentinel(v, SENTINEL);
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(call(blank), SENTINEL, `blank input ${JSON.stringify(blank)} → sentinel`);
  }
  assert.equal(call('2026-08-25'), '2026-08-25', 'a real date passes through untouched');

  const uses = crud.match(/dateOrSentinel\(/g) || [];
  assert.ok(uses.length >= 2, 'both the create and the edit save paths route through it');
});

test('a sentinel date renders as an empty cell, not a 1900 date', () => {
  assert.match(app, /const undated = dateStr === '1900-01-01'/);
  assert.match(app, /undated \? '' :/, 'the cell is blanked when undated');
});

test('the edit row offers the toggle only when the entry is undated', () => {
  assert.match(crud, /tr\.dataset\.date === UNDATED/,
    'an already-dated entry should show its date directly, not hide it behind a button');
});

test('revealing the date field does not throw where showPicker is unsupported', () => {
  installBrowser();
  const src = crud.match(/function revealDateField[\s\S]*?\n  \}/)[0];
  const revealDateField = new Function(`${src}; return revealDateField;`)();
  const toggle = { hidden: false };
  const input = { hidden: true, focus() {}, showPicker() { throw new Error('not supported'); } };
  revealDateField(toggle, input);           // Firefox / Safari path
  assert.equal(toggle.hidden, true, 'the button hides');
  assert.equal(input.hidden, false, 'the field shows even though showPicker threw');
});
