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
        <div className="h-9 sm:h-10 w-20 mx-auto rounded-md bg-gradient-to-r from-sentinel-border/30 via-sentinel-border/60 to-sentinel-border/30 bg-[length:200%_100%] animate-shimmer" />
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
    <section className="px-6 py-14 border-t border-sentinel-border/30 bg-gradient-to-b from-cyan-950/10 via-transparent to-transparent">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/5 text-[10px] font-semibold text-cyan-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Live · updated every 5 min
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold">$SENT earns you fees</h2>
          <p className="text-gray-400 mt-3 text-sm max-w-md mx-auto">
            Every trade on $SENT generates a 1% Bags fee. 30% of that goes directly to $SENT holders.
            Hold any amount to start earning.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl border border-sentinel-border/30 bg-sentinel-surface/30 animate-pulse" />
            ))}
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="p-4 rounded-xl border border-sentinel-border/40 bg-sentinel-surface/30 text-center">
                <div className="text-xl font-bold text-white">{fmt(data.volume24hUsd, 0)}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">24h Volume</div>
              </div>
              <div className="p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 text-center">
                <div className="text-xl font-bold text-cyan-400">{fmt(data.holdersShareDaily)}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Holders share / day</div>
              </div>
              <div className="p-4 rounded-xl border border-sentinel-border/40 bg-sentinel-surface/30 text-center">
                <div className="text-xl font-bold text-white">{data.holderCount.toLocaleString()}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">$SENT holders</div>
              </div>
              <div className="p-4 rounded-xl border border-green-500/20 bg-green-500/5 text-center">
                <div className="text-xl font-bold text-green-400">{fmt(data.estimatedDailyPerHolder, 4)}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Est. daily / holder</div>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-sentinel-border/40 bg-sentinel-surface/20 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-sm text-gray-400 text-center sm:text-left">
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
                className="text-xs font-semibold px-4 py-2 rounded-lg bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 transition-all whitespace-nowrap"
              >
                Buy $SENT on Bags ↗
              </a>
            </div>
          </>
        ) : (
          <div className="text-center text-sm text-gray-600 py-6">
            Stats temporarily unavailable —{' '}
            <a
              href={`https://bags.fm/token/${SENT_MINT}`}
              target="_blank"
              rel="noopener"
              className="text-sentinel-accent hover:underline"
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
    <section className="px-6 py-14 border-t border-sentinel-border/30 bg-gradient-to-b from-red-950/10 via-transparent to-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-red-500/20 bg-red-500/5 text-[10px] font-semibold text-red-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            Evidence chain
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold">Pre-rug catches · live</h2>
          <p className="text-gray-400 mt-3 text-sm">
            Every 15 minutes, our cron scans the top 50 Bags tokens and records the first moment a score
            collapses ≥40 points or crashes into danger/rug tier. This is not a claim — it's a log.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6 text-center">
          <div className="p-3 rounded-lg border border-sentinel-border/40 bg-sentinel-surface/30">
            <div className="text-xl font-bold text-white">{data.stats.tokensWatched || 50}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Tokens watched</div>
          </div>
          <div className="p-3 rounded-lg border border-sentinel-border/40 bg-sentinel-surface/30">
            <div className="text-xl font-bold text-white">{data.stats.catches}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Catches to date</div>
          </div>
          <div className="p-3 rounded-lg border border-sentinel-border/40 bg-sentinel-surface/30">
            <div className="text-xl font-bold text-white">{formatLeadTime(data.stats.avgLeadTimeMs)}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Avg lead time</div>
          </div>
        </div>

        {!hasCatches ? (
          <div className="p-5 rounded-xl border border-sentinel-border/40 bg-sentinel-surface/30 text-center">
            <p className="text-sm text-gray-400">
              <span className="text-green-400 font-medium">No catches yet.</span> The watcher is running —
              catches will appear here when a tracked token's score collapses.
            </p>
            <p className="text-[11px] text-gray-600 mt-2">
              Raw feed: <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches" target="_blank" rel="noopener" className="text-sentinel-accent hover:underline">GET /v1/watch/catches</a>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {data.catches.map((c) => (
              <div key={c.mint + c.caughtAt} className="p-3.5 rounded-lg border border-sentinel-border/40 bg-sentinel-surface/30 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white truncate">{c.symbol || c.mint.slice(0, 6)}</span>
                    <span className="text-[10px] font-mono text-gray-600 truncate">{c.mint.slice(0, 4)}…{c.mint.slice(-4)}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    Flagged {formatLeadTime(Date.now() - c.caughtAt)} ago · first seen {formatLeadTime(Date.now() - c.initialAt)} ago
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-gray-500 line-through">{c.initialScore}</span>
                    <span className="text-[11px] text-gray-600">→</span>
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${tierBadgeClass(c.caughtTier)}`}>{c.caughtScore}</span>
                  </div>
                  <div className="text-[10px] text-red-400 mt-0.5">−{c.scoreDrop} pts</div>
                </div>
              </div>
            ))}
            <p className="text-center text-[11px] text-gray-600 mt-3">
              Full list: <a href="https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=100" target="_blank" rel="noopener" className="text-sentinel-accent hover:underline">GET /v1/watch/catches?limit=100</a>
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
    <div className="bg-gradient-to-br from-sentinel-surface/80 to-sentinel-surface/40 rounded-xl p-5 border border-sentinel-border/50">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🤖</span>
            <h3 className="text-white font-semibold text-sm tracking-tight">BagsSwarm AI Consensus</h3>
          </div>
          <p className="text-[11px] text-gray-500">5 agents · BFT voting · DexScreener-enriched</p>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-sentinel-accent/15 text-sentinel-accent border border-sentinel-accent/30 hover:bg-sentinel-accent/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap"
        >
          {loading ? 'Voting…' : data ? 'Re-run' : 'Run live'}
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}

      {!data && !loading && !error && (
        <div className="text-[11px] text-gray-600 italic mt-2">
          Click "Run live" — 5 specialized agents analyze the token and vote on a verdict.
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-2">
          <span className="w-1.5 h-1.5 bg-sentinel-accent rounded-full animate-pulse" />
          Risk · Volume · Sentiment · Whale · Creator agents voting…
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-3 animate-fade-in">
          <p className="text-[12px] text-gray-300 leading-relaxed line-clamp-4">{data.summary}</p>

          <div className="flex flex-wrap gap-1.5">
            {data.agentStatuses.slice(0, 5).map((a) => (
              <div key={a.agentId} className="bg-black/30 rounded-md px-2 py-1 border border-sentinel-border/30 min-w-[90px]">
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
    <div className="max-w-md mx-auto w-full">
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Paste any Solana mint…"
          className="flex-1 bg-sentinel-surface/80 border border-sentinel-border/60 rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-sentinel-accent/50 transition-colors"
        />
        <button
          onClick={submit}
          className="bg-sentinel-accent hover:bg-sentinel-accent-dim text-white font-semibold px-5 py-3 rounded-xl text-sm transition-all hover:shadow-lg hover:shadow-sentinel-accent/25"
        >
          Score →
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400 mt-2 text-left">{error}</p>}
      <p className="text-[11px] text-gray-600 mt-2 text-left">
        Or try{' '}
        <button
          onClick={() => onScanToken(SENT_MINT)}
          className="text-sentinel-accent hover:underline font-medium"
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
      <nav className="px-6 py-4 flex items-center justify-between border-b border-sentinel-border/30 backdrop-blur-sm bg-sentinel-bg/90 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <SentinelLogo size={32} />
          <span className="text-lg font-bold tracking-tight">Sentinel</span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/loquit-doru/sentinel"
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-sentinel-accent transition-colors hidden sm:inline"
          >
            GitHub ↗
          </a>
          <a
            href="https://bags.fm"
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-sentinel-accent transition-colors hidden sm:inline"
          >
            bags.fm ↗
          </a>
          <button
            onClick={onLaunch}
            className="bg-sentinel-accent hover:bg-sentinel-accent-dim text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Launch App
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-16 sm:py-24 text-center relative overflow-hidden">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] h-[320px] bg-cyan-500/8 rounded-full blur-[80px] pointer-events-none" />
        <div className="absolute top-2/3 left-1/3 w-[200px] h-[200px] bg-indigo-500/6 rounded-full blur-[60px] pointer-events-none" />

        <div className="relative z-10 max-w-2xl mx-auto space-y-6 animate-fade-in">
          <div className="inline-flex items-center gap-2 bg-sentinel-surface/80 backdrop-blur-sm border border-sentinel-border/60 rounded-full px-4 py-1.5 text-xs text-gray-400 shadow-sm">
            <span className="w-1.5 h-1.5 bg-sentinel-safe rounded-full animate-pulse" />
            Built on Bags · Track: AI Agents · v0.13.0
          </div>

          <h1 className="text-5xl sm:text-7xl font-black tracking-tight leading-[1.05]">
            Read the{' '}
            <span className="bg-gradient-to-r from-cyan-400 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
              market.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-gray-400 max-w-md mx-auto leading-relaxed">
            Sentinel tracks the behavior of money itself — detecting coordinated manipulation before it becomes
            visible on price charts. AI risk scoring + pump phase intelligence for Bags tokens.
          </p>

          <div className="flex items-center justify-center gap-2 text-xs text-emerald-400/80">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
            Live catch: <span className="font-semibold text-emerald-400">$BAG flagged 32 min before collapse</span>
          </div>

          <div className="pt-2">
            <HeroSearch onScanToken={onScanToken} />
          </div>
        </div>
      </section>

      {/* Live stats */}
      <section className="border-y border-sentinel-border/30 bg-sentinel-surface/20 py-10 px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-center divide-x divide-sentinel-border/40">
          <StatBox
            loading={stats.loading}
            value={stats.tokensTracked.toString()}
            label="Tokens Tracked"
          />
          <StatBox
            loading={stats.loading}
            value={stats.riskScans.toLocaleString()}
            label="Risk Scans"
          />
          <StatBox
            loading={stats.loading}
            value={stats.totalApiCalls.toLocaleString()}
            label="API Calls"
          />
          <StatBox value="<1s" label="Edge Response" />
        </div>
      </section>

      {/* 2 superpowers — Live interactive (Bags-native only) */}
      <section className="px-6 py-16 sm:py-20">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold">Two superpowers no other Bags tool has</h2>
            <p className="text-gray-400 mt-3 text-sm">
              Run them <span className="text-sentinel-accent">live, right here</span>, on $SENT.
              No wallet, no sign-up, no install.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SwarmDemoCard mint={SENT_MINT} />

            <div className="bg-gradient-to-br from-sentinel-surface/80 to-sentinel-surface/40 rounded-xl p-5 border border-sentinel-border/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xl">🏦</span>
                  <h3 className="text-white font-semibold text-sm tracking-tight">Community Insurance Pool</h3>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed mt-2">
                  Stake $SENT in 3 tiers. Get auto-paid when a token you held drops 40+ points or hits rug-tier.
                  No claims department, no human review.
                </p>
              </div>
              <button
                onClick={onLaunch}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-sentinel-accent/15 text-sentinel-accent border border-sentinel-accent/30 hover:bg-sentinel-accent/25 whitespace-nowrap transition-all self-start mt-4"
              >
                Open pool →
              </button>
            </div>
          </div>

          <p className="text-center text-[11px] text-gray-600 mt-6">
            +3 complementary tools: Bags Token Monitor · Launch Guard · Wallet X-Ray
          </p>
        </div>
      </section>

      {/* Why Sentinel */}
      <section className="px-6 py-16 border-t border-sentinel-border/30 bg-sentinel-surface/20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold mb-8 text-center">Why Sentinel beats RugCheck + DexScreener combined</h2>
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              {
                icon: '🧪',
                title: 'What-if engine',
                desc: 'Other tools tell you the score. Sentinel simulates 6 rug scenarios so you know what could go wrong, when, and how much you\'d lose.',
              },
              {
                icon: '🤖',
                title: 'Multi-agent AI',
                desc: 'Five specialized agents debate independently — risk, volume, sentiment, whales, creator history — then vote. No single LLM blind spot.',
              },
              {
                icon: '🏦',
                title: 'Skin in the game',
                desc: '$SENT holders aren\'t just users — they back the insurance pool that pays out when scores collapse. Aligned incentives, not just analytics.',
              },
            ].map((f) => (
              <div key={f.title} className="space-y-2">
                <div className="text-2xl">{f.icon}</div>
                <h3 className="text-white font-semibold text-sm">{f.title}</h3>
                <p className="text-gray-400 text-xs leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* $SENT Fee Stats */}
      <SentFeeStatsWidget />

      {/* Pre-Rug Catches — live evidence chain */}
      <PreRugCatchesBanner />

      {/* Proof & Audit — "don't trust, verify" */}
      <section className="px-6 py-16 border-t border-sentinel-border/30">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold">Don't trust — verify.</h2>
            <p className="text-gray-400 mt-3 text-sm">
              Every score is reproducible from public data.
              Every claim in this page is backed by code you can read, run, and audit.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <a
              href="https://github.com/loquit-doru/sentinel/blob/main/EVIDENCE.md"
              target="_blank"
              rel="noopener"
              className="p-4 rounded-xl border border-sentinel-border/60 hover:border-sentinel-accent/40 bg-sentinel-surface/40 hover:bg-sentinel-surface/70 transition-all group"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📜</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-sentinel-accent transition-colors">EVIDENCE.md</h3>
                <span className="text-[10px] text-sentinel-accent ml-auto">↗</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Full methodology + weights + current Bags leaderboard scan + ground-truth alignment protocol.
              </p>
            </a>
            <a
              href="https://sentinel-api.apiworkersdev.workers.dev/stats"
              target="_blank"
              rel="noopener"
              className="p-4 rounded-xl border border-sentinel-border/60 hover:border-sentinel-accent/40 bg-sentinel-surface/40 hover:bg-sentinel-surface/70 transition-all group"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📊</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-sentinel-accent transition-colors">GET /stats</h3>
                <span className="text-[10px] text-sentinel-accent ml-auto">↗</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Public endpoint. Raw JSON: total requests, per-endpoint breakdown, today vs yesterday. No auth.
              </p>
            </a>
            <a
              href="https://github.com/loquit-doru/sentinel/blob/main/worker/src/risk/engine.ts"
              target="_blank"
              rel="noopener"
              className="p-4 rounded-xl border border-sentinel-border/60 hover:border-sentinel-accent/40 bg-sentinel-surface/40 hover:bg-sentinel-surface/70 transition-all group"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">⚙️</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-sentinel-accent transition-colors">engine.ts</h3>
                <span className="text-[10px] text-sentinel-accent ml-auto">↗</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                8-signal weighted scoring + instant rug override. 88 unit tests. Pure TypeScript, no magic.
              </p>
            </a>
            <a
              href="https://github.com/loquit-doru/sentinel/blob/main/worker/src/partner/bags-partner.ts"
              target="_blank"
              rel="noopener"
              className="p-4 rounded-xl border border-sentinel-border/60 hover:border-sentinel-accent/40 bg-sentinel-surface/40 hover:bg-sentinel-surface/70 transition-all group"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">🤝</span>
                <h3 className="font-semibold text-sm text-white group-hover:text-sentinel-accent transition-colors">Bags Partner API</h3>
                <span className="text-[10px] text-sentinel-accent ml-auto">↗</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                4 Bags partner endpoints consumed: config, create, claim-stats, claim-txs. Plus leaderboard, fee-share, trade quotes.
              </p>
            </a>
          </div>
          <p className="text-center text-[11px] text-gray-600 mt-6">
            Reproduce our scan: <code className="text-sentinel-accent">npx tsx scripts/scan-top-tokens.ts</code> · Audit any token: <code className="text-sentinel-accent">curl /v1/risk/token/&lt;mint&gt;</code>
          </p>
        </div>
      </section>

      {/* CTA bottom */}
      <section className="px-6 py-16 text-center">
        <div className="max-w-lg mx-auto space-y-4">
          <h2 className="text-2xl font-bold">Ready to trade smarter?</h2>
          <p className="text-gray-400 text-sm">
            Free to use. No sign-up. Connect your wallet only when you want to claim or stake.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onLaunch}
              className="bg-sentinel-accent hover:bg-sentinel-accent-dim text-white font-semibold px-8 py-3 rounded-xl text-base transition-all hover:shadow-lg hover:shadow-sentinel-accent/20"
            >
              Launch App →
            </button>
            <a
              href={`https://bags.fm/token/${SENT_MINT}`}
              target="_blank"
              rel="noopener"
              className="text-sentinel-accent hover:text-white text-sm font-medium px-6 py-3 rounded-xl border border-sentinel-accent/40 hover:border-sentinel-accent hover:bg-sentinel-accent/10 transition-all"
            >
              View $SENT on Bags ↗
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-sentinel-border/30 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-[11px] text-gray-600">
          <div className="flex items-center gap-2">
            <SentinelLogo size={14} />
            <span>Sentinel v0.13.0 — AI Risk Intelligence for Bags</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://github.com/loquit-doru/sentinel" target="_blank" rel="noopener" className="text-sentinel-accent/60 hover:text-sentinel-accent transition-colors">GitHub ↗</a>
            <a href="https://bags.fm" target="_blank" rel="noopener" className="text-sentinel-accent/60 hover:text-sentinel-accent transition-colors">bags.fm ↗</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
