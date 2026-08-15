/**
 * realtime.js — server-sent events (SSE) hub for live dashboards.
 *
 * Replaces the Analysis Board's 60 s polling + simulated KPI jitter and the
 * Engineer panel's 30 s fleet refresh with genuinely live updates: db.js
 * broadcasts at the data choke points (energy inserts, heartbeats, relay
 * toggles, OTA boot reports, alerts) and every connected browser receives
 * the event the moment it lands.
 *
 * Transport notes:
 *  - The browser client uses fetch + ReadableStream (public/shared/
 *    live-client.js), NOT the EventSource API — EventSource can't send the
 *    JWT Authorization header, and the feed is staff-only.
 *  - Delivery is org-scoped: super-admins and engineers (client.orgId null)
 *    see the whole fleet; org admins only receive events whose payload
 *    carries their own orgId. Events without an orgId are global and go to
 *    everyone.
 *  - A bounded ring buffer of recent events is replayed to each new client
 *    as the connect snapshot, so a freshly opened board isn't blank until
 *    the next telemetry tick.
 */

const MAX_RING = 100;
const PING_MS = 25_000;

/** @type {Set<{res: import('express').Response, role: string, orgId: number|null}>} */
const clients = new Set();
/* Ring of recent events, newest last — replayed on connect. */
const ring = [];

/**
 * Register an SSE subscriber. Writes the connection headers, sends the
 * snapshot (recent events + any caller-supplied data), then holds the
 * response open with periodic keep-alive pings until the client disconnects.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{role: string, orgId: number|null, snapshot?: object}} opts
 */
function subscribe(req, res, { role, orgId = null, snapshot = {} } = {}) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  /* The snapshot ring must be scoped the same way live delivery is — an org
     admin must not learn another tenant's events from the replay. */
  const scopedRing = ring.filter(ev => orgId == null || ev.orgId == null || ev.orgId === orgId);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ring: scopedRing, ...snapshot })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone — cleaned below */ }
  }, PING_MS);

  const client = { res, role, orgId };
  clients.add(client);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
  return client;
}

/**
 * Push an event to every matching client. `payload.orgId` (number) scopes
 * a device event to its org; omit it for global events. The full event is
 * appended to the ring so late subscribers get it in their snapshot.
 */
function broadcast(type, payload = {}) {
  const event = { type, ts: new Date().toISOString(), ...payload };
  ring.push(event);
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);

  const frame = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    /* Staff (orgId null) see everything; org admins see their org's events
       plus global ones. */
    if (c.orgId == null || event.orgId == null || c.orgId === event.orgId) {
      try { c.res.write(frame); } catch { /* disconnected — cleaned on close */ }
    }
  }
}

/** Test hook — how many live subscribers are connected. */
function clientCount() {
  return clients.size;
}

module.exports = { subscribe, broadcast, clientCount };
