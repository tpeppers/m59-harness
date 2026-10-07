// KEEP A CHARACTER OUT OF THE WORLD ON PURPOSE, or let it back. The command line over the broker's
// `dormancy` tool (tools/m59-dormancy.mjs has the model and the server's rules).
//
//   node tools/m59-dormant.mjs                          every held character: why, until, penalty
//   node tools/m59-dormant.mjs hold t20 --for 15        out for 15 minutes (logs it off if it is in)
//   node tools/m59-dormant.mjs hold t20                 out until `wake`
//   node tools/m59-dormant.mjs hold t20 --accept-penalty --note "camped at the bank"
//   node tools/m59-dormant.mjs wake t20                 back now
//   ... --port 8901                                     the broker (default 8901, or M59_BROKER_PORT)
//
// THE MOVE IT EXISTS FOR: you are playing a character, something is killing it, and you log off --
// the one thing in this game that breaks a fight. Without a hold the broker's rejoin sweep logs the
// keeper straight back in, onto the square you left, where the attacker is waiting. Hold it FIRST
// (a few seconds before you log off is plenty), then log off. A logoff outside an inn or your guild
// hall leaves a ghost the server punishes 540-660 s later; the hold brings the character back before
// the earliest of those unless you pass --accept-penalty.
//
// It prints the fleet the broker says it holds, every time: a hold sent to the wrong fleet's broker
// is a stranger's character kept offline, and that failure is silent.

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--for', '--note', '--port']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const [action = 'list', agent = null] = positional;
const port = Number(opt('--port', process.env.M59_BROKER_PORT || 8901));
const base = `http://127.0.0.1:${port}`;

async function tool(name, args) {
  const res = await fetch(`${base}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = JSON.parse(await res.text());
  const text = body?.result?.content?.[0]?.text ?? body?.error?.message ?? '';
  if (body?.result?.isError || body?.error) throw new Error(text || 'tool error');
  try { return JSON.parse(text); } catch { return { text }; }
}

const when = t => (t == null ? '-' : new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z');
const mins = t => (t == null ? '' : ` (${Math.round((t - Date.now()) / 60_000)} min)`);

async function main() {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
  if (!health) { console.error(`no broker answering on ${base}`); return 2; }
  console.log(`broker ${base}  fleet ${health.fleet ?? '?'}  roster ${health.state ?? health.state_file ?? '?'}`);

  if (action === 'list') {
    const r = await tool('dormancy', { action: 'list' });
    if (flag('--json')) { console.log(JSON.stringify(r, null, 1)); return 0; }
    if (!r.dormant?.length) console.log('nobody is held out of the world');
    for (const d of r.dormant ?? []) {
      console.log(`${d.agent}  ${d.reason}  wakes ${d.wake}${d.until ? ` at ${when(d.until)}${mins(d.until)}` : ''}  by ${d.by}`);
      if (d.note) console.log(`    ${d.note}`);
      if (d.logoff) console.log(`    left room ${d.logoff.room ?? 'unknown'} at ${when(d.logoff.at)}` +
        (d.penalty ? `; server penalty window ${when(d.penalty.earliest)}..${when(d.penalty.latest)}` +
          (d.accept_penalty ? ' (ACCEPTED)' : `; back by ${when(d.verdict?.must_wake_by)}${mins(d.verdict?.must_wake_by)}`)
          : '; a safe-logoff room, no penalty'));
      console.log(`    now: ${d.verdict?.wake ? 'WAKING' : 'held'} -- ${d.verdict?.why}`);
    }
    return 0;
  }
  if (!agent) { console.error(`usage: m59-dormant.mjs ${action} <agent>`); return 2; }
  if (action === 'wake') {
    const r = await tool('dormancy', { action: 'wake', agent, note: opt('--note', 'asked from the command line'), by: 'm59-dormant.mjs' });
    console.log(JSON.stringify(r, null, 1));
    return r.ok === false ? 1 : 0;
  }
  if (action === 'hold') {
    const forMin = opt('--for');
    const r = await tool('dormancy', { action: 'hold', agent, by: 'm59-dormant.mjs',
      note: opt('--note'), accept_penalty: flag('--accept-penalty'),
      ...(forMin != null ? { minutes: Number(forMin) } : {}) });
    if (r.error) { console.error(r.error); return 1; }
    const d = r.dormancy ?? {};
    console.log(`${agent} held: ${d.reason}, wakes ${d.wake}${d.until ? ` at ${when(d.until)}${mins(d.until)}` : ''}`);
    if (d.penalty && !d.accept_penalty)
      console.log(`    logged off outside a safe room: back by ${when(d.penalty.earliest - 60_000)} to beat the server's penalty`);
    if (r.note) console.log(`    ${r.note}`);
    return r.ok === false ? 1 : 0;
  }
  console.error(`unknown action "${action}" -- list, hold or wake`);
  return 2;
}

main().then(code => process.exit(code ?? 0), e => { console.error(e.message); process.exit(1); });
