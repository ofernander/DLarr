// DLarr — event bus
//
// In-process pub/sub used by the SSE stream. Modules that produce
// user-visible state changes (logger, reconciler, dispatcher, health
// checker, settings layer) publish events here; the SSE handler
// subscribes and forwards everything to connected browsers.
//
// Event shape:
//   {
//     type:      'file-update' | 'watch-update' | 'settings-update'
//              | 'arr-update'  | 'log'          | 'status',
//     timestamp: ISO string,
//     payload:   type-specific object
//   }
//
// Design §9 lists the event types. The bus itself doesn't care about
// payload shape — it just forwards.
//
// Why a custom bus instead of EventEmitter directly: we want to cap
// subscriber count (prevent a leak from a stuck browser tab accumulating
// listeners forever) and we want a single event shape for everything
// including timestamp normalization. Thin layer over EventEmitter does both.

import { EventEmitter } from 'node:events';

const MAX_SUBSCRIBERS = 100;

class EventBus {
  constructor() {
    this._ee = new EventEmitter();
    // Allow more listeners than Node's default 10 since each SSE client
    // is a listener and we want headroom.
    this._ee.setMaxListeners(MAX_SUBSCRIBERS);
  }

  /**
   * Publish an event.
   * @param {string} type     one of the documented event types
   * @param {object} payload  type-specific data
   */
  publish(type, payload = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this._ee.emit('event', event);
  }

  /**
   * Subscribe to all events. Returns an unsubscribe function.
   * @param {(event: object) => void} handler
   * @returns {() => void}
   */
  subscribe(handler) {
    if (this._ee.listenerCount('event') >= MAX_SUBSCRIBERS) {
      throw new Error(`Event bus at max subscribers (${MAX_SUBSCRIBERS})`);
    }
    this._ee.on('event', handler);
    return () => this._ee.off('event', handler);
  }

  /**
   * Current subscriber count. Useful for diagnostics / status endpoint.
   */
  subscriberCount() {
    return this._ee.listenerCount('event');
  }
}

// Module-level singleton
export const bus = new EventBus();

/**
 * Convenience: publish a log event. Called from logger.js.
 */
export function publishLog({ level, message, timestamp, ctx }) {
  bus.publish('log', { level, message, timestamp, ...ctx });
}

/**
 * Convenience: publish a file update.
 */
export function publishFileUpdate(fileRow) {
  bus.publish('file-update', fileRow);
}

/**
 * Convenience: publish a watch update.
 */
export function publishWatchUpdate(watchRow) {
  bus.publish('watch-update', watchRow);
}

/**
 * Convenience: publish an arr update.
 */
export function publishArrUpdate(arrRow) {
  bus.publish('arr-update', arrRow);
}

/**
 * Convenience: publish a settings update.
 */
export function publishSettingsUpdate(patch) {
  bus.publish('settings-update', patch);
}

/**
 * Convenience: publish a coarse-grained status change (e.g. engine on/off).
 */
export function publishStatus(status) {
  bus.publish('status', status);
}
