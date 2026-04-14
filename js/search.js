// Search parsing, clause building, and tag cloud

// Parses search input into mode + terms + date filters:
//   empty       → mode: 'default' (show non-tagged entries only)
//   "#"         → mode: 'tagcloud' (show tag cloud with counts)
//   "#git"      → mode: 'search', terms parsed normally
//   "chmod"     → mode: 'search', terms parsed normally
//   "git #"     → mode: 'search', lone "#" stripped
//   "after:2026-04-01"           → date filter
//   "after:2026-04-01 before:2026-04-14 #git"  → date range + tag search
export function parseSearch(query) {
  const raw = query.trim();

  if (!raw) return { mode: 'default', include: [], exclude: [], after: null, before: null };
  if (raw === '#') return { mode: 'tagcloud', include: [], exclude: [], after: null, before: null };

  // Strip single-character tokens
  const tokens = raw.split(/\s+/).filter(t => t && t.length > 1);

  if (tokens.length === 0) return { mode: 'default', include: [], exclude: [], after: null, before: null };

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

  // Text filters
  for (const term of include) {
    clauses.push(`feed_content ILIKE $${i}`);
    params.push(`%${term}%`);
    i++;
  }
  for (const term of exclude) {
    clauses.push(`feed_content NOT ILIKE $${i}`);
    params.push(`%${term}%`);
    i++;
  }

  return {
    where: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params,
  };
}

export async function showTagCloud(db, outputEl, totalsEl, searchEl, after, before) {
  // Build optional date filter for tag cloud
  let dateWhere = '';
  const dateParams = [];
  if (after) { dateWhere += ' AND feed_date >= $1::date'; dateParams.push(after); }
  if (before) {
    dateWhere += ` AND feed_date <= $${dateParams.length + 1}::date`;
    dateParams.push(before);
  }

  const result = await db.query(`
    SELECT feed_content
    FROM feed
    WHERE 1=1 ${dateWhere};
  `, dateParams);

  const tagCounts = {};
  for (const row of result.rows) {
    const tags = row.feed_content.match(/#\w+/g);
    if (tags) {
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        tagCounts[lower] = (tagCounts[lower] || 0) + 1;
      }
    }
  }

  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  totalsEl.style.display = 'flex';
  totalsEl.innerHTML = `
    <div class="item"><span class="label">tags:</span><span class="value">${sorted.length}</span></div>
  `;

  if (sorted.length === 0) {
    outputEl.innerHTML = '<p style="color:#666">No hashtags found.</p>';
    return;
  }

  outputEl.innerHTML = '<p style="line-height:2">' +
    sorted.map(([tag, count]) =>
      `<span style="color:#0f0;cursor:pointer" class="tag-link" data-tag="${tag}">${tag}</span> <span style="color:#666">(${count})</span>`
    ).join('&nbsp;&nbsp; ') +
    '</p>';

  outputEl.querySelectorAll('.tag-link').forEach(el => {
    el.addEventListener('click', () => {
      searchEl.value = el.dataset.tag;
      searchEl.dispatchEvent(new Event('input'));
    });
  });
}
