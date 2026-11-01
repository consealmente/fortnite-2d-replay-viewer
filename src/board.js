'use strict';

/* ============================================================================
   The "board": a Trello-style home screen persisted server-side.

     { categories: [ { id, name, collapsed, games: [ { id, code, label,
                                                       meta, addedAt } ] } ] }

   The client owns the model and PUTs the whole document (debounced). This
   module just validates/clamps the shape and writes it atomically. One file,
   one local user -- no locking, no history.
   ==========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOARD_PATH = path.join(DATA_DIR, 'board.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const HEX32 = /^[0-9a-f]{32}$/;
const MAX_CATEGORIES = 300;
const MAX_GAMES_PER_CATEGORY = 800;

function newId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function clampMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  if (typeof m.playlist === 'string') out.playlist = m.playlist.slice(0, 80);
  if (Number.isFinite(m.lengthMs)) out.lengthMs = m.lengthMs;
  if (typeof m.date === 'string') out.date = m.date.slice(0, 40);
  if (Number.isFinite(m.players)) out.players = m.players;
  if (Number.isFinite(m.placement)) out.placement = m.placement;
  return Object.keys(out).length ? out : null;
}

/** Coerce whatever the client sent into a safe, well-formed board document. */
function sanitize(doc) {
  const rawCats = Array.isArray(doc && doc.categories) ? doc.categories : [];
  const usedIds = new Set();
  const takeId = (raw, prefix) => {
    let id = str(raw, 40);
    if (!id || usedIds.has(id)) id = newId(prefix);
    usedIds.add(id);
    return id;
  };

  const categories = rawCats.slice(0, MAX_CATEGORIES).map((c) => {
    const games = (Array.isArray(c && c.games) ? c.games : [])
      .slice(0, MAX_GAMES_PER_CATEGORY)
      .map((g) => {
        const code = str(g && g.code, 64).toLowerCase().replace(/[^0-9a-f]/g, '');
        if (!HEX32.test(code)) return null;
        return {
          id: takeId(g && g.id, 'g_'),
          code,
          label: str(g && g.label, 120).trim() || 'Game',
          meta: clampMeta(g && g.meta),
          addedAt: Number.isFinite(g && g.addedAt) ? g.addedAt : Date.now(),
        };
      })
      .filter(Boolean);

    return {
      id: takeId(c && c.id, 'c_'),
      name: str(c && c.name, 120).trim() || 'Untitled',
      collapsed: !!(c && c.collapsed),
      games,
    };
  });

  return { categories };
}

function getBoard() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')));
  } catch {
    return { categories: [] };
  }
}

function saveBoard(doc) {
  const clean = sanitize(doc);
  const tmp = `${BOARD_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, BOARD_PATH);
  return clean;
}

module.exports = { getBoard, saveBoard };
