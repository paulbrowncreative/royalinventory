/* Google single sign-on gate for the whole site (Netlify Edge Function).
 *
 * Every request must carry a valid signed session cookie; otherwise the visitor sees the sign-in
 * page. Sign-in uses Google's OAuth 2.0 authorization-code flow, and only allow-listed accounts
 * (ALLOWED_EMAILS and/or ALLOWED_DOMAINS) are admitted. The allow-list is re-checked on every
 * request, so removing someone revokes their access immediately.
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   from Google Cloud Console → APIs & Services → Credentials
 *   SESSION_SECRET                           long random string (32+ characters)
 *   ALLOWED_EMAILS                           comma-separated, e.g. owner@gmail.com,staff@gmail.com
 *   ALLOWED_DOMAINS                          optional, Google Workspace domains, e.g. royal-club.com
 */

const SESSION_COOKIE = 'ri_session';
const STATE_COOKIE = 'ri_oauth_state';
const SESSION_HOURS = 24 * 7;

const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : undefined) || '';
const list = (k) => env(k).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmacKey() {
  return crypto.subtle.importKey('raw', enc.encode(env('SESSION_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body));
  return body + '.' + b64url(sig);
}

async function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return p.exp > Date.now() ? p : null;
  } catch (_) {
    return null;
  }
}

function getCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function isAllowed(email, hd) {
  const emails = list('ALLOWED_EMAILS');
  const domains = list('ALLOWED_DOMAINS');
  email = String(email || '').toLowerCase();
  if (emails.includes(email)) return true;
  // Workspace accounts carry an `hd` claim; requiring it stops personal accounts posing as the domain.
  return !!hd && domains.includes(String(hd).toLowerCase()) && email.endsWith('@' + String(hd).toLowerCase());
}

const configured = () => env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET') && env('SESSION_SECRET').length >= 32 && (env('ALLOWED_EMAILS') || env('ALLOWED_DOMAINS'));

const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(message = '', status = 200, showButton = true, tone = 'error') {
  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تسجيل الدخول | رويال – نظام جرد الأقمشة</title><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/assets/img/brand/favicon-64.png" type="image/png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=IBM+Plex+Sans+Arabic:wght@400;600&family=Reem+Kufi:wght@600;700&display=swap">
<style>
:root{--gold:#d4af62;--gold-grad:linear-gradient(135deg,#f3dc9f 0%,#d4af62 38%,#a87e36 72%,#e2c27c 100%);--text:#f4efe4;--muted:#a79f8f;--line:rgba(212,175,98,.3)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(900px 500px at 80% -10%,rgba(212,175,98,.14),transparent 60%),repeating-linear-gradient(115deg,transparent 0 46px,rgba(240,215,154,.03) 52px,transparent 64px 110px),#0b0b0d;color:var(--text);font:400 1rem/1.6 "IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif}
main{width:min(480px,100%);text-align:center;padding:40px 28px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,#1c1a18,#121214);box-shadow:0 30px 80px -30px #000}
.mark{display:block;margin:0 auto;background:var(--gold-grad);-webkit-mask:var(--logo) center/contain no-repeat;mask:var(--logo) center/contain no-repeat}
.lockup{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:24px}.lockup .mark{margin:0}
.crest{--logo:url(/assets/img/brand/crest.png);height:72px;aspect-ratio:360/446}
.wm{height:52px}.wm-en{--logo:url(/assets/img/brand/wordmark-en.png);aspect-ratio:640/285}.wm-ar{--logo:url(/assets/img/brand/wordmark-ar.png);aspect-ratio:640/321}
.rule{width:56px;height:1px;background:var(--line);margin:0 auto 20px}
h1{font:600 1.35rem/1.4 "Reem Kufi",serif;margin:0 0 6px}
.en{font-family:"Cormorant Garamond",Georgia,serif;color:var(--muted);font-size:1.05rem;margin:0 0 24px}
p.msg{margin:0 0 20px;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,138,128,.4);color:#ffb4ab;font-size:.9rem}p.msg--info{border-color:var(--line);color:#f0d79a}
a.btn{display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:0 22px;border-radius:10px;background:#fff;color:#1f1f1f;font-weight:600;text-decoration:none;border:1px solid #dadce0;transition:box-shadow .18s}
a.btn:hover{box-shadow:0 0 0 3px rgba(212,175,98,.55)}a.btn:focus-visible{outline:2px solid #f0d79a;outline-offset:3px}
a.btn svg{width:20px;height:20px}
small{display:block;margin-top:22px;color:var(--muted);font-size:.78rem}
</style></head><body><main>
<div class="lockup" dir="ltr" role="img" aria-label="Royal Fashion Club – رويال نادي الأناقة">
<span class="mark wm wm-en"></span><span class="mark crest"></span><span class="mark wm wm-ar"></span></div>
<div class="rule" aria-hidden="true"></div>
<h1>نظام جرد الأقمشة</h1><p class="en" lang="en">Fabric Inventory System</p>
${message ? `<p class="msg msg--${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${message}</p>` : ''}
${showButton ? `<a class="btn" href="/auth/login"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.2C1 16.4 0 20.1 0 24s1 7.6 2.7 10.8l7.8-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg><span>تسجيل الدخول بحساب Google</span></a>` : ''}
<small>الدخول مقصور على حسابات الموظفين المصرّح لهم · <span lang="en">Authorised staff accounts only</span></small>
</main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default async function auth(request, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  const callback = url.origin + '/auth/callback';

  if (!configured()) {
    return page('تسجيل الدخول غير مُعدّ بعد. أضف متغيرات Google في إعدادات Netlify.<br><span lang="en">Sign-in is not configured yet — add the Google environment variables in Netlify.</span>', 503, false);
  }

  if (path === '/auth/login') {
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const domains = list('ALLOWED_DOMAINS');
    const q = new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: callback, response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    });
    if (domains.length === 1 && !env('ALLOWED_EMAILS')) q.set('hd', domains[0]);
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, { 'set-cookie': cookie(STATE_COOKIE, state, 600) });
  }

  if (path === '/auth/callback') {
    const expected = getCookie(request, STATE_COOKIE);
    const clearState = cookie(STATE_COOKIE, '', 0);
    if (url.searchParams.get('error')) return page('تم إلغاء تسجيل الدخول. <span lang="en">Sign-in was cancelled.</span>', 401);
    if (!expected || expected !== url.searchParams.get('state') || !url.searchParams.get('code')) {
      return page('انتهت صلاحية محاولة الدخول، حاول مرة أخرى. <span lang="en">The sign-in attempt expired — please try again.</span>', 400);
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
        redirect_uri: callback, grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) return page('تعذّر التحقق من حساب Google. <span lang="en">Could not verify the Google account.</span>', 502);
    // The ID token comes straight from Google over TLS with our client secret, so its claims can be trusted
    // after checking audience, issuer and expiry (OpenID Connect Core §3.1.3.7).
    const { id_token } = await res.json();
    let claims;
    try { claims = JSON.parse(new TextDecoder().decode(fromB64url(id_token.split('.')[1]))); } catch (_) { claims = {}; }
    const validToken = claims.aud === env('GOOGLE_CLIENT_ID') && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) && claims.exp * 1000 > Date.now();
    if (!validToken || !claims.email_verified) return page('تعذّر التحقق من حساب Google. <span lang="en">Could not verify the Google account.</span>', 401);
    if (!isAllowed(claims.email, claims.hd)) {
      return new Response((await page(`الحساب <b dir="ltr">${esc(claims.email)}</b> غير مصرّح له بالدخول. اطلب من المسؤول إضافته.<br><span lang="en">This account is not authorised. Ask the administrator to add it.</span>`, 403).text()), {
        status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': clearState },
      });
    }
    const session = await sign({ email: claims.email, name: claims.name || claims.email, hd: claims.hd || '', exp: Date.now() + SESSION_HOURS * 3600e3 });
    const headers = new Headers({ location: '/', 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600));
    headers.append('set-cookie', clearState);
    return new Response(null, { status: 302, headers });
  }

  if (path === '/auth/logout') {
    return new Response(null, { status: 302, headers: { location: '/auth/signed-out', 'cache-control': 'no-store', 'set-cookie': cookie(SESSION_COOKIE, '', 0) } });
  }
  if (path === '/auth/signed-out') return page('تم تسجيل الخروج. <span lang="en">You have signed out.</span>', 200, true, 'info');

  const user = await verify(getCookie(request, SESSION_COOKIE));
  if (!user || !isAllowed(user.email, user.hd)) {
    const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
    return wantsHtml ? page() : new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  if (path === '/auth/me') {
    return new Response(JSON.stringify({ email: user.email, name: user.name }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  const response = await context.next();
  response.headers.set('cache-control', 'private, no-cache');
  return response;
}

export const config = {
  path: '/*',
  // Only the public brand marks (shown on the sign-in page) bypass the gate.
  excludedPath: ['/assets/img/brand/*', '/robots.txt'],
};
