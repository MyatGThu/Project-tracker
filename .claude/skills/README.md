# Project skills

Project-local Claude Code skills, vendored into the repo so they're available
to any session working on this codebase. Each lives in `<name>/SKILL.md` and is
auto-discovered by Claude Code.

| Skill | Source | License | Notes |
|-------|--------|---------|-------|
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | MIT | React/Next.js performance rules. Vendored complete (SKILL.md + `rules/`). |
| `vercel-composition-patterns` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | MIT | React composition patterns. Vendored complete (SKILL.md + `rules/`). |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | see upstream | Frontend design skill (critique / audit / polish, etc.). |

## Important caveats

- **`impeccable` is vendored as markdown guidance only.** Its executable
  detector scripts (`scripts/*.mjs`) and agent configs were intentionally
  **omitted** — they pull/run external code and need a headless browser. The
  `reference/*.md` docs (including `critique.md`, `audit.md`, `polish.md`) are
  present, so the design guidance works; the automated detector steps in
  `SKILL.md` will not.
- **The two Vercel skills are React/Next.js-specific.** This project is a
  vanilla-JS PWA (no framework, no build step) with a Cloudflare Worker backend
  — so most of their rules don't apply here. They're kept as a reference; only
  their framework-agnostic principles (composition, separation of concerns,
  data-fetch parallelism, avoiding boolean-prop sprawl) transfer.

To update or install the official versions properly, use the upstream
instructions (e.g. `npx skills add vercel-labs/agent-skills`).
