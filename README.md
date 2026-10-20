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
assets/css/styles.css design tokens + components (black / gold / ivory)
assets/js/i18n.js     Arabic & English strings
assets/js/config.js   site settings (Dropbox App key)
assets/js/dropbox.js  Dropbox OAuth (PKCE) + file API
assets/js/store.js    operations, local persistence, Dropbox sync, calculations
assets/js/app.js      rendering, forms, import/export
```
