/* Shared inventory storage for all signed-in devices (Netlify Function + Netlify Blobs).
 *
 *   GET  /api/store?ping=1                 → { ok: true }            (availability check)
 *   GET  /api/store?key=main&meta=1        → { etag } | 404
 *   GET  /api/store?key=main               → JSON body, X-Etag header | 404
 *   PUT  /api/store?key=main               body = JSON text; X-Mode: add | update | overwrite;
 *                                          If-Match: <etag> for update → { etag } | 409 conflict
 *   GET  /api/store?list=history           → { entries: [{ name, path }] }
 *
 * Every saved copy carries its own revision id (blob metadata `rev`), returned together with the
 * data in one read. A write must name the revision it was based on, and is also made conditional on
 * the blob's current ETag, so two devices saving at the same moment cannot overwrite each other:
 * the loser gets 409, re-reads, merges its queued changes and retries (see Store.sync). Every request must carry a valid Netlify Identity
 * session (the ri_at cookie set by the sign-in gate); it is verified with Identity itself.
 */
import { getStore } from '@netlify/blobs';

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

async function signedInUser(req) {
  const at = getCookie(req, 'ri_at');
  if (!at) return null;
  const res = await fetch(new URL(req.url).origin + '/.netlify/identity/user', { headers: { authorization: 'Bearer ' + at } });
  return res.ok ? res.json() : null;
}

// The blob's current storage ETag (from the listing, which every Blobs backend reports).
async function storageEtag(store, key) {
  const { blobs } = await store.list({ prefix: key });
  const b = blobs.find((x) => x.key === key);
  return b ? b.etag : null;
}

// Revision id of a stored copy. A copy written without one (older versions) gets a stable
// stand-in derived from its storage ETag, so devices can still read, compare and update it;
// the next write stores a real revision id.
const revOf = (metadata, etag) => (metadata && metadata.rev) || (etag ? 'etag:' + etag : '');

// One line per request in the Netlify function log (Site → Logs → Functions → store).
const log = (user, msg) => console.log(`[store] ${msg} user=${String(user && user.email || '').replace(/^(.).*@/, '$1***@')}`);

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
    const m = await store.getMetadata(key);
    if (!m) { log(user, `meta ${key} -> 404`); return json(404, { error: 'not_found' }); }
    const rev = revOf(m.metadata, m.metadata && m.metadata.rev ? null : (m.etag || (await storageEtag(store, key))));
    return json(200, { etag: rev, savedAt: (m.metadata && m.metadata.savedAt) || null });
  }

  if (req.method === 'GET') {
    const r = await store.getWithMetadata(key, { type: 'text' });
    if (!r) { log(user, `get ${key} -> 404`); return json(404, { error: 'not_found' }); }
    const rev = revOf(r.metadata, r.metadata && r.metadata.rev ? null : (r.etag || (await storageEtag(store, key))));
    log(user, `get ${key} rev=${rev.slice(0, 13)} bytes=${r.data.length}`);
    return new Response(r.data, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-etag': rev, 'x-saved-at': (r.metadata && r.metadata.savedAt) || '' } });
  }

  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_BYTES) return json(413, { error: 'too_large' });
    try { JSON.parse(text); } catch (_) { return json(400, { error: 'invalid_json' }); }
    const mode = req.headers.get('x-mode') || 'update';
    const rev = newRev();
    const opts = { metadata: { rev, savedAt: new Date().toISOString(), by: user.email } };
    if (mode === 'add') opts.onlyIfNew = true;
    else if (mode === 'update') {
      const expected = req.headers.get('if-match');
      if (!expected) return json(428, { error: 'if-match required' });
      // Pin the write to the blob as it is now (ETag from the listing), then confirm that blob is
      // the revision the device based its changes on. A write landing in between changes the ETag,
      // so the conditional set below fails instead of overwriting it.
      const etag = await storageEtag(store, key);
      const m = etag ? await store.getMetadata(key) : null;
      if (!etag || !m || revOf(m.metadata, etag) !== expected) {
        log(user, `put ${key} mode=update -> 409 (stale)`);
        return json(409, { error: 'conflict' });
      }
      opts.onlyIfMatch = etag;
    }
    const res = await store.set(key, text, opts);
    if (!res.modified) { log(user, `put ${key} mode=${mode} -> 409`); return json(409, { error: 'conflict' }); }
    log(user, `put ${key} mode=${mode} -> 200 rev=${rev.slice(0, 8)} bytes=${text.length}`);
    return json(200, { etag: rev });
  }

  return json(405, { error: 'method not allowed' });
};

export const config = { path: '/api/store' };
