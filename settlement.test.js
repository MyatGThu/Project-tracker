import { describe, it, expect } from 'vitest';
import settlement from './settlement.js';

const { totalBuyin, computeNet, minimalSettlements, forceBalance } = settlement;

// Sum of nets in a settlement should always move everyone to zero.
const sumNets = arr => arr.reduce((s, p) => s + p.net, 0);

describe('totalBuyin', () => {
  it('sums buy-in amounts', () => {
    expect(totalBuyin([{ amount: 20 }, { amount: 30 }, { amount: 50 }])).toBe(100);
  });
  it('handles empty / null', () => {
    expect(totalBuyin([])).toBe(0);
    expect(totalBuyin(null)).toBe(0);
    expect(totalBuyin(undefined)).toBe(0);
  });
  it('coerces string amounts', () => {
    expect(totalBuyin([{ amount: '20' }, { amount: '5' }])).toBe(25);
  });
});

describe('computeNet', () => {
  it('is final chips minus total buy-in', () => {
    expect(computeNet(150, [{ amount: 100 }])).toBe(50);
    expect(computeNet(60, [{ amount: 100 }])).toBe(-40);
  });
  it('treats null final chips as 0 (busted)', () => {
    expect(computeNet(null, [{ amount: 40 }])).toBe(-40);
  });
  it('rounds to 2 decimal places', () => {
    expect(computeNet(33.333, [{ amount: 0 }])).toBe(33.33);
  });
});

describe('minimalSettlements', () => {
  it('settles a simple two-player game', () => {
    const txns = minimalSettlements([{ name: 'A', net: 50 }, { name: 'B', net: -50 }]);
    expect(txns).toEqual([{ from: 'B', to: 'A', amount: 50 }]);
  });

  it('one loser pays two winners', () => {
    const txns = minimalSettlements([
      { name: 'A', net: 30 }, { name: 'B', net: 20 }, { name: 'C', net: -50 },
    ]);
    expect(txns).toEqual([
      { from: 'C', to: 'A', amount: 30 },
      { from: 'C', to: 'B', amount: 20 },
    ]);
  });

  it('returns no transactions when everyone is square', () => {
    expect(minimalSettlements([{ name: 'A', net: 0 }, { name: 'B', net: 0 }])).toEqual([]);
  });

  it('every debt is covered and no money is invented (balanced table)', () => {
    const balances = [
      { name: 'A', net: 120 }, { name: 'B', net: -30 },
      { name: 'C', net: -45 }, { name: 'D', net: -45 },
    ];
    const txns = minimalSettlements(balances);
    const totalMoved = txns.reduce((s, t) => s + t.amount, 0);
    expect(totalMoved).toBe(120);                 // winners are made whole
    expect(txns.every(t => t.amount > 0)).toBe(true);
  });

  it('ignores sub-cent dust', () => {
    const txns = minimalSettlements([{ name: 'A', net: 0.005 }, { name: 'B', net: -0.005 }]);
    expect(txns).toEqual([]);
  });
});

describe('forceBalance', () => {
  it('returns null when the table already balances', () => {
    expect(forceBalance([{ id: '1', net: 50 }, { id: '2', net: -50 }])).toBe(null);
  });

  it('chips missing (D<0): reduces losers proportionally, winners untouched, table zeroes out', () => {
    // winner +30, losers -40/-20 → sum -30 (chips missing)
    const res = forceBalance([
      { id: 'w', net: 30 }, { id: 'l1', net: -40 }, { id: 'l2', net: -20 },
    ]);
    expect(res.discrepancy).toBe(-30);
    expect(res.adjusted.get('w')).toBe(30);                   // winner unchanged
    // losses reduced proportionally (40:20 split of the 30 shortfall)
    expect(res.adjusted.get('l1')).toBeCloseTo(-20, 2);
    expect(res.adjusted.get('l2')).toBeCloseTo(-10, 2);
    const total = [...res.adjusted.values()].reduce((s, n) => s + n, 0);
    expect(Math.abs(total)).toBeLessThan(0.05);               // now balances
  });

  it('extra chips (D>0): reduces winners proportionally, losers untouched', () => {
    // winners +60/+40, loser -80 → sum +20 extra
    const res = forceBalance([
      { id: 'w1', net: 60 }, { id: 'w2', net: 40 }, { id: 'l', net: -80 },
    ]);
    expect(res.discrepancy).toBe(20);
    expect(res.adjusted.get('l')).toBe(-80);                  // loser unchanged
    expect(res.adjusted.get('w1')).toBeCloseTo(48, 2);        // 60 - (60/100)*20
    expect(res.adjusted.get('w2')).toBeCloseTo(32, 2);        // 40 - (40/100)*20
    const total = [...res.adjusted.values()].reduce((s, n) => s + n, 0);
    expect(Math.abs(total)).toBeLessThan(0.05);
  });

  // A positive net sum guarantees a winner and a negative sum guarantees a
  // loser, so the no-winners/no-losers guards are unreachable in practice —
  // these cases just zero everyone out.
  it('an all-winners table (surplus) reduces everyone to zero', () => {
    const res = forceBalance([{ id: 'a', net: 50 }, { id: 'b', net: 50 }]);
    expect(res.discrepancy).toBe(100);
    expect(res.adjusted.get('a')).toBe(0);
    expect(res.adjusted.get('b')).toBe(0);
  });

  it('an all-losers table (shortfall) reduces everyone to zero', () => {
    const res = forceBalance([{ id: 'a', net: -50 }, { id: 'b', net: -50 }]);
    expect(res.discrepancy).toBe(-100);
    expect(res.adjusted.get('a')).toBe(0);
    expect(res.adjusted.get('b')).toBe(0);
  });
});
