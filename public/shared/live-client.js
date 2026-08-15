/**
 * live-client.js — browser side of the realtime SSE feed (/api/live).
 *
 * Uses fetch + ReadableStream instead of the EventSource API because the
 * feed is staff-only and the JWT must ride the Authorization header, which
 * EventSource cannot set. Auto-reconnects with a fixed backoff; every
 * reconnect gets a fresh `snapshot` event (recent events + online device
 * ids), so boards self-heal after a blip.
 *
 * Exposed as window.SolGridLive.connect({ token, onEvent, onStatus }).
 * onEvent receives { event, data } where data is the parsed payload.
 * Returns { close } to tear the connection down.
 */
window.SolGridLive = (function () {
  const RETRY_MS = 3000;

  function parseFrame(frame) {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  }

  function connect({ token, onEvent, onStatus } = {}) {
    let closed = false;
    let controller = null;
    let retryTimer = null;

    async function open() {
      if (closed) return;
      try {
        controller = new AbortController();
        const res = await fetch('/api/live', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal
        });
        if (!res.ok || !res.body) throw new Error(`live feed HTTP ${res.status}`);
        onStatus && onStatus('open');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseFrame(frame);
            if (ev && !closed) onEvent && onEvent(ev);
          }
        }
      } catch {
        if (!closed) onStatus && onStatus('error');
      }
      if (!closed) {
        onStatus && onStatus('reconnecting');
        retryTimer = setTimeout(open, RETRY_MS);
      }
    }

    open();
    return {
      close() {
        closed = true;
        clearTimeout(retryTimer);
        if (controller) controller.abort();
      }
    };
  }

  return { connect };
})();
