import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchTopTokens = vi.fn();
const mockFetchRecentLaunches = vi.fn();
const mockComputeRiskScore = vi.fn();
const mockFetchRugCheckReport = vi.fn();
const mockFetchBirdeyeOverview = vi.fn();
const mockComputeAgentPolicy = vi.fn();
const mockRecordCatchEvidence = vi.fn();
const mockBackfillMissingCatchEvidence = vi.fn();

vi.mock('../src/feed/bags', () => ({
  fetchTopTokens: (...args: unknown[]) => mockFetchTopTokens(...args),
  fetchRecentLaunches: (...args: unknown[]) => mockFetchRecentLaunches(...args),
}));

vi.mock('../src/risk/engine', () => ({
  computeRiskScore: (...args: unknown[]) => mockComputeRiskScore(...args),
}));

vi.mock('../src/risk/rugcheck', () => ({
  fetchRugCheckReport: (...args: unknown[]) => mockFetchRugCheckReport(...args),
}));

vi.mock('../src/risk/birdeye', () => ({
  fetchBirdeyeOverview: (...args: unknown[]) => mockFetchBirdeyeOverview(...args),
}));

vi.mock('../src/agent/policy', () => ({
  computeAgentPolicy: (...args: unknown[]) => mockComputeAgentPolicy(...args),
}));

vi.mock('../src/watch/catch-evidence', () => ({
  recordCatchEvidence: (...args: unknown[]) => mockRecordCatchEvidence(...args),
  backfillMissingCatchEvidence: (...args: unknown[]) => mockBackfillMissingCatchEvidence(...args),
}));

import { runAlertScan, getAlertScannerDebug } from '../src/alerts/scanner';
import { runPreRugWatch } from '../src/watch/pre-rug-catcher';
import { runDbcPoolMonitor } from '../src/watch/dbc-pool-monitor';

class MockKV {
  private store = new Map<string, string>();

  async get(key: string, type?: 'json'): Promise<any> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    if (type === 'json') {
      return JSON.parse(raw);
    }
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function baseRisk(score: number, tier: 'safe' | 'caution' | 'danger' | 'rug') {
  return {
    mint: 'm',
    score,
    tier,
    breakdown: {
      honeypot: 50,
      lpLocked: 50,
      mintAuthority: 100,
      freezeAuthority: 100,
      topHolderPct: 50,
      liquidityDepth: 50,
      volumeHealth: 50,
      creatorReputation: 50,
    },
    timestamp: Date.now(),
    cached: false,
    dataConfidence: 1,
    missingSignals: [],
  };
}

describe('detection hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordCatchEvidence.mockResolvedValue(undefined);
    mockBackfillMissingCatchEvidence.mockResolvedValue(undefined);
  });

  describe('runAlertScan false-positive controls', () => {
    it('suppresses lp_drain alerts when source-health outage is detected', async () => {
      const kv = new MockKV();
      const env = {
        SENTINEL_KV: kv as unknown as KVNamespace,
        BAGS_API_KEY: 'x',
        BIRDEYE_API_KEY: 'x',
      } as any;

      const tokens = [
        { mint: 'A', symbol: 'A', name: 'Token A' },
        { mint: 'B', symbol: 'B', name: 'Token B' },
        { mint: 'C', symbol: 'C', name: 'Token C' },
      ];

      mockFetchTopTokens.mockResolvedValue(tokens);
      mockComputeRiskScore.mockImplementation(async (mint: string) => ({ ...baseRisk(50, 'caution'), mint }));
      mockFetchBirdeyeOverview.mockResolvedValue({ liquidity: 800 });

      mockFetchRugCheckReport.mockImplementation(async (mint: string) => {
        if (mint === 'A') {
          return {
            totalMarketLiquidity: 1000,
            markets: [],
            creator: null,
          };
        }
        return null;
      });

      await kv.put('score:prev:A', JSON.stringify({
        score: 50,
        tier: 'caution',
        lpLocked: 50,
        topHolderPct: 50,
        mintAuthority: 100,
        liquidityUsd: 10000,
        lpDrainConfirmCount: 1,
        timestamp: Date.now() - 60_000,
      }));
      await kv.put('score:prev:B', JSON.stringify({
        score: 50,
        tier: 'caution',
        lpLocked: 50,
        topHolderPct: 50,
        mintAuthority: 100,
        liquidityUsd: 8000,
        lpDrainConfirmCount: 0,
        timestamp: Date.now() - 60_000,
      }));
      await kv.put('score:prev:C', JSON.stringify({
        score: 50,
        tier: 'caution',
        lpLocked: 50,
        topHolderPct: 50,
        mintAuthority: 100,
        liquidityUsd: 7000,
        lpDrainConfirmCount: 0,
        timestamp: Date.now() - 60_000,
      }));

      const alerts = await runAlertScan(env);
      expect(alerts.filter((a) => a.type === 'lp_drain')).toHaveLength(0);

      const debug = await getAlertScannerDebug(kv as unknown as KVNamespace);
      expect(debug.quality?.suppressedLpDrainOutage).toBeGreaterThanOrEqual(1);
    });
  });

  describe('runPreRugWatch anti-noise guards', () => {
    it('does not catch when baseline is newer than min lead time', async () => {
      const kv = new MockKV();
      const env = {
        SENTINEL_KV: kv as unknown as KVNamespace,
        BAGS_API_KEY: 'x',
      } as any;

      const now = 1_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockFetchTopTokens.mockResolvedValue([{ mint: 'M1', symbol: 'M1', name: 'Mint One' }]);
      mockFetchRecentLaunches.mockResolvedValue([]);
      mockBackfillMissingCatchEvidence.mockResolvedValue(undefined);
      mockComputeAgentPolicy.mockResolvedValue({ action: 'telegram_alert', confidence: 0.9, reasons: ['x'] });

      await kv.put('risk:M1', JSON.stringify({
        ...baseRisk(20, 'danger'),
        mint: 'M1',
      }));

      // Only 5 minutes old -> should be ignored by MIN_LEAD_TIME_MS (10 min)
      await kv.put('watch:snap:M1', JSON.stringify({
        mint: 'M1',
        symbol: 'M1',
        name: 'Mint One',
        score: 80,
        tier: 'safe',
        ts: now - 5 * 60 * 1000,
      }));

      const count = await runPreRugWatch(env);
      expect(count).toBe(0);
      expect(await kv.get('watch:catch:M1')).toBeNull();
    });

    it('records catch when score drop passes threshold and baseline is old enough', async () => {
      const kv = new MockKV();
      const env = {
        SENTINEL_KV: kv as unknown as KVNamespace,
        BAGS_API_KEY: 'x',
      } as any;

      const now = 2_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      mockFetchTopTokens.mockResolvedValue([{ mint: 'M2', symbol: 'M2', name: 'Mint Two' }]);
      mockFetchRecentLaunches.mockResolvedValue([]);
      mockBackfillMissingCatchEvidence.mockResolvedValue(undefined);
      mockComputeAgentPolicy.mockResolvedValue({ action: 'telegram_alert', confidence: 0.95, reasons: ['drop'] });

      await kv.put('risk:M2', JSON.stringify({
        ...baseRisk(40, 'danger'),
        mint: 'M2',
      }));

      await kv.put('watch:snap:M2', JSON.stringify({
        mint: 'M2',
        symbol: 'M2',
        name: 'Mint Two',
        score: 80,
        tier: 'safe',
        ts: now - 11 * 60 * 1000,
      }));

      const count = await runPreRugWatch(env);
      expect(count).toBe(1);
      const savedCatch = await kv.get('watch:catch:M2', 'json');
      expect(savedCatch).not.toBeNull();
      expect(savedCatch.scoreDrop).toBe(40);
      expect(savedCatch.reason).toBe('score_drop');
    });
  });

  describe('runDbcPoolMonitor drain thresholds', () => {
    it('does not catch when drain is below threshold', async () => {
      const kv = new MockKV();
      const env = {
        SENTINEL_KV: kv as unknown as KVNamespace,
      } as any;

      const now = 3_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await kv.put('dbc:vault:D1', 'VaultD1');
      await kv.put('dbc:bal:D1', JSON.stringify({
        mint: 'D1',
        symbol: 'D1',
        name: 'Drain One',
        dbcPoolKey: 'PoolD1',
        vault: 'VaultD1',
        lamports: 10_002_039_280,
        sol: 10,
        ts: now - 11 * 60 * 1000,
      }));

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: {
            value: [{ lamports: 4_002_039_280, data: ['', 'base64'] }],
          },
        }),
      })) as any);

      const count = await runDbcPoolMonitor(env, [{
        mint: 'D1',
        symbol: 'D1',
        name: 'Drain One',
        dbcPoolKey: 'PoolD1',
        accountKeys: ['VaultD1'],
      }] as any);

      expect(count).toBe(0);
      expect(await kv.get('watch:catch:D1')).toBeNull();
    });

    it('records catch when drain is above threshold and baseline is valid', async () => {
      const kv = new MockKV();
      const env = {
        SENTINEL_KV: kv as unknown as KVNamespace,
      } as any;

      const now = 4_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await kv.put('dbc:vault:D2', 'VaultD2');
      await kv.put('dbc:bal:D2', JSON.stringify({
        mint: 'D2',
        symbol: 'D2',
        name: 'Drain Two',
        dbcPoolKey: 'PoolD2',
        vault: 'VaultD2',
        lamports: 10_002_039_280,
        sol: 10,
        ts: now - 11 * 60 * 1000,
      }));

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: {
            value: [{ lamports: 2_002_039_280, data: ['', 'base64'] }],
          },
        }),
      })) as any);

      const count = await runDbcPoolMonitor(env, [{
        mint: 'D2',
        symbol: 'D2',
        name: 'Drain Two',
        dbcPoolKey: 'PoolD2',
        accountKeys: ['VaultD2'],
      }] as any);

      expect(count).toBe(1);
      const savedCatch = await kv.get('watch:catch:D2', 'json');
      expect(savedCatch).not.toBeNull();
      expect(savedCatch.reason).toBe('tier_crash');
      expect(savedCatch.triggerSignals[0]).toContain('liquidity drained');
    });
  });
});
