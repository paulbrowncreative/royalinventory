/* Data layer: persistence (IndexedDB with localStorage fallback) and stock calculations. */
(function () {
  const DB_NAME = 'royal-inventory';
  const STORE = 'state';
  const KEY = 'main';
  const LS_KEY = 'royal-inventory-state';
  const EPS = 0.0001;

  const blank = () => ({
    version: 1,
    settings: { lowThreshold: 5, lang: 'ar' },
    cards: [],
    withdrawals: [],
    seq: { card: 0, withdrawal: 0 },
    updatedAt: null,
  });

  let state = blank();
  let db = null;
  let saveTimer = null;
  const listeners = new Set();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('royal-inventory') : null;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function normalize(raw) {
    const s = Object.assign(blank(), raw || {});
    s.settings = Object.assign(blank().settings, s.settings || {});
    s.seq = Object.assign(blank().seq, s.seq || {});
    s.cards = Array.isArray(s.cards) ? s.cards : [];
    s.withdrawals = Array.isArray(s.withdrawals) ? s.withdrawals : [];
    return s;
  }

  async function load() {
    try {
      db = await openDb();
      state = normalize(await idbGet());
    } catch (e) {
      db = null;
      try { state = normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch (_) { state = blank(); }
    }
    return state;
  }

  function emit(type) { listeners.forEach((fn) => fn(type)); }

  async function persist() {
    emit('saving');
    try {
      if (db) await idbPut(state);
      else localStorage.setItem(LS_KEY, JSON.stringify(state));
      emit('saved');
      if (channel) channel.postMessage('changed');
    } catch (e) {
      console.error(e);
      emit('save-error');
    }
  }

  function commit() {
    state.updatedAt = new Date().toISOString();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
    emit('change');
  }

  if (channel) {
    channel.onmessage = async () => {
      if (db) state = normalize(await idbGet());
      else try { state = normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch (_) {}
      emit('change');
    };
  }

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const round = (n) => Math.round(n * 100) / 100;
  const norm = (s) => String(s || '').trim().toUpperCase();

  /* ---------- Calculations ---------- */
  // Recomputed per render; O(cards + withdrawals) so it stays fast at tens of thousands of rows.
  function compute() {
    const threshold = num(state.settings.lowThreshold) ?? 5;
    const byCard = new Map();
    state.cards.forEach((c) => byCard.set(c.id, { card: c, list: [] }));
    state.withdrawals.forEach((w) => { const e = byCard.get(w.cardId); if (e) e.list.push(w); });

    const rows = [];
    const runningAfter = new Map(); // withdrawal id -> card balance after it
    byCard.forEach(({ card, list }) => {
      list.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));
      const opening = card.opening || 0;
      const hasCount = card.physical !== null && card.physical !== undefined && card.physicalDate;
      let total = 0, before = 0, after = 0;
      list.forEach((w) => {
        total += w.qty;
        if (hasCount && w.date > card.physicalDate) {
          after += w.qty;
          runningAfter.set(w.id, round(card.physical - after));
        } else {
          before += w.qty;
          runningAfter.set(w.id, round(opening - before));
        }
      });
      const calc = round(opening - total);
      const variance = hasCount ? round(card.physical - (opening - before)) : null;
      const final = hasCount ? round(card.physical - after) : calc;
      let status = 'ok';
      if (final < -EPS) status = 'negative';
      else if (Math.abs(final) <= EPS) status = 'out';
      else if (final <= threshold + EPS) status = 'low';
      rows.push({
        card, opening, total: round(total), calc, variance, final, status,
        hasVariance: variance !== null && Math.abs(variance) > EPS,
        count: list.length, list,
      });
    });

    const items = new Map();
    rows.forEach((r) => {
      const k = norm(r.card.itemNo) || '—';
      if (!items.has(k)) items.set(k, { itemNo: r.card.itemNo || '—', name: r.card.name, origins: new Set(), rows: [], opening: 0, total: 0, final: 0 });
      const g = items.get(k);
      g.rows.push(r); g.opening += r.opening; g.total += r.total; g.final += r.final;
      if (r.card.origin) g.origins.add(r.card.origin);
    });
    items.forEach((g) => { g.opening = round(g.opening); g.total = round(g.total); g.final = round(g.final); });

    const totals = rows.reduce((t, r) => {
      t.opening += r.opening; t.withdrawals += r.total; t.net += r.final;
      if (r.status === 'low' || r.status === 'out') t.low++;
      if (r.status === 'negative') t.negative++;
      if (r.hasVariance) t.alerts++;
      return t;
    }, { cards: rows.length, opening: 0, withdrawals: 0, net: 0, low: 0, negative: 0, alerts: 0 });
    totals.opening = round(totals.opening); totals.withdrawals = round(totals.withdrawals); totals.net = round(totals.net);

    const rowByCardId = new Map(rows.map((r) => [r.card.id, r]));
    return { rows, rowByCardId, items, totals, runningAfter, threshold };
  }

  /* ---------- Mutations ---------- */
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  function findCardByNo(no) {
    const n = norm(no);
    return n ? state.cards.find((c) => norm(c.cardNo) === n) : undefined;
  }

  function upsertCard(data) {
    const clean = {
      cardNo: String(data.cardNo || '').trim(),
      entryDate: data.entryDate || today(),
      itemNo: String(data.itemNo || '').trim(),
      name: String(data.name || '').trim(),
      origin: String(data.origin || '').trim(),
      opening: num(data.opening) ?? 0,
    };
    let card;
    if (data.id) {
      card = state.cards.find((c) => c.id === data.id);
      Object.assign(card, clean);
    } else {
      state.seq.card += 1;
      card = Object.assign({ id: 'c' + state.seq.card + '-' + Date.now().toString(36), physical: null, physicalDate: '' }, clean);
      state.cards.push(card);
    }
    if ('physical' in data) {
      card.physical = num(data.physical);
      card.physicalDate = card.physical === null ? '' : data.physicalDate || today();
    }
    commit();
    return card;
  }

  function setPhysical(cardId, physical, date) {
    const card = state.cards.find((c) => c.id === cardId);
    card.physical = num(physical);
    card.physicalDate = card.physical === null ? '' : date || today();
    commit();
    return card;
  }

  function deleteCard(cardId) {
    const idx = state.cards.findIndex((c) => c.id === cardId);
    const card = state.cards[idx];
    const removed = state.withdrawals.filter((w) => w.cardId === cardId);
    state.cards.splice(idx, 1);
    state.withdrawals = state.withdrawals.filter((w) => w.cardId !== cardId);
    commit();
    return { card, removed, idx };
  }

  function restoreCard({ card, removed, idx }) {
    state.cards.splice(Math.min(idx, state.cards.length), 0, card);
    state.withdrawals.push(...removed);
    commit();
  }

  function addWithdrawal(data) {
    state.seq.withdrawal += 1;
    const w = {
      id: 'W-' + String(state.seq.withdrawal).padStart(6, '0'),
      seq: state.seq.withdrawal,
      date: data.date || today(),
      cardId: data.cardId,
      qty: num(data.qty),
      notes: String(data.notes || '').trim(),
    };
    state.withdrawals.push(w);
    commit();
    return w;
  }

  function updateWithdrawal(id, data) {
    const w = state.withdrawals.find((x) => x.id === id);
    Object.assign(w, { date: data.date, cardId: data.cardId, qty: num(data.qty), notes: String(data.notes || '').trim() });
    commit();
    return w;
  }

  function deleteWithdrawal(id) {
    const idx = state.withdrawals.findIndex((w) => w.id === id);
    const [w] = state.withdrawals.splice(idx, 1);
    commit();
    return { w, idx };
  }

  function restoreWithdrawal({ w, idx }) {
    state.withdrawals.splice(Math.min(idx, state.withdrawals.length), 0, w);
    commit();
  }

  function setSettings(patch) {
    Object.assign(state.settings, patch);
    commit();
  }

  function replaceAll(raw) {
    state = normalize(raw);
    commit();
  }

  window.Store = {
    load, compute, today, num, norm, findCardByNo,
    upsertCard, setPhysical, deleteCard, restoreCard,
    addWithdrawal, updateWithdrawal, deleteWithdrawal, restoreWithdrawal,
    setSettings, replaceAll,
    reset() { replaceAll(Object.assign(blank(), { settings: state.settings })); },
    get state() { return state; },
    on(fn) { listeners.add(fn); },
  };
})();
