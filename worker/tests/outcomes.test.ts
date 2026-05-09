import { describe, expect, it, vi } from 'vitest';
import { classifyOutcomeWindow, updatePendingOutcomes, type OutcomeSnapshot, type PredictionOutcomeRecord } from '../src/watch/outcomes';

vi.mock('../src/risk/rugcheck', () => ({
  fetchRugCheckReport: vi.fn(async () => null),
}));

function baseRecord(overrides: Partial<PredictionOutcomeRecord> = {}): PredictionOutcomeRecord {
  const now = 1_000_000;
  return {
    version: 1,
    id: `mint:${now}`,
    mint: 'mint',
    symbol: 'TEST',
    name: 'Test Token',
    caughtAt: now,
    initialAt: now - 900_000,
    initialScore: 80,
    caughtScore: 20,
    tierTransition: 'safe->rug',
    scoreDrop: 60,
    triggerSignals: [],
    baselineLiquidity: null,
    baselineLiquidityUnit: 'unknown',
    rugcheckLiquidityAtCatch: 10_000,
    rugcheckRuggedAtCatch: false,
    riskTierAtCatch: 'rug',
    windows: {
      m15: { status: 'pending', dueAt: now + 900_000, reasons: [] },
      h1: { status: 'pending', dueAt: now + 3_600_000, reasons: [] },
      h24: { status: 'pending', dueAt: now + 86_400_000, reasons: [] },
    },
    summaryStatus: 'pending',
    confirmedAt: null,
    confirmationReasons: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function snapshot(overrides: Partial<OutcomeSnapshot> = {}): OutcomeSnapshot {
  return {
    observedAt: 2_000_000,
    ageMs: 1_000_000,
    rugcheckFetched: true,
    rugcheckRugged: false,
    rugcheckScoreNormalised: 7,
    rugcheckDangerCount: 0,
    rugcheckWarnCount: 1,
    rugcheckLiquidityUsd: 9_000,
    bagsLiquidityUsd: null,
    bagsFdvUsd: null,
    bagsPriceChange24hPct: null,
    dbcSol: null,
    ...overrides,
  };
}

describe('classifyOutcomeWindow', () => {
  it('confirms when RugCheck later marks the token rugged', () => {
    const result = classifyOutcomeWindow(baseRecord(), snapshot({ rugcheckRugged: true }));
    expect(result.status).toBe('confirmed');
    expect(result.reasons[0]).toContain('RugCheck');
  });

  it('confirms when external market liquidity collapses at least 80%', () => {
    const result = classifyOutcomeWindow(baseRecord(), snapshot({ rugcheckLiquidityUsd: 1_500 }));
    expect(result.status).toBe('confirmed');
    expect(result.reasons[0]).toContain('liquidity dropped');
  });

  it('confirms DBC pool drain against SOL baseline', () => {
    const result = classifyOutcomeWindow(
      baseRecord({ baselineLiquidity: 6, baselineLiquidityUnit: 'sol', rugcheckLiquidityAtCatch: null }),
      snapshot({ rugcheckFetched: false, rugcheckLiquidityUsd: null, dbcSol: 1 }),
    );
    expect(result.status).toBe('confirmed');
    expect(result.reasons[0]).toContain('DBC WSOL vault');
  });

  it('does not call backfilled records false positives without comparable baseline', () => {
    const result = classifyOutcomeWindow(
      baseRecord({ baselineLiquidity: null, baselineLiquidityUnit: 'unknown', rugcheckLiquidityAtCatch: null }),
      snapshot({ rugcheckRugged: false, rugcheckLiquidityUsd: 9_000 }),
    );
    expect(result.status).toBe('inconclusive');
  });
});

describe('updatePendingOutcomes', () => {
  it('continues evaluating pending windows after a record is already confirmed', async () => {
    const caughtAt = 1_000_000;
    const record = baseRecord({
      id: `mint:${caughtAt}`,
      caughtAt,
      baselineLiquidity: 10,
      baselineLiquidityUnit: 'sol',
      rugcheckLiquidityAtCatch: null,
      summaryStatus: 'confirmed',
      confirmedAt: caughtAt + 900_000,
      confirmationReasons: ['DBC WSOL vault liquidity collapsed 90% from baseline.'],
      windows: {
        m15: {
          status: 'confirmed',
          dueAt: caughtAt + 900_000,
          checkedAt: caughtAt + 900_000,
          reasons: ['DBC WSOL vault liquidity collapsed 90% from baseline.'],
        },
        h1: { status: 'pending', dueAt: caughtAt + 3_600_000, reasons: [] },
        h24: { status: 'pending', dueAt: caughtAt + 86_400_000, reasons: [] },
      },
    });
    const store = new Map<string, string>([
      ['watch:outcomes:index', JSON.stringify([record.id])],
      [`watch:outcome:${record.mint}:${record.caughtAt}`, JSON.stringify(record)],
      [`dbc:bal:${record.mint}`, JSON.stringify({ sol: 1, ts: caughtAt + 86_400_000 })],
    ]);
    const kv = {
      get: vi.fn(async (key: string, type?: string) => {
        const value = store.get(key) ?? null;
        return type === 'json' && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };

    vi.spyOn(Date, 'now').mockReturnValue(caughtAt + 86_400_000 + 1);
    try {
      const updated = await updatePendingOutcomes({ SENTINEL_KV: kv as any });
      const saved = JSON.parse(store.get(`watch:outcome:${record.mint}:${record.caughtAt}`) ?? '{}') as PredictionOutcomeRecord;

      expect(updated).toBe(1);
      expect(saved.summaryStatus).toBe('confirmed');
      expect(saved.windows.h1.status).toBe('confirmed');
      expect(saved.windows.h24.status).toBe('confirmed');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
