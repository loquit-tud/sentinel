import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { computeRiskScore } from './risk/engine';
import { fetchTopTokens, fetchRecentLaunches } from './feed/bags';
import { tierFromScore } from '../../shared/types';
import type { TokenFeedItem, RiskScore } from '../../shared/types';
import { SENTINEL_DASHBOARD_URL } from '../../shared/constants';
import { fetchClaimablePositions, fetchClaimTransactions } from './fees/bags-fees';
import { fetchSmartFees } from './fees/smart-fees';
import { createTokenInfo, createLaunchTransaction, createFeeShareConfig } from './token/launch';
import type { FeeClaimerEntry } from './token/launch';
import { evaluateLaunchGuard } from './token/launch-guard';
import { scanWallet } from './portfolio/scanner';
import { getSwapQuote, buildSwapTransaction, WSOL_MINT } from './trade/swap';
import { runAlertScan, getAlertFeed, getAlertScannerDebug } from './alerts/scanner';
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
import { computeCreatorTrustScore } from './creator/trust-score';
import { runPreRugWatch, getRecentCatches, getWatchStats, getTokenMemory } from './watch/pre-rug-catcher';
import { runDbcPoolMonitor, getDbcSnapshot } from './watch/dbc-pool-monitor';
import { getCatchEvidence } from './watch/catch-evidence';
import { backfillOutcomeSeeds, getAccuracyReport, updatePendingOutcomes } from './watch/outcomes';
import { subscribe as tgSubscribe, unsubscribe as tgUnsubscribe, notifySubscribersOfCatch, getSubscriberCount, getSubscription } from './notify/alert-subscriptions';
import type { CatchPayload } from './notify/alert-subscriptions';
import { addWatchMint, removeWatchMint, getWatchlist, getBaseline, putBaseline, formatDeltaLine } from './notify/watchlists';
import { computeSurvival } from './launch/survival';
import type { SurvivalInput } from './launch/survival';
import { generateRiskExplanation } from './risk/explain';
import { hasXCredentials, postCatchToX } from './notify/x';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export interface Env {
  // Secrets
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  BAGS_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHANNEL_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  X_POST_RUG_ALERTS?: string;
  ENABLE_KV_ANALYTICS?: string;
  // KV
  SENTINEL_KV?: KVNamespace;
  // Cloudflare Workers AI
  AI?: Ai;
}

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const app = new Hono<{ Bindings: Env }>();

// ── CORS (must be registered before routes) ───────────────

const ALLOWED_ORIGINS = [
  SENTINEL_DASHBOARD_URL,
  'https://sentinel.bags.fm',
  'https://bags.fm',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:7777',
  'http://localhost:9191',
];

app.use('/*', cors({
  origin: (origin) => {
    if (!origin) return '*'; // server-to-server, curl, embed iframes
    if (!origin || origin === 'null') return '*'; // file:// local HTML
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    if (origin.endsWith('.pages.dev')) return origin; // CF Pages previews
    return null;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-wallet'],
  maxAge: 86400,
}));

// ── Auth (Ed25519) ────────────────────────────────────────

const AUTH_CHALLENGE_TTL_SECONDS = 5 * 60; // 5 min
const AUTH_SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const TG_WEBHOOK_DEDUPE_TTL_SECONDS = 24 * 60 * 60; // 24h
const TG_WEBHOOK_MAX_AGE_SECONDS = 15 * 60; // reject stale updates older than 15 min
const TG_WEBHOOK_MAX_TEXT_LENGTH = 1024;

function bytesToBase64Url(bytes: Uint8Array): string {
  // btoa expects latin1 string
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToBase64Url(b);
}

function getBearerToken(c: any): string | null {
  const h = (c.req.header('authorization') ?? c.req.header('Authorization') ?? '').trim();
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function incrementKvCounter(kv: KVNamespace, key: string, ttlSeconds = 86400 * 7): Promise<void> {
  const curr = await kv.get(key);
  const next = Number(curr || 0) + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
}

async function resolveAuthedWallet(c: any): Promise<string | null> {
  const kv = c.env.SENTINEL_KV as KVNamespace | undefined;
  if (!kv) return null;
  const token = getBearerToken(c);
  if (!token) return null;
  const session = await kv.get<{ wallet: string; exp: number }>(`auth:sess:${token}`, 'json').catch(() => null);
  if (!session?.wallet || !SOLANA_ADDR_RE.test(session.wallet)) return null;
  if (typeof session.exp !== 'number' || session.exp < Date.now()) return null;
  return session.wallet;
}

function buildAuthMessage(params: { wallet: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  // Keep message stable and strict: wallets sign this exact string.
  return [
    'Sentinel Authentication',
    `wallet=${params.wallet}`,
    `nonce=${params.nonce}`,
    `issuedAt=${params.issuedAt}`,
    `expiresAt=${params.expiresAt}`,
  ].join('\n');
}

app.post('/v1/auth/challenge', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const body = await c.req.json().catch(() => null) as { wallet?: string };
  const wallet = body?.wallet?.trim() ?? '';
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }

  const challengeId = `ch_${randomToken(18)}`;
  const nonce = randomToken(16);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + AUTH_CHALLENGE_TTL_SECONDS * 1000;
  const message = buildAuthMessage({ wallet, nonce, issuedAt, expiresAt });

  await kv.put(
    `auth:ch:${challengeId}`,
    JSON.stringify({ wallet, nonce, issuedAt, expiresAt }),
    { expirationTtl: AUTH_CHALLENGE_TTL_SECONDS },
  );

  return c.json({
    ok: true,
    data: { challengeId, wallet, message, expiresAt },
  });
});

app.post('/v1/auth/verify', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const body = await c.req.json().catch(() => null) as {
    challengeId?: string;
    wallet?: string;
    signature?: string; // base58
  };

  const challengeId = body?.challengeId?.trim() ?? '';
  const wallet = body?.wallet?.trim() ?? '';
  const signatureB58 = body?.signature?.trim() ?? '';

  if (!challengeId.startsWith('ch_') || challengeId.length < 10) {
    return c.json({ ok: false, error: 'Invalid challengeId' }, 400);
  }
  if (!SOLANA_ADDR_RE.test(wallet)) {
    return c.json({ ok: false, error: 'Invalid wallet address' }, 400);
  }
  if (!signatureB58) {
    return c.json({ ok: false, error: 'Missing signature' }, 400);
  }

  const ch = await kv.get<{ wallet: string; nonce: string; issuedAt: number; expiresAt: number }>(`auth:ch:${challengeId}`, 'json');
  if (!ch) return c.json({ ok: false, error: 'Challenge not found or expired' }, 404);
  if (ch.wallet !== wallet) return c.json({ ok: false, error: 'Wallet mismatch for challenge' }, 400);
  if (typeof ch.expiresAt !== 'number' || ch.expiresAt < Date.now()) {
    return c.json({ ok: false, error: 'Challenge expired' }, 401);
  }

  const message = buildAuthMessage({ wallet, nonce: ch.nonce, issuedAt: ch.issuedAt, expiresAt: ch.expiresAt });
  const msgBytes = new TextEncoder().encode(message);

  let sigBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(signatureB58);
  } catch {
    return c.json({ ok: false, error: 'Invalid signature encoding (expected base58)' }, 400);
  }

  const pkBytes = bs58.decode(wallet);
  const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pkBytes);
  if (!ok) return c.json({ ok: false, error: 'Invalid signature' }, 401);

  // Single-use challenge
  c.executionCtx.waitUntil(kv.delete(`auth:ch:${challengeId}`).catch(() => {}));

  const sessionToken = `sess_${randomToken(24)}`;
  const exp = Date.now() + AUTH_SESSION_TTL_SECONDS * 1000;
  await kv.put(`auth:sess:${sessionToken}`, JSON.stringify({ wallet, exp }), { expirationTtl: AUTH_SESSION_TTL_SECONDS });

  return c.json({
    ok: true,
    data: {
      sessionToken,
      wallet,
      expiresAt: exp,
    },
  });
});

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
    version: '0.14.0',
    pillars: ['risk-scoring-engine', 'wallet-xray'],
    features: ['autoclaim', 'alert-feed', 'creator-reputation', 'token-gating', 'fee-analytics', 'social-sharing'],
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

  const payload = {
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
  } as const;

  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html')) {
    const d = payload.data;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Live Stats</title>
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}h1{color:#fff;font-size:1.5rem;margin:0 0 4px}p.sub{color:#64748b;font-size:.85rem;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px 18px}.val{font-size:2rem;font-weight:900;color:#fff}.lbl{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-top:4px}.row{display:flex;gap:12px;flex-wrap:wrap}.pill{background:#0f172a;border:1px solid #334155;border-radius:999px;padding:6px 10px;font-size:.8rem;color:#cbd5e1}.footer{margin-top:18px;font-size:.75rem;color:#334155}a{color:#38bdf8}</style></head><body>
<h1>⬡ Sentinel — Live API Stats</h1>
<p class="sub">KV-backed counters · for demo proof (not a local mock)</p>
<div class="grid">
  <div class="card"><div class="val">${d.totalRequests}</div><div class="lbl">Total requests</div></div>
  <div class="card"><div class="val">${d.today.total}</div><div class="lbl">Today</div></div>
  <div class="card"><div class="val">${d.yesterday.total}</div><div class="lbl">Yesterday</div></div>
  <div class="card"><div class="val">${d.byEndpoint.risk}</div><div class="lbl">Risk endpoint (all-time)</div></div>
</div>
<div class="row">
  <div class="pill">fees: <b>${d.byEndpoint.fees}</b></div>
  <div class="pill">claim: <b>${d.byEndpoint.claim}</b></div>
  <div class="pill">feed: <b>${d.byEndpoint.feed}</b></div>
  <div class="pill">today risk: <b>${d.today.risk}</b></div>
  <div class="pill">today fees: <b>${d.today.fees}</b></div>
  <div class="pill">today claim: <b>${d.today.claim}</b></div>
  <div class="pill">today feed: <b>${d.today.feed}</b></div>
</div>
<div class="footer">Raw JSON: <a href="/stats">/stats</a></div>
</body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  }

  return c.json(payload);
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
  const data = {
    catches,
    stats: stats ?? { tokensWatched: 0, catches: 0, lastRunAt: 0, lastCatchAt: null, avgLeadTimeMs: 0 },
  };

  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html')) {
    const fmtMs = (ms: number) => ms < 60000 ? `${Math.round(ms/1000)}s` : `${Math.round(ms/60000)}m`;
    const fmtTs = (ts: number) => new Date(ts).toISOString().replace('T',' ').slice(0,19) + ' UTC';
    const rows = catches.map((c2) => {
      const baselineAgeMs = c2.caughtAt - c2.initialAt;
      const evUrl = `/v1/watch/catch-evidence/${c2.mint}?caughtAt=${c2.caughtAt}`;
      return `<tr>
        <td><b>${c2.symbol ?? '—'}</b><br><span class="mono">${c2.mint.slice(0,8)}…</span></td>
        <td>${c2.initialScore ?? '—'} → <b>${c2.caughtScore ?? '—'}</b></td>
        <td class="red">−${c2.scoreDrop ?? 0} pts</td>
        <td>${c2.tierTransition ?? '—'}</td>
        <td class="green"><b>${fmtMs(baselineAgeMs)}</b></td>
        <td class="dim">${fmtTs(c2.caughtAt)}</td>
        <td><a href="${evUrl}">evidence ↗</a></td>
      </tr>`;
    }).join('');
    const s = data.stats;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Risk Deterioration Catches</title>
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}h1{color:#fff;font-size:1.5rem;margin:0 0 4px}p.sub{color:#64748b;font-size:.85rem;margin:0 0 28px}table{width:100%;border-collapse:collapse;font-size:.875rem}th{text-align:left;color:#475569;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;border-bottom:1px solid #1e293b}td{padding:10px 12px;border-bottom:1px solid #1e293b16}tr:hover td{background:#ffffff08}.mono{color:#64748b;font-size:.75rem;font-family:monospace}.red{color:#f87171}.green{color:#4ade80}.dim{color:#64748b;font-size:.8rem}.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}.stat{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px 20px}.stat-val{font-size:2rem;font-weight:900;color:#fff}.stat-val.green{color:#4ade80}.stat-val.red{color:#f87171}.stat-lbl{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-top:4px}.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:.7rem;font-weight:700;background:#0f172a;border:1px solid #334155;color:#94a3b8}.footer{margin-top:24px;font-size:.75rem;color:#334155}a{color:#38bdf8}</style></head><body>
<h1>⬡ Sentinel — Risk Deterioration Evidence Chain</h1>
<p class="sub">Autonomous agent catches · every 15 min · timestamped · not curated</p>
<div class="stat-grid">
  <div class="stat"><div class="stat-val">${s.catches}</div><div class="stat-lbl">Catches logged</div></div>
  <div class="stat"><div class="stat-val green">${s.avgLeadTimeMs > 0 ? fmtMs(s.avgLeadTimeMs) : '—'}</div><div class="stat-lbl">Avg baseline age</div></div>
  <div class="stat"><div class="stat-val red">${catches.length > 0 ? '−' + Math.round(catches.reduce((a, x) => a + (x.scoreDrop ?? 0), 0) / catches.length) : '—'} pts</div><div class="stat-lbl">Avg score drop</div></div>
  <div class="stat"><div class="stat-val">${s.tokensWatched}</div><div class="stat-lbl">Tokens watched</div></div>
</div>
<table><thead><tr><th>Token</th><th>Score</th><th>Drop</th><th>Tier transition</th><th>Baseline age</th><th>Flagged at</th><th>Proof</th></tr></thead><tbody>${rows || '<tr><td colspan=7 style="color:#64748b;padding:20px 12px">No catches yet.</td></tr>'}</tbody></table>
<div class="footer">Baseline age = time from last safe snapshot to alert, not a claimed prediction window. Raw JSON: <a href="?format=json">/v1/watch/catches?format=json</a> · <a href="https://sentinel-dashboard-3uy.pages.dev" target="_blank">View dashboard ↗</a></div>
</body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  }

  return c.json({ ok: true, data });
});

// ── Demo Viewer (live, proof-first) ──────────────────────

function renderStatsHtml(payload: {
  ok: true;
  data: {
    totalRequests: number;
    byEndpoint: { risk: number; fees: number; claim: number; feed: number };
    today: { date: string; total: number; risk: number; fees: number; claim: number; feed: number };
    yesterday: { date: string; total: number };
  };
}): string {
  const d = payload.data;
  return `<section class="panel">
    <div class="panel-head">
      <h2>Live API stats</h2>
      <p>KV-backed counters · real usage proof</p>
    </div>
    <div class="grid4">
      <div class="card"><div class="val">${d.totalRequests}</div><div class="lbl">Total requests</div></div>
      <div class="card"><div class="val">${d.today.total}</div><div class="lbl">Today</div></div>
      <div class="card"><div class="val">${d.yesterday.total}</div><div class="lbl">Yesterday</div></div>
      <div class="card"><div class="val">${d.byEndpoint.risk}</div><div class="lbl">Risk (all-time)</div></div>
    </div>
    <div class="row">
      <span class="pill">fees: <b>${d.byEndpoint.fees}</b></span>
      <span class="pill">claim: <b>${d.byEndpoint.claim}</b></span>
      <span class="pill">feed: <b>${d.byEndpoint.feed}</b></span>
      <span class="pill">today risk: <b>${d.today.risk}</b></span>
      <span class="pill">today fees: <b>${d.today.fees}</b></span>
      <span class="pill">today claim: <b>${d.today.claim}</b></span>
      <span class="pill">today feed: <b>${d.today.feed}</b></span>
    </div>
  </section>`;
}

function renderCatchesHtml(catches: any[], stats: any): string {
  const fmtMs = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
  const fmtTs = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const rows = catches.map((c2) => {
    const baselineAgeMs = (c2.caughtAt ?? 0) - (c2.initialAt ?? 0);
    const evUrl = `/v1/watch/catch-evidence/${c2.mint}?caughtAt=${c2.caughtAt}`;
    return `<tr>
      <td><b>${c2.symbol ?? '—'}</b><div class="dim mono">${String(c2.mint ?? '').slice(0, 8)}…</div></td>
      <td>${c2.initialScore ?? '—'} → <b>${c2.caughtScore ?? '—'}</b></td>
      <td class="red">−${c2.scoreDrop ?? 0} pts</td>
      <td>${c2.tierTransition ?? '—'}</td>
      <td class="green"><b>${baselineAgeMs > 0 ? fmtMs(baselineAgeMs) : '—'}</b></td>
      <td class="dim">${c2.caughtAt ? fmtTs(c2.caughtAt) : '—'}</td>
      <td class="links"><a href="${evUrl}">evidence ↗</a> · <a href="https://sentinel-dashboard-3uy.pages.dev/?risk=${c2.mint}" target="_blank">dash ↗</a></td>
    </tr>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-head">
      <h2>Risk deterioration evidence chain</h2>
      <p>Autonomous catches · timestamped · baseline age shown</p>
    </div>
    <div class="grid4">
      <div class="card"><div class="val">${stats?.catches ?? 0}</div><div class="lbl">Catches logged</div></div>
      <div class="card"><div class="val green">${stats?.avgLeadTimeMs ? fmtMs(stats.avgLeadTimeMs) : '—'}</div><div class="lbl">Avg baseline age</div></div>
      <div class="card"><div class="val">${stats?.tokensWatched ?? 0}</div><div class="lbl">Tokens watched</div></div>
      <div class="card"><div class="val">${stats?.lastRunAt ? fmtTs(stats.lastRunAt) : '—'}</div><div class="lbl">Last run</div></div>
    </div>
    <table class="tbl">
      <thead><tr><th>Token</th><th>Score</th><th>Drop</th><th>Tier</th><th>Baseline age</th><th>Flagged</th><th>Links</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="color:#64748b;padding:16px 12px">No catches yet.</td></tr>'}</tbody>
    </table>
    <p class="dim" style="margin-top:10px">Baseline age is the time from the prior safe snapshot to the alert; outcome windows are verified after the alert.</p>
  </section>`;
}

function renderAccuracyHtml(report: Awaited<ReturnType<typeof getAccuracyReport>>): string {
  const fmtPct = (n: number | null) => n == null ? 'pending' : `${Math.round(n * 100)}%`;
  const fmtMs = (ms: number | null) => {
    if (!ms || ms < 0) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  };
  const statusColor = (s: string) =>
    s === 'confirmed' ? '#4ade80' :
    s === 'false_positive' ? '#f87171' :
    s === 'inconclusive' ? '#facc15' : '#38bdf8';
  const rows = report.records.slice(0, 8).map((r) => `<tr>
    <td><b>${r.symbol || '—'}</b><div class="dim mono">${r.mint.slice(0, 8)}…</div></td>
    <td><span class="badge" style="border-color:${statusColor(r.summaryStatus)};color:${statusColor(r.summaryStatus)}">${r.summaryStatus}</span></td>
    <td>${r.initialScore} → <b>${r.caughtScore}</b></td>
    <td>${r.confirmationReasons.slice(0, 1).join('') || '<span class="dim">pending external outcome</span>'}</td>
    <td class="links"><a href="/v1/watch/catch-evidence/${r.mint}?caughtAt=${r.caughtAt}">evidence ↗</a></td>
  </tr>`).join('');
  return `<section class="panel proof">
    <div class="panel-head">
      <h2>Post-alert outcome tracker</h2>
      <p>Confirmed only by external post-alert evidence</p>
    </div>
    <div class="grid4">
      <div class="card"><div class="val green">${report.metrics.confirmed}</div><div class="lbl">Confirmed</div></div>
      <div class="card"><div class="val">${fmtPct(report.metrics.precision)}</div><div class="lbl">Precision</div></div>
      <div class="card"><div class="val">${report.metrics.pending}</div><div class="lbl">Pending</div></div>
      <div class="card"><div class="val green">${fmtMs(report.metrics.medianLeadTimeMs)}</div><div class="lbl">Median baseline age</div></div>
    </div>
    <table class="tbl">
      <thead><tr><th>Token</th><th>Status</th><th>Score</th><th>Outcome evidence</th><th>Proof</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="color:#64748b;padding:16px 12px">No outcome records yet.</td></tr>'}</tbody>
    </table>
  </section>`;
}

function renderFeedHtml(enriched: TokenFeedItem[]): string {
  const rows = enriched.slice(0, 20).map((t) => {
    const score = t.riskScore ?? null;
    const tier = t.riskTier ?? null;
    const tierColor =
      tier === 'safe' ? '#4ade80' :
      tier === 'caution' ? '#fb923c' :
      tier === 'danger' ? '#f87171' :
      '#94a3b8';
    const dashUrl = `https://sentinel-dashboard-3uy.pages.dev/?risk=${t.mint}`;
    const bagsUrl = `https://bags.fm/token/${t.mint}`;
    const fee = typeof (t as any).lifetimeFees === 'number' ? (t as any).lifetimeFees : null;
    const liq = typeof (t as any).liquidity === 'number' ? (t as any).liquidity : null;
    return `<tr>
      <td><b>${t.symbol ?? '—'}</b><div class="dim mono">${t.mint.slice(0, 8)}…</div></td>
      <td>${fee === null ? '<span class="dim">—</span>' : `$${Math.round(fee).toLocaleString()}`}</td>
      <td>${liq === null ? '<span class="dim">—</span>' : `$${Math.round(liq).toLocaleString()}`}</td>
      <td>${score === null ? '<span class="dim">—</span>' : `<b>${score}</b>`}</td>
      <td><span class="badge" style="border-color:${tierColor};color:${tierColor}">${tier ?? 'unscored'}</span></td>
      <td class="links"><a href="${dashUrl}" target="_blank">view ↗</a> · <a href="${bagsUrl}" target="_blank">bags ↗</a></td>
    </tr>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-head">
      <h2>Bags-native discovery feed</h2>
      <p>Top tokens by lifetime fees on Bags + cached Sentinel risk</p>
    </div>
    <table class="tbl">
      <thead><tr><th>Token</th><th>Lifetime fees</th><th>Liquidity</th><th>Risk</th><th>Tier</th><th>Links</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="color:#64748b;padding:16px 12px">No tokens found.</td></tr>'}</tbody>
    </table>
  </section>`;
}

app.get('/v1/demo', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const limit = Math.min(Number(c.req.query('limit') ?? 8), 25);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const endpoints = ['risk', 'fees', 'claim', 'feed'] as const;

  const [catches, watchStats, accuracyReport, tokens, totalRisk, totalFees, totalClaim, totalFeed, todayTotal, yesterdayTotal, ...dailyEndpoints] =
    await Promise.all([
      getRecentCatches(kv, limit),
      getWatchStats(kv),
      getAccuracyReport(kv, 25),
      fetchTopTokens(c.env.BAGS_API_KEY).catch((err) => {
        console.error('Demo feed fetch failed:', err);
        return [] as TokenFeedItem[];
      }),
      kv.get('stats:total:risk'),
      kv.get('stats:total:fees'),
      kv.get('stats:total:claim'),
      kv.get('stats:total:feed'),
      kv.get(`stats:day:${today}:total`),
      kv.get(`stats:day:${yesterday}:total`),
      ...endpoints.map((e) => kv.get(`stats:day:${today}:${e}`)),
    ]);

  const enriched = await enrichFeedWithRisk(tokens, kv);
  const totalAll = [totalRisk, totalFees, totalClaim, totalFeed].reduce((s, v) => s + Number(v || 0), 0);
  const statsPayload = {
    ok: true as const,
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
  };

  const accept = c.req.header('accept') ?? '';
  const wantsJson = c.req.query('format') === 'json' || !accept.includes('text/html');
  if (wantsJson) {
    return c.json({
      ok: true,
      data: {
        catches,
        watchStats,
        accuracy: accuracyReport,
        feed: enriched.slice(0, 20),
        stats: statsPayload.data,
      },
    });
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Live Demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0}
.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 48px}
h1{margin:0 0 6px;font-size:1.7rem;color:#fff}
.sub{margin:0 0 18px;color:#64748b;font-size:.92rem}
.topbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
.chip{background:#0f172a;border:1px solid #334155;border-radius:999px;padding:6px 10px;font-size:.8rem;color:#cbd5e1}
.chip a{color:#38bdf8;text-decoration:none}
.chip a:hover{text-decoration:underline}
.panel{background:#0b1220;border:1px solid #1e293b;border-radius:14px;padding:16px 16px 14px;margin:14px 0}
.panel.proof{border-color:#22c55e55;background:linear-gradient(135deg,#052e1b99,#0b1220 55%,#08334455)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.panel-head h2{margin:0;color:#fff;font-size:1rem}
.panel-head p{margin:0;color:#64748b;font-size:.82rem}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
@media (max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}}
.card{background:#0a0e17;border:1px solid #1e293b;border-radius:12px;padding:12px 14px}
.val{font-size:1.6rem;font-weight:900;color:#fff;line-height:1.1}
.val.green{color:#4ade80}
.lbl{font-size:.68rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-top:6px}
.row{display:flex;flex-wrap:wrap;gap:8px}
.pill{background:#0f172a;border:1px solid #334155;border-radius:999px;padding:6px 10px;font-size:.8rem;color:#cbd5e1}
.tbl{width:100%;border-collapse:collapse;font-size:.9rem}
.tbl th{text-align:left;color:#475569;font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:6px 10px;border-bottom:1px solid #1e293b}
.tbl td{padding:9px 10px;border-bottom:1px solid #1e293b1f;vertical-align:top}
.tbl tr:hover td{background:#ffffff08}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
.dim{color:#64748b;font-size:.82rem}
.red{color:#f87171}
.green{color:#4ade80}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #334155;background:#0f172a;font-size:.75rem;font-weight:900}
.links a{color:#38bdf8;text-decoration:none}
.links a:hover{text-decoration:underline}
.footer{margin-top:16px;color:#334155;font-size:.78rem}
</style></head><body>
<div class="wrap">
  <h1>⬡ Sentinel — Live Demo</h1>
  <p class="sub">Proof-first viewer for judges: evidence chain + Bags-native feed + traction — all live</p>
  <div class="topbar">
    <span class="chip">Dashboard: <a href="https://sentinel-dashboard-3uy.pages.dev" target="_blank">sentinel-dashboard ↗</a></span>
    <span class="chip">JSON: <a href="/v1/demo?format=json">/v1/demo?format=json</a></span>
    <span class="chip">Catches: <a href="/v1/watch/catches?limit=${limit}">/v1/watch/catches ↗</a></span>
    <span class="chip">Outcomes: <a href="/v1/watch/accuracy">/v1/watch/accuracy ↗</a></span>
    <span class="chip">Feed: <a href="/v1/tokens/feed">/v1/tokens/feed ↗</a></span>
    <span class="chip">Stats: <a href="/stats">/stats ↗</a></span>
  </div>
  ${renderAccuracyHtml(accuracyReport)}
  ${renderCatchesHtml(catches, watchStats ?? { catches: 0, tokensWatched: 0, lastRunAt: 0, avgLeadTimeMs: 0 })}
  ${renderFeedHtml(enriched)}
  ${renderStatsHtml(statsPayload)}
  <div class="footer">This page renders the same live data used by the public endpoints. No mock data.</div>
</div>
</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
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

/**
 * GET /v1/watch/debug
 * Diagnostic: shows pool sizes, recent KV snapshots, and score distribution.
 * Helps diagnose why the risk deterioration watcher isn't producing catches.
 */
app.get('/v1/watch/debug', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const [recent, top] = await Promise.all([
    fetchRecentLaunches(c.env.BAGS_API_KEY).catch((e) => { console.error('recent err', e); return []; }),
    fetchTopTokens(c.env.BAGS_API_KEY).catch((e) => { console.error('top err', e); return []; }),
  ]);

  // Sample first 20 cached scores from combined pool
  const seen = new Set<string>();
  const combined = [...recent, ...top].filter((t) => {
    if (seen.has(t.mint)) return false;
    seen.add(t.mint);
    return true;
  }).slice(0, 30);

  const samples: Array<{ mint: string; symbol: string; source: 'recent' | 'top'; score: number | null; tier: string | null }> = [];
  for (const t of combined) {
    const cached = await kv.get(`risk:${t.mint}`, 'json') as RiskScore | null;
    samples.push({
      mint: t.mint.slice(0, 8) + '…',
      symbol: t.symbol,
      source: recent.some((r) => r.mint === t.mint) ? 'recent' : 'top',
      score: cached?.score ?? null,
      tier: cached?.tier ?? null,
    });
  }

  // Score distribution
  const scored = samples.filter((s) => s.score !== null);
  const dist = {
    null_count: samples.length - scored.length,
    danger_lt40: scored.filter((s) => (s.score ?? 0) < 40).length,
    warn_40_70: scored.filter((s) => (s.score ?? 0) >= 40 && (s.score ?? 0) < 70).length,
    safe_gte70: scored.filter((s) => (s.score ?? 0) >= 70).length,
    avg: scored.length ? Math.round(scored.reduce((a, s) => a + (s.score ?? 0), 0) / scored.length) : null,
  };

  // Snapshot count (sampled)
  let snapCount = 0;
  for (const t of combined) {
    const snap = await kv.get(`watch:snap:${t.mint}`);
    if (snap) snapCount++;
  }

  // DBC pool snapshots (sampled) — for PRE_GRAD direct liquidity tracking
  let dbcSnapCount = 0;
  let dbcWithKeyCount = 0;
  let dbcVaultCount = 0;
  const dbcSamples: Array<{ symbol: string; vault: string; sol: number; ageMin: number }> = [];
  for (const t of combined) {
    if (t.dbcPoolKey) dbcWithKeyCount++;
    const dsnap = await getDbcSnapshot(kv, t.mint);
    if (dsnap) {
      dbcSnapCount++;
      if (dsnap.vault) dbcVaultCount++;
      if (dbcSamples.length < 5) {
        dbcSamples.push({
          symbol: t.symbol,
          vault: dsnap.vault ? `${dsnap.vault.slice(0, 8)}…` : '(none)',
          sol: Math.round((dsnap.sol ?? 0) * 1000) / 1000,
          ageMin: Math.round((Date.now() - dsnap.ts) / 60000),
        });
      }
    }
  }

  return c.json({
    ok: true,
    data: {
      pools: { recent: recent.length, top: top.length, combined_unique: combined.length },
      bags_api_key_present: !!c.env.BAGS_API_KEY,
      helius_api_key_present: !!c.env.HELIUS_API_KEY,
      score_distribution: dist,
      snapshots_present: `${snapCount}/${combined.length}`,
      dbc: {
        with_pool_key: `${dbcWithKeyCount}/${combined.length}`,
        vaults_resolved: `${dbcVaultCount}/${combined.length}`,
        snapshots_present: `${dbcSnapCount}/${combined.length}`,
        recent_balances: dbcSamples,
      },
      samples,
    },
  });
});

/**
 * GET /v1/watch/dbc-tick
 * One-shot trigger of the DBC pool monitor (resolves vaults, snapshots balances).
 * Runs synchronously over the first 30 PRE_GRAD candidates from the feed.
 * Used to validate the monitor outside of the 15-minute cron cadence.
 */
app.get('/v1/watch/dbc-tick', async (c) => {
  const recent = await fetchRecentLaunches(c.env.BAGS_API_KEY).catch(() => []);
  const seen = new Set<string>();
  const batch = recent.filter((t) => {
    if (seen.has(t.mint)) return false;
    seen.add(t.mint);
    return true;
  }).slice(0, 30);
  const newCatches = await runDbcPoolMonitor(c.env, batch);
  if (newCatches > 0) {
    await broadcastDbcCatches(c.env, newCatches);
  }
  return c.json({ ok: true, data: { processed: batch.length, newCatches } });
});

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCatchEvidenceHtml(evidence: Awaited<ReturnType<typeof getCatchEvidence>>, outcome?: Awaited<ReturnType<typeof getAccuracyReport>>['records'][number]): string {
  if (!evidence) return '';
  const fmtTs = (ts: number | null | undefined) => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
  const fmtMs = (ms: number | null | undefined) => {
    if (!ms || ms < 0) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  };
  const c = evidence.catch;
  const baselineAgeMs = c.caughtAt - c.initialAt;
  const status = outcome?.summaryStatus ?? 'pending';
  const statusColor =
    status === 'confirmed' ? '#4ade80' :
    status === 'false_positive' ? '#f87171' :
    status === 'inconclusive' ? '#facc15' : '#38bdf8';
  const signals = (c.triggerSignals ?? []).map((s) => `<span class="pill">${escapeHtml(s)}</span>`).join('');
  const reasons = (outcome?.confirmationReasons ?? []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  const windows = outcome
    ? `<div class="row">
        <span class="pill">15m: <b>${escapeHtml(outcome.windows.m15.status)}</b></span>
        <span class="pill">1h: <b>${escapeHtml(outcome.windows.h1.status)}</b></span>
        <span class="pill">24h: <b>${escapeHtml(outcome.windows.h24.status)}</b></span>
      </div>`
    : '<p class="dim">Outcome record pending.</p>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel Evidence — ${escapeHtml(c.symbol)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}.wrap{max-width:960px;margin:0 auto}h1{color:#fff;font-size:1.8rem;margin:0 0 6px}.sub{color:#64748b;margin:0 0 22px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}}.card,.panel{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:16px}.panel{margin-top:14px}.lbl{font-size:.68rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em}.val{font-size:1.55rem;font-weight:900;color:#fff;margin-top:6px}.green{color:#4ade80}.red{color:#f87171}.dim{color:#64748b}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.row{display:flex;flex-wrap:wrap;gap:8px}.pill{display:inline-flex;gap:4px;align-items:center;background:#0f172a;border:1px solid #334155;border-radius:999px;padding:7px 10px;font-size:.82rem;color:#cbd5e1}.links a{color:#38bdf8;text-decoration:none}.links a:hover{text-decoration:underline}pre{white-space:pre-wrap;word-break:break-word;background:#060914;border:1px solid #1e293b;border-radius:12px;padding:12px;color:#cbd5e1}.status{display:inline-flex;border:1px solid currentColor;border-radius:999px;padding:4px 10px;font-size:.78rem;font-weight:900;text-transform:uppercase}</style></head><body>
<div class="wrap">
  <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:14px">
    <div>
      <h1>⬡ Sentinel Evidence — ${escapeHtml(c.symbol || c.mint.slice(0, 8))}</h1>
      <p class="sub">${escapeHtml(c.name)} · <span class="mono">${escapeHtml(c.mint)}</span></p>
    </div>
    <span class="status" style="color:${statusColor}">${escapeHtml(status)}</span>
  </div>

  <div class="grid">
    <div class="card"><div class="lbl">Score</div><div class="val">${c.initialScore} → <span class="red">${c.caughtScore}</span></div></div>
    <div class="card"><div class="lbl">Drop</div><div class="val red">−${c.scoreDrop} pts</div></div>
    <div class="card"><div class="lbl">Tier</div><div class="val">${escapeHtml(c.tierTransition)}</div></div>
    <div class="card"><div class="lbl">Baseline age</div><div class="val green">${fmtMs(baselineAgeMs)}</div></div>
  </div>

  <section class="panel">
    <div class="lbl">Trigger signals</div>
    <div class="row" style="margin-top:10px">${signals || '<span class="dim">No trigger signals stored.</span>'}</div>
  </section>

  <section class="panel">
    <div class="lbl">Outcome validation</div>
    <div style="margin-top:10px">${windows}</div>
    ${reasons ? `<ul class="green">${reasons}</ul>` : '<p class="dim">Waiting for post-alert verification windows.</p>'}
  </section>

  <section class="panel">
    <div class="lbl">Evidence timestamps</div>
    <div class="grid" style="margin-bottom:0">
      <div><div class="lbl">Initial snapshot</div><div>${fmtTs(c.initialAt)}</div></div>
      <div><div class="lbl">Caught at</div><div>${fmtTs(c.caughtAt)}</div></div>
      <div><div class="lbl">Recorded at</div><div>${fmtTs(evidence.recordedAt)}</div></div>
      <div><div class="lbl">RugCheck at catch</div><div>${evidence.rugcheck?.ok ? `score ${escapeHtml(evidence.rugcheck.scoreNormalised)} · rugged ${escapeHtml(evidence.rugcheck.rugged)}` : 'unavailable'}</div></div>
    </div>
  </section>

  <section class="panel links">
    <div class="lbl">Verify</div>
    <p>
      <a href="${evidence.links.bagsToken}" target="_blank">Bags token ↗</a> ·
      <a href="${evidence.links.dashboard}" target="_blank">Dashboard ↗</a> ·
      <a href="${evidence.links.riskApi}" target="_blank">Risk API ↗</a> ·
      <a href="/v1/watch/accuracy">Accuracy tracker ↗</a> ·
      <a href="?caughtAt=${c.caughtAt}&format=json">Raw JSON ↗</a>
    </p>
  </section>
</div>
</body></html>`;
}

function buildManualShareText(
  catchItem: Awaited<ReturnType<typeof getRecentCatches>>[number],
  shareUrl: string,
): string {
  const transition = catchItem.tierTransition.replace(/\brug\b/gi, 'critical risk');
  const shortMint = `${catchItem.mint.slice(0, 6)}...${catchItem.mint.slice(-4)}`;
  const primarySignal = catchItem.triggerSignals?.[0]
    ?? (catchItem.reason === 'score_drop' ? 'Rapid score deterioration' : 'Tier crash detected');
  return [
    `RISK ALERT: $${catchItem.symbol} ${transition}`,
    `Score ${catchItem.initialScore}->${catchItem.caughtScore} (-${catchItem.scoreDrop})`,
    primarySignal,
    `Mint ${shortMint}`,
    shareUrl,
    '@BagsApp #Solana #Sentinel',
  ].join('\n');
}

function renderManualShareHtml(data: {
  title: string;
  symbol: string;
  mint: string;
  cardUrl: string;
  evidenceUrl: string;
  dashboardUrl: string;
  text: string;
  intentUrl: string;
}): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(data.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:24px}.wrap{max-width:1040px;margin:0 auto}.panel{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:16px}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:920px){.row{grid-template-columns:1fr}}h1{font-size:1.4rem;margin:0 0 4px;color:#fff}.sub{color:#64748b;margin:0 0 14px}.links a{color:#38bdf8;text-decoration:none}.links a:hover{text-decoration:underline}textarea{width:100%;min-height:180px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#dbeafe;padding:12px;font-size:.92rem;line-height:1.4}img{width:100%;height:auto;border-radius:12px;border:1px solid #1e293b;background:#020617}.btn{display:inline-block;padding:8px 12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;text-decoration:none;font-size:.88rem}</style></head><body>
<div class="wrap">
  <h1>Manual X Share Card</h1>
  <p class="sub">Copy text + save card image, then post manually on X.</p>
  <div class="row">
    <section class="panel">
      <p><b>${escapeHtml(data.symbol)}</b> · <span>${escapeHtml(data.mint)}</span></p>
      <p class="links"><a href="${escapeHtml(data.cardUrl)}" target="_blank">Open card SVG</a> · <a href="${escapeHtml(data.evidenceUrl)}" target="_blank">Evidence</a> · <a href="${escapeHtml(data.dashboardUrl)}" target="_blank">Dashboard</a></p>
      <textarea readonly>${escapeHtml(data.text)}</textarea>
      <p style="margin-top:12px"><a class="btn" href="${escapeHtml(data.intentUrl)}" target="_blank">Open in X (prefilled)</a></p>
    </section>
    <section class="panel">
      <img src="${escapeHtml(data.cardUrl)}" alt="Sentinel share card" />
    </section>
  </div>
</div>
</body></html>`;
}

function buildXIntentUrl(postText: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(postText)}`;
}

function buildPngPreviewUrl(svgUrl: string): string {
  // X preview is more reliable with raster images than raw SVG.
  // We keep SVG as source-of-truth and derive a PNG URL via an image proxy.
  const withoutScheme = svgUrl.replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(withoutScheme)}&output=png&w=1200&h=630&fit=contain`;
}

function buildPngPreviewUrlFromMint(origin: string, mint: string, version: number): string {
  const svgUrl = `${origin}/v1/card/${mint}?v=${version}`;
  return buildPngPreviewUrl(svgUrl);
}

function renderXOgShareHtml(data: {
  pageUrl: string;
  title: string;
  description: string;
  cardSvgUrl: string;
  cardPngUrl: string;
  evidenceUrl: string;
  dashboardUrl: string;
  mint: string;
}): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(data.title)}</title>
<meta name="description" content="${escapeHtml(data.description)}" />
<link rel="canonical" href="${escapeHtml(data.pageUrl)}" />

<meta property="og:type" content="article" />
<meta property="og:url" content="${escapeHtml(data.pageUrl)}" />
<meta property="og:title" content="${escapeHtml(data.title)}" />
<meta property="og:description" content="${escapeHtml(data.description)}" />
<meta property="og:image" content="${escapeHtml(data.cardPngUrl)}" />
<meta property="og:image:secure_url" content="${escapeHtml(data.cardPngUrl)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:site_name" content="Sentinel" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(data.title)}" />
<meta name="twitter:description" content="${escapeHtml(data.description)}" />
<meta name="twitter:image" content="${escapeHtml(data.cardPngUrl)}" />
<meta name="twitter:image:alt" content="Sentinel risk alert card for ${escapeHtml(data.mint)}" />

<style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto}.panel{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:16px}
h1{margin:0 0 8px;color:#fff;font-size:1.3rem}.sub{margin:0 0 14px;color:#94a3b8}
a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}
img{width:100%;height:auto;border-radius:12px;border:1px solid #1e293b;background:#020617}
</style>
</head><body>
<div class="wrap">
  <div class="panel">
    <h1>${escapeHtml(data.title)}</h1>
    <p class="sub">This link is optimized for X preview cards.</p>
    <p><a href="${escapeHtml(data.dashboardUrl)}" target="_blank">Open dashboard</a> · <a href="${escapeHtml(data.evidenceUrl)}" target="_blank">Open evidence</a> · <a href="${escapeHtml(data.cardSvgUrl)}" target="_blank">Open raw SVG card</a></p>
    <img src="${escapeHtml(data.cardSvgUrl)}" alt="Sentinel share card" />
  </div>
</div>
</body></html>`;
}

/**
 * GET /v1/watch/catch-evidence/:mint?caughtAt=<ms>
 * Immutable evidence bundle for a risk deterioration catch (KV, no TTL).
 */
app.get('/v1/watch/catch-evidence/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) {
    return c.json({ ok: false, error: 'Invalid Solana mint address' }, 400);
  }
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const caughtAtRaw = c.req.query('caughtAt');
  const caughtAt = caughtAtRaw ? Number(caughtAtRaw) : undefined;
  const evidence = await getCatchEvidence(kv, mint, caughtAt);
  if (!evidence) return c.json({ ok: false, error: 'No evidence bundle for this mint yet' }, 404);
  const accept = c.req.header('accept') ?? '';
  const wantsJson = c.req.query('format') === 'json' || !accept.includes('text/html');
  if (!wantsJson) {
    const report = await getAccuracyReport(kv, 100).catch(() => null);
    const outcome = report?.records.find((r) => r.mint === evidence.mint && r.caughtAt === evidence.caughtAt);
    return new Response(renderCatchEvidenceHtml(evidence, outcome), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  }
  return c.json({ ok: true, data: evidence });
});

/**
 * GET /v1/watch/accuracy
 * Public post-alert outcome tracker for risk deterioration catches.
 *
 * A catch is only "confirmed" when a post-alert external outcome is observed
 * (RugCheck rugged flag or >=80% external liquidity / DBC pool collapse).
 */
app.get('/v1/watch/accuracy', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 250);
  const report = await getAccuracyReport(kv, limit);

  const accept = c.req.header('accept') ?? '';
  const wantsJson = c.req.query('format') === 'json' || !accept.includes('text/html');
  if (wantsJson) return c.json({ ok: true, data: report });

  const fmtTs = (ts: number | null | undefined) => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
  const fmtMs = (ms: number | null | undefined) => {
    if (!ms || ms < 0) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  };
  const fmtPct = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`;
  const statusColor = (s: string) =>
    s === 'confirmed' ? '#4ade80' :
    s === 'false_positive' ? '#f87171' :
    s === 'inconclusive' ? '#facc15' : '#38bdf8';
  const rows = report.records.map((r) => `<tr>
    <td><b>${String(r.symbol || r.mint.slice(0, 8))}</b><br><span class="mono">${r.mint.slice(0, 8)}…</span></td>
    <td><span style="color:${statusColor(r.summaryStatus)}">${r.summaryStatus}</span></td>
    <td>${r.initialScore} → <b>${r.caughtScore}</b></td>
    <td>${r.windows.m15.status} / ${r.windows.h1.status} / ${r.windows.h24.status}</td>
    <td>${r.confirmationReasons.slice(0, 2).join('<br>') || '—'}</td>
    <td class="dim">${fmtTs(r.caughtAt)}</td>
  </tr>`).join('');
  const m = report.metrics;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Post-Alert Outcomes</title>
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}h1{color:#fff;font-size:1.5rem;margin:0 0 4px}p.sub{color:#64748b;font-size:.85rem;margin:0 0 28px}table{width:100%;border-collapse:collapse;font-size:.875rem}th{text-align:left;color:#475569;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;border-bottom:1px solid #1e293b}td{padding:10px 12px;border-bottom:1px solid #1e293b16;vertical-align:top}tr:hover td{background:#ffffff08}.mono{color:#64748b;font-size:.75rem;font-family:monospace}.dim{color:#64748b;font-size:.8rem}.stat-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:28px}.stat{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px 20px}.stat-val{font-size:2rem;font-weight:900;color:#fff}.stat-lbl{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-top:4px}.footer{margin-top:24px;font-size:.75rem;color:#64748b}a{color:#38bdf8}</style></head><body>
<h1>⬡ Sentinel — Post-Alert Outcomes</h1>
<p class="sub">15m / 1h / 24h verification windows · confirmed only by external post-alert evidence</p>
<div class="stat-grid">
  <div class="stat"><div class="stat-val">${m.total}</div><div class="stat-lbl">Tracked</div></div>
  <div class="stat"><div class="stat-val" style="color:#4ade80">${m.confirmed}</div><div class="stat-lbl">Confirmed</div></div>
  <div class="stat"><div class="stat-val" style="color:#f87171">${m.falsePositive}</div><div class="stat-lbl">False positives</div></div>
  <div class="stat"><div class="stat-val">${fmtPct(m.precision)}</div><div class="stat-lbl">Precision</div></div>
  <div class="stat"><div class="stat-val">${fmtMs(m.medianLeadTimeMs)}</div><div class="stat-lbl">Median baseline age</div></div>
</div>
<table><thead><tr><th>Token</th><th>Status</th><th>Score</th><th>15m / 1h / 24h</th><th>Evidence</th><th>Alerted at</th></tr></thead><tbody>${rows || '<tr><td colspan=6 style="color:#64748b;padding:20px 12px">No outcome records yet. New catches will appear here after cron seeds them.</td></tr>'}</tbody></table>
<div class="footer">Raw JSON: <a href="?format=json">/v1/watch/accuracy?format=json</a> · Confirmation rule: RugCheck rugged OR ≥80% external liquidity/pool collapse.</div>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
});

/**
 * GET /v1/watch/share/latest
 * Returns ready-to-share payload for manual X posting (latest catch):
 * - card URL (SVG)
 * - copy-ready post text
 * - evidence + dashboard URLs
 *
 * Accepts HTML (default when browser requests text/html) and JSON (?format=json).
 */
app.get('/v1/watch/share/latest', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const recent = await getRecentCatches(kv, 1);
  const latest = recent[0];
  if (!latest) return c.json({ ok: false, error: 'No catches yet' }, 404);

  const url = new URL(c.req.url);
  const origin = url.origin;
  const stableShareUrl = `${origin}/v1/watch/share/${latest.mint}/x?caughtAt=${latest.caughtAt}&cb=${latest.caughtAt}`;
  const cardUrl = `${origin}/v1/card/${latest.mint}`;
  const evidenceUrl = `${origin}/v1/watch/catch-evidence/${latest.mint}?caughtAt=${latest.caughtAt}`;
  const dashboardUrl = `https://sentinel-dashboard-3uy.pages.dev/?risk=${latest.mint}`;
  const text = buildManualShareText(latest, stableShareUrl);
  const intentUrl = buildXIntentUrl(text);

  const payload = {
    mint: latest.mint,
    symbol: latest.symbol,
    name: latest.name,
    scoreDrop: latest.scoreDrop,
    tierTransition: latest.tierTransition,
    caughtAt: latest.caughtAt,
    cardUrl,
    shareUrl: stableShareUrl,
    evidenceUrl,
    dashboardUrl,
    text,
    postText: text,
    intentUrl,
  };

  const accept = c.req.header('accept') ?? '';
  const wantsJson = c.req.query('format') === 'json' || !accept.includes('text/html');
  if (wantsJson) return c.json({ ok: true, data: payload });

  const html = renderManualShareHtml({
    title: 'Sentinel Manual X Share',
    symbol: latest.symbol,
    mint: latest.mint,
    cardUrl,
    evidenceUrl,
    dashboardUrl,
    text,
    intentUrl,
  });
  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
});

/**
 * GET /v1/watch/share/latest/post.txt
 * Plain text message ready to paste directly into X composer.
 */
app.get('/v1/watch/share/latest/post.txt', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.text('KV not configured', 500);

  const recent = await getRecentCatches(kv, 1);
  const latest = recent[0];
  if (!latest) return c.text('No catches yet', 404);

  const url = new URL(c.req.url);
  const origin = url.origin;
  const stableShareUrl = `${origin}/v1/watch/share/${latest.mint}/x?caughtAt=${latest.caughtAt}&cb=${latest.caughtAt}`;
  const text = buildManualShareText(latest, stableShareUrl);

  return new Response(text, {
    headers: {
      'content-type': 'text/plain;charset=utf-8',
      'cache-control': 'public, max-age=30',
    },
  });
});

/**
 * GET /v1/watch/share/latest/intent
 * Opens X intent composer with latest catch post text prefilled.
 */
app.get('/v1/watch/share/latest/intent', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.text('KV not configured', 500);

  const recent = await getRecentCatches(kv, 1);
  const latest = recent[0];
  if (!latest) return c.text('No catches yet', 404);

  const url = new URL(c.req.url);
  const origin = url.origin;
  const stableShareUrl = `${origin}/v1/watch/share/${latest.mint}/x?caughtAt=${latest.caughtAt}&cb=${latest.caughtAt}`;
  const text = buildManualShareText(latest, stableShareUrl);
  const intentUrl = buildXIntentUrl(text);

  return Response.redirect(intentUrl, 302);
});

/**
 * GET /v1/watch/share/latest/og-image.png
 * Returns PNG suitable for OG/Twitter preview cards (latest catch).
 * Image is generated by proxying the latest token SVG card through a PNG renderer.
 */
app.get('/v1/watch/share/latest/og-image.png', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.text('KV not configured', 500);

  const recent = await getRecentCatches(kv, 1);
  const latest = recent[0];
  if (!latest) return c.text('No catches yet', 404);

  const reqUrl = new URL(c.req.url);
  const origin = reqUrl.origin;
  const sourceUrl = buildPngPreviewUrlFromMint(origin, latest.mint, latest.caughtAt);

  const imgRes = await fetch(sourceUrl, {
    cf: {
      cacheTtl: 120,
      cacheEverything: true,
    },
  } as RequestInit);

  if (!imgRes.ok) {
    // Fallback: serve SVG directly if PNG conversion fails.
    const svgFallback = await fetch(`${origin}/v1/card/${latest.mint}?v=${latest.caughtAt}`);
    if (!svgFallback.ok) return c.text('Failed to render preview image', 502);
    return new Response(svgFallback.body, {
      headers: {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=60',
      },
    });
  }

  return new Response(imgRes.body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=120',
    },
  });
});

/**
 * GET /v1/watch/share/og-image/:mint?caughtAt=<ms>
 * Deterministic OG image for a specific catch/mint, used by stable share URLs.
 */
app.get('/v1/watch/share/og-image/:mint', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) return c.text('Invalid mint', 400);

  const caughtAt = Number(c.req.query('caughtAt') ?? Date.now());
  const reqUrl = new URL(c.req.url);
  const origin = reqUrl.origin;
  const sourceUrl = buildPngPreviewUrlFromMint(origin, mint, Number.isFinite(caughtAt) ? caughtAt : Date.now());

  const imgRes = await fetch(sourceUrl, {
    cf: {
      cacheTtl: 300,
      cacheEverything: true,
    },
  } as RequestInit);

  if (!imgRes.ok) {
    const svgFallback = await fetch(`${origin}/v1/card/${mint}?v=${Number.isFinite(caughtAt) ? caughtAt : Date.now()}`);
    if (!svgFallback.ok) return c.text('Failed to render preview image', 502);
    return new Response(svgFallback.body, {
      headers: {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=120',
      },
    });
  }

  return new Response(imgRes.body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300',
    },
  });
});

/**
 * GET /v1/watch/share/:mint/x?caughtAt=<ms>
 * Stable OG/Twitter share page for a specific catch/mint.
 * Prefer this URL when posting on X to avoid mutable "latest" cache artifacts.
 */
app.get('/v1/watch/share/:mint/x', async (c) => {
  const mint = c.req.param('mint');
  if (!SOLANA_ADDR_RE.test(mint)) return c.text('Invalid mint', 400);

  const caughtAt = Number(c.req.query('caughtAt') ?? Date.now());
  const reqUrl = new URL(c.req.url);
  const origin = reqUrl.origin;
  const cacheBust = c.req.query('cb') ?? String(Date.now());
  const pageUrl = reqUrl.toString();
  const cardSvgUrl = `${origin}/v1/card/${mint}?v=${Number.isFinite(caughtAt) ? caughtAt : Date.now()}`;
  const cardPngUrl = `${origin}/v1/watch/share/og-image/${mint}?caughtAt=${Number.isFinite(caughtAt) ? caughtAt : Date.now()}&cb=${encodeURIComponent(cacheBust)}`;
  const evidenceUrl = `${origin}/v1/watch/catch-evidence/${mint}${Number.isFinite(caughtAt) ? `?caughtAt=${caughtAt}` : ''}`;
  const dashboardUrl = `https://sentinel-dashboard-3uy.pages.dev/?risk=${mint}`;

  // Best-effort: enrich title from catch record when available.
  let symbol = mint.slice(0, 4).toUpperCase();
  let tierTransition = 'risk update';
  let scoreLine = mint.slice(0, 6) + '...' + mint.slice(-4);
  if (c.env.SENTINEL_KV) {
    const recent = await getRecentCatches(c.env.SENTINEL_KV, 50).catch(() => []);
    const found = recent.find((r) => r.mint === mint && (!Number.isFinite(caughtAt) || r.caughtAt === caughtAt));
    if (found) {
      symbol = found.symbol || symbol;
      tierTransition = found.tierTransition;
      scoreLine = `Score ${found.initialScore}->${found.caughtScore} (-${found.scoreDrop})`;
    }
  }

  const softenedTransition = tierTransition.replace(/\brug\b/gi, 'critical risk');
  const title = `RISK ALERT: $${symbol} ${softenedTransition}`;
  const description = scoreLine;

  const html = renderXOgShareHtml({
    pageUrl,
    title,
    description,
    cardSvgUrl,
    cardPngUrl,
    evidenceUrl,
    dashboardUrl,
    mint,
  });

  return new Response(html, {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
});

/**
 * GET /v1/watch/share/latest/x
 * OG/Twitter share page for the latest catch.
 * Use this URL directly in X to get a richer preview card.
 */
app.get('/v1/watch/share/latest/x', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const recent = await getRecentCatches(kv, 1);
  const latest = recent[0];
  if (!latest) return c.json({ ok: false, error: 'No catches yet' }, 404);

  const reqUrl = new URL(c.req.url);
  const origin = reqUrl.origin;
  const target = `${origin}/v1/watch/share/${latest.mint}/x?caughtAt=${latest.caughtAt}&cb=${Date.now()}`;
  return Response.redirect(target, 302);
});

// ── Telegram Alert Subscriptions ─────────────────────────

/**
 * POST /v1/alerts/subscribe
 * Body: { chatId: string, wallet?: string }
 * Subscribe a Telegram chat to receive risk catch broadcasts.
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
  return c.json({
    ok: true,
    message: wallet
      ? 'Subscribed. You will receive alerts for risk events on tokens where you are the creator wallet.'
      : 'Subscribed. You will receive alerts for new risk catches and high-signal risk events.',
  });
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

/**
 * GET /v1/alerts/telegram/bot — public bot identity
 * Returns the bot username so users can DM it (/start) to enable subscriptions.
 */
app.get('/v1/alerts/telegram/bot', async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'Telegram bot not configured' }, 500);
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || !body?.ok || !body?.result?.username) {
      return c.json({ ok: false, error: 'Failed to fetch bot info' }, 502);
    }
    const username = String(body.result.username);
    const deepLink = `https://t.me/${username}?start=sentinel`;
    return c.json({ ok: true, data: { username, deepLink } });
  } catch (e) {
    return c.json({ ok: false, error: 'Telegram getMe failed' }, 502);
  }
});

/**
 * POST /v1/alerts/telegram/resolve
 * Body: { username?: string }
 * Resolve a Telegram private chatId by reading recent bot updates.
 *
 * Requirement: the user must have DM'd the bot at least once (e.g. /start)
 * so that `getUpdates` contains their chat record.
 */
app.post('/v1/alerts/telegram/resolve', async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'Telegram bot not configured' }, 500);
  }
  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const username = body.username?.trim() ?? '';
  const chatId = await resolveTelegramChatId({
    botToken: c.env.TELEGRAM_BOT_TOKEN,
    username: username.length >= 2 ? username : undefined,
  });
  if (!chatId) {
    return c.json({
      ok: false,
      error: 'Could not resolve chatId. DM the bot first (send /start) then retry.',
    }, 404);
  }
  return c.json({ ok: true, data: { chatId } });
});

// ── Telegram Bot Commands (Webhook) ───────────────────────

type TgUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number; type?: string; username?: string; first_name?: string; last_name?: string };
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
  };
};

function tgHelpMessage(): string {
  return [
    '👋 <b>Sentinel bot</b> — proof-first risk checks + watchlists.',
    '',
    '<b>Commands</b>',
    '• <code>/status &lt;mint&gt;</code> — current risk score + tier',
    '• <code>/why &lt;mint&gt;</code> — explanation for the score (AI if available)',
    '• <code>/watch &lt;mint&gt;</code> — add to your watchlist',
    '• <code>/unwatch &lt;mint&gt;</code> — remove from watchlist',
    '• <code>/list</code> — show your watched mints',
    '• <code>/report</code> — quick summary (watchlist + recent alerts)',
    '',
    'Tip: paste a mint address directly — I will treat it as <code>/status</code>.',
  ].join('\n');
}

function normalizeCommand(raw: string): { cmd: string; args: string[] } {
  const s = raw.trim();
  if (!s) return { cmd: '', args: [] };
  const parts = s.split(/\s+/g);
  let head = parts[0] ?? '';
  if (head.startsWith('/')) head = head.slice(1);
  // Telegram supports /cmd@botusername
  head = head.split('@')[0] ?? head;
  return { cmd: head.toLowerCase(), args: parts.slice(1) };
}

function safeMintArg(args: string[]): string | null {
  const m = (args[0] ?? '').trim();
  if (!m) return null;
  return SOLANA_ADDR_RE.test(m) ? m : null;
}

function formatExplanationForTelegram(expl: any): string {
  if (!expl) return '<i>No explanation available.</i>';
  if (typeof expl === 'string') return expl;
  const why = typeof expl.why === 'string' ? expl.why : null;
  const pattern = typeof expl.pattern === 'string' ? expl.pattern : null;
  const action = typeof expl.action === 'string' ? expl.action : null;
  const confidence = typeof expl.confidence === 'string' ? expl.confidence : null;
  const lines = [
    why ? `• <b>Why</b>: ${why}` : null,
    pattern ? `• <b>Pattern</b>: ${pattern}` : null,
    action ? `• <b>Action</b>: ${action}` : null,
    confidence ? `• <b>Confidence</b>: ${String(confidence).toUpperCase()}` : null,
  ].filter(Boolean) as string[];
  return lines.length > 0 ? lines.join('\n') : '<i>No explanation available.</i>';
}

app.post('/v1/telegram/webhook', async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'Telegram bot not configured' }, 500);
  }

  // Optional hardening: if TELEGRAM_WEBHOOK_SECRET is configured, require it.
  const secret = (c.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (secret) {
    const headerSecret = (c.req.header('x-telegram-bot-api-secret-token') ?? '').trim();
    const querySecret = (c.req.query('secret') ?? '').trim();
    if (headerSecret !== secret && querySecret !== secret) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }
  }

  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  const updateId = typeof update?.update_id === 'number' ? update.update_id : null;
  if (updateId != null) {
    const dedupeKey = `tg:webhook:seen:${updateId}`;
    const seen = await kv.get(dedupeKey);
    if (seen) {
      c.executionCtx.waitUntil(incrementKvCounter(kv, 'tg:webhook:metric:duplicates'));
      return c.json({ ok: true, duplicate: true });
    }
    await kv.put(dedupeKey, '1', { expirationTtl: TG_WEBHOOK_DEDUPE_TTL_SECONDS });
  }

  const msg = update?.message;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof msg?.date === 'number' && msg.date < (nowSec - TG_WEBHOOK_MAX_AGE_SECONDS)) {
    c.executionCtx.waitUntil(incrementKvCounter(kv, 'tg:webhook:metric:stale'));
    return c.json({ ok: true, stale: true });
  }

  const chatIdNum = msg?.chat?.id;
  const text = (msg?.text ?? '').trim().slice(0, TG_WEBHOOK_MAX_TEXT_LENGTH);
  if (!chatIdNum || !text) return c.json({ ok: true });

  const chatId = String(chatIdNum);

  const isMintPaste = SOLANA_ADDR_RE.test(text);
  const { cmd, args } = isMintPaste ? { cmd: 'status', args: [text] } : normalizeCommand(text);

  const send = async (message: string): Promise<void> => {
    await sendTelegramMessage({
      botToken: c.env.TELEGRAM_BOT_TOKEN!,
      chatId,
      message,
      parseMode: 'HTML',
    });
  };

  if (!cmd || cmd === 'start' || cmd === 'help') {
    await send(tgHelpMessage());
    return c.json({ ok: true });
  }

  if (cmd === 'watch') {
    const mint = safeMintArg(args);
    if (!mint) {
      await send('Usage: <code>/watch &lt;mint&gt;</code>');
      return c.json({ ok: true });
    }
    const wl = await addWatchMint(kv, chatId, mint);
    await send([
      '✅ Added to watchlist.',
      `Now watching: <b>${wl.mints.length}</b> token(s).`,
      `<a href="https://sentinel-dashboard-3uy.pages.dev/?risk=${mint}">Open on Sentinel ↗</a>`,
    ].join('\n'));
    return c.json({ ok: true });
  }

  if (cmd === 'unwatch') {
    const mint = safeMintArg(args);
    if (!mint) {
      await send('Usage: <code>/unwatch &lt;mint&gt;</code>');
      return c.json({ ok: true });
    }
    const wl = await removeWatchMint(kv, chatId, mint);
    await send(`🧹 Removed. Watchlist now: <b>${wl.mints.length}</b> token(s).`);
    return c.json({ ok: true });
  }

  if (cmd === 'list') {
    const wl = await getWatchlist(kv, chatId);
    if (wl.mints.length === 0) {
      await send('Your watchlist is empty. Add one: <code>/watch &lt;mint&gt;</code>');
      return c.json({ ok: true });
    }
    const lines = wl.mints.slice(0, 25).map((m) => `• <code>${m.slice(0, 4)}…${m.slice(-4)}</code>`);
    await send([
      `👁 Watchlist: <b>${wl.mints.length}</b> token(s)`,
      ...lines,
      wl.mints.length > 25 ? `… +${wl.mints.length - 25} more` : null,
    ].filter(Boolean).join('\n'));
    return c.json({ ok: true });
  }

  if (cmd === 'status' || cmd === 'why' || cmd === 'report') {
    const mint = cmd === 'report' ? null : safeMintArg(args);
    if ((cmd === 'status' || cmd === 'why') && !mint) {
      await send(`Usage: <code>/${cmd} &lt;mint&gt;</code>`);
      return c.json({ ok: true });
    }

    if (cmd === 'report') {
      const wl = await getWatchlist(kv, chatId);
      const lines: string[] = [];
      lines.push('🧾 <b>Sentinel report</b>');
      lines.push(`👁 Watchlist: <b>${wl.mints.length}</b> token(s)`);
      if (wl.mints.length > 0) {
        const sample = wl.mints.slice(0, 5);
        lines.push('');
        lines.push('<b>Quick status (sample)</b>');
        for (const m of sample) {
          try {
            const next = await computeRiskScore(m, {
              HELIUS_API_KEY: c.env.HELIUS_API_KEY,
              BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
            });
            const prev = await getBaseline(kv, chatId, m);
            lines.push(formatDeltaLine({
              mint: m,
              symbol: (next as any).tokenSymbol ?? (next as any).symbol ?? null,
              prev,
              nextScore: next.score,
              nextTier: next.tier,
            }));
            await putBaseline(kv, chatId, { mint: m, score: next.score, tier: next.tier, capturedAt: Date.now() });
          } catch {
            lines.push(`• <code>${m.slice(0, 4)}…${m.slice(-4)}</code>: <i>failed to score</i>`);
          }
        }
        if (wl.mints.length > 5) lines.push(`… +${wl.mints.length - 5} more`);
      }
      lines.push('');
      lines.push('For a token: <code>/status &lt;mint&gt;</code> · <code>/why &lt;mint&gt;</code>');
      await send(lines.join('\n'));
      return c.json({ ok: true });
    }

    // status/why
    try {
      const next = await computeRiskScore(mint!, {
        HELIUS_API_KEY: c.env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
      });
      const prev = await getBaseline(kv, chatId, mint!);
      await putBaseline(kv, chatId, { mint: mint!, score: next.score, tier: next.tier, capturedAt: Date.now() });

      const dashUrl = `https://sentinel-dashboard-3uy.pages.dev/?risk=${mint!}`;
      const short = `${mint!.slice(0, 4)}…${mint!.slice(-4)}`;
      const title = (next as any).tokenName ?? (next as any).name ?? null;
      const sym = (next as any).tokenSymbol ?? (next as any).symbol ?? null;

      if (cmd === 'status') {
        await send([
          `📊 <b>Status</b>${sym ? `: <b>${sym}</b>` : ''}`,
          title ? `🪙 <b>${title}</b> (<code>${short}</code>)` : `🪙 <code>${short}</code>`,
          formatDeltaLine({ mint: mint!, symbol: sym ?? null, prev, nextScore: next.score, nextTier: next.tier }),
          '',
          `<a href="${dashUrl}">Open on Sentinel ↗</a>`,
        ].join('\n'));
        return c.json({ ok: true });
      }

      // why
      const tokenName = typeof title === 'string' ? title : undefined;
      const cachedExplain = await kv.get(`explain:${mint!}`, 'json').catch(() => null) as any;
      let explanationObj: any = cachedExplain?.explanation ?? null;
      if (!explanationObj) {
        const exp = await generateRiskExplanation(next as any, { AI: c.env.AI }, tokenName);
        explanationObj = exp;
        kv.put(`explain:${mint!}`, JSON.stringify({ mint: mint!, score: next.score, tier: next.tier, explanation: exp }), { expirationTtl: 600 }).catch(() => {});
      }

      await send([
        `🧠 <b>Why</b>${sym ? `: <b>${sym}</b>` : ''}`,
        title ? `🪙 <b>${title}</b> (<code>${short}</code>)` : `🪙 <code>${short}</code>`,
        `📉 Risk: <b>${next.score}/100</b> (${String(next.tier).toUpperCase()})`,
        '',
        formatExplanationForTelegram(explanationObj),
        '',
        `<a href="${dashUrl}">Open on Sentinel ↗</a>`,
      ].join('\n'));
      return c.json({ ok: true });
    } catch {
      await send('❌ Failed to compute risk score. Try again in a few seconds.');
      return c.json({ ok: true });
    }
  }

  await send('Unknown command. Send <code>/help</code>.');
  return c.json({ ok: true });
});

/**
 * GET /v1/alerts/subscription/:chatId — debug helper
 * Returns the subscription record for a Telegram chat ID.
 * Intended for demo / verification flows (shows wallet filter + timestamps).
 */
app.get('/v1/alerts/subscription/:chatId', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);

  const chatId = (c.req.param('chatId') ?? '').trim();
  if (!chatId || !/^\-?\d+$/.test(chatId)) {
    return c.json({ ok: false, error: 'chatId must be a numeric Telegram chat ID' }, 400);
  }

  const sub = await getSubscription(kv, chatId);
  if (!sub) return c.json({ ok: true, data: { subscribed: false } });

  return c.json({
    ok: true,
    data: {
      subscribed: true,
      chatId: sub.chatId,
      wallet: sub.wallet ?? null,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    },
  });
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
  const authedWallet = await resolveAuthedWallet(c);
  const scannerWallet = authedWallet ?? (c.req.header('x-wallet') ?? null);
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

// ── AI Risk Explanation ──────────────────────────────────

/**
 * POST /v1/risk/explain
 * Body: { mint: string, tokenName?: string }
 * Returns: AI-generated reasoning over the risk breakdown.
 * Falls back to rule-based explanation if Workers AI is unavailable.
 */
app.post('/v1/risk/explain', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.mint !== 'string' || !SOLANA_ADDR_RE.test(body.mint)) {
    return c.json({ ok: false, error: 'Invalid or missing mint address' }, 400);
  }

  const { mint, tokenName } = body as { mint: string; tokenName?: string };
  const kv = c.env.SENTINEL_KV;

  // Serve cached explanation (10 min TTL)
  if (kv) {
    const cached = await kv.get(`explain:${mint}`, 'json');
    if (cached) {
      return c.json({ ok: true, data: cached, cached: true }, 200, { 'x-cache': 'HIT' });
    }
  }

  // Fetch or reuse risk score
  let riskScore: RiskScore | null = null;
  if (kv) {
    riskScore = await kv.get<RiskScore>(`risk:${mint}`, 'json');
  }
  if (!riskScore) {
    try {
      riskScore = await computeRiskScore(mint, {
        HELIUS_API_KEY: c.env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: c.env.BIRDEYE_API_KEY,
      });
    } catch {
      return c.json({ ok: false, error: 'Failed to fetch risk score' }, 500);
    }
  }

  const explanation = await generateRiskExplanation(riskScore, { AI: c.env.AI }, tokenName);

  const result = { mint, score: riskScore.score, tier: riskScore.tier, explanation };

  if (kv) {
    c.executionCtx.waitUntil(
      kv.put(`explain:${mint}`, JSON.stringify(result), { expirationTtl: 600 }),
    );
  }

  return c.json({ ok: true, data: result }, 200, { 'x-cache': 'MISS' });
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
    baseMint?: string;
    feeClaimers?: FeeClaimerEntry[];
    payer?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.baseMint || !SOLANA_ADDR_RE.test(body.baseMint)) {
    return c.json({ ok: false, error: 'Invalid baseMint (token mint address)' }, 400);
  }
  if (!body.payer || !SOLANA_ADDR_RE.test(body.payer)) {
    return c.json({ ok: false, error: 'Invalid payer wallet address' }, 400);
  }
  if (!Array.isArray(body.feeClaimers) || body.feeClaimers.length === 0) {
    return c.json({ ok: false, error: 'feeClaimers array required (wallet + bps entries)' }, 400);
  }

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
      { baseMint: body.baseMint, feeClaimers: body.feeClaimers, payer: body.payer },
      c.env.BAGS_API_KEY,
    );
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Fee config error:', msg);
    return c.json({ ok: false, error: msg }, 500);
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

function renderTokenFeedHtml(enriched: TokenFeedItem[]): Response {
  const rows = enriched.slice(0, 50).map((t) => {
    const score = t.riskScore ?? null;
    const tier = t.riskTier ?? null;
    const tierColor =
      tier === 'safe' ? '#4ade80' :
      tier === 'caution' ? '#fb923c' :
      tier === 'danger' ? '#f87171' :
      '#94a3b8';
    const bagsUrl = `https://bags.fm/token/${t.mint}`;
    const dashUrl = `https://sentinel-dashboard-3uy.pages.dev/?risk=${t.mint}`;
    const scoreCell = score === null ? '<span class="dim">—</span>' : `<b>${score}</b>`;
    const fee = typeof (t as any).lifetimeFees === 'number' ? (t as any).lifetimeFees : null;
    const feeCell = fee === null ? '<span class="dim">—</span>' : `$${Math.round(fee).toLocaleString()}`;
    const liq = typeof (t as any).liquidity === 'number' ? (t as any).liquidity : null;
    const liqCell = liq === null ? '<span class="dim">—</span>' : `$${Math.round(liq).toLocaleString()}`;
    return `<tr>
          <td><b>${t.symbol ?? '—'}</b><div class="dim mono">${t.mint.slice(0, 8)}…</div></td>
          <td>${feeCell}</td>
          <td>${liqCell}</td>
          <td>${scoreCell}</td>
          <td><span class="badge" style="border-color:${tierColor};color:${tierColor}">${tier ?? 'unscored'}</span></td>
          <td class="links"><a href="${dashUrl}" target="_blank">view ↗</a> · <a href="${bagsUrl}" target="_blank">bags ↗</a></td>
        </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Bags Feed</title>
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}h1{color:#fff;font-size:1.5rem;margin:0 0 4px}p.sub{color:#64748b;font-size:.85rem;margin:0 0 24px}table{width:100%;border-collapse:collapse;font-size:.875rem}th{text-align:left;color:#475569;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;border-bottom:1px solid #1e293b}td{padding:10px 12px;border-bottom:1px solid #1e293b16;vertical-align:top}tr:hover td{background:#ffffff08}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.dim{color:#64748b;font-size:.8rem}.badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #334155;background:#0f172a;font-size:.75rem;font-weight:800}.links a{color:#38bdf8;text-decoration:none}.links a:hover{text-decoration:underline}.footer{margin-top:18px;font-size:.75rem;color:#334155}</style></head><body>
<h1>⬡ Sentinel — Bags-native Token Feed</h1>
<p class="sub">Top tokens on Bags (fee-sorted) + cached Sentinel risk scores · demo-friendly view</p>
<table><thead><tr><th>Token</th><th>Lifetime fees</th><th>Liquidity</th><th>Risk score</th><th>Tier</th><th>Links</th></tr></thead><tbody>
${rows || '<tr><td colspan="6" style="color:#64748b;padding:20px 12px">No tokens found.</td></tr>'}
</tbody></table>
<div class="footer">Force JSON: <a href="/v1/tokens/feed?format=json">/v1/tokens/feed?format=json</a></div>
</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}

app.get('/v1/tokens/feed', async (c) => {
  const kv = c.env.SENTINEL_KV;
  const format = (c.req.query('format') ?? '').toLowerCase();
  const accept = c.req.header('accept') ?? '';
  const wantsHtml = format !== 'json' && accept.includes('text/html');

  // Check KV cache (30s TTL for feed)
  if (kv) {
    const cached = await kv.get('feed:top-scored', 'json');
    if (cached) {
      if (wantsHtml) {
        return renderTokenFeedHtml(cached as TokenFeedItem[]);
      }
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

    if (wantsHtml) return renderTokenFeedHtml(enriched);

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

    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/html')) {
      const fmtTs = (ts: number) => new Date(ts).toISOString().replace('T',' ').slice(0,19) + ' UTC';
      const sevColor = (s: string) => s==='critical'?'#f87171':s==='warning'?'#fb923c':s==='info'?'#38bdf8':'#94a3b8';
      const alerts = (feed.alerts ?? []) as import('../../shared/types').RiskAlert[];
      const rows = alerts.map((a) => `<tr>
        <td><b>${String(a.tokenSymbol ?? (String(a.mint ?? '').slice(0,8)+'…'))}</b></td>
        <td><span style="color:${sevColor(String(a.severity ?? ''))}">${String(a.severity ?? '—')}</span></td>
        <td>${String(a.type ?? '—')}</td>
        <td>${String(a.previousScore ?? '—')} → <b>${String(a.currentScore ?? '—')}</b></td>
        <td>${String(a.currentTier ?? '—')}</td>
        <td class="dim">${fmtTs(a.timestamp as number)}</td>
      </tr>`).join('');
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sentinel — Alert Feed</title>
<style>*{box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:32px}h1{color:#fff;font-size:1.5rem;margin:0 0 4px}p.sub{color:#64748b;font-size:.85rem;margin:0 0 28px}table{width:100%;border-collapse:collapse;font-size:.875rem}th{text-align:left;color:#475569;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;border-bottom:1px solid #1e293b}td{padding:10px 12px;border-bottom:1px solid #1e293b16}tr:hover td{background:#ffffff08}.dim{color:#64748b;font-size:.8rem}.footer{margin-top:24px;font-size:.75rem;color:#334155}a{color:#38bdf8}</style></head><body>
<h1>⬡ Sentinel — Alert Feed</h1>
<p class="sub">${alerts.length} alerts · sorted newest first · live data from Bags token monitoring</p>
<table><thead><tr><th>Token</th><th>Severity</th><th>Type</th><th>Score</th><th>Tier</th><th>Timestamp</th></tr></thead><tbody>${rows || '<tr><td colspan=6 style="color:#64748b;padding:20px 12px">No alerts yet.</td></tr>'}</tbody></table>
<div class="footer">Raw JSON: <a href="?format=json">/v1/alerts/feed?format=json</a> · <a href="https://sentinel-dashboard-3uy.pages.dev" target="_blank">View dashboard ↗</a></div>
</body></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

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

/**
 * GET /v1/alerts/debug
 * Shows adaptive calibration + quality suppression counters from latest scan.
 */
app.get('/v1/alerts/debug', async (c) => {
  const kv = c.env.SENTINEL_KV;
  if (!kv) return c.json({ ok: false, error: 'KV not configured' }, 500);
  try {
    const [debug, dupRaw, staleRaw] = await Promise.all([
      getAlertScannerDebug(kv),
      kv.get('tg:webhook:metric:duplicates'),
      kv.get('tg:webhook:metric:stale'),
    ]);
    return c.json({
      ok: true,
      data: {
        ...debug,
        telegramWebhook: {
          duplicatesDropped: Number(dupRaw || 0),
          staleDropped: Number(staleRaw || 0),
        },
      },
    });
  } catch (err) {
    console.error('Alert debug error:', err);
    return c.json({ ok: false, error: 'Failed to fetch alert debug info' }, 500);
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

async function broadcastCatch(env: Env, payload: CatchPayload): Promise<void> {
  const DASHBOARD_URL = SENTINEL_DASHBOARD_URL;

  if (env.TELEGRAM_BOT_TOKEN) {
    if (env.TELEGRAM_ALERT_CHANNEL_ID) {
      const { buildCatchMessage } = await import('./notify/alert-subscriptions');
      const msg = buildCatchMessage(payload);
      broadcastAlert(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALERT_CHANNEL_ID, msg)
        .catch((err) => console.error('Channel broadcast failed:', err));
    }

    if (env.SENTINEL_KV) {
      notifySubscribersOfCatch(env.SENTINEL_KV, env.TELEGRAM_BOT_TOKEN, payload)
        .catch((err) => console.error('Subscriber notify failed:', err));
    }
  }

  if (env.X_POST_RUG_ALERTS === '1' && env.SENTINEL_KV) {
    const creds = {
      apiKey: env.X_API_KEY,
      apiSecret: env.X_API_SECRET,
      accessToken: env.X_ACCESS_TOKEN,
      accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
    };
    if (hasXCredentials(creds)) {
      postCatchToX({
        kv: env.SENTINEL_KV,
        payload,
        creds,
        dashboardUrl: DASHBOARD_URL,
      }).catch((err) => console.error('X catch post failed:', err));
    }
  }
}

/** Broadcast freshly-recorded DBC drain catches to Telegram (channel + subscribers). */
async function broadcastDbcCatches(env: Env, dbcCatches: number): Promise<void> {
  if (dbcCatches <= 0) return;
  if (!env.SENTINEL_KV) return;
  const recent = await getRecentCatches(env.SENTINEL_KV, dbcCatches);
  const freshCutoff = Date.now() - 25 * 60 * 1000;
  const fresh = recent.filter((c) => c.caughtAt >= freshCutoff);
  for (const c of fresh) {
    const payload: CatchPayload = {
      mint: c.mint, symbol: c.symbol, name: c.name,
      initialScore: c.initialScore, caughtScore: c.caughtScore,
      scoreDrop: c.scoreDrop, tierTransition: c.tierTransition,
      initialAt: c.initialAt, caughtAt: c.caughtAt, reason: c.reason,
      triggerSignals: c.triggerSignals,
    };
    await broadcastCatch(env, payload);
  }
}

/** Pre-compute risk scores for top feed tokens (called from cron) */
async function precomputeFeedRiskScores(env: Env): Promise<void> {
  const kv = env.SENTINEL_KV;
  if (!kv) return;

  // Combine top lifetime-fees tokens (stable, established) with recent launches
  // (volatile, PRE_GRAD/MIGRATING) — rugs happen almost exclusively in the latter.
  const [top, recent] = await Promise.all([
    fetchTopTokens(env.BAGS_API_KEY),
    fetchRecentLaunches(env.BAGS_API_KEY),
  ]);

  // Deduplicate by mint; recent launches take precedence in order (higher rug risk priority)
  const seen = new Set<string>();
  const batch: typeof top = [];
  for (const t of [...recent, ...top]) {
    if (!seen.has(t.mint)) {
      seen.add(t.mint);
      batch.push(t);
      if (batch.length >= 100) break;
    }
  }

  for (const token of batch) {
    try {
      const score = await computeRiskScore(token.mint, {
        HELIUS_API_KEY: env.HELIUS_API_KEY,
        BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
      });
      // TTL: 10 min (cron runs every 15 min, so always recompute by next tick)
      await kv.put(`risk:${token.mint}`, JSON.stringify(score), { expirationTtl: 600 });
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
    const DASHBOARD_URL = SENTINEL_DASHBOARD_URL;

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
              // Broadcast fresh catches to all configured channels (Telegram/X)
              if (env.SENTINEL_KV) {
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
                    triggerSignals: c.triggerSignals,
                  };
                  await broadcastCatch(env, payload);
                }
              }
            }
          } catch (err) {
            console.error('Pre-rug watch failed:', err);
          }

          // DBC pool monitor: direct on-chain liquidity drain detection for PRE_GRAD tokens.
          // Bypasses the risk-score system entirely (those tokens have no RugCheck data).
          // Same combined pool as precompute; lighter pass (1 RPC batch per 100 mints).
          try {
            const [topPool, recentPool] = await Promise.all([
              fetchTopTokens(env.BAGS_API_KEY),
              fetchRecentLaunches(env.BAGS_API_KEY),
            ]);
            const dseen = new Set<string>();
            const dbatch: TokenFeedItem[] = [];
            for (const t of [...recentPool, ...topPool]) {
              if (!dseen.has(t.mint)) {
                dseen.add(t.mint);
                dbatch.push(t);
                if (dbatch.length >= 150) break;
              }
            }
            const dbcCatches = await runDbcPoolMonitor(env, dbatch);
            if (dbcCatches > 0) {
              console.log(`DBC pool monitor: ${dbcCatches} drain catch(es) recorded`);
              await broadcastDbcCatches(env, dbcCatches);
            }
            if (env.SENTINEL_KV) {
              const catches = await getRecentCatches(env.SENTINEL_KV, 100);
              await backfillOutcomeSeeds(env.SENTINEL_KV, catches, 20);
              const updatedOutcomes = await updatePendingOutcomes(env, dbatch);
              if (updatedOutcomes > 0) {
                console.log(`Outcome tracker: ${updatedOutcomes} prediction outcome(s) updated`);
              }
            }
          } catch (err) {
            console.error('DBC pool monitor failed:', err);
          }
        })(),

        // Alert scan — broadcast LP drain alerts to Telegram channel if configured
        runAlertScan(env).then(async (newAlerts) => {
          if (!env.TELEGRAM_BOT_TOKEN) return;
          const drainAlerts = newAlerts
            .filter(a => a.type === 'lp_drain')
            // Telegram should only get high-signal drains:
            // - confirmed multi-scan drains OR catastrophic drops that scanner marks as critical
            // WARNING/unconfirmed drains stay in the API feed/dashboard to avoid spam + false positives.
            .filter((a) => a.severity === 'critical' && a.confirmed !== false);

          // Mass-drain guard: if ≥3 tokens drain in the same cron cycle it's almost certainly
          // a Bags API outage (liquidity returned 0 for all), not individual rugs.
          // Suppress Telegram in this case to avoid false-positive spam.
          if (drainAlerts.length >= 3) {
            console.warn(`Mass-drain guard triggered: ${drainAlerts.length} LP drain alerts in one cycle — likely API outage, suppressing Telegram broadcast.`);
            // Still allow subscriber notifications (they are wallet-filtered), but skip channel spam.
          }

          // 1) Public channel broadcast (optional)
          if (env.TELEGRAM_ALERT_CHANNEL_ID && drainAlerts.length < 3) {
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
                {
                  confirmed: alert.confirmed,
                  riskScore: alert.currentScore,
                  riskTier: alert.currentTier,
                  dataConfidence: alert.dataConfidence,
                  missingSignals: alert.missingSignals,
                  marketPubkey: alert.marketPubkey,
                  lpMint: alert.lpMint,
                  lpLockedPct: alert.lpLockedPct,
                  lpLockedUsd: alert.lpLockedUsd,
                },
              );
              await broadcastAlert(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALERT_CHANNEL_ID, msg)
                .catch((err) => console.error('LP drain broadcast failed:', err));
            }
          }

          // 2) Personal subscribers (wallet-filtered for creators)
          if (env.SENTINEL_KV) {
            const { notifySubscribersOfAlert } = await import('./notify/alert-subscriptions');
            const creatorAlerts = newAlerts.filter((a) => a.type === 'lp_drain' || a.type === 'lp_unlock');
            await Promise.allSettled(
              creatorAlerts.map((a) => notifySubscribersOfAlert(env.SENTINEL_KV!, env.TELEGRAM_BOT_TOKEN!, a)),
            );
          }
        }).catch((err) => console.error('Scheduled alert scan failed:', err)),

        // Watchlists — periodic delta scan with dedupe + thresholds
        (async () => {
          if (!env.SENTINEL_KV || !env.TELEGRAM_BOT_TOKEN) return;

          const kv = env.SENTINEL_KV;
          const botToken = env.TELEGRAM_BOT_TOKEN;

          const tierRank = (tier: string): number => {
            const t = String(tier || '').toLowerCase();
            if (t === 'safe') return 0;
            if (t === 'caution') return 1;
            if (t === 'danger') return 2;
            if (t === 'rug') return 3;
            return 99;
          };

          try {
            const { listWatchlistChatIds } = await import('./notify/watchlists');
            const chatIds = (await listWatchlistChatIds(kv)).slice(0, 25);
            if (chatIds.length === 0) return;

            for (const chatId of chatIds) {
              const wl = await getWatchlist(kv, chatId);
              const mints = wl.mints.slice(0, 10);
              if (mints.length === 0) continue;

              for (const mint of mints) {
                const prev = await getBaseline(kv, chatId, mint);

                let next: RiskScore | null = null;
                try {
                  next = await computeRiskScore(mint, {
                    HELIUS_API_KEY: env.HELIUS_API_KEY,
                    BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
                  });
                } catch {
                  continue;
                }

                // Always refresh baseline
                await putBaseline(kv, chatId, { mint, score: next.score, tier: next.tier, capturedAt: Date.now() });

                // First capture: don't notify
                if (!prev) continue;

                const scoreDrop = prev.score - next.score;
                const tierWorsened = tierRank(next.tier) > tierRank(prev.tier);

                // Thresholds (high-signal only)
                const shouldNotify = tierWorsened || scoreDrop >= 10;
                if (!shouldNotify) continue;

                const dedupKey = `tg:watch:notify:${chatId}:${mint}`;
                const already = await kv.get(dedupKey);
                if (already) continue;

                const msg = [
                  '⚠️ <b>Watchlist delta</b>',
                  '',
                  formatDeltaLine({
                    mint,
                    symbol: (next as any).tokenSymbol ?? (next as any).symbol ?? null,
                    prev,
                    nextScore: next.score,
                    nextTier: next.tier,
                  }),
                  '',
                  `<a href="${DASHBOARD_URL}?risk=${mint}">Open on Sentinel ↗</a>`,
                ].join('\n');

                const sent = await sendTelegramMessage({ botToken, chatId, message: msg, parseMode: 'HTML' });
                if (sent) {
                  await kv.put(dedupKey, '1', { expirationTtl: 6 * 60 * 60 }); // 6h
                }
              }
            }
          } catch (err) {
            console.error('Watchlist scan failed:', err);
          }
        })(),

        runFeeMonitorScan(env).catch((err) => console.error('Scheduled fee monitor failed:', err)),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;

