// Compatibility routing from the broker port to the read-only dashboard port.
//
// The broker serves /fleet itself, and that page's shared tab bar uses origin-relative
// links. Without this seam, following "Tougher" from http://localhost:8901/fleet asks
// the JSON-RPC server for GET /tougher and receives 405, even though the page is alive
// one port over. Keep the list here so the HTTP server and its offline test share it.

const EXACT = new Set([
  '/budget', '/deaths', '/deaths/report', '/dum', '/economy', '/harness',
  '/players', '/skills', '/stats', '/tougher', '/travel',
]);

export function isDashboardOnlyPath(pathname) {
  return EXACT.has(pathname) || pathname.startsWith('/hero/');
}

export function dashboardRedirectUrl(reqUrl, localAddress, dashboardPort) {
  const parsed = new URL(reqUrl, 'http://dashboard.invalid');
  if (!isDashboardOnlyPath(parsed.pathname) || !Number.isInteger(dashboardPort)) return null;

  // Use the address the request actually reached, not Host (which is caller-controlled).
  // Windows reports IPv4 sockets either plainly or as IPv4-mapped IPv6.
  let address = String(localAddress || '127.0.0.1');
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${dashboardPort}${parsed.pathname}${parsed.search}`;
}
