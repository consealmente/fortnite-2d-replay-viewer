'use strict';
// Public replay processing is expensive. Keep the website open while limiting
// repeated requests from individual visitors and preventing shared-cache deletion.
const requests = new Map();
const WINDOW = 60 * 60 * 1000;
function publicGuard(req, res, next) {
  if (req.method === 'DELETE' && req.path === '/replays') {
    return res.status(403).json({ error: 'Shared replay cache cannot be cleared on the public website.' });
  }
  if (req.method !== 'POST' || req.path !== '/replays') return next();
  const now = Date.now();
  if (requests.size > 10000) for (const [ip, entry] of requests) if (now - entry.start > WINDOW) requests.delete(ip);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let entry = requests.get(ip);
  if (!entry || now - entry.start > WINDOW) entry = { start: now, count: 0 };
  entry.count++;
  requests.set(ip, entry);
  if (entry.count > Number(process.env.REPLAY_REQUESTS_PER_HOUR || 30)) {
    res.setHeader('Retry-After', Math.ceil((WINDOW - (now - entry.start)) / 1000));
    return res.status(429).json({ error: 'Replay request limit reached. Try again later.' });
  }
  next();
}
module.exports = { publicGuard };
