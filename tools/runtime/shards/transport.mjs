function requireEndpoint(endpoint, method, label) {
  if (!endpoint || typeof endpoint[method] !== 'function')
    throw new TypeError(`${label} must provide ${method}()`);
}

function listener(endpoint, event, handler) {
  endpoint.on(event, handler);
  return () => {
    if (typeof endpoint.off === 'function') endpoint.off(event, handler);
    else endpoint.removeListener?.(event, handler);
  };
}

export function assertShardTransport(transport) {
  requireEndpoint(transport, 'send', 'transport');
  requireEndpoint(transport, 'onMessage', 'transport');
  requireEndpoint(transport, 'onClose', 'transport');
  return transport;
}

// Parent-side adapter for node:child_process.fork() children.
export function createChildProcessParentTransport(child) {
  requireEndpoint(child, 'send', 'child process');
  requireEndpoint(child, 'on', 'child process');
  return Object.freeze({
    send(frame) {
      if (child.connected === false) throw new Error('child IPC channel is disconnected');
      return new Promise((resolve, reject) => {
        child.send(frame, error => error ? reject(error) : resolve());
      });
    },
    onMessage(handler) { return listener(child, 'message', handler); },
    onClose(handler) {
      const onExit = (code, signal) => handler({ code, signal, source: 'exit' });
      const onDisconnect = () => handler({ code: null, signal: null, source: 'disconnect' });
      const offExit = listener(child, 'exit', onExit);
      const offDisconnect = listener(child, 'disconnect', onDisconnect);
      return () => { offExit(); offDisconnect(); };
    },
    onError(handler) { return listener(child, 'error', handler); },
    close() { if (child.connected !== false) child.disconnect(); },
  });
}

// Child-side adapter. Passing process explicitly keeps tests free of global listeners.
export function createChildProcessWorkerTransport(workerProcess = process) {
  requireEndpoint(workerProcess, 'send', 'worker process');
  requireEndpoint(workerProcess, 'on', 'worker process');
  return Object.freeze({
    send(frame) {
      if (workerProcess.connected === false) throw new Error('parent IPC channel is disconnected');
      return new Promise((resolve, reject) => {
        workerProcess.send(frame, error => error ? reject(error) : resolve());
      });
    },
    onMessage(handler) { return listener(workerProcess, 'message', handler); },
    onClose(handler) {
      return listener(workerProcess, 'disconnect', () =>
        handler({ code: null, signal: null, source: 'disconnect' }));
    },
    onError(handler) { return listener(workerProcess, 'error', handler); },
    close() { if (workerProcess.connected !== false) workerProcess.disconnect(); },
  });
}

export function createMessagePortTransport(port) {
  requireEndpoint(port, 'postMessage', 'MessagePort');
  requireEndpoint(port, 'on', 'MessagePort');
  return Object.freeze({
    send(frame) { port.postMessage(frame); },
    onMessage(handler) { return listener(port, 'message', handler); },
    onClose(handler) {
      return listener(port, 'close', () =>
        handler({ code: null, signal: null, source: 'port-close' }));
    },
    onError(handler) { return listener(port, 'messageerror', handler); },
    close() { port.close(); },
  });
}
