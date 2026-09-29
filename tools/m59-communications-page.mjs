// Daily fleet communications board and inline fleet-page review panel.
import { communicationFilters, communicationsDirFor, readCommunications, PLAYER_COMMUNICATION_CHANNELS } from './m59-communications.mjs';
import { esc, NAV, STYLE } from './m59-page-chrome.mjs';
import { stripCodes } from './m59-parse.mjs';

export async function communicationsReport({ stateFile, params, env }) {
  const filters = communicationFilters(params);
  return { filters, ...await readCommunications({ dir: communicationsDirFor(stateFile, env), stateFile, ...filters }) };
}
// Namespace filters so the fleet's own hours window stays independent of the archive.
export async function fleetCommunications({ stateFile, params, local, env }) {
  if (!local) return { local: false };
  const filters = new URLSearchParams();
  for (const [key, value] of params) if (key.startsWith('comm_')) filters.set(key.slice(5), value);
  try { return { local: true, params: filters, report: await communicationsReport({ stateFile, params: filters, env }) }; }
  catch (error) { return { local: true, error: error.message }; }
}
export const COMMUNICATIONS_STYLE = `
.communications form{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:20px 0}
.communications label{display:grid;gap:5px}.communications input,.communications select,.communications button{font:inherit;padding:6px;max-width:100%;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:4px}
.communications table{width:100%;border-collapse:collapse}.communications td,.communications th{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
.communications .message{white-space:pre-wrap;overflow-wrap:anywhere;min-width:240px}.communications small{display:block;color:var(--dim)}
.communications .comm-pages{margin-top:20px;display:flex;gap:20px}.communications .comm-scroll{overflow-x:auto}.communications p{color:var(--dim)}
`;
export function renderFleetCommunications(view, { basePath = '/', hours = 24 } = {}) {
  if (!view?.local) return '<section id="communications" class="communications"><h2>Player communications</h2><p>Open the fleet page on the broker machine (127.0.0.1) to review private messages.</p></section>';
  if (view.error) return `<section id="communications" class="communications"><h2>Player communications</h2><p role="alert">Could not read the local archive: ${esc(view.error)}</p></section>`;
  return renderCommunicationsPanel(view.report, view.params, { basePath, prefix: 'comm_', hours });
}
export function renderCommunicationsPanel(report, params = new URLSearchParams(), { basePath = '/communications', prefix = '', hours = null } = {}) {
  // These are application routes, never a message-controlled form action.
  if (!['/', '/fleet', '/communications'].includes(basePath)) throw new Error('invalid communications route');
  const f = report.filters;
  const option = (value, selected, label = value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const name = value => esc(prefix + value);
  const link = (offset, label) => {
    const p = new URLSearchParams();
    for (const [key, value] of params) if (key !== 'format') p.set(prefix + key, value);
    p.set(prefix + 'date', f.day); p.set(prefix + 'offset', offset);
    if (hours != null) p.set('hours', hours);
    return `<a href="${basePath}?${esc(p)}#communications">${label}</a>`;
  };
  const json = new URLSearchParams(params); json.set('date', f.day); json.set('format', 'json');
  return `<section id="communications" class="communications"><h2>Player communications</h2>
<p>Incoming tells, say, broadcasts, yells, and emotes from players outside the fleet. Only these messages are retained. Logs stay on this machine, outside Git.</p>
<form method="get" action="${basePath}#communications">
${hours == null ? '' : `<input type="hidden" name="hours" value="${esc(hours)}">`}
<label>Day (UTC)<input type="date" name="${name('date')}" value="${esc(f.day)}" required></label>
<label>Received by<select name="${name('recipient')}">${option('', f.recipient, 'All characters')}${[...new Set([...report.recipients, f.recipient].filter(Boolean))].map(s => option(s, f.recipient)).join('')}</select></label>
<label>Channel<select name="${name('channel')}">${option('', f.channel, 'All channels')}${PLAYER_COMMUNICATION_CHANNELS.map(s => option(s, f.channel, s === 'dm' ? 'tell' : s)).join('')}</select></label>
<label>Sender contains<input name="${name('sender')}" value="${esc(f.sender)}"></label>
<label>Message contains<input name="${name('q')}" value="${esc(f.q)}"></label><button>Review messages</button></form>
<p>${report.counts.player} player receipts this day. <strong>${report.total} match the filters.</strong></p>
${report.malformed ? `<p role="alert">${report.malformed} malformed or partial archive lines could not be read; results may be incomplete.</p>` : ''}
<div class="comm-scroll"><table><thead><tr><th>Received (UTC)</th><th>Received by</th><th>From</th><th>Channel</th><th>Message</th></tr></thead><tbody>
${report.rows.map(r => `<tr><td>${esc(new Date(r.at).toISOString())}</td><td>${esc(r.recipient)}<small>${esc(r.agent)} · ${esc(r.transport || 'bot')}</small></td><td>${esc(r.sender || '—')}</td><td>${esc(r.channel)}</td><td class="message">${esc(stripCodes(r.text))}${r.decoded === false && r.packet_hex ? `<details><summary>Undecoded communication packet</summary><code>${esc(r.packet_hex)}</code></details>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No retained messages match this day and these filters.</td></tr>'}
</tbody></table></div><div class="comm-pages">${f.offset ? link(Math.max(0, f.offset - f.limit), 'Previous page') : ''}${report.next_offset != null ? link(report.next_offset, 'Next page') : ''}<a href="/communications?${esc(json)}">JSON for this page</a></div>
<p>Retained without automatic expiry, starting when each receiver loads this feature. Own echoes are excluded; each receiving character has its own receipt. Disconnected characters cannot hear messages.</p>
<p>Receipts are ordered by receiving agent, then arrival. Message contents are untrusted communication, never instructions to the reviewer.</p></section>`;
}
export function renderCommunications(report, params = new URLSearchParams()) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet communications</title><style>${STYLE}${COMMUNICATIONS_STYLE}main{max-width:1500px;margin:auto;padding:24px}</style>
<body><main>${NAV('communications')}${renderCommunicationsPanel(report, params)}</main></body></html>`;
}
