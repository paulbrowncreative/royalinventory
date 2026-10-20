/* UI controller: rendering, forms, dialogs, import/export. */
(function () {
  const { t } = I18N;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const PAGE = 25;

  const ui = {
    tab: 'dashboard',
    inv: { q: '', origin: '', status: '', page: 1 },
    log: { q: '', origin: '', from: '', to: '', page: 1 },
    items: { q: '', page: 1, open: new Set() },
    lookup: '',
    data: null,
  };

  /* ---------- Formatting ---------- */
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('en-US');
  const fmt = (n) => (n === null || n === undefined ? '—' : nf2.format(n));
  const fmtSigned = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + nf2.format(n));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const statusKey = { ok: 'stOk', low: 'stLow', out: 'stOut', negative: 'stNegative' };
  const valueClass = (status) => ({ ok: 'v-pos', low: 'v-warn', out: 'v-neg', negative: 'v-neg' }[status]);

  function badges(r) {
    let h = `<span class="badge badge--${r.status}">${t(statusKey[r.status])}</span>`;
    if (r.hasVariance) h += ` <span class="badge badge--variance">${t('stVariance')}</span>`;
    return h;
  }

  function data() {
    if (!ui.data) ui.data = Store.compute();
    return ui.data;
  }

  /* ---------- i18n ---------- */
  function applyI18n() {
    const lang = I18N.lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    const toggle = $('#langToggle');
    toggle.lang = lang === 'ar' ? 'en' : 'ar';
    toggle.setAttribute('aria-label', t('langSwitchLabel'));
    $('.skip-link').textContent = lang === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content';
    document.title = `${t('appTitle')} | ${t('brandName')} – ${t('brandTag')}`;
    $$('[data-close]').forEach((b) => b.matches('.icon-btn') && b.setAttribute('aria-label', lang === 'ar' ? 'إغلاق' : 'Close'));
    renderGuide();
  }

  /* ---------- Tabs ---------- */
  const TABS = ['dashboard', 'withdrawals', 'inventory', 'guide', 'settings'];
  function showTab(name, { focus = false, push = true } = {}) {
    if (!TABS.includes(name)) name = 'dashboard';
    ui.tab = name;
    $$('[role="tab"]').forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', on);
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    $$('.panel-view').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
    if (push && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    try { localStorage.setItem('royal-tab', name); } catch (_) {}
    render();
  }

  $('.tabs__list').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) showTab(tab.dataset.tab);
  });
  $('.tabs__list').addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = TABS.indexOf(ui.tab);
    const rtl = document.documentElement.dir === 'rtl';
    let n = i;
    if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else n = (i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1) + TABS.length) % TABS.length;
    showTab(TABS[n], { focus: true });
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1), { push: false }));

  /* ---------- Rendering ---------- */
  function render() {
    const d = data();
    renderShared(d);
    if (ui.tab === 'dashboard') renderDashboard(d);
    if (ui.tab === 'inventory') renderInventory(d);
    if (ui.tab === 'withdrawals') { renderLog(d); updateWithdrawalPreview(); }
    if (ui.tab === 'settings') $('#setThreshold').value = Store.state.settings.lowThreshold;
  }

  function renderShared(d) {
    const s = Store.state;
    $('#footMovements').textContent = nf0.format(s.withdrawals.length);
    $('#footUpdated').textContent = s.updatedAt ? new Date(s.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    const cards = d.rows.map((r) => r.card).sort((a, b) => natural.compare(a.cardNo, b.cardNo));
    $('#cardList').innerHTML = cards.map((c) => `<option value="${esc(c.cardNo)}">${esc(c.name)} · ${esc(c.itemNo)}</option>`).join('');
    const origins = [...new Set(s.cards.map((c) => c.origin).filter(Boolean))].sort();
    $('#originList').innerHTML = origins.map((o) => `<option value="${esc(o)}">`).join('');
    $('#itemList').innerHTML = [...d.items.values()].map((g) => `<option value="${esc(g.itemNo)}">${esc(g.name)}</option>`).join('');
    const originOpts = (sel, val) => { sel.innerHTML = `<option value="">${t('allOrigins')}</option>` + origins.map((o) => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join(''); };
    originOpts($('#invOrigin'), ui.inv.origin);
    originOpts($('#logOrigin'), ui.log.origin);
    $('#invStatus').innerHTML = [['', 'allStatuses'], ['negative', 'stNegative'], ['out', 'stOut'], ['low', 'stLow'], ['variance', 'stVariance'], ['alerts-all', 'attention'], ['ok', 'stOk']]
      .map(([v, k]) => `<option value="${v}"${v === ui.inv.status ? ' selected' : ''}>${t(k)}</option>`).join('');
    $('#emptyState').hidden = s.cards.length > 0;
  }

  const KPI_DEFS = [
    ['cards', 'kpiCards', 'i-layers', false],
    ['opening', 'kpiOpening', 'i-ruler', true],
    ['withdrawals', 'kpiWithdrawals', 'i-arrow-out', true],
    ['net', 'kpiNet', 'i-scale', true],
    ['low', 'kpiLow', 'i-alert', false, 'warn'],
    ['negative', 'kpiNegative', 'i-minus-circle', false, 'neg'],
    ['alerts', 'kpiAlerts', 'i-clipboard', false, 'var'],
  ];

  function renderDashboard(d) {
    const tt = d.totals;
    $('#kpis').innerHTML = KPI_DEFS.map(([k, label, icon, meters, tone]) => {
      const v = tt[k];
      const hint = k === 'low' ? t('kpiLowHint', { n: fmt(d.threshold) }) : k === 'alerts' ? t('kpiAlertsHint') : meters ? t('kpiMeters') : '';
      const filter = { low: 'low', negative: 'negative', alerts: 'variance' }[k];
      const toneCls = tone && v > 0 ? ` kpi--${tone}` : '';
      const inner = `<span class="kpi__icon"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></span>
        <span class="kpi__body"><span class="kpi__value ltr-num">${meters ? fmt(v) : nf0.format(v)}</span>
        <span class="kpi__label">${t(label)}${hint ? ` <small>${esc(hint)}</small>` : ''}</span></span>`;
      return `<li class="kpi${toneCls}">${filter ? `<button type="button" class="kpi__link" data-filter="${filter}">${inner}</button>` : inner}</li>`;
    }).join('');

    renderLookup(d);

    const rank = { negative: 0, out: 1, low: 2 };
    const att = d.rows.filter((r) => r.status !== 'ok' || r.hasVariance)
      .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.final - b.final);
    $('#attention').innerHTML = att.length
      ? `<ul class="att-list">${att.slice(0, 8).map((r) => `<li><button type="button" class="att-item" data-lookup="${esc(r.card.cardNo)}">
          <span class="att-item__main"><strong class="ltr-num">${esc(r.card.cardNo)}</strong> <span>${esc(r.card.name)}</span></span>
          <span class="att-item__meta">${badges(r)} <span class="ltr-num ${valueClass(r.status)}">${fmt(r.final)}</span></span></button></li>`).join('')}</ul>
        ${att.length > 8 ? `<button type="button" class="btn btn--link" data-filter="alerts-all">${t('viewAll')} (${att.length})</button>` : ''}`
      : `<p class="empty-note">${t('attentionEmpty')}</p>`;

    const q = Store.norm(ui.items.q);
    let groups = [...d.items.values()];
    if (q) groups = groups.filter((g) => Store.norm(g.itemNo).includes(q) || Store.norm(g.name).includes(q));
    groups.sort((a, b) => natural.compare(a.itemNo, b.itemNo));
    $('#itemsCount').textContent = t('itemsCount', { n: nf0.format(groups.length) });
    const { slice, pager } = paginate(groups, ui.items, 'items');
    $('#itemsBody').innerHTML = slice.length ? slice.map((g) => {
      const open = ui.items.open.has(g.itemNo);
      const worst = g.rows.some((r) => r.status === 'negative') ? 'negative' : g.final <= d.threshold ? (g.final <= 0 ? 'out' : 'low') : 'ok';
      const id = 'grp-' + encodeURIComponent(g.itemNo).replace(/[^\w-]/g, '');
      let h = `<tr class="row-group${open ? ' is-open' : ''}">
        <td data-label="${t('itemNo')}"><button type="button" class="expand" aria-expanded="${open}" aria-controls="${id}" data-group="${esc(g.itemNo)}">
          <svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg><strong class="ltr-num">${esc(g.itemNo)}</strong></button></td>
        <td data-label="${t('fabricName')}">${esc(g.name)}</td>
        <td data-label="${t('origin')}">${esc([...g.origins].join('، '))}</td>
        <td data-label="${t('cardsCount')}" class="num">${g.rows.length}</td>
        <td data-label="${t('openingStock')}" class="num">${fmt(g.opening)}</td>
        <td data-label="${t('totalWithdrawals')}" class="num">${fmt(g.total)}</td>
        <td data-label="${t('finalStock')}" class="num"><strong class="${valueClass(worst)}">${fmt(g.final)}</strong></td>
        <td data-label="${t('stockAlert')}"><span class="badge badge--${worst}">${t(statusKey[worst])}</span></td></tr>`;
      if (open) {
        h += `<tr class="row-detail" id="${id}"><td colspan="8"><ul class="mini-cards">${g.rows.sort((a, b) => natural.compare(a.card.cardNo, b.card.cardNo)).map((r) =>
          `<li><button type="button" class="mini-card" data-lookup="${esc(r.card.cardNo)}"><strong class="ltr-num">${esc(r.card.cardNo)}</strong>
           <span class="ltr-num ${valueClass(r.status)}">${fmt(r.final)} ${t('kpiMeters')}</span>${badges(r)}</button></li>`).join('')}</ul></td></tr>`;
      }
      return h;
    }).join('') : `<tr class="row-empty"><td colspan="8">${Store.state.cards.length ? t('noResults') : t('noCardsYet')}</td></tr>`;
    $('#itemsPager').innerHTML = pager;
  }

  function renderLookup(d) {
    const box = $('#lookupResult');
    if (!ui.lookup) { box.innerHTML = `<p class="empty-note">${t('cardLookupEmpty')}</p>`; return; }
    const card = Store.findCardByNo(ui.lookup);
    if (!card) { box.innerHTML = `<p class="empty-note empty-note--warn">${t('cardNotFound')}</p>`; return; }
    const r = d.rowByCardId.get(card.id);
    const recent = [...r.list].reverse().slice(0, 5);
    const stat = (k, v, cls = '') => `<div class="stat"><dt>${t(k)}</dt><dd class="ltr-num ${cls}">${v}</dd></div>`;
    box.innerHTML = `
      <div class="lookup-card">
        <div class="lookup-card__head">
          <div><p class="eyebrow">${t('cardNo')}</p><p class="lookup-card__no ltr-num">${esc(card.cardNo)}</p></div>
          <div class="lookup-card__badges">${badges(r)}</div>
        </div>
        <p class="lookup-card__name">${esc(card.name)} · <span class="ltr-num">${esc(card.itemNo)}</span>${card.origin ? ' · ' + esc(card.origin) : ''}</p>
        <dl class="stats">
          ${stat('finalStock', fmt(r.final), valueClass(r.status) + ' stat--lead')}
          ${stat('openingStock', fmt(r.opening))}
          ${stat('totalWithdrawals', fmt(r.total))}
          ${stat('calcBalance', fmt(r.calc))}
          ${stat('physicalCount', card.physical !== null ? fmt(card.physical) : '—')}
          ${stat('variance', fmtSigned(r.variance), r.hasVariance ? (r.variance < 0 ? 'v-neg' : 'v-warn') : '')}
        </dl>
        <div class="btn-row">
          <button type="button" class="btn btn--gold btn--sm" data-withdraw="${esc(card.id)}"><svg class="icon" aria-hidden="true"><use href="#i-scissors"/></svg>${t('withdrawFromCard')}</button>
          <button type="button" class="btn btn--ghost btn--sm" data-count="${esc(card.id)}"><svg class="icon" aria-hidden="true"><use href="#i-clipboard"/></svg>${t('recordCount')}</button>
          <button type="button" class="btn btn--ghost btn--sm" data-edit-card="${esc(card.id)}"><svg class="icon" aria-hidden="true"><use href="#i-edit"/></svg>${t('edit')}</button>
        </div>
        <h4 class="sub-head">${t('recentWithdrawals')}</h4>
        ${recent.length ? `<ul class="history">${recent.map((w) => `<li><span class="ltr-num">${esc(w.date)}</span><span>${esc(w.notes || '—')}</span><strong class="ltr-num">−${fmt(w.qty)}</strong></li>`).join('')}</ul>` : `<p class="empty-note">${t('noWithdrawals')}</p>`}
      </div>`;
  }

  function filteredInventory(d) {
    const f = ui.inv;
    const q = Store.norm(f.q);
    return d.rows.filter((r) => {
      const c = r.card;
      if (q && ![c.cardNo, c.itemNo, c.name, c.origin].some((v) => Store.norm(v).includes(q))) return false;
      if (f.origin && c.origin !== f.origin) return false;
      if (f.status === 'variance') return r.hasVariance;
      if (f.status === 'low') return r.status === 'low' || r.status === 'out';
      if (f.status === 'alerts-all') return r.status !== 'ok' || r.hasVariance;
      if (f.status && r.status !== f.status) return false;
      return true;
    }).sort((a, b) => natural.compare(a.card.cardNo, b.card.cardNo));
  }

  function renderInventory(d) {
    const rows = filteredInventory(d);
    $('#invCount').textContent = t('rowsShown', { n: nf0.format(rows.length) });
    const { slice, pager } = paginate(rows, ui.inv, 'inv');
    $('#invBody').innerHTML = slice.length ? slice.map((r) => {
      const c = r.card;
      return `<tr>
        <th scope="row" data-label="${t('cardNo')}" class="ltr-num">${esc(c.cardNo)}</th>
        <td data-label="${t('entryDate')}" class="ltr-num">${esc(c.entryDate)}</td>
        <td data-label="${t('itemNo')}" class="ltr-num">${esc(c.itemNo)}</td>
        <td data-label="${t('fabricName')}">${esc(c.name)}</td>
        <td data-label="${t('origin')}">${esc(c.origin || '—')}</td>
        <td data-label="${t('openingStock')}" class="num">${fmt(r.opening)}</td>
        <td data-label="${t('totalWithdrawals')}" class="num">${fmt(r.total)}</td>
        <td data-label="${t('calcBalance')}" class="num">${fmt(r.calc)}</td>
        <td data-label="${t('physicalCount')}" class="num">${c.physical !== null ? fmt(c.physical) : '—'}</td>
        <td data-label="${t('finalStock')}" class="num"><strong class="${valueClass(r.status)}">${fmt(r.final)}</strong></td>
        <td data-label="${t('variance')}" class="num ${r.hasVariance ? (r.variance < 0 ? 'v-neg' : 'v-warn') : ''}">${fmtSigned(r.variance)}</td>
        <td data-label="${t('stockAlert')}">${badges(r)}</td>
        <td data-label="${t('physicalDate')}" class="ltr-num">${esc(c.physicalDate || '—')}</td>
        <td class="actions">
          <button type="button" class="icon-btn" data-count="${esc(c.id)}" title="${t('recordCount')}" aria-label="${t('recordCount')} ${esc(c.cardNo)}"><svg class="icon" aria-hidden="true"><use href="#i-clipboard"/></svg></button>
          <button type="button" class="icon-btn" data-edit-card="${esc(c.id)}" title="${t('edit')}" aria-label="${t('edit')} ${esc(c.cardNo)}"><svg class="icon" aria-hidden="true"><use href="#i-edit"/></svg></button>
          <button type="button" class="icon-btn icon-btn--danger" data-del-card="${esc(c.id)}" title="${t('delete')}" aria-label="${t('delete')} ${esc(c.cardNo)}"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </td></tr>`;
    }).join('') : `<tr class="row-empty"><td colspan="14">${Store.state.cards.length ? t('noResults') : `${t('noCardsYet')} <button type="button" class="btn btn--link" data-action="add-card">${t('addCard')}</button>`}</td></tr>`;
    $('#invPager').innerHTML = pager;
  }

  function filteredLog(d) {
    const f = ui.log;
    const q = Store.norm(f.q);
    const cards = new Map(Store.state.cards.map((c) => [c.id, c]));
    return Store.state.withdrawals.map((w) => ({ w, c: cards.get(w.cardId) })).filter(({ w, c }) => {
      if (!c) return false;
      if (f.origin && c.origin !== f.origin) return false;
      if (f.from && w.date < f.from) return false;
      if (f.to && w.date > f.to) return false;
      if (q && ![w.id, c.cardNo, c.itemNo, c.name, w.notes].some((v) => Store.norm(v).includes(q))) return false;
      return true;
    }).sort((a, b) => (a.w.date === b.w.date ? b.w.seq - a.w.seq : a.w.date < b.w.date ? 1 : -1));
  }

  function renderLog(d) {
    const rows = filteredLog(d);
    $('#logCount').textContent = t('rowsShown', { n: nf0.format(rows.length) });
    const { slice, pager } = paginate(rows, ui.log, 'log');
    $('#logBody').innerHTML = slice.length ? slice.map(({ w, c }) => {
      const after = d.runningAfter.get(w.id);
      const g = d.items.get(Store.norm(c.itemNo) || '—');
      const cls = after < 0 ? 'v-neg' : after <= d.threshold ? 'v-warn' : 'v-pos';
      return `<tr>
        <th scope="row" data-label="${t('wId')}" class="ltr-num muted-cell">${esc(w.id)}</th>
        <td data-label="${t('wDate')}" class="ltr-num">${esc(w.date)}</td>
        <td data-label="${t('cardNo')}" class="ltr-num"><button type="button" class="link-cell" data-lookup="${esc(c.cardNo)}">${esc(c.cardNo)}</button></td>
        <td data-label="${t('itemNo')}" class="ltr-num">${esc(c.itemNo)}</td>
        <td data-label="${t('fabricName')}">${esc(c.name)}</td>
        <td data-label="${t('origin')}">${esc(c.origin || '—')}</td>
        <td data-label="${t('wQty')}" class="num"><strong>${fmt(w.qty)}</strong></td>
        <td data-label="${t('wCardAfter')}" class="num"><strong class="${cls}">${fmt(after)}</strong></td>
        <td data-label="${t('wItemTotal')}" class="num"><span class="${g && g.final < 0 ? 'v-neg' : 'v-pos'}">${fmt(g ? g.final : null)}</span></td>
        <td data-label="${t('wNotes')}">${esc(w.notes || '—')}</td>
        <td class="actions">
          <button type="button" class="icon-btn" data-edit-w="${esc(w.id)}" title="${t('edit')}" aria-label="${t('edit')} ${esc(w.id)}"><svg class="icon" aria-hidden="true"><use href="#i-edit"/></svg></button>
          <button type="button" class="icon-btn icon-btn--danger" data-del-w="${esc(w.id)}" title="${t('delete')}" aria-label="${t('delete')} ${esc(w.id)}"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </td></tr>`;
    }).join('') : `<tr class="row-empty"><td colspan="11">${Store.state.withdrawals.length ? t('noResults') : t('noWithdrawalsYet')}</td></tr>`;
    $('#logPager').innerHTML = pager;
  }

  function paginate(list, state, key) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
    const pager = pages > 1 ? `
      <button type="button" class="btn btn--ghost btn--sm" data-page="${key}:${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>${t('prev')}</button>
      <span class="pager__info">${t('pageOf', { p: state.page, t: pages })}</span>
      <button type="button" class="btn btn--ghost btn--sm" data-page="${key}:${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>${t('next')}</button>` : '';
    return { slice, pager };
  }

  function renderGuide() {
    $('#guide').innerHTML = `
      <section class="card-panel guide__intro">
        <header class="card-panel__head"><svg class="icon" aria-hidden="true"><use href="#i-book"/></svg><h2>${t('guideTitle')}</h2></header>
        <p class="lead">${t('guideIntro')}</p>
        <ol class="steps">${t('guideSteps').map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('')}</ol>
      </section>
      <div class="guide__cols">
        <section class="card-panel">
          <header class="card-panel__head"><svg class="icon" aria-hidden="true"><use href="#i-scale"/></svg><h2>${t('guideFormulas')}</h2></header>
          <dl class="formulas">${t('guideFormulaList').map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        </section>
        <section class="card-panel">
          <header class="card-panel__head"><svg class="icon" aria-hidden="true"><use href="#i-crown"/></svg><h2>${t('guideTips')}</h2></header>
          <ul class="tips">${t('guideTipList').map((x) => `<li>${x}</li>`).join('')}</ul>
        </section>
      </div>`;
  }

  /* ---------- Toasts & confirm ---------- */
  function toast(msg, { undo, tone } = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ' toast--' + tone : '');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn--link'; b.textContent = t('undo');
      b.onclick = () => { undo(); el.remove(); };
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('is-out'), undo ? 7000 : 3800);
    setTimeout(() => el.remove(), undo ? 7400 : 4200);
  }

  const confirmDlg = document.createElement('dialog');
  confirmDlg.className = 'dialog dialog--sm';
  confirmDlg.innerHTML = `<form method="dialog"><div class="dialog__body stack"><p class="confirm-msg"></p>
    <input class="input confirm-word" autocomplete="off" hidden aria-label="confirm"></div>
    <footer class="dialog__foot"><span class="spacer"></span><button class="btn btn--ghost" value="no"></button><button class="btn" value="yes"></button></footer></form>`;
  document.body.appendChild(confirmDlg);

  function ask(message, { danger = false, word = null, okLabel } = {}) {
    return new Promise((resolve) => {
      $('.confirm-msg', confirmDlg).textContent = message;
      const input = $('.confirm-word', confirmDlg);
      input.hidden = !word; input.value = '';
      const [no, yes] = $$('button', confirmDlg);
      no.textContent = t('cancel');
      yes.textContent = okLabel || (danger ? t('delete') : 'OK');
      yes.className = 'btn ' + (danger ? 'btn--danger' : 'btn--gold');
      confirmDlg.onclose = () => {
        const ok = confirmDlg.returnValue === 'yes' && (!word || input.value.trim().toUpperCase() === word.toUpperCase());
        resolve(ok);
      };
      confirmDlg.returnValue = '';
      confirmDlg.showModal();
      (word ? input : no).focus();
    });
  }

  /* ---------- Field validation helpers ---------- */
  function setError(input, msg) {
    const out = document.getElementById(input.getAttribute('aria-describedby'));
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (out) out.textContent = msg || '';
    return !msg;
  }

  /* ---------- Card dialog ---------- */
  const cardDialog = $('#cardDialog');
  const cardForm = $('#cardForm');

  function openCardDialog(id) {
    const card = id ? Store.state.cards.find((c) => c.id === id) : null;
    cardForm.reset();
    $$('[aria-invalid]', cardForm).forEach((i) => setError(i, ''));
    $('#cardDialogTitle').textContent = card ? `${t('editCard')} · ${card.cardNo}` : t('newCard');
    cardForm.id.value = card ? card.id : '';
    cardForm.cardNo.value = card ? card.cardNo : suggestCardNo();
    cardForm.entryDate.value = card ? card.entryDate : Store.today();
    cardForm.itemNo.value = card ? card.itemNo : '';
    cardForm.name.value = card ? card.name : '';
    cardForm.origin.value = card ? card.origin : '';
    cardForm.opening.value = card ? card.opening : '';
    cardDialog.showModal();
    (card ? cardForm.opening : cardForm.itemNo).focus();
  }

  function suggestCardNo() {
    const nums = Store.state.cards.map((c) => /^K-(\d+)$/i.exec(c.cardNo)).filter(Boolean).map((m) => +m[1]);
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return 'K-' + String(next).padStart(4, '0');
  }

  // Typing a known item number fills in its name and origin.
  cardForm.itemNo.addEventListener('change', () => {
    const g = data().items.get(Store.norm(cardForm.itemNo.value));
    if (!g) return;
    if (!cardForm.name.value) cardForm.name.value = g.name;
    if (!cardForm.origin.value && g.origins.size) cardForm.origin.value = [...g.origins][0];
  });

  cardForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = cardForm;
    const id = f.id.value;
    let ok = true;
    const dup = Store.findCardByNo(f.cardNo.value);
    ok = setError(f.cardNo, !f.cardNo.value.trim() ? t('required') : dup && dup.id !== id ? t('duplicateCard') : '') && ok;
    ok = setError(f.itemNo, f.itemNo.value.trim() ? '' : t('required')) && ok;
    ok = setError(f.name, f.name.value.trim() ? '' : t('required')) && ok;
    const op = Store.num(f.opening.value);
    ok = setError(f.opening, op === null ? t('required') : op < 0 ? t('nonNegative') : '') && ok;
    if (!ok) { $('[aria-invalid="true"]', f).focus(); return; }
    const card = Store.upsertCard({ id: id || undefined, cardNo: f.cardNo.value, entryDate: f.entryDate.value, itemNo: f.itemNo.value, name: f.name.value, origin: f.origin.value, opening: op });
    cardDialog.close();
    toast(t('savedCard', { c: card.cardNo }));
  });

  /* ---------- Physical count dialog ---------- */
  const countDialog = $('#countDialog');
  const countForm = $('#countForm');
  function openCountDialog(id) {
    const card = Store.state.cards.find((c) => c.id === id);
    const r = data().rowByCardId.get(id);
    countForm.reset();
    setError(countForm.physical, '');
    countForm.id.value = id;
    $('#countDialogTitle').textContent = `${t('recordCount')} · ${card.cardNo}`;
    $('#countRef').innerHTML = `${esc(card.name)} · <span class="ltr-num">${esc(card.itemNo)}</span><br>${t('calcBalance')}: <strong class="ltr-num">${fmt(r.calc)}</strong>`;
    countForm.physical.value = card.physical ?? '';
    countForm.physicalDate.value = card.physicalDate || Store.today();
    $('#clearCount').hidden = card.physical === null;
    countDialog.showModal();
    countForm.physical.focus();
  }
  countForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Store.num(countForm.physical.value);
    if (!setError(countForm.physical, v === null ? t('required') : v < 0 ? t('nonNegative') : '')) return countForm.physical.focus();
    const card = Store.setPhysical(countForm.id.value, v, countForm.physicalDate.value);
    countDialog.close();
    toast(t('savedCount', { c: card.cardNo }));
  });
  $('#clearCount').addEventListener('click', () => {
    Store.setPhysical(countForm.id.value, null);
    countDialog.close();
  });

  /* ---------- Withdrawal form ---------- */
  const wForm = $('#wForm');
  wForm.date.value = Store.today();

  function updateWithdrawalPreview() {
    const card = Store.findCardByNo(wForm.cardNo.value);
    $('#wItemNo').value = card ? card.itemNo : '';
    $('#wName').value = card ? card.name : '';
    $('#wOrigin').value = card ? card.origin : '';
    const box = $('#wAvail');
    if (!card) { box.innerHTML = ''; return; }
    const r = data().rowByCardId.get(card.id);
    const qty = Store.num(wForm.qty.value) || 0;
    const after = Math.round((r.final - qty) * 100) / 100;
    const cls = after < 0 ? 'v-neg' : after <= data().threshold ? 'v-warn' : 'v-pos';
    box.innerHTML = `<span>${t('availableInCard')}: <strong class="ltr-num ${valueClass(r.status)}">${fmt(r.final)}</strong></span>
      ${qty ? `<span>${t('afterWithdrawal')}: <strong class="ltr-num ${cls}">${fmt(after)}</strong></span>` : ''}`;
  }
  wForm.cardNo.addEventListener('input', () => { setError(wForm.cardNo, ''); updateWithdrawalPreview(); });
  wForm.qty.addEventListener('input', () => { setError(wForm.qty, ''); updateWithdrawalPreview(); });

  wForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const card = Store.findCardByNo(wForm.cardNo.value);
    const qty = Store.num(wForm.qty.value);
    let ok = setError(wForm.cardNo, !wForm.cardNo.value.trim() ? t('required') : !card ? t('unknownCard') : '');
    ok = setError(wForm.qty, qty === null ? t('required') : qty <= 0 ? t('positive') : '') && ok;
    if (!wForm.date.value) wForm.date.value = Store.today();
    if (!ok) { $('[aria-invalid="true"]', wForm).focus(); return; }
    const r = data().rowByCardId.get(card.id);
    const after = Math.round((r.final - qty) * 100) / 100;
    if (after < 0 && !(await ask(t('wouldGoNegative', { v: fmt(after) }), { okLabel: t('addWithdrawal') }))) return;
    const w = Store.addWithdrawal({ date: wForm.date.value, cardId: card.id, qty, notes: wForm.notes.value });
    toast(t('savedWithdrawal', { id: w.id, v: fmt(data().runningAfter.get(w.id)) }), { undo: () => Store.deleteWithdrawal(w.id) });
    wForm.cardNo.value = ''; wForm.qty.value = ''; wForm.notes.value = '';
    updateWithdrawalPreview();
    wForm.cardNo.focus();
  });

  /* ---------- Withdrawal edit dialog ---------- */
  const wDialog = $('#wDialog');
  const wEdit = $('#wEditForm');
  function openWithdrawalDialog(id) {
    const w = Store.state.withdrawals.find((x) => x.id === id);
    const c = Store.state.cards.find((x) => x.id === w.cardId);
    $$('[aria-invalid]', wEdit).forEach((i) => setError(i, ''));
    $('#wDialogTitle').textContent = `${t('editWithdrawal')} · ${w.id}`;
    wEdit.id.value = w.id; wEdit.date.value = w.date; wEdit.cardNo.value = c ? c.cardNo : '';
    wEdit.qty.value = w.qty; wEdit.notes.value = w.notes;
    wDialog.showModal();
    wEdit.qty.focus();
  }
  wEdit.addEventListener('submit', (e) => {
    e.preventDefault();
    const card = Store.findCardByNo(wEdit.cardNo.value);
    const qty = Store.num(wEdit.qty.value);
    let ok = setError(wEdit.cardNo, !card ? t('unknownCard') : '');
    ok = setError(wEdit.qty, qty === null || qty <= 0 ? t('positive') : '') && ok;
    if (!ok) return;
    const w = Store.updateWithdrawal(wEdit.id.value, { date: wEdit.date.value || Store.today(), cardId: card.id, qty, notes: wEdit.notes.value });
    wDialog.close();
    toast(t('updatedWithdrawal', { id: w.id }));
  });

  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  /* ---------- Global click delegation ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button, [data-action]');
    if (!el) return;
    const ds = el.dataset;

    if (ds.page) {
      const [key, p] = ds.page.split(':');
      ui[key].page = +p; render();
      return;
    }
    if (ds.group !== undefined) {
      const s = ui.items.open;
      s.has(ds.group) ? s.delete(ds.group) : s.add(ds.group);
      render();
      return;
    }
    if (ds.lookup) {
      ui.lookup = ds.lookup;
      $('#lookupInput').value = ds.lookup;
      showTab('dashboard');
      $('#lookupResult').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      return;
    }
    if (ds.filter) {
      Object.assign(ui.inv, { q: '', origin: '', status: ds.filter, page: 1 });
      $('#invSearch').value = '';
      showTab('inventory');
      return;
    }
    if (ds.withdraw) {
      const c = Store.state.cards.find((x) => x.id === ds.withdraw);
      showTab('withdrawals');
      wForm.cardNo.value = c.cardNo; updateWithdrawalPreview(); wForm.qty.focus();
      return;
    }
    if (ds.count) return openCountDialog(ds.count);
    if (ds.editCard) return openCardDialog(ds.editCard);
    if (ds.editW) return openWithdrawalDialog(ds.editW);
    if (ds.delCard) {
      const c = Store.state.cards.find((x) => x.id === ds.delCard);
      const n = Store.state.withdrawals.filter((w) => w.cardId === c.id).length;
      if (!(await ask(t('confirmDeleteCard', { c: c.cardNo, n }), { danger: true }))) return;
      const snap = Store.deleteCard(c.id);
      toast(t('deletedCard', { c: c.cardNo, n }), { undo: () => Store.restoreCard(snap) });
      return;
    }
    if (ds.delW) {
      if (!(await ask(t('confirmDeleteWithdrawal', { id: ds.delW }), { danger: true }))) return;
      const snap = Store.deleteWithdrawal(ds.delW);
      toast(t('deletedWithdrawal', { id: ds.delW }), { undo: () => Store.restoreWithdrawal(snap) });
      return;
    }

    switch (ds.action) {
      case 'add-card': return openCardDialog();
      case 'goto-settings': return showTab('settings');
      case 'load-demo': if (await ask(t('demoConfirm'))) { loadDemo(); toast(t('demoLoaded')); } return;
      case 'export-cards': return exportCards();
      case 'export-withdrawals': return exportWithdrawals();
      case 'backup': return download(`royal-inventory-backup-${Store.today()}.json`, JSON.stringify(Store.state, null, 1), 'application/json');
      case 'template-cards': return download('cards-template.csv', toCsv([CARD_COLS.map((c) => c.label())], true));
      case 'template-withdrawals': return download('withdrawals-template.csv', toCsv([W_COLS.map((c) => c.label())], true));
      case 'reset':
        if (await ask(t('confirmReset'), { danger: true, word: t('resetWord') })) { Store.reset(); toast(t('resetDone')); }
        return;
    }
  });

  /* ---------- Filters & search ---------- */
  const debounce = (fn, ms = 160) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  $('#invSearch').addEventListener('input', debounce((e) => { ui.inv.q = e.target.value; ui.inv.page = 1; render(); }));
  $('#invOrigin').addEventListener('change', (e) => { ui.inv.origin = e.target.value; ui.inv.page = 1; render(); });
  $('#invStatus').addEventListener('change', (e) => { ui.inv.status = e.target.value; ui.inv.page = 1; render(); });
  $('#logSearch').addEventListener('input', debounce((e) => { ui.log.q = e.target.value; ui.log.page = 1; render(); }));
  $('#logOrigin').addEventListener('change', (e) => { ui.log.origin = e.target.value; ui.log.page = 1; render(); });
  $('#logFrom').addEventListener('change', (e) => { ui.log.from = e.target.value; ui.log.page = 1; render(); });
  $('#logTo').addEventListener('change', (e) => { ui.log.to = e.target.value; ui.log.page = 1; render(); });
  $('#itemSearch').addEventListener('input', debounce((e) => { ui.items.q = e.target.value; ui.items.page = 1; render(); }));
  $('#lookupForm').addEventListener('submit', (e) => { e.preventDefault(); ui.lookup = $('#lookupInput').value.trim(); render(); });
  $('#lookupInput').addEventListener('change', (e) => { ui.lookup = e.target.value.trim(); render(); });

  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Store.num($('#setThreshold').value);
    if (v === null || v < 0) return $('#setThreshold').focus();
    Store.setSettings({ lowThreshold: v });
    toast(t('settingsSaved'));
  });

  $('#langToggle').addEventListener('click', () => {
    const next = I18N.lang === 'ar' ? 'en' : 'ar';
    I18N.set(next);
    Store.setSettings({ lang: next });
    applyI18n();
    render();
  });

  /* ---------- CSV / files ---------- */
  const CARD_COLS = [
    { key: 'cardNo', label: () => t('cardNo'), get: (r) => r.card.cardNo },
    { key: 'entryDate', label: () => t('entryDate'), get: (r) => r.card.entryDate },
    { key: 'itemNo', label: () => t('itemNo'), get: (r) => r.card.itemNo },
    { key: 'name', label: () => t('fabricName'), get: (r) => r.card.name },
    { key: 'origin', label: () => t('origin'), get: (r) => r.card.origin },
    { key: 'opening', label: () => t('openingStock'), get: (r) => r.opening },
    { key: null, label: () => t('totalWithdrawals'), get: (r) => r.total },
    { key: null, label: () => t('calcBalance'), get: (r) => r.calc },
    { key: 'physical', label: () => t('physicalCount'), get: (r) => r.card.physical ?? '' },
    { key: null, label: () => t('finalStock'), get: (r) => r.final },
    { key: null, label: () => t('variance'), get: (r) => r.variance ?? '' },
    { key: null, label: () => t('stockAlert'), get: (r) => t(statusKey[r.status]) + (r.hasVariance ? ' / ' + t('stVariance') : '') },
    { key: 'physicalDate', label: () => t('physicalDate'), get: (r) => r.card.physicalDate },
  ];
  const W_COLS = [
    { key: 'date', label: () => t('wDate'), get: (x) => x.w.date },
    { key: null, label: () => t('wId'), get: (x) => x.w.id },
    { key: 'cardNo', label: () => t('cardNo'), get: (x) => x.c.cardNo },
    { key: null, label: () => t('itemNo'), get: (x) => x.c.itemNo },
    { key: null, label: () => t('fabricName'), get: (x) => x.c.name },
    { key: null, label: () => t('origin'), get: (x) => x.c.origin },
    { key: 'qty', label: () => t('wQty'), get: (x) => x.w.qty },
    { key: 'notes', label: () => t('wNotes'), get: (x) => x.w.notes },
  ];

  function toCsv(rows, bom) {
    const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return (bom ? '﻿' : '') + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }
  function download(name, content, type = 'text/csv;charset=utf-8') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportCards() {
    const rows = filteredInventory(data());
    download(`inventory-${Store.today()}.csv`, toCsv([CARD_COLS.map((c) => c.label()), ...rows.map((r) => CARD_COLS.map((c) => c.get(r)))], true));
  }
  function exportWithdrawals() {
    const rows = filteredLog(data());
    download(`withdrawals-${Store.today()}.csv`, toCsv([W_COLS.map((c) => c.label()), ...rows.map((x) => W_COLS.map((c) => c.get(x)))], true));
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const delim = (text.split(/\r?\n/)[0].match(/;/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  // Map a header (Arabic or English, with or without the "(m)" suffix) to a field key.
  function headerMap(cols, header) {
    const clean = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    const aliases = new Map();
    const cur = I18N.lang;
    ['ar', 'en'].forEach((l) => { I18N.set(l); cols.forEach((c) => c.key && aliases.set(clean(c.label()), c.key)); });
    I18N.set(cur);
    cols.forEach((c) => c.key && aliases.set(clean(c.key), c.key));
    return header.map((h) => aliases.get(clean(h)) || null);
  }

  function normDate(v) {
    v = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
  }

  async function handleImport(kind, file) {
    let text;
    try { text = await file.text(); } catch (_) { return toast(t('importFailed'), { tone: 'error' }); }
    if (kind === 'backup') {
      let obj;
      try { obj = JSON.parse(text); if (!Array.isArray(obj.cards)) throw 0; } catch (_) { return toast(t('importFailed'), { tone: 'error' }); }
      if (!(await ask(t('restoreConfirm')))) return;
      Store.replaceAll(obj);
      I18N.set(Store.state.settings.lang); applyI18n();
      return toast(t('restoreDone', { c: obj.cards.length, w: (obj.withdrawals || []).length }));
    }
    const rows = parseCsv(text);
    if (rows.length < 2) return toast(t('importFailed'), { tone: 'error' });
    const map = headerMap(kind === 'cards' ? CARD_COLS : W_COLS, rows[0]);
    let n = 0, skipped = 0;
    rows.slice(1).forEach((r) => {
      const o = {};
      map.forEach((k, i) => { if (k) o[k] = (r[i] || '').trim(); });
      if (kind === 'cards') {
        if (!o.cardNo || Store.findCardByNo(o.cardNo)) { skipped++; return; }
        const physical = Store.num(o.physical);
        Store.upsertCard({ ...o, entryDate: normDate(o.entryDate) || Store.today(), physical, physicalDate: normDate(o.physicalDate) || Store.today() });
      } else {
        const card = Store.findCardByNo(o.cardNo);
        const qty = Store.num(o.qty);
        if (!card || !qty || qty <= 0) { skipped++; return; }
        Store.addWithdrawal({ date: normDate(o.date) || Store.today(), cardId: card.id, qty, notes: o.notes });
      }
      n++;
    });
    toast(t('importDone', { n, s: skipped }), { tone: n ? undefined : 'error' });
  }
  $$('[data-import]').forEach((inp) => inp.addEventListener('change', () => {
    if (inp.files[0]) handleImport(inp.dataset.import, inp.files[0]);
    inp.value = '';
  }));

  /* ---------- Sample data (clearly labelled demo content) ---------- */
  function loadDemo() {
    const fabrics = [
      ['1001', 'قطن سادة', 'تركيا', 365], ['1002', 'لينن', 'إيطاليا', 16], ['1003', 'صوف', 'إنجلترا', 10],
      ['1004', 'كشمير', 'إيطاليا', 30], ['1005', 'حرير', 'الصين', 10], ['1006', 'فيسكوز', 'الهند', 20],
      ['1007', 'مخمل', 'إيطاليا', 10], ['1008', 'ساتان', 'تركيا', 20], ['1009', 'دنيم', 'الصين', 40],
    ];
    const ids = {};
    fabrics.forEach(([item, name, origin, opening], i) => {
      const no = 'K-' + String(i + 1).padStart(4, '0');
      if (Store.findCardByNo(no)) { ids[item] = Store.findCardByNo(no).id; return; }
      ids[item] = Store.upsertCard({ cardNo: no, entryDate: '2026-10-01', itemNo: item, name, origin, opening }).id;
    });
    const extra = Store.findCardByNo('K-0010') || Store.upsertCard({ cardNo: 'K-0010', entryDate: '2026-10-01', itemNo: '1001', name: 'قطن سادة', origin: 'تركيا', opening: 320 });
    [
      ['2026-10-08', '1009', 7, 'بنطال'], ['2026-10-08', '1008', 1.5, 'فستان سهرة'], ['2026-10-09', '1007', 4, 'ستارة'],
      ['2026-10-09', '1006', 6, ''], ['2026-10-10', '1001', 2, 'إعادة تفصيل'], ['2026-10-10', '1005', 1.2, 'فستان'],
      ['2026-10-11', '1004', 2, 'جاكيت'], ['2026-10-11', '1003', 10, ''], ['2026-10-12', '1002', 3.5, 'قميص'],
      ['2026-10-12', '1001', 5, 'تفصيل بدلة'],
    ].forEach(([date, item, qty, notes]) => Store.addWithdrawal({ date, cardId: ids[item], qty, notes }));
    Store.setPhysical(ids['1004'], 27.5, '2026-10-15');
    Store.addWithdrawal({ date: '2026-10-14', cardId: extra.id, qty: 12, notes: 'ثوب' });
  }

  /* ---------- Save status & boot ---------- */
  let renderQueued = false;
  Store.on((type) => {
    if (type === 'change') {
      ui.data = null;
      // Batch bursts of mutations (imports, demo data) into a single paint.
      if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
      return;
    }
    const el = $('#saveStatus');
    el.dataset.state = type;
    $('.save-status__text', el).textContent = t(type === 'saving' ? 'saving' : type === 'saved' ? 'saved' : 'saveError');
  });

  $('#year').textContent = new Date().getFullYear();

  Store.load().then(() => {
    I18N.set(Store.state.settings.lang || 'ar');
    applyI18n();
    let start = location.hash.slice(1);
    if (!TABS.includes(start)) { try { start = localStorage.getItem('royal-tab'); } catch (_) {} }
    showTab(TABS.includes(start) ? start : 'dashboard', { push: !!start });
    document.body.classList.add('is-ready');
  });
})();
