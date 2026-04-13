// Content rendering — escape HTML, markdown links, bare URL auto-linking

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderContent(text) {
  let out = escapeHtml(text);
  // Markdown-style links: [text](url) — supports absolute and relative URLs
  // External links open in new tab, relative links open in same tab
  out = out.replace(
    /\[([^\]]+)\]\(([^\s)]+)\)/g,
    (_, text, url) => url.startsWith('http')
      ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>`
      : `<a href="${url}">${text}</a>`
  );
  // Bare URLs — only if not already inside an href="..."
  out = out.replace(
    /(?<!href=")(https?:\/\/[^\s<]+)(?![^<]*<\/a>)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
  return out;
}
