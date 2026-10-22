/* Data layer: local persistence (IndexedDB), Dropbox sync, history, and stock calculations.
 *
 * Every change is an operation ("op") applied by a pure reducer. Ops made while Dropbox is
 * connected are queued until uploaded; if another device saved first, the remote copy is
 * downloaded and the queued ops are replayed on top of it, so concurrent edits are not lost.
 */
(function () {
  const DB_NAME = 'royal-inventory';
  const STORE = 'state';
  const KEY = 'main';
  const META_KEY = 'sync';
  const LS_KEY = 'royal-inventory-state';
  const MAIN_FILE = '/royal-inventory.json';
  const HISTORY_DIR = '/history';
  const EPS = 0.0001;

  const blank = () => ({
    version: 2,
    settings: { lowThreshold: 5 },
    cards: [],
    withdrawals: [],
    trash: { cards: [], withdrawals: [] },
    seq: { withdrawal: 0 },
    updatedAt: null,
  });
  const blankMeta = () => ({ rev: null, pending: [], lastSync: null, lastSnapshot: null });

  let state = blank();
  let meta = blankMeta();
  let db = null;
  let saveTimer = null;
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;
  const listeners = new Set();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('royal-inventory') : null;

  /* ---------- Helpers ---------- */
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const round = (n) => Math.round(n * 100) / 100;
  const norm = (s) => String(s || '').trim().toUpperCase();
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const uid = (p) => p + '-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const userName = () => { try { return localStorage.getItem('royal-user') || ''; } catch (_) { return ''; } };

  function normalize(raw) {
    const s = Object.assign(blank(), raw || {});
    s.settings = { lowThreshold: num((raw && raw.settings && raw.settings.lowThreshold)) ?? 5 };
    s.seq = { withdrawal: (raw && raw.seq && raw.seq.withdrawal) || 0 };
    s.cards = Array.isArray(s.cards) ? s.cards : [];
    s.withdrawals = Array.isArray(s.withdrawals) ? s.withdrawals : [];
    s.trash = Object.assign({ cards: [], withdrawals: [] }, s.trash || {});
    // v1 records had no stable uid; reuse the display id.
    s.withdrawals.forEach((w) => { if (!w.uid) w.uid = 'w-' + w.id; });
    s.version = 2;
    return s;
  }

  /* ---------- Local persistence ---------- */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function readLocal() {
    if (db) {
      const [s, m] = await Promise.all([idb('readonly', (st) => st.get(KEY)), idb('readonly', (st) => st.get(META_KEY))]);
      return { s, m };
    }
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { return {}; }
  }

  async function load() {
    try { db = await openDb(); } catch (_) { db = null; }
    const { s, m } = await readLocal();
    state = normalize(s);
    meta = Object.assign(blankMeta(), m || {});
    return state;
  }

  function emit(type, detail) { listeners.forEach((fn) => fn(type, detail)); }

  async function persist() {
    try {
      if (db) await idb('readwrite', (st) => { st.put(state, KEY); st.put(meta, META_KEY); });
      else localStorage.setItem(LS_KEY, JSON.stringify({ s: state, m: meta }));
      if (channel) channel.postMessage('changed');
      if (!Cloud.connected()) emit('status', { state: 'local' });
    } catch (e) {
      console.error(e);
      emit('status', { state: 'save-error' });
    }
  }
  function schedulePersist() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); }

  if (channel) {
    channel.onmessage = async () => {
      const { s, m } = await readLocal();
      state = normalize(s);
      meta = Object.assign(blankMeta(), m || {});
      emit('change');
    };
  }

  /* ---------- Reducer ---------- */
  function trashCardWithdrawal(s, w) {
    const entry = s.trash.cards.find((e) => e.card.id === w.cardId);
    if (entry) entry.withdrawals.push(w);
  }

  function apply(s, op) {
    const p = op.p;
    switch (op.type) {
      case 'card.upsert': {
        const card = s.cards.find((c) => c.id === p.id);
        if (card) Object.assign(card, p.fields, { updatedAt: op.at });
        else if (!s.trash.cards.some((e) => e.card.id === p.id)) {
          s.cards.push(Object.assign({ id: p.id, physical: null, physicalDate: '', createdAt: op.at, by: op.by }, p.fields, { updatedAt: op.at }));
        }
        break;
      }
      case 'card.count': {
        const card = s.cards.find((c) => c.id === p.cardId);
        if (card) Object.assign(card, { physical: p.physical, physicalDate: p.physicalDate, countedBy: op.by, updatedAt: op.at });
        break;
      }
      case 'card.delete': {
        const i = s.cards.findIndex((c) => c.id === p.cardId);
        if (i < 0) break;
        const [card] = s.cards.splice(i, 1);
        const ws = s.withdrawals.filter((w) => w.cardId === card.id);
        s.withdrawals = s.withdrawals.filter((w) => w.cardId !== card.id);
        s.trash.cards.push({ card, withdrawals: ws, deletedAt: op.at, by: op.by });
        break;
      }
      case 'card.restore': {
        const i = s.trash.cards.findIndex((e) => e.card.id === p.cardId);
        if (i < 0) break;
        const [e] = s.trash.cards.splice(i, 1);
        s.cards.push(e.card);
        s.withdrawals.push(...e.withdrawals);
        break;
      }
      case 'w.add': {
        if (s.withdrawals.some((w) => w.uid === p.w.uid)) break; // idempotent on replay
        s.seq.withdrawal += 1;
        const w = Object.assign({}, p.w, {
          id: 'W-' + String(s.seq.withdrawal).padStart(6, '0'),
          seq: s.seq.withdrawal, createdAt: op.at, by: op.by,
        });
        if (s.cards.some((c) => c.id === w.cardId)) s.withdrawals.push(w);
        else trashCardWithdrawal(s, w);
        break;
      }
      case 'w.update': {
        const w = s.withdrawals.find((x) => x.uid === p.uid);
        if (w) Object.assign(w, p.fields, { updatedAt: op.at, updatedBy: op.by });
        break;
      }
      case 'w.delete': {
        const i = s.withdrawals.findIndex((x) => x.uid === p.uid);
        if (i < 0) break;
        const [w] = s.withdrawals.splice(i, 1);
        s.trash.withdrawals.push({ w, deletedAt: op.at, by: op.by });
        break;
      }
      case 'w.restore': {
        const i = s.trash.withdrawals.findIndex((e) => e.w.uid === p.uid);
        if (i < 0) break;
        const [e] = s.trash.withdrawals.splice(i, 1);
        if (s.cards.some((c) => c.id === e.w.cardId)) s.withdrawals.push(e.w);
        break;
      }
      case 'settings':
        Object.assign(s.settings, p);
        break;
      case 'replace': {
        const fresh = normalize(JSON.parse(JSON.stringify(p.state)));
        Object.keys(s).forEach((k) => delete s[k]);
        Object.assign(s, fresh);
        break;
      }
    }
    s.updatedAt = op.at;
    return s;
  }

  function dispatch(type, p) {
    const op = { type, p, at: new Date().toISOString(), by: userName() };
    apply(state, op);
    if (Cloud.connected()) { meta.pending.push(op); scheduleSync(1200); }
    schedulePersist();
    emit('change');
    return op;
  }

  /* ---------- Calculations ---------- */
  // Recomputed per render; O(cards + withdrawals) so it stays fast at tens of thousands of rows.
  function compute() {
    const threshold = num(state.settings.lowThreshold) ?? 5;
    const byCard = new Map();
    state.cards.forEach((c) => byCard.set(c.id, { card: c, list: [] }));
    state.withdrawals.forEach((w) => { const e = byCard.get(w.cardId); if (e) e.list.push(w); });

    const rows = [];
    const runningAfter = new Map(); // withdrawal uid -> card balance after it
    byCard.forEach(({ card, list }) => {
      list.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));
      const opening = card.opening || 0;
      const hasCount = card.physical !== null && card.physical !== undefined && card.physicalDate;
      let total = 0, before = 0, after = 0;
      list.forEach((w) => {
        total += w.qty;
        if (hasCount && w.date > card.physicalDate) {
          after += w.qty;
          runningAfter.set(w.uid, round(card.physical - after));
        } else {
          before += w.qty;
          runningAfter.set(w.uid, round(opening - before));
        }
      });
      const calc = round(opening - total);
      const variance = hasCount ? round(card.physical - (opening - before)) : null;
      const final = hasCount ? round(card.physical - after) : calc;
      rows.push({
        card, opening, total: round(total), calc, variance, final, status: statusOf(final, threshold),
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

    // Item total remaining right after each withdrawal: replay the item's withdrawals in date order,
    // swapping each card's previous balance for its balance after that withdrawal.
    const itemAfter = new Map();
    items.forEach((g) => {
      const bal = new Map(g.rows.map((r) => [r.card.id, r.opening]));
      let total = g.rows.reduce((t, r) => t + r.opening, 0);
      g.rows.flatMap((r) => r.list)
        .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1))
        .forEach((w) => {
          const next = runningAfter.get(w.uid);
          total += next - bal.get(w.cardId);
          bal.set(w.cardId, next);
          itemAfter.set(w.uid, round(total));
        });
    });

    const rowByCardId = new Map(rows.map((r) => [r.card.id, r]));
    return { rows, rowByCardId, items, totals, runningAfter, itemAfter, threshold };
  }

  function statusOf(final, threshold) {
    if (final < -EPS) return 'negative';
    if (Math.abs(final) <= EPS) return 'out';
    if (final <= threshold + EPS) return 'low';
    return 'ok';
  }

  // Stock of every card as it stood at the end of `date` (uses the latest physical count on or before it).
  function computeAsOf(date) {
    const threshold = num(state.settings.lowThreshold) ?? 5;
    const counted = (c) => c.physical !== null && c.physical !== undefined && c.physicalDate && c.physicalDate <= date;
    const cards = new Map(state.cards.map((c) => [c.id, c]));
    const sums = new Map();
    state.withdrawals.forEach((w) => {
      const c = cards.get(w.cardId);
      if (!c || w.date > date) return;
      const e = sums.get(w.cardId) || { all: 0, afterCount: 0 };
      e.all += w.qty;
      if (counted(c) && w.date > c.physicalDate) e.afterCount += w.qty;
      sums.set(w.cardId, e);
    });
    return state.cards.filter((c) => !c.entryDate || c.entryDate <= date).map((c) => {
      const e = sums.get(c.id) || { all: 0, afterCount: 0 };
      const balance = round(counted(c) ? c.physical - e.afterCount : (c.opening || 0) - e.all);
      return { card: c, opening: c.opening || 0, withdrawn: round(e.all), balance, counted: counted(c), status: statusOf(balance, threshold) };
    });
  }

  // Withdrawal totals per item between two dates (inclusive).
  function periodSummary(from, to) {
    const cards = new Map(state.cards.map((c) => [c.id, c]));
    const groups = new Map();
    state.withdrawals.forEach((w) => {
      if ((from && w.date < from) || (to && w.date > to)) return;
      const c = cards.get(w.cardId) || {};
      const itemNo = w.itemNo || c.itemNo || '—';
      const k = norm(itemNo);
      if (!groups.has(k)) groups.set(k, { itemNo, name: w.name || c.name || '', origin: w.origin || c.origin || '', count: 0, qty: 0, cards: new Set() });
      const g = groups.get(k);
      g.count++; g.qty = round(g.qty + w.qty); g.cards.add(w.cardId);
    });
    return [...groups.values()];
  }

  /* ---------- Public mutations ---------- */
  function findCardByNo(no) {
    const n = norm(no);
    return n ? state.cards.find((c) => norm(c.cardNo) === n) : undefined;
  }

  function upsertCard(data) {
    const fields = {
      cardNo: String(data.cardNo || '').trim(),
      entryDate: data.entryDate || today(),
      itemNo: String(data.itemNo || '').trim(),
      name: String(data.name || '').trim(),
      origin: String(data.origin || '').trim(),
      opening: num(data.opening) ?? 0,
    };
    if ('physical' in data) {
      fields.physical = num(data.physical);
      fields.physicalDate = fields.physical === null ? '' : data.physicalDate || today();
    }
    const id = data.id || uid('c');
    dispatch('card.upsert', { id, fields });
    return state.cards.find((c) => c.id === id);
  }

  function setPhysical(cardId, physical, date) {
    const v = num(physical);
    dispatch('card.count', { cardId, physical: v, physicalDate: v === null ? '' : date || today() });
    return state.cards.find((c) => c.id === cardId);
  }

  // Fabric details are typed on each withdrawal; blanks fall back to the card's own details.
  function withdrawalFields(data) {
    const card = state.cards.find((c) => c.id === data.cardId) || {};
    const pick = (k) => String(data[k] ?? '').trim() || card[k] || '';
    return {
      date: data.date || today(), cardId: data.cardId, qty: num(data.qty),
      notes: String(data.notes || '').trim(), itemNo: pick('itemNo'), name: pick('name'), origin: pick('origin'),
    };
  }

  function addWithdrawal(data) {
    const w = Object.assign({ uid: uid('w') }, withdrawalFields(data));
    dispatch('w.add', { w });
    return state.withdrawals.find((x) => x.uid === w.uid);
  }

  function updateWithdrawal(wuid, data) {
    dispatch('w.update', { uid: wuid, fields: withdrawalFields(data) });
    return state.withdrawals.find((x) => x.uid === wuid);
  }

  /* ---------- Dropbox sync ---------- */
  function setStatus() {
    if (!Cloud.connected()) return emit('status', { state: 'local' });
    if (syncing) return emit('status', { state: 'syncing' });
    if (meta.pending.length) return emit('status', { state: navigator.onLine ? 'pending' : 'offline', pending: meta.pending.length });
    emit('status', { state: 'synced', at: meta.lastSync });
  }

  function scheduleSync(ms = 0) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync(), ms);
  }

  async function snapshot(force) {
    const d = today();
    const last = meta.lastSnapshot;
    // One file per day, refreshed at most every 15 minutes; Dropbox also keeps each file's versions.
    if (!force && last && last.date === d && Date.now() - new Date(last.at).getTime() < 15 * 60000) return;
    try {
      await Cloud.upload(`${HISTORY_DIR}/${d}.json`, JSON.stringify(state), 'overwrite');
      meta.lastSnapshot = { date: d, at: new Date().toISOString() };
    } catch (e) { console.warn('snapshot failed', e); }
  }

  async function sync() {
    if (!Cloud.connected()) return setStatus();
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setStatus();
    let changed = false;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!meta.pending.length) {
          // Cheap metadata check first; only download when another device has saved.
          const rev = await Cloud.rev(MAIN_FILE);
          if (rev && rev === meta.rev) break;
          const remote = rev ? await Cloud.download(MAIN_FILE) : null;
          if (!remote) {
            const r = await Cloud.upload(MAIN_FILE, JSON.stringify(state), null);
            meta.rev = r.rev;
            await snapshot(true);
          } else if (remote.rev !== meta.rev && !meta.pending.length) {
            state = normalize(remote.data);
            meta.rev = remote.rev;
            changed = true;
          }
          break;
        }
        const sent = meta.pending.length;
        try {
          const r = await Cloud.upload(MAIN_FILE, JSON.stringify(state), meta.rev);
          meta.rev = r.rev;
          meta.pending = meta.pending.slice(sent); // ops made during the upload stay queued
          await snapshot();
          if (!meta.pending.length) break;
        } catch (e) {
          if (!e.conflict) throw e;
          // Another device saved first: rebuild from its copy and replay our queued ops.
          const remote = await Cloud.download(MAIN_FILE);
          const base = remote ? normalize(remote.data) : blank();
          meta.pending.forEach((op) => apply(base, op));
          state = base;
          meta.rev = remote ? remote.rev : null;
          changed = true;
        }
      }
      meta.lastSync = new Date().toISOString();
    } catch (e) {
      console.warn('sync failed', e);
      if (e.auth) emit('status', { state: 'auth' });
      else emit('status', { state: navigator.onLine ? 'sync-error' : 'offline', pending: meta.pending.length });
      syncing = false;
      schedulePersist();
      if (changed) emit('change');
      return;
    }
    syncing = false;
    schedulePersist();
    if (changed) emit('change');
    setStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }

  // First connection on this device: decide between Dropbox's copy and this device's copy.
  async function linkCloud(chooseLocal) {
    syncing = true;
    emit('status', { state: 'syncing' });
    try {
      const remote = await Cloud.download(MAIN_FILE);
      const localHasData = state.cards.length || state.withdrawals.length;
      if (!remote) {
        meta.rev = (await Cloud.upload(MAIN_FILE, JSON.stringify(state), null)).rev;
        await snapshot(true);
      } else {
        const r = normalize(remote.data);
        const remoteHasData = r.cards.length || r.withdrawals.length;
        if (localHasData && remoteHasData && (await chooseLocal({ cards: r.cards.length, withdrawals: r.withdrawals.length, updatedAt: r.updatedAt }))) {
          // Keep a copy of what is being replaced before overwriting it.
          await Cloud.upload(`${HISTORY_DIR}/replaced-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(r), 'overwrite');
          meta.rev = (await Cloud.upload(MAIN_FILE, JSON.stringify(state), 'overwrite')).rev;
          await snapshot(true);
        } else if (remoteHasData || !localHasData) {
          state = r;
          meta.rev = remote.rev;
        } else {
          meta.rev = (await Cloud.upload(MAIN_FILE, JSON.stringify(state), remote.rev)).rev;
          await snapshot(true);
        }
      }
      meta.pending = [];
      meta.lastSync = new Date().toISOString();
    } finally {
      syncing = false;
      schedulePersist();
      emit('change');
      setStatus();
    }
  }

  function unlinkCloud() {
    Cloud.disconnect();
    meta = blankMeta();
    schedulePersist();
    setStatus();
  }

  // Keep other devices' changes flowing in.
  setInterval(() => { if (Cloud.connected() && document.visibilityState === 'visible') sync(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Cloud.connected()) sync(); });
  window.addEventListener('online', () => Cloud.connected() && sync());
  window.addEventListener('beforeunload', (e) => {
    if (Cloud.connected() && meta.pending.length) { e.preventDefault(); e.returnValue = ''; }
  });

  window.Store = {
    load, compute, computeAsOf, periodSummary, today, num, norm, findCardByNo,
    upsertCard, setPhysical, addWithdrawal, updateWithdrawal,
    deleteCard: (cardId) => dispatch('card.delete', { cardId }),
    restoreCard: (cardId) => dispatch('card.restore', { cardId }),
    deleteWithdrawal: (wuid) => dispatch('w.delete', { uid: wuid }),
    restoreWithdrawal: (wuid) => dispatch('w.restore', { uid: wuid }),
    setSettings: (patch) => dispatch('settings', patch),
    replaceAll: (raw) => dispatch('replace', { state: normalize(raw) }),
    reset() { dispatch('replace', { state: Object.assign(blank(), { settings: state.settings }) }); },
    sync, linkCloud, unlinkCloud, setStatus,
    listHistory: () => Cloud.list(HISTORY_DIR),
    downloadHistory: (path) => Cloud.download(path),
    get state() { return state; },
    get meta() { return meta; },
    on(fn) { listeners.add(fn); },
  };
})();
