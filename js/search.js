// Search parsing, clause building, and tag cloud

// Parses search input into a mode + terms:
//   empty       → mode: 'default' (show non-tagged entries only)
//   "#"         → mode: 'tagcloud' (show tag cloud with counts)
//   "#git"      → mode: 'search', terms parsed normally
//   "chmod"     → mode: 'search', terms parsed normally
//   "git #"     → mode: 'search', lone "#" stripped, treated as "git"
export function parseSearch(query) {
  const raw = query.trim();

  if (!raw) return { mode: 'default', include: [], exclude: [] };
  if (raw === '#') return { mode: 'tagcloud', include: [], exclude: [] };

  // Strip single-character tokens (too broad to be useful)
  const terms = raw.split(/\s+/).filter(t => t && t.length > 1);

  if (terms.length === 0) return { mode: 'default', include: [], exclude: [] };

  const include = [];
  const exclude = [];
  for (const t of terms) {
    if (t.startsWith('-') && t.length > 1) {
      exclude.push(t.substring(1));
    } else {
      include.push(t);
    }
  }
  return { mode: 'search', include, exclude };
}

export function buildSearchClauses({ include, exclude }, startIdx) {
  const clauses = [];
  const params = [];
  let i = startIdx;
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

export async function showTagCloud(db, begin, end, outputEl, totalsEl, searchEl) {
  const result = await db.query(`
    SELECT feed_content
    FROM feed
    WHERE feed_date BETWEEN $1 AND $2;
  `, [begin, end]);

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

  // Click a tag to search for it
  outputEl.querySelectorAll('.tag-link').forEach(el => {
    el.addEventListener('click', () => {
      searchEl.value = el.dataset.tag;
      searchEl.dispatchEvent(new Event('input'));
    });
  });
}
