# Listener identity after a Windows hot handover

Windows can continue to attribute an IPC-transferred TCP listener to its original
creator even after the current broker has adopted the fleet and the predecessor
has exited. Neither a PID hint nor a handover log proves who serves a fresh
connection. The optional `broker-listener-identity.mjs` supplies a read-only proof
without changing handover, keeper lifecycle, locks, RPC authority or game traffic.

## Protocol 1

1. The consumer has already validated configured root/fleet/roster, HTTP health,
   current broker script/PID/incarnation, active roster lock, and game endpoint.
2. Connect locally to `\\.\pipe\m59-broker-identity-v1-<pid>`. Check the **kernel**
   server PID before/after the read using Windows `GetNamedPipeServerProcessId`,
   and check process creation time against the expected incarnation. The name
   and response's self-reported PID alone are not proof.
3. The pipe returns one bounded JSON line: `schema`, `pid`, `instance`,
   `public_key` (base64 DER SPKI Ed25519). The instance is random per process.
4. Send a new random 32-byte hexadecimal nonce to the numeric loopback RPC port:
   `GET /identity/v1?nonce=<64 lowercase hex digits>`. No redirects or browsers.
5. The response is `{payload,signature}`, both canonical base64. Verify the
   Ed25519 signature over the decoded payload bytes using the pipe's public key.
   Then validate decoded JSON `schema: m59-broker-listener-identity/1`, `nonce`,
   `pid`, `fleet`, `root`, `state`, `port`, `instance`, and `issued_at` (Unix ms).
   The signed port is the actual connection's local port. Bind every field to
   the configured/current identity, not values chosen by a remote response.
6. Require a fresh proof (consumer: at most 5 seconds old, at most 1 second in the
   future), then revalidate health, process incarnation and active roster claim.
   An identity change aborts; it is never a reason to silently switch brokers.

The process generates a new private key in memory. It is not persisted, logged,
included in handover snapshots, or exposed by any endpoint. Each successor has
its own pipe/key/instance. The old pipe closes on handover commit. Identity HTTP
requests are never forwarded to a successor; a frozen/retired/non-owning broker
refuses them. A fresh proof is not a lease or permission to issue game commands.

## Bounds and failure behavior

- Windows only; other systems retain their existing owner checks.
- Pipe: maximum 16 clients, fixed public response, hard 1.5-second lifetime;
  connection name collision/startup failure does not interrupt the broker.
- HTTP: strict loopback source and Host, no Origin/Sec-Fetch-Site, GET only,
  exactly one bounded nonce, at most 32 signing requests per second.
- Only the RPC listener handles identity. The read-only dashboard is not an
  alternate broker. HTTP health advertises `listener_identity.protocol=1` and
  `available`, but those fields are discovery hints, never attestation.
- Missing proof, unverified pipe ownership, bad signature, stale response,
  changed claim/incarnation or unavailable pipe fail closed. No lock deletion,
  cold restart, process killing, automatic deployment or stale authorization.

No Meridian requests, keeper polls, DUM reads, roster writes or background
sampling are added. A proof costs a public pipe read plus one small HTTP read;
consumers may repeat it at their existing startup identity boundaries. The
module checks the existing local ownership claim before answering. The normal
HTTP `/health` may report proof availability but never emits a signature/key.

Run `node tools/runtime/broker-listener-identity-test.mjs` and the existing
`node tools/runtime/broker-handover-test.mjs`. The C&C consumer additionally
tests real inherited sockets, x86/x64 Windows readers, spoofed pipe names,
signatures, replay/expiry and changed startup identity. No real broker is started
by these tests. Production release must use the normal reviewed/tagged deploy
workflow; changing source cannot retrofit a running process's key/pipe.

API references: [Windows pipe server PID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid)
and [Node IPC transport](https://nodejs.org/api/net.html#ipc-support).
