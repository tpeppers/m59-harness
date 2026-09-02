// Runtime profiles are an explicit safety boundary. In particular, a fleet called
// "prod" must never inherit a time multiplier from a lab shell by accident.

export class RuntimeProfileError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RuntimeProfileError';
    this.details = details;
  }
}

export const RUNTIME_PROFILE_NAMES = Object.freeze(['legacy', 'prod', 'lab']);

const DEFINITIONS = Object.freeze({
  legacy: Object.freeze({ production: false, permitsTimeScale: true }),
  prod: Object.freeze({ production: true, permitsTimeScale: false }),
  lab: Object.freeze({ production: false, permitsTimeScale: true }),
});

const ALIASES = Object.freeze({ production: 'prod' });

export function createRuntimeProfile(input = {}) {
  if (typeof input === 'string') input = { name: input };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RuntimeProfileError('runtime profile input must be a name or an object');

  const name = profileName(input.name ?? input.profile ?? 'legacy');
  const definition = DEFINITIONS[name];
  const timeScale = parseTimeScale(input.timeScale ?? input.scale ?? 1);
  assertTimeScaleAllowed({ name, production: definition.production }, timeScale);

  return Object.freeze({
    schema: 'm59-runtime-profile/v1',
    name,
    production: definition.production,
    lab: name === 'lab',
    timeScale,
    scaled: timeScale !== 1,
    accelerated: timeScale > 1,
  });
}

export function runtimeProfileFromEnv(env = process.env, overrides = {}) {
  if (!env || typeof env !== 'object')
    throw new RuntimeProfileError('env must be an object');
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new RuntimeProfileError('overrides must be an object');

  const envName = nonempty(env.M59_RUNTIME_PROFILE);
  const envScale = nonempty(env.M59_TIME_SCALE);
  return createRuntimeProfile({
    name: overrides.name ?? overrides.profile ?? envName ?? 'legacy',
    timeScale: overrides.timeScale ?? overrides.scale ?? envScale ?? 1,
  });
}

// Call this at any dynamic scale-change boundary as well as at profile construction.
// The separate export makes it hard for an admin endpoint to validate startup and then
// accidentally omit the same production guard later.
export function assertTimeScaleAllowed(profile, value) {
  const scale = parseTimeScale(value);
  const production = profile?.production === true || profileName(profile?.name ?? profile) === 'prod';
  if (production && scale !== 1) {
    throw new RuntimeProfileError(
      `runtime profile "prod" requires timeScale=1 (received ${scale})`,
      { profile: 'prod', timeScale: scale },
    );
  }
  return scale;
}

function profileName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const name = ALIASES[raw] ?? raw;
  if (!DEFINITIONS[name])
    throw new RuntimeProfileError(
      `unknown runtime profile "${raw || value}"; expected ${RUNTIME_PROFILE_NAMES.join(', ')}`,
      { profile: value },
    );
  return name;
}

function parseTimeScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RuntimeProfileError('timeScale must be a finite number greater than zero',
      { timeScale: value });
  return scale;
}

function nonempty(value) {
  return value == null || String(value).trim() === '' ? null : value;
}
