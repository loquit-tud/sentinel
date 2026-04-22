/**
 * Pre-Rug Catcher — the evidence-chain engine.
 *
 * Goal: build a verifiable track record of "we flagged X at 14:02, it died at 17:13".
 *
 * Mechanism:
 *  1. Every cron tick (15min), fetch top 100 Bags tokens + compute risk scores (via cache when warm).
 *  2. For each mint, read previous snapshot from KV (`watch:snap:${mint}`).
 *  3. If previous exists:
 *     - Compute delta (score drop) and check tier transitions.
 *     - If drop >= 40 points OR transitioned to rug/danger tier => record a "catch"
 *       in `watch:catch:${mint}` and push to `watch:catches:index` (sorted set-ish via JSON list).
 *  4. Always overwrite `watch:snap:${mint}` with the latest snapshot (last-write-wins).
 *
 * Storage keys:
 *  - `watch:snap:${mint}`       — latest risk snapshot { score, tier, ts, symbol, name }. TTL 7d.
 *  - `watch:catch:${mint}`      — captured pre-rug event (first observed). TTL 30d.
 *  - `watch:catches:index`      — list of mints with catches, sorted desc by `caughtAt`. TTL 30d.
 *  - `watch:stats`              — aggregate counters { tokensWatched, catches, avgLeadTimeMs }. TTL 30d.
 *
 * Non-goals: this module does NOT re-compute scores. It reads from existing KV cache to stay
 * within CPU time. The cache is kept warm by `precomputeFeedRiskScores` in the same cron.
 */

import type { TokenFeedItem, RiskScore, RiskTier, TokenPhase, TokenTrend } from '../../../shared/types';
import { fetchTopTokens } from '../feed/bags';

export interface WatchSnapshot {
  mint: string;
  symbol: string;
  name: string;
  score: number;
  tier: RiskTier;
  ts: number;
  // Agent memory fields (added April 2026)
  liquidity?: number;
  topHolderPct?: number;
  pumpScore?: number;
  phase?: TokenPhase;
}

/** Ring buffer of last 3 snapshots per token — forms agent memory */
export interface TokenMemory {
  mint: string;
  snapshots: WatchSnapshot[];  // newest first, max 3
  trend: TokenTrend;
  lastReasoning: string;
}

export interface PreRugCatch {
  mint: string;
  symbol: string;
  name: string;
  initialScore: number;
  initialTier: RiskTier;
  initialAt: number;
  caughtScore: number;
  caughtTier: RiskTier;
  caughtAt: number;
  scoreDrop: number;
  tierTransition: string; // e.g. "caution→rug"
  reason: 'score_drop' | 'tier_crash';
}

export interface WatchStats {
  tokensWatched: number;
  catches: number;
  lastRunAt: number;
  lastCatchAt: number | null;
  avgLeadTimeMs: number; // average time between initial snapshot and catch
}

export interface WatchEnv {
  SENTINEL_KV?: KVNamespace;
  BAGS_API_KEY?: string;
}

const SNAP_TTL = 7 * 24 * 60 * 60;      // 7 days
const CATCH_TTL = 30 * 24 * 60 * 60;    // 30 days
const INDEX_TTL = CATCH_TTL;

const SCORE_DROP_THRESHOLD = 40;         // ≥40 pts drop = catch
const TIER_CRASH_MIN_DROP = 15;          // tier_crash only counts if drop ≥15 (avoids cache-warming noise)
const MIN_LEAD_TIME_MS = 30 * 60 * 1000; // snapshot must be ≥30min old before a catch counts
const INDEX_KEY = 'watch:catches:index';
const STATS_KEY = 'watch:stats';
const MAX_INDEX_LEN = 100;

/** Read one snapshot (null if not found). */
async function getSnapshot(kv: KVNamespace, mint: string): Promise<WatchSnapshot | null> {
  return kv.get(`watch:snap:${mint}`, 'json') as Promise<WatchSnapshot | null>;
}

/** Read agent memory (ring buffer of last 3 snapshots) */
async function getMemory(kv: KVNamespace, mint: string): Promise<TokenMemory | null> {
  return kv.get(`watch:mem:${mint}`, 'json') as Promise<TokenMemory | null>;
}

/** Infer trend from last 2 snapshots using delta signals */
function inferTrend(prev: WatchSnapshot, curr: WatchSnapshot): TokenTrend {
  const scoreDelta = curr.score - prev.score;
  const liquidityDelta = (curr.liquidity ?? 0) - (prev.liquidity ?? 0);
  const holderDelta = (curr.topHolderPct ?? 0) - (prev.topHolderPct ?? 0);
  const pumpDelta = (curr.pumpScore ?? 0) - (prev.pumpScore ?? 0);

  // Collapse signal: score dropping fast
  if (scoreDelta <= -20) return 'dying';

  // Distribution: liquidity dropping + holders concentrating
  if (liquidityDelta < 0 && holderDelta > 3) return 'distributing';

  // Pump: pumpScore rising + score stable or rising
  if (pumpDelta > 10 && scoreDelta >= -5) return 'pumping';

  // Accumulation: pumpScore rising, price flat, score stable
  if (pumpDelta > 5 && curr.phase === 'accumulation') return 'accumulating';

  return 'stable';
}

/** Generate delta-based reasoning text for agent memory */
function generateMemoryReasoning(prev: WatchSnapshot, curr: WatchSnapshot, trend: TokenTrend): string {
  const reasons: string[] = [];

  const liquidityDrop = prev.liquidity && curr.liquidity
    ? ((prev.liquidity - curr.liquidity) / Math.max(prev.liquidity, 1)) * 100
    : 0;

  if (liquidityDrop >= 30) reasons.push(`liquidity dropped ${liquidityDrop.toFixed(0)}%`);
  else if (liquidityDrop >= 15) reasons.push(`liquidity declining −${liquidityDrop.toFixed(0)}%`);

  const holderDelta = (curr.topHolderPct ?? 0) - (prev.topHolderPct ?? 0);
  if (holderDelta >= 5) reasons.push(`wallet concentration increased +${holderDelta.toFixed(1)}%`);
  else if (holderDelta <= -5) reasons.push(`wallet concentration dispersing`);

  const scoreDelta = curr.score - prev.score;
  if (scoreDelta <= -20) reasons.push(`risk score dropped ${Math.abs(scoreDelta)} pts`);
  else if (scoreDelta >= 10) reasons.push(`risk improving +${scoreDelta} pts`);

  if (curr.phase === 'manipulation') reasons.push(`low-trader high-impact movement detected`);
  if (curr.phase === 'distribution') reasons.push(`classic distribution — smart money exiting`);
  if (curr.phase === 'collapse') reasons.push(`active exit event in progress`);
  if (curr.phase === 'accumulation') reasons.push(`quiet positioning — potential pre-move setup`);

  if (reasons.length === 0) {
    return trend === 'stable' ? 'no significant behavioral change detected' : `trend: ${trend}`;
  }
  return reasons.join(' — ');
}

/** Update agent memory ring buffer (max 3 snapshots) */
async function updateMemory(kv: KVNamespace, snap: WatchSnapshot): Promise<void> {
  const existing = await getMemory(kv, snap.mint);
  const snapshots = existing ? existing.snapshots : [];

  // Prepend new snapshot, keep max 3
  snapshots.unshift(snap);
  const trimmed = snapshots.slice(0, 3);

  let trend: TokenTrend = 'stable';
  let lastReasoning = '';
  if (trimmed.length >= 2) {
    trend = inferTrend(trimmed[1], trimmed[0]); // prev=trimmed[1], curr=trimmed[0]
    lastReasoning = generateMemoryReasoning(trimmed[1], trimmed[0], trend);
  }

  const memory: TokenMemory = { mint: snap.mint, snapshots: trimmed, trend, lastReasoning };
  await kv.put(`watch:mem:${snap.mint}`, JSON.stringify(memory), { expirationTtl: SNAP_TTL });
}

/** Read cached risk score for a mint (populated by precomputeFeedRiskScores). */
async function getCachedRisk(kv: KVNamespace, mint: string): Promise<RiskScore | null> {
  return kv.get(`risk:${mint}`, 'json') as Promise<RiskScore | null>;
}

function tierSeverity(tier: RiskTier): number {
  switch (tier) {
    case 'safe': return 0;
    case 'caution': return 1;
    case 'danger': return 2;
    case 'rug': return 3;
  }
}

/** Returns a catch record if conditions meet, else null. */
function detectCatch(prev: WatchSnapshot, curr: { score: number; tier: RiskTier }, token: TokenFeedItem): PreRugCatch | null {
  // Require the baseline snapshot to be at least MIN_LEAD_TIME_MS old.
  // This eliminates "calibration noise" — when the first snapshot is captured
  // from a partially-warmed cache (optimistic RugCheck-only score), and the
  // second snapshot reflects the fully-enriched score a few minutes later.
  if (Date.now() - prev.ts < MIN_LEAD_TIME_MS) return null;

  const drop = prev.score - curr.score;
  const prevSev = tierSeverity(prev.tier);
  const currSev = tierSeverity(curr.tier);
  const crashedToDanger = currSev >= 2 && prevSev < 2; // transitioned into danger/rug

  // Real rug signal: big drop OR tier-crash with meaningful magnitude.
  const isScoreDrop = drop >= SCORE_DROP_THRESHOLD;
  const isTierCrash = crashedToDanger && drop >= TIER_CRASH_MIN_DROP;
  if (!isScoreDrop && !isTierCrash) return null;

  return {
    mint: prev.mint,
    symbol: token.symbol ?? prev.symbol,
    name: token.name ?? prev.name,
    initialScore: prev.score,
    initialTier: prev.tier,
    initialAt: prev.ts,
    caughtScore: curr.score,
    caughtTier: curr.tier,
    caughtAt: Date.now(),
    scoreDrop: drop,
    tierTransition: `${prev.tier}→${curr.tier}`,
    reason: isScoreDrop ? 'score_drop' : 'tier_crash',
  };
}

/** Main cron entry point. Returns number of new catches in this run. */
export async function runPreRugWatch(env: WatchEnv): Promise<number> {
  const kv = env.SENTINEL_KV;
  if (!kv) return 0;

  // Self-heal: purge low-quality catches from index (lead time < MIN_LEAD_TIME_MS
  // or drop < TIER_CRASH_MIN_DROP). This removes calibration noise from earlier runs.
  await purgeLowQualityCatches(kv);

  const tokens = await fetchTopTokens(env.BAGS_API_KEY);
  const batch = tokens.slice(0, 100);
  let newCatches = 0;
  let snapshotsWritten = 0;

  for (const token of batch) {
    try {
      // Need a current risk score to operate on
      const riskCached = await getCachedRisk(kv, token.mint);
      if (!riskCached) continue; // skip if precompute hasn't warmed this mint yet

      const current = { score: riskCached.score, tier: riskCached.tier };
      const prev = await getSnapshot(kv, token.mint);

      if (prev) {
        // Already have a catch recorded? skip detection to preserve first event.
        const existingCatch = await kv.get(`watch:catch:${token.mint}`);
        if (!existingCatch) {
          const caught = detectCatch(prev, current, token);
          if (caught) {
            await kv.put(`watch:catch:${token.mint}`, JSON.stringify(caught), { expirationTtl: CATCH_TTL });
            await addToIndex(kv, caught);
            newCatches++;
          }
        }
      }

      // Always refresh the snapshot (so next cron has the latest baseline)
      const snap: WatchSnapshot = {
        mint: token.mint,
        symbol: token.symbol ?? '',
        name: token.name ?? '',
        score: current.score,
        tier: current.tier,
        ts: Date.now(),
        liquidity: token.liquidity,
        topHolderPct: riskCached.breakdown?.topHolderPct,
        pumpScore: riskCached.pumpSignal?.pumpScore,
        phase: riskCached.pumpSignal?.phase,
      };
      await kv.put(`watch:snap:${token.mint}`, JSON.stringify(snap), { expirationTtl: SNAP_TTL });
      await updateMemory(kv, snap);
      snapshotsWritten++;
    } catch (err) {
      console.error(`Watch tick failed for ${token.mint}:`, err);
    }
  }

  await updateStats(kv, snapshotsWritten, newCatches);
  return newCatches;
}

async function addToIndex(kv: KVNamespace, c: PreRugCatch): Promise<void> {
  const existing = (await kv.get(INDEX_KEY, 'json')) as PreRugCatch[] | null;
  const list = existing ?? [];
  list.unshift(c);
  const trimmed = list.slice(0, MAX_INDEX_LEN);
  await kv.put(INDEX_KEY, JSON.stringify(trimmed), { expirationTtl: INDEX_TTL });
}

/**
 * Self-healing purge: remove catches that don't meet current quality thresholds.
 * Drops entries where lead time < MIN_LEAD_TIME_MS or drop < TIER_CRASH_MIN_DROP.
 * Also deletes matching `watch:catch:${mint}` keys so those mints can be caught again legitimately.
 */
async function purgeLowQualityCatches(kv: KVNamespace): Promise<void> {
  const existing = (await kv.get(INDEX_KEY, 'json')) as PreRugCatch[] | null;
  if (!existing || existing.length === 0) return;

  const keep: PreRugCatch[] = [];
  const purge: string[] = [];
  for (const c of existing) {
    const leadOk = (c.caughtAt - c.initialAt) >= MIN_LEAD_TIME_MS;
    const dropOk = c.reason === 'score_drop'
      ? c.scoreDrop >= SCORE_DROP_THRESHOLD
      : c.scoreDrop >= TIER_CRASH_MIN_DROP;
    if (leadOk && dropOk) {
      keep.push(c);
    } else {
      purge.push(c.mint);
    }
  }

  if (purge.length === 0) return;

  await kv.put(INDEX_KEY, JSON.stringify(keep), { expirationTtl: INDEX_TTL });
  for (const mint of purge) {
    await kv.delete(`watch:catch:${mint}`);
  }

  // Reset counter + recompute avgLeadTime to match the cleaned index.
  const statsExisting = (await kv.get(STATS_KEY, 'json')) as WatchStats | null;
  const avgLeadTimeMs = keep.length > 0
    ? Math.round(keep.reduce((sum, c) => sum + (c.caughtAt - c.initialAt), 0) / keep.length)
    : 0;
  const stats: WatchStats = {
    tokensWatched: statsExisting?.tokensWatched ?? 0,
    catches: keep.length,
    lastRunAt: statsExisting?.lastRunAt ?? Date.now(),
    lastCatchAt: keep.length > 0 ? keep[0].caughtAt : null,
    avgLeadTimeMs,
  };
  await kv.put(STATS_KEY, JSON.stringify(stats), { expirationTtl: INDEX_TTL });
}

async function updateStats(kv: KVNamespace, watched: number, newCatches: number): Promise<void> {
  const existing = (await kv.get(STATS_KEY, 'json')) as WatchStats | null;
  const now = Date.now();
  const catches = (existing?.catches ?? 0) + newCatches;
  const stats: WatchStats = {
    tokensWatched: watched,
    catches,
    lastRunAt: now,
    lastCatchAt: newCatches > 0 ? now : (existing?.lastCatchAt ?? null),
    avgLeadTimeMs: existing?.avgLeadTimeMs ?? 0,
  };

  // Recompute avgLeadTime from the current index (cheap, at most 100 entries)
  if (newCatches > 0) {
    const index = (await kv.get(INDEX_KEY, 'json')) as PreRugCatch[] | null;
    if (index && index.length > 0) {
      const total = index.reduce((sum, c) => sum + (c.caughtAt - c.initialAt), 0);
      stats.avgLeadTimeMs = Math.round(total / index.length);
    }
  }

  await kv.put(STATS_KEY, JSON.stringify(stats), { expirationTtl: INDEX_TTL });
}

/** Public read: return most recent catches. */
export async function getRecentCatches(kv: KVNamespace, limit = 20): Promise<PreRugCatch[]> {
  const list = (await kv.get(INDEX_KEY, 'json')) as PreRugCatch[] | null;
  return (list ?? []).slice(0, limit);
}

/** Public read: aggregate stats. */
export async function getWatchStats(kv: KVNamespace): Promise<WatchStats | null> {
  return (await kv.get(STATS_KEY, 'json')) as WatchStats | null;
}

/** Public read: agent memory for a specific token */
export async function getTokenMemory(kv: KVNamespace, mint: string): Promise<TokenMemory | null> {
  return getMemory(kv, mint);
}
