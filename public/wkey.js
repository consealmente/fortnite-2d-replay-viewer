/* Archived movement-based W-key detector, adapted for the current viewer.
   Review candidates only: health totals cannot attribute earlier damage. */
(() => {
const WK = { CLOSE: 1000, LOOKBACK: 15, RUN_S: 5, FROM: 2500, MIN_RUN: 1500, STRAIGHT: 1.35, HEADING: 30, STEP: 0.25 };
const WK_SOLO = { MAX_HP: 200, DAMAGE: 160, MAX_AGE: 20, AFTER: 3 };
const AIRBORNE = 2 | 4 | 16;
function distAt(a, b, t) {
  const pa = posAt(a, t), pb = posAt(b, t);
  if (!pa || !pb || (pa.flags & AIRBORNE) || (pb.flags & AIRBORNE)) return null;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

/** Did A run at B in the WK.RUN_S seconds before `tc`? -> { from } (distance at the start) or null. */
function ranAtThem(A, B, tc) {
  const t0 = tc - WK.RUN_S;
  const d0 = distAt(A, B, t0);
  if (d0 == null || d0 < WK.FROM) return null;            // came from far away
  const pts = [];
  for (let t = t0; t <= tc + 0.01; t += WK.STEP) { const p = posAt(A, t); if (p) pts.push(p); }
  if (pts.length < 8) return null;
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const a0 = pts[0], a1 = pts[pts.length - 1];
  const disp = Math.hypot(a1.x - a0.x, a1.y - a0.y);
  if (disp < WK.MIN_RUN || path / disp > WK.STRAIGHT) return null; // not a straight run
  const b0 = posAt(B, t0), b1 = posAt(B, tc);
  if (!b0 || !b1 || disp < Math.hypot(b1.x - b0.x, b1.y - b0.y)) return null; // B did the closing
  const bearing = Math.atan2(b0.y - a0.y, b0.x - a0.x);
  const heading = Math.atan2(a1.y - a0.y, a1.x - a0.x);
  const off = Math.abs((((heading - bearing) * 180) / Math.PI + 540) % 360 - 180);
  return off <= WK.HEADING ? { from: d0 } : null;
}

/** B's health + shield at time t: the last recorded reading, if it's no older than
    WK_SOLO.MAX_AGE. Otherwise -- a target nobody touched for a while has no recent reading, the log only
    stores CHANGES -- the first reading within WK_SOLO.AFTER s AFTER t, which is what they had when the
    runner arrived (any hit only lowers it, so "more than 40 left" still holds). Else null.
    (Without this fallback the cleanest w-keys, on a target who hadn't been hit for 20 s+, were skipped
    as "health not recorded": 16 of 68 approaches in one real replay.) */
function hpLeftAt(B, t) {
  const h = B.hp;
  if (!h || !h.length) return null;
  let lo = 0, hi = h.length - 1;
  if (t >= h[0][0]) {
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (h[mid][0] <= t) lo = mid; else hi = mid - 1; }
    if (t - h[lo][0] <= WK_SOLO.MAX_AGE) return h[lo][1] + h[lo][2];
    lo++; // the first reading after t
  } else lo = 0;
  return lo < h.length && h[lo][0] - t <= WK_SOLO.AFTER ? h[lo][1] + h[lo][2] : null;
}

/** Every event that passes the loose rule, tagged with whether it was a rush and whether A fired.
    Solos also carry `hpLeft` (the target's health + shield when A got close; `unknown` if not recorded). */
function getWkeys() {
  if (model.wk) return model.wk;
  const solo = model.isSolo;
  const hpAllowed = WK_SOLO.MAX_HP - WK_SOLO.DAMAGE; // at or below this, 160+ damage is already dealt
  const out = [];
  for (const e of model.kills) {
    const aId = e.killer ?? (e.knock ? e.knock.killer : null); // finishing blows count for whoever knocked them
    const A = aId != null ? model.byId.get(aId) : null;
    const B = model.byId.get(e.victim);
    if (!A || !B || A === B || A.isBot || (!solo && A.team != null && A.team === B.team)) continue;

    let tc = null; // first moment in the lookback A was within range of B
    for (let t = e.t - WK.LOOKBACK; t <= e.t + 0.01; t += WK.STEP) {
      const d = distAt(A, B, t);
      if (d != null && d <= WK.CLOSE) { tc = t; break; }
    }
    if (tc == null) continue;

    let hpLeft = null;
    if (solo) {
      hpLeft = hpLeftAt(B, tc);
      if (hpLeft != null && hpLeft <= hpAllowed) continue; // already dealt 160+ -> allowed to close in
    } else if (model.kills.some((k) => k.downed && k.killer === A.id && k.victim === B.id && k.t < tc)) {
      continue; // knocked them from range before closing in -> not a w-key
    }

    const run = ranAtThem(A, B, tc);
    out.push({
      e, A, B, tc,
      rush: !!run, from: run ? run.from : null,
      fired: A.shots ? A.shots.some((s) => s >= tc - WK.RUN_S && s < tc) : null, // null = no shot data
      hpLeft, unknown: solo && hpLeft == null,
    });
  }
  model.wk = out;
  return out;
}


function prepare(m) {
  m.byId = new Map(m.players.map(p => [p.id, p]));
  const knocks = new Map();
  m.kills = [];
  for (const source of [...m.events].sort((a,b) => a.t-b.t)) {
    const e = {...source};
    if (e.revived) { knocks.delete(e.victim); continue; }
    const victim = m.byId.get(e.victim);
    if (!victim || victim.isBot) continue;
    if (e.downed) knocks.set(e.victim, e);
    else if (e.killer == null) {
      const k = knocks.get(e.victim);
      if (k && e.t-k.t < 180) e.knock = k;
    }
    m.kills.push(e);
  }
  m.wk = null;
}
// Zone 5 opens when Zone 4 finishes closing, matching the viewer HUD.
// Only flag events whose recorded storm phase is known to be before Zone 5.
function beforeFifthZone(t) {
  const phases = [...(model.storm || [])].filter(p =>
    Number.isFinite(p.phase) && Number.isFinite(p.finishShrink))
    .sort((a, b) => a.finishShrink - b.finishShrink);
  const current = phases.find(p => t < p.finishShrink);
  return !!current && current.phase >= 1 && current.phase < 5;
}
function candidates(level) {
  return getWkeys().filter(w =>
    !w.e.downed && beforeFifthZone(w.tc) && beforeFifthZone(w.e.t) &&
    (level === 'loose' || w.rush) &&
    (level !== 'strict' || w.fired === false));
}
function teamMembers(p) {
  return model.isSolo || p.team == null ? [p] : model.roster.filter(q => q.team === p.team);
}
function jump(w) {
  play.t = clamp(w.tc - WK.RUN_S - 1, model.time.start, model.time.end);
  setPlaying(false);
  selectPlayer(w.A);
  play.follow = w.A;
  syncFollowBtn();
  const p = posAt(w.A, play.t) || posAt(w.A, w.tc);
  if (p) { cam.x = p.x; cam.y = p.y; cam.zoom = Math.max(cam.zoom, Math.min(W, H) / 12000); }
  updateHud();
}
function renderFlags() {
  if (!model) return;
  if (!model.byId || !model.kills) prepare(model);
  const list = candidates($('wk-level').value);
  const box = $('wk-list');
  box.replaceChildren();
  $('wk-count').textContent = `${list.length} suspected pushes`;
  $('wk-empty').hidden = list.length > 0;
  for (const w of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wk-event';
    const title = document.createElement('strong');
    title.textContent = `${fmtTime(w.e.t - replayClockStart())} · ${w.A.name} → ${w.B.name}`;
    const detail = document.createElement('span');
    detail.textContent = [w.e.downed ? 'Knock' : 'Elimination',
      w.rush ? `Approached from ${Math.round(w.from / 100)} m` : 'Within 10 m',
      w.fired == null ? 'Shot data unavailable' : w.fired ? 'Fired during approach' : 'No recorded shots during approach',
      model.isSolo ? (w.unknown ? 'Health unknown — manual review' : `Target HP + shield: ${Math.round(w.hpLeft)} (damage source unknown)`) : ''
    ].filter(Boolean).join(' · ');
    b.append(title, detail); b.title = 'Jump to six seconds before close range and follow the attacker';
    b.onclick = () => { jump(w); box.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); };
    const card = document.createElement('div');
    card.append(b);
    for (const [label, player] of [['Attacking team', w.A], ['Target team', w.B]]) {
      const roster = document.createElement('div');
      roster.className = 'wk-roster';
      const heading = document.createElement('strong'); heading.textContent = label;
      roster.append(heading);
      for (const member of teamMembers(player)) {
        const memberButton = document.createElement('button');
        memberButton.type = 'button'; memberButton.className = 'chip';
        memberButton.textContent = member.name;
        memberButton.title = 'Follow this teammate at the current replay time';
        memberButton.onclick = () => {
          selectPlayer(member); play.follow = member; syncFollowBtn();
          const pos = posAt(member, play.t);
          if (pos) { cam.x = pos.x; cam.y = pos.y; }
          updateHud();
        };
        roster.append(memberButton);
      }
      card.append(roster);
    }
    box.append(card);
  }
}
$('btn-wkey').onclick = () => {
  const panel = $('wk-panel'); panel.hidden = !panel.hidden;
  $('btn-wkey').classList.toggle('active', !panel.hidden);
  if (!panel.hidden) renderFlags();
};
$('wk-close').onclick = () => { $('wk-panel').hidden = true; $('btn-wkey').classList.remove('active'); };
$('wk-level').onchange = renderFlags;
const originalEnterViewer = enterViewer;
enterViewer = function(m) {
  prepare(m);
  $('wk-panel').hidden = true;
  $('btn-wkey').classList.remove('active');
  originalEnterViewer(m);
};
})();
