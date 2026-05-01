/**
 * Sentinel API Client for MCP Server
 * Calls the deployed Sentinel Worker API via HTTP.
 */

export interface SentinelClientOptions {
  baseUrl: string;
}

export interface RiskScore {
  mint: string;
  score: number;
  tier: 'safe' | 'caution' | 'danger' | 'rug';
  breakdown: {
    honeypot: number;
    lpLocked: number;
    mintAuthority: number;
    freezeAuthority: number;
    topHolderPct: number;
    liquidityDepth: number;
    volumeHealth: number;
    creatorReputation: number;
  };
  timestamp: number;
  cached: boolean;
}

export interface TokenFeedItem {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string;
  volume24h: number;
  fdv: number;
  priceChangePct24h: number;
  riskScore: number | null;
  riskTier: string | null;
  lifetimeFees: number;
}

export interface ClaimablePosition {
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  claimableAmount: number;
  claimableUsd: number;
}

export interface FeeSnapshot {
  wallet: string;
  positions: ClaimablePosition[];
  totalClaimableUsd: number;
}

export interface WalletXRayResult {
  wallet: string;
  holdings: Array<{
    mint: string;
    amount: number;
    decimals: number;
    score: number | null;
    tier: string | null;
  }>;
  portfolioHealth: number;
  flaggedCount: number;
  scannedAt: number;
}

export interface CreatorProfile {
  wallet: string;
  totalTokens: number;
  ruggedCount: number;
  safeCount: number;
  avgRiskScore: number;
  reputationScore: number;
  reputationTier: 'safe' | 'caution' | 'danger' | 'rug';
  tokens: Array<{
    mint: string;
    name: string;
    symbol: string;
    riskScore: number;
    riskTier: 'safe' | 'caution' | 'danger' | 'rug';
    rugged: boolean;
    lifetimeFees: number;
  }>;
  scannedAt: number;
}

export interface ApiStats {
  totalRequests: number;
  byEndpoint: {
    risk: number;
    fees: number;
    claim: number;
    feed: number;
  };
  today: {
    date: string;
    total: number;
    risk: number;
    fees: number;
    claim: number;
    feed: number;
  };
  yesterday: {
    date: string;
    total: number;
  };
}

export interface HealthStatus {
  status: string;
  service: string;
  version: string;
  pillars: string[];
}

// ── Partner Types ────────────────────────────────────────

export interface PartnerConfig {
  partner: string;
  bps: number;
  totalClaimedFees: string;
  totalAccumulatedFees: string;
  totalLifetimeAccumulatedFees: string;
}

export interface PartnerClaimStats {
  claimedFees: string;
  unclaimedFees: string;
  claimedFeesUsd: number;
  unclaimedFeesUsd: number;
}

// ── Token Gate Types ─────────────────────────────────────

export type GateTier = 'free' | 'holder' | 'whale';

export interface TokenGateResult {
  wallet: string;
  tier: GateTier;
  sentBalance: number;
  sentRawBalance: string;
  eligible: boolean;
  checkedAt: number;
}

// ── App Store Types ──────────────────────────────────────

export interface AppStoreInfo {
  name: string;
  tagline: string;
  description: string;
  category: string;
  token: { symbol: string; mint: string; bagsUrl: string };
  links: Record<string, string>;
  features: string[];
  version: string;
  updatedAt: string;
}

export interface SentFeeShareConfig {
  tokenMint: string;
  tokenSymbol: string;
  allocations: { creatorPct: number; holdersPct: number; devFundPct: number; partnerPct: number };
  feeClaimers: Array<{ label: string; wallet: string; bps: number }>;
}

// ── Trade Types ──────────────────────────────────────────

export interface TradeQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  riskScore: number | null;
  riskTier: string | null;
}

// ── Smart Fee Types ──────────────────────────────────────

export interface SmartFeePosition {
  tokenMint: string;
  tokenSymbol: string;
  claimableUsd: number;
  riskScore: number | null;
  riskTier: string | null;
  urgency: 'high' | 'medium' | 'low';
}

export interface SmartFeeSnapshot {
  wallet: string;
  positions: SmartFeePosition[];
  totalClaimableUsd: number;
  highUrgencyCount: number;
}

// ── Alert Types ──────────────────────────────────────────

export interface AlertItem {
  id: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  mint: string;
  message: string;
  timestamp: number;
}

export class SentinelClient {
  private baseUrl: string;

  constructor(options: SentinelClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: { 'Accept': 'application/json', ...options?.headers },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }

    const data = await response.json();
    // Worker returns { ok, data, error } wrapper
    if (data && typeof data === 'object' && 'ok' in data) {
      if (!data.ok) throw new Error(data.error || 'API error');
      return data.data as T;
    }
    return data as T;
  }

  /** Get risk score (0-100) for a Solana token mint */
  async getRiskScore(mint: string): Promise<RiskScore> {
    return this.request<RiskScore>(`/v1/risk/${encodeURIComponent(mint)}`);
  }

  /** Get top tokens by lifetime fees on Bags */
  async getTokenFeed(): Promise<TokenFeedItem[]> {
    return this.request<TokenFeedItem[]>('/v1/tokens/feed');
  }

  /** Get claimable fee positions for a wallet */
  async getClaimableFees(wallet: string): Promise<FeeSnapshot> {
    return this.request<FeeSnapshot>(`/v1/fees/${encodeURIComponent(wallet)}`);
  }

  /** Get wallet portfolio x-ray with per-holding risk context */
  async getWalletXRay(wallet: string): Promise<WalletXRayResult> {
    return this.request<WalletXRayResult>(`/v1/portfolio/${encodeURIComponent(wallet)}`);
  }

  /** Get creator reputation profile */
  async getCreatorProfile(wallet: string): Promise<CreatorProfile> {
    return this.request<CreatorProfile>(`/v1/creator/${encodeURIComponent(wallet)}`);
  }

  /** Public health endpoint */
  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/health');
  }

  /** Public stats endpoint */
  async getStats(): Promise<ApiStats> {
    return this.request<ApiStats>('/stats');
  }

  // ── Partner Integration ────────────────────────────────

  /** Get partner config for a wallet */
  async getPartnerConfig(wallet: string): Promise<{ config: PartnerConfig | null; registered: boolean }> {
    return this.request<{ config: PartnerConfig | null; registered: boolean }>(`/v1/partner/${encodeURIComponent(wallet)}`);
  }

  /** Get partner claim stats */
  async getPartnerStats(wallet: string): Promise<PartnerClaimStats> {
    return this.request<PartnerClaimStats>(`/v1/partner/${encodeURIComponent(wallet)}/stats`);
  }

  // ── Token Gate ─────────────────────────────────────────

  /** Check $SENT token gate tier for a wallet */
  async checkTokenGate(wallet: string): Promise<TokenGateResult> {
    return this.request<TokenGateResult>(`/v1/gate/${encodeURIComponent(wallet)}`);
  }

  // ── App Store ──────────────────────────────────────────

  /** Get Sentinel app store info */
  async getAppInfo(): Promise<AppStoreInfo> {
    return this.request<AppStoreInfo>('/v1/app/info');
  }

  /** Get $SENT fee share target config */
  async getSentFeeShare(): Promise<SentFeeShareConfig> {
    return this.request<SentFeeShareConfig>('/v1/app/fee-share');
  }

  // ── Trade Intelligence ─────────────────────────────────

  /** Get swap quote with risk context */
  async getTradeQuote(inputMint: string, outputMint: string, amount: string): Promise<TradeQuote> {
    const params = new URLSearchParams({ inputMint, outputMint, amount });
    return this.request<TradeQuote>(`/v1/trade/quote?${params}`);
  }

  // ── Smart Fees ─────────────────────────────────────────

  /** Get risk-aware fee urgency snapshot */
  async getSmartFees(wallet: string): Promise<SmartFeeSnapshot> {
    return this.request<SmartFeeSnapshot>(`/v1/fees/${encodeURIComponent(wallet)}/smart`);
  }

  // ── Alerts ─────────────────────────────────────────────

  /** Get alert feed */
  async getAlertFeed(): Promise<AlertItem[]> {
    return this.request<AlertItem[]>('/v1/alerts/feed');
  }
}
