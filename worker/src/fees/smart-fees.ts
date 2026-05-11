import type { SmartFeeSnapshot, SmartFeePosition, FeeUrgency, RiskTier } from '../../../shared/types';
import { fetchClaimablePositions } from './bags-fees';
import { computeRiskScore } from '../risk/engine';
import { cachedCompute } from '../../../shared/cache-helpers';

interface SmartFeeEnv {
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  BAGS_API_KEY?: string;
  SENTINEL_KV?: KVNamespace;
}

function determineUrgency(
  claimableUsd: number,
  riskScore: number | null,
  riskTier: RiskTier | null,
): { urgency: FeeUrgency; reason: string } {
  // No risk data — can't determine urgency
  if (riskScore === null || riskTier === null) {
    return { urgency: 'unknown', reason: 'Risk data unavailable' };
  }

  // CRITICAL: token is danger/rug AND has significant fees
  if ((riskTier === 'danger' || riskTier === 'rug') && claimableUsd > 0.01) {
    return {
      urgency: 'critical',
      reason: `Token risk is ${riskTier.toUpperCase()} (${riskScore}/100) — claim immediately before potential rug`,
    };
  }

  // WARNING: token is caution with meaningful fees
  if (riskTier === 'caution' && claimableUsd > 0.5) {
    return {
      urgency: 'warning',
      reason: `Token risk is CAUTION (${riskScore}/100) — claim soon, risk may increase`,
    };
  }

  // WARNING: large unclaimed amount regardless of risk
  if (claimableUsd > 10) {
    return {
      urgency: 'warning',
      reason: `Large unclaimed amount ($${claimableUsd.toFixed(2)}) — don't leave money on the table`,
    };
  }

  return { urgency: 'safe', reason: 'Token is healthy, fees are accruing normally' };
}

/**
 * Fetches claimable fees and enriches each position with risk score + urgency.
 * Positions are sorted by urgency: critical first, then warning, then safe.
 */
export async function fetchSmartFees(
  wallet: string,
  env: SmartFeeEnv,
): Promise<SmartFeeSnapshot> {
  // Step 1: Get raw fee positions
  const raw = await fetchClaimablePositions(wallet, env.BAGS_API_KEY);

  if (raw.positions.length === 0) {
    return {
      wallet,
      positions: [],
      totalClaimableUsd: 0,
      urgentClaimableUsd: 0,
      criticalCount: 0,
      lastUpdated: Date.now(),
    };
  }

  // Step 2: Score risk for each token (parallel, with cache via KV)
  const riskResults = await Promise.allSettled(
    raw.positions.map(async (pos) => {
      const score = await cachedCompute(
        env.SENTINEL_KV,
        `risk:${pos.tokenMint}`,
        60,
        () => computeRiskScore(pos.tokenMint, {
          HELIUS_API_KEY: env.HELIUS_API_KEY,
          BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
        }),
      );
      return { score: score.score, tier: score.tier };
    }),
  );

  // Step 3: Merge fees + risk + urgency
  let urgentClaimableUsd = 0;
  let criticalCount = 0;

  const positions: SmartFeePosition[] = raw.positions.map((pos, i) => {
    const riskResult = riskResults[i];
    const riskScore = riskResult.status === 'fulfilled' ? riskResult.value.score : null;
    const riskTier = riskResult.status === 'fulfilled' ? riskResult.value.tier : null;
    const { urgency, reason } = determineUrgency(pos.claimableUsd, riskScore, riskTier);

    if (urgency === 'critical') {
      urgentClaimableUsd += pos.claimableUsd;
      criticalCount++;
    } else if (urgency === 'warning') {
      urgentClaimableUsd += pos.claimableUsd;
    }

    return {
      ...pos,
      riskScore,
      riskTier,
      urgency,
      urgencyReason: reason,
    };
  });

  // Step 4: Sort by urgency (critical > warning > unknown > safe), then by USD desc
  const urgencyOrder: Record<FeeUrgency, number> = { critical: 0, warning: 1, unknown: 2, safe: 3 };
  positions.sort((a, b) => {
    const ud = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (ud !== 0) return ud;
    return b.claimableUsd - a.claimableUsd;
  });

  return {
    wallet,
    positions,
    totalClaimableUsd: raw.totalClaimableUsd,
    urgentClaimableUsd,
    criticalCount,
    lastUpdated: Date.now(),
  };
}
