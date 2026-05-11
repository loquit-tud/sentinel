import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunAlertScan = vi.fn();
const mockBroadcastAlert = vi.fn();
const mockBuildLpDrainMessage = vi.fn(() => 'lp-message');
const mockNotifySubscribersOfAlert = vi.fn();
const mockRunPreRugWatch = vi.fn();
const mockRunDbcPoolMonitor = vi.fn();
const mockFetchTopTokens = vi.fn();
const mockFetchRecentLaunches = vi.fn();
const mockComputeRiskScore = vi.fn();
const mockUpdatePendingOutcomes = vi.fn();
const mockBackfillOutcomeSeeds = vi.fn();

vi.mock('../src/alerts/scanner', () => ({
  runAlertScan: (...args: unknown[]) => mockRunAlertScan(...args),
  getAlertFeed: vi.fn(),
  getAlertScannerDebug: vi.fn(),
}));

vi.mock('../src/notify/telegram', () => ({
  sendTelegramMessage: vi.fn(),
  resolveTelegramChatId: vi.fn(),
  broadcastAlert: (...args: unknown[]) => mockBroadcastAlert(...args),
  buildLpDrainMessage: (...args: unknown[]) => mockBuildLpDrainMessage(...args),
}));

vi.mock('../src/notify/alert-subscriptions', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  notifySubscribersOfCatch: vi.fn(),
  getSubscriberCount: vi.fn(),
  getSubscription: vi.fn(),
  notifySubscribersOfAlert: (...args: unknown[]) => mockNotifySubscribersOfAlert(...args),
}));

vi.mock('../src/watch/pre-rug-catcher', () => ({
  runPreRugWatch: (...args: unknown[]) => mockRunPreRugWatch(...args),
  getRecentCatches: vi.fn(async () => []),
  getWatchStats: vi.fn(),
  getTokenMemory: vi.fn(),
}));

vi.mock('../src/watch/dbc-pool-monitor', () => ({
  runDbcPoolMonitor: (...args: unknown[]) => mockRunDbcPoolMonitor(...args),
  getDbcSnapshot: vi.fn(),
}));

vi.mock('../src/watch/outcomes', () => ({
  backfillOutcomeSeeds: (...args: unknown[]) => mockBackfillOutcomeSeeds(...args),
  getAccuracyReport: vi.fn(),
  updatePendingOutcomes: (...args: unknown[]) => mockUpdatePendingOutcomes(...args),
}));

vi.mock('../src/feed/bags', () => ({
  fetchTopTokens: (...args: unknown[]) => mockFetchTopTokens(...args),
  fetchRecentLaunches: (...args: unknown[]) => mockFetchRecentLaunches(...args),
}));

vi.mock('../src/risk/engine', () => ({
  computeRiskScore: (...args: unknown[]) => mockComputeRiskScore(...args),
}));

import worker from '../src/index';
import { MockKV } from './mocks';

function makeCriticalDrainAlert(id: string) {
  return {
    id,
    mint: `${id}Mint`,
    tokenName: `${id} Token`,
    tokenSymbol: id,
    type: 'lp_drain',
    severity: 'critical',
    title: 'LP drain detected',
    description: 'drain',
    previousScore: 60,
    currentScore: 10,
    previousTier: 'caution',
    currentTier: 'rug',
    timestamp: Date.now(),
    liquidityDropPct: 80,
    prevLiquidityUsd: 10000,
    liquidityUsd: 2000,
    confirmed: true,
  };
}

async function runScheduled(env: any): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as ExecutionContext;

  await worker.scheduled({} as ScheduledController, env, ctx);
  await Promise.allSettled(pending);
}

describe('scheduled cron alert orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunPreRugWatch.mockResolvedValue(0);
    mockRunDbcPoolMonitor.mockResolvedValue(0);
    mockFetchTopTokens.mockResolvedValue([]);
    mockFetchRecentLaunches.mockResolvedValue([]);
    mockUpdatePendingOutcomes.mockResolvedValue(0);
    mockBackfillOutcomeSeeds.mockResolvedValue(undefined);
    mockNotifySubscribersOfAlert.mockResolvedValue(undefined);
    mockBroadcastAlert.mockResolvedValue(undefined);
  });

  it('suppresses channel broadcast when mass-drain guard triggers (>=3 critical drains)', async () => {
    mockRunAlertScan.mockResolvedValue([
      makeCriticalDrainAlert('A'),
      makeCriticalDrainAlert('B'),
      makeCriticalDrainAlert('C'),
    ]);

    const env = {
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_ALERT_CHANNEL_ID: '-100123',
      SENTINEL_KV: new MockKV() as unknown as KVNamespace,
      BAGS_API_KEY: 'bags',
    } as any;

    await runScheduled(env);

    expect(mockBroadcastAlert).not.toHaveBeenCalled();
    expect(mockBuildLpDrainMessage).not.toHaveBeenCalled();
    expect(mockNotifySubscribersOfAlert).toHaveBeenCalledTimes(3);
  });

  it('broadcasts critical drains when below mass-drain threshold', async () => {
    mockRunAlertScan.mockResolvedValue([
      makeCriticalDrainAlert('A'),
      makeCriticalDrainAlert('B'),
    ]);

    const env = {
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_ALERT_CHANNEL_ID: '-100123',
      SENTINEL_KV: new MockKV() as unknown as KVNamespace,
      BAGS_API_KEY: 'bags',
    } as any;

    await runScheduled(env);

    expect(mockBuildLpDrainMessage).toHaveBeenCalledTimes(2);
    expect(mockBroadcastAlert).toHaveBeenCalledTimes(2);
    expect(mockNotifySubscribersOfAlert).toHaveBeenCalledTimes(2);
  });
});
