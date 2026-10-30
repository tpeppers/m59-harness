import { LootPolicyStore, decideLoot, lootPolicyDiagnostics, policyChain } from './m59-loot-policies.mjs';

export class LootPolicyControls {
  constructor({ stateFile, pid = process.pid, members, sources }) {
    this.state = stateFile; this.pid = pid; this.members = members;
    this.store = new LootPolicyStore(stateFile, sources ? { sources } : {});
  }
  async run(body) {
    if (!['read', 'preview', 'save'].includes(body.action)) throw new Error('Unknown loot policy action');
    const current = this.store.snapshot();
    const members = await this.members();
    if (body.action !== 'read') {
      if (body.expected_state !== this.state || body.expected_pid !== this.pid || body.expected_revision !== current.revision)
        throw new Error('Broker or policy sources changed; reload before editing');
      if (!this.store.writable.has(body.source)) throw new Error('Select a source registered for writeback');
    }
    let snapshot = body.action === 'read' ? current : this.store.compose(body.document, body.source);
    if (body.action === 'save') {
      // Do not present a successful save to a fleet whose keepers cannot interpret it.
      if (members.some(m => m.status?.protocol !== 1 || !m.status?.available))
        throw new Error('Every keeper must support the loot policy protocol before saving; deploy compatible keepers first');
      if (members.some(m => m.status.revision !== current.revision))
        throw new Error('Keeper policy sources differ or are not yet observed; refresh before saving');
      snapshot = this.store.save(body.document, body.expected_revision, body.source);
    }
    return { protocol: 1, identity: { state: this.state, pid: this.pid }, ...snapshot,
      saved: body.action === 'save', applied: false,
      note: body.action === 'save' ? 'Source saved. Keepers hot-read it; refresh to verify their observed revisions.' : 'Read-only composition; no game orders issued.',
      members: members.map(m => {
        const context = { character: m.character, guild: m.status?.guild ?? null };
        return { agent: m.agent, character: m.character, guild: context.guild,
          supported: m.status?.protocol === 1 && m.status?.available === true,
          observed_revision: m.status?.revision ?? null, error: m.status?.error ?? null,
          chain: policyChain(snapshot.effective, context).map(p => ({ id: p.id, scope: p.scope })),
          diagnostics: lootPolicyDiagnostics(snapshot.effective, context, m.status?.legacy),
          inventory: (m.status?.inventory ?? []).map(item => ({ ...item, projected: decideLoot(snapshot.effective, context, item) })) };
      }) };
  }
}
