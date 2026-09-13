// Authenticated, per-bot conversations. The transport supplies broker-verified pilot
// identity, never a player name claimed in speech. All setting names are reflected.
import { ControlDraft } from './m59-control-client.mjs';

export function tellChunks(text, max = 210) {
  // Game strings are byte bounded; keep transport text ASCII and leave header room.
  const words = String(text).replace(/[^\x20-\x7e\n]/g, '?').split(/\s+/);
  const out = []; let part = '';
  for (let word of words) {
    while (word.length > max) { if (part) out.push(part); part = ''; out.push(word.slice(0, max)); word = word.slice(max); }
    if (part.length + word.length + 1 > max) { out.push(part); part = ''; }
    part += (part ? ' ' : '') + word;
  }
  if (part) out.push(part);
  return out;
}
const fingerprint = p => p ? `${p.agent}:${p.pid}:${p.objectId}` : null;

export class ChatControls {
  constructor({ authenticate, client, reply, now = Date.now }) {
    Object.assign(this, { authenticate, client, reply, now });
    this.sessions = new Map();
    this.chains = new Map();
  }
  handle(bot, said) {
    // Serialize a speaker's commands: confirmation, edit, save cannot overtake.
    const key = said.speaker;
    const job = (this.chains.get(key) ?? Promise.resolve()).then(() => this.receive(bot, said));
    const settled = job.catch(() => {});
    this.chains.set(key, settled);
    return job.finally(() => { if (this.chains.get(key) === settled) this.chains.delete(key); });
  }
  async receive(bot, said) {
    const identity = await this.authenticate(said.speaker);
    if (!identity || bot === identity.agent) return false;
    for (const [key, s] of this.sessions) if (s.until < this.now()) this.sessions.delete(key);
    const key = `${bot}:${said.speaker}`, text = String(said.text ?? '').trim(), lower = text.toLowerCase();
    const auth = fingerprint(identity);
    const valid = async () => fingerprint(await this.authenticate(said.speaker)) === auth;
    const tell = async message => {
      for (const chunk of tellChunks(message)) { if (!await valid()) return; await this.reply(bot, said.speaker, chunk); }
    };
    if (lower === 'control' || lower === `control ${bot.toLowerCase()}`) {
      this.sessions.set(key, { auth, until: this.now() + 600000, confirmed: false });
      await tell(`Control ${bot}: reply "confirm ${bot}" to edit this bot. Settings are staged until you say "save to live fleet". "cancel control" exits.`);
      return true;
    }
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.auth !== auth) { this.sessions.delete(key); return false; }
    session.until = this.now() + 600000;
    if (lower === 'cancel control' || lower === 'exit control') { this.sessions.delete(key); await tell('Control closed; unsaved edits discarded.'); return true; }
    try {
      if (!session.confirmed) {
        if (lower !== `confirm ${bot.toLowerCase()}`) return false;
        session.client = await this.client();
        session.draft = new ControlDraft(await session.client.read([bot]));
        if (!await valid()) { this.sessions.delete(key); return false; }
        for (const [other, s] of this.sessions) if (other !== key && s.auth === auth) this.sessions.delete(other);
        session.confirmed = true; session.page = 0;
        await tell('Control confirmed. Commands: list [filter], next, show <setting>, set <setting> <value>, inherit <order>, changes, reset to current, save to live fleet, cancel control. Example: no food vigor floor 70');
        return true;
      }
      const draft = session.draft;
      if (lower === 'reset to current' || lower === 'reset') {
        draft.reset(await session.client.read([bot])); await tell('Reloaded actual live state. Unsaved edits discarded.');
      } else if (lower === 'save to live fleet' || lower === 'save') {
        if (!await valid()) throw new Error('operator connection ended');
        const answer = await session.client.save(draft); draft.reset(answer);
        await tell(answer.ok ? 'Saved to live fleet; keeper values reloaded.' : `Some changes failed: ${JSON.stringify(answer.results)}`);
      } else if (lower === 'changes') await tell(JSON.stringify({ patch: draft.patch, inherit: draft.inherit }));
      else if (/^show\s/i.test(text)) await tell(draft.describe(draft.field(text.slice(5))).join('\n'));
      else if (/^inherit\s/i.test(text)) await tell('Staged inheritance for ' + draft.inheritField(text.slice(8)).id + '. Say save to live fleet to apply.');
      else if (/^(list|help)(\s|$)/i.test(text) || lower === 'next') {
        if (lower === 'next') session.page++;
        else { session.filter = text.replace(/^(list|help)\s*/i, '').toLowerCase(); session.page = 0; }
        const fields = draft.snapshot.fields.filter(f => (f.id + ' ' + f.title).toLowerCase().includes(session.filter ?? ''));
        const page = fields.slice(session.page * 4, session.page * 4 + 4);
        await tell(page.length ? page.map(f => `${f.id}: ${String(f.description ?? f.title).slice(0, 110)}. Current ${JSON.stringify(draft.snapshot.rows[bot].current[f.id])}`).join('\n') + '\nSay next or show <setting>.' : 'No more settings. Use list or list <filter>.');
      } else if (lower === 'templates') await tell(draft.snapshot.templates.map(t => t.id).join(', '));
      else {
        const f = draft.assignment(text);
        await tell(`Staged ${f.title} = ${JSON.stringify(draft.patch[f.id])}. Say save to live fleet to apply, or reset to current to discard.`);
      }
    } catch (e) { await tell(`Control: ${e.message}`); }
    return true;
  }
}
