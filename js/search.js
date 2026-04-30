// Search parsing, clause building, and tag cloud

// Parses search input into mode + terms + date filters:
//   empty                         → mode: 'default' (show non-tagged entries only)
//   "#"                           → mode: 'tagcloud' (show full tag cloud with counts)
//   "# git"                       → mode: 'tagcloud' filtered by "git"
//   "# git -intro after:..."      → mode: 'tagcloud' filtered by include/exclude/dates
//   "#git"                        → mode: 'search', terms parsed normally
//   "chmod"                       → mode: 'search', terms parsed normally
//   "git #"                       → mode: 'search', lone "#" stripped (only leading # is a mode flag)
//   "after:2026-04-01"            → date filter
//   "after:2026-04-01 before:... #git"  → date range + tag search
export function parseSearch(query) {
  const raw = query.trim();

  if (!raw) return { mode: 'default', include: [], exclude: [], after: null, before: null };

  // Detect leading "#" as a mode flag BEFORE the single-char filter strips it.
  const rawTokens = raw.split(/\s+/).filter(Boolean);
  const isTagCloud = rawTokens[0] === '#';
  const restRaw = isTagCloud ? rawTokens.slice(1) : rawTokens;

  // Strip single-character tokens (noise like lone "a", "i", trailing "#")
  const tokens = restRaw.filter(t => t.length > 1);

  const include = [];
  const exclude = [];
  let after = null;
  let before = null;

  for (const t of tokens) {
    if (t.startsWith('after:') && t.length > 6) {
      after = t.substring(6);
    } else if (t.startsWith('before:') && t.length > 7) {
      before = t.substring(7);
    } else if (t.startsWith('-') && t.length > 1) {
      exclude.push(t.substring(1));
    } else {
      include.push(t);
    }
  }

  if (isTagCloud) {
    return { mode: 'tagcloud', include, exclude, after, before };
  }

  if (tokens.length === 0) return { mode: 'default', include: [], exclude: [], after: null, before: null };

  // If only date terms and no text terms, still show all entries (not just non-tagged)
  const hasTextTerms = include.length > 0 || exclude.length > 0;
  const hasDateTerms = after !== null || before !== null;
  const mode = (hasTextTerms || hasDateTerms) ? 'search' : 'default';

  return { mode, include, exclude, after, before };
}

export function buildSearchClauses({ include, exclude, after, before }, startIdx) {
  const clauses = [];
  const params = [];
  let i = startIdx;

  // Date filters
  if (after) {
    clauses.push(`feed_date >= $${i}::date`);
    params.push(after);
    i++;
  }
  if (before) {
    clauses.push(`feed_date <= $${i}::date`);
    params.push(before);
    i++;
  }

  // Text filters. A "term" can be pipe-separated alternatives — "#a|#b" means
  // (matches a OR matches b). Excludes apply NOT to the whole OR group, so
  // "-#a|#b" excludes entries matching either.
  function termSql(term) {
    const parts = term.split('|').filter(Boolean);
    if (parts.length === 0) return null;
    const subs = parts.map(part => {
      params.push(`%${part}%`);
      return `feed_content ILIKE $${i++}`;
    });
    return parts.length > 1 ? `(${subs.join(' OR ')})` : subs[0];
  }

  for (const term of include) {
    const sql = termSql(term);
    if (sql) clauses.push(sql);
  }
  for (const term of exclude) {
    const sql = termSql(term);
    if (sql) clauses.push(`NOT ${sql}`);
  }

  return {
    where: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params,
  };
}

export async function showTagCloud(db, outputEl, totalsEl, searchEl, parsed) {
  // Scope the tag cloud to entries matching the same filters as a regular search:
  // include / exclude / after / before. Reuses buildSearchClauses for symmetry.
  const search = buildSearchClauses(parsed, 1);

  const [result, grandResult] = await Promise.all([
    db.query(`
      SELECT feed_content
      FROM feed
      WHERE 1=1 ${search.where};
    `, search.params),
    db.query('SELECT COUNT(*) AS n FROM feed;'),
  ]);

  const matched = result.rows.length;
  const grandTotal = Number(grandResult.rows[0].n);

  const tagCounts = {};
  for (const row of result.rows) {
    const tags = row.feed_content.match(/#\w+/g);
    if (tags) {
      // Dedupe per-row so the count reflects "entries tagged with X",
      // not "total occurrences of #X" — a row with "#demo #demo" counts once.
      const unique = new Set(tags.map(t => t.toLowerCase()));
      for (const tag of unique) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  // Match regular-search totals layout: "#: matched / total" + "tags: N"
  totalsEl.style.display = 'flex';
  totalsEl.innerHTML = `
    <div class="item"><span class="label">#:</span><span class="value">${matched} / ${grandTotal}</span></div>
    <div class="item"><span class="label">tags:</span><span class="value">${sorted.length}</span></div>
  `;

  if (sorted.length === 0) {
    outputEl.innerHTML = '<p style="color:#666">No hashtags found.</p>';
    return;
  }

  // Each tag rendered as "#tag (count pct%)". Floor-protect: anything that
  // would round to 0% renders as "<1%" so "(1 0%)" doesn't look like a bug.
  function pctLabel(count) {
    if (matched === 0) return '0%';
    const raw = (count / matched) * 100;
    return raw >= 1 ? `${Math.round(raw)}%` : '<1%';
  }

  outputEl.innerHTML = '<p style="line-height:2">' +
    sorted.map(([tag, count]) =>
      `<span style="color:var(--accent);cursor:pointer" class="tag-link" data-tag="${tag}">${tag}</span> <span style="color:#666">(${count} <span class="tag-pct">${pctLabel(count)}</span>)</span>`
    ).join('&nbsp;&nbsp; ') +
    '</p>';

  outputEl.querySelectorAll('.tag-link').forEach(el => {
    el.addEventListener('click', () => {
      searchEl.value = el.dataset.tag;
      searchEl.dispatchEvent(new Event('input'));
    });
  });
}
