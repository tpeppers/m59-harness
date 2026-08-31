import { EventEmitter } from 'node:events';

import { immutableStateValue } from '../state/json-value.mjs';
import { ShardParentController } from './parent-controller.mjs';

export const SHARDED_FLEET_SNAPSHOT_SCHEMA = 'm59-sharded-fleet-runtime-snapshot/v1';

let nextAggregateId = 0;

export class ShardFleetAggregator {
  constructor({ controllers = [], runtimeId = null } = {}) {
    if (!controllers || typeof controllers[Symbol.iterator] !== 'function')
      throw new TypeError('controllers must be iterable');
    this.controllers = [...controllers];
    if (!this.controllers.every(controller => controller instanceof ShardParentController))
      throw new TypeError('every controller must be a ShardParentController');
    this.runtimeId = runtimeId == null
      ? `sharded-fleet-${Date.now()}-${++nextAggregateId}`
      : String(runtimeId).trim();
    if (!this.runtimeId) throw new TypeError('runtimeId must be a non-empty string');
    this.lifecycle = 'created';
    this.events = new EventEmitter();
    this.byShard = new Map();
    this.byActor = new Map();
    this.unsubscribers = [];
    this.revision = 0;
    this.startPromise = null;
    this.stopPromise = null;
    for (const controller of this.controllers) {
      if (this.byShard.has(controller.shardId))
        throw new Error(`duplicate shard id: ${controller.shardId}`);
      this.byShard.set(controller.shardId, controller);
      for (const actorId of controller.actorIds) {
        if (this.byActor.has(actorId)) throw new Error(`actor assigned to two shards: ${actorId}`);
        this.byActor.set(actorId, controller);
      }
      for (const event of ['ready', 'initialized', 'state', 'transition', 'health',
        'stopped', 'stop-failed', 'crash', 'close']) {
        this.unsubscribers.push(controller.on(event, value => this._childEvent(
          event, controller, value)));
      }
    }
  }

  on(event, handler) {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  get actorIds() { return Object.freeze([...this.byActor.keys()]); }

  get stats() {
    const shardStats = this.controllers.map(controller => controller.stats);
    return immutableStateValue({
      runtime_id: this.runtimeId,
      lifecycle: this.lifecycle,
      shards: this.controllers.length,
      actors: this.byActor.size,
      ready_shards: this.controllers.filter(row => row.lifecycle === 'ready').length,
      stopped_shards: this.controllers.filter(row => row.lifecycle === 'stopped').length,
      unavailable_shards: this.controllers.filter(row =>
        row.lifecycle === 'crashed' || row.lifecycle === 'disconnected').length,
      actors_with_state: shardStats.reduce((sum, row) => sum + row.actors_with_state, 0),
      pending_transitions: shardStats.reduce((sum, row) => sum + row.pending_transitions, 0),
      frames_sent: shardStats.reduce((sum, row) => sum + row.frames_sent, 0),
      frames_received: shardStats.reduce((sum, row) => sum + row.frames_received, 0),
    });
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.lifecycle !== 'created')
      return Promise.reject(new Error('sharded fleet cannot be started from its current lifecycle'));
    this.lifecycle = 'starting';
    this.revision++;
    this.startPromise = Promise.allSettled(this.controllers.map(controller => controller.start()))
      .then(results => {
        const failures = results.flatMap((result, index) => result.status === 'rejected'
          ? [{ shard_id: this.controllers[index].shardId,
            error: { name: result.reason?.name ?? 'Error', code: result.reason?.code } }]
          : []);
        this.lifecycle = failures.length ? 'degraded' : 'running';
        this.revision++;
        return immutableStateValue({
          ok: failures.length === 0,
          ready: results.length - failures.length,
          failed: failures.length,
          failures,
        });
      });
    return this.startPromise;
  }

  snapshot() {
    const shards = this.controllers.map(controller => controller.snapshot());
    const actors = [];
    for (const shard of shards) {
      for (const actor of shard.actors) actors.push({ ...actor, shard_id: shard.shard_id });
    }
    actors.sort((left, right) => left.id.localeCompare(right.id));
    return immutableStateValue({
      schema: SHARDED_FLEET_SNAPSHOT_SCHEMA,
      runtime_id: this.runtimeId,
      lifecycle: this.lifecycle,
      revision: this.revision,
      shards,
      actors,
    });
  }

  streamsFor(actorId) {
    const controller = this.byActor.get(actorId);
    return controller?.streamsFor(actorId) ?? null;
  }

  controllerForActor(actorId) { return this.byActor.get(actorId) ?? null; }
  controllerForShard(shardId) { return this.byShard.get(shardId) ?? null; }

  sendInit(shardId, payload) {
    const controller = this.byShard.get(shardId);
    if (!controller) return Promise.reject(new Error(`unknown shard: ${shardId}`));
    return controller.sendInit(payload);
  }

  stop(reason = 'sharded fleet stopped', options = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycle = 'stopping';
    this.revision++;
    this.stopPromise = Promise.allSettled(
      this.controllers.map(controller => controller.requestStop(reason, options)))
      .then(results => {
        const failures = results.flatMap((result, index) => {
          if (result.status === 'rejected') return [{
            shard_id: this.controllers[index].shardId,
            error: { name: result.reason?.name ?? 'Error', code: result.reason?.code },
          }];
          if (result.value?.ok === false) return [{
            shard_id: this.controllers[index].shardId,
            error: result.value.error,
          }];
          return [];
        });
        this.lifecycle = failures.length ? 'stop-failed' : 'stopped';
        this.revision++;
        return immutableStateValue({
          ok: failures.length === 0,
          stopped: results.length - failures.length,
          failed: failures.length,
          failures,
        });
      });
    return this.stopPromise;
  }

  _childEvent(event, controller, value) {
    this.revision++;
    if ((event === 'crash' || event === 'close') &&
        this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped')
      this.lifecycle = 'degraded';
    this.events.emit(event, Object.freeze({
      shardId: controller.shardId,
      value,
    }));
    this.events.emit('change', Object.freeze({ event, shardId: controller.shardId }));
  }
}
