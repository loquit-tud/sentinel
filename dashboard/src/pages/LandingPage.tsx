import { useEffect, useState } from 'react';
import {
  fetchTokenFeed,
  fetchApiStats,
  fetchSentFeeStats,
  fetchPreRugCatches,
  fetchAlertFeed,
  fetchRiskScore,
  explainRisk,
  resolveTelegramChatId,
  subscribeAlerts,
  unsubscribeAlerts,
  fetchSubscription,
  fetchTelegramBotInfo,
  fetchAlertSubscriberCount,
  type SentFeeStats,
  type PreRugCatch,
  type RiskExplanation,
} from '../api';
import type { RiskAlert } from '../../../shared/types';

// ─── Constants ─────────────────────────────────────────────────────────

const SENT_MINT = 'Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS';
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─── Hooks ─────────────────────────────────────────────────────────────

interface LiveStats {
  tokensTracked: number;
  totalApiCalls: number;
  riskScans: number;
  todayCalls: number;
  loading: boolean;
}

function useLiveStats(): LiveStats {
  const [stats, setStats] = useState<LiveStats>({
    tokensTracked: 0, totalApiCalls: 0, riskScans: 0, todayCalls: 0, loading: true,
  });
  useEffect(() => {
    Promise.all([fetchTokenFeed(), fetchApiStats()])
      .then(([tokens, apiStats]) => {
        setStats({
          tokensTracked: tokens.length,
          totalApiCalls: apiStats?.totalRequests ?? 0,
          riskScans: apiStats?.byEndpoint.risk ?? 0,
          todayCalls: apiStats?.today.total ?? 0,
          loading: false,
        });
      })
      .catch(() => setStats((s) => ({ ...s, loading: false })));
  }, []);
  return stats;
}

// ─── Visual primitives ────────────────────────────────────────────────

function SentinelLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 3L4 8v8c0 6.627 5.148 12.347 12 13.93C22.852 28.347 28 22.627 28 16V8L16 3z"
        fill="rgba(6,182,212,0.12)"
        stroke="rgba(6,182,212,0.5)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4" fill="none" stroke="#06b6d4" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="1.5" fill="#06b6d4" />
      <path d="M16 10v2M16 20v2M10 16h2M20 16h2" stroke="#06b6d4" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function StatBox({ value, label, loading = false }: { value: string; label: string; loading?: boolean }) {
  return (
    <div className="text-center px-4 sm:px-8">
      {loading ? (
        <div className="h-9 sm:h-10 w-20 mx-auto rounded-md bg-gradient-to-r from-slate-800/30 via-slate-700/60 to-slate-800/30 bg-[length:200%_100%] animate-shimmer" />
      ) : (
        <p className="text-3xl sm:text-4xl font-black text-white tabular-nums">{value}</p>
      )}
      <p className="text-[11px] text-gray-600 mt-1.5 uppercase tracking-widest">{label}</p>
    </div>
  );
}

// ─── $SENT Fee Stats widget ─────────────────────────────────────────────

function useSentFeeStats() {
  const [data, setData] = useState<SentFeeStats | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchSentFeeStats().then((d) => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  return { data, loading };
}

function fmt(n: number, decimals = 2): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(decimals)}`;
}

function SentFeeStatsWidget() {
  const { data, loading } = useSentFeeStats();

  return (
    <section className="px-6 py-14 border-t border-slate-800/50 bg-gradient-to-b from-cyan-950/10 via-transparent to-transparent">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/5 text-[10px] font-semibold text-cyan-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Live · updated every 5 min
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">$SENT earns you fees</h2>
          <p className="text-slate-400 mt-3 text-sm max-w-md mx-auto">
            Every trade on $SENT generates a 1% Bags fee. 30% of that goes directly to $SENT holders.
            Hold any amount to start earning.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl border border-slate-800/50 bg-slate-900/40 animate-pulse" />
            ))}
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="p-4 rounded-xl border border-slate-800/60 bg-slate-900/40 text-center">
                <div className="text-xl font-bold text-white">{fmt(data.volume24hUsd, 0)}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">24h Volume</div>
              </div>
              <div className="p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 text-center">
                <div className="text-xl font-bold text-cyan-400">{fmt(data.holdersShareDaily)}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Holders share / day</div>
              </div>
              <div className="p-4 rounded-xl border border-slate-800/60 bg-slate-900/40 text-center">
                <div className="text-xl font-bold text-white">{data.holderCount.toLocaleString()}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">$SENT holders</div>
              </div>
              <div className="p-4 rounded-xl border border-green-500/20 bg-green-500/5 text-center">
                <div className="text-xl font-bold text-green-400">{fmt(data.estimatedDailyPerHolder, 4)}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Est. daily / holder</div>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-800/60 bg-slate-900/30 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-sm text-slate-400 text-center sm:text-left">
                <span className="text-white font-semibold">{data.feeRatePct}% Bags fee</span>
                {' · '}
                <span className="text-cyan-400 font-semibold">{data.holderSharePct}%</span> goes to holders
                {' · '}
                price{' '}
                <span className="text-white font-medium">${data.price < 0.0001 ? data.price.toExponential(2) : data.price.toFixed(6)}</span>
              </div>
              <a
                href={`https://bags.fm/token/${SENT_MINT}`}
                target="_blank"
                rel="noopener"
                className="text-xs font-semibold px-4 py-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 transition-all whitespace-nowrap"
              >
                Buy $SENT on Bags ↗
              </a>
            </div>
          </>
        ) : (
          <div className="text-center text-sm text-slate-600 py-6">
            Stats temporarily unavailable —{' '}
            <a
              href={`https://bags.fm/token/${SENT_MINT}`}
              target="_blank"
              rel="noopener"
              className="text-cyan-400 hover:underline"
            >
              view $SENT on Bags ↗
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Pre-Rug Catches Banner — live evidence chain ─────────────────────

function formatLeadTime(ms: number): string {
  if (ms <= 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`;
}

function tierBadgeClass(tier: PreRugCatch['caughtTier']): string {
  switch (tier) {
    case 'rug':     return 'text-red-400 bg-red-500/10 border-red-500/20';
    case 'danger':  return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
    case 'caution': return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
    default:        return 'text-green-400 bg-green-500/10 border-green-500/20';
  }
}

interface EvidenceItem {
  key: string;
  symbol: string;
  mint: string;
  fromScore: number;
  toScore: number;
  drop: number;
  toTier: PreRugCatch['caughtTier'];
  flaggedAt: number;
  firstSeenAt: number;
  source: 'catch' | 'alert';
  triggerSignals?: string[];
  creatorPrevRug?: boolean;
  agentDecision?: PreRugCatch['agentDecision'];
}

function PreRugCatchesBanner() {
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [stats, setStats] = useState<{ tokensWatched: number; catches: number; avgLeadTimeMs: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [explanations, setExplanations] = useState<Record<string, RiskExplanation | null>>({});
  const [loadingExpl, setLoadingExpl] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchPreRugCatches(10).catch(() => null),
      fetchAlertFeed().catch(() => null),
    ]).then(([catchData, alertData]) => {
      const merged: EvidenceItem[] = [];

      // Pre-rug catches (high quality, ≥30min lead time)
      if (catchData) {
        for (const c of catchData.catches) {
          merged.push({
            key: c.mint + c.caughtAt,
            symbol: c.symbol || c.mint.slice(0, 6),
            mint: c.mint,
            fromScore: c.initialScore,
            toScore: c.caughtScore,
            drop: c.scoreDrop,
            toTier: c.caughtTier,
            flaggedAt: c.caughtAt,
            firstSeenAt: c.initialAt,
            source: 'catch',
            triggerSignals: c.triggerSignals,
            creatorPrevRug: c.creatorPrevRug,
            agentDecision: c.agentDecision,
          });
        }
        setStats(catchData.stats);
      }

      // Alert feed — tier_change warnings/critical not already in catches
      if (alertData) {
        const catchMints = new Set(merged.map((m) => m.mint));
        const tierAlerts = alertData.alerts.filter(
          (a: RiskAlert) =>
            a.type === 'tier_change' &&
            (a.severity === 'warning' || a.severity === 'critical') &&
            !catchMints.has(a.mint),
        );
        for (const a of tierAlerts.slice(0, 10)) {
          merged.push({
            key: a.id,
            symbol: a.tokenSymbol || a.mint.slice(0, 6),
            mint: a.mint,
            fromScore: a.previousScore ?? 0,
            toScore: a.currentScore ?? 0,
            drop: (a.previousScore ?? 0) - (a.currentScore ?? 0),
            toTier: (a.currentTier ?? 'danger') as PreRugCatch['caughtTier'],
            flaggedAt: a.timestamp,
            firstSeenAt: a.timestamp,
            source: 'alert',
          });
        }
      }

      // Sort newest first
      // Pre-rug catches always appear first (they are the anchor proof), then alerts newest first
      merged.sort((a, b) => {
        if (a.source === 'catch' && b.source !== 'catch') return -1;
        if (a.source !== 'catch' && b.source === 'catch') return 1;
        return b.flaggedAt - a.flaggedAt;
      });
      setItems(merged.slice(0, 8));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleExplain = async (item: EvidenceItem) => {
    if (explanations[item.mint] !== undefined || loadingExpl === item.mint) return;
    setLoadingExpl(item.mint);
    try {
      const result = await explainRisk(item.mint, item.symbol);
      setExplanations((prev) => ({ ...prev, [item.mint]: result?.explanation ?? null }));
    } catch {
      setExplanations((prev) => ({ ...prev, [item.mint]: null }));
    } finally {
      setLoadingExpl(null);
    }
  };

  if (loading) return null;

  return (
    <section className="px-6 py-14 border-t border-slate-800/50 bg-gradient-to-b from-red-950/10 via-transparent to-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-red-500/20 bg-red-500/5 text-[10px] font-semibold text-red-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            Evidence chain
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">Risk events · live</h2>
          <p className="text-slate-400 mt-3 text-sm">
            Every 15 minutes, our cron scans the top 100 Bags tokens. Tier drops and score collapses are logged automatically — not curated.
          </p>
        </div>

        {/* Proof of Alpha — agent performance metrics */}
        {stats && (
          <div className="mb-8 p-5 rounded-xl border border-green-500/20 bg-gradient-to-br from-green-950/30 via-slate-900/60 to-slate-900/40">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[9px] font-semibold tracking-widest uppercase text-green-400">⬡ Agent Performance · live proof</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div>
                <div className="text-3xl font-black text-white tabular-nums">{stats.catches || items.filter(i => i.source === 'catch').length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Catches logged</div>
              </div>
              <div>
                <div className="text-3xl font-black text-green-400 tabular-nums">
                  {stats.avgLeadTimeMs > 0 ? formatLeadTime(stats.avgLeadTimeMs) : '—'}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Avg lead time</div>
              </div>
              <div>
                <div className="text-3xl font-black text-red-400 tabular-nums">
                  {items.filter(i => i.drop > 0).length > 0
                    ? `−${Math.round(items.filter(i => i.drop > 0).reduce((s, i) => s + i.drop, 0) / items.filter(i => i.drop > 0).length)}`
                    : '—'}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Avg score drop</div>
              </div>
              <div>
                <div className="text-3xl font-black text-white tabular-nums">{stats.tokensWatched || 100}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Tokens watched</div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-slate-800/40 flex items-center justify-between text-[10px] text-slate-600">
              <span>Every catch is timestamped · lead time = time between first snapshot and alert</span>
              <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=100" target="_blank" rel="noopener" className="text-cyan-500 hover:underline">verify →</a>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <div className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 text-center">
            <p className="text-sm text-slate-400">
              <span className="text-green-400 font-medium">No events yet.</span> The watcher is running every 15 minutes.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((c) => (
              <div key={c.key} className="rounded-lg border border-slate-800/60 bg-slate-900/40 overflow-hidden">
                <div className="p-3.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white truncate">{c.symbol}</span>
                    <span className="text-[10px] font-mono text-slate-600 truncate">{c.mint.slice(0, 4)}…{c.mint.slice(-4)}</span>
                    {c.source === 'catch' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-cyan-500/20 text-cyan-500 bg-cyan-500/5">pre-rug</span>
                    )}
                    {c.creatorPrevRug && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 bg-red-500/10 font-semibold">⚠ repeat offender</span>
                    )}
                    {c.agentDecision && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${
                        c.agentDecision.action === 'escalate'        ? 'border-red-500/50 text-red-300 bg-red-500/15' :
                        c.agentDecision.action === 'telegram_alert'  ? 'border-orange-500/40 text-orange-300 bg-orange-500/10' :
                        c.agentDecision.action === 'log_alert'       ? 'border-slate-600/40 text-slate-400 bg-slate-800/30' :
                        c.agentDecision.action === 'rescan_soon'     ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/8' :
                        'border-green-500/20 text-green-500 bg-green-500/5'
                      }`}
                        title={`Agent decision (${c.agentDecision.decidedBy}, ${c.agentDecision.confidence}% confidence): ${c.agentDecision.reasoning}`}
                      >
                        {c.agentDecision.action === 'escalate'        ? '🚨 escalated' :
                         c.agentDecision.action === 'telegram_alert'  ? '📡 broadcast' :
                         c.agentDecision.action === 'log_alert'       ? '📝 logged' :
                         c.agentDecision.action === 'rescan_soon'     ? '⚡ rescanning' :
                         '👁 watching'}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Flagged {formatLeadTime(Date.now() - c.flaggedAt)} ago
                    {c.source === 'catch' && c.firstSeenAt !== c.flaggedAt && (
                      <> · first seen {formatLeadTime(Date.now() - c.firstSeenAt)} ago</>
                    )}
                  </div>
                  {/* Agent reasoning trace */}
                  {c.triggerSignals && c.triggerSignals.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {c.triggerSignals.map((sig, i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 border border-slate-700/40">
                          {sig}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-slate-500 line-through">{c.fromScore}</span>
                      <span className="text-[11px] text-slate-600">→</span>
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${tierBadgeClass(c.toTier)}`}>{c.toScore}</span>
                    </div>
                    {c.drop > 0 && <div className="text-[10px] text-red-400 mt-0.5">−{c.drop} pts</div>}
                  </div>
                  <button
                    onClick={() => handleExplain(c)}
                    disabled={loadingExpl === c.mint || explanations[c.mint] !== undefined}
                    className="text-[10px] font-medium px-2 py-1 rounded border border-violet-500/30 bg-violet-500/5 text-violet-400 hover:bg-violet-500/15 disabled:opacity-40 disabled:cursor-default transition-all whitespace-nowrap"
                    title="Ask AI why this token is risky"
                  >
                    {loadingExpl === c.mint ? '…' : explanations[c.mint] !== undefined ? '✓ AI' : '✦ Why?'}
                  </button>
                </div>
                </div>
                {/* AI Explanation Panel */}
                {explanations[c.mint] && (
                  <div className="border-t border-slate-800/60 bg-violet-950/20 px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] font-semibold tracking-widest uppercase text-violet-400">✦ Sentinel AI Analysis</span>
                      <span className={`text-[9px] px-1 py-0.5 rounded border ${
                        explanations[c.mint]!.confidence === 'high' ? 'border-green-500/20 text-green-400 bg-green-500/5' :
                        explanations[c.mint]!.confidence === 'medium' ? 'border-yellow-500/20 text-yellow-400 bg-yellow-500/5' :
                        'border-slate-600/40 text-slate-500 bg-slate-800/30'
                      }`}>{explanations[c.mint]!.confidence} confidence</span>
                    </div>
                    <p className="text-[11px] text-slate-300 leading-relaxed">{explanations[c.mint]!.why}</p>
                    <div className="flex flex-col sm:flex-row gap-2 text-[11px]">
                      <div className="flex gap-1.5 items-start">
                        <span className="text-violet-400 shrink-0">Pattern:</span>
                        <span className="text-slate-400">{explanations[c.mint]!.pattern}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5 items-start text-[11px]">
                      <span className="text-cyan-400 shrink-0">Action:</span>
                      <span className="text-slate-300 font-medium">{explanations[c.mint]!.action}</span>
                    </div>
                  </div>
                )}
                {explanations[c.mint] === null && (
                  <div className="border-t border-slate-800/60 bg-slate-900/20 px-4 py-2">
                    <p className="text-[10px] text-slate-600">AI analysis unavailable for this token.</p>
                  </div>
                )}
              </div>
            ))}
            <p className="text-center text-[11px] text-slate-600 mt-3">
              Raw log: <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=100" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">GET /v1/watch/catches</a>
              {' · '}
              <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">GET /v1/alerts/feed</a>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Live Risk Score Card (instant scan on $SENT) ────────────────────

function LiveRiskCard({ mint }: { mint: string }) {
  const [score, setScore] = useState<number | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const result = await fetchRiskScore(mint);
      if (result) {
        setScore(result.score);
        setTier(result.tier);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRan(true);
    }
  };

  const tierColor = tier === 'safe' ? 'text-green-400' : tier === 'caution' ? 'text-yellow-400' : tier === 'danger' ? 'text-orange-400' : 'text-red-400';
  const tierBg = tier === 'safe' ? 'bg-green-500/10 border-green-500/20' : tier === 'caution' ? 'bg-yellow-500/10 border-yellow-500/20' : tier === 'danger' ? 'bg-orange-500/10 border-orange-500/20' : 'bg-red-500/10 border-red-500/20';

  return (
    <div className="bg-gradient-to-br from-slate-900/80 to-slate-900/40 rounded-xl p-5 border border-slate-800/50">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🔍</span>
            <h3 className="text-white font-semibold text-sm tracking-tight">Live Risk Scanner</h3>
          </div>
          <p className="text-[11px] text-slate-500">8 signals · RugCheck · Helius · Birdeye · Bags</p>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap"
        >
          {loading ? 'Scanning…' : ran ? 'Re-scan' : 'Scan $SENT'}
        </button>
      </div>

      {!ran && !loading && (
        <div className="text-[11px] text-slate-600 italic mt-2">
          Click "Scan $SENT" — runs all 8 risk signals live against our own token.
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-2">
          <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" />
          Querying RugCheck · Helius · Birdeye · Bags…
        </div>
      )}

      {ran && score !== null && !loading && (
        <div className="mt-3 flex items-center gap-4 animate-fade-in">
          <div className="relative w-16 h-16 shrink-0">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3" />
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor"
                className={tierColor}
                strokeWidth="3"
                strokeDasharray={`${score} ${100 - score}`}
                strokeLinecap="round" />
            </svg>
            <span className={`absolute inset-0 flex items-center justify-center text-sm font-bold ${tierColor}`}>{score}</span>
          </div>
          <div>
            <span className={`text-xs font-bold px-2 py-1 rounded-md border uppercase tracking-wide ${tierColor} ${tierBg}`}>{tier}</span>
            <p className="text-[11px] text-slate-500 mt-1.5">$SENT · Sentinel's own token</p>
            <p className="text-[10px] text-slate-600 mt-0.5">scored by the same engine protecting every Bags token</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Hero search bar (instant risk score on landing) ─────────────────

function HeroSearch({ onScanToken }: { onScanToken: (mint: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (!SOLANA_MINT_RE.test(trimmed)) {
      setError('Paste a valid Solana mint address');
      return;
    }
    setError(null);
    onScanToken(trimmed);
  };

  return (
    <div className="max-w-xl mx-auto w-full">
      <div className="flex items-center gap-2 rounded-2xl border border-cyan-500/20 bg-slate-900/80 px-5 py-3.5 shadow-[0_0_40px_rgba(6,182,212,0.12)] backdrop-blur-md focus-within:border-cyan-500/40 focus-within:shadow-[0_0_60px_rgba(6,182,212,0.20)] transition-all">
        <span className="text-cyan-400 text-sm font-mono shrink-0 select-none">sentinel.scan</span>
        <span className="text-slate-600 text-sm shrink-0">›</span>
        <input
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="paste token address..."
          className="flex-1 bg-transparent outline-none text-white text-sm placeholder:text-slate-600"
        />
        <button
          onClick={submit}
          className="shrink-0 text-sm px-4 py-1.5 rounded-lg bg-cyan-500 text-slate-950 font-semibold hover:bg-cyan-400 transition-all shadow-md shadow-cyan-500/25 hover:shadow-cyan-500/35 active:scale-95"
        >
          analyze
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400 mt-2 text-left px-1">{error}</p>}
      <p className="text-[11px] text-slate-600 mt-2 text-left px-1">
        or try{' '}
        <button
          onClick={() => onScanToken(SENT_MINT)}
          className="text-cyan-500/70 hover:text-cyan-400 font-medium transition-colors"
        >
          $SENT
        </button>{' '}
        — our own token, launched on Bags.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────

export function LandingPage({ onLaunch, onScanToken }: { onLaunch: () => void; onScanToken: (mint: string) => void }) {
  const stats = useLiveStats();
  const [tgUsername, setTgUsername] = useState('');
  const [creatorWallet, setCreatorWallet] = useState('');
  const [resolvedChatId, setResolvedChatId] = useState<string | null>(null);
  const [subStatus, setSubStatus] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subInfo, setSubInfo] = useState<{ subscribed: boolean; wallet?: string | null } | null>(null);
  const [botInfo, setBotInfo] = useState<{ username: string; deepLink: string } | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);

  useEffect(() => {
    fetchTelegramBotInfo().then(setBotInfo).catch(() => {});
    fetchAlertSubscriberCount().then(setSubscriberCount).catch(() => {});
  }, []);

  const handleTelegramSubscribe = async () => {
    setSubBusy(true);
    setSubStatus(null);
    try {
      const username = tgUsername.trim();
      // Username is optional; if omitted, we auto-detect the most recent private chat update.
      const chatId = await resolveTelegramChatId(username || undefined);
      setResolvedChatId(chatId);
      const msg = await subscribeAlerts({ chatId, wallet: creatorWallet.trim() || undefined });
      setSubStatus(msg);
      const info = await fetchSubscription(chatId);
      setSubInfo({ subscribed: info.subscribed, wallet: info.wallet ?? null });
    } catch (e) {
      setSubStatus(e instanceof Error ? e.message : 'Subscribe failed');
    } finally {
      setSubBusy(false);
    }
  };

  const handleTelegramUnsubscribe = async () => {
    setSubBusy(true);
    setSubStatus(null);
    try {
      const chatId = resolvedChatId;
      if (!chatId) throw new Error('Resolve chatId first (subscribe once)');
      await unsubscribeAlerts(chatId);
      setSubStatus('Unsubscribed.');
      const info = await fetchSubscription(chatId);
      setSubInfo({ subscribed: info.subscribed, wallet: info.wallet ?? null });
    } catch (e) {
      setSubStatus(e instanceof Error ? e.message : 'Unsubscribe failed');
    } finally {
      setSubBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-3 flex items-center justify-between border-b border-white/5 backdrop-blur-xl bg-slate-950/70 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <SentinelLogo size={28} />
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold tracking-tight">Sentinel</span>
            <span className="text-[10px] text-cyan-400 font-medium tracking-wider hidden sm:inline">AI Risk Engine</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/loquit-doru/sentinel"
            target="_blank"
            rel="noopener"
            className="text-xs text-slate-500 hover:text-cyan-400 transition-colors hidden sm:inline"
          >
            GitHub ↗
          </a>
          <a
            href="https://bags.fm"
            target="_blank"
            rel="noopener"
            className="text-xs text-slate-500 hover:text-cyan-400 transition-colors hidden sm:inline"
          >
            bags.fm ↗
          </a>
          <button
            onClick={onLaunch}
            className="bg-gradient-to-r from-violet-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg shadow-cyan-500/20 transition-all"
          >
            Launch App
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-20 sm:py-32 text-center relative overflow-hidden">
        {/* Radial gradient layers */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(6,182,212,0.10),transparent_50%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(168,85,247,0.06),transparent_40%)] pointer-events-none" />
        {/* Dramatic glow orbs */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-cyan-500/5 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-1/4 right-1/4 w-[350px] h-[350px] bg-indigo-500/5 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute bottom-1/4 left-1/4 w-[280px] h-[280px] bg-cyan-400/4 rounded-full blur-[90px] pointer-events-none" />

        <div className="relative z-10 max-w-2xl mx-auto space-y-8 animate-fade-in">
          <div className="inline-flex items-center gap-2 bg-slate-900/80 backdrop-blur-sm border border-slate-700/60 rounded-full px-4 py-1.5 text-xs text-slate-400 shadow-sm">
            <span className="w-1.5 h-1.5 bg-sentinel-safe rounded-full animate-pulse" />
            Built on Bags · Track: AI Agents · v0.14.0
          </div>

          <h1 className="text-6xl sm:text-7xl font-bold tracking-tight leading-[1.02]">
            <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-400 bg-clip-text text-transparent">
              Catch rugs
            </span>
            <br />
            <span className="text-white">before price moves.</span>
          </h1>

          <p className="text-base sm:text-lg text-slate-400 max-w-md mx-auto leading-relaxed">
            Autonomous risk monitoring for Bags token launches. Alerts before the collapse — not after.
          </p>

          <HeroSearch onScanToken={onScanToken} />

          <p className="text-xs text-slate-600">
            live: <span className="text-slate-500">$BAG caught pre-rug 32m early</span> · <span className="text-slate-500">agent scans every 15 min</span>
          </p>
        </div>
      </section>

      {/* Live stats */}
      <section className="border-y border-slate-800/60 bg-slate-950/50 py-10 px-6">
        <div className="max-w-3xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 text-center">
            {stats.loading ? (
              <div className="h-8 w-16 mx-auto rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="text-2xl font-bold text-white tabular-nums">{stats.tokensTracked}</div>
            )}
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">Tokens Tracked</div>
          </div>
          {/* ONE glowing metric — the heartbeat */}
          <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4 text-center shadow-[0_0_24px_rgba(6,182,212,0.10)]">
            {stats.loading ? (
              <div className="h-8 w-16 mx-auto rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="text-2xl font-bold text-cyan-400 tabular-nums drop-shadow-[0_0_12px_rgba(6,182,212,0.5)]">{stats.riskScans.toLocaleString()}</div>
            )}
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">Risk Scans</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 text-center">
            {stats.loading ? (
              <div className="h-8 w-16 mx-auto rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="text-2xl font-bold text-white tabular-nums">{stats.totalApiCalls.toLocaleString()}</div>
            )}
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">API Calls</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 text-center">
            <div className="text-2xl font-bold text-white">&lt;1s</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">Edge Response</div>
          </div>
        </div>
      </section>

      {/* 2 superpowers — Live interactive (Bags-native only) */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800 to-transparent" />
      <section className="px-6 py-16 sm:py-20 bg-slate-950/20">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Two things no other Bags tool does</h2>
            <p className="text-slate-400 mt-3 text-sm">
              One runs on-demand. One runs <span className="text-cyan-400">24/7 without human input</span>.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <LiveRiskCard mint={SENT_MINT} />

            <div className="bg-gradient-to-br from-slate-900/80 to-slate-900/40 rounded-xl p-5 border border-slate-800/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xl">📡</span>
                  <h3 className="text-white font-semibold text-sm tracking-tight">Autonomous broadcast agent</h3>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed mt-2">
                  Every 15 minutes, a cron agent scans 100 Bags tokens.
                  When a score collapses, it <span className="text-white">automatically posts to Telegram</span> — no human trigger, no dashboard to check.
                  Subscribe once, get warned before price reacts. Creators can filter alerts by their wallet to avoid noise.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[10px] text-emerald-400 font-medium">Live: @SentinelRiskAlerts on Telegram</span>
                  {typeof subscriberCount === 'number' && (
                    <span className="text-[10px] text-slate-600">· {subscriberCount} subs</span>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-slate-800/60 bg-slate-950/30 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] text-slate-500">
                      DM the bot once (send <span className="font-mono text-slate-300">/start</span>), then connect here:
                    </div>
                    {botInfo && (
                      <a
                        href={botInfo.deepLink}
                        target="_blank"
                        rel="noopener"
                        className="text-[10px] px-2 py-1 rounded-md border border-slate-800/70 text-slate-400 hover:text-cyan-300 hover:border-cyan-500/30 transition-all whitespace-nowrap"
                      >
                        Open bot DM @{botInfo.username} →
                      </a>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      value={tgUsername}
                      onChange={(e) => setTgUsername(e.target.value)}
                      placeholder="@yourname (optional)"
                      className="w-full px-3 py-2 text-xs rounded-lg bg-black/30 border border-slate-800/70 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                    />
                    <input
                      value={creatorWallet}
                      onChange={(e) => setCreatorWallet(e.target.value)}
                      placeholder="Creator wallet (optional)"
                      className="w-full px-3 py-2 text-xs rounded-lg bg-black/30 border border-slate-800/70 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleTelegramSubscribe}
                      disabled={subBusy}
                      className={`text-[11px] font-medium px-3 py-1.5 rounded-lg border whitespace-nowrap transition-all ${
                        subBusy
                          ? 'bg-cyan-500/10 text-cyan-300/60 border-cyan-500/10 cursor-wait'
                          : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30'
                      }`}
                    >
                      {subBusy ? 'Working…' : 'Connect Telegram'}
                    </button>
                    <button
                      onClick={handleTelegramUnsubscribe}
                      disabled={subBusy || !resolvedChatId}
                      className="text-[11px] font-medium px-3 py-1.5 rounded-lg border border-slate-800/70 text-slate-400 hover:text-slate-200 hover:border-slate-700/70 transition-all disabled:opacity-40"
                    >
                      Disconnect
                    </button>
                    {resolvedChatId && (
                      <span className="text-[10px] text-slate-600 font-mono ml-auto">
                        chatId: {resolvedChatId}
                      </span>
                    )}
                  </div>
                  {(subStatus || subInfo) && (
                    <div className="text-[11px] text-slate-500">
                      {subStatus && <div>{subStatus}</div>}
                      {subInfo && (
                        <div className="mt-1 text-[10px] text-slate-600">
                          Status: <span className="text-slate-400">{subInfo.subscribed ? 'connected' : 'not connected'}</span>
                          {subInfo.wallet ? <> · wallet filter: <span className="font-mono">{subInfo.wallet.slice(0, 6)}…{subInfo.wallet.slice(-4)}</span></> : null}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="pt-2 border-t border-slate-800/60">
                    <div className="text-[10px] text-slate-600 font-semibold uppercase tracking-widest">Bot commands</div>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-slate-500">
                      <div><span className="font-mono text-slate-300">/status &lt;mint&gt;</span> — score + tier</div>
                      <div><span className="font-mono text-slate-300">/why &lt;mint&gt;</span> — explanation</div>
                      <div><span className="font-mono text-slate-300">/watch &lt;mint&gt;</span> — watchlist</div>
                      <div><span className="font-mono text-slate-300">/report</span> — quick summary</div>
                    </div>
                    <a
                      href="https://github.com/loquit-doru/sentinel/blob/master/docs/telegram.md"
                      target="_blank"
                      rel="noopener"
                      className="inline-flex mt-2 text-[10px] text-cyan-400 hover:underline"
                    >
                      Setup + troubleshooting docs ↗
                    </a>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <a
                  href="https://t.me/SentinelRiskAlerts"
                  target="_blank"
                  rel="noopener"
                  className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 whitespace-nowrap transition-all self-start"
                >
                  Join channel →
                </a>
              </div>
            </div>
          </div>

          <p className="text-center text-[11px] text-slate-600 mt-6">
            +3 more tools: Risk Badge · Wallet X-Ray · Launch Guard
          </p>
        </div>
      </section>

      {/* Why Sentinel */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800 to-transparent" />
      <section className="px-6 py-20 bg-slate-950/40">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">What Sentinel detects that humans don't see</h2>
            <p className="text-slate-500 mt-3 text-sm">Pattern recognition across on-chain behavior, not just static metrics.</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                phase: 'BEHAVIORAL LAYER',
                phaseColor: 'text-yellow-400 border-yellow-500/20 bg-yellow-500/5',
                icon: '📉',
                title: 'Phase detection',
                desc: 'Distribution and collapse phases show up in buy/sell ratios and liquidity stress before price reacts. Sentinel classifies each token: Accumulation, Distribution, Manipulation, Collapse.',
                signal: 'distribution phase detected — smart money exiting',
              },
              {
                phase: 'DECISION LAYER',
                phaseColor: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
                icon: '🤖',
                title: 'LLM policy engine',
                desc: 'The agent doesn\'t just score — it decides what to do. Watch, rescan in 2 min, log quietly, broadcast to Telegram, or escalate. A calibrated heuristic fallback runs when the LLM is unavailable.',
                signal: 'action: telegram_alert — confidence 84%',
              },
              {
                phase: 'AUTONOMOUS LAYER',
                phaseColor: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
                icon: '📡',
                title: 'Agent that acts',
                desc: 'Sentinel doesn\'t wait for you to open a dashboard. Score collapse → Telegram broadcast. Automatic.',
                signal: 'alert dispatched 32m before price collapsed',
              },
            ].map((f) => (
              <div key={f.title} className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:bg-slate-900/60 hover:border-slate-700/60 hover:-translate-y-0.5 transition-all duration-300">
                <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-semibold tracking-widest uppercase mb-3 ${f.phaseColor}`}>
                  {f.phase}
                </div>
                <div className="text-xl mb-2">{f.icon}</div>
                <h3 className="text-white font-semibold text-sm mb-1.5">{f.title}</h3>
                <p className="text-slate-400 text-xs leading-relaxed mb-3">{f.desc}</p>
                <div className="text-[10px] text-slate-600 font-mono border-t border-slate-800/60 pt-2 mt-auto">
                  › {f.signal}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* $SENT Fee Stats */}
      <SentFeeStatsWidget />

      {/* Pre-Rug Catches — live evidence chain */}
      <PreRugCatchesBanner />

      {/* Proof & Audit — “don't trust, verify” */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800 to-transparent" />
      <section className="px-6 py-20 bg-slate-950/40">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Don't trust — verify.</h2>
            <p className="text-slate-400 mt-3 text-sm">
              Every score is reproducible from public data.
              Every claim on this page is backed by code you can read, run, and audit.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <a
              href="https://github.com/loquit-doru/sentinel/blob/master/EVIDENCE.md"
              target="_blank"
              rel="noopener"
              className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:border-cyan-500/30 hover:bg-slate-900/60 hover:-translate-y-0.5 transition-all duration-300 group"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">📜</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-cyan-400 transition-colors">EVIDENCE.md</h3>
                <span className="text-[10px] text-slate-600 group-hover:text-cyan-500 ml-auto transition-colors">↗</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">Full methodology + weights + current Bags leaderboard scan + ground-truth alignment protocol.</p>
            </a>
            <a
              href="https://sentinel-api.apiworkersdev.workers.dev/stats"
              target="_blank"
              rel="noopener"
              className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:border-cyan-500/30 hover:bg-slate-900/60 hover:-translate-y-0.5 transition-all duration-300 group"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">📊</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-cyan-400 transition-colors">GET /stats</h3>
                <span className="text-[10px] text-slate-600 group-hover:text-cyan-500 ml-auto transition-colors">↗</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">Public endpoint. Raw JSON: total requests, per-endpoint breakdown, today vs yesterday. No auth.</p>
            </a>
            <a
              href="https://github.com/loquit-doru/sentinel/blob/master/worker/src/risk/engine.ts"
              target="_blank"
              rel="noopener"
              className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:border-cyan-500/30 hover:bg-slate-900/60 hover:-translate-y-0.5 transition-all duration-300 group"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">⚙️</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-cyan-400 transition-colors">engine.ts</h3>
                <span className="text-[10px] text-slate-600 group-hover:text-cyan-500 ml-auto transition-colors">↗</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">8-signal weighted scoring + instant rug override. 102 unit tests. Pure TypeScript, no magic.</p>
            </a>
            <a
              href="https://github.com/loquit-doru/sentinel/blob/master/docs/telegram.md"
              target="_blank"
              rel="noopener"
              className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:border-cyan-500/30 hover:bg-slate-900/60 hover:-translate-y-0.5 transition-all duration-300 group"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">📩</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-cyan-400 transition-colors">Telegram bot docs</h3>
                <span className="text-[10px] text-slate-600 group-hover:text-cyan-500 ml-auto transition-colors">↗</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">Self-serve commands, creator alerts, webhook setup, and troubleshooting.</p>
            </a>
            <a
              href="https://github.com/loquit-doru/sentinel/blob/master/worker/src/partner/bags-partner.ts"
              target="_blank"
              rel="noopener"
              className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 hover:border-cyan-500/30 hover:bg-slate-900/60 hover:-translate-y-0.5 transition-all duration-300 group"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🤝</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-cyan-400 transition-colors">Bags Partner API</h3>
                <span className="text-[10px] text-slate-600 group-hover:text-cyan-500 ml-auto transition-colors">↗</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">4 Bags partner endpoints consumed: config, create, claim-stats, claim-txs. Plus leaderboard, fee-share, trade quotes.</p>
            </a>
          </div>
          <p className="text-center text-[11px] text-slate-700 mt-6 font-mono">
            Reproduce scan: <span className="text-slate-500">npx tsx scripts/scan-top-tokens.ts</span> · Audit token: <span className="text-slate-500">curl /v1/risk/&lt;mint&gt;</span>
          </p>
        </div>
      </section>

      {/* CTA bottom */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800 to-transparent" />
      <section className="px-6 py-20 text-center bg-slate-950/20">
        <div className="max-w-lg mx-auto space-y-6">
          <h2 className="text-3xl font-bold text-white">The agent has been running since April.</h2>
          <p className="text-slate-400 text-sm">
            Free to use. No sign-up. Connect your wallet only when you want to claim fees.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onLaunch}
              className="bg-gradient-to-r from-cyan-500 to-cyan-400 hover:from-cyan-400 hover:to-cyan-300 text-black font-semibold px-8 py-3 rounded-xl text-base transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30 hover:scale-105"
            >
              Launch App →
            </button>
            <a
              href={`https://bags.fm/token/${SENT_MINT}`}
              target="_blank"
              rel="noopener"
              className="text-slate-400 hover:text-white text-sm font-medium px-6 py-3 rounded-xl border border-slate-700/60 hover:border-slate-600 hover:bg-slate-900/40 transition-all"
            >
              View $SENT on Bags ↗
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800/50 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-[11px] text-gray-600">
          <div className="flex items-center gap-2">
            <SentinelLogo size={14} />
            <span>Sentinel v0.14.0 — Autonomous risk monitoring for Bags</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://github.com/loquit-doru/sentinel" target="_blank" rel="noopener" className="text-cyan-500/50 hover:text-cyan-400 transition-colors">GitHub ↗</a>
            <a href="https://bags.fm" target="_blank" rel="noopener" className="text-cyan-500/50 hover:text-cyan-400 transition-colors">bags.fm ↗</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
