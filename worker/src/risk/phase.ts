/**
 * Phase Classification Engine
 *
 * Classifies a token into one of 5 behavioral phases using Bags stats24h data.
 * Based on ChatGPT-validated decision tree (April 2026 research session).
 *
 * Phase priority (evaluated top → bottom):
 *   1. COLLAPSE    — active exit, liquidity draining, price cratering
 *   2. DISTRIBUTION — smart money exiting into retail liquidity
 *   3. MANIPULATION — few wallets controlling price (low traders, high impact)
 *   4. ACCUMULATION — silent positioning before move
 *   5. UNCERTAIN    — fallback
 *
 * All data comes from Bags stats24h (no candles needed).
 */

import type { TokenPhase, PumpDerivedMetrics, PumpSignal, PumpScoreBreakdown } from '../../../shared/types';
import {
  PUMP_WEIGHTS,
  MOMENTUM_WEIGHTS,
  FRAGILITY_WEIGHTS,
  COORDINATION_WEIGHTS,
  PHASE_THRESHOLDS as T,
} from '../../../shared/constants';

export interface PhaseInput {
  // From Bags stats24h
  priceChange24h: number;    // % (e.g. +15.3 or -42.0)
  buyVolume: number;         // USD
  sellVolume: number;        // USD
  numBuys: number;
  numSells: number;
  numTraders: number;
  // From token info / RugCheck
  liquidity: number;         // USD
  topHolderPct: number;      // 0-100
  lpLocked: boolean;
  // Market baseline (computed externally from full feed)
  baselineVolume?: number;   // median volume across feed
  baselineSpread?: number;   // MAD of volume across feed
  sensitivity?: number;      // adaptive sensitivity factor (default 1.0)
  // Previous snapshot for delta computation
  prevLiquidity?: number;
  prevTopHolderPct?: number;
}

// ── Derived metrics ──────────────────────────────────────

export function computeDerivedMetrics(input: PhaseInput): PumpDerivedMetrics {
  const { buyVolume, sellVolume, numBuys, numSells, numTraders, liquidity, topHolderPct } = input;
  const totalTrades = numBuys + numSells;
  const totalVolume = buyVolume + sellVolume;

  return {
    buySellRatio: buyVolume / Math.max(sellVolume, 1),
    tradeIntensity: numTraders / Math.max(totalTrades, 1),
    liquidityStress: totalVolume / Math.max(liquidity, 1),
    whaleRisk: topHolderPct,
  };
}

// ── Market-normalized z-score ────────────────────────────

function zScore(value: number, baseline: number, spread: number): number {
  if (spread === 0) return 0;
  return (value - baseline) / spread;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

// ── Sub-score calculators ────────────────────────────────

function computeMomentumScore(input: PhaseInput, derived: PumpDerivedMetrics, sensitivity: number): number {
  const totalVolume = input.buyVolume + input.sellVolume;

  // Volume z-score (normalized vs market baseline if available)
  let volZ = 0;
  if (input.baselineVolume !== undefined && input.baselineSpread !== undefined && input.baselineSpread > 0) {
    volZ = zScore(totalVolume, input.baselineVolume, input.baselineSpread);
  } else {
    // Fallback: $10K volume = 1.0 normalized
    volZ = totalVolume / 10_000;
  }
  const volScore = clamp(volZ * 20 * sensitivity); // z=5 → score=100

  // Price change normalized (0-100, 50% change = 100)
  const priceScore = clamp(Math.abs(input.priceChange24h) / 50 * 100);

  // Trade count (log scale, 1000 trades = 100)
  const totalTrades = input.numBuys + input.numSells;
  const tradeScore = clamp(Math.log10(Math.max(totalTrades, 1)) / 3 * 100);

  return clamp(
    MOMENTUM_WEIGHTS.volumeZ * volScore +
    MOMENTUM_WEIGHTS.priceChange * priceScore +
    MOMENTUM_WEIGHTS.tradeCount * tradeScore,
  );
}

function computeFragilityScore(input: PhaseInput): number {
  // Low liquidity = high fragility (token is pumpable)
  const liquidityNorm = clamp(input.liquidity / 100_000 * 100); // $100K = 100
  const liquidityScore = clamp(100 - liquidityNorm); // inverted

  // Top holder concentration (already 0-100, higher = worse = more fragile)
  const holderScore = clamp(input.topHolderPct);

  // LP risk (unlocked = fragile)
  const lpScore = input.lpLocked ? 0 : 100;

  return clamp(
    FRAGILITY_WEIGHTS.liquidityInverse * liquidityScore +
    FRAGILITY_WEIGHTS.topHolderConc * holderScore +
    FRAGILITY_WEIGHTS.lpRisk * lpScore,
  );
}

function computeCoordinationScore(derived: PumpDerivedMetrics): number {
  // High buy pressure = potential coordinated push
  // buySellRatio: 1.0 = neutral, 3.0+ = extreme buy pressure → score 100
  const buySellScore = clamp((derived.buySellRatio - 1) / 2 * 100);

  // Low tradeIntensity = few wallets doing many trades = coordination signal (inverted)
  const intensityScore = clamp((1 - derived.tradeIntensity) * 100);

  // Whale risk = concentration in few hands
  const whaleScore = clamp(derived.whaleRisk);

  return clamp(
    COORDINATION_WEIGHTS.buySellPressure * buySellScore +
    COORDINATION_WEIGHTS.tradeIntensityInverse * intensityScore +
    COORDINATION_WEIGHTS.whaleRisk * whaleScore,
  );
}

// ── Phase decision tree ──────────────────────────────────

function classifyPhase(input: PhaseInput, derived: PumpDerivedMetrics): { phase: TokenPhase; confidence: number } {
  const liquidityDropPct = input.prevLiquidity
    ? ((input.prevLiquidity - input.liquidity) / Math.max(input.prevLiquidity, 1)) * 100
    : 0;

  // 1. COLLAPSE — highest priority
  if (
    liquidityDropPct >= T.collapseMinLiquidityDropPct &&
    input.priceChange24h <= T.collapsePriceChangeMax &&
    input.sellVolume > input.buyVolume * T.collapseSellBuyRatio
  ) {
    const conf = clamp(70 + Math.min(liquidityDropPct - T.collapseMinLiquidityDropPct, 25));
    return { phase: 'collapse', confidence: conf };
  }

  // 2. DISTRIBUTION — smart money exiting
  if (
    input.priceChange24h >= T.distributionMinPriceChange &&
    input.sellVolume > input.buyVolume * T.distributionSellBuyMin &&
    input.numSells > input.numBuys
  ) {
    const conf = clamp(60 + Math.min((input.sellVolume / Math.max(input.buyVolume, 1) - 1) * 20, 30));
    return { phase: 'distribution', confidence: conf };
  }

  // 3. MANIPULATION — few wallets, high impact
  if (
    input.priceChange24h >= T.manipulationPriceChangeMin &&
    derived.tradeIntensity < T.manipulationTradeIntMax &&
    input.liquidity < T.manipulationLiquidityMax
  ) {
    const conf = clamp(70 + Math.min((T.manipulationTradeIntMax - derived.tradeIntensity) * 100, 25));
    return { phase: 'manipulation', confidence: conf };
  }

  // 4. ACCUMULATION — quiet positioning
  if (
    input.priceChange24h < T.accumulationPriceChangeMax &&
    Math.abs(derived.buySellRatio - 1) < T.accumulationBuySellTolerance &&
    input.liquidity >= T.manipulationLiquidityMax
  ) {
    const conf = input.lpLocked ? 80 : 65;
    return { phase: 'accumulation', confidence: conf };
  }

  // 5. UNCERTAIN — fallback
  return { phase: 'uncertain', confidence: 50 };
}

// ── Reasoning generator ──────────────────────────────────

function generateReasoning(
  input: PhaseInput,
  derived: PumpDerivedMetrics,
  phase: TokenPhase,
): string {
  const reasons: string[] = [];

  // Delta-based signals (if previous snapshot available)
  if (input.prevLiquidity !== undefined) {
    const liquidityDropPct = ((input.prevLiquidity - input.liquidity) / Math.max(input.prevLiquidity, 1)) * 100;
    if (liquidityDropPct >= 30) reasons.push(`liquidity dropped ${liquidityDropPct.toFixed(0)}%`);
    else if (liquidityDropPct >= 15) reasons.push(`liquidity declining (−${liquidityDropPct.toFixed(0)}%)`);
  }

  if (input.prevTopHolderPct !== undefined) {
    const holderDelta = input.topHolderPct - input.prevTopHolderPct;
    if (holderDelta >= 5) reasons.push(`wallet concentration increased +${holderDelta.toFixed(1)}%`);
    else if (holderDelta <= -5) reasons.push(`wallet concentration dispersing`);
  }

  // Current signal summary
  if (derived.buySellRatio >= 2.0) reasons.push(`strong buy pressure (${derived.buySellRatio.toFixed(1)}x)`);
  else if (derived.buySellRatio <= 0.5) reasons.push(`heavy sell pressure (${derived.buySellRatio.toFixed(2)}x)`);

  if (derived.tradeIntensity < 0.3) reasons.push(`low trader diversity suggests concentrated activity`);
  else if (derived.tradeIntensity > 0.7) reasons.push(`broad retail participation`);

  if (derived.liquidityStress > 2.0) reasons.push(`volume ${derived.liquidityStress.toFixed(1)}x pool size — pool under stress`);

  if (!input.lpLocked) reasons.push(`LP unlocked — rug risk elevated`);

  // Phase-specific explanations
  switch (phase) {
    case 'manipulation':
      reasons.push(`low-trader high-impact movement suggests coordinated activity`);
      break;
    case 'distribution':
      reasons.push(`classic distribution — smart money exiting into retail`);
      break;
    case 'collapse':
      reasons.push(`active exit event in progress`);
      break;
    case 'accumulation':
      reasons.push(`quiet positioning — potential pre-move setup`);
      break;
  }

  if (reasons.length === 0) return 'insufficient signal data for detailed analysis';
  return reasons.join(' — ');
}

// ── Main export ──────────────────────────────────────────

export function computePumpSignal(input: PhaseInput): PumpSignal {
  const sensitivity = input.sensitivity ?? 1.0;
  const derived = computeDerivedMetrics(input);

  const momentumScore     = computeMomentumScore(input, derived, sensitivity);
  const fragilityScore    = computeFragilityScore(input);
  const coordinationScore = computeCoordinationScore(derived);

  const pumpScore = clamp(
    PUMP_WEIGHTS.momentum * momentumScore +
    PUMP_WEIGHTS.fragility * fragilityScore +
    PUMP_WEIGHTS.coordination * coordinationScore,
  );

  const { phase, confidence } = classifyPhase(input, derived);
  const reasoning = generateReasoning(input, derived, phase);

  const breakdown: PumpScoreBreakdown = {
    momentumScore: Math.round(momentumScore),
    fragilityScore: Math.round(fragilityScore),
    coordinationScore: Math.round(coordinationScore),
  };

  return {
    pumpScore: Math.round(pumpScore),
    phase,
    confidence: Math.round(confidence),
    reasoning,
    breakdown,
    derived,
    computedAt: Date.now(),
  };
}

// ── Market baseline helpers ──────────────────────────────

/** Compute median of an array (robust vs outliers) */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute Median Absolute Deviation (MAD) — robust spread measure */
export function mad(values: number[]): number {
  if (values.length === 0) return 1;
  const m = median(values);
  const deviations = values.map(v => Math.abs(v - m));
  return Math.max(median(deviations), 1); // never 0
}

/** Adaptive sensitivity: tighter when market is hot, looser when quiet */
export function computeMarketSensitivity(priceChanges: number[]): number {
  if (priceChanges.length === 0) return 1.0;
  const m = median(priceChanges.map(Math.abs));
  const spread = mad(priceChanges.map(Math.abs));
  const volatilityIndex = m + spread;
  // High volatility (>20% avg change) → sensitivity 0.7, low (<5%) → 1.3
  if (volatilityIndex > 20) return 0.7;
  if (volatilityIndex < 5) return 1.3;
  return 1.0;
}
