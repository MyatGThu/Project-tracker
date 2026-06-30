# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # root deps (vitest only)
npm test                    # run all Vitest suites (settlement + worker auth + worker integration)
npx vitest run settlement.test.js          # a single test file
npx vitest run -t "force-balance"          # a single test by name

# Backend (Cloudflare Worker + D1) — all run from worker/
cd worker && npm install
npx wrangler dev            # local API on http://localhost:8787
npm run deploy              # = wrangler deploy
npx wrangler d1 execute poker-tracker --remote --file schema.sql   # fresh DB: full schema
npx wrangler d1 execute poker-tracker --remote --file migrations/0001_multitenant.sql  # existing DB: add multi-tenant tables (run once)
npx wrangler secret put LOCK_PASSWORD        # admin password (server-side only)
npx wrangler secret put USER_PASSWORD        # optional restricted role
npx wrangler secret put AUTH0_DOMAIN         # multi-user mode: Auth0 tenant domain
npx wrangler secret put AUTH0_AUDIENCE       # multi-user mode: API identifier (audience)

# Frontend — static files, NO build step
npx wrangler pages deploy .                  # direct upload, or connect Git in CF dashboard
```

There is **no bundler and no build step**. The frontend is plain static files served as-is; "running" it locally means serving the directory (e.g. `npx serve .`) with a valid `config.js` pointing at a deployed/`wrangler dev` Worker.

## Architecture

Three layers, deliberately framework-free:

1. **Static frontend** — `index.html` (app shell holding *every* view and modal), `app.js` (~2900-line monolith = all UI logic), `settlement.js` (pure money math), `style.css` (design system + responsive + safe-area), `sw.js` (service worker).
2. **`worker/src/index.js`** — the Cloudflare Worker = the entire API. Routes are matched by `path === ...` / `path.match(regex)` on `url.pathname`; all endpoints are under `/api/*`. Auth0 token verification lives in the sibling module **`worker/src/auth.js`**.
3. **Cloudflare D1 (SQLite)** — full schema for fresh DBs in `worker/schema.sql`; incremental, run-once migrations in `worker/migrations/` (apply to existing DBs).

### Frontend view system
`app.js` drives a single-page app via `show(viewId, dir)` which toggles `.view.active` on the `#view-*` divs in `index.html`. There is no router and no components — everything is global functions + `innerHTML`. The two product modes (**Home Game** and **Casino**) are just different sets of views switched from a mode selector. Data is fetched through the single `api(path, method, body)` helper, which guards against a missing/placeholder `API_BASE`.

### Auth — two modes, config-gated
The app has **two distinct auth modes**, selected by whether `AUTH0` is set in `config.js`:

- **Password mode (default).** The lock screen POSTs to `/api/auth`; the Worker compares against `LOCK_PASSWORD` / `USER_PASSWORD` and returns `{ role: 'admin' | 'user' }`. The client stores it in `sessionStorage` (`getRole()` / `isAdmin()`) and hides destructive actions for `user`. **The data API endpoints are unauthenticated** — anyone with the Worker URL can read/write. A shared-device guardrail, not a security boundary.
- **Multi-user mode (TODO Phase 2).** When the `AUTH0_DOMAIN` + `AUTH0_AUDIENCE` Worker secrets *and* the `AUTH0` `config.js` block are both set, every `/api` route requires a verified Bearer token (RS256/JWKS, verified in `worker/src/auth.js`) and is **scoped to the caller's active group**. `authEnabled(env)` is the server switch; `authMode()` is the client switch. First login auto-provisions a `users` row + a personal `groups` row (owner). The active group is the `X-Group-Id` header (when the caller is a member) else their oldest membership. The per-group role maps onto the existing `isAdmin()` gating (owner/admin → admin, member → user), so destructive-action hiding is reused unchanged.

**Both modes share one rule: when Auth0 is not configured the API behaves exactly as the original single-shared-dataset app** (group columns stay NULL, no scoping). Keep this fall-through intact when adding endpoints — wrap group checks in `if (gid)` / use the `groupFilter` + `ownsRow` helpers. The auth + scoping paths are covered by `worker/auth.test.js` and `worker/integration.test.js` (the latter runs the real handler against `node:sqlite`).

### Data model & money flow
`sessions → session_players → buyins` (FK `ON DELETE CASCADE`); `casino_visits` is standalone. Multi-tenant tables `groups`, `users`, `group_members`, `invites` sit alongside; `sessions` and `casino_visits` each carry a **nullable** `group_id` (NULL = legacy/password-mode rows). Settlement is **final-chips driven**: each `session_players.final_chips` minus that player's summed buy-ins = their net; `settlement.js` turns the net vector into minimal "who pays whom" transactions, with a force-balance step that fairly spreads any chip-count discrepancy. **`settlement.js` is the trust-critical core and is fully unit-tested — never change its math without keeping `settlement.test.js` green.**

### Worker write-safety
PATCH bodies are filtered through `ALLOWED_FIELDS` (per-table column whitelist) before column names are ever interpolated into SQL — user input can't inject column names. Every write is guarded by the `isStr` / `isPos` / `isMoneyOrNull` / `isDateStr` predicates. Keep both patterns when adding endpoints.

## Gotchas that bite

- **Bump the service-worker cache on any shell change.** `sw.js` is network-first but re-caches assets; stale deploys were a recurring bug. After editing `index.html` / `app.js` / `style.css`, increment `const CACHE = 'poker-tracker-vNN'` in `sw.js`. The fetch handler uses `fetch(request, { cache: 'no-cache' })` to bypass the browser HTTP cache.
- **Accessibility cues are intentional, keep them.** Win/loss is never color-only: `▲`/`▼` pseudo-element cues (WCAG 1.4.1) live in `style.css`; secondary text uses the `--muted` token which is tuned to clear WCAG AA (≥4.5:1) on all surfaces — don't darken it.
- **Reduced motion is global.** A `@media (prefers-reduced-motion: reduce)` damper near-zeroes every animation; new animations inherit it automatically, so don't add per-animation opt-outs.
- **Dashboard records logic lives in `loadDashboard()`** (highest earnings, win/loss streaks via `longestStreaks()`, highest pot, "Person in Hell"), with the fire/ember effects (`embersHTML()` + `.rock-bottom` CSS) applied to the last-place cards.
- **`config.js` is committed and holds no secrets** (`API_BASE`, `CURRENCY`, `DEFAULT_ROSTER`, `RANK_BADGES`, and the optional `AUTH0` block). The `AUTH0` `domain`/`clientId`/`audience` are public client values (safe to commit); passwords and the `AUTH0_*` server secrets only ever exist as Worker secrets.
- **Vendored skills under `.claude/skills/` are intentionally tracked** (`.gitignore` ignores `.claude/*` except `skills/`).
