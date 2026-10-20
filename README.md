# Royal — Fabric Inventory System · نظام جرد الأقمشة

A bilingual (Arabic RTL / English) fabric inventory dashboard for Royal – The Royal Elegance Club.
Plain HTML/CSS/JS with no build step and no dependencies.

## Run
- **Locally:** open `index.html` in Chrome/Edge, or run `python3 -m http.server` and visit http://localhost:8000
- **Netlify:** Add new site → Import from GitHub → pick this repo and branch. `netlify.toml` sets everything (no build command, publish directory `.`). Or drag the project folder onto https://app.netlify.com/drop.

## Pages
| Page | Purpose |
|---|---|
| Dashboard · لوحة التحكم | KPIs, card lookup, alerts, search & group by item number |
| Withdrawals · صفحة السحوبات | Fast withdrawal entry (auto-fills fabric details) + searchable log |
| Inventory · صفحة الجرد | All fabric cards with calculated balances, physical counts, variance and alerts |
| History & Archive · السجل والأرشيف | Stock on any past date, withdrawal summary for a period, deleted-records archive, daily Dropbox copies |
| User Guide · دليل الاستخدام | Workflow and calculation rules |
| Settings · الإعدادات | Dropbox connection, low-stock threshold, user name, CSV import, JSON backup/restore |

## Calculations
- Calculated balance = opening stock − total withdrawals
- Variance = physical count − calculated balance on the count date
- Final available = physical count − withdrawals after the count date (or the calculated balance when there is no count)
- Alerts: negative, out (0), low (≤ threshold, default 5 m), variance

## Google sign-in (single sign-on)
> **Currently switched off for previewing.** The gate lives in `sso/auth.js`, outside the folder Netlify deploys
> functions from, so the site is open to anyone with the link. To turn it on, set the environment variables below and
> move it back: `git mv sso/auth.js netlify/edge-functions/auth.js`, then commit and deploy.

When enabled, `netlify/edge-functions/auth.js` runs on Netlify before every request: nobody can load the app, its files, or `/auth/me`
without signing in with an allow-listed Google account. Sessions last 7 days in a signed, HttpOnly cookie, and the
allow-list is checked on every request, so removing an email revokes access immediately. Locally (no Netlify) the gate is not active.

### One-time Google setup (Google Cloud Console)
1. https://console.cloud.google.com → create a project (e.g. "Royal Inventory").
2. **APIs & Services → OAuth consent screen** (Google Auth Platform): app name, support email.
   Audience **Internal** if all staff use your Google Workspace domain; otherwise **External**, then **Publish app**
   (only the basic `openid email profile` scopes are used, so no Google verification is required).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorised redirect URI: `https://<your-site>.netlify.app/auth/callback` (add your custom domain's `/auth/callback` too).
4. In **Netlify → Site configuration → Environment variables** add:
   | Variable | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | the client ID |
   | `GOOGLE_CLIENT_SECRET` | the client secret (keep private — only in Netlify) |
   | `SESSION_SECRET` | 32+ random characters, e.g. from `openssl rand -base64 48` |
   | `ALLOWED_EMAILS` | comma-separated staff Gmail/Google addresses |
   | `ALLOWED_DOMAINS` | optional: your Google Workspace domain, admits every account in it |
5. Redeploy. Until the variables are set, the site shows a "sign-in not configured" page (it fails closed).

## Data & Dropbox
Every change is saved instantly in the browser (IndexedDB) and, once Dropbox is connected, uploaded to
`Dropbox/Apps/<your app>/royal-inventory.json`. A full copy is also written to `history/YYYY-MM-DD.json` each day.
Devices connected to the same Dropbox account share one inventory; edits made at the same time are merged
(each change is replayed on top of the latest Dropbox copy). Changes made offline upload automatically later.
Deleted cards/withdrawals go to an archive and can be restored.

### One-time Dropbox setup
1. https://www.dropbox.com/developers/apps → **Create app** → *Scoped access* → *App folder* → name it (e.g. RoyalInventory).
2. **Permissions** tab: enable `files.metadata.read`, `files.content.read`, `files.content.write` → Submit.
3. **Settings** tab → *OAuth 2 Redirect URIs*: add your site URL exactly, e.g. `https://your-site.netlify.app/`.
4. Copy the **App key** (not the secret) into `assets/js/config.js` → `dropboxAppKey` (or paste it in the app's Settings on each device).
5. On each device: Settings → **Connect Dropbox**, sign in with the shop's Dropbox account.

## Files
```
index.html            markup, dialogs, icon sprite
sso/auth.js           Google sign-in gate (disabled; see above to enable)
assets/css/styles.css design tokens + components (black / gold / ivory)
assets/js/i18n.js     Arabic & English strings
assets/js/config.js   site settings (Dropbox App key)
assets/js/dropbox.js  Dropbox OAuth (PKCE) + file API
assets/js/store.js    operations, local persistence, Dropbox sync, calculations
assets/js/app.js      rendering, forms, import/export
```
