/**
 * Risk Alert Scanner
 *
 * Scans top Bags tokens, compares current risk scores to previous scores
 * stored in KV, and generates alerts when significant changes occur.
 *
 * Design: stateless function, KV for persistence. Called by:
 *   - Cron trigger (scheduled every 15 min)
 *   - On-demand via GET /v1/alerts/scan (rate-limited)
 */

import type { Env } from '../index';
import type { RiskAlert, AlertType, AlertSeverity, RiskTier } from '../../../shared/types';
import { tierFromScore } from '../../../shared/types';
import { fetchTopTokens } from '../feed/bags';
import { computeRiskScore } from '../risk/engine';
import { fetchRugCheckReport, analyzeRugCheck } from '../risk/rugcheck';
import { fetchBirdeyeOverview } from '../risk/birdeye';

const ALERT_KV_PREFIX = 'alert:';
const SCORE_KV_PREFIX = 'score:prev:';
const FEED_KEY = 'alerts:feed';
const SCAN_META_KEY = 'alerts:scan:meta';
const CALIBRATION_KEY = 'alerts:calibration';
const QUALITY_METRICS_KEY = 'alerts:quality:latest';

// Max tokens to scan per run (kept conservative to preserve KV quota)
const MAX_SCAN_BATCH = 10;
// Max alerts to keep in feed (rolling window)
const MAX_ALERTS = 100;
// Score change threshold to generate alert (absolute points)
const SCORE_CHANGE_THRESHOLD = 15;
// Adaptive threshold bounds (periodic drift calibration)
const SCORE_CHANGE_THRESHOLD_MIN = 10;
const SCORE_CHANGE_THRESHOLD_MAX = 28;
// Tier downgrade hysteresis (prevents noisy boundary flips)
const TIER_HYSTERESIS_POINTS = 5;
// Cooldown for repeated tier/score alerts per token
const TIER_ALERT_COOLDOWN_MS = 45 * 60 * 1000;
// Top holder concentration spike threshold (percentage points)
const HOLDER_SPIKE_THRESHOLD = 20;
// LP drain thresholds (% drop in totalMarketLiquidity between scans)
const LP_DRAIN_CRITICAL_PCT = 20; // ≥20% drop → CRITICAL
const LP_DRAIN_WARNING_PCT = 10;  // ≥10% drop → WARNING
// Minimum liquidity to track (ignore micro-pools)
const LP_DRAIN_MIN_USD = 500;
// Source health gate: if ≥35% tokens return null/zero liquidity in same cycle → likely API outage
const SOURCE_HEALTH_OUTAGE_THRESHOLD = 0.35;
// Zero-shock guard: prev liquidity above this + current exactly 0 → require Birdeye confirmation
const ZERO_SHOCK_MIN_PREV_USD = 5_000;

interface PreviousScore {
  score: number;
  tier: RiskTier;
  lpLocked: number;
  topHolderPct: number;
  mintAuthority: number;
  liquidityUsd: number;  // totalMarketLiquidity from RugCheck (only stored when > 0)
  lpDrainConfirmCount: number; // consecutive scans showing drain (debounce)
  timestamp: number;
}

interface ScanMeta {
  lastScanAt: number;
  scannedTokens: number;
  alertsGenerated: number;
}

interface AlertCalibration {
  updatedAt: number;
  scoreChangeThreshold: number;
  tierHysteresisPoints: number;
}

export interface AlertQualityMetrics {
  lastRunAt: number;
  scannedTokens: number;
  emittedAlerts: number;
  sourceHealthScore: number;
  nullLiquidityTokens: number;
  scoreChangeThreshold: number;
  observedMedianDelta: number;
  suppressedTierHysteresis: number;
  suppressedTierCooldown: number;
  suppressedScoreCooldown: number;
  suppressedLpDrainOutage: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function shouldEmitWithCooldown(kv: KVNamespace, key: string, cooldownMs: number): Promise<boolean> {
  const now = Date.now();
  const prevRaw = await kv.get(key);
  const prevTs = prevRaw ? Number(prevRaw) : 0;
  if (Number.isFinite(prevTs) && prevTs > 0 && now - prevTs < cooldownMs) return false;
  const ttl = Math.max(60, Math.ceil(cooldownMs / 1000) * 2);
  await kv.put(key, String(now), { expirationTtl: ttl });
  return true;
}

function computeAdaptiveScoreThreshold(deltas: number[]): number {
  if (deltas.length < 5) return SCORE_CHANGE_THRESHOLD;
  const med = median(deltas);
  // Conservative multiplier keeps noise low but still catches real moves.
  const adaptive = Math.round(med * 1.6);
  return clamp(adaptive, SCORE_CHANGE_THRESHOLD_MIN, SCORE_CHANGE_THRESHOLD_MAX);
}

function pickPrimaryRugcheckMarket(report: Awaited<ReturnType<typeof fetchRugCheckReport>>): {
  marketPubkey: string;
  lpMint: string;
  lpLockedPct: number;
  lpLockedUsd: number;
} | null {
  const markets = report?.markets ?? null;
  if (!markets || markets.length === 0) return null;

  // Prefer the pool with the highest locked USD (best proxy for "main" pool).
  // Fallback to highest total USD (baseUSD+quoteUSD) if locked USD missing.
  const ranked = markets
    .filter((m) => Boolean(m?.pubkey) && Boolean(m?.mintLP) && Boolean(m?.lp))
    .map((m) => ({
      marketPubkey: m.pubkey,
      lpMint: m.mintLP,
      lpLockedPct: m.lp?.lpLockedPct ?? 0,
      lpLockedUsd: m.lp?.lpLockedUSD ?? 0,
      totalUsd: (m.lp?.baseUSD ?? 0) + (m.lp?.quoteUSD ?? 0),
    }))
    .sort((a, b) => {
      if (b.lpLockedUsd !== a.lpLockedUsd) return b.lpLockedUsd - a.lpLockedUsd;
      return b.totalUsd - a.totalUsd;
    });

  if (ranked.length === 0) return null;
  const top = ranked[0];
  return {
    marketPubkey: top.marketPubkey,
    lpMint: top.lpMint,
    lpLockedPct: top.lpLockedPct,
    lpLockedUsd: top.lpLockedUsd,
  };
}

/**
 * Run a full scan: fetch top tokens, score them, compare to previous, emit alerts.
 * Returns the new alerts generated in this run.
 */
export async function runAlertScan(env: Env): Promise<RiskAlert[]> {
  const kv = env.SENTINEL_KV;
  if (!kv) return [];

  const calibrationRaw = await kv.get(CALIBRATION_KEY, 'json').catch(() => null);
  const calibration = (calibrationRaw as AlertCalibration | null) ?? null;
  const scoreChangeThreshold = clamp(
    calibration?.scoreChangeThreshold ?? SCORE_CHANGE_THRESHOLD,
    SCORE_CHANGE_THRESHOLD_MIN,
    SCORE_CHANGE_THRESHOLD_MAX,
  );
  const tierHysteresisPoints = clamp(
    calibration?.tierHysteresisPoints ?? TIER_HYSTERESIS_POINTS,
    3,
    10,
  );

  // 1. Get top tokens from Bags
  const tokens = await fetchTopTokens(env.BAGS_API_KEY);
  // Deduplicate by mint before slicing — prevents the same token appearing twice
  // in the feed (which would cause prev-state to be overwritten mid-cycle, creating
  // phantom prev values on the second occurrence).
  const seenMints = new Set<string>();
  const dedupedTokens = tokens.filter((t) => {
    if (seenMints.has(t.mint)) return false;
    seenMints.add(t.mint);
    return true;
  });
  const batch = dedupedTokens.slice(0, MAX_SCAN_BATCH);
  if (batch.length === 0) return [];

  const newAlerts: RiskAlert[] = [];
  const observedScoreDeltas: number[] = [];
  let suppressedTierHysteresis = 0;
  let suppressedTierCooldown = 0;
  let suppressedScoreCooldown = 0;
  let suppressedLpDrainOutage = 0;
  // Source health tracking: count tokens with null/zero/invalid liquidity data this cycle
  let nullLiquidityTokens = 0;

  // 2. Score each token and compare to previous
  const scoringResults = await Promise.allSettled(
    batch.map(async (token) => {
      try {
        // Current score
        const current = await computeRiskScore(token.mint, {
          HELIUS_API_KEY: env.HELIUS_API_KEY,
          BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
        });

        // Previous score from KV
        const prevRaw = await kv.get(`${SCORE_KV_PREFIX}${token.mint}`, 'json');
        const prev = prevRaw as PreviousScore | null;
        if (prev) observedScoreDeltas.push(Math.abs(current.score - prev.score));

        // Get RugCheck for creator + LP details
        const rugReport = await fetchRugCheckReport(token.mint);
        const creatorWallet = rugReport?.creator ?? null;
        const primaryMarket = pickPrimaryRugcheckMarket(rugReport);

        // --- Generate alerts ---

        // Tier change
        if (prev && prev.tier !== current.tier) {
          const degraded = tierRank(current.tier) < tierRank(prev.tier);
          const scoreDrop = prev.score - current.score;
          // Hysteresis for downgrades: require a minimum score move, not just boundary flicker.
          const hysteresisPassed = !degraded || scoreDrop >= tierHysteresisPoints;
          if (hysteresisPassed) {
            const canEmit = await shouldEmitWithCooldown(
              kv,
              `${ALERT_KV_PREFIX}cooldown:tier:${token.mint}`,
              TIER_ALERT_COOLDOWN_MS,
            );
            if (canEmit) {
              newAlerts.push({
                id: `tier_${token.mint}_${Date.now()}`,
                mint: token.mint,
                tokenName: token.name,
                tokenSymbol: token.symbol,
                type: 'tier_change',
                severity: degraded ? (current.tier === 'rug' ? 'critical' : 'warning') : 'info',
                title: `${token.symbol} moved from ${tierLabel(prev.tier)} to ${tierLabel(current.tier)}`,
                description: degraded
                  ? `Risk score dropped from ${prev.score} to ${current.score}. Review this token immediately.`
                  : `Risk score improved from ${prev.score} to ${current.score}.`,
                previousScore: prev.score,
                currentScore: current.score,
                previousTier: prev.tier,
                currentTier: current.tier,
                timestamp: Date.now(),
                creatorWallet,
              });
            }
            else {
              suppressedTierCooldown++;
            }
          }
          else {
            suppressedTierHysteresis++;
          }
        }
        // Significant score change (same tier but big move)
        else if (prev && Math.abs(current.score - prev.score) >= scoreChangeThreshold) {
          const degraded = current.score < prev.score;
          const canEmit = await shouldEmitWithCooldown(
            kv,
            `${ALERT_KV_PREFIX}cooldown:score:${token.mint}`,
            TIER_ALERT_COOLDOWN_MS,
          );
          if (canEmit) {
            newAlerts.push({
              id: `score_${token.mint}_${Date.now()}`,
              mint: token.mint,
              tokenName: token.name,
              tokenSymbol: token.symbol,
              type: 'tier_change',
              severity: degraded ? 'warning' : 'info',
              title: `${token.symbol} score ${degraded ? 'dropped' : 'improved'}: ${prev.score} → ${current.score}`,
              description: `Significant ${degraded ? 'decline' : 'improvement'} in risk score within the same tier (${current.tier}).`,
              previousScore: prev.score,
              currentScore: current.score,
              previousTier: prev.tier,
              currentTier: current.tier,
              timestamp: Date.now(),
              creatorWallet,
            });
          }
          else {
            suppressedScoreCooldown++;
          }
        }

        // LP unlock detection
        if (prev && prev.lpLocked > 50 && current.breakdown.lpLocked < 20) {
          newAlerts.push({
            id: `lp_${token.mint}_${Date.now()}`,
            mint: token.mint,
            tokenName: token.name,
            tokenSymbol: token.symbol,
            type: 'lp_unlock',
            severity: 'critical',
            title: `⚠️ ${token.symbol} LP appears UNLOCKED`,
            description: `LP locked score dropped from ${prev.lpLocked} to ${current.breakdown.lpLocked}. Liquidity may be at risk of removal.`,
            previousScore: prev.score,
            currentScore: current.score,
            previousTier: prev.tier,
            currentTier: current.tier,
            timestamp: Date.now(),
            creatorWallet,
            dataConfidence: current.dataConfidence,
            missingSignals: current.missingSignals,
            marketPubkey: primaryMarket?.marketPubkey,
            lpMint: primaryMarket?.lpMint,
            lpLockedPct: primaryMarket?.lpLockedPct,
            lpLockedUsd: primaryMarket?.lpLockedUsd,
          });
        }

        // LP drain detection — 3-layer false positive suppression
        //
        // Layer 1: Null/Zero shock filter
        //   API outages return null or 0 for ALL tokens simultaneously.
        //   Never treat missing data as a confirmed economic state change.
        const rawLiquidityReport = rugReport?.totalMarketLiquidity;
        const liquidityDataValid = rugReport !== null && rawLiquidityReport != null;
        const currentLiquidityUsd = liquidityDataValid ? rawLiquidityReport! : 0;

        // Track invalid data for source health scoring (used after the loop)
        if (!liquidityDataValid || (currentLiquidityUsd === 0 && (prev?.liquidityUsd ?? 0) >= ZERO_SHOCK_MIN_PREV_USD)) {
          nullLiquidityTokens++;
        }

        // Layer 2: Only run drain detection if data is structurally valid AND non-zero
        if (
          liquidityDataValid &&
          currentLiquidityUsd > 0 &&
          prev &&
          prev.liquidityUsd >= LP_DRAIN_MIN_USD &&
          currentLiquidityUsd < prev.liquidityUsd
        ) {
          const dropPct = ((prev.liquidityUsd - currentLiquidityUsd) / prev.liquidityUsd) * 100;
          const confirmCount = (prev.lpDrainConfirmCount ?? 0) + 1;

          if (dropPct >= LP_DRAIN_CRITICAL_PCT) {
            // Escalate to CRITICAL on first scan if drop is catastrophic (≥50%).
            // No reason to wait 2 cycles when 75%+ of liquidity is already gone.
            const isCatastrophic = dropPct >= 50;
            if (confirmCount >= 2 || isCatastrophic) {
              // Layer 3: Birdeye cross-validation for zero-shock CRITICAL alerts.
              // If prev liquidity was large and current is suspiciously low, verify with Birdeye.
              const isZeroShock = currentLiquidityUsd === 0 && prev.liquidityUsd >= ZERO_SHOCK_MIN_PREV_USD;
              let birdeyeConfirmed = true;
              // Also cross-validate large non-zero drops (>=40%) to reduce false positives from noisy liquidity sources.
              const needsCrossValidation = isZeroShock || dropPct >= 40;
              if (needsCrossValidation && env.BIRDEYE_API_KEY) {
                const birdeyeOverview = await fetchBirdeyeOverview(token.mint, env.BIRDEYE_API_KEY).catch(() => null);
                const birdeyeLiq = birdeyeOverview?.liquidity ?? null;
                // If Birdeye reports normal liquidity (≥50% of prev), Bags data is wrong
                if (birdeyeLiq != null && birdeyeLiq > prev.liquidityUsd * 0.5) {
                  birdeyeConfirmed = false;
                  nullLiquidityTokens++;
                  console.warn(`[Sentinel] LP drain SUPPRESSED for ${token.symbol}: Bags=$0 but Birdeye=$${birdeyeLiq.toLocaleString()} — treating as API noise`);
                }
              }

              if (birdeyeConfirmed) {
                const dataConfidence = current.dataConfidence ?? 1;
                const missing = current.missingSignals ?? [];
                const hasMissingMarketData = missing.includes('liquidityDepth') || missing.includes('volumeHealth');
                const downgradeForPartialData = dataConfidence < 0.9 || hasMissingMarketData;
                const severity: AlertSeverity = downgradeForPartialData ? 'warning' : 'critical';
                const suffix = downgradeForPartialData ? ' (partial data)' : '';

                // Confirmed over 2+ scans with valid data — real drain
                newAlerts.push({
                  id: `drain_${token.mint}_${Date.now()}`,
                  mint: token.mint,
                  tokenName: token.name,
                  tokenSymbol: token.symbol,
                  type: 'lp_drain',
                  severity,
                  title: `${severity === 'critical' ? '🚨' : '⚠️'} ${token.symbol} LP drain detected — -${dropPct.toFixed(1)}% liquidity${suffix}`,
                  description: `Liquidity dropped from $${prev.liquidityUsd.toLocaleString()} to $${currentLiquidityUsd.toLocaleString()} (-${dropPct.toFixed(1)}%) since last scan.${downgradeForPartialData ? ' Some market signals were missing; treat as high-risk but verify before acting.' : ' Possible critical-risk event in progress — exit window closing.'}`,
                  previousScore: prev.score,
                  currentScore: current.score,
                  previousTier: prev.tier,
                  currentTier: current.tier,
                  timestamp: Date.now(),
                  creatorWallet,
                  liquidityUsd: currentLiquidityUsd,
                  prevLiquidityUsd: prev.liquidityUsd,
                  liquidityDropPct: dropPct,
                  confirmed: true,
                  dataConfidence: current.dataConfidence,
                  missingSignals: current.missingSignals,
                  marketPubkey: primaryMarket?.marketPubkey,
                  lpMint: primaryMarket?.lpMint,
                  lpLockedPct: primaryMarket?.lpLockedPct,
                  lpLockedUsd: primaryMarket?.lpLockedUsd,
                });
              }
            } else {
              // First detection — fire WARNING only (possible API noise)
              newAlerts.push({
                id: `drain_${token.mint}_${Date.now()}`,
                mint: token.mint,
                tokenName: token.name,
                tokenSymbol: token.symbol,
                type: 'lp_drain',
                severity: 'warning',
                title: `⚠️ ${token.symbol} LP may be draining — -${dropPct.toFixed(1)}% (unconfirmed)`,
                description: `Liquidity dropped from $${prev.liquidityUsd.toLocaleString()} to $${currentLiquidityUsd.toLocaleString()} (-${dropPct.toFixed(1)}%). Monitoring next scan to confirm.`,
                previousScore: prev.score,
                currentScore: current.score,
                previousTier: prev.tier,
                currentTier: current.tier,
                timestamp: Date.now(),
                creatorWallet,
                liquidityUsd: currentLiquidityUsd,
                prevLiquidityUsd: prev.liquidityUsd,
                liquidityDropPct: dropPct,
                confirmed: false,
                dataConfidence: current.dataConfidence,
                missingSignals: current.missingSignals,
                marketPubkey: primaryMarket?.marketPubkey,
                lpMint: primaryMarket?.lpMint,
                lpLockedPct: primaryMarket?.lpLockedPct,
                lpLockedUsd: primaryMarket?.lpLockedUsd,
              });
            }
          } else if (dropPct >= LP_DRAIN_WARNING_PCT) {
            newAlerts.push({
              id: `drain_${token.mint}_${Date.now()}`,
              mint: token.mint,
              tokenName: token.name,
              tokenSymbol: token.symbol,
              type: 'lp_drain',
              severity: 'warning',
              title: `⚠️ ${token.symbol} liquidity dropping — -${dropPct.toFixed(1)}%`,
              description: `Liquidity dropped from $${prev.liquidityUsd.toLocaleString()} to $${currentLiquidityUsd.toLocaleString()} (-${dropPct.toFixed(1)}%) since last scan. Monitor closely.`,
              previousScore: prev.score,
              currentScore: current.score,
              previousTier: prev.tier,
              currentTier: current.tier,
              timestamp: Date.now(),
              creatorWallet,
              liquidityUsd: currentLiquidityUsd,
              prevLiquidityUsd: prev.liquidityUsd,
              liquidityDropPct: dropPct,
              confirmed: false,
              dataConfidence: current.dataConfidence,
              missingSignals: current.missingSignals,
              marketPubkey: primaryMarket?.marketPubkey,
              lpMint: primaryMarket?.lpMint,
              lpLockedPct: primaryMarket?.lpLockedPct,
              lpLockedUsd: primaryMarket?.lpLockedUsd,
            });
          }
        }

        // Top holder concentration spike
        if (prev) {
          // topHolderPct in breakdown is inverted (100 = good distribution)
          // So a DROP in this value means concentration INCREASED
          const prevDistribution = prev.topHolderPct;
          const currDistribution = current.breakdown.topHolderPct;
          if (prevDistribution - currDistribution >= HOLDER_SPIKE_THRESHOLD) {
            newAlerts.push({
              id: `holder_${token.mint}_${Date.now()}`,
              mint: token.mint,
              tokenName: token.name,
              tokenSymbol: token.symbol,
              type: 'holder_spike',
              severity: 'warning',
              title: `${token.symbol}: Top holder concentration increased sharply`,
              description: `Holder distribution score dropped from ${prevDistribution} to ${currDistribution}. Whales may be accumulating.`,
              previousScore: prev.score,
              currentScore: current.score,
              previousTier: prev.tier,
              currentTier: current.tier,
              timestamp: Date.now(),
              creatorWallet,
            });
          }
        }

        // New token scored danger/rug on first scan
        if (!prev && (current.tier === 'danger' || current.tier === 'rug')) {
          newAlerts.push({
            id: `new_${token.mint}_${Date.now()}`,
            mint: token.mint,
            tokenName: token.name,
            tokenSymbol: token.symbol,
            type: 'new_danger',
            severity: current.tier === 'rug' ? 'critical' : 'warning',
            title: `New token ${token.symbol} scored ${tierLabel(current.tier)} (${current.score})`,
            description: `First scan of ${token.name} shows ${tierLabel(current.tier).toLowerCase()} risk. Exercise extreme caution.`,
            previousScore: null,
            currentScore: current.score,
            previousTier: null,
            currentTier: current.tier,
            timestamp: Date.now(),
            creatorWallet,
          });
        }

        // Save current score as "previous" for next scan
        // Note: only update liquidityUsd if we got valid data to avoid storing API noise.
        // Preserves last known good value when current data is invalid/null.
        const realLiquidityUsd = liquidityDataValid && currentLiquidityUsd > 0
          ? currentLiquidityUsd
          : (prev?.liquidityUsd ?? 0);

        // Drain confirm count: only increment for valid, non-zero data confirming the drain.
        // Invalid data (null/zero shock) resets the counter to 0 to prevent outage amplification.
        const isDraining = liquidityDataValid && currentLiquidityUsd > 0 &&
          prev != null && prev.liquidityUsd >= LP_DRAIN_MIN_USD && currentLiquidityUsd < prev.liquidityUsd &&
          ((prev.liquidityUsd - currentLiquidityUsd) / prev.liquidityUsd) * 100 >= LP_DRAIN_CRITICAL_PCT;
        const lpDrainConfirmCount = isDraining ? (prev?.lpDrainConfirmCount ?? 0) + 1 : 0;

        const newPrev: PreviousScore = {
          score: current.score,
          tier: current.tier,
          lpLocked: current.breakdown.lpLocked,
          topHolderPct: current.breakdown.topHolderPct,
          mintAuthority: current.breakdown.mintAuthority,
          liquidityUsd: realLiquidityUsd,
          lpDrainConfirmCount,
          timestamp: Date.now(),
        };
        const changed =
          !prev ||
          prev.score !== newPrev.score ||
          prev.tier !== newPrev.tier ||
          prev.lpLocked !== newPrev.lpLocked ||
          prev.topHolderPct !== newPrev.topHolderPct ||
          prev.mintAuthority !== newPrev.mintAuthority ||
          prev.lpDrainConfirmCount !== newPrev.lpDrainConfirmCount ||
          Math.abs((prev.liquidityUsd ?? 0) - newPrev.liquidityUsd) > 10; // save if liquidity changed >$10

        if (changed) {
          await kv.put(
            `${SCORE_KV_PREFIX}${token.mint}`,
            JSON.stringify(newPrev),
            { expirationTtl: 86400 * 7 }, // 7 days
          );
        }
      } catch (err) {
        console.error(`Alert scan failed for ${token.mint}:`, err);
      }
    }),
  );

  // Source health gate: if ≥35% of tokens returned null/zero liquidity in this cycle,
  // it's almost certainly a Bags API outage, not real rugs.
  // Suppress LP drain alerts for the entire cycle to avoid mass false positives.
  const sourceHealthScore = 1 - (nullLiquidityTokens / Math.max(batch.length, 1));
  if (sourceHealthScore < (1 - SOURCE_HEALTH_OUTAGE_THRESHOLD)) {
    const drainCount = newAlerts.filter((a) => a.type === 'lp_drain').length;
    if (drainCount > 0) {
      suppressedLpDrainOutage += drainCount;
      console.warn(
        `[Sentinel] Source health gate: ${nullLiquidityTokens}/${batch.length} tokens with ` +
        `invalid liquidity data (health=${(sourceHealthScore * 100).toFixed(0)}%) — ` +
        `suppressing ${drainCount} LP drain alert(s) as suspected API outage`,
      );
      const filtered = newAlerts.filter((a) => a.type !== 'lp_drain');
      newAlerts.length = 0;
      newAlerts.push(...filtered);
    }
  }

  // Periodic calibration: update adaptive score threshold from observed token volatility.
  // This keeps alert sensitivity stable when market regime changes.
  const calibratedThreshold = computeAdaptiveScoreThreshold(observedScoreDeltas);
  const nextCalibration: AlertCalibration = {
    updatedAt: Date.now(),
    scoreChangeThreshold: calibratedThreshold,
    tierHysteresisPoints,
  };
  await kv.put(CALIBRATION_KEY, JSON.stringify(nextCalibration), { expirationTtl: 86400 * 7 });

  const quality: AlertQualityMetrics = {
    lastRunAt: Date.now(),
    scannedTokens: batch.length,
    emittedAlerts: newAlerts.length,
    sourceHealthScore,
    nullLiquidityTokens,
    scoreChangeThreshold: calibratedThreshold,
    observedMedianDelta: Number(median(observedScoreDeltas).toFixed(2)),
    suppressedTierHysteresis,
    suppressedTierCooldown,
    suppressedScoreCooldown,
    suppressedLpDrainOutage,
  };
  await kv.put(QUALITY_METRICS_KEY, JSON.stringify(quality), { expirationTtl: 86400 * 7 });

  // 3. Merge new alerts into existing feed (rolling window)
  const existingRaw = await kv.get(FEED_KEY, 'json');
  const existingAlerts = (existingRaw as RiskAlert[] | null) ?? [];
  const mergedAlerts = [...newAlerts, ...existingAlerts].slice(0, MAX_ALERTS);

  if (newAlerts.length > 0) {
    await kv.put(FEED_KEY, JSON.stringify(mergedAlerts), {
      expirationTtl: 86400 * 3, // 3 days
    });
  }

  // 4. Save scan metadata
  const meta: ScanMeta = {
    lastScanAt: Date.now(),
    scannedTokens: batch.length,
    alertsGenerated: newAlerts.length,
  };
  const prevMetaRaw = await kv.get(SCAN_META_KEY, 'json');
  const prevMeta = prevMetaRaw as ScanMeta | null;
  const metaChanged =
    !prevMeta ||
    prevMeta.scannedTokens !== meta.scannedTokens ||
    prevMeta.alertsGenerated !== meta.alertsGenerated;

  if (metaChanged || newAlerts.length > 0) {
    await kv.put(SCAN_META_KEY, JSON.stringify(meta), { expirationTtl: 86400 });
  }

  return newAlerts;
}

/**
 * Get the current alert feed from KV.
 */
export async function getAlertFeed(kv: KVNamespace): Promise<{
  alerts: RiskAlert[];
  scannedTokens: number;
  lastScanAt: number;
}> {
  const [alertsRaw, metaRaw] = await Promise.all([
    kv.get(FEED_KEY, 'json'),
    kv.get(SCAN_META_KEY, 'json'),
  ]);

  const alerts = (alertsRaw as RiskAlert[] | null) ?? [];
  const meta = (metaRaw as ScanMeta | null) ?? { lastScanAt: 0, scannedTokens: 0, alertsGenerated: 0 };

  return {
    alerts,
    scannedTokens: meta.scannedTokens,
    lastScanAt: meta.lastScanAt,
  };
}

export async function getAlertScannerDebug(kv: KVNamespace): Promise<{
  calibration: AlertCalibration | null;
  quality: AlertQualityMetrics | null;
}> {
  const [calibrationRaw, qualityRaw] = await Promise.all([
    kv.get(CALIBRATION_KEY, 'json').catch(() => null),
    kv.get(QUALITY_METRICS_KEY, 'json').catch(() => null),
  ]);
  return {
    calibration: (calibrationRaw as AlertCalibration | null) ?? null,
    quality: (qualityRaw as AlertQualityMetrics | null) ?? null,
  };
}

/** Convert tier to numeric rank for comparison (higher = safer) */
function tierRank(tier: RiskTier): number {
  switch (tier) {
    case 'safe': return 4;
    case 'caution': return 3;
    case 'danger': return 2;
    case 'rug': return 1;
  }
}

function tierLabel(tier: RiskTier): string {
  switch (tier) {
    case 'safe': return 'SAFE';
    case 'caution': return 'CAUTION';
    case 'danger': return 'DANGER';
    case 'rug': return 'CRITICAL';
  }
}
