// ─── PERSONAL CONFIG — do not include in the buyer package ───
// (config.js is excluded by package-for-sale.ps1; buyers get config.example.js)
const API_BASE = 'https://poker-api.goodgaminggm.workers.dev/api';

// Currency symbol shown throughout the app.
const CURRENCY = '$';

const DEFAULT_ROSTER = [
  'Gerald', 'Sai', 'Hein', 'John',
  'Harry Zhao', 'Tony Shi', 'Aung Gyi', 'George', 'Simon', 'Ruby'
];

// Fun: float a decoration above leaderboard podium ranks 2 & 3.
//   { icon: 'jester' } → built-in jester hat
//   { img: 'file.png' } → your own image placed in the project root
// Trademarked logos (e.g. a club badge) belong here ONLY — config.js is excluded
// from the sale package, so they never ship to buyers.
const RANK_BADGES = {
  2: { img: 'badge-arsenal.svg' },   // your Arsenal badge — vector, crisp at any size (badge-arsenal.svg in project root)
  3: { icon: 'jester' },
};
