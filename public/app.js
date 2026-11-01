'use strict';

/* ============================================================================
   Fortnite 2D replay viewer -- front end.
   Talks to /api, then renders the parsed model on a canvas with playback.
   ==========================================================================*/

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, u) => a + (b - a) * u;
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

/* The map image (Chapter 7 "Hera" island, the current 2048px render from
   fortnite-api.com) and its calibration to build-42 world coordinates. These
   bounds span the image edge-to-edge. The X and Y world spans differ (the map
   render is NOT square in world units) -- calibrating with one scale for both
   axes leaves a drift that grows with distance. Fitted per-axis through two
   user-verified points (Green Hill Zone and a SW launch pad). If Fortnite
   changes the map, re-run Align > 2-point fit (points far apart in BOTH x and
   y) and paste the numbers here. NOTE: the storm `Radius` value is on a
   different scale than positions -- don't derive map scale from it. */
const MAP_SRC = 'maps/hera.png';
const MAP_BOUNDS = { minX: -141696, maxX: 159672, minY: -149469, maxY: 150677 };

/* Death-cause codes -> short labels (EDeathCause). Best-effort; unknowns show
   the number. Only used for the kill feed wording. */
const DEATH_CAUSE = {
  0: 'default', 1: 'fall', 2: 'pistol', 3: 'shotgun', 4: 'AR', 5: 'SMG', 6: 'sniper',
  7: 'melee', 8: 'explosive', 14: 'storm', 15: 'fall', 22: 'melee', 23: 'bleed out',
  24: 'gas', 25: 'trap', 34: 'car', 41: 'DBNO timeout',
};

let model = null;
let mapImg = new Image();
let mapReady = false;

/* ---------------------------------------------------------------------------
   Loading a replay -- shared by the board (board.js) and #<code> deep links.
   The home screen itself (the board) lives in board.js.
   ------------------------------------------------------------------------- */
let loadingCode = null;

async function readApiJson(response) {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch (_) {
    throw new Error(response.ok
      ? 'The replay server returned an invalid response.'
      : 'The replay server failed (HTTP ' + response.status + '). It may have reached its memory or execution limit.');
  }
  if (!response.ok) throw new Error(data.error || 'Replay server failed (HTTP ' + response.status + ').');
  return data;
}

async function startLoad(rawCode) {
  const code = String(rawCode || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!/^[0-9a-f]{32}$/.test(code)) {
    (window.Board?.showError || alert)('That code should be 32 hex characters.');
    return;
  }
  if (loadingCode) return; // one at a time
  loadingCode = code;
  $('home-error').hidden = true;
  $('loading').hidden = false;
  setLoading(2, 'Requesting…');

  try {
    const r = await fetch('/api/replays', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const j = await readApiJson(r);
    if (!r.ok) throw new Error(j.error || 'request failed');
    if (!j.status) {
      // Vercel completes the replay in one request; no cross-instance polling.
      j.__code = code;
      enterViewer(j);
      return;
    }

    // Poll
    for (;;) {
      const s = await fetch(`/api/replays/${code}/status`).then(readApiJson);
      setLoading(s.progress, phaseLabel(s));
      if (s.status === 'done') break;
      if (s.status === 'error') throw new Error(s.error || 'parse failed');
      await new Promise((res) => setTimeout(res, 700));
    }

    setLoading(100, 'Loading model…');
    const m = await fetch(`/api/replays/${code}/model`).then(readApiJson);
    m.__code = code;
    enterViewer(m);
  } catch (err) {
    $('loading').hidden = true;
    loadingCode = null;
    (window.Board?.showError || alert)(String(err.message || err));
  }
}
window.startLoad = startLoad;

function phaseLabel(s) {
  if (s.status === 'downloading') return `Downloading replay… ${s.progress}%`;
  if (s.status === 'parsing') return s.progress < 16
    ? 'Building the parser (first run only, ~30–60s)…'
    : `Parsing replay… ${s.progress}%`;
  return s.phase || s.status;
}
function setLoading(pct, text) {
  $('loading-bar').style.width = `${clamp(pct, 0, 100)}%`;
  $('loading-phase').textContent = text;
}
$('loading-cancel').onclick = () => location.reload();

// Deep link: #<code> -- on first load and whenever the hash changes to a code
// while we're still on the home screen.
function tryHashLoad() {
  const h = location.hash.replace('#', '').trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(h) && $('viewer').hidden) startLoad(h);
}
tryHashLoad();
window.addEventListener('hashchange', tryHashLoad);

/* ---------------------------------------------------------------------------
   Viewer
   ------------------------------------------------------------------------- */
const cv = $('stage');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;

const cam = { x: 0, y: 0, zoom: 1 };
let cal = null; // {ox, oy, wppu, flipX, flipY, hide}
const play = { t: 0, playing: false, speed: 1, follow: null };
let selected = null;
let hovered = null;
let calibrating = false;
const ui = { names: false };

// v3: new (larger, sharper) map image + recalibrated default -- ignore older
// saved values. v4: calibration gained separate x/y scales (wppuX, wppuY).
function calKey() { return 'fn2d.cal.v4.' + (model?.meta?.build || 'default'); }
function loadCal() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(calKey()) || 'null'); } catch {}
  if (c && Number.isFinite(c.wppuX) && Number.isFinite(c.wppuY)) return c;
  return defaultCal();
}
function defaultCal() {
  const iw = mapImg.naturalWidth || 2048;
  const ih = mapImg.naturalHeight || 2048;
  const b = MAP_BOUNDS;
  return {
    ox: (b.minX + b.maxX) / 2,
    oy: (b.minY + b.maxY) / 2,
    wppuX: (b.maxX - b.minX) / iw,
    wppuY: (b.maxY - b.minY) / ih,
    flipX: false, flipY: false, hide: false,
  };
}
function saveCal() { try { localStorage.setItem(calKey(), JSON.stringify(cal)); } catch {} }

function enterViewer(m) {
  model = m;
  window.MODEL = m; // handy for debugging
  window.DBG = { get cam() { return cam; }, get cal() { return cal; }, get play() { return play; },
    get selected() { return selected; }, get ui() { return ui; },
    stormAt: (t) => stormAt(t), posAt: (p, t) => posAt(p, t), worldToScreen,
    pick: (sx, sy) => pickPlayer(sx, sy), select: (p) => selectPlayer(p),
    swap: (dir) => swapTeammate(dir),
    render: () => { try { frame(performance.now()); } catch (e) { console.error(e); } },
    lockView: (x, y, z) => { framePending = false; cam.x = x; cam.y = y; cam.zoom = z; } };

  // Index / normalize
  m.players.forEach((p) => {
    p.endT = p.track.length ? p.track[p.track.length - 1][0] : 0;
    // "gone" = eliminated, or (no death recorded) the moment their data stops.
    p.goneT = p.death ? p.death.t : p.endT + 2;
    p.spawnT = p.track.length ? p.track[0][0] : Infinity;
  });
  m.storm.sort((a, b) => a.startShrink - b.startShrink);

  // Cumulative damage-taken track per player (needs storm + tracks, both ready).
  m.players.forEach((p) => { p.dmg = computeDamage(p); });

  // Team grouping. `team` is the replay's TeamIndex. Bots are dropped from the
  // viewer entirely (they're AI filler, not players).
  m.roster = m.players.filter((p) => !p.isBot);
  m.botIds = new Set(m.players.filter((p) => p.isBot).map((p) => p.id));
  m.teams = new Map();
  for (const p of m.roster) {
    const key = p.team ?? -1;
    if (!m.teams.has(key)) m.teams.set(key, []);
    m.teams.get(key).push(p);
  }
  m.maxTeamSize = Math.max(1, ...[...m.teams.values()].map((a) => a.length));
  m.isSolo = m.maxTeamSize <= 1 || /solo/i.test(m.meta.playlist || '');

  $('home').hidden = true;
  $('loading').hidden = true;
  loadingCode = null;
  $('viewer').hidden = false;

  cal = loadCal();
  play.t = m.time.start;
  play.playing = false;
  selected = null;

  $('mi-playlist').textContent = prettyPlaylist(m.meta.playlist);
  $('t-tot').textContent = fmtTime(m.time.end - m.time.start);
  $('scrub').max = String(Math.round((m.time.end - m.time.start) * 10));

  model.bus = computeBus(m);
  renderTimelineMarks();

  resize();
  frameFit();
  requestAnimationFrame(loop);
  // Autoplay a touch after the first drop.
  setPlaying(true);

  // Feed what we just learned back to the board card (playlist, length, date).
  if (m.__code && window.Board) {
    window.Board.enrich(m.__code, {
      playlist: prettyPlaylist(m.meta.playlist),
      lengthMs: Number.isFinite(m.meta.lengthMs) ? m.meta.lengthMs : null,
      date: m.meta.utcMatchStart || m.meta.recordedUtc || null,
      players: Number.isFinite(m.meta.playerCount) ? m.meta.playerCount : null,
    });
  }
}

function prettyPlaylist(s) {
  if (!s) return 'Replay';
  return s.replace(/^Playlist_?/, '').replace(/_/g, ' ').replace(/\bFN\b/g, '').replace(/\s+/g, ' ').trim();
}

/* ---- sizing / camera ---- */
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);

function worldToScreen(x, y) {
  return [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
}
function screenToWorld(sx, sy) {
  return [(sx - W / 2) / cam.zoom + cam.x, (sy - H / 2) / cam.zoom + cam.y];
}

/* Fit the view to the initial storm circle with a little margin. */
let framePending = false;
function frameFit() {
  if (W <= 1 || H <= 1) { framePending = true; return; }
  framePending = false;
  // Fit the map image (plus a little margin) into the view.
  const mw = (mapImg.naturalWidth || 2048) * cal.wppuX;
  const mh = (mapImg.naturalHeight || 2048) * cal.wppuY;
  cam.x = cal.ox;
  cam.y = cal.oy;
  cam.zoom = Math.min(W / (mw * 1.04), H / (mh * 1.04));
}

/* ---------------------------------------------------------------------------
   Storm geometry at a given match-clock time
   ------------------------------------------------------------------------- */
function stormAt(t) {
  const ph = model.storm;
  if (!ph.length) return null;

  // Current (enforced) circle: piecewise between keyframes.
  let cur = { x: ph[0].center[0], y: ph[0].center[1], r: ph[0].radius };
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i];
    if (t <= p.startShrink) break;
    if (t >= p.finishShrink) {
      cur = { x: p.nextCenter[0], y: p.nextCenter[1], r: p.nextRadius };
      continue;
    }
    const u = (t - p.startShrink) / (p.finishShrink - p.startShrink);
    cur = {
      x: lerp(p.center[0], p.nextCenter[0], u),
      y: lerp(p.center[1], p.nextCenter[1], u),
      r: lerp(p.radius, p.nextRadius, u),
    };
    break;
  }

  // Next circle preview + timer: the first phase not yet finished.
  let next = null, timerTo = null, shrinking = false, phaseNo = ph.length;
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i];
    if (t < p.finishShrink) {
      next = { x: p.nextCenter[0], y: p.nextCenter[1], r: p.nextRadius };
      phaseNo = p.phase;
      if (t < p.startShrink) { timerTo = p.startShrink - t; shrinking = false; }
      else { timerTo = p.finishShrink - t; shrinking = true; }
      break;
    }
  }
  return { cur, next, timerTo, shrinking, phaseNo };
}

/* ---------------------------------------------------------------------------
   Battle bus -- inferred. Build-42 replays don't replicate the aircraft, but
   every player's highest-altitude sample right after their track starts sits
   on the bus at the moment they jumped. The bus flies a straight line at a
   constant speed, so a linear fit of x(t) and y(t) through those points
   reconstructs the whole flight path (fits at r^2 ~ 1.0 in practice).
   ------------------------------------------------------------------------- */
function linFit(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  let st = 0, sv = 0, stt = 0, stv = 0;
  for (const [t, v] of pairs) { st += t; sv += v; stt += t * t; stv += t * v; }
  const denom = n * stt - st * st;
  if (Math.abs(denom) < 1e-9) return null;
  const m = (n * stv - st * sv) / denom;
  return { m, c: (sv - m * st) / n };
}

function computeBus(m) {
  const pts = [];
  for (const p of m.players) {
    const tr = p.track;
    if (!tr || !tr.length) continue;
    const cut = tr[0][0] + 6;
    let hi = tr[0];
    for (const s of tr) { if (s[0] > cut) break; if (s[3] > hi[3]) hi = s; }
    pts.push(hi); // [t, x, y, z, flags, yaw]
  }
  if (pts.length < 6) return null;

  // Keep only the samples near bus altitude (drop anyone already gliding low,
  // or auto-dropped at the end of the route).
  const maxZ = Math.max(...pts.map((p) => p[3]));
  const near = pts.filter((p) => p[3] > maxZ - 12000);
  const ts = near.map((p) => p[0]);
  if (near.length < 5 || Math.max(...ts) - Math.min(...ts) < 3) return null;

  const fx = linFit(near.map((p) => [p[0], p[1]]));
  const fy = linFit(near.map((p) => [p[0], p[2]]));
  if (!fx || !fy) return null;
  const speed = Math.hypot(fx.m, fy.m);
  if (speed < 2000 || speed > 20000) return null; // Fortnite bus ~7500 u/s

  // Time range while the bus is over a generously padded map rectangle
  // (parametric slab clip). One axis can be near-flat -> its bounds go to
  // +/-Infinity and the other axis constrains, which is correct.
  const b = MAP_BOUNDS, pad = 70000;
  const sx = [(b.minX - pad - fx.c) / fx.m, (b.maxX + pad - fx.c) / fx.m].sort((a, c) => a - c);
  const sy = [(b.minY - pad - fy.c) / fy.m, (b.maxY + pad - fy.c) / fy.m].sort((a, c) => a - c);
  const tIn = Math.max(sx[0], sy[0]);
  const tOut = Math.min(sx[1], sy[1]);
  if (!Number.isFinite(tIn) || !Number.isFinite(tOut) || tOut <= tIn) return null;

  return {
    at: (t) => [fx.m * t + fx.c, fy.m * t + fy.c],
    tIn, tOut, speed,
    heading: Math.atan2(fy.m, fx.m),
  };
}

function drawBus() {
  const bus = model.bus;
  if (!bus) return;
  const t = play.t;

  // Flight path: visible while the bus flies and briefly after it leaves.
  if (t < bus.tOut + 45) {
    const [ax, ay] = bus.at(bus.tIn);
    const [bx, by] = bus.at(bus.tOut);
    const [x0, y0] = worldToScreen(ax, ay);
    const [x1, y1] = worldToScreen(bx, by);
    ctx.save();
    ctx.setLineDash([3, 8]);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = 'rgba(255, 221, 138, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // The bus itself, only while it's actually crossing the map.
  if (t < bus.tIn || t > bus.tOut) return;
  const [wx, wy] = bus.at(t);
  const [sx, sy] = worldToScreen(wx, wy);

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(bus.heading); // local +x = direction of travel
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.roundRect(-13, -5.5, 26, 11, 3);
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.stroke();
  ctx.beginPath(); // nose
  ctx.moveTo(13, -5.5); ctx.lineTo(18.5, 0); ctx.lineTo(13, 5.5); ctx.closePath();
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.font = '600 10px system-ui';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText('BUS', sx, sy - 12);
  ctx.fillStyle = 'rgba(255, 238, 190, 0.95)';
  ctx.fillText('BUS', sx, sy - 12);
}

/* ---------------------------------------------------------------------------
   Track sampling
   ------------------------------------------------------------------------- */
function posAt(p, t) {
  const tr = p.track;
  if (!tr.length || t < tr[0][0] || t > p.endT) return null;
  // binary search
  let lo = 0, hi = tr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tr[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  const a = tr[lo], b = tr[Math.min(lo + 1, tr.length - 1)];
  const span = b[0] - a[0];
  const u = span > 0 ? clamp((t - a[0]) / span, 0, 1) : 0;
  return {
    x: lerp(a[1], b[1], u),
    y: lerp(a[2], b[2], u),
    z: lerp(a[3], b[3], u),
    flags: a[4],
    yaw: a[5],
  };
}

/* Health/shield at time t: {hp, shield} or null. Step function (no interp). */
function hpAt(p, t) {
  if (!p.hp || !p.hp.length || t < p.hp[0][0]) return null;
  let lo = 0, hi = p.hp.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.hp[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return { hp: p.hp[lo][1], shield: p.hp[lo][2] };
}

function isAlive(p, t) { return t >= p.spawnT && t < p.goneT; }

function aliveCount(t) {
  let n = 0;
  for (const p of model.roster) if (isAlive(p, t)) n++;
  return n;
}

function teamsAlive(t) {
  const s = new Set();
  for (const p of model.roster) if (isAlive(p, t)) s.add(p.team ?? -1);
  return s.size;
}

/* Is (wx,wy) outside the enforced wall at time t? */
function inStormAt(wx, wy, t) {
  const st = stormAt(t);
  if (!st || !(st.cur.r > 0)) return false;
  return Math.hypot(wx - st.cur.x, wy - st.cur.y) > st.cur.r;
}

/* Alive players inside the wall vs caught in the storm, at time t. */
function zoneCensus(t) {
  let inZone = 0, inStorm = 0;
  for (const p of model.roster) {
    if (!isAlive(p, t)) continue;
    const pos = posAt(p, t);
    if (pos && inStormAt(pos.x, pos.y, t)) inStorm++;
    else inZone++;
  }
  return { inZone, inStorm, total: inZone + inStorm };
}

/* Per-player cumulative damage taken over the match: [t, cumTotal, cumStorm].
   Storm damage = a health-only drop (shield untouched, ≤12) while the player is
   outside the wall. Each step is capped so a corrupt health sample can't blow
   the running total up. Precomputed once in enterViewer; dmgAt() reads it. */
function computeDamage(p) {
  const out = [];
  const hp = p.hp;
  if (!hp || hp.length < 2) return out;
  let total = 0, storm = 0;
  for (let i = 1; i < hp.length; i++) {
    const t0 = hp[i - 1][0], t1 = hp[i][0];
    if (t1 - t0 > 30) continue; // data gap — don't attribute a drop across it
    const dHp = Math.max(0, hp[i - 1][1] - hp[i][1]);
    const dSh = Math.max(0, hp[i - 1][2] - hp[i][2]);
    const step = Math.min(dHp, 120) + Math.min(dSh, 120);
    if (step <= 0) continue;

    let stormStep = 0;
    if (dHp > 0 && dSh <= 0.5 && dHp <= 12) {
      const pos = posAt(p, t1);
      if (pos && inStormAt(pos.x, pos.y, t1)) stormStep = Math.min(dHp, 12);
    }
    total += step;
    storm += stormStep;
    out.push([t1, total, storm]);
  }
  return out;
}

function dmgAt(p, t) {
  const a = p.dmg;
  if (!a || !a.length || t < a[0][0]) return { total: 0, storm: 0 };
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m][0] <= t) lo = m; else hi = m - 1; }
  return { total: a[lo][1], storm: a[lo][2] };
}

/* ---------------------------------------------------------------------------
   Render loop
   ------------------------------------------------------------------------- */
let lastTs = 0;
let loopErr = 0;
let running = false;
function loop(ts) {
  running = true;
  requestAnimationFrame(loop);
  try {
    frame(ts);
  } catch (e) {
    if (loopErr++ < 3) console.error('render frame error:', e);
  }
}
// requestAnimationFrame is parked while the tab is hidden. Keep a slow fallback
// tick so a hidden/blurred viewer still updates (and un-freezes on return).
setInterval(() => {
  if (document.hidden || performance.now() - lastTs > 250) {
    try { frame(performance.now()); } catch (e) { /* logged in loop() */ }
  }
}, 200);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lastTs = performance.now(); if (!running) requestAnimationFrame(loop); }
});
function frame(ts) {
  if (!model) return;
  const real = (ts - lastTs) / 1000 || 0;
  lastTs = ts;
  // Cap the step so a background pause (rAF throttled/parked) doesn't fast-forward
  // playback to "catch up" -- at most 0.1s of replay per rendered frame.
  const dt = Math.min(real, 0.1);

  if (play.playing) {
    play.t += dt * play.speed;
    if (play.t >= model.time.end) { play.t = model.time.end; setPlaying(false); }
  }
  if (framePending) frameFit();
  if (play.follow) {
    const pos = posAt(play.follow, play.t);
    if (pos) { cam.x = lerp(cam.x, pos.x, 0.15); cam.y = lerp(cam.y, pos.y, 0.15); }
  } else if (play.playing) {
    // Gently keep the fight in frame while watching: if the current storm
    // circle has drifted fully out of view, ease back toward it.
    const s = stormAt(play.t);
    if (s) {
      const [sx, sy] = worldToScreen(s.cur.x, s.cur.y);
      const rs = s.cur.r * cam.zoom;
      if (sx + rs < 0 || sx - rs > W || sy + rs < 0 || sy - rs > H) {
        cam.x = lerp(cam.x, s.cur.x, 0.04);
        cam.y = lerp(cam.y, s.cur.y, 0.04);
      }
    }
  }

  render();
  updateHud();
}

function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, W, H);

  drawMap();
  const storm = stormAt(play.t);
  if (storm) drawStorm(storm);
  drawBus();
  drawPlayers();
  drawDeaths();
}

function drawMap() {
  if (cal.hide || !mapReady) return;
  const iw = mapImg.naturalWidth, ih = mapImg.naturalHeight;
  const wW = iw * cal.wppuX, wH = ih * cal.wppuY;
  const [sx, sy] = worldToScreen(cal.ox - wW / 2, cal.oy - wH / 2);
  const sw = wW * cam.zoom, sh = wH * cam.zoom;
  ctx.save();
  ctx.globalAlpha = calibrating ? 0.85 : 1;
  if (cal.flipX || cal.flipY) {
    ctx.translate(sx + (cal.flipX ? sw : 0), sy + (cal.flipY ? sh : 0));
    ctx.scale(cal.flipX ? -1 : 1, cal.flipY ? -1 : 1);
    ctx.drawImage(mapImg, 0, 0, sw, sh);
  } else {
    ctx.drawImage(mapImg, sx, sy, sw, sh);
  }
  ctx.restore();
}

function drawStorm({ cur, next }) {
  const [cxs, cys] = worldToScreen(cur.x, cur.y);
  const rs = Math.max(0, cur.r * cam.zoom);

  // Darken + tint everything outside the current circle.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(cxs, cys, rs, 0, Math.PI * 2, true); // reverse winding -> hole
  ctx.fillStyle = 'rgba(150, 50, 195, 0.26)';
  ctx.fill('evenodd');
  ctx.restore();

  // Current wall, with a faint outer glow.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cxs, cys, rs, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(210, 130, 255, 0.35)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(240, 225, 255, 0.95)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();

  // Next circle (where the wall will close to). Dark backing stroke first so
  // the dashes read clearly over bright terrain, then a bold cyan line on top.
  if (next && next.r > 0) {
    const [nxs, nys] = worldToScreen(next.x, next.y);
    const nr = next.r * cam.zoom;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.arc(nxs, nys, nr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(3, 16, 32, 0.75)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#3db4ff';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.restore();
  }
}

/* Stable colour per team index. Evenly-spread hues; the golden-angle step keeps
   adjacent team numbers visually distinct. */
const teamColorCache = new Map();
function teamColor(team) {
  const key = team ?? -1;
  let c = teamColorCache.get(key);
  if (!c) {
    const hue = (key * 137.508) % 360;
    c = `hsl(${hue.toFixed(0)}, 62%, 60%)`;
    teamColorCache.set(key, c);
  }
  return c;
}

function drawPlayers() {
  const t = play.t;
  const selTeam = selected ? selected.team : null;
  for (const p of model.roster) {
    if (t >= p.goneT) continue;
    const pos = posAt(p, t);
    if (!pos) continue;
    const [sx, sy] = worldToScreen(pos.x, pos.y);
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;

    const sel = p === selected;
    const hov = p === hovered;
    const mate = !sel && selTeam != null && p.team === selTeam;
    const airborne = pos.flags & 2 || pos.flags & 4 || pos.flags & 16; // skydive / chute / bus
    const dbno = pos.flags & 1;
    const r = sel ? 6 : mate ? 4.7 : 3.9;
    const ang = ((pos.yaw || 0) * Math.PI) / 180 + Math.PI / 2; // Unreal yaw -> canvas

    const col = teamColor(p.team);

    // selected / teammate halo (a ring, drawn before rotating)
    if (sel || mate) {
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2 + (sel ? 3 : 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = sel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.stroke();
    }

    // the player: a dart pointing where they're facing
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);

    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 3;
    tracePlayerMarker(r);
    ctx.globalAlpha = airborne ? 0.5 : 1; // airborne reads faint
    ctx.fillStyle = col;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    if (dbno) {
      // knocked: an orange wash over the team colour + a bold orange outline.
      tracePlayerMarker(r);
      ctx.fillStyle = 'rgba(255, 140, 55, 0.5)';
      ctx.fill();
    }

    tracePlayerMarker(r);
    ctx.lineWidth = dbno ? 1.8 : 1.1;
    ctx.strokeStyle = dbno ? '#ff7a1a' : 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.restore();

    const showName = sel || hov || mate || (ui.names && cam.zoom > 0.006);
    if (showName) {
      const ny = sy - r * 2 - 6;
      ctx.font = sel ? '600 12px system-ui' : '11px system-ui';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(p.name, sx, ny);
      ctx.fillStyle = sel ? '#fff' : mate ? '#e7ecf3' : 'rgba(231,236,243,0.85)';
      ctx.fillText(p.name, sx, ny);
    }
  }
}

/* A player marker: a dart pointing along local -y (the caller rotates it to the
   player's yaw). Concave tail so the direction reads at a glance. */
function tracePlayerMarker(r) {
  ctx.beginPath();
  ctx.moveTo(0, -r * 2.0);      // nose
  ctx.lineTo(r * 1.3, r * 1.4); // right wing
  ctx.lineTo(0, r * 0.5);       // tail notch
  ctx.lineTo(-r * 1.3, r * 1.4); // left wing
  ctx.closePath();
}

/* Bots / AI filler don't count. Their victim id is in model.botIds and the
   parser names them "Bot" -- either match means "skip this kill-feed row". */
function isBotEvent(e) {
  return model.botIds.has(e.victim) || e.victimName === 'Bot';
}

function drawDeaths() {
  const t = play.t;
  for (const e of model.events) {
    if (e.x == null || isBotEvent(e)) continue;
    const age = t - e.t;
    if (age < 0 || age > 6) continue;
    const [sx, sy] = worldToScreen(e.x, e.y);
    const a = 1 - age / 6;
    ctx.globalAlpha = a;
    ctx.fillStyle = e.downed ? '#ffb03d' : '#ff5964';
    ctx.beginPath();
    ctx.arc(sx, sy, 3 + (1 - a) * 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------------------------------------------------------
   HUD
   ------------------------------------------------------------------------- */
function updateHud() {
  const rel = play.t - model.time.start;
  $('t-cur').textContent = fmtTime(rel);
  if (!scrubbing) $('scrub').value = String(Math.round(rel * 10));
  $('mi-alive').textContent = String(aliveCount(play.t));
  $('mi-teams').textContent = model.isSolo ? '' : `${teamsAlive(play.t)} teams`;

  const storm = stormAt(play.t);
  if (storm) {
    $('zi-phase').textContent = storm.shrinking ? `Zone ${storm.phaseNo} closing` : `Zone ${storm.phaseNo}`;
    const timerEl = $('zi-timer');
    timerEl.textContent = storm.timerTo != null ? fmtTime(storm.timerTo) : '—';
    timerEl.className = 'timer' + (storm.shrinking ? ' shrinking' : storm.timerTo < 20 ? ' warn' : '');
  }

  // kill feed: show events up to now, keep last 6
  renderFeed();
  if (selected) renderPanel();
  if (statsOpen) renderStats();
}

function renderFeed() {
  const recent = model.events.filter((e) => e.t <= play.t && e.victimName && !isBotEvent(e)).slice(-6);
  const box = $('killfeed');
  const sig = recent.map((e) => e.t + '|' + e.victim).join(',');
  if (box._sig === sig) return;
  box._sig = sig;
  box.innerHTML = '';
  recent.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const cause = DEATH_CAUSE[e.cause] || '';
    const selfOrEnv = !e.killerName || e.killer === e.victim || e.killer == null;
    const left = selfOrEnv
      ? `<span class="v">${esc(cause || 'storm')}</span>`
      : `<span class="k">${esc(e.killerName)}</span>`;
    row.innerHTML =
      left +
      `<span class="ico">${e.downed ? '▽' : '✕'}</span>` +
      `<span class="k">${esc(e.victimName)}</span>` +
      (!selfOrEnv && e.distance ? `<span class="v">${Math.round(e.distance / 100)}m</span>` : '');
    box.appendChild(row);
  });
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* Ticks under the scrubber: every time a zone finishes closing, and every
   elim / knock by the selected player (build-42 replays don't say who recorded
   the replay, so "my kills" follows whoever you've selected). */
function renderTimelineMarks() {
  const box = $('scrub-marks');
  if (!box || !model) return;
  const t0 = model.time.start;
  const span = (model.time.end - t0) || 1;
  const pct = (t) => (100 * (t - t0)) / span;
  const marks = [];

  for (const ph of model.storm) {
    const ft = ph.finishShrink;
    if (ft > t0 + 1 && ft < model.time.end) {
      marks.push(`<i class="mk mk-zone" style="left:${pct(ft).toFixed(2)}%" title="Zone ${ph.phase} fully closed"></i>`);
    }
  }

  const focus = selected;
  if (focus && focus.id != null) {
    for (const e of model.events) {
      if (e.killer !== focus.id || e.revived || isBotEvent(e)) continue;
      if (e.t <= t0 || e.t >= model.time.end) continue;
      const down = !!e.downed;
      marks.push(
        `<i class="mk mk-${down ? 'down' : 'elim'}" style="left:${pct(e.t).toFixed(2)}%" ` +
        `title="${down ? 'Knocked' : 'Eliminated'} ${esc(e.victimName || 'player')}"></i>`
      );
    }
  }
  box.innerHTML = marks.join('');
}

function renderPanel() {
  const p = selected;
  const panel = $('player-panel');
  panel.hidden = false;
  $('pp-name').textContent = p.name;
  const dead = play.t >= p.goneT;
  panel.style.borderColor = teamColor(p.team);

  const mates = model.teams.get(p.team ?? -1) || [p];
  const matesAlive = mates.filter((m) => isAlive(m, play.t)).length;
  const knocked = !dead && (posAt(p, play.t)?.flags & 1);
  $('pp-sub').textContent =
    (model.isSolo ? '' : `Team ${p.team ?? '?'} · ${matesAlive}/${mates.length} up · `) +
    (dead ? 'eliminated' : knocked ? 'knocked' : 'alive');
  $('pp-sub').style.color = knocked ? '#ff9a4d' : '';
  $('pp-swap').hidden = mates.length < 2;

  const h = dead ? { hp: 0, shield: 0 } : hpAt(p, play.t);
  if (h) {
    $('pp-bars').innerHTML =
      `<div class="hpbar shield"><i style="transform:scaleX(${clamp(h.shield / 100, 0, 1)})"></i></div>` +
      `<div class="hpbar"><i style="transform:scaleX(${clamp(h.hp / 100, 0, 1)})"></i></div>`;
  } else {
    $('pp-bars').innerHTML = '';
  }

  const mat = dead ? null : matsAt(p, play.t);
  $('pp-mats').innerHTML = mat
    ? `<span class="mat wood">Wood ${mat.wood ?? '—'}</span>` +
      `<span class="mat brick">Brick ${mat.brick ?? '—'}</span>` +
      `<span class="mat metal">Metal ${mat.metal ?? '—'}</span>`
    : '<span class="loadout-unknown">Materials unavailable in replay</span>';
  renderLoadout(p, play.t, dead);

  const kills = model.events.filter(
    (e) => e.killer === p.id && e.t <= play.t && !e.downed && !isBotEvent(e)
  ).length;
  const dmg = dmgAt(p, play.t);
  $('pp-stats').innerHTML =
    `<div>Elims <b>${kills}</b></div><div>Placement <b>#${p.placement ?? '—'}</b></div>` +
    `<div>Dmg taken <b>${Math.round(dmg.total)}</b></div>` +
    `<div>Storm dmg <b>${Math.round(dmg.storm)}</b></div>` +
    (h ? `<div>Health <b>${Math.round(h.hp)}</b></div>` : '') +
    (dead && p.death ? `<div>Died <b>${fmtTime(p.death.t - model.time.start)}</b></div>` : '');
  $('pp-follow').classList.toggle('active', play.follow === p);
}

/* Materials (wood/brick/metal) at time t, or null if the replay didn't carry
   inventory. `p.mats` is [[t, wood, brick, metal], ...] (only change points). */
function matsAt(p, t) {
  if (!p.mats || !p.mats.length || t < p.mats[0][0]) return null;
  let lo = 0, hi = p.mats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.mats[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return { wood: p.mats[lo][1], brick: p.mats[lo][2], metal: p.mats[lo][3] };
}

/* Inventory snapshots are [matchClock, slots, equipped]. Slots are ordered
   objects with {slot, name, rarity, count, ammo}; null is unknown, not empty. */
function inventoryAt(p, t) {
  const history = p.inventory;
  if (!Array.isArray(history) || !history.length || t < history[0][0]) return null;
  let lo = 0, hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return history[lo];
}
function safeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
}
function renderLoadout(p, t, dead) {
  const container = $('pp-loadout');
  const state = dead ? null : inventoryAt(p, t);
  if (!state) {
    container.innerHTML = '<div class="loadout-heading">Inventory</div><div class="loadout-unknown">Inventory and equipped weapon unavailable</div>';
    return;
  }
  const slots = Array.isArray(state[1]) ? state[1] : [];
  const equipped = state[2];
  const items = Array.from({length: 5}, (_, index) => {
    const item = slots.find(i => i && i.slot === index) ?? null;
    if (!item) return `<div class="loadout-slot"><small>${index + 1}</small><span>—</span></div>`;
    const active = equipped != null && (equipped === item.id || equipped === item.slot);
    return `<div class="loadout-slot ${active ? 'equipped' : ''}"><small>${index + 1}${active ? ' · Held' : ''}</small><span>${safeText(item.name || 'Unknown item')}</span><small>${safeText(item.rarity || '')}${item.count != null ? ' · ×' + safeText(item.count) : ''}${item.ammo != null ? ' · ' + safeText(item.ammo) + ' ammo' : ''}</small></div>`;
  });
  container.innerHTML = '<div class="loadout-heading">Inventory</div><div class="loadout-slots">' + items.join('') + '</div>' +
    `<div class="loadout-held">Equipped: ${safeText(state[3] || (equipped == null ? 'Unavailable' : 'Unknown weapon'))}</div>`;
}

/* ---------------------------------------------------------------------------
   Interaction
   ------------------------------------------------------------------------- */
let dragging = false, dragStart = null, camStart = null, moved = false;

cv.addEventListener('mousedown', (e) => {
  if (!model) return;
  dragging = true; moved = false;
  dragStart = [e.clientX, e.clientY];
  camStart = calibrating ? { ox: cal.ox, oy: cal.oy } : { x: cam.x, y: cam.y };
  cv.classList.add('grabbing');
});
window.addEventListener('mouseup', () => {
  dragging = false;
  cv.classList.remove('grabbing');
});
window.addEventListener('mousemove', (e) => {
  if (!model) return;
  if (dragging) {
    const dx = (e.clientX - dragStart[0]) / cam.zoom;
    const dy = (e.clientY - dragStart[1]) / cam.zoom;
    if (Math.hypot(e.clientX - dragStart[0], e.clientY - dragStart[1]) > 3) moved = true;
    if (calibrating) { cal.ox = camStart.ox - dx; cal.oy = camStart.oy - dy; showCalValues(); }
    else { cam.x = camStart.x - dx; cam.y = camStart.y - dy; play.follow = null; syncFollowBtn(); }
    return;
  }
  // hover (the name is drawn on the canvas so it tracks the dot during playback)
  const rect = cv.getBoundingClientRect();
  hovered = pickPlayer(e.clientX - rect.left, e.clientY - rect.top);
  cv.classList.toggle('picking', !!hovered);
});

cv.addEventListener('click', (e) => {
  if (!model || moved) return;
  const rect = cv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (calPick) { calPickClick(mx, my); return; }
  selectPlayer(pickPlayer(mx, my));
});

cv.addEventListener('dblclick', () => { if (model && !calibrating) { play.follow = null; syncFollowBtn(); frameFit(); } });

cv.addEventListener('wheel', (e) => {
  if (!model) return;
  e.preventDefault();
  const rect = cv.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const [wx, wy] = screenToWorld(mx, my);
  const factor = Math.exp(-e.deltaY * 0.0016);
  if (calibrating) {
    cal.wppuX *= 1 / factor;
    cal.wppuY *= 1 / factor;
    showCalValues();
  } else {
    cam.zoom = clamp(cam.zoom * factor, 1e-4, 5);
    const [nwx, nwy] = screenToWorld(mx, my);
    cam.x += wx - nwx; cam.y += wy - nwy;
  }
}, { passive: false });

function pickPlayer(sx, sy) {
  if (!model) return null;
  let best = null, bestD = 13;
  for (const p of model.roster) {
    if (play.t >= p.goneT) continue;
    const pos = posAt(p, play.t);
    if (!pos) continue;
    const [px, py] = worldToScreen(pos.x, pos.y);
    const d = Math.hypot(px - sx, py - sy);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Cycle the selection to the next player on the same team (alive first). */
function swapTeammate(dir = 1) {
  if (!selected) return;
  const mates = (model.teams.get(selected.team ?? -1) || []).slice();
  if (mates.length < 2) return;
  mates.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const i = mates.indexOf(selected);
  const order = [];
  for (let k = 1; k < mates.length; k++) order.push(mates[(i + k * dir + mates.length * mates.length) % mates.length]);
  const next = order.find((m) => isAlive(m, play.t)) || order[0];
  selectPlayer(next);
  if (play.follow) play.follow = next;
}

function selectPlayer(p) {
  selected = p;
  if (!p) { $('player-panel').hidden = true; play.follow = null; syncFollowBtn(); }
  renderTimelineMarks(); // kill ticks follow the selection
}

/* ---------------------------------------------------------------------------
   Transport
   ------------------------------------------------------------------------- */
function setPlaying(v) {
  play.playing = v;
  $('btn-play').innerHTML = v ? '&#10073;&#10073;' : '&#9654;';
}
$('btn-play').onclick = () => setPlaying(!play.playing);
document.querySelectorAll('.sp').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.sp').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    play.speed = parseFloat(b.dataset.sp);
  };
});

let scrubbing = false;
$('scrub').addEventListener('input', (e) => {
  scrubbing = true;
  play.t = model.time.start + parseInt(e.target.value, 10) / 10;
});
$('scrub').addEventListener('change', () => { scrubbing = false; });

window.addEventListener('keydown', (e) => {
  if ($('viewer').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!play.playing); }
  else if (e.code === 'ArrowRight') play.t = clamp(play.t + 5, model.time.start, model.time.end);
  else if (e.code === 'ArrowLeft') play.t = clamp(play.t - 5, model.time.start, model.time.end);
  else if (e.code === 'BracketRight') cycleSpeed(1);
  else if (e.code === 'BracketLeft') cycleSpeed(-1);
  else if (e.code === 'Home' || e.code === 'KeyF') { play.follow = null; syncFollowBtn(); frameFit(); }
  else if (e.code === 'Escape') selectPlayer(null);
  else if (e.code === 'Tab') { e.preventDefault(); swapTeammate(e.shiftKey ? -1 : 1); }
});
function cycleSpeed(dir) {
  const sps = [0.5, 1, 2, 4, 8];
  let i = sps.indexOf(play.speed);
  i = clamp(i + dir, 0, sps.length - 1);
  document.querySelector(`.sp[data-sp="${sps[i]}"]`).click();
}

/* ---------------------------------------------------------------------------
   Toolbar toggles / panels
   ------------------------------------------------------------------------- */
$('btn-names').onclick = () => {
  ui.names = !ui.names;
  $('btn-names').classList.toggle('active', ui.names);
};

/* ---- game stats popup ---- */
let statsOpen = false;
function setStatsOpen(v) {
  statsOpen = v;
  $('stats-panel').hidden = !v;
  $('btn-stats').classList.toggle('active', v);
  if (v) renderStats();
}
$('btn-stats').onclick = () => setStatsOpen(!statsOpen);
$('stats-close').onclick = () => setStatsOpen(false);

function renderStats() {
  if (!statsOpen || !model) return;
  const t = play.t;
  const c = zoneCensus(t);
  const s = stormAt(t);
  const zonePct = c.total ? (c.inZone / c.total) * 100 : 100;
  const zoneLabel = s ? (s.shrinking ? `Zone ${s.phaseNo} closing` : `Zone ${s.phaseNo}`) : 'Zone —';
  const zoneTimer = s && s.timerTo != null ? fmtTime(s.timerTo) : '—';
  $('sp-body').innerHTML =
    `<div class="sp-stat"><span>In the zone</span><b>${c.inZone}</b></div>` +
    `<div class="sp-stat"><span>In the storm</span><b class="in-storm">${c.inStorm}</b></div>` +
    `<div class="sp-bar" title="${c.inZone} in zone · ${c.inStorm} in storm"><i style="width:${zonePct.toFixed(1)}%"></i></div>` +
    `<div class="sp-stat"><span>Players alive</span><b>${aliveCount(t)}</b></div>` +
    (model.isSolo ? '' : `<div class="sp-stat"><span>Teams alive</span><b>${teamsAlive(t)}</b></div>`) +
    `<div class="sp-stat"><span>${zoneLabel}</span><b>${zoneTimer}</b></div>`;
}

$('btn-back').onclick = () => { history.replaceState(null, '', location.pathname); location.reload(); };
$('pp-close').onclick = () => selectPlayer(null);
$('pp-swap').onclick = () => swapTeammate(1);
$('pp-follow').onclick = () => {
  play.follow = play.follow === selected ? null : selected;
  syncFollowBtn();
};
function syncFollowBtn() { $('pp-follow').classList.toggle('active', !!play.follow && play.follow === selected); }

/* ---- calibrate ---- */
$('btn-calibrate').onclick = () => setCalibrating(true);
$('cal-done').onclick = () => setCalibrating(false);
$('cal-reset').onclick = () => { cal = defaultCal(); saveCal(); frameFit(); calPick = null; updateCalPickUi(); showCalValues(); };
$('cal-fit').onclick = () => frameFit();
$('cal-invx').onchange = (e) => { cal.flipX = e.target.checked; saveCal(); };
$('cal-invy').onchange = (e) => { cal.flipY = e.target.checked; saveCal(); };
$('cal-hide').onchange = (e) => { cal.hide = e.target.checked; saveCal(); };
$('cal-copy').onclick = () => {
  const txt = calValuesText();
  navigator.clipboard?.writeText(txt).then(
    () => flashCalStatus('Copied'),
    () => flashCalStatus(txt)
  );
};
function calValuesText() {
  return `ox:${Math.round(cal.ox)} oy:${Math.round(cal.oy)} ` +
    `wppuX:${cal.wppuX.toFixed(3)} wppuY:${cal.wppuY.toFixed(3)}` +
    (cal.flipX ? ' flipX' : '') + (cal.flipY ? ' flipY' : '');
}
function showCalValues() { $('cal-values').textContent = calValuesText(); }
function setCalibrating(v) {
  calibrating = v;
  $('calibrate').hidden = !v;
  if (!v) { saveCal(); calPick = null; updateCalPickUi(); }
  else {
    $('cal-invx').checked = cal.flipX;
    $('cal-invy').checked = cal.flipY;
    $('cal-hide').checked = cal.hide;
    showCalValues();
  }
}

/* ---- 2-point precise calibration ----
   The user picks the same real spot twice: we know the player's world position
   at that moment, and they click where that spot is on the map image. Two such
   pairs pin the world<->image transform exactly (per axis linear fit). */
let calPick = null; // { points: [{world:{x,y}, img:{x,y}}, ...] }

/** Screen pixel -> map-image pixel (in the un-flipped image's own space). */
function screenToImagePx(sx, sy) {
  const iw = mapImg.naturalWidth || 2048;
  const ih = mapImg.naturalHeight || 2048;
  const wW = iw * cal.wppuX, wH = ih * cal.wppuY;
  const [left, top] = worldToScreen(cal.ox - wW / 2, cal.oy - wH / 2);
  let u = (sx - left) / (wW * cam.zoom);
  let v = (sy - top) / (wH * cam.zoom);
  if (cal.flipX) u = 1 - u;
  if (cal.flipY) v = 1 - v;
  return { x: u * iw, y: v * ih, iw, ih };
}

$('cal-pick').onclick = () => {
  if (!selected) { flashCalStatus('Select a player first', true); return; }
  if (!calPick) calPick = { points: [] };
  flashCalStatus('Click the player’s real spot on the map');
  cv.classList.add('calpick');
};

function calPickClick(sx, sy) {
  const pos = posAt(selected, play.t);
  if (!pos) { flashCalStatus('That player isn’t on the map right now', true); return; }
  const img = screenToImagePx(sx, sy);
  calPick.points.push({ world: { x: pos.x, y: pos.y }, img: { x: img.x, y: img.y }, iw: img.iw, ih: img.ih });
  cv.classList.remove('calpick');

  if (calPick.points.length < 2) {
    updateCalPickUi();
    flashCalStatus('Point 1 set. Now scrub elsewhere and set point 2.');
    return;
  }
  const err = applyTwoPointFit(calPick.points);
  calPick = null;
  updateCalPickUi();
  showCalValues();
  flashCalStatus(err || 'Calibrated — hit Copy to share it back', !!err);
  if (!err) frameFit();
}

function applyTwoPointFit(pts) {
  const [a, b] = pts;
  const iw = a.iw, ih = a.ih;
  const u1 = a.img.x / iw, u2 = b.img.x / iw;
  const v1 = a.img.y / ih, v2 = b.img.y / ih;
  // The map's x and y world-scales differ, so BOTH axes need real spread --
  // otherwise the weak axis's scale is basically guessed and drifts elsewhere.
  if (Math.abs(u1 - u2) < 0.12 || Math.abs(v1 - v2) < 0.12) {
    return 'Points need to be far apart in BOTH directions — pick a very different spot';
  }
  // imgU = (worldX - ox) / (iw*wppuX) + 0.5  ->  solve wppuX and ox per axis
  const wppuX = (a.world.x - b.world.x) / ((u1 - u2) * iw);
  const wppuY = (a.world.y - b.world.y) / ((v1 - v2) * ih);
  if (!(wppuX > 0) || !(wppuY > 0)) {
    return 'That fit is inverted — check the two clicks match the two moments';
  }
  cal.wppuX = wppuX;
  cal.wppuY = wppuY;
  cal.ox = a.world.x - (u1 - 0.5) * iw * wppuX;
  cal.oy = a.world.y - (v1 - 0.5) * ih * wppuY;
  cal.flipX = false;
  cal.flipY = false;
  saveCal();
  return null;
}

let calStatusTimer = null;
function flashCalStatus(msg, isError) {
  const el = $('cal-pick-status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--accent)';
  clearTimeout(calStatusTimer);
  calStatusTimer = setTimeout(() => { if (!calPick) el.textContent = ''; }, 4000);
}
function updateCalPickUi() {
  const n = calPick ? calPick.points.length : 0;
  $('cal-pick').textContent = n === 0 ? 'Set point 1' : 'Set point 2';
}

/* ---------------------------------------------------------------------------
   Map image
   ------------------------------------------------------------------------- */
mapImg.onload = () => {
  mapReady = true;
  // If we drew a provisional calibration before the image dimensions were
  // known, recompute now (unless the user has a saved one).
  if (model && !savedCal()) { cal = defaultCal(); }
};
mapImg.onerror = () => { mapReady = false; };
mapImg.src = MAP_SRC;

function savedCal() {
  try { return localStorage.getItem(calKey()); } catch { return null; }
}
