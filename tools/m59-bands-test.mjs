// THE GUARD FOR m59-bands.mjs — offline, opens no socket, reads no registry off this machine.
//
//   node tools/m59-bands-test.mjs
//
// Every case here is a thing the first cut of the tool got wrong, or a thing it must keep
// getting right. The one worth naming: `boscontrol` at 9311 in five checkouts is five
// checkouts AGREEING, and reporting it as ten collisions buried the one conflict that had
// just taken prod down. A detector that cries wolf is a detector somebody deletes.
import { claimsFrom, collisions, overlaps, verdict, bandOf } from './m59-bands.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

const R1 = 'C:/a/substrate/keeper-bands.json';
const R2 = 'C:/b/substrate/keeper-bands.json';
const R3 = 'C:/c/substrate/keeper-bands.json';
const claims = (...sets) => sets.flatMap(([reg, json]) => claimsFrom(reg, json).claims);

// ---- a band is 100 ports wide, and the end is inclusive -------------------------------
eq(bandOf(9011), { base: 9011, end: 9110 }, 'a base names base..base+99');
ok(overlaps(bandOf(9011), bandOf(9110)), '9011 and 9110 overlap (9110 is inside the first band)');
ok(!overlaps(bandOf(9011), bandOf(9111)), '9011 and 9111 are adjacent, not overlapping');
ok(overlaps(bandOf(9011), bandOf(9011)), 'a band overlaps itself');
// Symmetry has to be asserted on bands that DO overlap. Asserted first on 9111 against 9011,
// which are adjacent and correctly do not — the test was wrong, not the predicate.
ok(overlaps(bandOf(9100), bandOf(9011)) === overlaps(bandOf(9011), bandOf(9100)),
   'overlap is symmetric on a genuine overlap');
ok(overlaps(bandOf(9111), bandOf(9011)) === overlaps(bandOf(9011), bandOf(9111)),
   'and symmetric on adjacent bands, where the answer is no');

// ---- claimsFrom ------------------------------------------------------------------------
{
  const { claims: c, rejected } = claimsFrom(R1, { prod: 9011, shadow: 9111 });
  eq(c.map(x => [x.fleet, x.base, x.end]), [['prod', 9011, 9110], ['shadow', 9111, 9210]],
     'claims carry an inclusive end');
  eq(rejected, [], 'nothing rejected from a clean registry');
}
{
  // An unusable value is REPORTED, never silently dropped — the `purpose`-missing-from-a-schema
  // failure is that a setting which does nothing is invisible.
  const { claims: c, rejected } = claimsFrom(R1, { good: 9011, zero: 0, word: 'nine', huge: 65500 });
  eq(c.map(x => x.fleet), ['good'], 'only the usable base becomes a claim');
  eq(rejected.map(x => x.fleet).sort(), ['huge', 'word', 'zero'], 'the other three are reported');
  ok(rejected.every(r => r.registry === R1), 'a rejection names the file it came from');
}
eq(claimsFrom(R1, null).claims, [], 'a null registry yields no claims rather than throwing');
eq(claimsFrom(R1, {}).claims, [], 'an empty registry yields no claims');

// ---- AGREEMENT IS NOT A CONFLICT. This is the bug. -------------------------------------
{
  const five = collisions(claims([R1, { boscontrol: 9311 }], [R2, { boscontrol: 9311 }],
                                 [R3, { boscontrol: 9311 }]));
  eq(five, [], 'the same fleet at the same base in three checkouts is agreement, not a conflict');
}
{
  const many = collisions(claims([R1, { prod: 9011, shadow: 9111, arena: 9211 }],
                                 [R2, { prod: 9011, shadow: 9111, arena: 9211 }]));
  eq(many, [], 'two checkouts holding identical registries conflict about nothing');
}

// ---- CONTENTION: different fleets, overlapping ports, different files -------------------
{
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { 'shadow-ab': 9011 }]));
  eq(c.length, 1, 'prod against shadow-ab on 9011 is one conflict');
  eq(c[0].kind, 'CONTENTION', 'different fleets over one range is CONTENTION');
  eq([c[0].from, c[0].to], [9011, 9110], 'the contested range is the intersection');
  eq(c[0].claims.map(x => x.fleet).sort(), ['prod', 'shadow-ab'], 'both fleets are named');
}
{
  // The incident, grouped: FIVE checkouts say prod:9011 and one says shadow-ab:9011. That is
  // ONE conflict with six rows, not ten pairs.
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { prod: 9011 }], [R3, { 'shadow-ab': 9011 }]));
  eq(c.filter(x => x.kind === 'CONTENTION').length, 1,
     'one contested range is one row however many checkouts hold a copy');
  eq(c[0].claims.length, 3, 'every claiming file is listed under it');
}
{
  // Partial overlap still contends: a band is 100 wide, so 9011 and 9100 share 11 ports.
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { lab: 9100 }]));
  eq(c.length, 1, 'a partial overlap is a conflict');
  eq([c[0].from, c[0].to], [9100, 9110], 'the range is only the shared ports');
}
{
  // One registry claiming two overlapping bands is allocateKeeperBand's job to refuse, and
  // reporting it here would blame the wrong file.
  const c = collisions(claims([R1, { prod: 9011, other: 9050 }]));
  eq(c, [], 'an overlap WITHIN one registry is not this tool\'s finding');
}

// ---- DISAGREEMENT: one fleet, two bands -------------------------------------------------
{
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { prod: 9511 }]));
  eq(c.length, 1, 'one fleet with two bands is one conflict');
  eq(c[0].kind, 'DISAGREEMENT', 'same name, different bases is DISAGREEMENT');
  eq(c[0].fleet, 'prod', 'it names the fleet');
  eq(c[0].claims.map(x => x.base), [9011, 9511], 'both bands are listed, lowest first');
}
{
  // The live shape on 2026-09-11: the deploy moved and the other checkouts did not.
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { prod: 9011 }],
                              [R3, { prod: 9511 }], ['C:/d/substrate/keeper-bands.json', { 'shadow-ab': 9011 }]));
  const kinds = c.map(x => x.kind).sort();
  eq(kinds, ['CONTENTION', 'DISAGREEMENT'], 'the incident produces exactly one of each');
  const dis = c.find(x => x.kind === 'DISAGREEMENT');
  eq(dis.claims.length, 3, 'the disagreement lists all three prod claims');
  const con = c.find(x => x.kind === 'CONTENTION');
  eq(con.claims.map(x => x.fleet).sort(), ['prod', 'prod', 'shadow-ab'],
     'the contention names shadow-ab and the prod claims it displaces');
}

// ---- PAPER vs LIVE ----------------------------------------------------------------------
{
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { 'shadow-ab': 9011 }]))[0];
  eq(verdict(c, []).verdict, 'CONTENTION (on paper)', 'nothing answering is a paper conflict');
  eq(verdict(c, []).slots, [], 'a paper conflict names no slots');

  const live = verdict(c, [{ port: 9013, agent: 'shadow03' }, { port: 9022, agent: 'shadow12' }]);
  eq(live.verdict, 'CONTENTION — LIVE', 'a keeper inside the range makes it live');
  eq(live.slots, ['shadow03', 'shadow12'], 'the slots say WHOSE keepers are down there');
  ok(live.verdict.endsWith('LIVE'), 'the exit-code gate matches the verdict string');

  // A keeper OUTSIDE the contested range must not promote it — this is the difference
  // between "two files disagree" and "a fleet is being driven by the wrong broker".
  eq(verdict(c, [{ port: 9511, agent: 't1' }]).verdict, 'CONTENTION (on paper)',
     'an occupant outside the contested range leaves the conflict on paper');
}
{
  // A DISAGREEMENT probes each band separately, so a keeper in EITHER band makes it live.
  const c = collisions(claims([R1, { prod: 9011 }], [R2, { prod: 9511 }]))[0];
  eq(verdict(c, [{ port: 9511, agent: 't1' }]).verdict, 'DISAGREEMENT — LIVE',
     'a keeper in the far band still makes a disagreement live');
  eq(verdict(c, [{ port: 9300, agent: 't1' }]).verdict, 'DISAGREEMENT (on paper)',
     'a keeper in neither band does not');
}

// ---- ordering ---------------------------------------------------------------------------
{
  const c = collisions(claims([R1, { a: 9011, b: 9511 }], [R2, { c: 9011, d: 9511 }]));
  ok(c.length >= 2 && c[0].from <= c[1].from, 'conflicts come out lowest port first');
}

console.log(`\nm59-bands: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
