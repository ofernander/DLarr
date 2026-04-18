// DLarr — /stream SSE endpoint
//
// One long-lived HTTP connection per connected browser tab. Every event
// published to the bus is forwarded to every subscriber as a separate
// `data:` line.
//
// Wire format:
//   data: {"type":"...","timestamp":"...","payload":{...}}\n\n
//
// Heartbeat: we send a ":keepalive" comment every 20s so proxies don't
// time the connection out. Comments are ignored by EventSource clients.
//
// Fastify's reply.raw is the underlying Node ServerResponse. We use it
// directly since we need the raw socket to stream indefinitely.

import { bus } from '../events.js';

const HEARTBEAT_INTERVAL_MS = 20_000;

export default async function streamRoutes(fastify) {
  fastify.get('/stream', (req, reply) => {
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type':   'text/event-stream',
      'Cache-Control':  'no-cache, no-transform',
      'Connection':     'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx proxy buffering if present
    });

    // Initial hello so the client knows the stream is alive immediately
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    let closed = false;

    const unsubscribe = bus.subscribe((event) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // If write fails, connection is dead; cleanup will fire from 'close'
      }
    });

    const heartbeat = setInterval(() => {
      if (closed) return;
      try { res.write(`: keepalive\n\n`); }
      catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Fastify expects either a return value or explicit reply. We already
    // called res.writeHead, so mark the reply as hijacked.
    reply.hijack();
  });
}
