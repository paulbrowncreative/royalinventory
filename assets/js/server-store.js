/* Shared storage on the site itself (Netlify Function + Blobs): same interface as the Dropbox
 * client, so the sync engine in store.js works unchanged. Used automatically when the site is
 * served by Netlify; every signed-in device then shares one inventory with no setup. */
(function () {
  const FLAG = 'royal-server-storage';
  const API = '/api/store';
  let available = (() => { try { return localStorage.getItem(FLAG) === '1'; } catch (_) { return false; } })();

  const keyOf = (path) => {
    const k = String(path).replace(/^\//, '').replace(/\.json$/, '');
    return k === 'royal-inventory' ? 'main' : k;
  };
  const url = (params) => API + '?' + new URLSearchParams(params);

  // Netlify Functions accept and return at most ~6 MB, so the inventory travels gzip-compressed
  // (JSON shrinks about 10x). Browsers without CompressionStream send and receive plain JSON.
  const canGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  const pipe = (data, stream) => new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer();
  const gzip = (text) => pipe(text, new CompressionStream('gzip'));
  const readText = async (res) => res.headers.get('x-body-encoding') === 'gzip'
    ? new TextDecoder().decode(await pipe(await res.arrayBuffer(), new DecompressionStream('gzip')))
    : res.text();
  const accept = canGzip ? { headers: { 'x-accept-gzip': '1' } } : {};

  // Signed-in sessions renew themselves on page loads; a page left open longer than the access
  // token lives renews here instead, then retries once.
  async function call(target, init = {}, retried) {
    const res = await fetch(target, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init));
    if (res.status === 401 && !retried) {
      const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
      if (r && r.ok) return call(target, init, true);
    }
    if (res.status === 401) throw Object.assign(new Error('Signed out — please sign in again.'), { auth: true });
    if (res.status === 429 || res.status >= 500) throw new Error('Shared storage is busy (' + res.status + ').');
    return res;
  }

  // Is shared storage served here? 'yes' / 'no' (definitely not, e.g. the site opened locally) /
  // 'unknown' (slow or failed connection, expired session). The answer is remembered so a device
  // that opens offline still queues its changes.
  let verdict = 'unknown';
  async function detect() {
    verdict = 'unknown';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const opts = { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal };
      let res = await fetch(url({ ping: 1 }), opts);
      if (res.status === 401) {
        const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: ctl.signal }).catch(() => null);
        if (r && r.ok) res = await fetch(url({ ping: 1 }), opts);
      }
      const isJson = (res.headers.get('content-type') || '').includes('json');
      if (res.ok && isJson) verdict = 'yes';
      else if (res.status === 404 || (res.ok && !isJson)) verdict = 'no';
    } catch (_) { /* offline or too slow: undecided */ }
    clearTimeout(timer);
    if (verdict !== 'unknown') available = verdict === 'yes';
    try { available ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch (_) {}
    return available;
  }

  // A first visit on a poor connection can leave the answer undecided: keep checking in the
  // background (every 15 s and whenever the connection or the app comes back) until it is known.
  function whenAvailable(cb) {
    if (available || verdict === 'no') return;
    let busy = false;
    const attempt = async () => {
      if (busy || available) return;
      busy = true;
      const ok = await detect();
      busy = false;
      if (ok) { stop(); cb(); } else if (verdict === 'no') stop();
    };
    const timer = setInterval(attempt, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') attempt(); };
    window.addEventListener('online', attempt);
    window.addEventListener('focus', attempt);
    document.addEventListener('visibilitychange', onVisible);
    function stop() {
      clearInterval(timer);
      window.removeEventListener('online', attempt);
      window.removeEventListener('focus', attempt);
      document.removeEventListener('visibilitychange', onVisible);
    }
  }

  // Current revision of the shared copy, or null when there is none yet.
  const remoteInfo = { savedAt: null, checkedAt: null };
  async function rev(path) {
    const res = await call(url({ key: keyOf(path), meta: 1 }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage error ' + res.status);
    const body = await res.json();
    if (keyOf(path) === 'main') Object.assign(remoteInfo, { savedAt: body.savedAt || null, checkedAt: new Date().toISOString() });
    return body.etag || '';
  }

  async function download(path) {
    const res = await call(url({ key: keyOf(path) }), accept);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage error ' + res.status);
    if (keyOf(path) === 'main') Object.assign(remoteInfo, { savedAt: res.headers.get('x-saved-at') || remoteInfo.savedAt, checkedAt: new Date().toISOString() });
    return { data: JSON.parse(await readText(res)), rev: res.headers.get('x-etag') || '' };
  }

  // rev: null = create only, 'overwrite' = replace, otherwise only if still at that revision.
  async function upload(path, text, revision) {
    const mode = revision === 'overwrite' ? 'overwrite' : revision ? 'update' : 'add';
    const headers = { 'content-type': 'application/json', 'x-mode': mode };
    const params = { key: keyOf(path) };
    // Not If-Match: Netlify's CDN strips that standard header before the function sees it.
    if (mode === 'update') { headers['x-base-rev'] = revision; params.base = revision; }
    let payload = text;
    if (canGzip) {
      try { payload = await gzip(text); headers['x-body-encoding'] = 'gzip'; headers['content-type'] = 'application/octet-stream'; } catch (_) { payload = text; }
    }
    const res = await call(url(params), { method: 'PUT', headers, body: payload });
    if (res.status === 413) throw new Error('The inventory is too large for shared storage (413).');
    if (res.status === 409) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!res.ok) throw new Error('Storage error ' + res.status);
    if (keyOf(path) === 'main') remoteInfo.savedAt = new Date().toISOString();
    return { rev: (await res.json()).etag };
  }

  async function list() {
    const res = await call(url({ list: 'history' }));
    if (!res.ok) throw new Error('Storage error ' + res.status);
    return (await res.json()).entries.map((e) => ({ '.tag': 'file', name: e.name, path_lower: e.path }));
  }

  window.ServerCloud = {
    kind: 'server',
    pollMs: 20000,
    connected: () => available,
    verdict: () => verdict,
    remoteInfo: () => remoteInfo,
    detect, whenAvailable, rev, download, upload, list,
    disconnect() {},
    appKey: () => '', redirectUri: () => '', hasConfigKey: () => true,
  };
})();
