# Player login alerts and Kasa lights

An existing tripwire can set a local Kasa bulb as well as applying its posture.
Keep the real player names and light identity in the machine's gitignored
`substrate/tripwires/<name>.mjs`, alongside its other alerts:

```js
export default {
  name: 'player-login',
  when: [{ who_online: ['Example Player', 'Another Player'] }],
  then: {
    posture: 'my-red-alert',
    kasa: {
      alias: 'Example lamp',
      model: 'KL125',
      // mac: 'AA:BB:CC:DD:EE:FF', // optional; pins identity across DHCP changes
      // host: '192.168.1.50',      // optional hint; checked before every write
      hue: 0, saturation: 100, brightness: 100,
      clear: 'restore',
    },
  },
  quiet_ms: 15 * 60_000,
  rearm_ms: 0,
};
```

Add its name to `enabled` in `substrate/tripwires-<fleet>.json`, preserving the
other enabled alerts. Use the existing `check`, `try`, `look`, `watch`, and
`stand-down` commands in `tools/m59-tripwire.mjs`. A running watcher loads its
assignment at startup; restart that exact watcher after changing configuration.
Use the deployed checkout and run `m59-which.mjs --fleet <fleet>` first.

Names match exactly after case and whitespace folding. Any one listed player
being online in a refreshed `who` trips the alert, including a player already
online when the watcher starts. The watcher checks every 15 seconds by default;
this is presence detection, not a promise of instantaneous login notification.
Failed or stale observations never start an alert or advance its quiet timer.

`node tools/m59-kasa.mjs discover` finds reachable local bulbs without changing
them. Legacy KL125 bulbs use UDP discovery and TCP port 9999; no cloud account
or additional dependencies are required. Authenticated devices discovered on
port 20002 use the optional `python-kasa` adapter. On Windows run
`./tools/m59-kasa-setup.ps1 -Python C:/path/to/python.exe` once. It creates an
isolated runtime and prompts locally for the TP-Link account email and password
(hidden); the password is stored with Windows user encryption, under the
gitignored `substrate/kasa-credentials.json`. The watcher must run as that user.
`-RuntimeOnly` installs without prompting; `-CredentialsOnly` saves the login
without installing. Never put a password in chat, in a tripwire, or in command
arguments. `KASA_USERNAME`/`KASA_PASSWORD` environment variables are also
supported. `M59_KASA_PYTHON` and `M59_KASA_CREDENTIALS` override local paths.
Use `protocol: 'authenticated'` in `then.kasa` to skip the legacy probe when the
device is already known to require authentication. Its host is only a hint;
every connection verifies alias and MAC before any write.
Discovery cannot cross an isolated Wi-Fi or extender subnet. An IP hint never
authorizes a different alias/MAC/model, and ambiguous names refuse.

The light turns on at the requested colour once per alert and is read back.
Network failures are recorded and retried once per minute while posture
activation and maintenance continue. `clear: 'restore'` restores the bulb's
previous power, colour, and brightness; `clear: 'leave'` retains the alert colour.
The original setting is saved before the write in
`substrate/tripwire-state/<fleet>/lights.json`, surviving watcher restarts and
uncertain writes. Several alerts naming the same identity share that save and
restore only after the last clears. Use the same alias/MAC selector for alerts
sharing a bulb. `--dry` never contacts a bulb. A shared posture also keeps its
original ownership until its last tripwire clears; manually applied postures
are never automatically released.

Verify with `node tools/m59-kasa-test.mjs`, `node tools/m59-tripwire-test.mjs`,
and `node tools/m59-posture-test.mjs`. Kasa transport tests use a loopback fake
bulb, never a household light.
