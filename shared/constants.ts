// ── External API URLs ────────────────────────────────────

export const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';
export const RUGCHECK_API_BASE = 'https://api.rugcheck.xyz/v1';
export const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
export const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';

// ── Risk Scoring Weights ─────────────────────────────────

export const RISK_WEIGHTS = {
  honeypot: 0.20,
  lpLocked: 0.15,
  mintAuthority: 0.15,
  freezeAuthority: 0.10,
  topHolderPct: 0.15,
  liquidityDepth: 0.10,
  volumeHealth: 0.10,
  creatorReputation: 0.05,
} as const satisfies Record<string, number>;

// ── Cache TTLs (seconds) ─────────────────────────────────

export const RISK_CACHE_TTL = 60;       // 1 min
export const FEED_CACHE_TTL = 30;       // 30 sec
export const FEE_CACHE_TTL = 300;       // 5 min

// ── Risk Tier Thresholds ─────────────────────────────────

export const TIER_SAFE_MIN = 70;
export const TIER_CAUTION_MIN = 40;
export const TIER_DANGER_MIN = 10;
// Below TIER_DANGER_MIN = rug

// ── Bags SDK ─────────────────────────────────────────────

export const BAGS_RATE_LIMIT = 1000;    // req/hour
export const HELIUS_FREE_CREDITS = 50_000; // per month

// ── $SENT Token ──────────────────────────────────────────

export const SENT_MINT = 'Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS';

// ── Sentinel Team Wallets ─────────────────────────────────

/** Main Sentinel team / creator wallet (signs partner registration, receives creator fees) */
export const SENTINEL_TEAM_WALLET = '2QCjUJ7nUBxpKtG3JJdNkuuNdwzTYuZbotaHaybEQh89';

/** Holders reward pool — receives 30% of $SENT trading fees for redistribution */
export const SENTINEL_HOLDERS_WALLET = '4a6fi8i4Lr1TKNMUmProRzr958X4w6ErhCaui92QXFva';

// ── Insurance Pool ───────────────────────────────────────

export const INSURANCE_POOL_WALLET = '4a6fi8i4Lr1TKNMUmProRzr958X4w6ErhCaui92QXFva';

// ── Pump Intelligence ─────────────────────────────────────

/** Pump Score component weights — must sum to 1.0 */
export const PUMP_WEIGHTS = {
  momentum:     0.35,  // MS — "is it already moving?"
  fragility:    0.35,  // SFS — "is it pumpable?"
  coordination: 0.30,  // WCS — "organic or engineered?"
} as const;

/** Momentum sub-weights */
export const MOMENTUM_WEIGHTS = {
  volumeZ:     0.50,
  priceChange: 0.30,
  tradeCount:  0.20,
} as const;

/** Fragility sub-weights */
export const FRAGILITY_WEIGHTS = {
  liquidityInverse: 0.40,
  topHolderConc:    0.30,
  lpRisk:           0.30,
} as const;

/** Coordination sub-weights */
export const COORDINATION_WEIGHTS = {
  buySellPressure:       0.40,
  tradeIntensityInverse: 0.30,
  whaleRisk:             0.30,
} as const;

/** Phase classification thresholds */
export const PHASE_THRESHOLDS = {
  // COLLAPSE
  collapseMinLiquidityDropPct: 30,   // liquidity must drop >30%
  collapsePriceChangeMax:      -15,  // priceChange < -15%
  collapseSellBuyRatio:        1.5,  // sellVol > buyVol * 1.5

  // DISTRIBUTION
  distributionMinPriceChange:  0,    // priceChange > 0
  distributionSellBuyMin:      1.0,  // sellVol > buyVol

  // MANIPULATION
  manipulationPriceChangeMin:  20,   // priceChange > +20%
  manipulationTradeIntMax:     0.4,  // tradeIntensity < 0.4
  manipulationLiquidityMax:    50_000, // liquidity < $50K = "low"

  // ACCUMULATION
  accumulationPriceChangeMax:  10,   // priceChange < +10%
  accumulationBuySellTolerance: 0.2, // buyVol within ±20% of sellVol
} as const;
