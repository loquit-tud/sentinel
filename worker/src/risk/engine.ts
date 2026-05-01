import { RISK_WEIGHTS } from '../../../shared/constants';
import type { RiskScore, RiskBreakdown, TokenStats24h } from '../../../shared/types';
import { tierFromScore } from '../../../shared/types';
import { fetchRugCheckReport, analyzeRugCheck } from './rugcheck';
import { fetchBirdeyeOverview, analyzeBirdeye } from './birdeye';
import { fetchTopHolders, analyzeHeliusHolders } from './helius';
import { computePumpSignal, median, mad, computeMarketSensitivity } from './phase';
import type { PhaseInput } from './phase';

export interface EngineEnv {
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
}

export interface MarketBaseline {
  baselineVolume: number;
  baselineSpread: number;
  sensitivity: number;
}

/** Compute market baseline from a list of 24h volumes across the feed */
export function computeMarketBaseline(volumes: number[], priceChanges: number[]): MarketBaseline {
  return {
    baselineVolume: median(volumes),
    baselineSpread: mad(volumes),
    sensitivity: computeMarketSensitivity(priceChanges),
  };
}

export async function computeRiskScore(
  mint: string,
  env: EngineEnv,
  stats24h?: TokenStats24h | null,
  liquidity?: number,
  topHolderPctFeed?: number,
  baseline?: MarketBaseline,
  prevLiquidity?: number,
  prevTopHolderPct?: number,
): Promise<RiskScore> {
  // Fetch all sources in parallel
  // Note: Birdeye token_security requires paid plan (401 on free tier),
  // and the 401 triggers rate limiting on subsequent requests.
  // We get security data from RugCheck instead.
  const [rugReport, birdOverview, heliusHolders] = await Promise.all([
    fetchRugCheckReport(mint),
    env.BIRDEYE_API_KEY
      ? fetchBirdeyeOverview(mint, env.BIRDEYE_API_KEY)
      : Promise.resolve(null),
    env.HELIUS_API_KEY
      ? fetchTopHolders(mint, env.HELIUS_API_KEY)
      : Promise.resolve([]),
  ]);

  // Analyze each source
  const rug = rugReport ? analyzeRugCheck(rugReport) : null;
  const bird = analyzeBirdeye(null, birdOverview);
  const helius = analyzeHeliusHolders(heliusHolders);

  // Build breakdown from best available data
  const breakdown: RiskBreakdown = {
    honeypot: rug?.honeypot ?? 50,
    lpLocked: rug?.lpLocked ?? 50,
    mintAuthority: rug?.mintAuthority ?? 50,
    freezeAuthority: rug?.freezeAuthority ?? 50,
    topHolderPct: rug?.topHolderPct ?? helius.topHolderConcentration,
    liquidityDepth: bird.liquidityDepth,
    volumeHealth: bird.volumeHealth,
    creatorReputation: rug?.creatorReputation ?? 50,
  };

  // Instant rug flag override
  if (rug?.ruggedFlag) {
    return {
      mint,
      score: 0,
      tier: 'rug',
      breakdown: { ...breakdown, honeypot: 0 },
      timestamp: Date.now(),
      cached: false,
    };
  }

  // Track which signals had missing data (imputed, not confirmed)
  const missingSignals: string[] = [];
  if (bird.liquidityMissing) missingSignals.push('liquidityDepth');
  if (bird.volumeMissing) missingSignals.push('volumeHealth');

  // Data confidence: fraction of total weight covered by real data
  const missingWeight =
    (bird.liquidityMissing ? RISK_WEIGHTS.liquidityDepth : 0) +
    (bird.volumeMissing ? RISK_WEIGHTS.volumeHealth : 0);
  const dataConfidence = Math.round((1 - missingWeight) * 100) / 100;

  // Weighted score calculation
  const rawScore = Math.round(
    breakdown.honeypot * RISK_WEIGHTS.honeypot +
    breakdown.lpLocked * RISK_WEIGHTS.lpLocked +
    breakdown.mintAuthority * RISK_WEIGHTS.mintAuthority +
    breakdown.freezeAuthority * RISK_WEIGHTS.freezeAuthority +
    breakdown.topHolderPct * RISK_WEIGHTS.topHolderPct +
    breakdown.liquidityDepth * RISK_WEIGHTS.liquidityDepth +
    breakdown.volumeHealth * RISK_WEIGHTS.volumeHealth +
    breakdown.creatorReputation * RISK_WEIGHTS.creatorReputation
  );

  // Tier ceiling when critical market data is missing:
  //   both liq+vol missing → max 'caution' (cannot call it safe without market data)
  //   one missing          → max 'caution' (uncertainty penalty)
  const score = missingSignals.length > 0
    ? Math.min(rawScore, 69)   // 69 = just below 'safe' threshold (70)
    : rawScore;

  // Compute pump signal if Bags stats24h data is available
  let pumpSignal: RiskScore['pumpSignal'] = undefined;
  if (stats24h) {
    const effectiveLiquidity = liquidity ?? bird.liquidityDepth * 1000;
    const effectiveTopHolder = topHolderPctFeed ?? breakdown.topHolderPct;
    const lpLockedBool = (rug?.lpLocked ?? 50) >= 50;

    const phaseInput: PhaseInput = {
      priceChange24h: stats24h.priceChange,
      buyVolume: stats24h.buyVolume,
      sellVolume: stats24h.sellVolume,
      numBuys: stats24h.numBuys,
      numSells: stats24h.numSells,
      numTraders: stats24h.numTraders,
      liquidity: effectiveLiquidity,
      topHolderPct: effectiveTopHolder,
      lpLocked: lpLockedBool,
      baselineVolume: baseline?.baselineVolume,
      baselineSpread: baseline?.baselineSpread,
      sensitivity: baseline?.sensitivity,
      prevLiquidity,
      prevTopHolderPct,
    };
    pumpSignal = computePumpSignal(phaseInput);
  }

  return {
    mint,
    score,
    tier: tierFromScore(score),
    breakdown,
    timestamp: Date.now(),
    cached: false,
    pumpSignal,
    ...(missingSignals.length > 0 && { missingSignals, dataConfidence }),
  };
}
