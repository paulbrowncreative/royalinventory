/* Minimal Dropbox client for a static site: OAuth 2 PKCE (no secret), files in the app's own folder. */
(function () {
  const AUTH_KEY = 'royal-dbx';
  const PKCE_KEY = 'royal-dbx-pkce';
  const API = 'https://api.dropboxapi.com';
  const CONTENT = 'https://content.dropboxapi.com';

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const write = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  let auth = read(AUTH_KEY);

  const redirectUri = () => location.origin + location.pathname;
  const appKey = () => (window.ROYAL_CONFIG && ROYAL_CONFIG.dropboxAppKey) || (auth && auth.appKey) || localStorage.getItem('royal-dbx-key') || '';

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Dropbox-API-Arg must be ASCII; escape anything else as \uXXXX.
  const apiArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  async function connect(key) {
    if (key) localStorage.setItem('royal-dbx-key', key.trim());
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const stateTok = b64url(crypto.getRandomValues(new Uint8Array(16)));
    write(PKCE_KEY, { verifier, state: stateTok, key: appKey() });
    const q = new URLSearchParams({
      client_id: appKey(), response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: redirectUri(), state: stateTok,
    });
    location.assign('https://www.dropbox.com/oauth2/authorize?' + q);
  }

  // Returns true when this page load is the return from Dropbox's sign-in.
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    const pkce = read(PKCE_KEY);
    history.replaceState(null, '', redirectUri() + '#settings');
    write(PKCE_KEY, null);
    if (q.has('error') || !pkce || q.get('state') !== pkce.state) throw new Error(q.get('error_description') || 'Dropbox sign-in was cancelled.');
    const res = await fetch(API + '/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ code: q.get('code'), grant_type: 'authorization_code', code_verifier: pkce.verifier, client_id: pkce.key, redirect_uri: redirectUri() }),
    });
    if (!res.ok) throw new Error('Dropbox sign-in failed (' + res.status + ').');
    const t = await res.json();
    auth = { appKey: pkce.key, refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000, account: t.account_id };
    write(AUTH_KEY, auth);
    return true;
  }

  async function token(force) {
    if (!auth) throw Object.assign(new Error('not connected'), { auth: true });
    if (!force && auth.access && Date.now() < auth.exp) return auth.access;
    const res = await fetch(API + '/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: auth.appKey }),
    });
    if (res.status === 400 || res.status === 401) throw Object.assign(new Error('Dropbox access was revoked.'), { auth: true });
    if (!res.ok) throw new Error('token refresh failed ' + res.status);
    const t = await res.json();
    auth.access = t.access_token;
    auth.exp = Date.now() + (t.expires_in - 120) * 1000;
    write(AUTH_KEY, auth);
    return auth.access;
  }

  async function call(url, init, retried) {
    const res = await fetch(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + (await token()) }, init.headers) }));
    if (res.status === 401 && !retried) { await token(true); return call(url, init, true); }
    if (res.status === 429 || res.status >= 500) throw new Error('Dropbox is busy (' + res.status + ').');
    return res;
  }

  async function errorOf(res) {
    let summary = '';
    try { summary = (await res.json()).error_summary || ''; } catch (_) {}
    return Object.assign(new Error('Dropbox error ' + res.status + ': ' + summary), { status: res.status, summary });
  }

  // Current revision of a file, or null when it does not exist.
  async function rev(path) {
    const res = await call(API + '/2/files/get_metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    if (res.status === 409) { const e = await errorOf(res); if (e.summary.includes('not_found')) return null; throw e; }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()).rev;
  }

  // { data, rev } or null when the file does not exist.
  async function download(path) {
    const res = await call(CONTENT + '/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': apiArg({ path }) } });
    if (res.status === 409) { const e = await errorOf(res); if (e.summary.includes('not_found')) return null; throw e; }
    if (!res.ok) throw await errorOf(res);
    const info = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}');
    const data = JSON.parse(await res.text());
    return { data, rev: info.rev || (await rev(path)) };
  }

  // rev: null = create only, 'overwrite' = replace, otherwise update only if the file is still at that revision.
  async function upload(path, text, rev) {
    const mode = rev === 'overwrite' ? 'overwrite' : rev ? { '.tag': 'update', update: rev } : 'add';
    const res = await call(CONTENT + '/2/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': apiArg({ path, mode, autorename: false, mute: true }) },
      body: new Blob([text], { type: 'application/json' }),
    });
    if (res.status === 409) { const e = await errorOf(res); if (e.summary.includes('conflict')) e.conflict = true; throw e; }
    if (!res.ok) throw await errorOf(res);
    return res.json();
  }

  async function list(path) {
    let res = await call(API + '/2/files/list_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    if (res.status === 409) return [];
    if (!res.ok) throw await errorOf(res);
    let page = await res.json();
    const entries = page.entries;
    while (page.has_more) {
      res = await call(API + '/2/files/list_folder/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: page.cursor }) });
      if (!res.ok) throw await errorOf(res);
      page = await res.json();
      entries.push(...page.entries);
    }
    return entries.filter((e) => e['.tag'] === 'file');
  }

  function disconnect() {
    const a = auth;
    auth = null;
    write(AUTH_KEY, null);
    if (a && a.access) fetch(API + '/2/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + a.access } }).catch(() => {});
  }

  window.Cloud = {
    connected: () => !!(auth && auth.refresh),
    appKey, redirectUri, connect, handleRedirect, disconnect, rev, download, upload, list,
    hasConfigKey: () => !!(window.ROYAL_CONFIG && ROYAL_CONFIG.dropboxAppKey),
  };
})();
