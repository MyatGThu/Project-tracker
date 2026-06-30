# 🃏 Poker Tracker

A polished, installable web app for tracking **home poker games** and **casino visits** — buy-ins, re-buys, settlements, leaderboards, records, and stats. Built as a fast, offline-capable PWA on a serverless stack that costs ~$0 to run at small scale.

> Two apps in one: a **Home Game** tracker (multi-player buy-ins → automatic settlements) and a **Casino** visit log (win/loss tracking, blinds timer, trip planning). Switchable from a mode selector.

---

## ✨ Features

### Home Game mode
- **Sessions** — create game nights, rename, set a custom date, add notes, search
- **Players & buy-ins** — pick from a roster, quick re-buys (configurable amount), edit/remove any buy-in
- **Live pot** total during an active session
- **Settle Up** — enter each player's profit/loss; the app computes **minimal-transaction settlements** ("who pays whom") automatically
- **Force-balance** — spreads chip-count discrepancies fairly when the table doesn't reconcile
- **Re-open** a settled session, **copy/share** results to a group chat
- **Seat randomizer** and a **2-dealer suggestion** for large tables

### Casino mode
- **Visit log** — casino, date, buy-in → cash-out, games played, notes
- **Dashboard** — total P&L, best/worst visit, win rate, with **time-period filters** (all-time / year / month)
- **Stats** — per-casino breakdown, favourite games, monthly summary
- **Blinds timer** — tournament clock with configurable levels (1–20 min)
- **Next-trip planner** with countdown

### General
- 🏆 **Leaderboard** with podium, win/loss streaks, and a **cumulative P&L chart**
- 📊 **Records** — biggest wins/losses, averages, attendance, consistency
- 🔒 **Password lock** (server-verified, no password stored in client code) — with an optional second **"user" password** for a restricted role that can't delete, re-open, or edit
- 📱 **Installable PWA** — add to home screen, works offline, safe-area aware
- 🎉 Splash animation, confetti on wins, skeleton loaders, toast + undo

---

## 🗺️ Roadmap & contributor docs

- **[TODO.md](TODO.md)** — roadmap: multi-tenant data model → real accounts/auth (social sign-in) → optional Azure hosting, plus polish items.
- **[CLAUDE.md](CLAUDE.md)** — architecture notes & commands for working in this codebase (no build step, view system, Worker API, money-math core, gotchas).

## 🧱 Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (no framework, no build step) |
| Charts | Chart.js (CDN) |
| Backend | Cloudflare Worker (serverless API) |
| Database | Cloudflare D1 (SQLite) |
| Hosting | Cloudflare Pages (frontend) + Workers (API) |
| Tests | Vitest (settlement math) |

No bundler, no `npm run build` — the frontend is plain static files. The only "backend" is a single Worker file.

---

## 📁 Project structure

```
.
├── index.html          # App shell + all views/modals
├── app.js              # Application logic
├── settlement.js       # Pure money math (net, settlements, force-balance)
├── settlement.test.js  # Vitest suite for the money math
├── style.css           # Design system + responsive + safe-area handling
├── config.example.js   # → copy to config.js (API URL + default roster)
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (offline shell cache)
├── icon-*.png          # PWA icons
└── worker/
    ├── src/index.js        # Cloudflare Worker API (all endpoints + validation)
    ├── schema.sql          # D1 schema (run once)
    ├── wrangler.example.jsonc  # → copy to wrangler.jsonc (add your DB id)
    └── package.json
```

---

## 🚀 Setup & deploy (~30–45 min)

### Prerequisites
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) 18+

### 1. Backend — Worker + D1 database

```bash
cd worker
npm install
npx wrangler login

# Create the database, then copy the printed database_id
npx wrangler d1 create poker-tracker

# Add your database_id to the config
cp wrangler.example.jsonc wrangler.jsonc
#   → edit wrangler.jsonc, paste the database_id

# Create the tables
npx wrangler d1 execute poker-tracker --remote --file schema.sql

# (Optional) load sample data so the app isn't empty on first run / for a demo
npx wrangler d1 execute poker-tracker --remote --file seed.sql

# Set the admin password (stored encrypted in Cloudflare, never in code)
npx wrangler secret put LOCK_PASSWORD
#   → type the admin password — full access

# (Optional) Set a second, restricted "user" password. Anyone logging in with
# it can add players, log buy-ins and settle up, but CANNOT delete or re-open
# sessions, remove/edit buy-ins, remove players, force-balance, or delete
# casino visits — handy for passing the phone around without risking a mistake.
# Skip this command to keep a single password (everyone gets full access).
npx wrangler secret put USER_PASSWORD

# Deploy — copy the printed https://...workers.dev URL
npm run deploy
```

### 2. Frontend — configure + deploy

```bash
cd ..
cp config.example.js config.js
#   → edit config.js:
#        API_BASE = 'https://YOUR-WORKER.workers.dev/api'   (note the /api)
#        DEFAULT_ROSTER = [...your starter player names...]
```

Then deploy the static files to Cloudflare Pages — either:

- **Connect a Git repo:** Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git. Framework preset **None**, build command **blank**, output directory **/**. Or
- **Direct upload:** `npx wrangler pages deploy .`

Open the resulting `*.pages.dev` URL, enter your password, pick a mode, and you're live.

### 3. (Optional) Custom domain
Add it under your Pages project → **Custom domains**. Cloudflare provisions SSL automatically.

---

## 🧪 Tests

```bash
npm install
npm test       # runs the settlement / money-math suite (Vitest)
```

The trust-critical logic (net calculation, minimal-transaction settlement, discrepancy spreading) lives in `settlement.js` and is fully unit-tested.

---

## ⚙️ Configuration

All deployment-specific values live in **`config.js`** (gitignored):

| Value | Purpose |
|---|---|
| `API_BASE` | Your Worker URL + `/api` |
| `CURRENCY` | Currency symbol shown throughout (`$`, `£`, `€`, `A$`, …) |
| `DEFAULT_ROSTER` | Starter list of player names in the picker |

Other tweaks:
- **Quick re-buy amount** — set in-app (persists per device), defaults to $20
- **Blinds levels** — edit `BLIND_LEVELS` in `app.js`
- **Theme** — CSS custom properties at the top of `style.css` (`--accent`, etc.)

---

## 🔐 Notes

- The app password is verified server-side against the `LOCK_PASSWORD` Worker secret — it never appears in client code or the repo. An optional `USER_PASSWORD` secret enables a restricted "user" role: the lock screen accepts either password and the server returns the role, which the client uses to hide destructive actions (delete / re-open / remove / edit buy-in / force-balance / delete casino visit). This is mistake-prevention for a shared device, not a hard security boundary — the data API endpoints are unauthenticated.
- All API writes are server-side validated (positive amounts, required fields, valid status).
- Cloudflare D1 **Time Travel** gives 30-day point-in-time recovery out of the box.

---

## 📄 License & legal

- [LICENSE](LICENSE) — proprietary; full rights transfer to the buyer on purchase.
- [PRIVACY.md](PRIVACY.md) — fill-in privacy policy template (Australia + GDPR-style).
- [TERMS.md](TERMS.md) — fill-in terms of use template.

Replace the **[bracketed]** placeholders with your own operator name, contact,
and jurisdiction before going live.

### Third-party assets

All bundled/loaded third-party resources are open-source and free for
commercial use:

| Asset | Use | License |
|---|---|---|
| [Chart.js](https://www.chartjs.org/) | P&L chart (loaded via CDN) | MIT |
| Fraunces, Inter, JetBrains Mono ([Google Fonts](https://fonts.google.com/)) | Typography | SIL Open Font License 1.1 |

No other third-party code or assets are included. App icons were created for
this project.
