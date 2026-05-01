import type { RiskScore, TokenFeedItem, FeeSnapshot, SmartFeeSnapshot, MonitoredWallet, PendingClaim, ApiResponse, AlertFeed, RiskAlert, CreatorProfile } from '../../shared/types';

const API_URL = import.meta.env.VITE_API_URL ?? (
  import.meta.env.DEV
    ? 'http://127.0.0.1:8787'
    : 'https://sentinel-api.apiworkersdev.workers.dev'
);
const BASE = `${API_URL}/v1`;

// ── Auth (signature session) ──────────────────────────────

const SESSION_TOKEN_KEY = 'sentinel_session_token_v1';
const SESSION_WALLET_KEY = 'sentinel_session_wallet_v1';

export function getSessionToken(): string | null {
  try {
    const fromLocal = localStorage.getItem(SESSION_TOKEN_KEY);
    if (fromLocal && fromLocal.startsWith('sess_')) return fromLocal;
  } catch {
    // ignore
  }
  try {
    const fromSession = sessionStorage.getItem(SESSION_TOKEN_KEY);
    return fromSession && fromSession.startsWith('sess_') ? fromSession : null;
  } catch {
    return null;
  }
}

export function getSessionWallet(): string | null {
  try {
    const w = localStorage.getItem(SESSION_WALLET_KEY);
    return w && w.length >= 32 ? w : null;
  } catch {
    // ignore
  }
  try {
    const w = sessionStorage.getItem(SESSION_WALLET_KEY);
    return w && w.length >= 32 ? w : null;
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (!token) localStorage.removeItem(SESSION_TOKEN_KEY);
    else localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // ignore
  }
  // Fallback: some environments block localStorage writes (privacy settings).
  try {
    if (!token) sessionStorage.removeItem(SESSION_TOKEN_KEY);
    else sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

export function setSessionWallet(wallet: string | null): void {
  try {
    if (!wallet) localStorage.removeItem(SESSION_WALLET_KEY);
    else localStorage.setItem(SESSION_WALLET_KEY, wallet);
  } catch {
    // ignore
  }
  try {
    if (!wallet) sessionStorage.removeItem(SESSION_WALLET_KEY);
    else sessionStorage.setItem(SESSION_WALLET_KEY, wallet);
  } catch {
    // ignore
  }
}

function buildAuthHeaders(opts?: { wallet?: string | null }): Record<string, string> | undefined {
  const token = getSessionToken();
  if (token) return { Authorization: `Bearer ${token}` };
  if (opts?.wallet) return { 'x-wallet': opts.wallet };
  return undefined;
}

export interface AuthChallenge {
  challengeId: string;
  wallet: string;
  message: string;
  expiresAt: number;
}

export async function authChallenge(wallet: string): Promise<AuthChallenge> {
  const res = await fetch(`${BASE}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  const body: ApiResponse<AuthChallenge> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Auth challenge failed');
  return body.data;
}

export interface AuthVerifyResult {
  sessionToken: string;
  wallet: string;
  expiresAt: number;
}

export async function authVerify(params: { challengeId: string; wallet: string; signature: string }): Promise<AuthVerifyResult> {
  const res = await fetch(`${BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body: ApiResponse<AuthVerifyResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Auth verify failed');
  return body.data;
}

// ── Wallet X-Ray ─────────────────────────────────────────

export interface XRayToken {
  mint: string;
  amount: number;
  decimals: number;
  score: number | null;
  tier: string | null;
  breakdown: Record<string, number> | null;
  phase?: string;   // pump phase (accumulation/manipulation/distribution/collapse)
}

export interface XRayResult {
  wallet: string;
  holdings: XRayToken[];
  portfolioHealth: number;     // non-linear: Herfindahl + phase multipliers
  flaggedCount: number;
  maxRiskToken: string | null; // mint with highest individual risk contribution
  scannedAt: number;
}

export async function fetchWalletXRay(wallet: string): Promise<XRayResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/portfolio/${wallet}`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<XRayResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to scan wallet');
  return body.data;
}

// ── Risk ─────────────────────────────────────────────────

export async function fetchRiskScore(mint: string, wallet?: string | null): Promise<RiskScore> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/risk/${mint}`, {
      headers: buildAuthHeaders({ wallet }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<RiskScore> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Unknown error');
  return body.data;
}

export async function fetchTokenFeed(): Promise<TokenFeedItem[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/tokens/feed`);
  } catch {
    return [];
  }
  const body: ApiResponse<TokenFeedItem[]> = await res.json();
  if (!body.ok || !body.data) return [];
  return body.data;
}

export async function fetchFeeSnapshot(wallet: string): Promise<FeeSnapshot> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/fees/${wallet}`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<FeeSnapshot> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Unknown error');
  return body.data;
}

export interface ClaimTxData {
  transactions: Array<{
    tx: string;  // base58
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export async function fetchClaimTransactions(wallet: string, tokenMint: string): Promise<ClaimTxData> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/fees/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, tokenMint }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<ClaimTxData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to build claim transactions');
  return body.data;
}

// ── Smart Fee Intelligence ───────────────────────────────

export async function fetchSmartFees(wallet: string): Promise<SmartFeeSnapshot> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/fees/${wallet}/smart`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<SmartFeeSnapshot> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch smart fees');
  return body.data;
}

// ── Wallet Monitoring ────────────────────────────────────

export async function registerMonitor(
  wallet: string,
  telegramChatId?: string,
  thresholdUsd?: number,
  options?: {
    label?: string;
    watchedTokenMints?: string[];
    watchedCreatorWallets?: string[];
  },
): Promise<MonitoredWallet & { degraded?: boolean; persisted?: boolean; note?: string }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/monitor/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, telegramChatId, thresholdUsd, ...options }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<MonitoredWallet> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to register monitor');
  return body.data;
}

export async function unregisterMonitor(wallet: string): Promise<void> {
  try {
    await fetch(`${BASE}/monitor/${wallet}`, { method: 'DELETE' });
  } catch {
    // silent fail
  }
}

export async function sendMonitorTest(wallet: string, telegramChatId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/monitor/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, telegramChatId }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }

  const body: ApiResponse<{ sent: boolean }> = await res.json();
  if (!body.ok) {
    throw new Error(body.error ?? 'Failed to send Telegram test message');
  }
}

export async function connectMonitorAuto(
  wallet: string,
  thresholdUsd?: number,
  telegramUsername?: string,
  options?: {
    label?: string;
    watchedTokenMints?: string[];
    watchedCreatorWallets?: string[];
  },
): Promise<MonitoredWallet & { degraded?: boolean; persisted?: boolean; note?: string; resolvedChatId?: string; testSent?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/monitor/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, thresholdUsd, telegramUsername, ...options }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }

  const body: ApiResponse<MonitoredWallet & { degraded?: boolean; persisted?: boolean; note?: string; resolvedChatId?: string; testSent?: boolean }> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to connect monitor');
  return body.data;
}

// ── AutoClaim: Pending Claims ────────────────────────────

export async function fetchPendingClaim(claimId: string): Promise<PendingClaim> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/claims/${claimId}`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<PendingClaim> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Claim not found or expired');
  return body.data;
}

export async function markClaimDone(claimId: string): Promise<void> {
  try {
    await fetch(`${BASE}/claims/${claimId}/done`, { method: 'POST' });
  } catch {
    // non-critical
  }
}

export interface ApiStats {
  totalRequests: number;
  byEndpoint: { risk: number; fees: number; claim: number; feed: number };
  today: { date: string; total: number; risk: number; fees: number; claim: number; feed: number };
  yesterday: { date: string; total: number };
}

export async function fetchApiStats(): Promise<ApiStats | null> {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const body: ApiResponse<ApiStats> = await res.json();
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

// ── Pre-Rug Watch (evidence chain) ───────────────────────

export interface PreRugCatch {
  mint: string;
  symbol: string;
  name: string;
  initialScore: number;
  initialTier: 'safe' | 'caution' | 'danger' | 'rug';
  initialAt: number;
  caughtScore: number;
  caughtTier: 'safe' | 'caution' | 'danger' | 'rug';
  caughtAt: number;
  scoreDrop: number;
  tierTransition: string;
  reason: 'score_drop' | 'tier_crash';
  // Agent reasoning trace
  triggerSignals?: string[];
  creatorPrevRug?: boolean;
  // Agent Policy Decision
  agentDecision?: {
    action: 'monitor' | 'rescan_soon' | 'log_alert' | 'telegram_alert' | 'escalate';
    alertLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
    confidence: number;
    reasoning: string;
    decidedBy: 'llm' | 'heuristic';
    decidedAt: number;
  };
}

export interface WatchStats {
  tokensWatched: number;
  catches: number;
  lastRunAt: number;
  lastCatchAt: number | null;
  avgLeadTimeMs: number;
}

export async function fetchPreRugCatches(limit = 10): Promise<{ catches: PreRugCatch[]; stats: WatchStats } | null> {
  try {
    const res = await fetch(`${BASE}/watch/catches?limit=${limit}`);
    const body: ApiResponse<{ catches: PreRugCatch[]; stats: WatchStats }> = await res.json();
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

// ── Token Launch ─────────────────────────────────────────

export interface TokenInfoResult {
  tokenMint: string;
  metadataUrl: string;
}

export interface CreateTokenParams {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export async function createTokenInfo(params: CreateTokenParams): Promise<TokenInfoResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/token/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<TokenInfoResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to create token');
  return body.data;
}

export interface FeeClaimerEntry {
  user: string;
  userBps: number;
}

export interface FeeConfigResult {
  needsCreation: boolean;
  transactions: Array<{ tx: string; blockhash: string; lastValidBlockHeight: number }>;
  meteoraConfigKey: string;
}

export async function createFeeConfig(feeClaimers: FeeClaimerEntry[], payer: string): Promise<FeeConfigResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/token/fee-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feeClaimers, payer }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<FeeConfigResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to create fee config');
  return body.data;
}

export interface LaunchTxResult {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

// ── Risk Alert Feed ──────────────────────────────────────

export async function fetchAlertFeed(): Promise<AlertFeed> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/alerts/feed`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<AlertFeed> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch alert feed');
  return body.data;
}

export async function fetchAlertSubscriberCount(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/alerts/subscribers/count`);
    const body: ApiResponse<{ count: number }> = await res.json();
    if (!body.ok || typeof body.data?.count !== 'number') return null;
    return body.data.count;
  } catch {
    return null;
  }
}

// ── AI Explanation ────────────────────────────────────────

export interface RiskExplanation {
  why: string;
  pattern: string;
  action: string;
  confidence: 'high' | 'medium' | 'low';
  generatedAt: number;
}

export interface ExplainResult {
  mint: string;
  score: number;
  tier: string;
  explanation: RiskExplanation;
}

export async function explainRisk(mint: string, tokenName?: string): Promise<ExplainResult | null> {
  try {
    const res = await fetch(`${BASE}/risk/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint, tokenName }),
    });
    const body: ApiResponse<ExplainResult> = await res.json();
    if (!body.ok || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

export async function triggerAlertScan(): Promise<{ newAlerts: number; alerts: RiskAlert[] }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/alerts/scan`, { method: 'POST' });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<{ newAlerts: number; alerts: RiskAlert[] }> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Scan failed');
  return body.data;
}

// ── Creator Alerts (Telegram subscriptions) ───────────────

export async function resolveTelegramChatId(username?: string): Promise<string> {
  const res = await fetch(`${BASE}/alerts/telegram/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(username ? { username } : {}),
  });
  const body: ApiResponse<{ chatId: string }> = await res.json();
  if (!body.ok || !body.data?.chatId) throw new Error(body.error ?? 'Failed to resolve Telegram chatId');
  return body.data.chatId;
}

export async function subscribeAlerts(params: { chatId: string; wallet?: string }): Promise<string> {
  const res = await fetch(`${BASE}/alerts/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json() as ApiResponse<unknown> & { message?: string };
  if (!body.ok) throw new Error(body.error ?? 'Subscribe failed');
  return body.message ?? 'Subscribed';
}

export async function unsubscribeAlerts(chatId: string): Promise<void> {
  const res = await fetch(`${BASE}/alerts/subscribe`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const body: ApiResponse<unknown> = await res.json();
  if (!body.ok) throw new Error(body.error ?? 'Unsubscribe failed');
}

export async function fetchSubscription(chatId: string): Promise<{
  subscribed: boolean;
  chatId?: string;
  wallet?: string | null;
  createdAt?: number;
  updatedAt?: number;
}> {
  const res = await fetch(`${BASE}/alerts/subscription/${encodeURIComponent(chatId)}`);
  const body: ApiResponse<{
    subscribed: boolean;
    chatId?: string;
    wallet?: string | null;
    createdAt?: number;
    updatedAt?: number;
  }> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch subscription');
  return body.data;
}

export async function fetchTelegramBotInfo(): Promise<{ username: string; deepLink: string } | null> {
  try {
    const res = await fetch(`${BASE}/alerts/telegram/bot`);
    const body: ApiResponse<{ username: string; deepLink: string }> = await res.json();
    return body.ok && body.data?.username && body.data?.deepLink ? body.data : null;
  } catch {
    return null;
  }
}

// ── $SENT Fee Stats ─────────────────────────────────────

export interface SentFeeStats {
  sentMint: string;
  price: number;
  fdv: number;
  liquidity: number;
  volume24hUsd: number;
  volume7dUsd: number | null;
  totalFeesGenerated24hUsd: number;
  holdersShareDaily: number;
  holderCount: number;
  estimatedDailyPerHolder: number;
  feeRatePct: number;
  holderSharePct: number;
  updatedAt: number;
}

export async function fetchSentFeeStats(): Promise<SentFeeStats | null> {
  try {
    const res = await fetch(`${BASE}/sent/fee-stats`);
    if (!res.ok) return null;
    const body: ApiResponse<SentFeeStats> = await res.json();
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

// ── Creator Profile ──────────────────────────────────────

export async function fetchCreatorProfile(wallet: string): Promise<CreatorProfile> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/creator/${wallet}`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<CreatorProfile> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch creator profile');
  return body.data;
}

// ── Smart Trade ──────────────────────────────────────────

export interface SwapQuoteData {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  priceImpactPct: number;
  slippageMode: string;
  route: unknown;
}

export interface SwapQuoteWithRisk {
  quote: SwapQuoteData;
  risk: RiskScore | null;
}

export async function fetchSwapQuote(outputMint: string, amount: number, inputMint?: string): Promise<SwapQuoteWithRisk> {
  const params = new URLSearchParams({
    outputMint,
    amount: String(amount),
  });
  if (inputMint) params.set('inputMint', inputMint);

  let res: Response;
  try {
    res = await fetch(`${BASE}/trade/quote?${params}`);
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<SwapQuoteWithRisk> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to get swap quote');
  return body.data;
}

export interface SwapTxData {
  transactions: Array<{
    tx: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export async function fetchSwapTransaction(params: {
  outputMint: string;
  amount: number;
  walletAddress: string;
  inputMint?: string;
  slippageMode?: 'dynamic' | 'fixed';
  slippageBps?: number;
}): Promise<SwapTxData> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/trade/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<SwapTxData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to build swap transaction');
  return body.data;
}

// ── Token Launch ─────────────────────────────────────────

export async function createLaunchTransaction(params: {
  tokenMint: string;
  launchWallet: string;
  metadataUrl: string;
  configKey: string;
  initialBuyLamports: number;
}): Promise<LaunchTxResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/token/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`);
  }
  const body: ApiResponse<LaunchTxResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to create launch transaction');
  return body.data;
}

export interface LaunchGuardIssue {
  severity: 'positive' | 'warning' | 'critical';
  title: string;
  detail: string;
}

export interface LaunchGuardRecommendation {
  label: string;
  action: string;
}

export interface LaunchGuardData {
  launchWallet: string;
  readinessScore: number;
  verdict: 'ready' | 'review' | 'blocked';
  creatorTrustScore: number;
  creatorTrustTier: string;
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

export async function fetchLaunchGuard(params: {
  launchWallet: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  feeClaimers: FeeClaimerEntry[];
}): Promise<LaunchGuardData> {
  const res = await fetch(`${BASE}/token/launch-guard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body: ApiResponse<LaunchGuardData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to run launch guard');
  return body.data;
}

// ── Partner Integration ──────────────────────────────────

export interface PartnerConfigData {
  config: {
    partner: string;
    bps: number;
    totalClaimedFees: string;
    totalAccumulatedFees: string;
    totalLifetimeAccumulatedFees: string;
  } | null;
  registered: boolean;
}

export interface PartnerClaimStatsData {
  claimedFees: string;
  unclaimedFees: string;
  claimedFeesUsd: number;
  unclaimedFeesUsd: number;
}

export interface PartnerTxData {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function fetchPartnerConfig(wallet: string): Promise<PartnerConfigData> {
  const res = await fetch(`${BASE}/partner/${wallet}`);
  const body: ApiResponse<PartnerConfigData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch partner config');
  return body.data;
}

export async function registerPartner(wallet: string): Promise<PartnerTxData> {
  const res = await fetch(`${BASE}/partner/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  const body: ApiResponse<PartnerTxData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to register partner');
  return body.data;
}

export async function fetchPartnerStats(wallet: string): Promise<PartnerClaimStatsData> {
  const res = await fetch(`${BASE}/partner/${wallet}/stats`);
  const body: ApiResponse<PartnerClaimStatsData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch partner stats');
  return body.data;
}

export async function claimPartnerFees(wallet: string): Promise<PartnerTxData[]> {
  const res = await fetch(`${BASE}/partner/${wallet}/claim`, { method: 'POST' });
  const body: ApiResponse<PartnerTxData[]> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to claim partner fees');
  return body.data;
}

// ── Token Gate ($SENT) ───────────────────────────────────

export type GateTier = 'free' | 'holder' | 'whale';

export interface TokenGateData {
  wallet: string;
  tier: GateTier;
  sentBalance: number;
  sentRawBalance: string;
  sentValueUsd: number;    // USD value of holdings
  sentPriceUsd: number;    // current $SENT price
  eligible: boolean;
  checkedAt: number;
}

export async function fetchTokenGate(wallet: string): Promise<TokenGateData> {
  const res = await fetch(`${BASE}/gate/${wallet}`);
  const body: ApiResponse<TokenGateData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to check token gate');
  return body.data;
}

export async function checkAccess(wallet: string, requiredTier: GateTier = 'holder'): Promise<{
  allowed: boolean;
  actual: GateTier;
  sentBalance: number;
  requiredTier: GateTier;
}> {
  const res = await fetch(`${BASE}/gate/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, requiredTier }),
  });
  const body = await res.json() as ApiResponse<{ allowed: boolean; actual: GateTier; sentBalance: number; requiredTier: GateTier }>;
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to check access');
  return body.data;
}

// ── App Store Info ───────────────────────────────────────

export interface AppStoreInfoData {
  name: string;
  tagline: string;
  description: string;
  category: string;
  token: { symbol: string; mint: string; bagsUrl: string };
  links: { dashboard: string; api: string; github: string; dorahacks: string; docs: string };
  features: string[];
  version: string;
  updatedAt: string;
}

export interface SentFeeShareData {
  tokenMint: string;
  tokenSymbol: string;
  allocations: { creatorPct: number; holdersPct: number; devFundPct: number; partnerPct: number };
  feeClaimers: Array<{ label: string; wallet: string; bps: number }>;
}

export async function fetchAppInfo(): Promise<AppStoreInfoData> {
  const res = await fetch(`${BASE}/app/info`);
  const body: ApiResponse<AppStoreInfoData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch app info');
  return body.data;
}

export async function fetchSentFeeShare(): Promise<SentFeeShareData> {
  const res = await fetch(`${BASE}/app/fee-share`);
  const body: ApiResponse<SentFeeShareData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch fee share config');
  return body.data;
}

// ── Leaderboard ──────────────────────────────────────────

export interface LeaderboardEntry {
  wallet: string;
  displayName: string | null;
  scansPerformed: number;
  rugsDetected: number;
  shareCount: number;
  portfolioHealth: number | null;
  rank: number;
  sentBalance: number;
  tier: 'free' | 'holder' | 'whale';
}

export interface LeaderboardData {
  entries: LeaderboardEntry[];
  totalUsers: number;
  period: 'weekly' | 'alltime';
  updatedAt: number;
}

export async function fetchLeaderboard(period: 'weekly' | 'alltime' = 'weekly'): Promise<LeaderboardData> {
  const res = await fetch(`${BASE}/leaderboard?period=${period}`);
  const body: ApiResponse<LeaderboardData> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch leaderboard');
  return body.data;
}

// ── Share Card ───────────────────────────────────────────

export function getShareCardUrl(mint: string): string {
  return `${API_URL}/v1/card/${mint}`;
}

export function getSharePageUrl(mint: string): string {
  const dashUrl = import.meta.env.DEV
    ? 'http://localhost:5173'
    : 'https://sentinel-dashboard-3uy.pages.dev';
  return `${dashUrl}?risk=${mint}`;
}

export function buildTweetUrl(mint: string, score: number, tier: string, symbol: string): string {
  const text = `${tierEmoji(tier)} ${symbol || mint.slice(0, 8)} scored ${score}/100 (${tier.toUpperCase()}) on @SentinelOnBags\n\nCheck any Bags token before you ape 👇`;
  const url = getSharePageUrl(mint);
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

function tierEmoji(tier: string): string {
  switch (tier) {
    case 'safe': return '🟢';
    case 'caution': return '🟡';
    case 'danger': return '🟠';
    case 'rug': return '🔴';
    default: return '⚪';
  }
}

// ── Fee Revenue Analytics ────────────────────────────────

export interface FeePositionAnalytics {
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  claimableUsd: number;
  riskScore: number | null;
  riskTier: string | null;
  urgency: string;
  estimatedApy: number | null;
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
  riskAdjustedScore: number;
  safePositionsPct: number;
  analyzedAt: number;
}

export async function fetchFeeAnalytics(wallet: string): Promise<FeeRevenueAnalytics> {
  let res: Response;
  try { res = await fetch(`${BASE}/fees/${wallet}/analytics`); }
  catch (err) { throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`); }
  const body: ApiResponse<FeeRevenueAnalytics> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch fee analytics');
  return body.data;
}

// ── Fee-Share Simulator ──────────────────────────────────

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

export async function simulateFeeShare(params: {
  expectedDailyVolumeUsd: number;
  feeRateBps: number;
  allocations: Array<{ label: string; bps: number }>;
}): Promise<FeeSimulationResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/fees/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) { throw new Error(`Network error: ${err instanceof Error ? err.message : 'fetch failed'}`); }
  const body: ApiResponse<FeeSimulationResult> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to simulate fees');
  return body.data;
}

// ── Creator Card ─────────────────────────────────────────

export function getCreatorCardUrl(wallet: string): string {
  return `${API_URL}/v1/card/creator/${wallet}`;
}

export function buildCreatorTweetUrl(wallet: string, score: number, tier: string): string {
  const shortWallet = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  const emoji = tier === 'safe' ? '🟢' : tier === 'caution' ? '🟡' : tier === 'danger' ? '🟠' : '🔴';
  const label = tier === 'safe' ? 'TRUSTED' : tier === 'caution' ? 'MIXED' : tier === 'danger' ? 'SUSPICIOUS' : 'RUGGER';
  const text = `${emoji} Creator ${shortWallet} scored ${score}/100 (${label}) on @SentinelOnBags\n\nCheck any creator before you trade 👇`;
  const dashUrl = import.meta.env.DEV ? 'http://localhost:5173' : 'https://sentinel-dashboard-3uy.pages.dev';
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(dashUrl)}`;
}

// ── Creator Trust Score ──────────────────────────────────

export interface CreatorTrustSignals {
  tokenAge: number;
  serialLauncher: boolean;
  rugRatio: number;
  avgTokenLifespan: number;
  lpRemovalCount: number;
  mintAuthorityActive: number;
  avgHolderConcentration: number;
  feeConsistency: number;
}

export interface CreatorTrustScore {
  wallet: string;
  trustScore: number;
  trustTier: string;
  signals: CreatorTrustSignals;
  riskFlags: string[];
  verdict: string;
  computedAt: number;
}

export async function fetchCreatorTrust(wallet: string): Promise<CreatorTrustScore> {
  const res = await fetch(`${BASE}/creator/${wallet}/trust`);
  const body: ApiResponse<CreatorTrustScore> = await res.json();
  if (!body.ok || !body.data) throw new Error(body.error ?? 'Failed to fetch trust score');
  return body.data;
}

// ── Launch Survival Engine ───────────────────────────────

export interface AttackScenario {
  name: string;
  triggered: boolean;
  severity: number;
  explanation: string;
}

export interface SurvivalResult {
  survivalScore: number;
  survivalLabel: 'Safe' | 'Vulnerable' | 'High Risk' | 'Critical';
  scenarios: {
    sniper: AttackScenario;
    dump: AttackScenario;
    wash: AttackScenario;
  };
  worstScenario: 'sniper' | 'dump' | 'wash' | null;
  recommendation: string;
}

export async function runStressTest(input: {
  liquidity: number;
  lpLockHours: number;
  devWalletPct: number;
  holderCount: number;
  topHolderPct: number;
  volume?: number;
  totalTrades?: number;
}): Promise<SurvivalResult> {
  const res = await fetch(`${BASE}/launch/stress-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json() as { ok: boolean; error?: string } & Partial<SurvivalResult>;
  if (!body.ok) throw new Error(body.error ?? 'Stress test failed');
  return body as SurvivalResult;
}
