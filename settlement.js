/* ─────────────────────────────────────────────────────────────
   settlement.js — pure money math for Poker Tracker.

   No DOM, no globals, no side effects — so it can be unit tested.
   Loaded as a classic <script> before app.js (functions become
   global for the browser) and imported via require() in vitest.
   ───────────────────────────────────────────────────────────── */

function round2(n) { return Math.round(n * 100) / 100; }

// Sum of a player's buy-ins.
function totalBuyin(buyins) {
  return (buyins || []).reduce((sum, b) => sum + Number(b.amount), 0);
}

// A player's raw net = final chips minus total buy-in, to 2 dp.
function computeNet(finalChips, buyins) {
  return round2((finalChips ?? 0) - totalBuyin(buyins));
}

// Greedy minimal-transaction settlement: largest debtor pays largest
// creditor until everyone is square.
// Input:  [{ name, net }]   Output: [{ from, to, amount }]
function minimalSettlements(balances) {
  const creditors = balances.filter(p => p.net > 0).map(p => ({ ...p })).sort((a, b) => b.net - a.net);
  const debtors   = balances.filter(p => p.net < 0).map(p => ({ ...p })).sort((a, b) => a.net - b.net);

  const transactions = [];
  let i = 0, j = 0;

  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(-debtors[i].net, creditors[j].net);
    if (amount > 0.009) {
      transactions.push({ from: debtors[i].name, to: creditors[j].name, amount: round2(amount) });
    }
    debtors[i].net   += amount;
    creditors[j].net -= amount;
    if (Math.abs(debtors[i].net)   < 0.01) i++;
    if (Math.abs(creditors[j].net) < 0.01) j++;
  }

  return transactions;
}

// Spread a chip-count discrepancy proportionally.
//   D < 0 (chips missing)  → reduce losers' losses, winners untouched
//   D > 0 (extra chips)    → reduce winners' gains,  losers untouched
// Input:  [{ id, net }]
// Output: { adjusted: Map<id, net>, discrepancy }  — normal case
//         { error: 'no-losers' | 'no-winners' }    — can't spread
//         null                                      — already balanced
function forceBalance(rawNets) {
  const D = round2(rawNets.reduce((sum, p) => sum + p.net, 0));
  if (Math.abs(D) < 0.01) return null;

  const adjusted = new Map();

  if (D < 0) {
    const totalLoss = rawNets.filter(p => p.net < 0).reduce((s, p) => s + Math.abs(p.net), 0);
    if (totalLoss === 0) return { error: 'no-losers' };
    rawNets.forEach(p => {
      adjusted.set(p.id, p.net < 0 ? round2(p.net + (Math.abs(p.net) / totalLoss) * Math.abs(D)) : p.net);
    });
  } else {
    const totalWin = rawNets.filter(p => p.net > 0).reduce((s, p) => s + p.net, 0);
    if (totalWin === 0) return { error: 'no-winners' };
    rawNets.forEach(p => {
      adjusted.set(p.id, p.net > 0 ? round2(p.net - (p.net / totalWin) * D) : p.net);
    });
  }

  return { adjusted, discrepancy: D };
}

// Export for tests (Node/vitest). Skipped in the browser where `module`
// is undefined, so the functions above stay as plain globals.
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = { round2, totalBuyin, computeNet, minimalSettlements, forceBalance };
}
