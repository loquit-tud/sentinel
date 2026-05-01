import { describe, it, expect } from 'vitest';
import { analyzeRugCheck } from '../src/risk/rugcheck';
import { analyzeBirdeye } from '../src/risk/birdeye';
import { analyzeHeliusHolders } from '../src/risk/helius';
import type { RugCheckReport } from '../src/risk/types';

// ── analyzeRugCheck ─────────────────────────────────────

describe('analyzeRugCheck', () => {
  const baseReport: RugCheckReport = {
    mint: 'TestMint111111111111111111111111111111111111',
    creator: null,
    creatorBalance: 0,
    mintAuthority: null,
    freezeAuthority: null,
    token: null,
    tokenMeta: null,
    topHolders: [],
    risks: [],
    score: 0,
    score_normalised: 80,
    markets: [],
    totalMarketLiquidity: 0,
    totalLPProviders: 0,
    rugged: false,
  };

  it('scores 100 for revoked mint/freeze authority', () => {
    const r = analyzeRugCheck(baseReport);
    expect(r.mintAuthority).toBe(100);
    expect(r.freezeAuthority).toBe(100);
  });

  it('scores 0 for active mint authority', () => {
    const r = analyzeRugCheck({ ...baseReport, mintAuthority: 'SomeAuthority111' });
    expect(r.mintAuthority).toBe(0);
  });

  it('scores 0 for active freeze authority', () => {
    const r = analyzeRugCheck({ ...baseReport, freezeAuthority: 'SomeFreezer111' });
    expect(r.freezeAuthority).toBe(0);
  });

  it('extracts LP locked pct from markets', () => {
    const report: RugCheckReport = {
      ...baseReport,
      markets: [
        { pubkey: 'a', marketType: 'raydium', mintA: '', mintB: '', mintLP: '', lp: { lpLockedPct: 85, lpLocked: 85, lpUnlocked: 15, lpLockedUSD: 50000, quoteUSD: 1000, baseUSD: 1000 } },
        { pubkey: 'b', marketType: 'orca', mintA: '', mintB: '', mintLP: '', lp: { lpLockedPct: 40, lpLocked: 40, lpUnlocked: 60, lpLockedUSD: 5000, quoteUSD: 500, baseUSD: 500 } },
      ],
    };
    const r = analyzeRugCheck(report);
    expect(r.lpLocked).toBe(85); // max across markets
  });

  it('caps LP locked at 100', () => {
    const report: RugCheckReport = {
      ...baseReport,
      markets: [
        { pubkey: 'a', marketType: 'orca', mintA: '', mintB: '', mintLP: '', lp: { lpLockedPct: 200, lpLocked: 200, lpUnlocked: 0, lpLockedUSD: 100000, quoteUSD: 1000, baseUSD: 1000 } },
      ],
    };
    const r = analyzeRugCheck(report);
    expect(r.lpLocked).toBe(100);
  });

  it('penalizes danger risks in honeypot score', () => {
    const report: RugCheckReport = {
      ...baseReport,
      risks: [
        { name: 'Honeypot detected', value: '', description: '', score: 100, level: 'danger' },
        { name: 'Suspicious transfer', value: '', description: '', score: 50, level: 'danger' },
      ],
    };
    const r = analyzeRugCheck(report);
    expect(r.honeypot).toBe(40); // 100 - 2*30
  });

  it('penalizes warn risks less than danger', () => {
    const report: RugCheckReport = {
      ...baseReport,
      risks: [
        { name: 'Mutable metadata', value: '', description: '', score: 10, level: 'warn' },
      ],
    };
    const r = analyzeRugCheck(report);
    expect(r.honeypot).toBe(90); // 100 - 1*10
  });

  it('clamps honeypot score to 0', () => {
    const report: RugCheckReport = {
      ...baseReport,
      risks: [
        { name: 'a', value: '', description: '', score: 100, level: 'danger' },
        { name: 'b', value: '', description: '', score: 100, level: 'danger' },
        { name: 'c', value: '', description: '', score: 100, level: 'danger' },
        { name: 'd', value: '', description: '', score: 100, level: 'danger' },
      ],
    };
    const r = analyzeRugCheck(report);
    expect(r.honeypot).toBe(0); // 100 - 4*30 = -20 → clamped to 0
  });

  it('sets ruggedFlag from report', () => {
    const r = analyzeRugCheck({ ...baseReport, rugged: true });
    expect(r.ruggedFlag).toBe(true);
    expect(r.creatorReputation).toBe(0);
  });

  it('computes top holder distribution score', () => {
    const report: RugCheckReport = {
      ...baseReport,
      topHolders: [
        { address: 'a', amount: 100, pct: 20, uiAmount: 100, owner: 'o1', insider: false },
        { address: 'b', amount: 80, pct: 15, uiAmount: 80, owner: 'o2', insider: false },
        { address: 'c', amount: 60, pct: 10, uiAmount: 60, owner: 'o3', insider: false },
      ],
    };
    const r = analyzeRugCheck(report);
    // top5Pct = 20 + 15 + 10 = 45, topHolderPct = 100 - 45 = 55
    expect(r.topHolderPct).toBe(55);
  });
});

// ── analyzeBirdeye ──────────────────────────────────────

describe('analyzeBirdeye', () => {
  it('returns neutral when both null', () => {
    const r = analyzeBirdeye(null, null);
    // Missing Birdeye data is imputed conservatively (not confirmed zero)
    expect(r.liquidityDepth).toBe(45);
    expect(r.volumeHealth).toBe(45);
  });

  it('normalizes liquidity to 100 at $100K', () => {
    const r = analyzeBirdeye(null, {
      address: 'x', symbol: 'X', name: 'X', decimals: 9,
      liquidity: 100_000, v24hUSD: 0, v24hChangePercent: 0,
      price: 1, priceChange24hPercent: 0, mc: 0, fdv: 0,
      trade24h: 0, uniqueWallet24h: 0, holder: 0,
    });
    expect(r.liquidityDepth).toBe(100);
  });

  it('caps liquidity at 100 for > $100K', () => {
    const r = analyzeBirdeye(null, {
      address: 'x', symbol: 'X', name: 'X', decimals: 9,
      liquidity: 500_000, v24hUSD: 0, v24hChangePercent: 0,
      price: 1, priceChange24hPercent: 0, mc: 0, fdv: 0,
      trade24h: 0, uniqueWallet24h: 0, holder: 0,
    });
    expect(r.liquidityDepth).toBe(100);
  });

  it('normalizes volume to 100 at $10K', () => {
    const r = analyzeBirdeye(null, {
      address: 'x', symbol: 'X', name: 'X', decimals: 9,
      liquidity: 0, v24hUSD: 10_000, v24hChangePercent: 0,
      price: 1, priceChange24hPercent: 0, mc: 0, fdv: 0,
      trade24h: 0, uniqueWallet24h: 0, holder: 0,
    });
    expect(r.volumeHealth).toBe(100);
  });
});

// ── analyzeHeliusHolders ────────────────────────────────

describe('analyzeHeliusHolders', () => {
  it('returns 50 (neutral) for empty holders', () => {
    const r = analyzeHeliusHolders([]);
    expect(r.topHolderConcentration).toBe(50);
  });

  it('gives high score for distributed holders', () => {
    const holders = Array.from({ length: 10 }, (_, i) => ({
      address: `addr${i}`, amount: 100, decimals: 9, owner: `own${i}`,
    }));
    const r = analyzeHeliusHolders(holders);
    // top5 = 500/1000 = 50%, score = 100-50 = 50
    expect(r.topHolderConcentration).toBe(50);
  });

  it('gives low score for whale-heavy holders', () => {
    const holders = [
      { address: 'whale', amount: 900, decimals: 9, owner: 'w' },
      { address: 'small1', amount: 25, decimals: 9, owner: 's1' },
      { address: 'small2', amount: 25, decimals: 9, owner: 's2' },
      { address: 'small3', amount: 25, decimals: 9, owner: 's3' },
      { address: 'small4', amount: 25, decimals: 9, owner: 's4' },
    ];
    const r = analyzeHeliusHolders(holders);
    // top5 = 1000/1000 = 100%, score = 100-100 = 0
    expect(r.topHolderConcentration).toBe(0);
  });
});
