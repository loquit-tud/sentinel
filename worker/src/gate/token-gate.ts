/**
 * Token Gate — $SENT holder verification.
 *
 * Uses Helius RPC `getTokenAccountsByOwner` to check if a wallet
 * holds any $SENT tokens. Premium features require minimum holding.
 *
 * Tiers:
 * - free: 0 $SENT (basic risk scores, discovery feed)
 * - holder: ≥1 $SENT (priority alerts, deeper scans, auto-claim)
 * - whale: ≥10,000 $SENT (API key, custom webhooks, bulk scanning)
 */
import { SENT_MINT, BIRDEYE_API_BASE } from '../../../shared/constants';

// ── Types ────────────────────────────────────────────────

export type GateTier = 'free' | 'holder' | 'whale';

export interface TokenGateResult {
  wallet: string;
  tier: GateTier;
  sentBalance: number;         // human-readable (not lamports)
  sentRawBalance: string;      // raw amount (string for BigInt)
  sentValueUsd: number;        // USD value of holdings
  sentPriceUsd: number;        // current $SENT price in USD
  eligible: boolean;           // true if tier >= required
  checkedAt: number;           // Unix ms
}

// ── Constants ────────────────────────────────────────────

const SENT_DECIMALS = 6;
const HOLDER_MIN = 1;            // 1 $SENT (fallback when price unavailable)
const WHALE_MIN = 10_000;        // 10,000 $SENT
const USD_HOLDER_MIN = 1.0;      // $1 USD equivalent (active when Birdeye key provided)

const GATE_CACHE_TTL = 300;      // 5 min cache in KV

// ── Core ─────────────────────────────────────────────────

/**
 * Check $SENT balance for a wallet via Helius RPC.
 * Returns the gate tier based on holdings.
 */
export async function checkTokenGate(
  wallet: string,
  heliusApiKey: string,
  kv?: KVNamespace,
  birdeyeApiKey?: string,
): Promise<TokenGateResult> {
  // Check cache first (cache key includes whether USD mode is active)
  const cacheKey = `gate:${birdeyeApiKey ? 'usd' : 'raw'}:${wallet}`;
  if (kv) {
    const cached = await kv.get(cacheKey, 'json');
    if (cached) return cached as TokenGateResult;
  }

  const [balance, sentPriceUsd] = await Promise.all([
    fetchSentBalance(wallet, heliusApiKey),
    birdeyeApiKey ? fetchSentPriceUsd(birdeyeApiKey) : Promise.resolve(0),
  ]);

  const humanBalance = balance / Math.pow(10, SENT_DECIMALS);
  const sentValueUsd = humanBalance * sentPriceUsd;

  let tier: GateTier;
  if (humanBalance >= WHALE_MIN) {
    tier = 'whale';
  } else if (birdeyeApiKey && sentPriceUsd > 0) {
    // USD-based gate: need $1 equivalent
    tier = sentValueUsd >= USD_HOLDER_MIN ? 'holder' : 'free';
  } else {
    // Fallback: 1 $SENT minimum
    tier = humanBalance >= HOLDER_MIN ? 'holder' : 'free';
  }

  const result: TokenGateResult = {
    wallet,
    tier,
    sentBalance: humanBalance,
    sentRawBalance: String(balance),
    sentValueUsd,
    sentPriceUsd,
    eligible: tier !== 'free',
    checkedAt: Date.now(),
  };

  // Cache result
  if (kv) {
    await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: GATE_CACHE_TTL });
  }

  return result;
}

/**
 * Quick tier check — returns tier without full result object.
 */
export async function getWalletTier(
  wallet: string,
  heliusApiKey: string,
  kv?: KVNamespace,
  birdeyeApiKey?: string,
): Promise<GateTier> {
  const result = await checkTokenGate(wallet, heliusApiKey, kv, birdeyeApiKey);
  return result.tier;
}

/**
 * Gate helper — returns true if wallet meets minimum tier.
 */
export async function requireTier(
  wallet: string,
  minTier: GateTier,
  heliusApiKey: string,
  kv?: KVNamespace,
  birdeyeApiKey?: string,
): Promise<{ allowed: boolean; actual: GateTier; sentBalance: number; sentValueUsd: number }> {
  const result = await checkTokenGate(wallet, heliusApiKey, kv, birdeyeApiKey);
  const tierRank: Record<GateTier, number> = { free: 0, holder: 1, whale: 2 };
  return {
    allowed: tierRank[result.tier] >= tierRank[minTier],
    actual: result.tier,
    sentBalance: result.sentBalance,
    sentValueUsd: result.sentValueUsd,
  };
}

// ── Birdeye Price ────────────────────────────────────────

async function fetchSentPriceUsd(birdeyeApiKey: string): Promise<number> {
  try {
    const res = await fetch(
      `${BIRDEYE_API_BASE}/defi/price?address=${SENT_MINT}`,
      {
        headers: { 'X-API-KEY': birdeyeApiKey, 'x-chain': 'solana' },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return 0;
    const json = await res.json() as { data?: { value?: number }; success: boolean };
    return (json.success && typeof json.data?.value === 'number') ? json.data.value : 0;
  } catch {
    return 0; // graceful: fallback to raw SENT count
  }
}

// ── Helius RPC ───────────────────────────────────────────

async function fetchSentBalance(wallet: string, heliusApiKey: string): Promise<number> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTokenAccountsByOwner',
    params: [
      wallet,
      { mint: SENT_MINT },
      { encoding: 'jsonParsed' },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.error(`Helius RPC ${res.status} for token gate check`);
    return 0; // graceful: treat as free tier on RPC failure
  }

  const data = await res.json() as {
    result?: {
      value?: Array<{
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: { amount: string; decimals: number; uiAmount: number };
              };
            };
          };
        };
      }>;
    };
  };

  const accounts = data.result?.value ?? [];
  if (accounts.length === 0) return 0;

  // Sum all token accounts (usually just 1)
  let total = 0;
  for (const acc of accounts) {
    const amount = acc.account.data.parsed.info.tokenAmount.amount;
    total += Number(amount);
  }

  return total;
}
