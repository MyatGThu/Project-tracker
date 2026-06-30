# TODO / Roadmap

Working backlog for Poker Tracker. The big theme is moving from a **single shared
dataset behind a password** to **real multi-user accounts**. Ordered by dependency,
not just priority — earlier phases unblock later ones.

---

## Phase 1 — Multi-tenant data model (foundation)

> The real work behind "accounts" isn't login, it's data ownership. Today every
> visitor with the URL sees the same sessions/players (`/api/*` is unauthenticated).
> This phase makes data belong to someone — and must land *before* auth is useful.

- [x] Decide the ownership unit: **per-group** (a poker crew shares one ledger) is
      almost certainly right for this app, not per-individual. This drives everything below.
      → encoded in the schema: `groups` is the owning entity; `sessions`/`casino_visits`
      carry `group_id`, and users join groups via `group_members`.
- [x] Schema: add `users`, `groups`, `group_members` (role per member), and `invites`
      tables to `worker/schema.sql`. Write a migration, not a destructive recreate.
      → `worker/migrations/0001_multitenant.sql` (run-once, non-destructive) + the same
      shape mirrored into `schema.sql` for fresh installs.
- [x] Add `group_id` (and/or `user_id`) to `sessions` and `casino_visits` as a
      **nullable** column first so existing rows keep working; backfill, then enforce.
      → added nullable in migration 0001; legacy rows keep `group_id IS NULL`.
      Backfill + `NOT NULL` enforcement deferred until the query-scoping step below lands.
- [x] Scope **every** query in `worker/src/index.js` by the caller's group — reads and
      writes. This is the bulk of the effort and the easy thing to get subtly wrong.
      → done via `groupFilter` (read scoping) + `ownsRow` (write ownership checks) on
      every route; verified by `worker/integration.test.js` (cross-group reads/writes 404).
      Still gated: when Auth0 is off, `gid` is null and everything matches (legacy mode).
- [x] Invite flow: generate a link/code that adds a user to a group.
      → `POST /api/invites` (owner/admin only) + `POST /api/invites/:code/accept`;
      single-use, optional expiry. Joining adds a `group_members` row.

## Phase 2 — Authentication & accounts

> Buy, don't build. A managed identity provider gives email/password *and* social
> login behind one integration; rolling your own password/session/OAuth stack is a
> liability. The `group_id` slots from Phase 1 are what the logged-in user attaches to.

- [x] Pick a provider → **Auth0** (easiest DX; plain-JS SDK fits the no-build frontend;
      standard OIDC JWTs the Worker verifies via JWKS). Other candidates considered:
      Microsoft Entra External ID, Clerk, Supabase Auth.
- [x] Replace the `LOCK_PASSWORD` lock screen with provider login; verify the token
      **server-side** in the Worker and derive the user/group from it.
      → `worker/src/auth.js` (RS256 + JWKS verification, unit-tested); client uses
      `auth0-spa-js` (CDN) and attaches `Authorization: Bearer` + `X-Group-Id`. The lock
      screen shows a "Sign in" button when `AUTH0` is configured, password input otherwise.
- [x] Migrate the existing `admin` / `user` role concept into per-group membership roles.
      → `group_members.role` = owner | admin | member; client maps owner/admin → admin,
      member → user, reusing the existing `isAdmin()` destructive-action gating.
- [ ] Social sign-in: **GitHub / Google are easy** (~20 min each). **Facebook** needs
      Meta Business verification + privacy-policy URL + App Review — budget real time or
      defer. **Apple** only needed if shipping to the iOS App Store (paid dev account).
      → No code change needed: enable the connections in the Auth0 dashboard. Just config.
- [x] **Multi-user UX:** Account modal with in-app group switcher (uses `X-Group-Id` +
      `/api/me`), invite-link generation, `?invite=CODE` redemption (preserved across the
      Auth0 redirect), and a sign-out control. Buttons stay hidden in password mode.
- [ ] **Retire the password path** (decided): once accounts are in real use, remove the
      password lock + `/api/auth` + `LOCK_PASSWORD`/`USER_PASSWORD` so Auth0 is the only
      way in. Deferred until after a deployment has run on accounts.
- [ ] **Optional Phase 1 backfill** (skipped for now — current data is disposable): a
      default group + `NOT NULL` on `group_id` once a deployment has data worth migrating.

## Phase 3 — Hosting (optional: Azure free tier)

> Current stack (Cloudflare Pages + Workers + D1) is genuinely a *simpler/better* free
> tier for this app. Only migrate if the goal is learning Azure. Keep it fully free.

- [ ] **Azure Static Web Apps (Free)** for the frontend — built-in GitHub/Entra auth, free SSL/CDN.
- [ ] **Azure Functions** (bundled with SWA) to port the Worker API.
- [ ] Database: **Cosmos DB free tier** (1000 RU/s + 25GB, NoSQL rethink) or the
      **Azure SQL free offer** (closest to the current SQLite/D1 schema). Verify current
      free-tier terms before committing — Microsoft changes them often.

---

## Smaller / polish items

From the most recent `impeccable` audit (P3 — nice-to-have, no user-blocking impact):

- [ ] Dashboard `aria-live` so screen readers announce the skeleton → data swap
      (skipped earlier to avoid double-announcing the already-rendered amounts).
- [ ] Tokenize the fire/ember colors (`#ff8126`, `#ffe9a8`, `rgba(255,80,40,…)`) into
      a `--fire-*` ramp instead of inline literals in `style.css`.
- [ ] Revisit the dashboard's hero-metric + repeating stat-card grid (a known design
      cliché) — only if a more distinctive layout is wanted; current variety mostly carries it.

## Known constraints (context, not bugs)

- The data API is unauthenticated — Phase 1+2 close this.
- Single-theme (dark only) by design.
- No build step by design; keep it that way unless a real need appears.
