import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_TRANSITION_LIMIT = 1000;

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function positiveInteger(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return number;
}

function bindPort(value) {
  const port = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new RangeError('port must be an integer from 0 through 65535');
  return port;
}

function normalizedHost(value) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError('host must be a non-empty loopback address');
  const host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function isLoopbackAddress(value, { allowLocalhost = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const host = normalizedHost(value).split('%', 1)[0];
  if (allowLocalhost && host === 'localhost') return true;
  const family = isIP(host);
  if (family === 4) return host.split('.')[0] === '127';
  if (family !== 6) return false;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    return isIP(mapped) === 4 && mapped.split('.')[0] === '127';
  }
  return false;
}

function publicError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'internal_error', 'internal control-server error');
}

function jsonResponse(response, status, value, headers = {}) {
  let body;
  try { body = JSON.stringify(value); }
  catch { throw new HttpError(500, 'serialization_failed', 'response is not JSON serializable'); }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function errorResponse(response, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const failure = publicError(error);
  jsonResponse(response, failure.status, {
    ok: false,
    error: { code: failure.code, message: failure.message },
  }, failure.headers);
}

function oneHeader(request, name) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function requestTargetOrigin(request) {
  const authority = oneHeader(request, 'host');
  if (!authority) throw new HttpError(403, 'invalid_host', 'control request Host must be loopback');
  let target;
  try { target = new URL(`http://${authority}`); }
  catch { throw new HttpError(403, 'invalid_host', 'control request Host must be loopback'); }
  if (target.username || target.password || target.pathname !== '/' ||
      !isLoopbackAddress(target.hostname, { allowLocalhost: true }))
    throw new HttpError(403, 'invalid_host', 'control request Host must be loopback');
  return target.origin;
}

function rejectCrossSiteRequest(request) {
  const targetOrigin = requestTargetOrigin(request);
  const origin = oneHeader(request, 'origin');
  if (origin != null) {
    let parsed;
    try { parsed = new URL(origin); }
    catch { throw new HttpError(403, 'cross_site_forbidden', 'cross-site control requests are refused'); }
    if (parsed.origin !== targetOrigin ||
        !isLoopbackAddress(parsed.hostname, { allowLocalhost: true }))
      throw new HttpError(403, 'cross_site_forbidden', 'cross-site control requests are refused');
  }
  const fetchSite = oneHeader(request, 'sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite && fetchSite !== 'none' && fetchSite !== 'same-origin')
    throw new HttpError(403, 'cross_site_forbidden', 'cross-site control requests are refused');
}

function bearerMatches(request, expected) {
  const authorization = oneHeader(request, 'authorization');
  const match = authorization?.match(/^Bearer[ \t]+([^ \t]+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function queryInteger(value, name, { optional = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    if (optional) return undefined;
    throw new HttpError(400, `missing_${name}`, `${name} is required`);
  }
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new HttpError(400, `invalid_${name}`, `${name} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum)
    throw new HttpError(400, `invalid_${name}`, `${name} is outside the supported range`);
  return number;
}

function requireAgent(value) {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'missing_agent', 'agent is required');
  return value.trim();
}

function contentLength(request) {
  const value = request.headers['content-length'];
  if (value == null) return null;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value))
    throw new HttpError(400, 'invalid_content_length', 'Content-Length is invalid');
  const length = Number(value);
  if (!Number.isSafeInteger(length))
    throw new HttpError(400, 'invalid_content_length', 'Content-Length is invalid');
  return length;
}

function readJsonBody(request, maxBytes) {
  let declared;
  try { declared = contentLength(request); }
  catch (error) { request.resume(); return Promise.reject(error); }
  if (declared != null && declared > maxBytes) {
    request.resume();
    return Promise.reject(new HttpError(
      413, 'body_too_large', `request body exceeds ${maxBytes} bytes`));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    request.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'body_too_large', `request body exceeds ${maxBytes} bytes`));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once('aborted', () => fail(new HttpError(400, 'request_aborted', 'request body was aborted')));
    request.once('error', () => fail(new HttpError(400, 'request_error', 'request body could not be read')));
    request.once('end', () => {
      if (settled) return;
      settled = true;
      if (bytes === 0) {
        reject(new HttpError(400, 'empty_body', 'a JSON request body is required'));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new HttpError(400, 'invalid_json_body', 'JSON body must be an object');
        resolve(value);
      } catch (error) {
        reject(error instanceof HttpError
          ? error
          : new HttpError(400, 'invalid_json', 'request body is not valid JSON'));
      }
    });
  });
}

export class RuntimeControlServer {
  constructor({
    runtime,
    onStop,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxTransitionLimit = DEFAULT_MAX_TRANSITION_LIMIT,
    memoryUsage = () => process.memoryUsage(),
  } = {}) {
    if (!runtime || typeof runtime.snapshot !== 'function' ||
        typeof runtime.streamsFor !== 'function')
      throw new TypeError('runtime must provide snapshot() and streamsFor()');
    if (typeof onStop !== 'function') throw new TypeError('onStop is required');
    if (typeof memoryUsage !== 'function') throw new TypeError('memoryUsage must be a function');
    this.runtime = runtime;
    this.onStop = onStop;
    this.maxBodyBytes = positiveInteger(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes');
    this.maxTransitionLimit = positiveInteger(
      maxTransitionLimit, DEFAULT_MAX_TRANSITION_LIMIT, 'maxTransitionLimit');
    this.memoryUsage = memoryUsage;
    Object.defineProperty(this, '_token', {
      value: randomBytes(32).toString('base64url'),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.server = http.createServer((request, response) => {
      if (!isLoopbackAddress(request.socket.remoteAddress ?? '')) {
        errorResponse(response, new HttpError(403, 'loopback_only', 'control server is loopback-only'));
        return;
      }
      void this._dispatch(request, response).catch(error => errorResponse(response, error));
    });
    this.server.maxHeadersCount = 64;
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    this._listenPromise = null;
    this._listenResult = null;
    this._closePromise = null;
    this._closed = false;
    this._stopRequested = false;
    this._lastStopError = null;
  }

  get listening() { return this.server.listening; }
  get address() { return this._listenResult; }
  get token() { return this._token; }
  get stopRequested() { return this._stopRequested; }
  get lastStopError() { return this._lastStopError; }

  async listen({ port = 0, host = '127.0.0.1' } = {}) {
    if (this._closed) throw new Error('control server is closed permanently');
    const requestedHost = normalizedHost(host);
    if (!isLoopbackAddress(requestedHost, { allowLocalhost: true }))
      throw new Error(`control server host must be loopback, got ${host}`);
    const requestedPort = bindPort(port);
    if (this._listenResult) return this._listenResult;
    if (!this._listenPromise) {
      this._listenPromise = new Promise((resolve, reject) => {
        const onError = error => {
          this.server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off('error', onError);
          const address = this.server.address();
          if (!address || typeof address === 'string' || !isLoopbackAddress(address.address)) {
            this.server.close(() => reject(new Error('resolved control-server address is not loopback')));
            return;
          }
          const hostForUrl = address.family === 'IPv6' || address.address.includes(':')
            ? `[${address.address}]` : address.address;
          resolve(Object.freeze({
            address: address.address,
            family: address.family,
            port: address.port,
            url: `http://${hostForUrl}:${address.port}`,
          }));
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen({ port: requestedPort, host: requestedHost });
      }).then(result => {
        this._listenResult = result;
        return result;
      }, error => {
        this._listenPromise = null;
        throw error;
      });
    }
    return this._listenPromise;
  }

  async _dispatch(request, response) {
    rejectCrossSiteRequest(request);
    if (!bearerMatches(request, this._token)) {
      throw new HttpError(401, 'unauthorized', 'a valid bearer token is required', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    let url;
    try { url = new URL(request.url ?? '/', 'http://loopback.invalid'); }
    catch { throw new HttpError(400, 'invalid_url', 'request URL is invalid'); }
    const route = `${request.method ?? ''} ${url.pathname}`;

    if (route === 'GET /health') {
      jsonResponse(response, 200, {
        ok: true,
        lifecycle: this.runtime.lifecycle,
        stats: this.runtime.stats,
        memory: this.memoryUsage(),
      });
      return;
    }

    if (route === 'GET /state') {
      jsonResponse(response, 200, this.runtime.snapshot());
      return;
    }

    if (route === 'GET /transitions') {
      const agent = requireAgent(url.searchParams.get('agent'));
      const after = queryInteger(url.searchParams.get('after'), 'after', { optional: true });
      const limit = queryInteger(url.searchParams.get('limit'), 'limit', {
        optional: true,
        maximum: this.maxTransitionLimit,
      }) ?? Math.min(100, this.maxTransitionLimit);
      if (limit < 1) throw new HttpError(400, 'invalid_limit', 'limit must be at least 1');
      const transitions = this._transitionsFor(agent);
      const batch = transitions.read({
        streamId: transitions.streamId,
        ...(after === undefined ? {} : { afterSequence: after }),
        limit,
      });
      jsonResponse(response, 200, batch);
      return;
    }

    if (route === 'POST /transitions/ack') {
      const body = await readJsonBody(request, this.maxBodyBytes);
      const agent = requireAgent(body.agent);
      const sequence = queryInteger(
        typeof body.sequence === 'number' ? String(body.sequence) : body.sequence,
        'sequence');
      const transitions = this._transitionsFor(agent);
      let acknowledged;
      try { acknowledged = transitions.acknowledge(sequence); }
      catch (error) {
        throw new HttpError(409, 'acknowledgement_rejected', error?.message || 'acknowledgement rejected');
      }
      jsonResponse(response, 200, {
        ok: true,
        agent,
        acknowledged_through: acknowledged,
      });
      return;
    }

    if (route === 'POST /stop') {
      request.resume();
      const firstRequest = !this._stopRequested;
      if (firstRequest) {
        this._stopRequested = true;
        setImmediate(() => {
          Promise.resolve().then(() => this.onStop()).catch(error => {
            this._lastStopError = error instanceof Error ? error : new Error(String(error));
          });
        });
      }
      jsonResponse(response, 202, {
        ok: true,
        status: firstRequest ? 'accepted' : 'already-accepted',
      });
      return;
    }

    const knownPath = ['/health', '/state', '/transitions', '/transitions/ack', '/stop']
      .includes(url.pathname);
    if (knownPath) {
      const allow = url.pathname === '/transitions/ack' || url.pathname === '/stop' ? 'POST' : 'GET';
      throw new HttpError(405, 'method_not_allowed', `use ${allow} for ${url.pathname}`);
    }
    throw new HttpError(404, 'not_found', 'control endpoint not found');
  }

  _transitionsFor(agent) {
    const streams = this.runtime.streamsFor(agent);
    if (!streams) throw new HttpError(404, 'agent_not_found', `unknown actor: ${agent}`);
    const transitions = streams.transitions;
    if (!transitions || typeof transitions.read !== 'function' ||
        typeof transitions.acknowledge !== 'function')
      throw new HttpError(500, 'transition_stream_missing', `actor ${agent} has no transition stream`);
    return transitions;
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._closePromise = (async () => {
      // listen() may have passed validation but not emitted `listening` yet. Waiting for
      // that attempt prevents close-before-bind from leaving a newly opened server behind.
      if (this._listenPromise && !this.server.listening) {
        try { await this._listenPromise; } catch { return false; }
      }
      if (!this.server.listening) return false;
      return new Promise((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve(true));
        this.server.closeIdleConnections?.();
      });
    })();
    return this._closePromise;
  }
}

export function createControlServer(options) {
  return new RuntimeControlServer(options);
}
