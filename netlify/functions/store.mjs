/* Shared inventory storage for all signed-in devices (Netlify Function + Netlify Blobs).
 *
 *   GET  /api/store?ping=1                 → { ok: true }            (availability check)
 *   GET  /api/store?key=main&meta=1        → { etag, savedAt } | 404
 *   GET  /api/store?key=main               → JSON body, X-Etag header | 404
 *   PUT  /api/store?key=main[&base=<etag>] body = JSON text; X-Mode: add | update | overwrite;
 *                                          base revision (query `base`, or X-Base-Rev header) for
 *                                          update → { etag } | 409 conflict
 *   GET  /api/store?list=history           → { entries: [{ name, path }] }
 *
 * Bodies may travel gzip-compressed (request header X-Body-Encoding: gzip; responses when the
 * request carries X-Accept-Gzip: 1). Netlify Functions cap request and response bodies at about
 * 6 MB, so compression keeps large inventories syncing. Blobs are always stored as plain JSON.
 *
 * Every saved copy carries its own revision id (blob metadata `rev`). A write must name the
 * revision it was based on and is also made conditional on the blob's current ETag, so two devices
 * saving at the same moment cannot overwrite each other: the loser gets 409, re-reads, replays its
 * queued changes and retries (see Store.sync). Every successful write is read back and confirmed
 * before the device is told it was saved. Every request must carry a valid Netlify Identity session
 * (the ri_at cookie set by the sign-in gate); it is verified with Identity itself.
 */
import { getStore } from '@netlify/blobs';
import { gzipSync, gunzipSync } from 'node:zlib';

const STORE_NAME = 'royal-inventory';
const newRev = () => crypto.randomUUID();
const KEY_RE = /^(main|history\/[\w.-]{1,100})$/;
const MAX_BYTES = 25 * 1024 * 1024;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// Sessions are verified with Identity itself. A verified token is remembered for a minute (as the
// sign-in gate does), so a device's sync checks every 20 s do not each wait on an Identity round
// trip; deleting a user in Netlify still locks them out within about a minute.
const USER_MS = 60 * 1000;
const verified = new Map(); // access token -> { user, until }
async function signedInUser(req) {
  const at = getCookie(req, 'ri_at');
  if (!at) return null;
  const hit = verified.get(at);
  if (hit && hit.until > Date.now()) return hit.user;
  const res = await fetch(new URL(req.url).origin + '/.netlify/identity/user', { headers: { authorization: 'Bearer ' + at } });
  if (!res.ok) { verified.delete(at); return null; }
  const user = await res.json();
  if (verified.size > 500) verified.clear();
  verified.set(at, { user, until: Date.now() + USER_MS });
  return user;
}

// Revision id of a stored copy. A copy written without one (older versions) gets a stable
// stand-in derived from its storage ETag, so devices can still read, compare and update it;
// the next write stores a real revision id.
const revOf = (metadata, etag) => (metadata && metadata.rev) || (etag ? 'etag:' + etag : '');

// The blob as it is now: { etag, rev, metadata } or null. The ETag comes from the blob itself
// (HEAD); backends that do not report it there (the local dev sandbox) fall back to the listing.
async function current(store, key) {
  const m = await store.getMetadata(key);
  if (!m) return null;
  let etag = m.etag;
  if (!etag) {
    const { blobs } = await store.list({ prefix: key });
    const b = blobs.find((x) => x.key === key);
    etag = b ? b.etag : '';
  }
  return { etag, rev: revOf(m.metadata, etag), metadata: m.metadata || {} };
}

// One line per request in the Netlify function log (Site → Logs → Functions → store).
const log = (user, msg) => console.log(`[store] ${msg} user=${String(user && user.email || '').replace(/^(.).*@/, '$1***@')}`);

async function readBody(req) {
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  const raw = (req.headers.get('x-body-encoding') || '') === 'gzip' ? gunzipSync(buf, { maxOutputLength: MAX_BYTES + 1 }) : buf;
  return raw.length > MAX_BYTES ? null : raw.toString('utf8');
}

function body(req, text, headers) {
  if (req.headers.get('x-accept-gzip') === '1') {
    return new Response(gzipSync(Buffer.from(text, 'utf8')), { headers: { ...headers, 'content-type': 'application/octet-stream', 'x-body-encoding': 'gzip' } });
  }
  return new Response(text, { headers: { ...headers, 'content-type': 'application/json' } });
}

export default async (req) => {
  const user = await signedInUser(req).catch(() => null);
  if (!user) return json(401, { error: 'unauthorized' });

  const url = new URL(req.url);
  if (url.searchParams.has('ping')) return json(200, { ok: true });

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });

  if (url.searchParams.get('list') === 'history') {
    const { blobs } = await store.list({ prefix: 'history/' });
    return json(200, { entries: blobs.map((b) => ({ name: b.key.slice('history/'.length) + '.json', path: '/' + b.key + '.json' })) });
  }

  const key = url.searchParams.get('key') || 'main';
  if (!KEY_RE.test(key)) return json(400, { error: 'bad key' });

  if (req.method === 'GET' && url.searchParams.has('meta')) {
    const cur = await current(store, key);
    if (!cur) { log(user, `meta ${key} -> 404`); return json(404, { error: 'not_found' }); }
    return json(200, { etag: cur.rev, savedAt: cur.metadata.savedAt || null });
  }

  if (req.method === 'GET') {
    const r = await store.getWithMetadata(key, { type: 'text' });
    if (!r) { log(user, `get ${key} -> 404`); return json(404, { error: 'not_found' }); }
    const rev = r.metadata && r.metadata.rev ? r.metadata.rev : (await current(store, key) || {}).rev || '';
    log(user, `get ${key} rev=${rev.slice(0, 13)} bytes=${r.data.length}`);
    return body(req, r.data, { 'cache-control': 'no-store', 'x-etag': rev, 'x-saved-at': (r.metadata && r.metadata.savedAt) || '' });
  }

  if (req.method === 'PUT') {
    let text;
    try { text = await readBody(req); } catch (_) { return json(400, { error: 'bad_encoding' }); }
    if (text === null) return json(413, { error: 'too_large' });
    try { JSON.parse(text); } catch (_) { return json(400, { error: 'invalid_json' }); }
    const mode = req.headers.get('x-mode') || 'update';
    const rev = newRev();
    const opts = { metadata: { rev, savedAt: new Date().toISOString(), by: user.email } };
    let expected = null;
    if (mode === 'add') opts.onlyIfNew = true;
    else if (mode === 'update') {
      // The base revision travels in the query string and a custom header: Netlify's CDN consumes the
      // standard If-Match header before it reaches this function (which caused "Storage error 428").
      expected = url.searchParams.get('base') || req.headers.get('x-base-rev') || req.headers.get('if-match');
      if (!expected) return json(428, { error: 'base revision required' });
      // Pin the write to the blob as it is now, after confirming it is the revision the device based
      // its changes on. A write landing in between changes the ETag, so the conditional set fails
      // instead of overwriting it.
      const cur = await current(store, key);
      if (!cur || cur.rev !== expected) {
        log(user, `put ${key} mode=update -> 409 (stale)`);
        return json(409, { error: 'conflict' });
      }
      opts.onlyIfMatch = cur.etag;
    }

    let res = await store.set(key, text, opts);
    if (!res.modified && mode === 'update') {
      // A refused conditional write is normally a real conflict. If the blob is still exactly the
      // revision the device based its changes on, the backend did not accept the ETag form instead:
      // write once without the ETag condition rather than stalling every save forever.
      const now = await current(store, key);
      if (now && now.rev === expected) {
        log(user, `put ${key} etag condition refused for unchanged blob; writing by revision check`);
        delete opts.onlyIfMatch;
        res = await store.set(key, text, opts);
      }
    }
    if (!res.modified) { log(user, `put ${key} mode=${mode} -> 409`); return json(409, { error: 'conflict' }); }

    // set() reports success for any status other than 412 on a conditional write, so confirm the
    // copy really landed before the device drops its queued changes. (A newer write by another
    // device in between also fails this check: harmless, the device re-reads and replays.)
    if (mode !== 'overwrite') {
      const after = await current(store, key).catch(() => null);
      if (!after || after.rev !== rev) {
        log(user, `put ${key} mode=${mode} -> 503 (write not confirmed)`);
        return json(503, { error: 'write_not_confirmed' });
      }
    }
    log(user, `put ${key} mode=${mode} -> 200 rev=${rev.slice(0, 8)} bytes=${text.length}`);
    return json(200, { etag: rev });
  }

  return json(405, { error: 'method not allowed' });
};

export const config = { path: '/api/store' };
