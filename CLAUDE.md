# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # root deps (vitest only)
npm test                    # run the settlement money-math suite (Vitest)
npx vitest run settlement.test.js          # the single test file
npx vitest run -t "force-balance"          # a single test by name

# Backend (Cloudflare Worker + D1) — all run from worker/
cd worker && npm install
npx wrangler dev            # local API on http://localhost:8787
npm run deploy              # = wrangler deploy
npx wrangler d1 execute poker-tracker --remote --file schema.sql   # apply schema
npx wrangler secret put LOCK_PASSWORD        # admin password (server-side only)
npx wrangler secret put USER_PASSWORD        # optional restricted role

# Frontend — static files, NO build step
npx wrangler pages deploy .                  # direct upload, or connect Git in CF dashboard
```

There is **no bundler and no build step**. The frontend is plain static files served as-is; "running" it locally means serving the directory (e.g. `npx serve .`) with a valid `config.js` pointing at a deployed/`wrangler dev` Worker.

## Architecture

Three layers, deliberately framework-free:

1. **Static frontend** — `index.html` (app shell holding *every* view and modal), `app.js` (~2900-line monolith = all UI logic), `settlement.js` (pure money math), `style.css` (design system + responsive + safe-area), `sw.js` (service worker).
2. **`worker/src/index.js`** — a single Cloudflare Worker file = the entire API. Routes are matched by `path === ...` / `path.match(regex)` on `url.pathname`; all endpoints are under `/api/*`.
3. **Cloudflare D1 (SQLite)** — schema in `worker/schema.sql`.

### Frontend view system
`app.js` drives a single-page app via `show(viewId, dir)` which toggles `.view.active` on the `#view-*` divs in `index.html`. There is no router and no components — everything is global functions + `innerHTML`. The two product modes (**Home Game** and **Casino**) are just different sets of views switched from a mode selector. Data is fetched through the single `api(path, method, body)` helper, which guards against a missing/placeholder `API_BASE`.

### Roles (mistake-prevention, not real auth)
The lock screen POSTs to `/api/auth`; the Worker compares against the `LOCK_PASSWORD` / `USER_PASSWORD` secrets and returns `{ role: 'admin' | 'user' }`. The client stores it in `sessionStorage` (`getRole()` / `isAdmin()`) and hides destructive actions for `user`. **The data API endpoints themselves are unauthenticated** — anyone with the Worker URL can read/write. Treat this as a shared-device guardrail, not a security boundary. (Adding real per-user auth is the planned next phase — see `TODO.md`.)

### Data model & money flow
`sessions → session_players → buyins` (FK `ON DELETE CASCADE`); `casino_visits` is standalone. Settlement is **final-chips driven**: each `session_players.final_chips` minus that player's summed buy-ins = their net; `settlement.js` turns the net vector into minimal "who pays whom" transactions, with a force-balance step that fairly spreads any chip-count discrepancy. **`settlement.js` is the trust-critical core and is fully unit-tested — never change its math without keeping `settlement.test.js` green.**

### Worker write-safety
PATCH bodies are filtered through `ALLOWED_FIELDS` (per-table column whitelist) before column names are ever interpolated into SQL — user input can't inject column names. Every write is guarded by the `isStr` / `isPos` / `isMoneyOrNull` / `isDateStr` predicates. Keep both patterns when adding endpoints.

## Gotchas that bite

- **Bump the service-worker cache on any shell change.** `sw.js` is network-first but re-caches assets; stale deploys were a recurring bug. After editing `index.html` / `app.js` / `style.css`, increment `const CACHE = 'poker-tracker-vNN'` in `sw.js`. The fetch handler uses `fetch(request, { cache: 'no-cache' })` to bypass the browser HTTP cache.
- **Accessibility cues are intentional, keep them.** Win/loss is never color-only: `▲`/`▼` pseudo-element cues (WCAG 1.4.1) live in `style.css`; secondary text uses the `--muted` token which is tuned to clear WCAG AA (≥4.5:1) on all surfaces — don't darken it.
- **Reduced motion is global.** A `@media (prefers-reduced-motion: reduce)` damper near-zeroes every animation; new animations inherit it automatically, so don't add per-animation opt-outs.
- **Dashboard records logic lives in `loadDashboard()`** (highest earnings, win/loss streaks via `longestStreaks()`, highest pot, "Person in Hell"), with the fire/ember effects (`embersHTML()` + `.rock-bottom` CSS) applied to the last-place cards.
- **`config.js` is committed and holds no secrets** (`API_BASE`, `CURRENCY`, `DEFAULT_ROSTER`, `RANK_BADGES`). Passwords only ever exist as Worker secrets.
- **Vendored skills under `.claude/skills/` are intentionally tracked** (`.gitignore` ignores `.claude/*` except `skills/`).
