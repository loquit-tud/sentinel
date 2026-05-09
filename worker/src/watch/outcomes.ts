import type { RiskScore, RiskTier, TokenFeedItem } from '../../../shared/types';
import type { RugCheckReport } from '../risk/types';
import { fetchRugCheckReport } from '../risk/rugcheck';
import type { PreRugCatch, WatchSnapshot } from './pre-rug-catcher';

const OUTCOME_INDEX_KEY = 'watch:outcomes:index';
const OUTCOME_TTL = 30 * 24 * 60 * 60;
const MAX_OUTCOMES = 250;

const WINDOWS = [
  { key: 'm15', label: '15m', delayMs: 15 * 60 * 1000 },
  { key: 'h1', label: '1h', delayMs: 60 * 60 * 1000 },
  { key: 'h24', label: '24h', delayMs: 24 * 60 * 60 * 1000 },
] as const;

export type OutcomeWindowKey = typeof WINDOWS[number]['key'];
export type OutcomeStatus = 'pending' | 'confirmed' | 'false_positive' | 'inconclusive';

export interface OutcomeSnapshot {
  observedAt: number;
  ageMs: number;
  rugcheckFetched: boolean;
  rugcheckRugged: boolean | null;
  rugcheckScoreNormalised: number | null;
  rugcheckDangerCount: number | null;
  rugcheckWarnCount: number | null;
  rugcheckLiquidityUsd: number | null;
  bagsLiquidityUsd: number | null;
  bagsFdvUsd: number | null;
  bagsPriceChange24hPct: number | null;
  dbcSol: number | null;
}

export interface OutcomeWindowResult {
  status: OutcomeStatus;
  dueAt: number;
  checkedAt?: number;
  snapshot?: OutcomeSnapshot;
  reasons: string[];
}

export interface PredictionOutcomeRecord {
  version: 1;
  id: string;
  mint: string;
  symbol: string;
  name: string;
  caughtAt: number;
  initialAt: number;
  initialScore: number;
  caughtScore: number;
  tierTransition: string;
  scoreDrop: number;
  triggerSignals: string[];
  baselineLiquidity: number | null;
  baselineLiquidityUnit: 'usd' | 'sol' | 'unknown';
  rugcheckLiquidityAtCatch: number | null;
  rugcheckRuggedAtCatch: boolean | null;
  riskTierAtCatch: RiskTier;
  windows: Record<OutcomeWindowKey, OutcomeWindowResult>;
  summaryStatus: OutcomeStatus;
  confirmedAt: number | null;
  confirmationReasons: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AccuracyMetrics {
  total: number;
  confirmed: number;
  falsePositive: number;
  pending: number;
  inconclusive: number;
  evaluated: number;
  precision: number | null;
  medianLeadTimeMs: number | null;
  lastUpdatedAt: number | null;
}

export interface AccuracyReport {
  metrics: AccuracyMetrics;
  records: PredictionOutcomeRecord[];
  windows: Array<{ key: OutcomeWindowKey; label: string; delayMs: number }>;
}

interface DbcBalanceSnapshot {
  sol: number;
  ts: number;
}

export interface OutcomeEnv {
  SENTINEL_KV?: KVNamespace;
  BAGS_API_KEY?: string;
}

function outcomeKey(mint: string, caughtAt: number): string {
  return `watch:outcome:${mint}:${caughtAt}`;
}

function makeOutcomeId(mint: string, caughtAt: number): string {
  return `${mint}:${caughtAt}`;
}

function inferBaselineUnit(caught: PreRugCatch): 'usd' | 'sol' | 'unknown' {
  return caught.triggerSignals?.some((s) => s.startsWith('SOL balance:') || s.startsWith('WSOL vault:'))
    ? 'sol'
    : 'unknown';
}

function buildPendingWindows(caughtAt: number): Record<OutcomeWindowKey, OutcomeWindowResult> {
  return WINDOWS.reduce((acc, w) => {
    acc[w.key] = {
      status: 'pending',
      dueAt: caughtAt + w.delayMs,
      reasons: [`Waiting for ${w.label} post-alert window.`],
    };
    return acc;
  }, {} as Record<OutcomeWindowKey, OutcomeWindowResult>);
}

async function addOutcomeToIndex(kv: KVNamespace, id: string): Promise<void> {
  const existing = (await kv.get(OUTCOME_INDEX_KEY, 'json')) as string[] | null;
  const next = [id, ...(existing ?? []).filter((x) => x !== id)].slice(0, MAX_OUTCOMES);
  await kv.put(OUTCOME_INDEX_KEY, JSON.stringify(next), { expirationTtl: OUTCOME_TTL });
}

export async function recordPredictionOutcomeSeed(params: {
  kv: KVNamespace;
  caught: PreRugCatch;
  baseline: WatchSnapshot;
  riskAtCatch: RiskScore;
  rugcheckAtCatch?: RugCheckReport | null;
}): Promise<void> {
  const { kv, caught, baseline, riskAtCatch, rugcheckAtCatch } = params;
  const id = makeOutcomeId(caught.mint, caught.caughtAt);
  const existing = await kv.get(outcomeKey(caught.mint, caught.caughtAt), 'json');
  if (existing) {
    await addOutcomeToIndex(kv, id);
    return;
  }

  const now = Date.now();
  const record: PredictionOutcomeRecord = {
    version: 1,
    id,
    mint: caught.mint,
    symbol: caught.symbol,
    name: caught.name,
    caughtAt: caught.caughtAt,
    initialAt: caught.initialAt,
    initialScore: caught.initialScore,
    caughtScore: caught.caughtScore,
    tierTransition: caught.tierTransition,
    scoreDrop: caught.scoreDrop,
    triggerSignals: caught.triggerSignals ?? [],
    baselineLiquidity: typeof baseline.liquidity === 'number' ? baseline.liquidity : null,
    baselineLiquidityUnit: inferBaselineUnit(caught),
    rugcheckLiquidityAtCatch: typeof rugcheckAtCatch?.totalMarketLiquidity === 'number' ? rugcheckAtCatch.totalMarketLiquidity : null,
    rugcheckRuggedAtCatch: typeof rugcheckAtCatch?.rugged === 'boolean' ? rugcheckAtCatch.rugged : null,
    riskTierAtCatch: riskAtCatch.tier,
    windows: buildPendingWindows(caught.caughtAt),
    summaryStatus: 'pending',
    confirmedAt: null,
    confirmationReasons: [],
    createdAt: now,
    updatedAt: now,
  };

  await kv.put(outcomeKey(caught.mint, caught.caughtAt), JSON.stringify(record), { expirationTtl: OUTCOME_TTL });
  await addOutcomeToIndex(kv, id);
}

function countRisks(report: RugCheckReport | null, level: 'danger' | 'warn'): number | null {
  if (!report?.risks) return null;
  return report.risks.filter((r) => r.level === level).length;
}

async function collectOutcomeSnapshot(params: {
  kv: KVNamespace;
  mint: string;
  caughtAt: number;
  token?: TokenFeedItem;
}): Promise<OutcomeSnapshot> {
  const { kv, mint, caughtAt, token } = params;
  const [rugcheck, dbcRaw] = await Promise.all([
    fetchRugCheckReport(mint).catch(() => null),
    kv.get(`dbc:bal:${mint}`, 'json').catch(() => null) as Promise<DbcBalanceSnapshot | null>,
  ]);
  const now = Date.now();
  return {
    observedAt: now,
    ageMs: now - caughtAt,
    rugcheckFetched: rugcheck !== null,
    rugcheckRugged: typeof rugcheck?.rugged === 'boolean' ? rugcheck.rugged : null,
    rugcheckScoreNormalised: typeof rugcheck?.score_normalised === 'number' ? rugcheck.score_normalised : null,
    rugcheckDangerCount: countRisks(rugcheck, 'danger'),
    rugcheckWarnCount: countRisks(rugcheck, 'warn'),
    rugcheckLiquidityUsd: typeof rugcheck?.totalMarketLiquidity === 'number' ? rugcheck.totalMarketLiquidity : null,
    bagsLiquidityUsd: typeof token?.liquidity === 'number' ? token.liquidity : null,
    bagsFdvUsd: typeof token?.fdv === 'number' ? token.fdv : null,
    bagsPriceChange24hPct: typeof token?.priceChangePct24h === 'number' ? token.priceChangePct24h : null,
    dbcSol: typeof dbcRaw?.sol === 'number' ? dbcRaw.sol : null,
  };
}

export function classifyOutcomeWindow(
  record: PredictionOutcomeRecord,
  snapshot: OutcomeSnapshot,
): { status: Exclude<OutcomeStatus, 'pending'>; reasons: string[] } {
  const reasons: string[] = [];

  if (snapshot.rugcheckRugged === true) {
    reasons.push('RugCheck marked the token as rugged after the alert.');
  }

  if (
    record.baselineLiquidityUnit === 'sol' &&
    record.baselineLiquidity != null &&
    record.baselineLiquidity > 0 &&
    snapshot.dbcSol != null
  ) {
    const dropPct = ((record.baselineLiquidity - snapshot.dbcSol) / record.baselineLiquidity) * 100;
    if (dropPct >= 80) {
      reasons.push(`DBC WSOL vault liquidity collapsed ${dropPct.toFixed(0)}% from baseline.`);
    }
  }

  if (
    record.rugcheckLiquidityAtCatch != null &&
    record.rugcheckLiquidityAtCatch > 0 &&
    snapshot.rugcheckLiquidityUsd != null
  ) {
    const dropPct = ((record.rugcheckLiquidityAtCatch - snapshot.rugcheckLiquidityUsd) / record.rugcheckLiquidityAtCatch) * 100;
    if (dropPct >= 80) {
      reasons.push(`RugCheck market liquidity dropped ${dropPct.toFixed(0)}% after the alert.`);
    }
  }

  if (reasons.length > 0) {
    return { status: 'confirmed', reasons };
  }

  const hasComparableOutcomeBaseline =
    (record.rugcheckLiquidityAtCatch != null && record.rugcheckLiquidityAtCatch > 0) ||
    (record.baselineLiquidityUnit === 'sol' && record.baselineLiquidity != null && record.baselineLiquidity > 0);

  if (!hasComparableOutcomeBaseline) {
    return {
      status: 'inconclusive',
      reasons: ['No comparable at-alert external baseline was stored for this window.'],
    };
  }

  const hasUsableExternalData =
    snapshot.rugcheckFetched ||
    snapshot.dbcSol != null ||
    snapshot.bagsLiquidityUsd != null;

  if (!hasUsableExternalData) {
    return {
      status: 'inconclusive',
      reasons: ['No usable external outcome data was available for this window.'],
    };
  }

  return {
    status: 'false_positive',
    reasons: ['No RugCheck rugged flag or >=80% external liquidity collapse observed in this window.'],
  };
}

function summarizeRecord(record: PredictionOutcomeRecord): Pick<PredictionOutcomeRecord, 'summaryStatus' | 'confirmedAt' | 'confirmationReasons'> {
  const windowResults = WINDOWS.map((w) => record.windows[w.key]);
  const confirmed = windowResults.find((w) => w.status === 'confirmed');
  if (confirmed) {
    return {
      summaryStatus: 'confirmed',
      confirmedAt: confirmed.checkedAt ?? null,
      confirmationReasons: confirmed.reasons,
    };
  }
  if (record.windows.h24.status === 'false_positive') {
    return { summaryStatus: 'false_positive', confirmedAt: null, confirmationReasons: [] };
  }
  if (record.windows.h24.status === 'inconclusive') {
    return { summaryStatus: 'inconclusive', confirmedAt: null, confirmationReasons: [] };
  }
  return { summaryStatus: 'pending', confirmedAt: null, confirmationReasons: [] };
}

function parseOutcomeId(id: string): { mint: string; caughtAt: number } | null {
  const idx = id.lastIndexOf(':');
  if (idx <= 0) return null;
  const mint = id.slice(0, idx);
  const caughtAt = Number(id.slice(idx + 1));
  if (!mint || !Number.isFinite(caughtAt)) return null;
  return { mint, caughtAt };
}

export async function updatePendingOutcomes(env: OutcomeEnv, tokens: TokenFeedItem[] = []): Promise<number> {
  const kv = env.SENTINEL_KV;
  if (!kv) return 0;
  const ids = (await kv.get(OUTCOME_INDEX_KEY, 'json')) as string[] | null;
  if (!ids || ids.length === 0) return 0;

  const tokenByMint = new Map(tokens.map((t) => [t.mint, t]));
  let updated = 0;
  const now = Date.now();

  for (const id of ids.slice(0, MAX_OUTCOMES)) {
    const parsed = parseOutcomeId(id);
    if (!parsed) continue;
    const record = (await kv.get(outcomeKey(parsed.mint, parsed.caughtAt), 'json')) as PredictionOutcomeRecord | null;
    if (!record || !WINDOWS.some((w) => record.windows[w.key]?.status === 'pending')) continue;

    let changed = false;
    for (const w of WINDOWS) {
      const current = record.windows[w.key];
      if (!current || current.status !== 'pending' || now < current.dueAt) continue;

      const snapshot = await collectOutcomeSnapshot({
        kv,
        mint: record.mint,
        caughtAt: record.caughtAt,
        token: tokenByMint.get(record.mint),
      });
      const classified = classifyOutcomeWindow(record, snapshot);
      record.windows[w.key] = {
        status: classified.status,
        dueAt: current.dueAt,
        checkedAt: snapshot.observedAt,
        snapshot,
        reasons: classified.reasons,
      };
      changed = true;
    }

    if (changed) {
      const summary = summarizeRecord(record);
      record.summaryStatus = summary.summaryStatus;
      record.confirmedAt = summary.confirmedAt;
      record.confirmationReasons = summary.confirmationReasons;
      record.updatedAt = Date.now();
      await kv.put(outcomeKey(record.mint, record.caughtAt), JSON.stringify(record), { expirationTtl: OUTCOME_TTL });
      updated++;
    }
  }

  return updated;
}

export async function backfillOutcomeSeeds(kv: KVNamespace, catches: PreRugCatch[], max = 20): Promise<number> {
  let written = 0;
  for (const caught of catches) {
    if (written >= max) break;
    const id = makeOutcomeId(caught.mint, caught.caughtAt);
    const existing = await kv.get(outcomeKey(caught.mint, caught.caughtAt), 'json');
    if (existing) {
      await addOutcomeToIndex(kv, id);
      continue;
    }
    const now = Date.now();
    const record: PredictionOutcomeRecord = {
      version: 1,
      id,
      mint: caught.mint,
      symbol: caught.symbol,
      name: caught.name,
      caughtAt: caught.caughtAt,
      initialAt: caught.initialAt,
      initialScore: caught.initialScore,
      caughtScore: caught.caughtScore,
      tierTransition: caught.tierTransition,
      scoreDrop: caught.scoreDrop,
      triggerSignals: caught.triggerSignals ?? [],
      baselineLiquidity: null,
      baselineLiquidityUnit: inferBaselineUnit(caught),
      rugcheckLiquidityAtCatch: null,
      rugcheckRuggedAtCatch: null,
      riskTierAtCatch: caught.caughtTier,
      windows: buildPendingWindows(caught.caughtAt),
      summaryStatus: 'pending',
      confirmedAt: null,
      confirmationReasons: [],
      createdAt: now,
      updatedAt: now,
    };
    await kv.put(outcomeKey(caught.mint, caught.caughtAt), JSON.stringify(record), { expirationTtl: OUTCOME_TTL });
    await addOutcomeToIndex(kv, id);
    written++;
  }
  return written;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export async function getAccuracyReport(kv: KVNamespace, limit = 100): Promise<AccuracyReport> {
  const ids = ((await kv.get(OUTCOME_INDEX_KEY, 'json')) as string[] | null) ?? [];
  const records: PredictionOutcomeRecord[] = [];
  for (const id of ids.slice(0, Math.min(limit, MAX_OUTCOMES))) {
    const parsed = parseOutcomeId(id);
    if (!parsed) continue;
    const record = (await kv.get(outcomeKey(parsed.mint, parsed.caughtAt), 'json')) as PredictionOutcomeRecord | null;
    if (record) records.push(record);
  }

  records.sort((a, b) => {
    if (a.summaryStatus === 'confirmed' && b.summaryStatus !== 'confirmed') return -1;
    if (a.summaryStatus !== 'confirmed' && b.summaryStatus === 'confirmed') return 1;
    return b.caughtAt - a.caughtAt;
  });

  const confirmed = records.filter((r) => r.summaryStatus === 'confirmed');
  const falsePositive = records.filter((r) => r.summaryStatus === 'false_positive');
  const pending = records.filter((r) => r.summaryStatus === 'pending');
  const inconclusive = records.filter((r) => r.summaryStatus === 'inconclusive');
  const evaluated = confirmed.length + falsePositive.length;
  const precision = evaluated > 0 ? confirmed.length / evaluated : null;
  const leadTimes = confirmed
    .map((r) => (r.confirmedAt ?? 0) - r.caughtAt)
    .filter((ms) => Number.isFinite(ms) && ms >= 0);

  return {
    metrics: {
      total: records.length,
      confirmed: confirmed.length,
      falsePositive: falsePositive.length,
      pending: pending.length,
      inconclusive: inconclusive.length,
      evaluated,
      precision,
      medianLeadTimeMs: median(leadTimes),
      lastUpdatedAt: records.length > 0 ? Math.max(...records.map((r) => r.updatedAt ?? 0)) : null,
    },
    records,
    windows: WINDOWS.map((w) => ({ key: w.key, label: w.label, delayMs: w.delayMs })),
  };
}
