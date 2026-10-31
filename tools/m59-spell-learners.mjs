#!/usr/bin/env node
// WHO CAN LEARN THIS SPELL — the old name of m59-learners.mjs, kept because fleetscripts import it.
//
//   node tools/m59-spell-learners.mjs --spell "enchant weapon"     # same as m59-learners.mjs --spell ...
//
// It hardcoded spells, so it could not answer for a skill (archery, 2026-10-31). m59-learners.mjs
// takes either and adds the time estimate; this file only forwards.
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export { plannerCatalogue, standing, trend, kindOf } from './m59-learners.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await (await import('./m59-learners.mjs')).main();
