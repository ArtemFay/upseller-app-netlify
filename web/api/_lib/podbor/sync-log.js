// In-memory ring buffer для журнала событий sync engine.
// Любое значимое событие (op queued, flush start/end, append/update, conflict)
// пишется сюда и параллельно в console.
//
// Доступно через GET /api/podbor/sync-log — фронт сможет показывать журнал.

const MAX_EVENTS = 500;
const _ring = [];

export function logEvent(level, channel, message, data) {
  const ev = {
    ts: Date.now(),
    level, // 'info' | 'warn' | 'error'
    channel, // 'queue' | 'flush' | 'sheet' | 'cas' | 'tick'
    message,
    data: data || null,
  };
  _ring.push(ev);
  if (_ring.length > MAX_EVENTS) _ring.shift();

  const tag = `[podbor:${channel}]`;
  if (level === 'error') console.error(tag, message, data || '');
  else if (level === 'warn') console.warn(tag, message, data || '');
  else console.log(tag, message, data || '');
}

export function getEvents({ since = 0, limit = 200 } = {}) {
  const filtered = since ? _ring.filter(e => e.ts > since) : _ring;
  return filtered.slice(-limit);
}

export function clearLog() { _ring.length = 0; }
