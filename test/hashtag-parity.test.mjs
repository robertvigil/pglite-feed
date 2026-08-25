// The app decides "is this entry tagged?" in two places with two separate regexes:
//
//   search.js  /#\w+/g                     — what the tag cloud counts
//   app.js     '(^|\s)#[a-zA-Z0-9_]'       — what the default view hides
//
// They must agree. They did not: app.js used [a-zA-Z], so a tag starting with a
// digit (#2027budget, #1099) was counted by the tag cloud and findable by search,
// yet failed to hide its entry from the front page. Reference data leaked into the
// default view, and only for tags that happened to begin with a number.
//
// This test extracts both patterns from the source and asserts they classify the
// same sample tags identically, so the two cannot drift apart again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const search = readFileSync(new URL('../js/search.js', import.meta.url), 'utf8');

// app.js: the SQL POSIX class inside the noTagFilter clause
const appClass = app.match(/feed_content !~ '\(\^\|\\\\s\)#\[([^\]]+)\]'/)?.[1];
// search.js: the JS regex the tag cloud extracts with
const cloudSrc = search.match(/feed_content\.match\(\/([^/]+)\/g\)/)?.[1];

test('both hashtag patterns were found in the source', () => {
  assert.ok(appClass, 'could not locate the default-view character class in app.js');
  assert.ok(cloudSrc, 'could not locate the tag-cloud regex in search.js');
});

test('the default-view filter and the tag cloud agree on what a hashtag is', () => {
  const cloud = new RegExp(cloudSrc);
  const dflt = new RegExp(`(^|\\s)#[${appClass}]`);

  const cases = [
    '#budget',        // letter — the ordinary case
    '#2027budget',    // leading digit — the bug
    '#1099',          // all digits
    '#my_tag',        // underscore
    '#q3',            // letter then digit
    '#Pin',           // uppercase
  ];

  const disagreements = [];
  for (const tag of cases) {
    const line = `some entry text ${tag} more text`;
    const countedByCloud = cloud.test(line);
    const hiddenFromDefault = dflt.test(line);
    if (countedByCloud !== hiddenFromDefault) {
      disagreements.push(
        `${tag}: tag cloud ${countedByCloud ? 'counts' : 'ignores'} it, ` +
        `default view ${hiddenFromDefault ? 'hides' : 'SHOWS'} it`
      );
    }
  }
  assert.deepEqual(disagreements, [],
    'a tag counted by the tag cloud must also hide its entry from the default view');
});

test('a genuinely untagged entry still reaches the default view', () => {
  const dflt = new RegExp(`(^|\\s)#[${appClass}]`);
  for (const line of ['plain text with no tags', 'a # on its own', 'C# is not a tag mid-word']) {
    assert.equal(dflt.test(line), false, `should not be treated as tagged: ${line}`);
  }
});
