import { useEffect, useRef, useState } from 'react';
import {
  SENTINEL_API_ORIGIN,
  fetchTokenFeed,
  fetchApiStats,
  fetchSentFeeStats,
  fetchPreRugCatches,
  fetchAlertFeed,
  fetchAccuracyReport,
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
  type AccuracyReport,
  type PredictionOutcomeRecord,
  type RiskExplanation,
} from '../api';
import type { RiskAlert } from '../../../shared/types';

// ─── Constants ─────────────────────────────────────────────────────────

const SENT_MINT = 'Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS';
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const PUBLIC_DEMO_HTML = `${SENTINEL_API_ORIGIN}/v1/demo`;
const PUBLIC_CATCHES_HTML = `${SENTINEL_API_ORIGIN}/v1/watch/catches?limit=100`;
const PUBLIC_ACCURACY_HTML = `${SENTINEL_API_ORIGIN}/v1/watch/accuracy`;

// ─── Count-up hook ─────────────────────────────────────────────────────

function useCountUp(target: number, duration = 1400, enabled = true) {
  const [value, setValue] = useState(0);
  const raf = useRef<number>(0);
  useEffect(() => {
    if (!enabled || target === 0) { setValue(target); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3); // ease-out-cubic
      setValue(Math.round(ease * target));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, enabled]);
  return value;
}

// ─── Live threat ticker ────────────────────────────────────────────────

const DEMO_TICKER_ITEMS = [
  { symbol: 'BONK9x', tier: 'rug',     drop: 41, time: '2m ago' },
  { symbol: 'PEPE2',  tier: 'danger',  drop: 28, time: '7m ago' },
  { symbol: 'SOLANA', tier: 'safe',    drop:  0, time: '11m ago' },
  { symbol: 'WIF3',   tier: 'caution', drop: 12, time: '14m ago' },
  { symbol: 'DOGE5',  tier: 'danger',  drop: 33, time: '19m ago' },
  { symbol: 'FLOKI2', tier: 'rug',     drop: 55, time: '23m ago' },
  { symbol: 'MEME',   tier: 'caution', drop: 8,  time: '28m ago' },
  { symbol: 'RAY',    tier: 'safe',    drop: 0,  time: '31m ago' },
];

function ThreatTicker({ items }: { items: typeof DEMO_TICKER_ITEMS }) {
  const doubled = [...items, ...items]; // seamless loop
  return (
    <div className="relative overflow-hidden h-8 border-t border-b border-slate-800/50 bg-slate-950/60 backdrop-blur-sm">
      <div className="absolute inset-y-0 left-0 w-12 z-10 bg-gradient-to-r from-[#050810] to-transparent pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-12 z-10 bg-gradient-to-l from-[#050810] to-transparent pointer-events-none" />
      <div className="flex items-center h-full animate-ticker" style={{ width: 'max-content' }}>
        {doubled.map((item, i) => (
          <span key={i} className="inline-flex items-center gap-2 px-5 text-[11px] whitespace-nowrap">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              item.tier === 'rug' ? 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]' :
              item.tier === 'danger' ? 'bg-orange-400' :
              item.tier === 'caution' ? 'bg-yellow-400' : 'bg-emerald-400'
            }`} />
            <span className="font-mono font-semibold text-slate-300">{item.symbol}</span>
            {item.drop > 0
              ? <span className="text-red-400 font-semibold">−{item.drop}pts</span>
              : <span className="text-emerald-400">clean</span>}
            <span className="text-slate-600">{item.time}</span>
            <span className="text-slate-800 mx-1">·</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Stats strip with count-up ─────────────────────────────────────────

function StatsStrip({ stats }: { stats: LiveStats }) {
  const tokens  = useCountUp(stats.tokensTracked,  1200, !stats.loading);
  const scans   = useCountUp(stats.riskScans,       1600, !stats.loading);
  const apiCalls = useCountUp(stats.totalApiCalls,  1800, !stats.loading);

  return (
    <div className="max-w-6xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-3 animate-stagger">
      <div className="rounded-2xl border border-slate-800/50 bg-slate-900/40 px-4 py-5 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:-translate-y-1 hover:shadow-lg transition-all duration-200">
        {stats.loading
          ? <div className="h-11 w-14 mx-auto rounded-lg bg-slate-800/60 animate-shimmer" />
          : <div className="text-4xl font-black text-white tabular-nums">{tokens}</div>}
        <div className="text-[10px] text-slate-500 mt-1.5 uppercase tracking-widest">tokens tracked</div>
      </div>
      <div className="rounded-2xl border border-slate-800/50 bg-slate-900/40 px-4 py-5 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:-translate-y-1 hover:shadow-lg transition-all duration-200">
        {stats.loading
          ? <div className="h-11 w-20 mx-auto rounded-lg bg-slate-800/60 animate-shimmer" />
          : <div className="text-4xl font-black text-cyan-400 tabular-nums">{scans.toLocaleString()}</div>}
        <div className="text-[10px] text-slate-500 mt-1.5 uppercase tracking-widest">risk scans</div>
      </div>
      <div className="rounded-2xl border border-slate-800/50 bg-slate-900/40 px-4 py-5 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:-translate-y-1 hover:shadow-lg transition-all duration-200">
        {stats.loading
          ? <div className="h-11 w-20 mx-auto rounded-lg bg-slate-800/60 animate-shimmer" />
          : <div className="text-4xl font-black text-white tabular-nums">{apiCalls.toLocaleString()}</div>}
        <div className="text-[10px] text-slate-500 mt-1.5 uppercase tracking-widest">api calls</div>
      </div>
      <div className="rounded-2xl border border-slate-800/50 bg-slate-900/40 px-4 py-5 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] hover:-translate-y-1 hover:shadow-lg transition-all duration-200">
        <div className="text-4xl font-black text-white">15m</div>
        <div className="text-[10px] text-slate-500 mt-1.5 uppercase tracking-widest">scan cadence</div>
      </div>
    </div>
  );
}

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
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Pulsing ring halos */}
      <span className="absolute inset-0 rounded-full border border-cyan-400/30 animate-ring-pulse" />
      <span className="absolute inset-0 rounded-full border border-cyan-400/20 animate-ring-pulse" style={{ animationDelay: '1.2s' }} />
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="relative z-10">
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
    </div>
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
      <p className="text-[11px] text-slate-500 mt-1.5 uppercase tracking-widest">{label}</p>
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
    <section className="px-6 py-24 border-t border-slate-800/50 bg-gradient-to-b from-cyan-950/10 via-transparent to-transparent">
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

// ─── Risk Catches Banner — live evidence chain ────────────────────────

function formatDuration(ms: number): string {
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

function ProofWall({ accuracy, record }: { accuracy: AccuracyReport | null; record: PredictionOutcomeRecord | null }) {
  if (!accuracy && !record) return null;

  const precision = accuracy?.metrics.precision == null
    ? 'pending'
    : `${Math.round(accuracy.metrics.precision * 100)}%`;
  const primarySignal = record?.triggerSignals?.[0] ?? 'DBC WSOL vault liquidity collapse';
  const balanceSignal = record?.triggerSignals?.find((s) => s.startsWith('SOL balance:'));
  const evidenceUrl = record
    ? `${SENTINEL_API_ORIGIN}/v1/watch/catch-evidence/${record.mint}?caughtAt=${record.caughtAt}`
    : PUBLIC_CATCHES_HTML;
  const status = record?.summaryStatus ?? 'pending';
  const baselineAgeMin = record ? Math.max(1, Math.round((record.caughtAt - record.initialAt) / 60_000)) : null;
  const confirmationReason = record?.confirmationReasons?.[0] ?? 'Post-alert outcome checked against external pool evidence';
  const windowBadges = record
    ? [
        ['15m', record.windows.m15?.status],
        ['1h', record.windows.h1?.status],
        ['24h', record.windows.h24?.status],
      ]
    : [];

  return (
    <div className="mb-8 overflow-hidden rounded-[28px] border border-emerald-400/25 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.22),transparent_34%),linear-gradient(135deg,rgba(6,12,21,0.96),rgba(2,6,23,0.86))] shadow-[0_24px_90px_rgba(0,0,0,0.36),0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="border-b border-white/[0.06] bg-white/[0.025] px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
          Judge proof pack
        </div>
        <div className="text-[11px] text-slate-500">Baseline → alert → evidence → outcome, all public</div>
      </div>

      <div className="p-5">
      <div className="flex flex-col lg:flex-row lg:items-start gap-5">
        <div className="flex-1">
          <h3 className="text-2xl sm:text-4xl font-black tracking-[-0.04em] text-white">
            {record?.symbol ?? 'A Bags launch'} deteriorated from baseline, then got verified after the alert.
          </h3>
          <p className="mt-3 text-sm text-slate-400 leading-relaxed">
            This is the proof loop: prior safe snapshot → Telegram alert → public evidence bundle → post-alert outcome tracking.
            {record ? (
              <> The confirmed record shows <span className="text-emerald-300 font-semibold">{primarySignal}</span>{balanceSignal ? <> and <span className="text-white">{balanceSignal}</span></> : null}.</>
            ) : (
              <> New catches are evaluated at 15m, 1h, and 24h against external pool evidence.</>
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 min-w-[280px]">
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Confirmed</div>
            <div className="mt-1 text-2xl font-black text-emerald-300">{accuracy?.metrics.confirmed ?? 0}</div>
          </div>
          <div className="rounded-2xl border border-slate-800/70 bg-black/20 p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Precision</div>
            <div className="mt-1 text-2xl font-black text-white">{precision}</div>
          </div>
          <div className="rounded-2xl border border-slate-800/70 bg-black/20 p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Status</div>
            <div className={`mt-1 text-sm font-black uppercase ${
              status === 'confirmed' ? 'text-emerald-300' :
              status === 'false_positive' ? 'text-red-300' :
              status === 'inconclusive' ? 'text-yellow-300' : 'text-cyan-300'
            }`}>{status.replace('_', ' ')}</div>
          </div>
          <div className="rounded-2xl border border-slate-800/70 bg-black/20 p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Baseline age</div>
            <div className="mt-1 text-sm font-semibold text-slate-200">{baselineAgeMin ? `${baselineAgeMin} min` : '15m / 1h / 24h'}</div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        {['Baseline alert', 'Evidence bundle', 'Outcome verified'].map((step, idx) => (
          <div key={step} className="rounded-2xl border border-slate-800/70 bg-black/20 p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-600">Step {idx + 1}</div>
            <div className="mt-1 text-sm font-bold text-white">{step}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              {idx === 0 ? 'Triggered by rapid risk deterioration' : idx === 1 ? 'Immutable public record' : confirmationReason}
            </div>
          </div>
        ))}
      </div>

      {windowBadges.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {windowBadges.map(([label, value]) => (
            <span key={label} className="rounded-full border border-slate-800/70 bg-slate-950/45 px-3 py-1 text-[11px] text-slate-300">
              {label}: <span className={value === 'confirmed' ? 'text-emerald-300 font-bold' : 'text-slate-400'}>{value ?? 'pending'}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-col sm:flex-row gap-2">
        <a href={evidenceUrl} target="_blank" rel="noopener" className="inline-flex min-h-11 justify-center rounded-xl bg-emerald-400 px-4 py-2.5 text-xs font-black text-slate-950 hover:bg-emerald-300 transition-colors">
          Open evidence bundle ↗
        </a>
        <a href={PUBLIC_ACCURACY_HTML} target="_blank" rel="noopener" className="inline-flex min-h-11 justify-center rounded-xl border border-cyan-400/25 bg-cyan-400/5 px-4 py-2.5 text-xs font-bold text-cyan-200 hover:bg-cyan-400/10 transition-colors">
          View outcome tracker ↗
        </a>
        <a href={PUBLIC_CATCHES_HTML} target="_blank" rel="noopener" className="inline-flex min-h-11 justify-center rounded-xl border border-slate-800/70 bg-slate-950/30 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-900/40 transition-colors">
          Evidence chain ↗
        </a>
      </div>
      </div>
    </div>
  );
}

function PreRugCatchesBanner() {
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [stats, setStats] = useState<{ tokensWatched: number; catches: number; avgLeadTimeMs: number } | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [explanations, setExplanations] = useState<Record<string, RiskExplanation | null>>({});
  const [loadingExpl, setLoadingExpl] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchPreRugCatches(10).catch(() => null),
      fetchAlertFeed().catch(() => null),
      fetchAccuracyReport(20).catch(() => null),
    ]).then(([catchData, alertData, accuracyData]) => {
      const merged: EvidenceItem[] = [];
      setAccuracy(accuracyData);

      // Risk deterioration catches with a prior safe baseline.
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
      // Risk catches always appear first (they are the anchor proof), then alerts newest first.
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

  const confirmedProof = accuracy?.records.find((r) => r.summaryStatus === 'confirmed')
    ?? accuracy?.records.find((r) => r.symbol === 'FREE PLINY')
    ?? null;

  return (
    <section className="px-6 py-24 border-t border-slate-800/50 bg-gradient-to-b from-red-950/10 via-transparent to-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-red-500/20 bg-red-500/5 text-[10px] font-semibold text-red-400 tracking-wider uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            Evidence chain
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">Risk events · live</h2>
          <p className="text-slate-400 mt-3 text-sm">
            Every 15 minutes, our cron scans the top 100 Bags tokens. Tier drops and score deterioration events are logged automatically — not curated.
          </p>
        </div>

        <ProofWall accuracy={accuracy} record={confirmedProof} />

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
                  {stats.avgLeadTimeMs > 0 ? formatDuration(stats.avgLeadTimeMs) : '—'}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-1">Avg baseline age</div>
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
              <span>Every catch is timestamped · baseline age = time from prior safe snapshot to alert</span>
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
                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-cyan-500/20 text-cyan-500 bg-cyan-500/5">risk catch</span>
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
                    Flagged {formatDuration(Date.now() - c.flaggedAt)} ago
                    {c.source === 'catch' && c.firstSeenAt !== c.flaggedAt && (
                      <> · first seen {formatDuration(Date.now() - c.firstSeenAt)} ago</>
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

function HeroProofLinks() {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center lg:justify-start gap-2 pt-2">
      <a
        href={PUBLIC_ACCURACY_HTML}
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 py-2.5 text-sm font-black text-slate-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-300 hover:shadow-emerald-500/30 transition-all"
      >
        Open live outcome tracker
        <span className="text-slate-800/70">↗</span>
      </a>
    </div>
  );
}

function HeroLivePanel({ stats }: { stats: LiveStats }) {
  return (
    <div className="relative">
      <div className="absolute -inset-6 bg-gradient-to-br from-cyan-500/10 via-transparent to-fuchsia-500/10 blur-2xl rounded-[28px] pointer-events-none" />
      <div className="relative rounded-2xl border border-slate-800/70 bg-slate-950/55 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.03)] p-5 text-left">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Autonomous loop</div>
            <div className="mt-2 text-lg font-bold text-white leading-tight">Monitors Bags tokens on a schedule</div>
            <div className="mt-2 text-xs text-slate-400 leading-relaxed">
              Cron tick scans the top 100 Bags tokens and logs deteriorations with timestamps — verify via the public HTML endpoints.
            </div>
          </div>
          <div className="shrink-0 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-3 py-1 text-[11px] text-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-800/60 bg-black/20 p-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">Scan cadence</div>
            <div className="mt-1 text-sm font-semibold text-white">Every 15 minutes</div>
            <div className="mt-1 text-[11px] text-slate-500">Cron-driven agent</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-black/20 p-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">Coverage</div>
            <div className="mt-1 text-sm font-semibold text-white">Top 100</div>
            <div className="mt-1 text-[11px] text-slate-500">Bags leaderboard snapshot</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-black/20 p-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">Risk scans</div>
            {stats.loading ? (
              <div className="mt-2 h-7 w-24 rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="mt-1 text-sm font-semibold text-cyan-300 tabular-nums">{stats.riskScans.toLocaleString()}</div>
            )}
            <div className="mt-1 text-[11px] text-slate-500">Public API usage (KV)</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">API calls</div>
            {stats.loading ? (
              <div className="mt-2 h-7 w-28 rounded-md bg-slate-800/60 animate-pulse" />
            ) : (
              <div className="mt-1 text-sm font-semibold text-white tabular-nums">{stats.totalApiCalls.toLocaleString()}</div>
            )}
            <div className="mt-1 text-[11px] text-slate-500">Total tracked requests</div>
          </div>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <a
            href={PUBLIC_DEMO_HTML}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2 text-xs font-bold text-slate-950 hover:from-cyan-400 hover:to-cyan-300 transition-colors"
          >
            Open proof-first viewer ↗
          </a>
          <a
            href="https://github.com/loquit-tud/sentinel/blob/master/EVIDENCE.md"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center justify-center rounded-xl border border-slate-800/70 bg-slate-950/30 px-4 py-2 text-xs font-semibold text-slate-200 hover:border-slate-700 hover:bg-slate-900/40 transition-colors"
          >
            Read EVIDENCE.md ↗
          </a>
        </div>
      </div>
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
      <nav className="sticky top-0 z-20 px-4 pt-4">
        <div className="max-w-6xl mx-auto px-5 py-3 rounded-2xl border border-white/[0.07] bg-[#07101c]/78 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.28)] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <SentinelLogo size={26} />
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold tracking-tight truncate text-white">Sentinel</span>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-[9px] text-cyan-300 font-semibold tracking-[0.18em] uppercase">Bags risk</span>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <a
              href={PUBLIC_DEMO_HTML}
              target="_blank"
              rel="noopener"
              className="hidden md:inline-flex text-[11px] font-medium px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              Proof viewer ↗
            </a>
            <a
              href="https://github.com/loquit-tud/sentinel"
              target="_blank"
              rel="noopener"
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors hidden sm:inline"
            >
              GitHub ↗
            </a>
            <a
              href="https://bags.fm"
              target="_blank"
              rel="noopener"
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors hidden sm:inline"
            >
              bags.fm ↗
            </a>
            <button
              onClick={onLaunch}
              className="text-sm font-semibold px-4 py-2 rounded-xl bg-cyan-400 text-slate-950 hover:bg-cyan-300 transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30"
            >
              Open app
            </button>
          </div>
        </div>
      </nav>

      {/* Live threat ticker */}
      <ThreatTicker items={DEMO_TICKER_ITEMS} />

      {/* Hero */}
      <section className="relative flex-1 px-6 pt-16 pb-24 sm:pt-24 sm:pb-32 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_38%_at_22%_12%,rgba(6,182,212,0.16),transparent)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_34%_26%_at_82%_24%,rgba(244,114,182,0.09),transparent)] pointer-events-none" />
        <div className="absolute left-[8%] top-[18%] h-56 w-56 rounded-full border border-cyan-400/10 bg-cyan-400/[0.03] blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-6xl mx-auto animate-fade-in">
          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-10 lg:gap-14 items-start">
            <div className="text-center lg:text-left">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/50 bg-slate-900/60 px-4 py-1.5 text-[11px] text-slate-400 shadow-sm mx-auto lg:mx-0">
                {/* Animated radar dot */}
                <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
                  <circle cx="8" cy="8" r="7" fill="none" stroke="rgba(52,211,153,0.2)" strokeWidth="1" />
                  <circle cx="8" cy="8" r="4" fill="none" stroke="rgba(52,211,153,0.15)" strokeWidth="0.8" />
                  <line x1="8" y1="8" x2="8" y2="1.5" stroke="rgba(52,211,153,0.7)" strokeWidth="1.2" strokeLinecap="round" className="animate-radar-sweep" style={{ transformOrigin: '8px 8px' }} />
                  <circle cx="8" cy="8" r="1.5" fill="rgba(52,211,153,0.8)" />
                </svg>
                Baseline-to-alert proof stack · live on Bags
              </div>

              <div className="mt-8 lg:mt-10 grid lg:grid-cols-[72px_1fr] gap-6 items-start">
                <div className="hidden lg:flex flex-col items-center gap-3 pt-2">
                  <div className="text-[10px] tracking-[0.28em] uppercase text-slate-600 [writing-mode:vertical-rl] rotate-180">risk intelligence</div>
                  <div className="w-px h-40 bg-gradient-to-b from-cyan-400/60 via-slate-700 to-transparent" />
                </div>
                <div>
                  <h1 className="text-5xl sm:text-6xl lg:text-[88px] font-black tracking-[-0.06em] leading-[0.92] mb-5">
                    <span className="block text-white">Detect risk</span>
                    <span className="block bg-gradient-to-r from-cyan-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent animate-gradient-text">deterioration.</span>
                  </h1>
                  <p className="text-base sm:text-lg text-slate-400 max-w-xl mx-auto lg:mx-0 leading-relaxed">
                    Sentinel scans the top 100 Bags tokens every 15 minutes, stores a safe baseline, alerts on rapid risk deterioration, and verifies outcomes after the alert.
                  </p>

                  <div className="mt-5 flex flex-wrap justify-center lg:justify-start gap-2">
                    {['Baseline snapshots', 'Telegram alerts', 'Outcome tracker'].map((label) => (
                      <span key={label} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                        {label}
                      </span>
                    ))}
                  </div>

                  <div className="mt-8 space-y-4">
                    <HeroSearch onScanToken={onScanToken} />
                    <HeroProofLinks />
                  </div>

                  <p className="mt-6 max-w-xl text-xs text-slate-500 leading-relaxed">
                    The full proof loop is visible in the live panel: scan cadence, coverage, public API usage, and the proof-first viewer.
                  </p>
                </div>
              </div>
            </div>

            <div className="relative lg:pt-8">
              <div className="absolute -inset-4 rounded-[32px] bg-gradient-to-b from-cyan-500/10 via-transparent to-transparent blur-2xl pointer-events-none" />
              <div className="relative rounded-[28px] border border-slate-800/60 bg-[#060c15]/88 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] overflow-hidden">
                {/* Scan beam */}
                <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent animate-scan-beam pointer-events-none z-20" />
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/60">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-600">live agent surface</div>
                    <div className="text-sm font-semibold text-white mt-1">Monitoring + proof stack</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
                  </div>
                </div>
                <div className="p-3">
                  <HeroLivePanel stats={stats} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2 superpowers */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800/60 to-transparent" />
      <section className="px-6 py-24 sm:py-28 bg-slate-950/10">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12 max-w-2xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-700/40 bg-slate-900/50 text-[10px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
              Core capabilities
            </div>
            <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-white">Two workflows for<br />Bags risk monitoring.</h2>
            <p className="text-slate-500 mt-4 text-sm">
              One runs when you ask. One runs <span className="text-cyan-400 font-medium">every 15 minutes, without you</span>.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-5 items-stretch">
            <LiveRiskCard mint={SENT_MINT} />

            <div className="bg-gradient-to-br from-slate-900/85 to-slate-900/45 rounded-[24px] p-6 border border-slate-800/50 flex flex-col justify-between shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xl">📡</span>
                  <h3 className="text-white font-semibold text-sm tracking-tight">Autonomous broadcast agent</h3>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed mt-2">
                  Every 15 minutes, a cron agent scans 100 Bags tokens.
                  When risk deteriorates from baseline, it <span className="text-white">automatically posts to Telegram</span> — no human trigger, no dashboard to keep open.
                  Subscribe once for broadcasts when the agent escalates. Creators can filter alerts by their wallet to avoid noise.
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
                      href="https://github.com/loquit-tud/sentinel/blob/master/docs/telegram.md"
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
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800/60 to-transparent" />
      <section className="px-6 py-24 sm:py-28 bg-slate-950/30">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-700/40 bg-slate-900/50 text-[10px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
              How it works
            </div>
            <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-white">What Sentinel records.<br /><span className="text-slate-500 font-normal">What users can verify.</span></h2>
            <p className="text-slate-500 mt-4 text-sm">Baseline snapshots, score changes, pool signals, and post-alert outcomes.</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                num: '01',
                phase: 'BEHAVIORAL LAYER',
                phaseColor: 'text-amber-400 border-amber-500/25 bg-amber-500/8',
                icon: '📉',
                title: 'Phase detection',
                desc: 'Risk deterioration shows up as score drops, tier transitions, and pool liquidity stress. Sentinel stores those changes against a prior baseline.',
                signal: 'risk deterioration detected — verify evidence',
              },
              {
                num: '02',
                phase: 'DECISION LAYER',
                phaseColor: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
                icon: '🤖',
                title: 'LLM policy engine',
                desc: 'The agent does not just score. It decides whether to watch, rescan, log quietly, broadcast to Telegram, or escalate. A calibrated heuristic fallback runs when the LLM is unavailable.',
                signal: 'action: telegram_alert — confidence 84%',
              },
              {
                num: '03',
                phase: 'AUTONOMOUS LAYER',
                phaseColor: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
                icon: '📡',
                title: 'Agent that acts',
                desc: 'Sentinel does not wait for you to open a dashboard. Baseline deterioration → Telegram broadcast → public evidence. Automatic.',
                signal: 'example catch: 32m from safe baseline to alert',
              },
            ].map((f) => (
              <div key={f.title} className="relative p-5 rounded-2xl border border-slate-800/60 bg-gradient-to-b from-slate-900/60 to-slate-900/30 hover:border-slate-700/60 hover:-translate-y-1 transition-all duration-300 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] group">
                <div className="flex items-start justify-between mb-3">
                  <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-bold tracking-widest uppercase ${f.phaseColor}`}>
                    {f.phase}
                  </div>
                  <span className="text-[10px] font-black text-slate-700 group-hover:text-slate-600 transition-colors">{f.num}</span>
                </div>
                <div className="text-2xl mb-2.5">{f.icon}</div>
                <h3 className="text-white font-semibold text-sm mb-2">{f.title}</h3>
                <p className="text-slate-400 text-xs leading-relaxed mb-4">{f.desc}</p>
                <div className="text-[10px] text-slate-600 font-mono border-t border-slate-800/50 pt-3 mt-auto">
                  › {f.signal}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* $SENT Fee Stats */}
      <SentFeeStatsWidget />

      {/* Risk catches — live evidence chain */}
      <PreRugCatchesBanner />

      {/* Proof & Audit */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800/60 to-transparent" />
      <section className="px-6 py-24 sm:py-28 bg-slate-950/30">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12 max-w-2xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-700/40 bg-slate-900/50 text-[10px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
              Open source · verifiable
            </div>
            <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-white">Don't trust us.<br /><span className="text-slate-500 font-normal">Verify.</span></h2>
            <p className="text-slate-500 mt-4 text-sm">
              Every score comes from public data. Every alert is timestamped. Read the code, run the API, check the evidence.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              { href: "https://github.com/loquit-tud/sentinel/blob/master/EVIDENCE.md", icon: '📜', title: 'EVIDENCE.md', desc: 'Full methodology + weights + current Bags leaderboard scan + ground-truth alignment protocol.' },
              { href: "https://sentinel-api.apiworkersdev.workers.dev/stats", icon: '📊', title: 'GET /stats', desc: 'Public endpoint. Raw JSON: total requests, per-endpoint breakdown, today vs yesterday. No auth.' },
              { href: "https://github.com/loquit-tud/sentinel/blob/master/worker/src/risk/engine.ts", icon: '⚙️', title: 'engine.ts', desc: '8-signal weighted scoring + instant rug override. 102 unit tests. Pure TypeScript, no magic.' },
              { href: "https://github.com/loquit-tud/sentinel/blob/master/docs/telegram.md", icon: '📩', title: 'Telegram bot docs', desc: 'Self-serve commands, creator alerts, webhook setup, and troubleshooting.' },
              { href: "https://github.com/loquit-tud/sentinel/blob/master/worker/src/partner/bags-partner.ts", icon: '🤝', title: 'Bags Partner API', desc: '4 Bags partner endpoints consumed: config, create, claim-stats, claim-txs. Plus leaderboard, fee-share, trade quotes.' },
            ].map((item) => (
              <a
                key={item.title}
                href={item.href}
                target="_blank"
                rel="noopener"
                className="p-5 rounded-2xl border border-slate-800/50 bg-gradient-to-b from-slate-900/50 to-slate-900/20 hover:border-slate-700/60 hover:from-slate-900/70 hover:-translate-y-1 hover:shadow-lg transition-all duration-200 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] group"
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-base">{item.icon}</span>
                  <h3 className="font-semibold text-sm text-white group-hover:text-cyan-300 transition-colors">{item.title}</h3>
                  <span className="text-[10px] text-slate-700 group-hover:text-cyan-600 ml-auto transition-colors">↗</span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">{item.desc}</p>
              </a>
            ))}
          </div>
          <p className="text-center text-[11px] text-slate-700 mt-8 font-mono">
            Reproduce scan: <span className="text-slate-500">npx tsx scripts/scan-top-tokens.ts</span> · Audit token: <span className="text-slate-500">curl /v1/risk/&lt;mint&gt;</span>
          </p>
        </div>
      </section>

      {/* CTA bottom */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-800/60 to-transparent" />
      <section className="relative px-6 py-28 text-center overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_50%,rgba(6,182,212,0.07),transparent)] pointer-events-none" />
        <div className="relative max-w-xl mx-auto space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/5 text-[10px] font-semibold text-emerald-400 tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running since April · 0 outages
          </div>
          <h2 className="text-4xl sm:text-5xl font-black tracking-tighter text-white leading-tight">
            The agent watches.<br /><span className="text-slate-500 font-normal">You decide.</span>
          </h2>
          <p className="text-slate-400 text-base">
            Free to use. No sign-up. Connect your wallet only when you want to claim fees.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onLaunch}
              className="text-base font-bold px-8 py-3.5 rounded-xl bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-all shadow-xl shadow-cyan-500/25 hover:shadow-cyan-500/35 hover:scale-[1.02] active:scale-[0.98]"
            >
              Launch App →
            </button>
            <a
              href={`https://bags.fm/token/${SENT_MINT}`}
              target="_blank"
              rel="noopener"
              className="text-sm font-medium px-6 py-3.5 rounded-xl border border-slate-700/50 text-slate-400 hover:text-white hover:border-slate-600 hover:bg-slate-900/40 transition-all"
            >
              View $SENT on Bags ↗
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800/30 px-6 py-5">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[11px] text-slate-600">
          <div className="flex items-center gap-2">
            <SentinelLogo size={14} />
            <span>Sentinel v0.14.0 · Autonomous risk monitoring for Bags</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/loquit-tud/sentinel" target="_blank" rel="noopener" className="hover:text-slate-300 transition-colors">GitHub</a>
            <a href="https://bags.fm" target="_blank" rel="noopener" className="hover:text-slate-300 transition-colors">bags.fm</a>
            <a href="https://t.me/SentinelRiskAlerts" target="_blank" rel="noopener" className="hover:text-slate-300 transition-colors">Telegram</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
