/* Staff-only access gate using Netlify Identity (free, built into Netlify, no external keys).
 *
 * Setup (Netlify UI → your site → Identity): Enable Identity → Registration: Invite only → Invite users.
 * Invited staff open the email link, set a password, and are signed in. Nobody else can get in:
 * every request (pages, scripts, data) is checked here before Netlify serves it.
 *
 * Sessions are Identity's own tokens kept in HttpOnly cookies and re-checked with Identity, so
 * deleting a user in Netlify locks them out within about a minute. If registration is ever left "Open",
 * sign-in is refused entirely (fail closed) because anyone could otherwise create an account.
 */

const AT = 'ri_at';
const RT = 'ri_rt';
const REFRESH_DAYS = 14; // staff stay signed in for two weeks of inactivity
const CHECK_MS = 60 * 1000;
const seen = new Map(); // access token -> { user, until }: avoids asking Identity on every asset request

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const sessionCookies = (t) => [cookie(AT, t.access_token, REFRESH_DAYS * 86400), cookie(RT, t.refresh_token, REFRESH_DAYS * 86400)];
const clearCookies = () => [cookie(AT, '', 0), cookie(RT, '', 0)];

function jwtExp(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (_) { return 0; }
}

/* ---------- Netlify Identity (GoTrue) API ---------- */
const identity = (origin, path, init = {}) => fetch(origin + '/.netlify/identity' + path, init);
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function settings(origin) {
  const res = await identity(origin, '/settings');
  return res.ok ? res.json() : null;
}
async function getUser(origin, at) {
  const res = await identity(origin, '/user', { headers: { authorization: 'Bearer ' + at } });
  return res.ok ? res.json() : null;
}
async function tokenGrant(origin, params) {
  const res = await identity(origin, '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return res.ok ? res.json() : null;
}

// Returns { user, tokens? } for a valid session. Only page navigations refresh an expiring access
// token: refresh tokens are single-use, so the burst of asset requests that follows a page load must
// not race to refresh — they arrive with the fresh cookies the navigation just set.
async function session(request, origin, navigation) {
  const at = getCookie(request, AT);
  const rt = getCookie(request, RT);
  if (at && jwtExp(at) > Date.now() + (navigation ? 60000 : 0)) {
    const hit = seen.get(at);
    if (hit && hit.until > Date.now()) return { user: hit.user };
    const user = await getUser(origin, at);
    if (user) {
      if (seen.size > 500) seen.clear();
      seen.set(at, { user, until: Date.now() + CHECK_MS });
      return { user };
    }
  }
  if (!rt || !navigation) return null;
  const tokens = await tokenGrant(origin, { grant_type: 'refresh_token', refresh_token: rt });
  if (!tokens) return null;
  const user = await getUser(origin, tokens.access_token);
  return user ? { user, tokens } : null;
}

/* ---------- Pages ---------- */
const T = {
  title: 'نظام جرد الأقمشة', titleEn: 'Fabric Inventory System',
  email: 'البريد الإلكتروني · <bdi lang="en" dir="ltr">Email</bdi>',
  password: 'كلمة المرور · <bdi lang="en" dir="ltr">Password</bdi>',
  newPassword: 'كلمة مرور جديدة (8 أحرف على الأقل) · <bdi lang="en" dir="ltr">New password (8+ characters)</bdi>',
  signIn: 'تسجيل الدخول · <bdi lang="en" dir="ltr">Sign in</bdi>',
  setPassword: 'تعيين كلمة المرور والدخول · <bdi lang="en" dir="ltr">Set password &amp; sign in</bdi>',
  sendLink: 'إرسال رابط إعادة التعيين · <bdi lang="en" dir="ltr">Send reset link</bdi>',
  forgot: 'نسيت كلمة المرور؟ · <bdi lang="en" dir="ltr">Forgot password?</bdi>',
  back: 'العودة لتسجيل الدخول · <bdi lang="en" dir="ltr">Back to sign in</bdi>',
  inviteIntro: 'مرحبًا بك! اختر كلمة مرور لحسابك. <bdi lang="en" dir="ltr">Welcome! Choose a password for your account.</bdi>',
  resetIntro: 'اختر كلمة مرور جديدة. <bdi lang="en" dir="ltr">Choose a new password.</bdi>',
  forgotIntro: 'أدخل بريدك وسنرسل لك رابطًا لإعادة تعيين كلمة المرور. <bdi lang="en" dir="ltr">Enter your email and we’ll send a reset link.</bdi>',
  footer: 'الدخول مقصور على الموظفين المدعوّين · <bdi lang="en" dir="ltr">Invited staff only</bdi>',
};

const MSG = {
  bad: 'البريد أو كلمة المرور غير صحيحة. <bdi lang="en" dir="ltr">Incorrect email or password.</bdi>',
  expired: 'الرابط غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا. <bdi lang="en" dir="ltr">This link is invalid or has expired — request a new one.</bdi>',
  short: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل. <bdi lang="en" dir="ltr">Password must be at least 8 characters.</bdi>',
  sent: 'إذا كان البريد مسجلًا، ستصلك رسالة خلال دقائق. <bdi lang="en" dir="ltr">If that email has an account, a reset link is on its way.</bdi>',
  out: 'تم تسجيل الخروج. <bdi lang="en" dir="ltr">You have signed out.</bdi>',
  off: 'لم يتم تفعيل Netlify Identity بعد. فعّله من لوحة Netlify ← Identity. <bdi lang="en" dir="ltr">Netlify Identity is not enabled yet — enable it in Netlify → Identity.</bdi>',
  open: 'التسجيل مفتوح للجميع. غيّر Registration إلى «Invite only» في Netlify ← Identity. <bdi lang="en" dir="ltr">Registration is open to anyone — set it to “Invite only” in Netlify → Identity.</bdi>',
};

function page({ message = '', tone = 'error', status = 200, view = 'login', email = '', token = '', headers = {} } = {}) {
  const field = (name, label, type, extra = '') => `<label><span>${label}</span><input name="${name}" type="${type}" required ${extra}></label>`;
  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تسجيل الدخول | رويال – نظام جرد الأقمشة</title><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/assets/img/brand/favicon-64.png" type="image/png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=IBM+Plex+Sans+Arabic:wght@400;600&family=Reem+Kufi:wght@600;700&display=swap">
<style>
:root{--gold:#d4af62;--gold-grad:linear-gradient(135deg,#f3dc9f 0%,#d4af62 38%,#a87e36 72%,#e2c27c 100%);--text:#f4efe4;--muted:#a79f8f;--line:rgba(212,175,98,.3)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(900px 500px at 80% -10%,rgba(212,175,98,.14),transparent 60%),repeating-linear-gradient(115deg,transparent 0 46px,rgba(240,215,154,.03) 52px,transparent 64px 110px),#0b0b0d;color:var(--text);font:400 1rem/1.6 "IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif}
main{width:min(480px,100%);text-align:center;padding:36px 28px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,#1c1a18,#121214);box-shadow:0 30px 80px -30px #000}
.mark{display:block;background:var(--gold-grad);-webkit-mask:var(--logo) center/contain no-repeat;mask:var(--logo) center/contain no-repeat}
.lockup{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:20px}
.crest{--logo:url(/assets/img/brand/crest.png);height:66px;aspect-ratio:360/446}
.wm{height:48px}.wm-en{--logo:url(/assets/img/brand/wordmark-en.png);aspect-ratio:640/285}.wm-ar{--logo:url(/assets/img/brand/wordmark-ar.png);aspect-ratio:640/321}
.rule{width:56px;height:1px;background:var(--line);margin:0 auto 18px}
h1{font:600 1.3rem/1.4 "Reem Kufi",serif;margin:0 0 4px}
.en{font-family:"Cormorant Garamond",Georgia,serif;color:var(--muted);font-size:1.05rem;margin:0 0 22px}
.msg{margin:0 0 18px;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,138,128,.4);color:#ffb4ab;font-size:.9rem}.msg--info{border-color:var(--line);color:#f0d79a}
form{display:grid;gap:14px;text-align:start}form[hidden]{display:none}
.intro{margin:0;color:var(--muted);font-size:.9rem;text-align:center}
label{display:grid;gap:6px;font-size:.85rem;font-weight:600;color:#c9c1b1}label bdi{font-weight:400;color:var(--muted)}
input{width:100%;min-height:46px;padding:0 12px;border-radius:8px;border:1px solid #d8cdb5;background:#f7f2e7;color:#1b1813;font:inherit;direction:ltr;text-align:left}
input:focus{outline:none;border-color:#9c7634;box-shadow:0 0 0 3px rgba(212,175,98,.45)}
button{min-height:48px;border:0;border-radius:10px;background:var(--gold-grad);color:#08080a;font:600 1rem "IBM Plex Sans Arabic",sans-serif;cursor:pointer;margin-top:4px}
button bdi{font-weight:500}button:focus-visible,.link:focus-visible{outline:2px solid #f0d79a;outline-offset:3px}
.link{background:none;border:0;color:#f0d79a;font:inherit;font-size:.85rem;text-decoration:underline;text-underline-offset:4px;cursor:pointer;min-height:36px;margin:0;justify-self:center}
.link bdi{color:inherit}
small{display:block;margin-top:20px;color:var(--muted);font-size:.78rem}
</style></head><body><main>
<div class="lockup" dir="ltr" role="img" aria-label="Royal Fashion Club – رويال نادي الأناقة"><span class="mark wm wm-en"></span><span class="mark crest"></span><span class="mark wm wm-ar"></span></div>
<div class="rule" aria-hidden="true"></div>
<h1>${T.title}</h1><p class="en" lang="en" dir="ltr">${T.titleEn}</p>
${message ? `<p class="msg msg--${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${message}</p>` : ''}
<form method="post" action="/auth/login" data-view="login"${view === 'login' ? '' : ' hidden'}>
  ${field('email', T.email, 'email', `autocomplete="username" value="${esc(email)}"`)}
  ${field('password', T.password, 'password', 'autocomplete="current-password"')}
  <button type="submit">${T.signIn}</button>
  <button type="button" class="link" data-show="forgot">${T.forgot}</button>
</form>
<form method="post" action="/auth/forgot" data-view="forgot"${view === 'forgot' ? '' : ' hidden'}>
  <p class="intro">${T.forgotIntro}</p>
  ${field('email', T.email, 'email', 'autocomplete="username"')}
  <button type="submit">${T.sendLink}</button>
  <button type="button" class="link" data-show="login">${T.back}</button>
</form>
<form method="post" action="/auth/accept" data-view="invite"${view === 'invite' ? '' : ' hidden'}>
  <p class="intro">${T.inviteIntro}</p><input type="hidden" name="token" value="${view === 'invite' ? esc(token) : ''}">
  ${field('password', T.newPassword, 'password', 'autocomplete="new-password" minlength="8"')}
  <button type="submit">${T.setPassword}</button>
</form>
<form method="post" action="/auth/reset" data-view="recovery"${view === 'recovery' ? '' : ' hidden'}>
  <p class="intro">${T.resetIntro}</p><input type="hidden" name="token" value="${view === 'recovery' ? esc(token) : ''}">
  ${field('password', T.newPassword, 'password', 'autocomplete="new-password" minlength="8"')}
  <button type="submit">${T.setPassword}</button>
</form>
<small>${T.footer}</small>
</main><script src="/auth/login.js"></script></body></html>`;
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  Object.entries(headers).forEach(([k, v]) => [].concat(v).forEach((x) => h.append(k, x)));
  return new Response(html, { status, headers: h });
}

// Invite and password-reset emails link to /#invite_token=… or /#recovery_token=…; the hash never
// reaches the server, so this small script moves it into the right form.
const LOGIN_JS = `(function(){
  var show=function(v){document.querySelectorAll('form[data-view]').forEach(function(f){f.hidden=f.dataset.view!==v});var f=document.querySelector('form[data-view="'+v+'"] input:not([type=hidden])');if(f)f.focus();};
  var fromHash=function(){var m=location.hash.match(/(invite|recovery)_token=([^&]+)/);if(!m)return;
    var v=m[1]==='invite'?'invite':'recovery';document.querySelector('form[data-view="'+v+'"] input[name=token]').value=decodeURIComponent(m[2]);show(v);history.replaceState(null,'',location.pathname);};
  fromHash();window.addEventListener('hashchange',fromHash);
  document.querySelectorAll('[data-show]').forEach(function(b){b.addEventListener('click',function(){show(b.dataset.show)})});
})();`;

const redirectHome = (cookies) => {
  const h = new Headers({ location: '/', 'cache-control': 'no-store' });
  cookies.forEach((c) => h.append('set-cookie', c));
  return new Response(null, { status: 303, headers: h });
};

/* ---------- Handler ---------- */
export default async function auth(request, context) {
  const url = new URL(request.url);
  const { origin, pathname: path } = url;

  if (path === '/auth/login.js') return new Response(LOGIN_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });

  // Fail closed until Identity is enabled and set to invite-only.
  const cfg = await settings(origin).catch(() => null);
  if (!cfg) return page({ message: MSG.off, status: 503, view: 'none' });
  if (!cfg.disable_signup) return page({ message: MSG.open, status: 503, view: 'none' });

  if (request.method === 'POST' && path.startsWith('/auth/')) {
    const from = request.headers.get('origin');
    if (from && from !== origin) return new Response('Forbidden', { status: 403 });
    const form = await request.formData();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const token = String(form.get('token') || '');

    if (path === '/auth/login') {
      const t = await tokenGrant(origin, { grant_type: 'password', username: email, password });
      return t ? redirectHome(sessionCookies(t)) : page({ message: MSG.bad, status: 401, email });
    }
    if (path === '/auth/forgot') {
      if (email) await identity(origin, '/recover', json({ email })).catch(() => {});
      return page({ message: MSG.sent, tone: 'info' });
    }
    if (path === '/auth/accept' || path === '/auth/reset') {
      const invite = path === '/auth/accept';
      if (password.length < 8) return page({ message: MSG.short, status: 400, view: invite ? 'invite' : 'recovery', token });
      const res = await identity(origin, '/verify', json(invite ? { token, password, type: 'signup' } : { token, type: 'recovery' }));
      if (!res.ok) return page({ message: MSG.expired, status: 400 });
      const t = await res.json();
      if (!invite) {
        const upd = await identity(origin, '/user', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t.access_token }, body: JSON.stringify({ password }) });
        if (!upd.ok) return page({ message: MSG.expired, status: 400 });
      }
      return redirectHome(sessionCookies(t));
    }
  }

  if (path === '/auth/logout') {
    const at = getCookie(request, AT);
    if (at) { seen.delete(at); identity(origin, '/logout', { method: 'POST', headers: { authorization: 'Bearer ' + at } }).catch(() => {}); }
    return page({ message: MSG.out, tone: 'info', headers: { 'set-cookie': clearCookies() } });
  }

  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  const s = await session(request, origin, wantsHtml && request.method === 'GET').catch(() => null);
  if (!s) {
    // Only a page view clears a dead session; an asset 401 must not wipe cookies a navigation just renewed.
    const headers = wantsHtml && (getCookie(request, AT) || getCookie(request, RT)) ? { 'set-cookie': clearCookies() } : {};
    return wantsHtml ? page({ status: 401, headers }) : new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  let response;
  if (path === '/auth/me') {
    const name = (s.user.user_metadata && s.user.user_metadata.full_name) || s.user.email;
    response = new Response(JSON.stringify({ email: s.user.email, name }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } else {
    response = await context.next();
    response.headers.set('cache-control', 'private, no-cache');
  }
  if (s.tokens) sessionCookies(s.tokens).forEach((c) => response.headers.append('set-cookie', c));
  return response;
}

export const config = {
  path: '/*',
  // Brand marks are shown on the sign-in page; /.netlify/* carries Identity's own API.
  excludedPath: ['/assets/img/brand/*', '/robots.txt', '/.netlify/*'],
};
