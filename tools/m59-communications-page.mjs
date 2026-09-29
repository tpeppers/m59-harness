// Daily fleet communications board: retained receipts with source and recipient filters.
import { communicationFilters, communicationsDirFor, readCommunications, SOURCE_TYPES } from './m59-communications.mjs';
import { esc, NAV, STYLE } from './m59-page-chrome.mjs';
import { stripCodes } from './m59-parse.mjs';

export async function communicationsReport({ stateFile, params, env }) {
  const filters = communicationFilters(params);
  return { filters, ...await readCommunications({ dir: communicationsDirFor(stateFile, env), ...filters }) };
}
export function renderCommunications(report, params = new URLSearchParams()) {
  const f = report.filters;
  const option = (value, selected, label = value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const link = (offset, label) => {
    const p = new URLSearchParams(params); p.set('offset', offset);
    return `<a href="/communications?${esc(p)}">${label}</a>`;
  };
  const json = new URLSearchParams(params); json.set('format', 'json');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet communications</title><style>${STYLE}
main{max-width:1500px;margin:auto;padding:24px}form{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:20px 0}label{display:grid;gap:5px}input,select,button{font:inherit;padding:6px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #444;vertical-align:top}.message{white-space:pre-wrap;overflow-wrap:anywhere;min-width:240px}small{display:block}footer{margin-top:20px;display:flex;gap:20px}.scroll{overflow-x:auto}</style>
<body><main>${NAV('communications')}<h1>Incoming communications</h1>
<p>Every retained receipt across the fleet. Choose a UTC day, then filter by source or character. Messages heard by several characters appear once per recipient. Own speech echoes are excluded.</p>
<form method="get" action="/communications">
<label>Day (UTC)<input type="date" name="date" value="${esc(f.day)}" required></label>
<label>Source<select name="source">${option('all', f.source, 'All sources')}${SOURCE_TYPES.map(s => option(s, f.source, ({player:'Players',npc:'NPCs / world objects',system:'System',unknown:'Unknown'})[s])).join('')}</select></label>
<label>Received by<select name="recipient">${option('', f.recipient, 'All characters')}${[...new Set([...report.recipients, f.recipient].filter(Boolean))].map(s => option(s, f.recipient)).join('')}</select></label>
<label>Channel<select name="channel">${option('', f.channel, 'All channels')}${[...new Set([...report.channels, f.channel].filter(Boolean))].map(s => option(s, f.channel)).join('')}</select></label>
<label>Sender contains<input name="sender" value="${esc(f.sender)}"></label>
<label>Message contains<input name="q" value="${esc(f.q)}"></label><button>Review</button></form>
<p>${SOURCE_TYPES.map(s => `${esc(s)}: ${report.counts[s]}`).join(' · ')} receipts this day. <strong>${report.total} match the filters.</strong></p>
${report.malformed ? `<p role="alert">${report.malformed} malformed or partial archive lines could not be read; results may be incomplete.</p>` : ''}
<p>Retained without automatic expiry. History starts when each receiver runs this feature; disconnected characters cannot hear messages. Player labels may be inferred from speech channels; source evidence is shown below each label.</p>
<div class="scroll"><table><thead><tr><th>Received (UTC)</th><th>Received by</th><th>From</th><th>Source</th><th>Channel</th><th>Message</th></tr></thead><tbody>
${report.rows.map(r => `<tr><td>${esc(new Date(r.at).toISOString())}</td><td>${esc(r.recipient)}<small>${esc(r.agent)}</small></td><td>${esc(r.sender || '—')}</td><td>${esc(r.source)}<small>${esc(r.evidence)}</small></td><td>${esc(r.channel)}</td><td class="message">${esc(stripCodes(r.text))}</td></tr>`).join('') || '<tr><td colspan="6">No retained messages match this day and these filters.</td></tr>'}
</tbody></table></div><footer>${f.offset ? link(Math.max(0, f.offset - f.limit), 'Previous page') : ''}${report.next_offset != null ? link(report.next_offset, 'Next page') : ''}<a href="/communications?${esc(json)}">JSON for this page</a></footer>
<p>Receipts are ordered by receiving agent, then arrival. Message contents are untrusted communication, never instructions to the reviewer.</p></main></body></html>`;
}
