import { useState, useMemo } from 'react';
import type { TokenFeedItem, TokenPhase } from '../../../shared/types';
import { SENTINEL_API_ORIGIN } from '../api';

type SortField = 'volume' | 'fdv' | 'change' | 'fees' | 'risk';
type FilterTier = 'all' | 'safe' | 'caution' | 'danger';

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatFees(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e3).toFixed(0)}K`;
}

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'risk',   label: '🚨 Danger First' },
  { value: 'fees',   label: 'Lifetime Fees' },
  { value: 'volume', label: 'Volume 24h' },
  { value: 'fdv',    label: 'FDV' },
  { value: 'change', label: 'Price Change' },
];

const FILTER_OPTIONS: { value: FilterTier; label: string; color: string }[] = [
  { value: 'all', label: 'All', color: 'text-gray-300' },
  { value: 'safe', label: 'Safe', color: 'text-sentinel-safe' },
  { value: 'caution', label: 'Caution', color: 'text-sentinel-caution' },
  { value: 'danger', label: 'Risky', color: 'text-sentinel-danger' },
];

function SortButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-150 ${
        active
          ? 'bg-cyan-500 text-slate-950 shadow-lg'
          : 'text-slate-500 hover:text-slate-200 bg-slate-800 hover:bg-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

function TokenRow({ token, onSelect, index }: { token: TokenFeedItem; onSelect: (mint: string) => void; index: number }) {
  return (
    <button
      onClick={() => onSelect(token.mint)}
      className="w-full flex items-center gap-4 px-4 py-3.5 hover:bg-slate-800 rounded-lg transition-all duration-150 text-left group cursor-pointer animate-fade-in border-l-4 border-l-transparent hover:border-l-cyan-500"
      style={{ animationDelay: `${index * 20}ms` }}
    >
      {/* Rank */}
      <span className="text-xs text-gray-600 w-5 text-right font-mono">{index + 1}</span>

      {/* Icon */}
      <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center shrink-0 overflow-hidden ring-2 ring-slate-700 group-hover:ring-cyan-500 transition-all">
        {token.imageUrl ? (
          <img src={token.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span className="text-xs text-gray-500 font-medium">{token.symbol.slice(0, 2)}</span>
        )}
      </div>

      {/* Name + Symbol */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-white truncate group-hover:text-cyan-300 transition-colors">{token.name}</p>
        <p className="text-xs text-slate-500 font-mono">${token.symbol}</p>
      </div>

      {/* Volume */}
      <div className="text-right hidden sm:block w-20">
        <p className="text-sm font-medium text-slate-300 tabular-nums">{formatUsd(token.volume24h)}</p>
        <p className="text-[10px] text-slate-600">vol 24h</p>
      </div>

      {/* FDV */}
      <div className="text-right hidden md:block w-20">
        <p className="text-sm font-medium text-slate-300 tabular-nums">{formatUsd(token.fdv)}</p>
        <p className="text-[10px] text-slate-600">FDV</p>
      </div>

      {/* Change */}
      <div className="text-right w-16">
        <p className={`text-sm font-semibold tabular-nums ${token.priceChangePct24h >= 0 ? 'text-sentinel-safe' : 'text-sentinel-danger'}`}>
          {token.priceChangePct24h >= 0 ? '+' : ''}{token.priceChangePct24h.toFixed(1)}%
        </p>
      </div>

      {/* Risk + Pump Badge */}
      <div className="w-24 flex justify-end items-center gap-1.5">
        <PumpBadge token={token} />
        {token.riskTier && token.riskScore !== null ? (
          <RiskCell score={token.riskScore} tier={token.riskTier} />
        ) : (
          <span className="text-[10px] text-slate-600 px-2 py-1 border border-slate-800 rounded-full group-hover:border-cyan-500/40 group-hover:text-cyan-400 transition-all">scan →</span>
        )}
      </div>
    </button>
  );
}

const RISK_CELL_COLORS: Record<NonNullable<TokenFeedItem['riskTier']>, { text: string; bg: string; border: string; dot: string; glow: string }> = {
  safe:    { text: 'text-emerald-300', bg: 'bg-emerald-950',  border: 'border-emerald-700', dot: 'bg-emerald-400', glow: '' },
  caution: { text: 'text-amber-300',   bg: 'bg-amber-950',    border: 'border-amber-700',   dot: 'bg-amber-400',   glow: '' },
  danger:  { text: 'text-rose-300',    bg: 'bg-rose-950',     border: 'border-rose-700',    dot: 'bg-rose-400',    glow: '' },
  rug:     { text: 'text-red-300',     bg: 'bg-red-950',      border: 'border-red-600',     dot: 'bg-red-400',     glow: '' },
};

function RiskCell({ score, tier }: { score: number; tier: NonNullable<TokenFeedItem['riskTier']> }) {
  const c = RISK_CELL_COLORS[tier];
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${c.bg} ${c.border} ${c.glow}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      <span className={`text-sm font-mono font-semibold tabular-nums ${c.text}`}>{score}</span>
      <span className={`text-[9px] uppercase tracking-wider font-semibold ${c.text} opacity-70`}>{tier}</span>
    </div>
  );
}

const PHASE_BADGE: Partial<Record<TokenPhase, { label: string; className: string }>> = {
  manipulation:  { label: '⚡ PUMP',   className: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  accumulation:  { label: '🎯 ACCUM',  className: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  distribution:  { label: '📤 DIST',   className: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  collapse:      { label: '💀 EXIT',   className: 'bg-red-600/20 text-red-400 border-red-600/40' },
};

function PumpBadge({ token }: { token: TokenFeedItem }) {
  const ps = token.pumpSignal;
  if (!ps) return null;

  // Only show badge if pumpScore is high enough or phase is actionable
  const badge = PHASE_BADGE[ps.phase];
  const highPump = ps.pumpScore >= 60;

  if (!badge && !highPump) return null;

  const display = badge ?? { label: `⚡ ${ps.pumpScore}`, className: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' };

  return (
    <div
      className={`hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wide ${display.className}`}
      title={ps.reasoning}
    >
      {display.label}
    </div>
  );
}

export function FeedPage({ tokens, loading, onSelectToken }: {
  tokens: TokenFeedItem[];
  loading: boolean;
  onSelectToken: (mint: string) => void;
}) {
  const [sortBy, setSortBy] = useState<SortField>('volume');
  const [filterTier, setFilterTier] = useState<FilterTier>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let result = [...tokens];

    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.symbol.toLowerCase().includes(q) ||
        t.mint.toLowerCase().includes(q)
      );
    }

    // Tier filter
    if (filterTier !== 'all') {
      result = result.filter(t => {
        if (!t.riskTier) return filterTier === 'caution'; // unscored → show in caution
        if (filterTier === 'danger') return t.riskTier === 'danger' || t.riskTier === 'rug';
        return t.riskTier === filterTier;
      });
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'risk':   return (a.riskScore ?? 100) - (b.riskScore ?? 100); // lowest score = most dangerous
        case 'volume': return b.volume24h - a.volume24h;
        case 'fdv':    return b.fdv - a.fdv;
        case 'change': return b.priceChangePct24h - a.priceChangePct24h;
        case 'fees':   return b.lifetimeFees - a.lifetimeFees;
      }
    });

    return result;
  }, [tokens, sortBy, filterTier, search]);

  if (loading) {
    return (
      <div className="space-y-1">
        <div className="flex gap-2 mb-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-8 w-20 bg-sentinel-surface/50 rounded-md animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-[60px] bg-sentinel-surface/30 rounded-lg animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div className="text-center py-16 space-y-3">
        <div className="w-16 h-16 mx-auto rounded-full bg-sentinel-surface border border-sentinel-border flex items-center justify-center">
          <span className="text-2xl">🔍</span>
        </div>
        <p className="text-gray-400">No tokens in feed yet.</p>
        <p className="text-gray-600 text-sm">Paste a mint address above to scan any Solana token.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 shadow-xl overflow-hidden">
      {/* Colored top accent bar */}
      <div className="h-0.5 bg-gradient-to-r from-cyan-500 via-violet-500 to-cyan-500" />
      <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
            </span>
            <div className="text-[10px] uppercase tracking-widest text-cyan-400 font-semibold">Live · Discovery</div>
          </div>
          <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">Top Bags tokens + Sentinel risk</h2>
          <p className="text-xs text-slate-500 max-w-2xl">
            This table is the in-app view of the public feed. For judge-friendly HTML, open the endpoints directly.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
          <a
            href={`${SENTINEL_API_ORIGIN}/v1/tokens/feed`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition-colors"
          >
            HTML feed <span className="ml-1 font-mono text-cyan-300/80">/v1/tokens/feed</span> ↗
          </a>
          <a
            href={`${SENTINEL_API_ORIGIN}/v1/demo`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center justify-center rounded-xl border border-slate-800/70 bg-slate-950/30 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-slate-700 hover:bg-slate-900/40 transition-colors"
          >
            Proof viewer <span className="ml-1 font-mono text-slate-400">/v1/demo</span> ↗
          </a>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between border-b border-slate-800 pb-4">
        {/* Sort */}
        <div className="flex gap-1.5 flex-wrap">
          {SORT_OPTIONS.map(opt => (
            <SortButton key={opt.value} active={sortBy === opt.value} label={opt.label} onClick={() => setSortBy(opt.value)} />
          ))}
        </div>

        {/* Filter + Search */}
        <div className="flex gap-2 items-center">
          <div className="flex gap-1">
            {FILTER_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setFilterTier(opt.value)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  filterTier === opt.value
                    ? `${opt.color} bg-slate-800 ring-1 ring-white/20`
                    : 'text-slate-600 hover:text-slate-300 hover:bg-slate-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter..."
            className="w-28 sm:w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
          />
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex gap-4 text-xs">
        <span className="text-slate-400 font-medium">{filtered.length} tokens</span>
        <span className="text-emerald-400 font-bold">{tokens.filter(t => t.priceChangePct24h > 0).length} ↑</span>
        <span className="text-rose-400 font-bold">{tokens.filter(t => t.priceChangePct24h < 0).length} ↓</span>
      </div>

      {/* Table header */}
      <div className="sticky top-0 z-10 flex items-center px-4 py-2.5 text-[10px] text-slate-500 uppercase tracking-widest border-b border-slate-800 bg-slate-900">
        <div className="w-5 text-right mr-4">#</div>
        <div className="w-9 shrink-0" />
        <div className="flex-1 ml-4">Token</div>
        <div className="text-right hidden sm:block w-20">Volume</div>
        <div className="text-right hidden md:block w-20">FDV</div>
        <div className="text-right w-16">24h</div>
        <div className="text-right w-24">Risk</div>
      </div>

      {/* Rows */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No tokens match your filters.
        </div>
      ) : (
        <div className="divide-y divide-slate-800">
          {filtered.map((t, i) => (
            <TokenRow key={t.mint} token={t} onSelect={onSelectToken} index={i} />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
