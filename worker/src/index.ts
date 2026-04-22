import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { computeRiskScore } from './risk/engine';
import { fetchTopTokens } from './feed/bags';
import { tierFromScore } from '../../shared/types';
import type { TokenFeedItem, RiskScore } from '../../shared/types';
import { fetchClaimablePositions, fetchClaimTransactions } from './fees/bags-fees';
import { fetchSmartFees } from './fees/smart-fees';
import { createTokenInfo, createLaunchTransaction, createFeeShareConfig } from './token/launch';
import type { FeeClaimerEntry } from './token/launch';
import { evaluateLaunchGuard } from './token/launch-guard';
import { scanWallet } from './portfolio/scanner';
import { getSwapQuote, buildSwapTransaction, WSOL_MINT } from './trade/swap';
import { runAlertScan, getAlertFeed } from './alerts/scanner';
import { buildCreatorProfile } from './creator/profiler';
import { renderBadgeSVG } from './badge/svg';
import { renderShareCardSVG } from './badge/card';
import { renderCreatorCardSVG } from './badge/creator-card';
import { renderEmbedHTML } from './badge/embed';
import { buildFeeAnalytics } from './fees/analytics';
import { simulateFeeShare } from './fees/simulator';
import { registerWallet, unregisterWallet, runFeeMonitorScan } from './monitor/fee-monitor';
import { sendTelegramMessage, resolveTelegramChatId, broadcastAlert, buildLpDrainMessage } from './notify/telegram';
import { prepareClaim, getClaim, markClaimDone } from './claims/pending-claims';
import { getPartnerConfig, getPartnerCreationTx, getPartnerClaimStats, getPartnerClaimTxs } from './partner/bags-partner';
import { checkTokenGate, requireTier } from './gate/token-gate';
import type { GateTier } from './gate/token-gate';
const USD_HOLDER_MIN = 1.0; // $1 USD — must match token-gate.ts
import { getAppStoreInfo, getSentFeeShareTarget } from './app-store/info';
import { fetchSentFeeStats } from './token/sent-stats';
import { runSwarmCycle, getSwarmState, runTokenSwarmCycle } from './swarm/engine';
import { screenTransaction, getWalletConfig, addRule, removeRule, updateSettings, getFirewallStats, getFirewallLog } from './firewall/engine';
import { getPoolStats, commitToPool, submitClaim, getWalletClaims, getRecentClaims, getCommitments } from './insurance/pool';
import { computeCreatorTrustScore } from './creator/trust-score';
import { simulateRug } from './risk/pre-rug-simulator';
import { runPreRugWatch, getRecentCatches, getWatchStats, getTokenMemory } from './watch/pre-rug-catcher';
import { subscribe as tgSubscribe, unsubscribe as tgUnsubscribe, notifySubscribersOfCatch, getSubscriberCount } from './notify/alert-subscriptions';
import type { CatchPayload } from './notify/alert-subscriptions';
import { computeSurvival } from './launch/survival';
import type { SurvivalInput } from './launch/survival';

export interface Env {
  // Secrets
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  BAGS_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHANNEL_ID?: string;
  ANTHROPIC_API_KEY?: string;
  ENABLE_KV_ANALYTICS?: string;
  // KV
  SENTINEL_KV?: KVNamespace;
}

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const app = new Hono<{ Bindings: Env }>();

const ALLOWED_ORIGINS = [
  'https://sentinel-dashboard-3uy.pages.dev',
  'https://sentinel.bags.fm',
  'https://bags.fm',
  'http://localhost:5173',
  'http://localhost:4173',
];

app.use('/*', cors({
  origin: (origin) => {
    if (!origin) return '*'; // server-to-server, curl, embed iframes
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    if (origin.endsWith('.pages.dev')) return origin; // CF Pages previews
    return null;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-wallet'],
  maxAge: 86400,
}));

// ── Rate limiting (in-memory per-isolate; CF spreads requests across many isolates) ──
// Lightweight defense against accidental spam from a single client.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(key, fresh);
    return { ok: true, remaining: limit - 1, resetAt: fresh.resetAt };
  }
  b.count += 1;
  if (b.count > limit) return { ok: false, remaining: 0, resetAt: b.resetAt };
  return { ok: true, remaining: limit - b.count, resetAt: b.resetAt };
}

app.use('/v1/risk/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const r = rateLimit(`risk:${ip}`, 60, 60_000); // 60 req/min/IP
  c.header('X-RateLimit-Limit', '60');
  c.header('X-RateLimit-Remaining', String(r.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(r.resetAt / 1000)));
  if (!r.ok) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ ok: false, error: 'rate_limit_exceeded' }, 429);
  }
  await next();
});

app.use('/v1/embed/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const r = rateLimit(`embed:${ip}`, 120, 60_000); // 120 req/min/IP (embeds are public widgets)
  c.header('X-RateLimit-Remaining', String(r.remaining));
  if (!r.ok) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ ok: false, error: 'rate_limit_exceeded' }, 429);
  }
  await next();
});

// ── Analytics middleware ──────────────────────────────────
// Fire-and-forget: track API usage in KV for traction metrics

app.use('/v1/*', async (c, next) => {
  await next();

  // Disabled by default to preserve KV daily write quota.
  if (c.env.ENABLE_KV_ANALYTICS !== '1') return;

  const kv = c.env.SENTINEL_KV;
  if (!kv) return;

  const path = new URL(c.req.url).pathname;
  const endpoint =
    path.startsWith('/v1/risk/') ? 'risk' :
    path.startsWith('/v1/fees/claim') ? 'claim' :
    path.startsWith('/v1/fees/') ? 'fees' :
    path.startsWith('/v1/tokens/') ? 'feed' :
    path.startsWith('/v1/alerts') ? 'alerts' :
    path.startsWith('/v1/creator/') ? 'creator' :
    path.startsWith('/v1/badge/') ? 'badge' :
    path.startsWith('/v1/embed/') ? 'embed' :
    path.startsWith('/v1/card/') ? 'card' :
    path.startsWith('/v1/leaderboard') ? 'leaderboard' :
    path.startsWith('/v1/fees/simulate') ? 'simulator' :
    path.startsWith('/v1/partner') ? 'partner' :
    path.startsWith('/v1/gate') ? 'gate' :
    path.startsWith('/v1/app') ? 'app' : 'other';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  c.executionCtx.waitUntil(
    Promise.all([
      // Total hits per endpoint (all-time)
      kv.get(`stats:total:${endpoint}`).then((v) =>
        kv.put(`stats:total:${endpoint}`, String(Number(v || 0) + 1)),
      ),
      // Daily hits
      kv.get(`stats:day:${today}:${endpoint}`).then((v) =>
        kv.put(`stats:day:${today}:${endpoint}`, String(Number(v || 0) + 1), { expirationTtl: 86400 * 30 }),
      ),
      // Global daily total
      kv.get(`stats:day:${today}:total`).then((v) =>
        kv.put(`stats:day:${today}:total`, String(Number(v || 0) + 1), { expirationTtl: 86400 * 30 }),
      ),
    ]).catch(() => {}),
  );
});

// ── Health ───────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'sentinel-api',
    version: '0.13.0',
    pillars: ['risk-scoring-engine', 'wallet-xray'],
    features: ['autoclaim', 'alert-feed', 'creator-reputation', 'token-gating', 'fee-analytics', 'social-sharing', 'autonomous-firewall'],
    bagsNative: true,
    walletConnect: true,
  });
});

// ── Public Stats ─────────────────────────────────────────

app.get('/stats', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  const endpoints = ['risk', 'fees', 'claim', 'feed'] as const;

  const [totalRisk, totalFees, totalClaim, totalFeed, todayTotal, yesterdayTotal, ...dailyEndpoints] =
    await Promise.all([
      kv.get('stats:total:risk'),
      kv.get('stats:total:fees'),
      kv.get('stats:total:claim'),
      kv.get('stats:total:feed'),
      kv.get(`stats:day:${today}:total`),
      kv.get(`stats:day:${yesterday}:total`),
      ...endpoints.map((e) => kv.get(`stats:day:${today}:${e}`)),
    ]);

  const totalAll = [totalRisk, totalFees, totalClaim, totalFeed]
    .reduce((s, v) => s + Number(v || 0), 0);

  return c.json({
    ok: true,
    data: {
      totalRequests: totalAll,
      byEndpoint: {
        risk: Number(totalRisk || 0),
        fees: Number(totalFees || 0),
        claim: Number(totalClaim || 0),
        feed: Number(totalFeed || 0),
      },
      today: {
        date: today,
        total: Number(todayTotal || 0),
        risk: Number(dailyEndpoints[0] || 0),
        fees: Number(dailyEndpoints[1] || 0),
        claim: Number(dailyEndpoints[2] || 0),
        feed: Number(dailyEndpoints[3] || 0),
      },
      yesterday: {
        date: yesterday,
        total: Number(yesterdayTotal || 0),
      },
    },
  });
});

// ── Pre-Rug Watch (evidence chain) ───────────────────────

app.get('/v1/watch/catches', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const [catches, stats] = await Promise.all([
    getRecentCatches(kv, limit),
    getWatchStats(kv),
  ]);
  return c.json({
    ok: true,
    data: {
      catches,
      stats: stats ?? { tokensWatched: 0, catches: 0, lastRunAt: 0, lastCatchAt: null, avgLeadTimeMs: 0 },
    },
  });
});

app.get('/v1/watch/memory/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.json({ ok: false, error: 'Invalid Solana mint address' }, 400);
  }
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  const memory = await getTokenMemory(kv, mint);
  if (!memory) return c.json({ ok: false, error: 'No memory for this token yet' }, 404);
  return c.json({ ok: true, data: memory });
});

// ── Telegram Alert Subscriptions ─────────────────────────

/**
 * POST /v1/alerts/subscribe
 * Body: { chatId: string, wallet?: string }
 * Subscribe a Telegram chat to receive pre-rug catch broadcasts.
 */
app.post('/v1/alerts/subscribe', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  let body: { chatId?: string; wallet?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const chatId = body.chatId?.trim();
  if (!chatId || !/^\-?\d+$/.test(chatId)) {
    return c.json({ ok: false, error: 'chatId must be a numeric Telegram chat ID' }, 400);
  }
  const wallet = body.wallet?.trim();
  if (wallet && !SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }
  await tgSubscribe(kv, chatId, wallet);
  return c.json({ ok: true, message: 'Subscribed. You will receive alerts for new pre-rug catches.' });
});

/**
 * DELETE /v1/alerts/subscribe
 * Body: { chatId: string }
 */
app.delete('/v1/alerts/subscribe', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  let body: { chatId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const chatId = body.chatId?.trim();
  if (!chatId) return c.json({ ok: false, error: 'chatId required' }, 400);
  await tgUnsubscribe(kv, chatId);
  return c.json({ ok: true, message: 'Unsubscribed.' });
});

/**
 * GET /v1/alerts/subscribers/count — public stats
 */
app.get('/v1/alerts/subscribers/count', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  const count = await getSubscriberCount(kv);
  return c.json({ ok: true, data: { count } });
});

// ── Risk Score ───────────────────────────────────────────

// ── Risk Scan daily quota helpers ───────────────────────
const FREE_DAILY_SCANS = 3;

async function checkScanQuota(
  kv: KVNamespace,
  ip: string,
  wallet: string | null,
): Promise<{ allowed: boolean; remaining: number; tier: string }> {
  // Holders (any $SENT) get unlimited scans — quota only for anonymous/free users
  if (wallet && SOLANA_ADDR_RE.test(wallet)) {
    return { allowed: true, remaining: 999, tier: 'holder' };
  }

  // Free quota: 3 scans/day per IP
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `quota:scan:${ip}:${today}`;
  const used = parseInt((await kv.get(key)) ?? '0', 10);
  if (used >= FREE_DAILY_SCANS) {
    return { allowed: false, remaining: 0, tier: 'free' };
  }
  // Increment (fire-and-forget, TTL 26h)
  kv.put(key, String(used + 1), { expirationTtl: 26 * 60 * 60 }).catch(() => {});
  return { allowed: true, remaining: FREE_DAILY_SCANS - used - 1, tier: 'free' };
}

app.get('/v1/risk/:mint', async (c) => {
  const mint = c.req.param('mint');

  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.json({ ok: false, error: 'Invalid Solana mint address' }, 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Check KV cache — always serve cached result regardless of quota
  if (kv) {
    const cached = await kv.get(`risk:${mint}`, 'json');
    if (cached) {
      return c.json({ ok: true, data: { ...(cached as object), cached: true } }, 200, {
        'x-cache': 'HIT',
      });
    }
  }

  // Quota check (only for fresh/uncached scans)
  const scannerWallet = c.req.header('x-wallet') ?? null;
  const ip = c.req.header('cf-connecting-ip') ?? 'anon';
  if (kv) {
    const quota = await checkScanQuota(kv, ip, scannerWallet);
    c.header('x-scan-tier', quota.tier);
    c.header('x-scan-remaining', String(quota.remaining));
    if (!quota.allowed) {
      return c.json({
        ok: false,
        error: 'Daily scan limit reached',
        hint: 'Hold any $SENT to unlock unlimited scans',
        sentMint: 'Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS',
        bagsUrl: 'https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS',
      }, 429);
    }
  }

  try {
    const score = await computeRiskScore(mint, {
      HELIUS_API_KEY: c.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
    });

    // Store in KV cache (60s TTL)
    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`risk:${mint}`, JSON.stringify(score), { expirationTtl: 1800 }),
      );
    }

    // Track scan for leaderboard (fire-and-forget)
    if (kv && scannerWallet && SOLANA_ADDR_RE.test(scannerWallet)) {
      trackWalletScan(kv, scannerWallet, c.executionCtx);
    }

    return c.json({ ok: true, data: score }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('Risk score error:', err);
    return c.json({ ok: false, error: 'Failed to compute risk score' }, 500);
  }
});

// ── Fee Positions ────────────────────────────────────────

app.get('/v1/fees/:wallet', async (c) => {
  const wallet = c.req.param('wallet');

  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Check KV cache (30s TTL)
  if (kv) {
    const cached = await kv.get(`fees:${wallet}`, 'json');
    if (cached) {
      return c.json({ ok: true, data: cached }, 200, { 'x-cache': 'HIT' });
    }
  }

  try {
    const snapshot = await fetchClaimablePositions(wallet, c.env.BAGS_API_KEY);

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`fees:${wallet}`, JSON.stringify(snapshot), { expirationTtl: 30 }),
      );
    }

    return c.json({ ok: true, data: snapshot }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('Fee positions error:', err);
    return c.json({ ok: false, error: 'Failed to fetch fee positions' }, 500);
  }
});

// ── Claim Transactions ───────────────────────────────────

app.post('/v1/fees/claim', async (c) => {
  let body: { wallet?: string; tokenMint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }
  if (!body.tokenMint || !SOLANA_ADDR_RE.test(body.tokenMint)) {
    return c.json({ ok: false, error: 'Invalid token mint address' }, 400);
  }

  try {
    const payload = await fetchClaimTransactions(body.wallet, body.tokenMint, c.env.BAGS_API_KEY);
    return c.json({ ok: true, data: payload });
  } catch (err) {
    console.error('Claim tx error:', err);
    return c.json({ ok: false, error: 'Failed to build claim transactions' }, 500);
  }
});

// ── Smart Fee Intelligence ───────────────────────────────

app.get('/v1/fees/:wallet/smart', async (c) => {
  const wallet = c.req.param('wallet');

  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  try {
    const snapshot = await fetchSmartFees(wallet, c.env);
    return c.json({ ok: true, data: snapshot });
  } catch (err) {
    console.error('Smart fee error:', err);
    return c.json({ ok: false, error: 'Failed to fetch smart fee data' }, 500);
  }
});

// ── Fee Revenue Analytics ────────────────────────────────

app.get('/v1/fees/:wallet/analytics', async (c) => {
  const wallet = c.req.param('wallet');

  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Cache analytics for 5 min
  if (kv) {
    const cached = await kv.get(`fee-analytics:${wallet}`, 'json');
    if (cached) {
      return c.json({ ok: true, data: cached }, 200, { 'x-cache': 'HIT' });
    }
  }

  try {
    const analytics = await buildFeeAnalytics(wallet, c.env);

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`fee-analytics:${wallet}`, JSON.stringify(analytics), { expirationTtl: 300 }),
      );
    }

    return c.json({ ok: true, data: analytics }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('Fee analytics error:', err);
    return c.json({ ok: false, error: 'Failed to build fee analytics' }, 500);
  }
});

// ── Fee-Share Simulator ──────────────────────────────────

app.post('/v1/fees/simulate', async (c) => {
  let body: {
    expectedDailyVolumeUsd?: number;
    feeRateBps?: number;
    allocations?: Array<{ label: string; bps: number }>;
  };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.expectedDailyVolumeUsd !== 'number' || body.expectedDailyVolumeUsd < 0) {
    return c.json({ ok: false, error: 'expectedDailyVolumeUsd must be a non-negative number' }, 400);
  }
  if (typeof body.feeRateBps !== 'number' || body.feeRateBps < 1 || body.feeRateBps > 10000) {
    return c.json({ ok: false, error: 'feeRateBps must be between 1 and 10000' }, 400);
  }
  if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
    return c.json({ ok: false, error: 'allocations must be a non-empty array of { label, bps }' }, 400);
  }

  const totalBps = body.allocations.reduce((sum, a) => sum + (a.bps || 0), 0);
  if (totalBps !== 10000) {
    return c.json({ ok: false, error: `Allocation BPS must sum to 10000, got ${totalBps}` }, 400);
  }

  const result = simulateFeeShare({
    expectedDailyVolumeUsd: body.expectedDailyVolumeUsd,
    feeRateBps: body.feeRateBps,
    allocations: body.allocations,
  });

  return c.json({ ok: true, data: result });
});

// ── Wallet Monitoring ────────────────────────────────────

app.post('/v1/monitor/register', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  let body: {
    wallet?: string;
    telegramChatId?: string;
    thresholdUsd?: number;
    label?: string;
    watchedTokenMints?: string[];
    watchedCreatorWallets?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }

  const threshold = body.thresholdUsd ?? 1.0;
  if (threshold < 0) {
    return c.json({ ok: false, error: 'thresholdUsd must be non-negative' }, 400);
  }

  try {
    const entry = await registerWallet(body.wallet, body.telegramChatId, threshold, {
      label: body.label,
      watchedTokenMints: Array.isArray(body.watchedTokenMints) ? body.watchedTokenMints.filter((mint) => SOLANA_ADDR_RE.test(mint)) : [],
      watchedCreatorWallets: Array.isArray(body.watchedCreatorWallets) ? body.watchedCreatorWallets.filter((wallet) => SOLANA_ADDR_RE.test(wallet)) : [],
    }, kv);
    return c.json({ ok: true, data: entry });
  } catch (err) {
    console.error('Monitor register error:', err);
    const detail = err instanceof Error ? err.message : 'unknown_error';

    // Graceful degradation when KV daily write quota is exhausted.
    if (detail === 'KV_QUOTA_EXCEEDED') {
      return c.json({
        ok: true,
        data: {
          wallet: body.wallet,
          telegramChatId: body.telegramChatId,
          autoClaimThresholdUsd: threshold,
          registeredAt: Date.now(),
          lastNotifiedAt: 0,
          lastClaimableUsd: 0,
          degraded: true,
          persisted: false,
          note: 'KV daily write quota exhausted. Monitor settings are temporary and not persisted until quota reset.',
        },
      });
    }

    return c.json({ ok: false, error: `Failed to register wallet: ${detail}` }, 500);
  }
});

app.post('/v1/monitor/connect', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'Telegram bot not configured on worker' }, 503);
  }

  let body: {
    wallet?: string;
    thresholdUsd?: number;
    telegramUsername?: string;
    label?: string;
    watchedTokenMints?: string[];
    watchedCreatorWallets?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }

  const threshold = body.thresholdUsd ?? 1.0;
  if (threshold < 0) {
    return c.json({ ok: false, error: 'thresholdUsd must be non-negative' }, 400);
  }

  const resolvedChatId = await resolveTelegramChatId({
    botToken: c.env.TELEGRAM_BOT_TOKEN,
    username: body.telegramUsername,
  });

  if (!resolvedChatId) {
    return c.json({
      ok: false,
      error: body.telegramUsername
        ? 'No recent private message found for this Telegram username. Open the bot, press Start, send any message, then retry.'
        : 'No recent private message found for this bot. Open the bot, press Start, send any message, then retry.',
    }, 404);
  }

  try {
    const entry = await registerWallet(body.wallet, resolvedChatId, threshold, {
      label: body.label,
      watchedTokenMints: Array.isArray(body.watchedTokenMints) ? body.watchedTokenMints.filter((mint) => SOLANA_ADDR_RE.test(mint)) : [],
      watchedCreatorWallets: Array.isArray(body.watchedCreatorWallets) ? body.watchedCreatorWallets.filter((wallet) => SOLANA_ADDR_RE.test(wallet)) : [],
    }, kv);

    const shortWallet = `${body.wallet.slice(0, 4)}…${body.wallet.slice(-4)}`;
    const sent = await sendTelegramMessage({
      botToken: c.env.TELEGRAM_BOT_TOKEN,
      chatId: resolvedChatId,
      message: [
        '✅ <b>Sentinel Telegram connected</b>',
        '',
        `👛 Wallet: <code>${shortWallet}</code>`,
        'Alerts are enabled. You will receive fee notifications on scheduled scans.',
      ].join('\n'),
    });

    if (!sent) {
      return c.json({ ok: false, error: 'Telegram test message failed. Verify bot chat permissions and retry.' }, 502);
    }

    return c.json({ ok: true, data: { ...entry, resolvedChatId, testSent: true } });
  } catch (err) {
    console.error('Monitor connect error:', err);
    const detail = err instanceof Error ? err.message : 'unknown_error';

    if (detail === 'KV_QUOTA_EXCEEDED') {
      return c.json({
        ok: true,
        data: {
          wallet: body.wallet,
          telegramChatId: resolvedChatId,
          autoClaimThresholdUsd: threshold,
          registeredAt: Date.now(),
          lastNotifiedAt: 0,
          lastClaimableUsd: 0,
          degraded: true,
          persisted: false,
          resolvedChatId,
          testSent: false,
          note: 'KV daily write quota exhausted. Monitor settings are temporary and not persisted until quota reset.',
        },
      });
    }

    return c.json({ ok: false, error: `Failed to connect monitor: ${detail}` }, 500);
  }
});

app.delete('/v1/monitor/:wallet', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }

  try {
    await unregisterWallet(wallet, kv);
    return c.json({ ok: true, data: { removed: wallet } });
  } catch (err) {
    console.error('Monitor unregister error:', err);
    return c.json({ ok: false, error: 'Failed to unregister wallet' }, 500);
  }
});

app.post('/v1/monitor/test', async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'Telegram bot not configured on worker' }, 503);
  }

  let body: { wallet?: string; telegramChatId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }
  if (!body.telegramChatId || !/^[-]?[0-9]{5,}$/.test(body.telegramChatId)) {
    return c.json({ ok: false, error: 'Invalid Telegram chat ID' }, 400);
  }

  const shortWallet = `${body.wallet.slice(0, 4)}…${body.wallet.slice(-4)}`;
  const sent = await sendTelegramMessage({
    botToken: c.env.TELEGRAM_BOT_TOKEN,
    chatId: body.telegramChatId,
    message: [
      '✅ <b>Sentinel Telegram connected</b>',
      '',
      `👛 Wallet: <code>${shortWallet}</code>`,
      'Alerts are enabled. You will receive fee notifications on scheduled scans.',
    ].join('\n'),
  });

  if (!sent) {
    return c.json({ ok: false, error: 'Telegram test message failed. Check bot token/chat ID and start bot chat first.' }, 502);
  }

  return c.json({ ok: true, data: { sent: true } });
});

// ── Token Launch: Create Metadata ────────────────────────

// ── AutoClaim: Prepare & Retrieve Pending Claims ─────────

app.post('/v1/claims/prepare', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  let body: { wallet?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }

  try {
    const snapshot = await fetchSmartFees(body.wallet, c.env);
    if (snapshot.totalClaimableUsd <= 0) {
      return c.json({ ok: true, data: { message: 'No claimable fees', totalClaimableUsd: 0 } });
    }

    const claim = await prepareClaim(
      body.wallet,
      snapshot.positions,
      snapshot.totalClaimableUsd,
      snapshot.urgentClaimableUsd,
      snapshot.criticalCount,
      kv,
    );

    return c.json({ ok: true, data: claim });
  } catch (err) {
    console.error('Prepare claim error:', err);
    return c.json({ ok: false, error: 'Failed to prepare claim' }, 500);
  }
});

app.get('/v1/claims/:claimId', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const claimId = c.req.param('claimId');
  if (!claimId || claimId.length < 10) {
    return c.json({ ok: false, error: 'Invalid claim ID' }, 400);
  }

  try {
    const claim = await getClaim(claimId, kv);
    if (!claim) {
      return c.json({ ok: false, error: 'Claim not found or expired' }, 404);
    }
    return c.json({ ok: true, data: claim });
  } catch (err) {
    console.error('Get claim error:', err);
    return c.json({ ok: false, error: 'Failed to get claim' }, 500);
  }
});

app.post('/v1/claims/:claimId/done', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const claimId = c.req.param('claimId');
  try {
    await markClaimDone(claimId, kv);
    return c.json({ ok: true, data: { claimId, status: 'claimed' } });
  } catch (err) {
    console.error('Mark claim done error:', err);
    return c.json({ ok: false, error: 'Failed to mark claim done' }, 500);
  }
});

// ── Token Launch: Create Metadata (original) ─────────────

app.post('/v1/token/create', async (c) => {
  let body: {
    name?: string; symbol?: string; description?: string;
    imageUrl?: string; website?: string; twitter?: string; telegram?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.name || !body.symbol || !body.description || !body.imageUrl) {
    return c.json({ ok: false, error: 'Missing required fields: name, symbol, description, imageUrl' }, 400);
  }

  try {
    const result = await createTokenInfo(
      {
        name: body.name,
        symbol: body.symbol,
        description: body.description,
        imageUrl: body.imageUrl,
        website: body.website,
        twitter: body.twitter,
        telegram: body.telegram,
      },
      c.env.BAGS_API_KEY,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Token create error:', err);
    return c.json({ ok: false, error: 'Failed to create token metadata' }, 500);
  }
});

// ── Token Launch: Fee-Share Config ───────────────────────

app.post('/v1/token/fee-config', async (c) => {
  let body: {
    feeClaimers?: FeeClaimerEntry[];
    payer?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.payer || !SOLANA_ADDR_RE.test(body.payer)) {
    return c.json({ ok: false, error: 'Invalid payer wallet address' }, 400);
  }
  if (!Array.isArray(body.feeClaimers) || body.feeClaimers.length === 0) {
    return c.json({ ok: false, error: 'feeClaimers array required (wallet + bps entries)' }, 400);
  }

  // Validate each entry has integer bps, then total = 10000
  for (const entry of body.feeClaimers) {
    if (!Number.isInteger(entry.userBps) || entry.userBps < 0) {
      return c.json({ ok: false, error: `Invalid bps value: ${entry.userBps} (must be non-negative integer)` }, 400);
    }
  }
  const totalBps = body.feeClaimers.reduce((s, e) => s + e.userBps, 0);
  if (totalBps !== 10_000) {
    return c.json({ ok: false, error: `Fee shares must total 10000 bps (100%), got ${totalBps}` }, 400);
  }

  try {
    const result = await createFeeShareConfig(
      { feeClaimers: body.feeClaimers, payer: body.payer },
      c.env.BAGS_API_KEY,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Fee config error:', err);
    return c.json({ ok: false, error: 'Failed to create fee-share config' }, 500);
  }
});

// ── Token Launch: Launch Transaction ─────────────────────

app.post('/v1/token/launch', async (c) => {
  let body: {
    tokenMint?: string; launchWallet?: string; metadataUrl?: string;
    configKey?: string; initialBuyLamports?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.tokenMint || !SOLANA_ADDR_RE.test(body.tokenMint)) {
    return c.json({ ok: false, error: 'Invalid tokenMint' }, 400);
  }
  if (!body.launchWallet || !SOLANA_ADDR_RE.test(body.launchWallet)) {
    return c.json({ ok: false, error: 'Invalid launchWallet' }, 400);
  }
  if (!body.metadataUrl || !body.configKey) {
    return c.json({ ok: false, error: 'Missing metadataUrl or configKey' }, 400);
  }

  try {
    const result = await createLaunchTransaction(
      {
        tokenMint: body.tokenMint,
        launchWallet: body.launchWallet,
        metadataUrl: body.metadataUrl,
        configKey: body.configKey,
        initialBuyLamports: body.initialBuyLamports ?? 0,
      },
      c.env.BAGS_API_KEY,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Launch tx error:', err);
    return c.json({ ok: false, error: 'Failed to create launch transaction' }, 500);
  }
});

app.post('/v1/token/launch-guard', async (c) => {
  let body: {
    launchWallet?: string;
    name?: string;
    symbol?: string;
    description?: string;
    imageUrl?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    feeClaimers?: FeeClaimerEntry[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.launchWallet || !SOLANA_ADDR_RE.test(body.launchWallet)) {
    return c.json({ ok: false, error: 'Invalid launchWallet' }, 400);
  }
  if (!body.name || !body.symbol || !body.description || !body.imageUrl) {
    return c.json({ ok: false, error: 'Missing required launch metadata' }, 400);
  }
  if (!Array.isArray(body.feeClaimers) || body.feeClaimers.length === 0) {
    return c.json({ ok: false, error: 'feeClaimers required' }, 400);
  }

  try {
    const result = await evaluateLaunchGuard({
      launchWallet: body.launchWallet,
      name: body.name,
      symbol: body.symbol,
      description: body.description,
      imageUrl: body.imageUrl,
      website: body.website,
      twitter: body.twitter,
      telegram: body.telegram,
      feeClaimers: body.feeClaimers,
    }, c.env);
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Launch guard error:', err);
    return c.json({ ok: false, error: 'Failed to evaluate launch guard' }, 500);
  }
});

// ── Wallet X-Ray (Portfolio Scanner) ─────────────────────

app.get('/v1/portfolio/:wallet', async (c) => {
  const wallet = c.req.param('wallet');

  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  try {
    const result = await scanWallet(
      wallet,
      {
        HELIUS_API_KEY: c.env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
      },
      c.env.SENTINEL_KV,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Wallet X-Ray error:', err);
    return c.json({ ok: false, error: 'Failed to scan wallet' }, 500);
  }
});

// ── Token Feed ───────────────────────────────────────────

app.get('/v1/tokens/feed', async (c) => {
  const kv = c.env.SENTINEL_KV;

  // Check KV cache (30s TTL for feed)
  if (kv) {
    const cached = await kv.get('feed:top-scored', 'json');
    if (cached) {
      return c.json({ ok: true, data: cached }, 200, { 'x-cache': 'HIT' });
    }
  }

  try {
    const tokens = await fetchTopTokens(c.env.BAGS_API_KEY);

    // Enrich with cached risk scores from KV
    const enriched = kv ? await enrichFeedWithRisk(tokens, kv) : tokens;

    // If feed is sparse on scores (< 5 scored out of top 20), trigger background precompute.
    // Cron runs every 15 min; this protects against cold-start windows.
    if (kv) {
      const scoredCount = enriched.slice(0, 20).filter((t) => t.riskScore !== null).length;
      if (scoredCount < 5) {
        c.executionCtx.waitUntil(precomputeFeedRiskScores(c.env).catch(() => {}));
      }

      c.executionCtx.waitUntil(
        kv.put('feed:top-scored', JSON.stringify(enriched), { expirationTtl: 30 }),
      );
    }

    return c.json({ ok: true, data: enriched }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('Token feed error:', err);
    return c.json({ ok: false, error: 'Failed to fetch token feed' }, 500);
  }
});

// ── Smart Trade: Quote ───────────────────────────────────

app.get('/v1/trade/quote', async (c) => {
  const outputMint = c.req.query('outputMint');
  const amountStr = c.req.query('amount');
  const inputMint = c.req.query('inputMint') ?? WSOL_MINT;

  if (!outputMint || !SOLANA_ADDR_RE.test(outputMint)) {
    return c.json({ ok: false, error: 'Invalid outputMint' }, 400);
  }
  if (!SOLANA_ADDR_RE.test(inputMint)) {
    return c.json({ ok: false, error: 'Invalid inputMint' }, 400);
  }

  const amount = Number(amountStr);
  if (!amount || amount <= 0) {
    return c.json({ ok: false, error: 'Invalid amount (lamports)' }, 400);
  }

  try {
    // Parallel: quote + risk score for the output token
    const [quote, riskResult] = await Promise.allSettled([
      getSwapQuote(
        { inputMint, outputMint, amount },
        c.env.BAGS_API_KEY,
      ),
      computeRiskScore(outputMint, {
        HELIUS_API_KEY: c.env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
      }),
    ]);

    if (quote.status === 'rejected') {
      throw quote.reason;
    }

    const risk = riskResult.status === 'fulfilled' ? riskResult.value : null;

    return c.json({
      ok: true,
      data: {
        quote: quote.value,
        risk,
      },
    });
  } catch (err) {
    console.error('Trade quote error:', err);
    return c.json({ ok: false, error: 'Failed to get swap quote' }, 500);
  }
});

// ── Smart Trade: Build Swap TX ───────────────────────────

app.post('/v1/trade/swap', async (c) => {
  let body: {
    inputMint?: string;
    outputMint?: string;
    amount?: number;
    walletAddress?: string;
    slippageMode?: 'dynamic' | 'fixed';
    slippageBps?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const inputMint = body.inputMint ?? WSOL_MINT;
  if (!body.outputMint || !SOLANA_ADDR_RE.test(body.outputMint)) {
    return c.json({ ok: false, error: 'Invalid outputMint' }, 400);
  }
  if (!SOLANA_ADDR_RE.test(inputMint)) {
    return c.json({ ok: false, error: 'Invalid inputMint' }, 400);
  }
  if (!body.walletAddress || !SOLANA_ADDR_RE.test(body.walletAddress)) {
    return c.json({ ok: false, error: 'Invalid walletAddress' }, 400);
  }
  if (!body.amount || body.amount <= 0) {
    return c.json({ ok: false, error: 'Invalid amount' }, 400);
  }

  try {
    const payload = await buildSwapTransaction(
      {
        inputMint,
        outputMint: body.outputMint,
        amount: body.amount,
        walletAddress: body.walletAddress,
        slippageMode: body.slippageMode,
        slippageBps: body.slippageBps,
      },
      c.env.BAGS_API_KEY,
    );
    return c.json({ ok: true, data: payload });
  } catch (err) {
    console.error('Swap build error:', err);
    return c.json({ ok: false, error: 'Failed to build swap transaction' }, 500);
  }
});

// ── Risk Alert Feed ──────────────────────────────────────

app.get('/v1/alerts/feed', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  try {
    const feed = await getAlertFeed(kv);
    return c.json({ ok: true, data: feed });
  } catch (err) {
    console.error('Alert feed error:', err);
    return c.json({ ok: false, error: 'Failed to fetch alert feed' }, 500);
  }
});

// ── Risk Alert Scan (on-demand trigger) ──────────────────

app.post('/v1/alerts/scan', async (c) => {
  try {
    const newAlerts = await runAlertScan(c.env);
    return c.json({
      ok: true,
      data: {
        newAlerts: newAlerts.length,
        alerts: newAlerts,
      },
    });
  } catch (err) {
    console.error('Alert scan error:', err);
    return c.json({ ok: false, error: 'Scan failed' }, 500);
  }
});

// ── Creator Reputation Profile ───────────────────────────

app.get('/v1/creator/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Cache creator profiles for 10 min
  if (kv) {
    const cached = await kv.get(`creator:${wallet}`, 'json');
    if (cached) {
      return c.json({ ok: true, data: cached }, 200, { 'x-cache': 'HIT' });
    }
  }

  try {
    const profile = await buildCreatorProfile(wallet, c.env);

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`creator:${wallet}`, JSON.stringify(profile), { expirationTtl: 600 }),
      );
    }

    return c.json({ ok: true, data: profile }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('Creator profile error:', err);
    return c.json({ ok: false, error: 'Failed to build creator profile' }, 500);
  }
});

// ── Creator Trust Score (advanced) ───────────────────────

app.get('/v1/creator/:wallet/trust', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }

  try {
    const trust = await computeCreatorTrustScore(wallet, c.env);
    return c.json({ ok: true, data: trust });
  } catch (err) {
    console.error('Creator trust score error:', err);
    return c.json({ ok: false, error: 'Failed to compute trust score' }, 500);
  }
});

// ── Pre-Rug Simulator ────────────────────────────────────

app.post('/v1/risk/simulate-rug', async (c) => {
  const body = await c.req.json<{ mint: string; scenarios?: string[] }>();
  if (!body?.mint || !SOLANA_ADDR_RE.test(body.mint)) {
    return c.json({ ok: false, error: 'Invalid token mint' }, 400);
  }

  try {
    const result = await simulateRug(
      { mint: body.mint, scenarios: body.scenarios as any },
      c.env,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Rug simulation error:', err);
    return c.json({ ok: false, error: 'Simulation failed' }, 500);
  }
});

app.get('/v1/risk/simulate-rug/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.json({ ok: false, error: 'Invalid token mint' }, 400);
  }

  try {
    const result = await simulateRug({ mint }, c.env);
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Rug simulation error:', err);
    return c.json({ ok: false, error: 'Simulation failed' }, 500);
  }
});

app.post('/v1/proof/token', async (c) => {
  let body: { wallet?: string; mint?: string; amountUsd?: number; scenarios?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.mint || !SOLANA_ADDR_RE.test(body.mint)) {
    return c.json({ ok: false, error: 'Invalid mint' }, 400);
  }

  const amountUsd = typeof body.amountUsd === 'number' && body.amountUsd >= 0 ? body.amountUsd : 100;

  try {
    const [simulation, screen] = await Promise.all([
      simulateRug({ mint: body.mint, scenarios: body.scenarios as any }, c.env),
      body.wallet && SOLANA_ADDR_RE.test(body.wallet)
        ? screenTransaction(body.wallet, body.mint, amountUsd, c.env)
        : Promise.resolve(null),
    ]);

    const highlights = [
      `Worst-case scenario: ${simulation.worstCase?.scenario ?? 'none'} (${simulation.overallRisk.toUpperCase()})`,
      `Current score: ${simulation.currentScore}/100 (${simulation.currentTier.toUpperCase()})`,
      screen ? `Firewall verdict: ${screen.decision}` : 'Connect a wallet to include firewall proof',
    ];

    return c.json({
      ok: true,
      data: {
        mint: body.mint,
        amountUsd,
        highlights,
        screen,
        simulation,
        generatedAt: Date.now(),
      },
    });
  } catch (err) {
    console.error('Proof mode error:', err);
    return c.json({ ok: false, error: 'Proof mode failed' }, 500);
  }
});

// ── Embeddable Badge ─────────────────────────────────────

app.get('/v1/badge/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.text('Invalid mint', 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Check SVG cache (60s)
  if (kv) {
    const cached = await kv.get(`badge:${mint}`);
    if (cached) {
      return c.body(cached, 200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=60',
        'x-cache': 'HIT',
      });
    }
  }

  try {
    const score = await computeRiskScore(mint, {
      HELIUS_API_KEY: c.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
    });

    const svg = renderBadgeSVG(score.score, score.tier, mint.slice(0, 6));

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`badge:${mint}`, svg, { expirationTtl: 60 }),
      );
    }

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=60',
      'x-cache': 'MISS',
    });
  } catch (err) {
    console.error('Badge error:', err);
    return c.text('Failed to generate badge', 500);
  }
});

// ── Interactive Embed Widget (HTML iframe) ──────────────

app.get('/v1/embed/score', async (c) => {
  const mint = c.req.query('mint') ?? '';
  const themeQ = (c.req.query('theme') ?? 'dark').toLowerCase();
  const theme: 'dark' | 'light' = themeQ === 'light' ? 'light' : 'dark';

  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.html(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;color:#dc2626;padding:1rem">Invalid mint address</body></html>',
      400,
    );
  }

  const url = new URL(c.req.url);
  const origin = `${url.protocol}//${url.host}`;
  const kv = c.env.SENTINEL_KV;
  const cacheKey = `embed:${theme}:${mint}`;

  if (kv) {
    const cached = await kv.get(cacheKey);
    if (cached) {
      return c.body(cached, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'x-cache': 'HIT',
      });
    }
  }

  try {
    const score = await computeRiskScore(mint, {
      HELIUS_API_KEY: c.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
    });
    const symbol = mint.slice(0, 4).toUpperCase();
    const html = renderEmbedHTML({
      mint,
      symbol,
      score: score.score,
      tier: score.tier,
      theme,
      origin: 'https://sentinel-dashboard-3uy.pages.dev',
    });

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(cacheKey, html, { expirationTtl: 60 }),
      );
    }

    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'x-cache': 'MISS',
    });
  } catch (err) {
    console.error('Embed error:', err);
    return c.html('<!DOCTYPE html><html><body style="color:#dc2626;font-family:sans-serif;padding:1rem">Sentinel: failed to generate embed</body></html>', 500);
  }
});

// ── Shareable Risk Card ──────────────────────────────────

app.get('/v1/card/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.text('Invalid mint', 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Check SVG cache (120s for cards — heavier to generate)
  if (kv) {
    const cached = await kv.get(`card:${mint}`);
    if (cached) {
      return c.body(cached, 200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=120',
        'x-cache': 'HIT',
      });
    }
  }

  try {
    const score = await computeRiskScore(mint, {
      HELIUS_API_KEY: c.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
    });

    const svg = renderShareCardSVG(
      score.score,
      score.tier,
      score.breakdown,
      score.mint.slice(0, 8),
      mint,
    );

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`card:${mint}`, svg, { expirationTtl: 120 }),
      );
    }

    // Track share event for leaderboard (fire-and-forget)
    if (kv) {
      const today = new Date().toISOString().slice(0, 10);
      c.executionCtx.waitUntil(
        kv.get(`stats:cards:${today}`).then((v) =>
          kv.put(`stats:cards:${today}`, String(Number(v || 0) + 1), { expirationTtl: 86400 * 30 }),
        ).catch(() => {}),
      );
    }

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=120',
      'x-cache': 'MISS',
    });
  } catch (err) {
    console.error('Card error:', err);
    return c.text('Failed to generate card', 500);
  }
});

// ── Shareable Creator Card ───────────────────────────────

app.get('/v1/card/creator/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.text('Invalid wallet', 400);
  }

  const kv = c.env.SENTINEL_KV;

  // Cache creator cards for 10 min (heavier — fetches multiple risk scores)
  if (kv) {
    const cached = await kv.get(`card:creator:${wallet}`);
    if (cached) {
      return c.body(cached, 200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=600',
        'x-cache': 'HIT',
      });
    }
  }

  try {
    const profile = await buildCreatorProfile(wallet, c.env);
    const svg = renderCreatorCardSVG(profile);

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(`card:creator:${wallet}`, svg, { expirationTtl: 600 }),
      );
    }

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=600',
      'x-cache': 'MISS',
    });
  } catch (err) {
    console.error('Creator card error:', err);
    return c.text('Failed to generate creator card', 500);
  }
});

// ── Social Leaderboard ───────────────────────────────────

app.get('/v1/leaderboard', async (c) => {
  const kv = c.env.SENTINEL_KV;
  const period = c.req.query('period') === 'alltime' ? 'alltime' : 'weekly';

  if (!kv) {
    return c.json({ ok: false, error: 'Leaderboard not available' }, 503);
  }

  try {
    // Check cache (5 min)
    const cacheKey = `leaderboard:${period}`;
    const cached = await kv.get(cacheKey);
    if (cached) {
      return c.json({ ok: true, data: JSON.parse(cached) }, 200, {
        'x-cache': 'HIT',
      });
    }

    // Build leaderboard from KV scan data
    // Scan all wallet activity keys: scan:{wallet}:{date}
    const scanPrefix = period === 'weekly'
      ? `scan:wallet:`
      : `scan:wallet:`;

    const list = await kv.list({ prefix: scanPrefix, limit: 200 });

    // Aggregate by wallet
    const walletStats = new Map<string, { scans: number; shares: number; rugs: number }>();

    for (const key of list.keys) {
      // Key format: scan:wallet:{address}
      const parts = key.name.split(':');
      if (parts.length < 3) continue;
      const wallet = parts[2];

      const val = await kv.get(key.name);
      if (!val) continue;

      try {
        const data = JSON.parse(val) as { scans?: number; shares?: number; rugs?: number };
        const existing = walletStats.get(wallet) || { scans: 0, shares: 0, rugs: 0 };
        existing.scans += data.scans || 0;
        existing.shares += data.shares || 0;
        existing.rugs += data.rugs || 0;
        walletStats.set(wallet, existing);
      } catch {
        // Non-JSON value, skip
      }
    }

    // Sort by scans descending, take top 50
    const entries = Array.from(walletStats.entries())
      .sort((a, b) => b[1].scans - a[1].scans)
      .slice(0, 50)
      .map(([wallet, stats], i) => ({
        wallet,
        displayName: null,
        scansPerformed: stats.scans,
        rugsDetected: stats.rugs,
        shareCount: stats.shares,
        portfolioHealth: null,
        rank: i + 1,
        sentBalance: 0,
        tier: 'free' as const,
      }));

    const result = {
      entries,
      totalUsers: walletStats.size,
      period,
      updatedAt: Date.now(),
    };

    // Cache for 5 min
    c.executionCtx.waitUntil(
      kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 }).catch(() => {}),
    );

    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Leaderboard error:', err);
    return c.json({ ok: false, error: 'Failed to build leaderboard' }, 500);
  }
});

// Track wallet scan activity (called from risk endpoint for leaderboard)
function trackWalletScan(kv: KVNamespace, wallet: string, ctx: ExecutionContext): void {
  const key = `scan:wallet:${wallet}`;
  ctx.waitUntil(
    kv.get(key).then((v) => {
      const data = v ? JSON.parse(v) : { scans: 0, shares: 0, rugs: 0 };
      data.scans += 1;
      return kv.put(key, JSON.stringify(data), { expirationTtl: 86400 * 30 });
    }).catch(() => {}),
  );
}

// ── Partner Integration ──────────────────────────────────

app.get('/v1/partner/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);

  try {
    const config = await getPartnerConfig(wallet, c.env.BAGS_API_KEY);
    return c.json({ ok: true, data: { config, registered: config !== null } });
  } catch (err) {
    console.error('Partner config error:', err);
    return c.json({ ok: false, error: 'Failed to fetch partner config' }, 500);
  }
});

app.post('/v1/partner/register', async (c) => {
  let body: { wallet?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);

  try {
    const tx = await getPartnerCreationTx(body.wallet, c.env.BAGS_API_KEY);
    return c.json({ ok: true, data: tx });
  } catch (err) {
    console.error('Partner register error:', err);
    return c.json({ ok: false, error: 'Failed to create partner registration tx' }, 500);
  }
});

app.get('/v1/partner/:wallet/stats', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);

  try {
    const stats = await getPartnerClaimStats(wallet, c.env.BAGS_API_KEY);
    return c.json({ ok: true, data: stats });
  } catch (err) {
    console.error('Partner stats error:', err);
    return c.json({ ok: false, error: 'Failed to fetch partner stats' }, 500);
  }
});

app.post('/v1/partner/:wallet/claim', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);

  try {
    const txs = await getPartnerClaimTxs(wallet, c.env.BAGS_API_KEY);
    if (txs.length === 0) return c.json({ ok: true, data: [], message: 'No partner fees to claim' });
    return c.json({ ok: true, data: txs });
  } catch (err) {
    console.error('Partner claim error:', err);
    return c.json({ ok: false, error: 'Failed to get partner claim txs' }, 500);
  }
});

// ── Token Gate ($SENT) ───────────────────────────────────

app.get('/v1/gate/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  if (!c.env.HELIUS_API_KEY) return c.json({ ok: false, error: 'Helius not configured' }, 500);

  try {
    const result = await checkTokenGate(wallet, c.env.HELIUS_API_KEY, c.env.SENTINEL_KV, c.env.BIRDEYE_API_KEY);
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error('Token gate error:', err);
    return c.json({ ok: false, error: 'Failed to check token gate' }, 500);
  }
});

app.post('/v1/gate/check', async (c) => {
  let body: { wallet?: string; requiredTier?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  if (!c.env.HELIUS_API_KEY) return c.json({ ok: false, error: 'Helius not configured' }, 500);

  const minTier = (body.requiredTier === 'whale' || body.requiredTier === 'holder') ? body.requiredTier : 'holder' as GateTier;

  try {
    const result = await requireTier(body.wallet, minTier, c.env.HELIUS_API_KEY, c.env.SENTINEL_KV, c.env.BIRDEYE_API_KEY);
    return c.json({ ok: true, data: { ...result, requiredTier: minTier } });
  } catch (err) {
    console.error('Token gate check error:', err);
    return c.json({ ok: false, error: 'Failed to check access' }, 500);
  }
});

// ── App Store Info ───────────────────────────────────────

app.get('/v1/app/info', (c) => {
  return c.json({ ok: true, data: getAppStoreInfo() });
});

app.get('/v1/app/fee-share', (c) => {
  return c.json({ ok: true, data: getSentFeeShareTarget() });
});

// ── $SENT Live Fee Stats ──────────────────────────────────

app.get('/v1/sent/fee-stats', async (c) => {
  if (!c.env.BIRDEYE_API_KEY) {
    return c.json({ ok: false, error: 'Birdeye not configured' }, 503);
  }

  const kv = c.env.SENTINEL_KV;
  const CACHE_KEY = 'sent:fee-stats';
  const CACHE_TTL = 300; // 5 min

  // Serve from cache
  if (kv) {
    const cached = await kv.get(CACHE_KEY, 'json');
    if (cached) {
      return c.json({ ok: true, data: cached }, 200, { 'x-cache': 'HIT' });
    }
  }

  try {
    const stats = await fetchSentFeeStats(c.env.BIRDEYE_API_KEY);

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(CACHE_KEY, JSON.stringify(stats), { expirationTtl: CACHE_TTL }),
      );
    }

    return c.json({ ok: true, data: stats }, 200, { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('SENT fee-stats error:', err);
    return c.json({ ok: false, error: 'Failed to fetch $SENT stats' }, 500);
  }
});

// ── Swarm Intelligence ───────────────────────────────────

app.post('/v1/swarm/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ ok: false, error: 'Swarm not configured — ANTHROPIC_API_KEY missing' }, 503);
  }
  try {
    const result = await runSwarmCycle(wallet, c.env);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Swarm cycle failed';
    console.error('Swarm cycle error:', err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

app.get('/v1/swarm/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid Solana wallet address' }, 400);
  }
  const state = await getSwarmState(wallet, c.env);
  return c.json({ ok: true, data: state });
});

// ── Token Swarm ──────────────────────────────────────────

app.post('/v1/swarm/token/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.json({ ok: false, error: 'Invalid Solana mint address' }, 400);
  }
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ ok: false, error: 'Swarm not configured — ANTHROPIC_API_KEY missing' }, 503);
  }
  // $SENT gate check
  if (c.env.HELIUS_API_KEY) {
    const callerWallet = c.req.header('x-wallet');
    if (!callerWallet || !SOLANA_ADDR_RE.test(callerWallet)) {
      return c.json({ ok: false, error: 'Wallet required — connect wallet to use AI Swarm' }, 401);
    }
    const gate = await checkTokenGate(callerWallet, c.env.HELIUS_API_KEY, c.env.SENTINEL_KV, c.env.BIRDEYE_API_KEY);
    if (gate.tier === 'free') {
      const needed = gate.sentPriceUsd > 0
        ? `$${USD_HOLDER_MIN} of $SENT (~${Math.ceil(USD_HOLDER_MIN / gate.sentPriceUsd).toLocaleString()} $SENT)`
        : '1 $SENT';
      return c.json({ ok: false, error: `Requires $SENT — buy at least ${needed} on Bags to unlock AI Swarm` }, 403);
    }
  }
  try {
    const result = await runTokenSwarmCycle(mint, c.env);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token swarm cycle failed';
    console.error('Token swarm cycle error:', err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── Autonomous Firewall ──────────────────────────────────

app.post('/v1/firewall/screen', async (c) => {
  let body: { wallet?: string; tokenMint?: string; amountUsd?: number };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  if (!body.tokenMint || !SOLANA_ADDR_RE.test(body.tokenMint)) return c.json({ ok: false, error: 'Invalid tokenMint' }, 400);
  const amountUsd = typeof body.amountUsd === 'number' && body.amountUsd >= 0 ? body.amountUsd : 100;

  try {
    const result = await screenTransaction(body.wallet, body.tokenMint, amountUsd, c.env);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Screen failed';
    return c.json({ ok: false, error: msg }, 500);
  }
});

app.get('/v1/firewall/:wallet/config', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const config = await getWalletConfig(wallet, kv);
  return c.json({ ok: true, data: config });
});

app.post('/v1/firewall/:wallet/rules', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  let body: { tokenMint?: string; tokenSymbol?: string; action?: string; reason?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.tokenMint || !SOLANA_ADDR_RE.test(body.tokenMint)) return c.json({ ok: false, error: 'Invalid tokenMint' }, 400);
  if (body.action !== 'whitelist' && body.action !== 'block') return c.json({ ok: false, error: 'action must be "whitelist" or "block"' }, 400);

  const config = await addRule(wallet, {
    tokenMint: body.tokenMint,
    tokenSymbol: body.tokenSymbol,
    action: body.action,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined,
  }, kv);
  return c.json({ ok: true, data: config });
});

app.delete('/v1/firewall/:wallet/rules/:ruleId', async (c) => {
  const wallet = c.req.param('wallet');
  const ruleId = c.req.param('ruleId');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const config = await removeRule(wallet, ruleId, kv);
  return c.json({ ok: true, data: config });
});

app.patch('/v1/firewall/:wallet/settings', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  let body: { autoBlockRug?: boolean; autoBlockDanger?: boolean; autoBlockLpDrain?: boolean };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const config = await updateSettings(wallet, body, kv);
  return c.json({ ok: true, data: config });
});

app.get('/v1/firewall/stats', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const stats = await getFirewallStats(kv);
  return c.json({ ok: true, data: stats });
});

app.get('/v1/firewall/:wallet/log', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const log = await getFirewallLog(wallet, kv);
  return c.json({ ok: true, data: log });
});

// ── Insurance Pool ───────────────────────────────────────

app.get('/v1/insurance/pool', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const stats = await getPoolStats(kv);
  return c.json({ ok: true, data: stats });
});

app.get('/v1/insurance/commitments', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const commitments = await getCommitments(kv);
  return c.json({ ok: true, data: { commitments, count: commitments.length } });
});

app.post('/v1/insurance/commit', async (c) => {
  let body: { wallet?: string; amountSent?: number; txSignature?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  if (typeof body.amountSent !== 'number' || body.amountSent <= 0) return c.json({ ok: false, error: 'amountSent must be a positive number' }, 400);
  if (!body.txSignature || typeof body.txSignature !== 'string') return c.json({ ok: false, error: 'txSignature is required' }, 400);

  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  try {
    const result = await commitToPool(body.wallet, body.amountSent, kv, c.env.HELIUS_API_KEY, body.txSignature);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Commit failed';
    return c.json({ ok: false, error: msg }, 400);
  }
});

app.post('/v1/insurance/claim', async (c) => {
  let body: { wallet?: string; tokenMint?: string; tokenSymbol?: string; lossEstimateUsd?: number; riskScoreAtEntry?: number };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body.wallet || !SOLANA_ADDR_RE.test(body.wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  if (!body.tokenMint || !SOLANA_ADDR_RE.test(body.tokenMint)) return c.json({ ok: false, error: 'Invalid tokenMint' }, 400);
  if (typeof body.lossEstimateUsd !== 'number' || body.lossEstimateUsd <= 0) return c.json({ ok: false, error: 'lossEstimateUsd must be positive' }, 400);
  if (typeof body.riskScoreAtEntry !== 'number' || body.riskScoreAtEntry < 0 || body.riskScoreAtEntry > 100) return c.json({ ok: false, error: 'riskScoreAtEntry must be 0-100' }, 400);

  try {
    const claim = await submitClaim(
      body.wallet,
      body.tokenMint,
      typeof body.tokenSymbol === 'string' ? body.tokenSymbol.slice(0, 20) : 'UNKNOWN',
      body.lossEstimateUsd,
      body.riskScoreAtEntry,
      c.env,
    );
    return c.json({ ok: true, data: claim });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Claim submission failed';
    return c.json({ ok: false, error: msg }, 500);
  }
});

app.get('/v1/insurance/claims/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  if (!SOLANA_ADDR_RE.test(wallet)) return c.json({ ok: false, error: 'Invalid wallet' }, 400);
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const claims = await getWalletClaims(wallet, kv);
  return c.json({ ok: true, data: claims });
});

app.get('/v1/insurance/claims', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const claims = await getRecentClaims(kv);
  return c.json({ ok: true, data: claims });
});

// ── Feed Risk Enrichment ──────────────────────────────────

/** Enrich feed tokens with cached risk scores from KV (no external API calls) */
async function enrichFeedWithRisk(
  tokens: TokenFeedItem[],
  kv: KVNamespace,
): Promise<TokenFeedItem[]> {
  const keys = tokens.map((t) => `risk:${t.mint}`);
  const results = await Promise.all(keys.map((k) => kv.get(k, 'json').catch(() => null)));
  return tokens.map((token, i) => {
    const cached = results[i] as RiskScore | null;
    if (cached) {
      return { ...token, riskScore: cached.score, riskTier: cached.tier };
    }
    return token;
  });
}

/** Pre-compute risk scores for top feed tokens (called from cron) */
async function precomputeFeedRiskScores(env: Env): Promise<void> {
  const kv = env.SENTINEL_KV;
  if (!kv) return;

  const tokens = await fetchTopTokens(env.BAGS_API_KEY);
  // Top 50 so the pre-rug watcher has a wide enough base; existing cache entries are skipped.
  const batch = tokens.slice(0, 50);

  for (const token of batch) {
    // Skip if already cached
    const existing = await kv.get(`risk:${token.mint}`);
    if (existing) continue;

    try {
      const score = await computeRiskScore(token.mint, {
        HELIUS_API_KEY: env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
      });
      await kv.put(`risk:${token.mint}`, JSON.stringify(score), { expirationTtl: 1800 });
    } catch (err) {
      console.error(`Feed risk precompute failed for ${token.mint}:`, err);
    }
  }
}

// ── Launch Survival Engine ──────────────────────────────
app.post('/v1/launch/stress-test', async (c) => {
  let body: Partial<SurvivalInput>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { liquidity, lpLockHours, devWalletPct, holderCount, topHolderPct } = body;

  if (
    typeof liquidity !== 'number' ||
    typeof lpLockHours !== 'number' ||
    typeof devWalletPct !== 'number' ||
    typeof holderCount !== 'number' ||
    typeof topHolderPct !== 'number'
  ) {
    return c.json(
      { ok: false, error: 'Required: liquidity, lpLockHours, devWalletPct, holderCount, topHolderPct (all numbers)' },
      400,
    );
  }

  const input: SurvivalInput = {
    liquidity,
    lpLockHours,
    devWalletPct,
    holderCount,
    topHolderPct,
    volume: typeof body.volume === 'number' ? body.volume : undefined,
    totalTrades: typeof body.totalTrades === 'number' ? body.totalTrades : undefined,
  };

  const result = computeSurvival(input);
  return c.json({ ok: true, ...result });
});

// ── Export with Cron Support ─────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    const DASHBOARD_URL = 'https://sentinel-dashboard-3uy.pages.dev';

    ctx.waitUntil(
      Promise.all([
        // Pre-compute risk scores, THEN run the pre-rug watch against fresh scores.
        // Sequential by design: watch reads from the KV cache that precompute just warmed.
        (async () => {
          try {
            await precomputeFeedRiskScores(env);
          } catch (err) {
            console.error('Feed risk precompute failed:', err);
          }
          try {
            const newCatchCount = await runPreRugWatch(env);
            if (newCatchCount > 0) {
              console.log(`Pre-rug watch: ${newCatchCount} new catch(es) recorded`);
              // Broadcast fresh catches to Telegram channel + subscribers
              if (env.TELEGRAM_BOT_TOKEN && env.SENTINEL_KV) {
                const recent = await getRecentCatches(env.SENTINEL_KV, newCatchCount);
                const freshCutoff = Date.now() - 25 * 60 * 1000; // within last 25min (cron is 15min)
                const fresh = recent.filter((c) => c.caughtAt >= freshCutoff);
                for (const c of fresh) {
                  const payload: CatchPayload = {
                    mint: c.mint,
                    symbol: c.symbol,
                    name: c.name,
                    initialScore: c.initialScore,
                    caughtScore: c.caughtScore,
                    scoreDrop: c.scoreDrop,
                    tierTransition: c.tierTransition,
                    initialAt: c.initialAt,
                    caughtAt: c.caughtAt,
                    reason: c.reason,
                  };
                  // Broadcast to public channel (fire-and-forget)
                  if (env.TELEGRAM_ALERT_CHANNEL_ID) {
                    const { buildCatchMessage } = await import('./notify/alert-subscriptions');
                    const msg = buildCatchMessage(payload);
                    broadcastAlert(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALERT_CHANNEL_ID, msg)
                      .catch((err) => console.error('Channel broadcast failed:', err));
                  }
                  // Notify personal subscribers (fire-and-forget)
                  notifySubscribersOfCatch(env.SENTINEL_KV, env.TELEGRAM_BOT_TOKEN, payload)
                    .catch((err) => console.error('Subscriber notify failed:', err));
                }
              }
            }
          } catch (err) {
            console.error('Pre-rug watch failed:', err);
          }
        })(),

        // Alert scan — broadcast LP drain alerts to Telegram channel if configured
        runAlertScan(env).then(async (newAlerts) => {
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ALERT_CHANNEL_ID) return;
          const drainAlerts = newAlerts.filter(a => a.type === 'lp_drain');
          for (const alert of drainAlerts) {
            if (alert.liquidityDropPct === undefined || alert.prevLiquidityUsd === undefined || alert.liquidityUsd === undefined) continue;
            const msg = buildLpDrainMessage(
              alert.tokenSymbol,
              alert.tokenName,
              alert.mint,
              alert.prevLiquidityUsd,
              alert.liquidityUsd,
              alert.liquidityDropPct,
              alert.severity === 'critical' ? 'critical' : 'warning',
              DASHBOARD_URL,
            );
            await broadcastAlert(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALERT_CHANNEL_ID, msg)
              .catch((err) => console.error('LP drain broadcast failed:', err));
          }
        }).catch((err) => console.error('Scheduled alert scan failed:', err)),

        runFeeMonitorScan(env).catch((err) => console.error('Scheduled fee monitor failed:', err)),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;

