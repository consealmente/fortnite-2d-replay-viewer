'use strict';

const DAY_MS = 86400000;

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function formatMatch(item, type, key) {
  const chestCount = integer(item.chestCount);
  return {
    id: type + ':' + key,
    fileName: item.fileName || key,
    sessionId: item.matchCode || item.sessionId || null,
    player: item.playerName || item.playerEpicId || 'Recording player',
    playerEpicId: item.playerEpicId || null,
    recordedAt: item.recordedAt || (item.mtimeMs ? new Date(item.mtimeMs).toISOString() : item.scannedAt || null),
    chestCount,
    expectedCount: integer(item.expectedCount),
    source: item.source || 'local',
    localChestCount: integer(item.localChestCount),
    serverChestCount: integer(item.serverChestCount),
    serverAttempt: item.serverAttempt || null,
    events: Array.isArray(item.chestEvents) ? item.chestEvents : [],
    warnings: Array.isArray(item.warnings) ? item.warnings : [],
    status: item.status || 'done',
    error: item.error || null,
    origin: type,
  };
}

function summarize(history, imports, now = new Date()) {
  const gathered = [];
  for (const [file, entry] of Object.entries(history?.matches || {})) {
    if (entry && entry.status === 'done') gathered.push(formatMatch({fileName:file, ...entry}, 'watch', file));
  }
  for (const [id, entry] of Object.entries(imports?.matches || {})) {
    if (entry && entry.status === 'done') gathered.push(formatMatch(entry, 'import', id));
  }

  // Duplicates may arise when a replay is saved/renamed or imported manually
  // after the watcher processed it. Avoid inflating aggregate chest totals.
  const unique = new Map();
  for (const match of gathered) {
    const key = match.sessionId && match.playerEpicId
      ? 'session:' + match.sessionId.toLowerCase() + ':' + match.playerEpicId.toLowerCase()
      : match.sessionId
        ? 'session:' + match.sessionId.toLowerCase() + ':' + match.player.toLowerCase()
        : match.origin + ':' + match.fileName.toLowerCase();
    const prior = unique.get(key);
    if (!prior || (match.chestCount ?? -1) > (prior.chestCount ?? -1)
      || ((match.chestCount ?? -1) === (prior.chestCount ?? -1)
        && match.origin === 'import' && prior.origin !== 'import')) unique.set(key, match);
  }

  const matches = [...unique.values()]
    .sort((a, b) => (Date.parse(b.recordedAt || '') || 0) - (Date.parse(a.recordedAt || '') || 0));
  const valid = matches.filter(m => m.chestCount !== null);
  const all = valid.map(m => m.chestCount);
  const total = all.reduce((a, b) => a + b, 0);
  const todayKey = localDay(now);
  const today = valid.filter(m => localDay(new Date(m.recordedAt || 0)) === todayKey)
    .reduce((n, m) => n + m.chestCount, 0);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDay(date);
    const count = valid.filter(m => localDay(new Date(m.recordedAt || 0)) === key)
      .reduce((n, m) => n + m.chestCount, 0);
    days.push({ date: key, label: date.toLocaleDateString('en-US',{month:'short',day:'numeric'}), count });
  }

  return {
    summary: {
      total, today, matches: valid.length,
      best: Math.max(0, ...all),
      average: valid.length ? Math.round(total / valid.length * 10) / 10 : 0,
      unknown: matches.length - valid.length,
      duplicatesExcluded: gathered.length - unique.size
    },
    days, matches
  };
}

function localDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  return year + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}

function csvExport(matches) {
  const columns = ['Date','File','Player','Session ID','Chests','Expected','Source','Local count','Server count'];
  const safe = value => {
    let v = value == null ? '' : String(value);
    if (/^[=+\-@]/.test(v)) v = "'" + v;
    return '"' + v.replace(/"/g,'""') + '"';
  };
  return [columns.map(safe).join(','), ...matches.map(m => [
    m.recordedAt,m.fileName,m.player,m.sessionId,m.chestCount,m.expectedCount,
    m.source,m.localChestCount,m.serverChestCount].map(safe).join(','))].join('\r\n')+'\r\n';
}

module.exports = { summarize, formatMatch, csvExport, localDay };
