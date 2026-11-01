'use strict';

/* ============================================================================
   Home screen -- a Trello-style board of categories, each holding replay
   "games". Persisted server-side (/api/board). Clicking a game hands its code
   to window.startLoad (app.js), which parses it and opens the viewer.

   The board model is owned here; every mutation debounce-PUTs the whole
   document. Drag/drop is SortableJS (vendor/sortable.min.js) -- one Sortable
   for the column strip, one per column for its cards (shared group so cards
   move between columns). After a drag we re-derive order from the DOM.
   ==========================================================================*/

(function () {
  const $ = (id) => document.getElementById(id);
  const HEX32 = /^[0-9a-f]{32}$/;
  const uid = (p) =>
    p + Math.random().toString(16).slice(2, 8) + Date.now().toString(16).slice(-4);

  const columnsEl = $('board-columns');
  const addColEl = $('add-column');

  let state = { categories: [] };
  let sortables = [];
  let justDragged = false;

  /* ---------------------------------------------------------------- persistence */
  let saveTimer = null;
  let savePending = false;
  let saveInFlight = false;

  function save() {
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  // Each visitor owns a separate board in their browser; no shared writes.
  async function flush() {
    savePending = false;
    try { localStorage.setItem('fortnite-replay-board-v1', JSON.stringify(state)); }
    catch (e) { showError('Could not save board: ' + e.message); }
  }

  async function loadBoard() {
    try {
      const saved = JSON.parse(localStorage.getItem('fortnite-replay-board-v1') || 'null');
      state = saved && Array.isArray(saved.categories) ? saved : { categories: [] };
    } catch { state = { categories: [] }; }
    render();
  }

  /* --------------------------------------------------------------- error toast */
  let errTimer = null;
  function showError(msg) {
    const el = $('home-error');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errTimer);
    errTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  /* ------------------------------------------------------------------ helpers */
  const catById = (id) => state.categories.find((c) => c.id === id);

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m >= 1 ? `${m}m` : `${s}s`;
  }
  function fmtDate(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function cardSub(g) {
    const bits = [];
    if (g.meta) {
      if (g.meta.playlist) bits.push(g.meta.playlist);
      if (g.meta.lengthMs) bits.push(fmtDur(g.meta.lengthMs));
      if (g.meta.date) { const d = fmtDate(g.meta.date); if (d) bits.push(d); }
    }
    if (!bits.length) bits.push(g.code.slice(0, 14) + '…');
    return bits.join('  ·  ');
  }

  /* Click the text to rename it: swaps in an <input>, Enter / blur commits,
     Escape cancels. Kept clear of the drag handle via stopPropagation. */
  function renameOnClick(el, commit) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.querySelector('input')) return;
      const cur = el.textContent;
      const inp = document.createElement('input');
      inp.className = 'inline-edit';
      inp.value = cur;
      el.textContent = '';
      el.appendChild(inp);
      inp.focus();
      inp.select();

      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        const v = keep ? inp.value.replace(/\s+/g, ' ').trim() : cur;
        el.textContent = v || cur;
        if (keep && v && v !== cur) commit(v);
      };
      inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    });
  }

  /* -------------------------------------------------------------- rendering */
  function render() {
    sortables.forEach((s) => s.destroy());
    sortables = [];
    [...columnsEl.querySelectorAll('.column')].forEach((n) => n.remove());

    $('add-column-hint').hidden = state.categories.length > 0;

    state.categories.forEach((cat) => columnsEl.insertBefore(renderColumn(cat), addColEl));

    sortables.push(new Sortable(columnsEl, {
      animation: 150,
      handle: '.col-head',
      draggable: '.column',
      filter: '.col-del, .inline-edit',
      preventOnFilter: false,
      forceFallback: true,
      ghostClass: 'drag-ghost',
      fallbackClass: 'drag-fallback',
      onMove: (evt) => evt.related !== addColEl, // never past the "+ Add category" tile
      onEnd: afterDrag,
    }));
  }

  function renderColumn(cat) {
    const col = document.createElement('div');
    col.className = 'column';
    col.dataset.id = cat.id;

    // header
    const head = document.createElement('div');
    head.className = 'col-head';

    const name = document.createElement('span');
    name.className = 'col-name';
    name.textContent = cat.name;
    name.title = 'Click to rename';
    renameOnClick(name, (v) => { cat.name = v; save(); });

    const count = document.createElement('span');
    count.className = 'col-count';
    count.textContent = cat.games.length;

    const del = document.createElement('button');
    del.className = 'col-del';
    del.innerHTML = '&times;';
    del.title = 'Delete category';
    del.onclick = () => {
      if (cat.games.length &&
          !confirm(`Delete “${cat.name}” and its ${cat.games.length} game${cat.games.length > 1 ? 's' : ''}?`)) return;
      state.categories = state.categories.filter((c) => c !== cat);
      save();
      render();
    };

    head.append(name, count, del);

    // cards
    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.id = cat.id;
    cat.games.forEach((g) => list.appendChild(renderCard(cat, g)));

    // footer / add
    const foot = document.createElement('div');
    foot.className = 'col-foot';
    const addBtn = document.createElement('button');
    addBtn.className = 'card-add';
    addBtn.textContent = '+ Add game';
    addBtn.onclick = () => openGameComposer(cat, list, foot, addBtn);
    foot.appendChild(addBtn);

    col.append(head, list, foot);

    sortables.push(new Sortable(list, {
      group: 'games',
      animation: 150,
      draggable: '.card',
      filter: '.card-tool',
      preventOnFilter: false,
      forceFallback: true,
      ghostClass: 'drag-ghost',
      fallbackClass: 'drag-fallback',
      onEnd: afterDrag,
    }));

    return col;
  }

  function renderCard(cat, g) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = g.id;
    card.title = 'Open replay ' + g.code;

    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = g.label;

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = cardSub(g);

    const tools = document.createElement('div');
    tools.className = 'card-tools';

    const edit = document.createElement('button');
    edit.className = 'card-tool card-edit';
    edit.innerHTML = '&#9998;';
    edit.title = 'Rename';
    edit.onclick = (e) => {
      e.stopPropagation();
      const v = prompt('Game name', g.label);
      if (v != null) { g.label = v.replace(/\s+/g, ' ').trim() || 'Game'; label.textContent = g.label; save(); }
    };

    const del = document.createElement('button');
    del.className = 'card-tool card-del';
    del.innerHTML = '&times;';
    del.title = 'Remove';
    del.onclick = (e) => {
      e.stopPropagation();
      cat.games = cat.games.filter((x) => x !== g);
      save();
      render();
    };

    tools.append(edit, del);
    card.append(tools, label, sub);
    card.addEventListener('click', () => { if (!justDragged) window.startLoad(g.code); });
    return card;
  }

  /* ------------------------------------------------------------ composers */
  function composerBox(multiline, placeholder) {
    const box = document.createElement('div');
    box.className = 'composer';
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.placeholder = placeholder;
    if (multiline) input.rows = 3;
    const row = document.createElement('div');
    row.className = 'composer-row';
    const ok = document.createElement('button');
    ok.className = 'chip primary';
    ok.textContent = 'Add';
    const cancel = document.createElement('button');
    cancel.className = 'chip';
    cancel.textContent = 'Cancel';
    row.append(ok, cancel);
    box.append(input, row);
    return { box, input, ok, cancel };
  }

  function openGameComposer(cat, list, foot, addBtn) {
    if (foot.querySelector('.composer')) return;
    addBtn.hidden = true;
    const { box, input, ok, cancel } = composerBox(
      true, 'Paste a replay code — or several, one per line'
    );
    foot.insertBefore(box, addBtn);
    input.focus();

    const close = () => { box.remove(); addBtn.hidden = false; };
    const commit = () => {
      const codes = input.value.toLowerCase().match(/[0-9a-f]{32}/g) || [];
      if (!codes.length) { showError('No 32-hex replay codes found in that.'); return; }
      const have = new Set(cat.games.map((g) => g.code));
      let n = cat.games.length;
      let added = 0;
      for (const code of codes) {
        if (have.has(code)) continue;
        have.add(code);
        cat.games.push({ id: uid('g_'), code, label: `Game ${++n}`, meta: null, addedAt: Date.now() });
        added++;
      }
      close();
      if (added) { save(); render(); }
      else showError('Those are already in this category.');
    };
    ok.onclick = commit;
    cancel.onclick = close;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') close();
    });
  }

  function openColumnComposer() {
    const wrap = $('add-column');
    const btn = $('add-column-btn');
    if (wrap.querySelector('.composer')) return;
    btn.hidden = true;
    const { box, input, ok, cancel } = composerBox(false, 'Category name');
    wrap.insertBefore(box, btn);
    input.focus();

    const close = () => { box.remove(); btn.hidden = false; };
    const commit = () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) { close(); return; }
      state.categories.push({ id: uid('c_'), name, collapsed: false, games: [] });
      close();
      save();
      render();
    };
    ok.onclick = commit;
    cancel.onclick = close;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') close();
    });
  }

  /* --------------------------------------------------------------- drag end */
  function afterDrag() {
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 80);
    syncFromDom();
    save();
  }

  /* Rebuild category + game order from the DOM after a Sortable drop. Game
     objects are looked up by id since a card may have changed columns. */
  function syncFromDom() {
    const gameById = new Map();
    state.categories.forEach((c) => c.games.forEach((g) => gameById.set(g.id, g)));

    const cols = [...columnsEl.querySelectorAll('.column')];
    state.categories = cols.map((colEl) => {
      const cat = catById(colEl.dataset.id) ||
        { id: colEl.dataset.id, name: 'Untitled', collapsed: false, games: [] };
      cat.games = [...colEl.querySelectorAll('.card')]
        .map((cd) => gameById.get(cd.dataset.id))
        .filter(Boolean);
      return cat;
    });

    // refresh the little count badges without a full re-render
    cols.forEach((colEl) => {
      const cat = catById(colEl.dataset.id);
      const badge = colEl.querySelector('.col-count');
      if (cat && badge) badge.textContent = cat.games.length;
    });
  }

  /* --------------------------------------------------------- public + wiring */
  /* app.js calls this after a replay parses, with what it learned (playlist,
     length, date). Fires while the viewer is open, so only re-render if the
     board is actually on screen -- otherwise the reload on "back" shows it. */
  function enrich(code, meta) {
    let touched = false;
    for (const c of state.categories) {
      for (const g of c.games) {
        if (g.code === code && meta) {
          g.meta = Object.assign({}, g.meta, meta);
          touched = true;
        }
      }
    }
    if (touched) {
      save();
      if (!$('home').hidden) render();
    }
  }

  window.Board = { showError, enrich, reload: loadBoard };

  $('add-column-btn').onclick = openColumnComposer;
  $('quick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('quick-code').value.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!HEX32.test(code)) { showError('That code should be 32 hex characters.'); return; }
    window.startLoad(code);
  });

  $('clear-cache').hidden = true;
  /* $('clear-cache').onclick = async () => {
    if (!confirm(
      'Delete every downloaded replay?\n\n' +
      'Your board and games stay — but each one has to re-download and re-parse ' +
      'the next time you open it (the first is slow again).'
    )) return;
    const btn = $('clear-cache');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      const r = await fetch('/api/replays', { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      const n = (j.replays || 0) + (j.parsed || 0);
      btn.textContent = n ? `Cleared ${j.replays} replay${j.replays === 1 ? '' : 's'}` : 'Nothing to clear';
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
    } catch (e) {
      showError('Could not clear downloads: ' + (e.message || e));
      btn.textContent = label;
      btn.disabled = false;
    }
  };

  */
  loadBoard();
})();
