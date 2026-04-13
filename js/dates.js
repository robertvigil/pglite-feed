// Date range helpers

export function iso(d) { return d.toISOString().split('T')[0]; }

export function getCurrentWeek() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { begin: iso(monday), end: iso(sunday) };
}

export function getCurrentMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { begin: iso(first), end: iso(last) };
}

export function getCurrentYear() {
  const now = new Date();
  return { begin: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
}

export function getAllTime() {
  return { begin: '1970-01-01', end: '2099-12-31' };
}
