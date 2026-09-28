import { AsyncLocalStorage } from 'node:async_hooks';

// All board renderers share lore/room links. Keep the browser's host scoped to
// its request, including renderers reached after an await or promise callback.
const requestOrigin = new AsyncLocalStorage();

export function compendiumOrigin(host, override = process.env.M59_COMPENDIUM) {
  if (override) return override.replace(/\/+$/, '');
  try {
    if (typeof host !== 'string' || !host || /[\s\\/?#@"'<>]/.test(host)) throw new Error('invalid host');
    const url = new URL(`http://${host}`);
    url.port = '8099';
    return url.origin;
  } catch {
    return 'http://localhost:8099';
  }
}

export const compendiumBase = () => requestOrigin.getStore() ?? compendiumOrigin();

export const withCompendiumRequest = handler => (req, res) =>
  requestOrigin.run(compendiumOrigin(req.headers.host), () => handler(req, res));
