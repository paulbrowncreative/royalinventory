/* TEMPORARY deployment health check — remove after verifying the live site.
 * Read-only for the inventory: reports only whether the shared copy exists, when it was saved and
 * how many records it holds (counts, no content). Exercises Blobs in a separate test store. */
import { getStore } from '@netlify/blobs';

const KEY = 'h2STsWM4pxTwsQFcCdRC0kN1';

export default async (req) => {
  if (new URL(req.url).searchParams.get('t') !== KEY) return new Response('Not found', { status: 404 });
  const out = { functionDeployed: true };
  try {
    const probe = getStore({ name: 'royal-health-probe', consistency: 'strong' });
    const rev = crypto.randomUUID();
    const w = await probe.set('probe', JSON.stringify({ at: Date.now() }), { metadata: { rev } });
    const r = await probe.getWithMetadata('probe', { type: 'json' });
    out.blobsWriteRead = !!(w.modified && r && r.metadata && r.metadata.rev === rev);
    const { blobs } = await probe.list({ prefix: 'probe' });
    const etag = blobs.find((b) => b.key === 'probe').etag;
    const stale = await probe.set('probe', '{"stale":true}', { onlyIfMatch: '"stale-etag"' });
    const fresh = await probe.set('probe', '{"fresh":true}', { onlyIfMatch: etag });
    out.conditionalWrites = stale.modified === false && fresh.modified === true;
  } catch (e) { out.blobsError = String(e && e.message || e); }
  try {
    const store = getStore({ name: 'royal-inventory', consistency: 'strong' });
    const m = await store.getWithMetadata('main', { type: 'json' });
    out.sharedInventory = m ? { exists: true, savedAt: m.metadata && m.metadata.savedAt, items: (m.data.cards || []).length, withdrawals: (m.data.withdrawals || []).length } : { exists: false };
    const { blobs } = await store.list({ prefix: 'history/' });
    out.backupCopies = blobs.length;
  } catch (e) { out.inventoryError = String(e && e.message || e); }
  return new Response(JSON.stringify(out, null, 1), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
};

export const config = { path: '/api/health' };
