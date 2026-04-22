import { useEffect, useState } from 'react';
import {
  fetchTokenFeed,
  fetchApiStats,
  fetchSentFeeStats,
  runTokenSwarmCycle,
  fetchPreRugCatches,
  type SentFeeStats,
  type SwarmCycleData,
  type PreRugCatch,
} from '../api';

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

function PreRugCatchesBanner() {
  const [data, setData] = useState<{ catches: PreRugCatch[]; stats: { tokensWatched: number; catches: number; lastRunAt: number; lastCatchAt: number | null; avgLeadTimeMs: number } } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPreRugCatches(5).then((d) => {
      setData(d);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Hide entirely while loading first response; if endpoint fails or returns null, render nothing.
  if (loading) return null;
  if (!data) return null;

  const hasCatches = data.catches.length > 0;

  return (
    <section className="px-6 py-14 border-t border-slate-800/50 bg-gradient-to-b from-red-950/10 via-transparent to-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-red-500/20 bg-red-500/5 text-[10px] font-semibold text-red-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            Evidence chain
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">Pre-rug catches · live</h2>
          <p className="text-slate-400 mt-3 text-sm">
            Every 15 minutes, our cron scans the top 100 Bags tokens and records the first moment a score
            collapses ≥40 points or crashes into danger/rug tier. This is not a claim — it's a log.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6 text-center">
          <div className="p-3 rounded-lg border border-slate-800/60 bg-slate-900/40">
            <div className="text-xl font-bold text-white">{data.stats.tokensWatched || 50}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Tokens watched</div>
          </div>
          <div className="p-3 rounded-lg border border-slate-800/60 bg-slate-900/40">
            <div className="text-xl font-bold text-white">{data.stats.catches}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Catches to date</div>
          </div>
          <div className="p-3 rounded-lg border border-slate-800/60 bg-slate-900/40">
            <div className="text-xl font-bold text-white">{formatLeadTime(data.stats.avgLeadTimeMs)}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Avg lead time</div>
          </div>
        </div>

        {!hasCatches ? (
          <div className="p-5 rounded-xl border border-slate-800/60 bg-slate-900/40 text-center">
            <p className="text-sm text-slate-400">
              <span className="text-green-400 font-medium">No catches yet.</span> The watcher is running —
              catches will appear here when a tracked token's score collapses.
            </p>
            <p className="text-[11px] text-slate-600 mt-2">
              Raw feed: <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">GET /v1/watch/catches</a>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {data.catches.map((c) => (
              <div key={c.mint + c.caughtAt} className="p-3.5 rounded-lg border border-slate-800/60 bg-slate-900/40 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white truncate">{c.symbol || c.mint.slice(0, 6)}</span>
                    <span className="text-[10px] font-mono text-slate-600 truncate">{c.mint.slice(0, 4)}…{c.mint.slice(-4)}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Flagged {formatLeadTime(Date.now() - c.caughtAt)} ago · first seen {formatLeadTime(Date.now() - c.initialAt)} ago
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-500 line-through">{c.initialScore}</span>
                    <span className="text-[11px] text-slate-600">→</span>
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${tierBadgeClass(c.caughtTier)}`}>{c.caughtScore}</span>
                  </div>
                  <div className="text-[10px] text-red-400 mt-0.5">−{c.scoreDrop} pts</div>
                </div>
              </div>
            ))}
            <p className="text-center text-[11px] text-slate-600 mt-3">
              Full list: <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=100" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">GET /v1/watch/catches?limit=100</a>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Live Demo: BagsSwarm (5-agent AI consensus) ─────────────────────

function SwarmDemoCard({ mint }: { mint: string }) {
  const [data, setData] = useState<SwarmCycleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await runTokenSwarmCycle(mint);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-slate-900/80 to-slate-900/40 rounded-xl p-5 border border-slate-800/50">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🤖</span>
            <h3 className="text-white font-semibold text-sm tracking-tight">BagsSwarm AI Consensus</h3>
          </div>
          <p className="text-[11px] text-slate-500">5 agents · majority voting · DexScreener-enriched</p>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap"
        >
          {loading ? 'Voting…' : data ? 'Re-run' : 'Run live'}
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}

      {!data && !loading && !error && (
        <div className="text-[11px] text-slate-600 italic mt-2">
          Click "Run live" — 5 specialized agents analyze the token and vote on a verdict.
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-2">
          <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" />
          Risk · Volume · Sentiment · Whale · Creator agents voting…
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-3 animate-fade-in">
          <p className="text-[12px] text-slate-300 leading-relaxed line-clamp-4">{data.summary}</p>

          <div className="flex flex-wrap gap-1.5">
            {data.agentStatuses.slice(0, 5).map((a) => (
              <div key={a.agentId} className="bg-black/30 rounded-md px-2 py-1 border border-slate-800/50 min-w-[90px]">
                <p className="text-[10px] text-gray-400 truncate">{a.name}</p>
                <p className="text-[10px] text-gray-600 truncate">
                  {a.status} · {a.voteCount} vote{a.voteCount === 1 ? '' : 's'}
                </p>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-gray-500">
            {data.decisions.length} decision{data.decisions.length === 1 ? '' : 's'} reached consensus
          </p>
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
      <div className="flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/70 px-4 py-3 shadow-lg shadow-cyan-500/5 backdrop-blur-md focus-within:border-cyan-500/40 focus-within:shadow-cyan-500/10 transition-all">
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
          className="shrink-0 text-sm px-4 py-1.5 rounded-lg bg-cyan-500 text-black font-semibold hover:bg-cyan-400 transition-colors"
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

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-4 flex items-center justify-between border-b border-slate-800/50 backdrop-blur-sm bg-slate-950/90 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <SentinelLogo size={32} />
          <span className="text-lg font-bold tracking-tight">Sentinel</span>
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
            className="bg-cyan-500 hover:bg-cyan-400 text-black text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            Launch App
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-20 sm:py-32 text-center relative overflow-hidden">
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
            Real-time adversarial risk intelligence for Bags token launches.
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
              <div className="text-2xl font-bold text-white">{stats.tokensTracked}</div>
            )}
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">Tokens Tracked</div>
          </div>
          {/* ONE glowing metric — the heartbeat */}
          <div className="rounded-xl border border-cyan-500/20 bg-slate-900/40 p-4 text-center">
            {stats.loading ? (
              <div className="h-8 w-16 mx-auto rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="text-2xl font-bold text-cyan-400 drop-shadow-[0_0_12px_rgba(6,182,212,0.5)]">{stats.riskScans.toLocaleString()}</div>
            )}
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1.5">Risk Scans</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 text-center">
            {stats.loading ? (
              <div className="h-8 w-16 mx-auto rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="text-2xl font-bold text-white">{stats.totalApiCalls.toLocaleString()}</div>
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
            <SwarmDemoCard mint={SENT_MINT} />

            <div className="bg-gradient-to-br from-slate-900/80 to-slate-900/40 rounded-xl p-5 border border-slate-800/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xl">📡</span>
                  <h3 className="text-white font-semibold text-sm tracking-tight">Autonomous broadcast agent</h3>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed mt-2">
                  Every 15 minutes, a cron agent scans 100 Bags tokens.
                  When a score collapses, it <span className="text-white">automatically posts to Telegram</span> — no human trigger, no dashboard to check.
                  Subscribe once, get warned before price reacts.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[10px] text-emerald-400 font-medium">Live: @SentinelRiskAlerts on Telegram</span>
                </div>
              </div>
              <a
                href="https://t.me/SentinelRiskAlerts"
                target="_blank"
                rel="noopener"
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 whitespace-nowrap transition-all self-start mt-4"
              >
                Join channel →
              </a>
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
                phase: 'SIMULATION LAYER',
                phaseColor: 'text-yellow-400 border-yellow-500/20 bg-yellow-500/5',
                icon: '🧪',
                title: 'What-if engine',
                desc: 'Sentinel simulates 6 rug scenarios before they happen. You see the exact loss scenario, not just a score.',
                signal: 'price impact if LP pulled in next 10 min',
              },
              {
                phase: 'CONSENSUS LAYER',
                phaseColor: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
                icon: '🤖',
                title: 'Multi-agent consensus',
                desc: 'Five specialized agents vote independently. Risk, volume, sentiment, whales, creator history. One being wrong doesn\'t break the verdict.',
                signal: 'coordinated wallets + low LP depth detected',
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
              href="https://github.com/loquit-doru/sentinel/blob/main/EVIDENCE.md"
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
              href="https://github.com/loquit-doru/sentinel/blob/main/worker/src/risk/engine.ts"
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
              href="https://github.com/loquit-doru/sentinel/blob/main/worker/src/partner/bags-partner.ts"
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
            Reproduce scan: <span className="text-slate-500">npx tsx scripts/scan-top-tokens.ts</span> · Audit token: <span className="text-slate-500">curl /v1/risk/token/&lt;mint&gt;</span>
          </p>
        </div>
      </section>

      {/* CTA bottom */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800 to-transparent" />
      <section className="px-6 py-20 text-center bg-slate-950/20">
        <div className="max-w-lg mx-auto space-y-6">
          <h2 className="text-3xl font-bold text-white">Ready to trade smarter?</h2>
          <p className="text-slate-400 text-sm">
            Free to use. No sign-up. Connect your wallet only when you want to claim or stake.
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
            <span>Sentinel v0.14.0 — AI Risk Intelligence for Bags</span>
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
