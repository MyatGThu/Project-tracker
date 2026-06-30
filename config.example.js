// ─────────────────────────────────────────────────────────────
// Copy this file to config.js and fill in your own values.
// config.js is gitignored and is never committed.
// ─────────────────────────────────────────────────────────────

// Base URL of your deployed Cloudflare Worker API (note the /api suffix).
// You get this URL after running `npm run deploy` in the worker/ folder.
const API_BASE = 'https://YOUR-WORKER-NAME.workers.dev/api';

// Currency symbol shown throughout the app, e.g. '$', '£', '€', 'A$', 'NZ$'.
const CURRENCY = '$';

// Starter roster shown in the player picker. Edit to your own group,
// or leave as-is — players can also be added from inside the app.
const DEFAULT_ROSTER = ['Alex', 'Sam', 'Jordan', 'Casey', 'Taylor', 'Morgan'];

// Optional fun touch: float a decoration above leaderboard podium ranks 2 & 3.
//   { icon: 'jester' } → built-in jester hat (safe to ship)
//   { img: 'your.png' } → your own image placed in the project root
// Set to {} to disable. Do NOT bundle trademarked logos (club badges, etc.).
const RANK_BADGES = {
  3: { icon: 'jester' },
};
