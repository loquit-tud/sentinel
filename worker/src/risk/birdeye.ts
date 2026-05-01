import type { BirdeyeTokenSecurity, BirdeyeTokenOverview } from './types';
import { BIRDEYE_API_BASE as BIRDEYE_BASE } from '../../../shared/constants';

export async function fetchBirdeyeSecurity(
  mint: string,
  apiKey: string,
): Promise<BirdeyeTokenSecurity | null> {
  try {
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/token_security?address=${mint}`,
      { headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;     // 401 on free tier — graceful skip
    const json = await res.json() as { data: BirdeyeTokenSecurity; success: boolean };
    return json.success ? json.data : null;
  } catch {
    return null;
  }
}

export async function fetchBirdeyeOverview(
  mint: string,
  apiKey: string,
): Promise<BirdeyeTokenOverview | null> {
  try {
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/token_overview?address=${mint}`,
      { headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { data: BirdeyeTokenOverview; success: boolean };
    return json.success ? json.data : null;
  } catch {
    return null;
  }
}

// Imputed value used when Birdeye data is unavailable (not confirmed zero)
const IMPUTED_MISSING = 45;

export function analyzeBirdeye(
  security: BirdeyeTokenSecurity | null,
  overview: BirdeyeTokenOverview | null,
) {
  // Liquidity depth: normalize — $100K+ = 100, $0 = 0
  // null overview = data unavailable → impute conservatively, NOT 0
  const liquidityMissing = overview === null || overview.liquidity == null;
  const liquidity = overview?.liquidity ?? 0;
  const liquidityDepth = liquidityMissing
    ? IMPUTED_MISSING
    : Math.min((liquidity / 100_000) * 100, 100);

  // Volume health: $10K+ daily = healthy
  const volumeMissing = overview === null || overview.v24hUSD == null;
  const vol24h = overview?.v24hUSD ?? 0;
  const volumeHealth = volumeMissing
    ? IMPUTED_MISSING
    : Math.min((vol24h / 10_000) * 100, 100);

  // Top 10 holder concentration from Birdeye (fallback/complement to RugCheck)
  const top10Pct = (security?.top10HolderPercent ?? 0) * 100;
  const holderDistribution = Math.max(0, 100 - top10Pct);

  return {
    liquidityDepth,
    volumeHealth,
    liquidityMissing,
    volumeMissing,
    holderDistribution,
    price: overview?.price ?? 0,
    fdv: overview?.fdv ?? 0,
    volume24h: vol24h,
    holders: overview?.holder ?? 0,
    priceChange24h: overview?.priceChange24hPercent ?? 0,
  };
}
