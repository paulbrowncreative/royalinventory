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

  // Is shared storage served here? Remembered so a device that opens offline still queues changes.
  async function detect() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(url({ ping: 1 }), { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      const isJson = (res.headers.get('content-type') || '').includes('json');
      if (res.ok && isJson) available = true;
      else if (res.status === 404 || (res.ok && !isJson)) available = false;
    } catch (_) { /* offline: keep what we knew */ }
    try { available ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch (_) {}
    return available;
  }

  async function rev(path) {
    const res = await call(url({ key: keyOf(path), meta: 1 }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage error ' + res.status);
    return (await res.json()).etag;
  }

  async function download(path) {
    const res = await call(url({ key: keyOf(path) }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Storage error ' + res.status);
    return { data: JSON.parse(await res.text()), rev: res.headers.get('x-etag') };
  }

  // rev: null = create only, 'overwrite' = replace, otherwise only if still at that revision.
  async function upload(path, text, revision) {
    const mode = revision === 'overwrite' ? 'overwrite' : revision ? 'update' : 'add';
    const headers = { 'content-type': 'application/json', 'x-mode': mode };
    if (mode === 'update') headers['if-match'] = revision;
    const res = await call(url({ key: keyOf(path) }), { method: 'PUT', headers, body: text });
    if (res.status === 409) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!res.ok) throw new Error('Storage error ' + res.status);
    return { rev: (await res.json()).etag };
  }

  async function list() {
    const res = await call(url({ list: 'history' }));
    if (!res.ok) throw new Error('Storage error ' + res.status);
    return (await res.json()).entries.map((e) => ({ '.tag': 'file', name: e.name, path_lower: e.path }));
  }

  window.ServerCloud = {
    kind: 'server',
    pollMs: 30000,
    connected: () => available,
    detect, rev, download, upload, list,
    disconnect() {},
    appKey: () => '', redirectUri: () => '', hasConfigKey: () => true,
  };
})();
