// ── Risk Scoring ──────────────────────────────────────────

export type RiskTier = 'safe' | 'caution' | 'danger' | 'rug';

export interface RiskBreakdown {
  honeypot: number;       // 0-100 (0 = definitely honeypot)
  lpLocked: number;       // 0-100 (100 = fully locked)
  mintAuthority: number;  // 0 or 100 (100 = revoked)
  freezeAuthority: number;// 0 or 100 (100 = revoked)
  topHolderPct: number;   // 0-100 (lower = better distribution)
  liquidityDepth: number; // 0-100 (higher = deeper)
  volumeHealth: number;   // 0-100 (organic volume patterns)
  creatorReputation: number; // 0-100 (based on Bags history)
}

export interface RiskScore {
  mint: string;
  score: number;          // 0-100 (higher = safer)
  tier: RiskTier;
  breakdown: RiskBreakdown;
  timestamp: number;      // Unix ms
  cached: boolean;
  pumpSignal?: PumpSignal; // optional — present when Bags stats24h data available
  /** Signals where data was unavailable — score was imputed, not measured */
  missingSignals?: string[];
  /** 0.0–1.0 — how much of the score is based on real data */
  dataConfidence?: number;
  /** Volume spiked 300%+ in 24h — possible pump-before-dump pattern */
  volumeVelocitySpike?: boolean;
}

export function tierFromScore(score: number): RiskTier {
  if (score >= 70) return 'safe';
  if (score >= 40) return 'caution';
  if (score >= 10) return 'danger';
  return 'rug';
}

// ── Agent Policy ──────────────────────────────────────────

export type AgentAction =
  | 'monitor'         // continue normal scan cycle
  | 'rescan_soon'     // reschedule to 2-5 min (early warning)
  | 'log_alert'       // record internally, suppress broadcast
  | 'telegram_alert'  // broadcast to Telegram
  | 'escalate';       // maximum urgency, active collapse

export interface AgentPolicyDecision {
  action: AgentAction;
  alertLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;   // 0-100
  reasoning: string;    // 1-sentence decision rationale
  dynamicRescanMs?: number;  // if set, reschedule sooner than 15min
  decidedBy: 'llm' | 'heuristic';
  decidedAt: number;
}

export interface AgentPolicyInput {
  score: number;
  prevScore?: number;
  scoreDrop: number;
  tierTransition?: string;
  breakdown: RiskBreakdown;
  phase?: TokenPhase;
  trend?: TokenTrend;
  creatorPrevRug: boolean;
  memory?: {
    snapshots: Array<{ score: number; ts: number; phase?: string }>;
    lastReasoning: string;
  };
}

// ── Agent Decision Log ───────────────────────────────────

export type AgentDecision = 'ESCALATE' | 'WATCH' | 'SUPPRESS' | 'DOWNGRADE';

export type AgentReasonCode =
  | 'LIQUIDITY_COLLAPSE'
  | 'HOLDER_CONCENTRATION'
  | 'VOLUME_ANOMALY'
  | 'CREATOR_RISK'
  | 'AUTHORITY_RISK'
  | 'REPEAT_ALERT'
  | 'LOW_CONFIDENCE'
  | 'SOURCE_OUTAGE'
  | 'RISK_DECREASED';

export type AgentNextAction =
  | 'SEND_ALERT'
  | 'MONITOR_1H'
  | 'RECHECK_NEXT_CYCLE'
  | 'SUPPRESS_REPEAT'
  | 'NO_ACTION';

export interface AgentDecisionLog {
  id: string;
  cycleId: string;
  timestamp: string;
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  decision: AgentDecision;
  confidence: number; // 0.0 - 1.0
  riskScoreBefore?: number;
  riskScoreAfter: number;
  scoreRange?: {
    min: number;
    max: number;
  };
  reasonCodes: AgentReasonCode[];
  reason: string;
  nextAction: AgentNextAction;
  missingSources: string[];
  suppressedRepeats?: number;
  evidence?: {
    liquidityDropPct?: number;
    scoreDrop?: number;
    riskScoreBefore?: number;
    riskScoreAfter?: number;
    holderConcentrationPct?: number;
    volumeChangePct?: number;
    rugcheckRugged?: boolean;
    creatorTrustScore?: number;
  };
}

// ── Buy Guard ─────────────────────────────────────────────

export type BuyVerdict = 'safe' | 'caution' | 'avoid';

export interface BuyDecision {
  verdict: BuyVerdict;
  confidence: number;   // 0-100
  reasons: string[];    // top 2 factors (red flags or strengths)
  worstCase: string;    // expected outcome if pattern repeats
}

// ── Pump Intelligence ────────────────────────────────────

export type TokenPhase =
  | 'accumulation'
  | 'manipulation'
  | 'distribution'
  | 'collapse'
  | 'uncertain';

export type TokenTrend =
  | 'accumulating'
  | 'pumping'
  | 'distributing'
  | 'dying'
  | 'stable';

/** Derived behavioral metrics computed from Bags stats24h */
export interface PumpDerivedMetrics {
  buySellRatio: number;       // buyVolume / sellVolume (>1 = buy pressure)
  tradeIntensity: number;     // numTraders / (numBuys + numSells) (low = few wallets, many trades)
  liquidityStress: number;    // totalVolume / liquidity (high = pool under pressure)
  whaleRisk: number;          // topHolderPct normalized 0-100
}

/** 3-component pump score decomposition */
export interface PumpScoreBreakdown {
  momentumScore: number;       // MS: 0-100 (is it already moving?)
  fragilityScore: number;      // SFS: 0-100 (is it pumpable? low liquidity + concentrated)
  coordinationScore: number;   // WCS: 0-100 (organic vs engineered?)
}

export interface PumpSignal {
  pumpScore: number;           // 0-100 final weighted score
  phase: TokenPhase;           // classified market phase
  confidence: number;          // 0-100 confidence in phase classification
  reasoning: string;           // human-readable explanation
  breakdown: PumpScoreBreakdown;
  derived: PumpDerivedMetrics;
  computedAt: number;          // Unix ms
}

// ── Fee Optimizer ────────────────────────────────────────

export interface ClaimablePosition {
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  claimableAmount: number;  // in SOL or token units
  claimableUsd: number;
  source: 'fee-share-v1' | 'fee-share-v2' | 'partner';
}

export interface FeeSnapshot {
  wallet: string;
  positions: ClaimablePosition[];
  totalClaimableUsd: number;
  lastUpdated: number;     // Unix ms
}

// ── Smart Fee Intelligence ───────────────────────────────

export type FeeUrgency = 'critical' | 'warning' | 'safe' | 'unknown';

export interface SmartFeePosition extends ClaimablePosition {
  riskScore: number | null;     // 0-100
  riskTier: RiskTier | null;
  urgency: FeeUrgency;
  urgencyReason: string;        // human-readable reason
}

export interface SmartFeeSnapshot {
  wallet: string;
  positions: SmartFeePosition[];
  totalClaimableUsd: number;
  urgentClaimableUsd: number;   // only critical + warning
  criticalCount: number;
  lastUpdated: number;
}

// ── Wallet Monitoring ────────────────────────────────────

export interface MonitoredWallet {
  wallet: string;
  telegramChatId?: string;      // optional Telegram destination
  autoClaimThresholdUsd: number; // notify/auto-claim when above this
  registeredAt: number;          // Unix ms
  lastNotifiedAt: number;        // Unix ms (0 = never)
  lastClaimableUsd: number;      // last known amount
  label?: string;
  watchedTokenMints?: string[];
  watchedCreatorWallets?: string[];
  lastTokenScores?: Record<string, number>;
  lastCreatorTrustScores?: Record<string, number>;
}

// ── Pending Claims (AutoClaim) ───────────────────────────

export interface PendingClaim {
  id: string;                    // unique claim ID (nanoid)
  wallet: string;                // creator wallet
  positions: SmartFeePosition[]; // positions to claim
  totalClaimableUsd: number;
  urgentClaimableUsd: number;
  criticalCount: number;
  createdAt: number;             // Unix ms
  expiresAt: number;             // Unix ms (1h TTL)
  status: 'pending' | 'claimed' | 'expired';
}

// ── Token Feed ───────────────────────────────────────────

export interface TokenStats24h {
  priceChange: number;     // % price change
  buyVolume: number;       // USD
  sellVolume: number;      // USD
  numBuys: number;
  numSells: number;
  numTraders: number;
}

export interface TokenFeedItem {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string;
  createdAt: number;       // Unix ms
  volume24h: number;       // USD
  fdv: number;             // USD
  priceChangePct24h: number;
  riskScore: number | null;
  riskTier: RiskTier | null;
  lifetimeFees: number;    // USD
  liquidity: number;       // USD — needed for pump scoring
  stats24h: TokenStats24h | null; // raw Bags trading stats
  pumpSignal?: PumpSignal; // computed pump intelligence
  // Bags PRE_GRAD-only: bonding curve pool address (used by DBC pool monitor for direct on-chain liquidity tracking)
  dbcPoolKey?: string;
  // Bags PRE_GRAD-only: full account list from launch tx; used to resolve the WSOL quote vault on first sight
  accountKeys?: string[];
}

// ── API Responses ────────────────────────────────────────

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── Risk Alerts ──────────────────────────────────────────

export type AlertType =
  | 'tier_change'        // token moved from safe→caution, caution→danger, etc.
  | 'lp_unlock'          // LP was locked, now unlocked
  | 'lp_drain'           // LP liquidity actively draining (rug in progress)
  | 'holder_spike'       // top holder concentration jumped significantly
  | 'mint_authority'     // mint authority was NOT revoked (or was re-enabled)
  | 'new_danger'         // new token scored danger/rug on first scan
  | 'creator_rug_history'; // creator has history of rugged tokens

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface RiskAlert {
  id: string;               // unique alert ID
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;             // "BONK dropped from SAFE to DANGER"
  description: string;       // detailed explanation
  previousScore: number | null;
  currentScore: number;
  previousTier: RiskTier | null;
  currentTier: RiskTier;
  timestamp: number;         // Unix ms
  creatorWallet: string | null;
  /** Risk endpoint metadata at time of alert (optional) */
  dataConfidence?: number;     // 0.0–1.0
  missingSignals?: string[];   // e.g. ["liquidityDepth","volumeHealth"]
  // LP drain specific fields
  liquidityUsd?: number;       // current liquidity in USD
  prevLiquidityUsd?: number;   // previous liquidity in USD
  liquidityDropPct?: number;   // % drop since last scan
  /** RugCheck market evidence (optional, best-effort) */
  marketPubkey?: string;
  lpMint?: string;
  lpLockedPct?: number;        // 0-100
  lpLockedUsd?: number;        // USD value of locked LP (if available)
  /**
   * LP drain confirmation marker.
   * - true: confirmed across multiple scans (or catastrophic drop)
   * - false: early warning / unconfirmed single-scan signal
   * Undefined for non-lp_drain alerts.
   */
  confirmed?: boolean;
}

export interface AlertFeed {
  alerts: RiskAlert[];
  scannedTokens: number;
  lastScanAt: number;       // Unix ms
}

// ── Creator Reputation ───────────────────────────────────

export interface CreatorToken {
  mint: string;
  name: string;
  symbol: string;
  riskScore: number;
  riskTier: RiskTier;
  rugged: boolean;
  createdAt: number;         // Unix ms (0 if unknown)
  lifetimeFees: number;
}

export interface CreatorProfile {
  wallet: string;
  totalTokens: number;
  ruggedCount: number;
  safeCount: number;
  avgRiskScore: number;
  reputationScore: number;   // 0-100 (higher = more trustworthy)
  reputationTier: RiskTier;
  tokens: CreatorToken[];
  scannedAt: number;         // Unix ms
}

// ── Leaderboard ──────────────────────────────────────────

export interface LeaderboardEntry {
  wallet: string;
  displayName: string | null;   // optional alias
  scansPerformed: number;
  rugsDetected: number;
  shareCount: number;
  portfolioHealth: number | null; // latest health score
  rank: number;
  sentBalance: number;           // $SENT held
  tier: 'free' | 'holder' | 'whale';
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  totalUsers: number;
  period: 'weekly' | 'alltime';
  updatedAt: number;             // Unix ms
}

// ── Fee Revenue Analytics ────────────────────────────────

export interface FeePositionAnalytics {
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  claimableUsd: number;
  riskScore: number | null;
  riskTier: RiskTier | null;
  urgency: FeeUrgency;
  /** Annualized yield estimate based on recent fee accrual vs token FDV */
  estimatedApy: number | null;
  /** Fee accrual velocity — USD per day estimate */
  dailyAccrualUsd: number | null;
}

export interface FeeRevenueAnalytics {
  wallet: string;
  positions: FeePositionAnalytics[];
  totalClaimableUsd: number;
  totalDailyAccrualUsd: number;
  projectedMonthlyUsd: number;
  projectedYearlyUsd: number;
  topEarner: { mint: string; symbol: string; dailyUsd: number } | null;
  riskAdjustedScore: number;       // 0-100 (weighted by safe vs risky positions)
  safePositionsPct: number;        // % of value in safe-tier tokens
  analyzedAt: number;
}

// ── Fee-Share Simulator ──────────────────────────────────

export interface FeeSimulationInput {
  /** Expected daily volume in USD */
  expectedDailyVolumeUsd: number;
  /** Fee rate in basis points (e.g. 100 = 1%) */
  feeRateBps: number;
  /** Allocation splits — must sum to 10000 */
  allocations: Array<{ label: string; bps: number }>;
}

export interface FeeSimulationResult {
  dailyFeesUsd: number;
  weeklyFeesUsd: number;
  monthlyFeesUsd: number;
  yearlyFeesUsd: number;
  perRecipient: Array<{
    label: string;
    bps: number;
    pctShare: number;
    dailyUsd: number;
    monthlyUsd: number;
    yearlyUsd: number;
  }>;
  comparisonToMedian: {
    medianDailyVolumeUsd: number;
    yourVsMedianPct: number;
  };
}

// ── Autonomous Firewall ──────────────────────────────────

export type FirewallDecision = 'ALLOW' | 'WARN' | 'BLOCK';

export interface FirewallRule {
  id: string;
  tokenMint: string;
  tokenSymbol?: string;
  action: 'whitelist' | 'block';
  reason?: string;
  createdAt: number;
}

export interface FirewallScreenResult {
  decision: FirewallDecision;
  riskScore: number;
  riskTier: RiskTier;
  reasons: string[];
  rulesApplied: string[];
  estimatedRiskUsd: number;
  screenedAt: number;
}

export interface FirewallWalletConfig {
  wallet: string;
  rules: FirewallRule[];
  autoBlockRug: boolean;
  autoBlockDanger: boolean;
  autoBlockLpDrain: boolean;
  updatedAt: number;
}

export interface FirewallStats {
  totalScreened: number;
  totalBlocked: number;
  totalWarned: number;
  estimatedSavedUsd: number;
  topBlockedTokens: Array<{ mint: string; symbol: string; count: number }>;
  updatedAt: number;
}

export interface FirewallLogEntry {
  wallet: string;
  tokenMint: string;
  tokenSymbol: string;
  decision: FirewallDecision;
  riskScore: number;
  riskTier: RiskTier;
  amountUsd: number;
  reasons: string[];
  screenedAt: number;
}

// ── Insurance Pool ───────────────────────────────────────

export type InsuranceClaimStatus = 'pending' | 'approved' | 'denied';

export interface InsuranceCommitment {
  wallet: string;
  amountSent: number;
  tier: 'backer' | 'guardian' | 'whale-shield';
  committedAt: number;
  txSignature?: string;
}

export interface InsuranceClaim {
  id: string;
  wallet: string;
  tokenMint: string;
  tokenSymbol: string;
  lossEstimateUsd: number;
  riskScoreAtEntry: number;
  riskScoreNow: number;
  status: InsuranceClaimStatus;
  reason: string;
  evidence: string;
  submittedAt: number;
  resolvedAt?: number;
}

export interface InsurancePoolStats {
  totalCommittedSent: number;
  totalCommittors: number;
  totalClaimsPaid: number;
  totalClaimsSubmitted: number;
  pendingClaimsCount: number;
  poolHealthPct: number;
  lastUpdated: number;
}

// ── Creator Trust Score (advanced) ───────────────────────

export interface CreatorTrustSignals {
  tokenAge: number;            // avg age in days across tokens
  serialLauncher: boolean;     // >5 tokens in 30 days
  rugRatio: number;            // rugged / total (0-1)
  avgTokenLifespan: number;    // days before abandonment or rug
  lpRemovalCount: number;      // tokens where LP was pulled
  mintAuthorityActive: number; // tokens with mint authority still active
  avgHolderConcentration: number; // avg top5 holder % across tokens
  feeConsistency: number;      // 0-1 (1 = consistently generates fees)
}

export interface CreatorTrustScore {
  wallet: string;
  trustScore: number;          // 0-100 (higher = more trustworthy)
  trustTier: RiskTier;
  signals: CreatorTrustSignals;
  riskFlags: string[];         // human-readable flags like "Serial launcher", "LP puller"
  verdict: string;             // one-liner summary
  computedAt: number;
}

// ── Launch Guard ────────────────────────────────────────

export interface LaunchGuardIssue {
  severity: 'positive' | 'warning' | 'critical';
  title: string;
  detail: string;
}

export interface LaunchGuardRecommendation {
  label: string;
  action: string;
}

export interface LaunchGuardResult {
  launchWallet: string;
  readinessScore: number;
  verdict: 'ready' | 'review' | 'blocked';
  creatorTrustScore: number;
  creatorTrustTier: RiskTier;
  feeConfigScore: number;
  metadataScore: number;
  topRecipientPct: number;
  uniqueRecipients: number;
  issues: LaunchGuardIssue[];
  recommendations: LaunchGuardRecommendation[];
  simulatedDailyFeesUsd: number;
  simulatedMonthlyFeesUsd: number;
  generatedAt: number;
}

// ── Risk Scenario Simulator ──────────────────────────────

export type RugScenario =
  | 'lp_pull'           // LP removed entirely
  | 'mint_exploit'      // infinite mint flood
  | 'whale_dump'        // top holder sells 100%
  | 'freeze_attack'     // freeze authority exercised on holders
  | 'slow_rug'          // gradual sell-off over days
  | 'honeypot_activate'; // honeypot flag flipped post-launch

export interface RugSimulationInput {
  mint: string;
  scenarios?: RugScenario[];   // if omitted, run all applicable
}

export interface ScenarioResult {
  scenario: RugScenario;
  applicable: boolean;         // can this scenario actually happen?
  probability: 'low' | 'medium' | 'high' | 'critical';
  estimatedLossPct: number;    // 0-100 (% of holder value lost)
  estimatedTimeframe: string;  // "instant", "minutes", "hours", "days"
  explanation: string;         // human-readable
  mitigations: string[];       // what users can do
}

export interface RugSimulationResult {
  mint: string;
  tokenSymbol: string;
  currentScore: number;
  currentTier: RiskTier;
  scenarios: ScenarioResult[];
  worstCase: ScenarioResult | null;
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  simulatedAt: number;
}

// ── Proof Mode ──────────────────────────────────────────

export interface ProofModeResult {
  mint: string;
  amountUsd: number;
  highlights: string[];
  screen: FirewallScreenResult | null;
  simulation: RugSimulationResult;
  generatedAt: number;
}
