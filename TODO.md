# TODO / Roadmap

Working backlog for Poker Tracker. The big theme is moving from a **single shared
dataset behind a password** to **real multi-user accounts**. Ordered by dependency,
not just priority — earlier phases unblock later ones.

---

## Phase 1 — Multi-tenant data model (foundation)

> The real work behind "accounts" isn't login, it's data ownership. Today every
> visitor with the URL sees the same sessions/players (`/api/*` is unauthenticated).
> This phase makes data belong to someone — and must land *before* auth is useful.

- [ ] Decide the ownership unit: **per-group** (a poker crew shares one ledger) is
      almost certainly right for this app, not per-individual. This drives everything below.
- [ ] Schema: add `users`, `groups`, `group_members` (role per member), and `invites`
      tables to `worker/schema.sql`. Write a migration, not a destructive recreate.
- [ ] Add `group_id` (and/or `user_id`) to `sessions` and `casino_visits` as a
      **nullable** column first so existing rows keep working; backfill, then enforce.
- [ ] Scope **every** query in `worker/src/index.js` by the caller's group — reads and
      writes. This is the bulk of the effort and the easy thing to get subtly wrong.
- [ ] Invite flow: generate a link/code that adds a user to a group.

## Phase 2 — Authentication & accounts

> Buy, don't build. A managed identity provider gives email/password *and* social
> login behind one integration; rolling your own password/session/OAuth stack is a
> liability. The `group_id` slots from Phase 1 are what the logged-in user attaches to.

- [ ] Pick a provider. Candidates (all have free tiers):
      - **Microsoft Entra External ID** (Azure-native; ~50k MAU free) — best fit if Azure is the goal
      - **Auth0** (25k MAU) — easiest DX
      - **Clerk** (10k MAU) — best drop-in UI
      - **Supabase Auth** (50k MAU; bundles a free Postgres)
- [ ] Replace the `LOCK_PASSWORD` lock screen with provider login; verify the token
      **server-side** in the Worker and derive the user/group from it.
- [ ] Social sign-in: **GitHub / Google are easy** (~20 min each). **Facebook** needs
      Meta Business verification + privacy-policy URL + App Review — budget real time or
      defer. **Apple** only needed if shipping to the iOS App Store (paid dev account).
- [ ] Migrate the existing `admin` / `user` role concept into per-group membership roles.

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
