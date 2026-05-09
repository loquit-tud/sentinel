import type { TokenFeedItem, TokenStats24h } from '../../../shared/types';
import { BAGS_API_BASE } from '../../../shared/constants';

/** Raw Bags API response shape for top tokens by lifetime fees */
interface BagsLeaderboardItem {
  token: string;
  lifetimeFees: string;
  tokenInfo: {
    id: string;
    name: string;
    symbol: string;
    icon: string;
    decimals: number;
    fdv: number;
    mcap: number;
    usdPrice: number;
    liquidity: number;
    holderCount: number;
    stats24h?: {
      priceChange: number;
      buyVolume: number;
      sellVolume: number;
      numBuys: number;
      numSells: number;
      numTraders: number;
    };
  } | null;
  creators: Array<{ wallet: string; royaltyBps: number }> | null;
  tokenSupply: { amount: string; decimals: number; uiAmount: number } | null;
  tokenLatestPrice: { price: number; priceUSD: number } | null;
}

interface BagsApiResponse {
  success: boolean;
  response: BagsLeaderboardItem[];
}

/** Raw Bags API response shape for the token launch feed (recent/active launches) */
interface BagsLaunchFeedItem {
  name: string;
  symbol: string;
  description: string;
  image: string;
  tokenMint: string;
  status: 'PRE_LAUNCH' | 'PRE_GRAD' | 'MIGRATING' | 'MIGRATED';
  twitter?: string | null;
  website?: string | null;
  // Bonding curve pool key — holds real SOL liquidity for PRE_GRAD tokens
  dbcPoolKey?: string;
  dbcConfigKey?: string;
  launchSignature?: string;
  accountKeys?: string[];
}

interface BagsLaunchFeedResponse {
  success: boolean;
  response: BagsLaunchFeedItem[];
}

/**
 * Fetch recent/active token launches — the volatile pool where rugs happen.
 * These are PRE_GRAD and MIGRATING tokens (fresh, not yet established).
 */
export async function fetchRecentLaunches(apiKey?: string): Promise<TokenFeedItem[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(`${BAGS_API_BASE}/token-launch/feed`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`Bags launch feed API ${res.status}: ${res.statusText}`);
    return [];
  }

  const body = await res.json() as BagsLaunchFeedResponse;
  if (!body.success || !Array.isArray(body.response)) {
    console.error('Bags launch feed API error or unexpected format');
    return [];
  }

  // Focus on tokens that are live but not yet graduated — highest rug risk window
  const filtered = body.response.filter((item) => item.status === 'PRE_GRAD' || item.status === 'MIGRATING');
  console.log(`[bags-feed] total=${body.response.length} pre_grad+migrating=${filtered.length}`);
  return filtered
    .map((item): TokenFeedItem => ({
      mint: item.tokenMint,
      name: item.name,
      symbol: item.symbol,
      imageUrl: item.image ?? '',
      createdAt: 0,
      volume24h: 0,
      fdv: 0,
      priceChangePct24h: 0,
      riskScore: null,
      riskTier: null,
      lifetimeFees: 0,
      liquidity: 0,
      stats24h: null,
      dbcPoolKey: item.dbcPoolKey,
      accountKeys: item.accountKeys,
    }));
}

export async function fetchTopTokens(apiKey?: string): Promise<TokenFeedItem[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(`${BAGS_API_BASE}/token-launch/top-tokens/lifetime-fees`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`Bags API ${res.status}: ${res.statusText}`);
    return [];
  }

  const body = await res.json() as BagsApiResponse;
  if (!body.success || !Array.isArray(body.response)) {
    console.error('Bags API error or unexpected format');
    return [];
  }

  return body.response
    .filter((item) => item.tokenInfo !== null)
    .map((item): TokenFeedItem => {
      const info = item.tokenInfo!;
      const stats = info.stats24h;
      const volume24h = (stats?.buyVolume ?? 0) + (stats?.sellVolume ?? 0);

      const stats24h: TokenStats24h | null = stats
        ? {
            priceChange: stats.priceChange,
            buyVolume: stats.buyVolume,
            sellVolume: stats.sellVolume,
            numBuys: stats.numBuys,
            numSells: stats.numSells,
            numTraders: stats.numTraders,
          }
        : null;

      return {
        mint: item.token,
        name: info.name,
        symbol: info.symbol,
        imageUrl: info.icon ?? '',
        createdAt: 0,
        volume24h,
        fdv: info.fdv ?? 0,
        priceChangePct24h: stats?.priceChange ?? 0,
        riskScore: null,
        riskTier: null,
        lifetimeFees: parseFloat(item.lifetimeFees) || 0,
        liquidity: info.liquidity ?? 0,
        stats24h,
      };
    });
}
