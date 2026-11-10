'use strict';

function normalizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

function chooseResult(local, server) {
  // A replay with no positively matched player does NOT mean zero chests.
  if (server?.playerResolved && Number.isInteger(server.count)
      && (!local.playerResolved || !Number.isInteger(local.count)
          || server.count >= local.count)) {
    return { source: 'server', data: server };
  }
  return { source: 'local', data: local };
}

module.exports = { normalizeSessionId, chooseResult };
