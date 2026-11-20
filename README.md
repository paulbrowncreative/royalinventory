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
| Inventory · صفحة الجرد | Add Item to Inventory form (entry date, item number, name, source, opening balance) and the inventory list with total withdrawals and remaining balance |
| History & Archive · السجل والأرشيف | Stock on any past date, withdrawal summary for a period, deleted-records archive, daily Dropbox copies |
| User Guide · دليل الاستخدام | Workflow and calculation rules |
| Settings · الإعدادات | Dropbox connection, low-stock threshold, user name, CSV import, JSON backup/restore |

## Calculations
- Calculated balance = opening stock − total withdrawals
- Variance = physical count − calculated balance on the count date
- Final available = physical count − withdrawals after the count date (or the calculated balance when there is no count)
- Alerts: negative, out (0), low (≤ threshold, default 5 m), variance

## Staff sign-in (Netlify Identity)
`netlify/edge-functions/auth.js` runs on Netlify before every request. Only invited staff can load the app,
its scripts or `/auth/me`; everyone else sees the branded sign-in page. Free on every Netlify plan, no API keys.

**Setup (Netlify → your site → Identity):**
1. **Enable Identity**.
2. **Settings and usage → Registration → Registration preferences → Invite only** → Save.
3. **Invite users** → enter staff emails. Each person gets an email, clicks the link, sets a password and is signed in.

Managing access: invite to add, **Delete user** to remove (locked out within about a minute).
Staff can reset their own password with "Forgot password?" on the sign-in page.
The gate fails closed: if Identity is off, or registration is left *Open*, nobody can sign in and the page says why.
Sessions last 14 days of inactivity. Locally (without Netlify) the gate is not active.

An alternative Google sign-in gate (requires a Google Cloud OAuth client) is kept in `sso/google-auth.js`.

## Shared storage (sync between devices)
On Netlify the inventory is stored on the site itself (Netlify Function `netlify/functions/store.mjs` +
Netlify Blobs, free tier). Every signed-in device shares one copy automatically — no setup. Each device
links once: it uploads its data if the shared copy is empty, adopts the shared copy if it is empty itself,
and asks only if both hold data (the replaced copy is always kept under History → Daily Backup Copies).
Changes upload within a second, other devices pick them up within 20 s or as soon as the app is opened or
brought to the front, and saves from two devices at once are merged (conditional writes + replay).
Offline changes queue on the device and upload when it reconnects.
Every save is confirmed by reading it back before the device clears its queue, data travels
gzip-compressed (Netlify Functions cap bodies at ~6 MB; 40,000 withdrawals send as ~0.8 MB), and the base
revision is sent as `?base=` / `X-Base-Rev` because Netlify's CDN strips the standard `If-Match` header.
Automatically numbered cards that two devices create at the same time get the next free number on merge,
and the device that made the card shows a notice so the label can be corrected. When the site is opened without Netlify
(e.g. locally) the app falls back to device storage and the optional Dropbox connection below.

Settings → Shared Storage shows this device's sync status (last check, last shared save, pending
changes, last error, app version) for troubleshooting. A device that cannot reach shared storage at first
(slow connection) keeps retrying in the background and switches over by itself.

**Releasing an update:** bump the version in both `assets/version.txt` and `APP_VERSION` at the top of
`assets/js/app.js`. Devices that keep the app open reload onto the new version automatically once all
their changes are saved.

## Data & Dropbox
**Autosave and safeguards.** Every change is saved immediately on the device (IndexedDB) and also copied
synchronously to a small safety log, so a tab closed mid-save loses nothing (the log is replayed on next load).
Two open tabs editing at once are merged, not overwritten. If a save or Dropbox upload fails, the header shows
**Save now**; signing out first saves everything and, if anything is still unsaved (or a withdrawal is half-typed),
a dialog offers **Save now**, **Download backup**, **Sign out anyway** or **Cancel**. Closing the tab with unsaved
changes triggers the browser's leave warning.

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
netlify/edge-functions/auth.js  staff sign-in gate (Netlify Identity)
netlify/functions/store.mjs     shared storage API (Netlify Blobs)
assets/js/server-store.js       client for the shared storage
sso/google-auth.js    alternative Google sign-in gate (not deployed)
assets/css/styles.css design tokens + components (black / gold / ivory)
assets/js/i18n.js     Arabic & English strings
assets/js/config.js   site settings (Dropbox App key)
assets/js/dropbox.js  Dropbox OAuth (PKCE) + file API
assets/js/store.js    operations, local persistence, Dropbox sync, calculations
assets/js/app.js      rendering, forms, import/export
```
