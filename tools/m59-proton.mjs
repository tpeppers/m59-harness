// START A WINDOWS meridian.exe UNDER PROTON, WITHOUT STEAM IN THE MIDDLE.
//
// `steam -applaunch 893390` can only ever start the Steam install, under whatever Proton
// Steam has picked for it. That is the wrong client twice over on the Deck: the patched
// build lives in ~/Games/Meridian59 (install/steamdeck in the Meridian59 tree), and
// Proton 11's DXVK wants VK_KHR_maintenance6, which the Mesa on an older SteamOS does not
// have -- the client then finds no Direct3D adapter at all and never shows a window. Proton
// 10 runs it.
//
// So this assembles the launch Steam would have made: Proton's own `proton` script, run
// INSIDE the Steam Linux Runtime its toolmanifest asks for. Run bare, Proton 10 and 11 die
// at once on SteamOS's libc (`GLIBC_2.38 not found`), and the wrong runtime fails the same
// way, so the runtime is read from the manifest rather than guessed.
//
//   M59_PROTON          the Proton folder name under steamapps/common  (Proton 10.0)
//   M59_PROTON_PREFIX   the compat data dir; Proton makes pfx/ inside   (~/Games/Meridian59-prefix)
//   M59_DECK_CLIENT     the meridian.exe to start                       (~/Games/Meridian59/meridian.exe)
//
// The prefix is our own rather than Steam's compatdata/893390: that one belongs to the Steam
// client and to whatever Proton Steam last ran it with, and Proton upgrades a prefix it is
// pointed at -- sharing it would have the two launchers fighting over its version.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HOME = process.env.HOME || '';

export const DECK_CLIENT = () =>
  process.env.M59_DECK_CLIENT || join(HOME, 'Games', 'Meridian59', 'meridian.exe');
export const PROTON_NAME = () => process.env.M59_PROTON || 'Proton 10.0';
export const PROTON_PREFIX = () =>
  process.env.M59_PROTON_PREFIX || join(HOME, 'Games', 'Meridian59-prefix');

const STEAM_ROOTS = [
  join(HOME, '.local/share/Steam'),
  join(HOME, '.steam/steam'),
  join(HOME, '.var/app/com.valvesoftware.Steam/data/Steam'),
];

export function steamRoot() {
  return STEAM_ROOTS.find(r => existsSync(join(r, 'steamapps'))) ?? null;
}

// Every library, not just the root's: Proton and the runtimes can sit on a microSD card.
function libraries(root) {
  const libs = [root];
  try {
    const vdf = readFileSync(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) if (!libs.includes(m[1])) libs.push(m[1]);
  } catch { /* the root alone */ }
  return libs;
}

const vdfValue = (text, key) => text.match(new RegExp(`"${key}"\\s+"([^"]*)"`))?.[1] ?? null;

function findInLibraries(libs, name) {
  for (const lib of libs) {
    const p = join(lib, 'steamapps', 'common', name);
    if (existsSync(p)) return p;
  }
  return null;
}

// The runtime a Proton asks for is an app id; its folder name is in that app's manifest.
function runtimeFor(libs, protonDir) {
  let appid;
  try { appid = vdfValue(readFileSync(join(protonDir, 'toolmanifest.vdf'), 'utf8'), 'require_tool_appid'); }
  catch { return { error: `no toolmanifest.vdf in ${protonDir}` }; }
  if (!appid) return { entry: null };       // an old Proton that runs without a container
  for (const lib of libs) {
    try {
      const acf = readFileSync(join(lib, 'steamapps', `appmanifest_${appid}.acf`), 'utf8');
      const entry = join(lib, 'steamapps', 'common', vdfValue(acf, 'installdir'), '_v2-entry-point');
      if (existsSync(entry)) return { entry };
    } catch { /* not in this library */ }
  }
  return { error: `the Steam Linux Runtime it needs (app ${appid}) is not installed -- launch any game using it from Steam once` };
}

// Everything a launch needs, or { error } saying what is missing. Nothing is started.
export function resolveProton() {
  const root = steamRoot();
  if (!root) return { error: 'no Steam install found' };
  const libs = libraries(root);
  const name = PROTON_NAME();
  const proton = findInLibraries(libs, name);
  if (!proton) return { error: `${name} is not installed (Steam > Library > Tools), or set M59_PROTON` };
  const rt = runtimeFor(libs, proton);
  if (rt.error) return { error: rt.error };
  return { root, name, proton, entry: rt.entry, prefix: PROTON_PREFIX() };
}

// Start `exe args...` from the exe's own folder -- the client finds resource\ relative to
// its working directory, and dies after BP_LOAD_MODULE without it.
//
// The `run` verb, not `waitforexitandrun`: the latter waits for the prefix's wineserver to
// go idle first, so a second client would sit behind the first until it was closed.
// Detached, so quitting the caller never takes the client with it.
export function launchUnderProton(exe, args, { stdio = 'ignore', env = {} } = {}) {
  const p = resolveProton();
  if (p.error) throw new Error(p.error);
  mkdirSync(p.prefix, { recursive: true });
  const cmd = [join(p.proton, 'proton'), 'run', exe, ...args];
  const [file, ...argv] = p.entry ? [p.entry, '--verb=run', '--', ...cmd] : cmd;
  const child = spawn(file, argv, {
    cwd: dirname(exe),
    stdio,
    detached: true,
    env: {
      ...process.env,
      STEAM_COMPAT_DATA_PATH: p.prefix,
      STEAM_COMPAT_CLIENT_INSTALL_PATH: p.root,
      ...env,
    },
  });
  child.unref();
  return { child, proton: p.name, prefix: p.prefix };
}
