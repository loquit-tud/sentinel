/**
 * $SENT token live stats — volume, fees generated, holder count, per-holder estimate.
 * Used by the fee-stats display endpoint and the dashboard widget.
 */
import { BIRDEYE_API_BASE, SENT_MINT } from '../../../shared/constants';

// Bags charges 1% (100 bps) trading fee on $SENT transactions.
// Of that, 30% goes to $SENT holders per the fee-share config.
const BAGS_FEE_BPS = 100;          // 1%
const HOLDER_SHARE_PCT = 0.30;     // 30% of fees → holders

export interface SentFeeStats {
  sentMint: string;
  price: number;
  fdv: number;
  liquidity: number;
  volume24hUsd: number;
  volume7dUsd: number | null;       // estimated: 7 × 24h (Birdeye free tier has no 7d)
  totalFeesGenerated24hUsd: number; // 1% of 24h volume
  holdersShareDaily: number;        // 30% of fees → holders
  holderCount: number;
  estimatedDailyPerHolder: number;  // holdersShareDaily / holderCount
  feeRatePct: number;               // 1.0
  holderSharePct: number;           // 30.0
  updatedAt: number;
}

interface BirdeyeOverviewRaw {
  address: string;
  price: number;
  fdv: number;
  liquidity: number;
  v24hUSD: number;
  holder: number;
}

export async function fetchSentFeeStats(birdeyeApiKey: string): Promise<SentFeeStats> {
  const res = await fetch(
    `${BIRDEYE_API_BASE}/defi/token_overview?address=${SENT_MINT}`,
    {
      headers: { 'X-API-KEY': birdeyeApiKey, 'x-chain': 'solana' },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    throw new Error(`Birdeye overview error: ${res.status}`);
  }

  const json = await res.json() as { data: BirdeyeOverviewRaw; success: boolean };
  if (!json.success || !json.data) {
    throw new Error('Birdeye returned no data for $SENT');
  }

  const d = json.data;
  const feesGenerated24h = (d.v24hUSD * BAGS_FEE_BPS) / 10_000;
  const holdersShare = feesGenerated24h * HOLDER_SHARE_PCT;
  const holderCount = Math.max(d.holder ?? 1, 1);

  return {
    sentMint: SENT_MINT,
    price: d.price ?? 0,
    fdv: d.fdv ?? 0,
    liquidity: d.liquidity ?? 0,
    volume24hUsd: d.v24hUSD ?? 0,
    volume7dUsd: d.v24hUSD ? d.v24hUSD * 7 : null,
    totalFeesGenerated24hUsd: feesGenerated24h,
    holdersShareDaily: holdersShare,
    holderCount,
    estimatedDailyPerHolder: holdersShare / holderCount,
    feeRatePct: (BAGS_FEE_BPS / 100),
    holderSharePct: HOLDER_SHARE_PCT * 100,
    updatedAt: Date.now(),
  };
}
