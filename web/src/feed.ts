import { useEffect } from 'react';
import { token } from './api.ts';

export type Tick = { symbol: string; price: number };
type Handler = (ticks: Tick[], at: number) => void;

// One socket for the whole app, however many components are listening. It opens on the
// first subscriber and closes after the last one leaves.
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function connect() {
  const t = token.get();
  if (!t || ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/feed`);
  ws = socket;

  // The server sends nothing until this arrives; a token in the URL would be logged.
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: t }));

  socket.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === 'ready') attempt = 0;
    if (msg.type === 'tick') for (const h of handlers) h(msg.ticks, msg.at);
  };

  socket.onclose = () => {
    // A socket we already replaced is closing (React re-runs effects, so subscribe and
    // unsubscribe churn on mount). Ignore it, or it schedules a second live socket and
    // every tick arrives twice.
    if (ws !== socket) return;
    ws = null;
    if (!handlers.size || retry) return;
    // Back off on repeated failures so a dead server isn't hammered.
    retry = setTimeout(() => { retry = null; connect(); }, Math.min(30_000, 1000 * 2 ** attempt++));
  };
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  connect();
  return () => {
    handlers.delete(handler);
    if (!handlers.size) {
      const dead = ws;
      ws = null;
      dead?.close();
      if (retry) { clearTimeout(retry); retry = null; }
    }
  };
}

/** Subscribe for the lifetime of a component. */
export function useFeed(handler: Handler, deps: unknown[]) {
  useEffect(() => subscribe(handler), deps);
}
