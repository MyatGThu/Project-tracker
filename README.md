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
- 🔒 **Auth0 sign-in** with **per-group accounts** — each crew has its own private ledger; group owners/admins invite others via a link, members get a restricted role that can't delete, re-open, or edit
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

# Auth0 secrets (REQUIRED — sign-in is Auth0 only). See "Sign-in (Auth0)" below
# for where these come from. The Worker returns 503 until both are set.
npx wrangler secret put AUTH0_DOMAIN     #   → your-tenant.us.auth0.com
npx wrangler secret put AUTH0_AUDIENCE   #   → your API Identifier (audience)

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

Then deploy the static files. Because the frontend is just static files with **no
build step**, any static host works — pick one:

- **Cloudflare Pages — connect a Git repo:** dashboard → Workers & Pages → Create → Pages → Connect to Git. Framework preset **None**, build command **blank**, output directory **/**.
- **Cloudflare Pages — direct upload:** `npx wrangler pages deploy .`
- **Vercel / Netlify / any static host:** point it at the repo root, framework preset **Other/None**, no build command, output directory **/**.

The frontend and the Worker API are separate origins (the Worker sends permissive
CORS), so the static host and Cloudflare don't need to be the same provider. **Set your
Auth0 callback URLs (next section) to whichever domain(s) you deploy the frontend on.**
Open the resulting URL, sign in, pick a mode, and you're live.

### 3. (Optional) Custom domain
Add it under your Pages project → **Custom domains**. Cloudflare provisions SSL automatically.

### 4. Sign-in (Auth0) — required

Sign-in is **Auth0 only** (there is no password fallback). Each user gets accounts +
**per-group private data**; until it's configured the app shows a "not configured" notice
and the Worker returns 503.

1. **Create an Auth0 tenant** (free) → create a **Single Page Application** and an
   **API**. Note the SPA's *Domain* + *Client ID* and the API's *Identifier* (audience).
2. In the SPA settings, add your site URL to **Allowed Callback URLs**, **Allowed Logout
   URLs**, and **Allowed Web Origins** (e.g. `https://YOUR-APP.pages.dev` — every domain
   you deploy the frontend on, plus `http://localhost:PORT` for local dev).
3. **Worker secrets** — tell the API which tokens to trust (also done in step 1 above):
   ```bash
   cd worker
   npx wrangler secret put AUTH0_DOMAIN      # e.g. your-tenant.us.auth0.com
   npx wrangler secret put AUTH0_AUDIENCE    # the API Identifier from step 1
   npm run deploy
   ```
4. **Frontend** — set the `AUTH0` block in `config.js` (all public values):
   ```js
   const AUTH0 = {
     domain:   'your-tenant.us.auth0.com',
     clientId: 'YOUR_SPA_CLIENT_ID',
     audience: 'https://api.poker-tracker',   // must match AUTH0_AUDIENCE
   };
   ```
5. Redeploy the frontend. The lock screen shows **Sign in**; the first login provisions a
   personal group, and group owners/admins invite others from the in-app **Account** menu
   (which generates a `?invite=CODE` link). Members can switch between groups there too.

Social sign-in (GitHub, Google, …) is just an Auth0 dashboard toggle — no code change.
For local development, put the two secrets in `worker/.dev.vars` (see
`worker/.dev.vars.example`).

---

## 🧪 Tests

```bash
npm install
npm test       # runs all Vitest suites
```

- **`settlement.test.js`** — the trust-critical money math (net calculation,
  minimal-transaction settlement, discrepancy spreading) in `settlement.js`.
- **`worker/auth.test.js`** — Auth0 RS256 token verification (valid tokens accepted;
  tampering, wrong audience/issuer, expiry, and `alg` downgrade rejected).
- **`worker/integration.test.js`** — the real Worker handler against an in-memory
  SQLite DB, asserting group data isolation, blocked cross-group writes, and the invite flow.

---

## ⚙️ Configuration

All deployment-specific values live in **`config.js`** (gitignored):

| Value | Purpose |
|---|---|
| `API_BASE` | Your Worker URL + `/api` |
| `CURRENCY` | Currency symbol shown throughout (`$`, `£`, `€`, `A$`, …) |
| `DEFAULT_ROSTER` | Starter list of player names in the picker |
| `AUTH0` | **Required** `{ domain, clientId, audience }` for sign-in (see step 4 above); `null` shows a "not configured" screen |

Other tweaks:
- **Quick re-buy amount** — set in-app (persists per device), defaults to $20
- **Blinds levels** — edit `BLIND_LEVELS` in `app.js`
- **Theme** — CSS custom properties at the top of `style.css` (`--accent`, etc.)

---

## 🔐 Notes

- Sign-in is **Auth0 only**: every `/api` route requires a verified Bearer token (RS256, checked against the tenant JWKS server-side in the Worker) and is scoped to the caller's group, so each crew's data is private. Identity is keyed solely by the Auth0 `sub` (accounts are never linked by email). The per-group role (owner/admin/member) drives which destructive actions (delete / re-open / remove / edit buy-in / force-balance / delete casino visit) are hidden.
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
