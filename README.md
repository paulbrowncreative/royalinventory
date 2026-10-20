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
| User Guide · دليل الاستخدام | Workflow and calculation rules |
| Settings · الإعدادات | Low-stock threshold, CSV import, JSON backup/restore |

## Calculations
- Calculated balance = opening stock − total withdrawals
- Variance = physical count − calculated balance on the count date
- Final available = physical count − withdrawals after the count date (or the calculated balance when there is no count)
- Alerts: negative, out (0), low (≤ threshold, default 5 m), variance

## Data
Data is saved automatically in the browser (IndexedDB) **on each device separately**.
Use Settings → *Download Backup* regularly. Excel data can be imported as “CSV UTF-8” using the downloadable templates.
To share live data across several devices/users, a backend (e.g. Supabase or Firebase) can replace `assets/js/store.js` without changing the UI.

## Files
```
index.html            markup, dialogs, icon sprite
assets/css/styles.css design tokens + components (black / gold / ivory)
assets/js/i18n.js     Arabic & English strings
assets/js/store.js    persistence + stock calculations
assets/js/app.js      rendering, forms, import/export
```
