#!/usr/bin/env node
// Optional event-driven runtime for a dedicated test fleet, with one shared process by
// default and explicit process shards when a smaller blast radius matters more than RAM.
// The legacy broker remains the default; no Meridian module is imported on --check.

import {
  BROKER_FLEET_LOCK_KIND, inspectFleetLock, claimFleetLock,
} from './runtime/fleet-lock.mjs';
import { AccountLeaseRegistry } from './runtime/account-leases.mjs';
import {
  LAB_RUNNER_HELP, loadLabSelection, parseLabArgs, publicSelection,
} from './runtime/lab-config.mjs';
import { configureLabEnvironment } from './runtime/lab-environment.mjs';
import { installLabGameGlobals } from './runtime/lab-game-globals.mjs';
import {
  publicStartupFailure,
  watchRuntimeFailure,
} from './runtime/lab-runner-lifecycle.mjs';
import { createMeridianFleetRuntime } from './runtime/meridian-fleet-runtime.mjs';
import {
  MeridianShardSupervisor,
  partitionShardEntries,
} from './runtime/shards/index.mjs';

const mib = bytes => Math.round(bytes / 1024 / 1024);

function publicLock(found) {
  const unguardedBroker = found.state === 'stale' &&
    found.lock?.kind === BROKER_FLEET_LOCK_KIND &&
    !Object.hasOwn(found.lock, 'guards');
  return {
    state: found.state,
    reclaimable: found.reclaimable === true && !unguardedBroker,
    ...(found.lock?.pid ? { pid: found.lock.pid } : {}),
    ...(found.lock?.at ? { claimed_at: found.lock.at } : {}),
    ...(unguardedBroker
      ? { why: 'dead broker record predates keeper guards; surviving sockets cannot be ruled out' }
      : found.why ? { why: found.why } : {}),
    ...(found.unverifiable ? { unverifiable: true } : {}),
    ...((found.unguarded_broker || unguardedBroker) ? { unguarded_broker: true } : {}),
  };
}

function lockAllowsLabStart(found) {
  if (found.state === 'live') return false;
  // A pre-guard broker record cannot prove that its child keepers died with the
  // broker. claimFleetLock() fails closed here as well; keep --check consistent.
  return !(found.state === 'stale' &&
    found.lock?.kind === BROKER_FLEET_LOCK_KIND &&
    !Object.hasOwn(found.lock, 'guards'));
}

async function run(selection, config, assignments) {
  const sharded = config.shards > 1;
  const claim = claimFleetLock(selection.lockFile, {
    // A shard must appear on both guarded ownership layers before it can import Meridian.
    guards: sharded ? [] : null,
  });
  if (!claim.ok) {
    const held = publicLock(claim.found);
    throw new Error(`fleet is already claimed (${held.why ?? `pid ${held.pid ?? 'unknown'}`})`);
  }

  const accountLeases = new AccountLeaseRegistry({ guardChildren: sharded });
  let accounts;
  try {
    accounts = accountLeases.acquireAll(selection.entries);
  } catch (error) {
    claim.release();
    throw error;
  }
  if (!accounts.ok) {
    claim.release();
    const conflict = accounts.conflict;
    const holder = accounts.found?.lock;
    throw new Error(
      `account ownership for actor ${conflict?.agent ?? 'unknown'} at ` +
      `${conflict?.endpoint?.key ?? selection.endpoint} is held` +
      (holder?.pid ? ` by pid ${holder.pid} (${holder.kind})` : ' by another runtime'),
    );
  }

  let runtime = null;
  let control = null;
  let terminalFailure = null;
  let unwatchRuntimeFailure = () => {};
  let stopReason = null;
  let resolveStop;
  const stopRequested = new Promise(resolve => { resolveStop = resolve; });
  const requestStop = (reason = 'stop requested') => {
    if (stopReason) return false;
    stopReason = reason;
    resolveStop(reason);
    if (runtime) {
      try { void Promise.resolve(runtime.stop(reason)).catch(() => {}); } catch {}
    }
    return true;
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  const releaseAtExit = () => {
    try { accountLeases.releaseAll(); } catch {}
    try { claim.release(); } catch {}
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', releaseAtExit);

  try {
    if (sharded) {
      console.error(
        `[lab-runtime] starting ${assignments.length} isolated atlas process(es) for ` +
        `${selection.entries.length} actor(s)`,
      );
      runtime = new MeridianShardSupervisor({
        assignments,
        fleet: selection.fleet,
        stateFile: selection.stateFile,
        fleetClaim: claim,
        accountLeases,
        initConfig: { startupConcurrency: config.startupConcurrency },
      });
      unwatchRuntimeFailure = watchRuntimeFailure(runtime, failure => {
        terminalFailure ??= failure;
        process.exitCode = 1;
        requestStop(`shard runtime failure (${failure.code})`);
      });
    } else {
      const isolated = configureLabEnvironment(selection);
      installLabGameGlobals(selection);
      console.error(
        `[lab-runtime] loading one shared lazy atlas for ${selection.entries.length} actor(s); ` +
        `mutable state: ${isolated.runtimeDir}`,
      );
      const actorModule = await import('./runtime/meridian-actor.mjs');
      actorModule.installFleetRosterSource({
        roster: selection.roster,
        stateFile: selection.stateFile,
        entries: selection.entries,
      });
      runtime = createMeridianFleetRuntime({
        runtimeId: `${selection.fleet}-${process.pid}-${Date.now()}`,
        entries: selection.entries,
        startupConcurrency: config.startupConcurrency,
        actorFactory: actorModule.createMeridianActor,
      });
    }

    if (config.controlPort) {
      const controlModule = await import('./runtime/control-server.mjs');
      control = controlModule.createControlServer({
        runtime,
        onStop: () => requestStop('control request'),
      });
      const address = await control.listen({ port: config.controlPort, host: '127.0.0.1' });
      console.error(`[lab-runtime] control ${address.url}`);
      console.error(`[lab-runtime] control bearer token ${control.token}`);
    }

    if (stopReason) return;
    const started = await runtime.start();
    const memory = process.memoryUsage();
    if (sharded) {
      console.error(
        `[lab-runtime] ${started.started}/${started.total} actor(s) started across ` +
        `${started.shards} shard(s)${started.failed ? ' (degraded)' : ''}; ` +
        `parent rss=${mib(memory.rss)} MiB heap=${mib(memory.heapUsed)} MiB`,
      );
      for (const rawFailure of started.failures ?? []) {
        const failure = publicStartupFailure(rawFailure);
        console.error(
          `[lab-runtime] ${failure.id} failed (${failure.code})` +
          (failure.shard_id ? ` in ${failure.shard_id}` : ''),
        );
      }
    } else {
      console.error(
        `[lab-runtime] ${started.started}/${started.total} actor(s) started; ` +
        `rss=${mib(memory.rss)} MiB heap=${mib(memory.heapUsed)} MiB`,
      );
      for (const rawFailure of started.failures ?? []) {
        const failure = publicStartupFailure(rawFailure);
        console.error(`[lab-runtime] ${failure.id} failed (${failure.code})`);
      }
    }
    if (started.started === 0) throw new Error('no lab actor started successfully');
    await stopRequested;
    if (terminalFailure) {
      throw Object.assign(
        new Error(`sharded lab stopped after ${terminalFailure.code}`),
        { code: terminalFailure.code },
      );
    }
  } finally {
    try {
      const stopped = await runtime?.stop(stopReason ?? 'lab runtime exiting');
      if (stopped?.ok === false) {
        process.exitCode = 1;
        console.error('[lab-runtime] one or more shard children remain unconfirmed; ownership stays guarded');
      }
    } catch {
      process.exitCode = 1;
      console.error('[lab-runtime] runtime stop failed; ownership release remains fail-closed');
    }
    try { await control?.close(); } catch {}
    try { accountLeases.releaseAll(); } catch {}
    try { claim.release(); } catch {}
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('exit', releaseAtExit);
    unwatchRuntimeFailure();
  }
}

async function main(argv = process.argv.slice(2)) {
  const config = parseLabArgs(argv);
  if (config.help) { console.log(LAB_RUNNER_HELP); return; }
  const selection = loadLabSelection(config);
  const assignments = partitionShardEntries(selection.entries, config.shards);
  const found = inspectFleetLock(selection.lockFile);

  if (config.action === 'check') {
    const result = {
      ok: lockAllowsLabStart(found),
      action: 'check',
      profile: config.profile,
      selection: publicSelection(selection),
      lock: publicLock(found),
      design: {
        shards: assignments.length,
        assignments: assignments.map(assignment => Object.freeze({
          shard: assignment.id,
          actors: assignment.actorIds,
        })),
        atlas: assignments.length === 1
          ? 'one lazy module instance in the lab runtime'
          : 'one lazy module instance per isolated shard process',
        sessions: 'one mutable Session and TCP socket per actor',
        decisions: 'event/deadline driven',
        state: 'coalesced latest snapshots plus acknowledged critical transitions',
        time_scale: 1,
        server_clock: 'endpoint-defined; use the separately attested m59-sim-server for accelerated Blakod timers/world hours',
      },
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  await run(selection, config, assignments);
}

try {
  await main();
} catch (error) {
  console.error(`[lab-runtime] refused: ${error?.message ?? String(error)}`);
  if (process.env.M59_DEBUG) console.error(error?.stack);
  process.exitCode = 1;
}
