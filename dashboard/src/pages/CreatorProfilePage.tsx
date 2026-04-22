import { useState, useEffect, useCallback, useRef } from 'react';
import type { CreatorProfile, CreatorToken, RiskTier } from '../../../shared/types';
import { ScoreGauge, TierBadge } from '../components/RiskDisplay';
import { fetchCreatorProfile, getCreatorCardUrl, buildCreatorTweetUrl, fetchCreatorTrust } from '../api';
import type { CreatorTrustScore } from '../api';

const TIER_ROW_BG: Record<RiskTier, string> = {
  safe: 'bg-sentinel-safe/5 border-sentinel-safe/20',
  caution: 'bg-sentinel-caution/5 border-sentinel-caution/20',
  danger: 'bg-sentinel-danger/5 border-sentinel-danger/20',
  rug: 'bg-sentinel-rug/5 border-sentinel-rug/20',
};

function TokenRow({ token, rank, onView }: { token: CreatorToken; rank: number; onView: (mint: string) => void }) {
  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border ${TIER_ROW_BG[token.riskTier]} transition-all hover:border-opacity-60 cursor-pointer`}
      onClick={() => onView(token.mint)}
    >
      <span className="text-xs text-gray-600 w-5 text-right font-mono">{rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">{token.name}</span>
          <span className="text-xs text-gray-500">{token.symbol}</span>
          {token.rugged && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sentinel-rug/20 text-sentinel-rug border border-sentinel-rug/30 font-medium">
              RUGGED
            </span>
          )}
        </div>
        <p className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{token.mint}</p>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-mono font-medium ${
            token.riskScore >= 70 ? 'text-sentinel-safe' :
            token.riskScore >= 40 ? 'text-sentinel-caution' :
            token.riskScore >= 10 ? 'text-sentinel-danger' :
            'text-sentinel-rug'
          }`}>
            {token.riskScore}
          </span>
          <TierBadge tier={token.riskTier} />
        </div>
      </div>
    </div>
  );
}

export function CreatorProfilePage({
  wallet,
  onBack,
  onViewToken,
}: {
  wallet: string;
  onBack: () => void;
  onViewToken: (mint: string) => void;
}) {
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<CreatorTrustScore | null>(null);
  const [trustLoading, setTrustLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCreatorProfile(wallet)
      .then(setProfile)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // Fetch trust score in parallel
    setTrustLoading(true);
    fetchCreatorTrust(wallet)
      .then(setTrust)
      .catch(() => {}) // non-blocking
      .finally(() => setTrustLoading(false));
  }, [wallet]);

  useEffect(() => { load(); }, [load]);

  const shortWallet = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Back nav */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-sm group"
      >
        <span className="inline-block transition-transform group-hover:-translate-x-0.5">←</span>
        Risk Alerts
      </button>

      {/* Loading */}
      {loading && (
        <div className="text-center py-16">
          <div className="w-6 h-6 border-2 border-sentinel-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-500 mt-3">Scanning creator&apos;s tokens…</p>
          <p className="text-xs text-gray-600 mt-1">This may take a moment</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-4 bg-sentinel-danger/5 border border-sentinel-danger/20 rounded-xl">
          <p className="text-sm text-gray-400">{error}</p>
          <button onClick={load} className="text-xs text-sentinel-accent hover:underline mt-2">Retry</button>
        </div>
      )}

      {/* Profile */}
      {profile && !loading && (
        <>
          {/* Header */}
          <div className="flex items-center gap-5">
            <ScoreGauge score={profile.reputationScore} tier={profile.reputationTier} size={100} />
            <div className="space-y-1.5">
              <h2 className="text-lg font-bold text-white">Creator Profile</h2>
              <p className="text-sm text-gray-400 font-mono">{shortWallet}</p>
              <TierBadge tier={profile.reputationTier} />
            </div>
          </div>

          {/* Trust verdict — hero banner (Bags-specific differentiator) */}
          {trust && !trustLoading && (
            <div className={`rounded-xl border p-5 ${
              trust.trustScore >= 70 ? 'border-sentinel-safe/30 bg-sentinel-safe/5' :
              trust.trustScore >= 40 ? 'border-sentinel-caution/30 bg-sentinel-caution/5' :
              trust.trustScore >= 10 ? 'border-sentinel-danger/30 bg-sentinel-danger/5' :
                                       'border-sentinel-rug/30 bg-sentinel-rug/5'
            }`}>
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1">
                    Trust Verdict
                  </div>
                  <p className="text-base text-white font-medium leading-snug">{trust.verdict}</p>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`text-3xl font-bold ${
                    trust.trustScore >= 70 ? 'text-sentinel-safe' :
                    trust.trustScore >= 40 ? 'text-sentinel-caution' :
                    trust.trustScore >= 10 ? 'text-sentinel-danger' :
                    'text-sentinel-rug'
                  }`}>{trust.trustScore}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">trust / 100</div>
                </div>
              </div>

              {/* Risk flags — chip row */}
              {trust.riskFlags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {trust.riskFlags.map((flag, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-sentinel-rug/15 border border-sentinel-rug/30 text-sentinel-rug font-medium">
                      ⚠ {flag}
                    </span>
                  ))}
                </div>
              )}

              {/* Signals grid — 4 most important */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SignalChip label="Rug Ratio" value={`${(trust.signals.rugRatio * 100).toFixed(0)}%`} warn={trust.signals.rugRatio > 0.2} />
                <SignalChip label="Serial Launcher" value={trust.signals.serialLauncher ? 'YES' : 'No'} warn={trust.signals.serialLauncher} />
                <SignalChip label="LP Removals" value={String(trust.signals.lpRemovalCount)} warn={trust.signals.lpRemovalCount > 0} />
                <SignalChip label="Avg Lifespan" value={`${trust.signals.avgTokenLifespan}d`} warn={trust.signals.avgTokenLifespan < 7 && trust.signals.avgTokenLifespan > 0} />
              </div>
            </div>
          )}
          {trustLoading && (
            <div className="p-4 rounded-xl border border-sentinel-border/30 bg-sentinel-surface/20 animate-pulse">
              <p className="text-sm text-gray-500">Computing trust verdict…</p>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Tokens Launched" value={String(profile.totalTokens)} />
            <StatCard
              label="Rugged"
              value={String(profile.ruggedCount)}
              color={profile.ruggedCount > 0 ? 'text-sentinel-danger' : 'text-sentinel-safe'}
            />
            <StatCard
              label="Safe Tokens"
              value={String(profile.safeCount)}
              color="text-sentinel-safe"
            />
            <StatCard
              label="Avg Risk Score"
              value={String(profile.avgRiskScore)}
              color={
                profile.avgRiskScore >= 70 ? 'text-sentinel-safe' :
                profile.avgRiskScore >= 40 ? 'text-sentinel-caution' :
                'text-sentinel-danger'
              }
            />
          </div>

          {/* Reputation Card — shareable */}
          <ReputationCard profile={profile} wallet={wallet} />

          {/* Rug ratio warning */}
          {profile.totalTokens > 0 && profile.ruggedCount > 0 && (
            <div className="p-3 rounded-lg border border-sentinel-danger/30 bg-sentinel-danger/5 text-sm">
              <span className="text-sentinel-danger font-medium">
                ⚠️ {Math.round((profile.ruggedCount / profile.totalTokens) * 100)}% rug rate
              </span>
              <span className="text-gray-400">
                {' '}— {profile.ruggedCount} of {profile.totalTokens} tokens by this creator were flagged as rugged.
              </span>
            </div>
          )}

          {/* Token list */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-300">
              Tokens by this creator ({profile.tokens.length})
            </h3>
            {profile.tokens.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">
                No tokens found for this creator yet.
              </p>
            ) : (
              <div className="space-y-2">
                {profile.tokens.map((token, i) => (
                  <TokenRow
                    key={token.mint}
                    token={token}
                    rank={i + 1}
                    onView={onViewToken}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Embed badge */}
          <div className="p-4 rounded-xl border border-sentinel-border/50 bg-sentinel-surface/30 space-y-2">
            <h3 className="text-sm font-medium text-gray-300">Embeddable Badges</h3>
            <p className="text-xs text-gray-500">
              Creators can embed these badges on their token pages to show Sentinel scores:
            </p>
            <div className="space-y-2 mt-2">
              {profile.tokens.slice(0, 3).map((token) => (
                <div key={token.mint} className="flex items-center gap-3">
                  <img
                    src={`${import.meta.env.VITE_API_URL ?? 'https://sentinel-api.apiworkersdev.workers.dev'}/v1/badge/${token.mint}`}
                    alt={`Sentinel badge for ${token.symbol}`}
                    className="h-5"
                  />
                  <span className="text-[10px] text-gray-600 font-mono">{token.symbol}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ReputationCard({ profile, wallet }: { profile: CreatorProfile; wallet: string }) {
  const [copied, setCopied] = useState(false);
  const shortWallet = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  const dashboardUrl = `https://sentinel-dashboard-3uy.pages.dev`;

  const tierColor = profile.reputationTier === 'safe' ? '#22c55e'
    : profile.reputationTier === 'caution' ? '#f59e0b'
    : profile.reputationTier === 'danger' ? '#ef4444'
    : '#dc2626';

  const tierEmoji = profile.reputationTier === 'safe' ? '✅'
    : profile.reputationTier === 'caution' ? '⚠️'
    : '🚨';

  const rugRate = profile.totalTokens > 0
    ? Math.round((profile.ruggedCount / profile.totalTokens) * 100)
    : 0;

  const twitterText = encodeURIComponent(
    `${tierEmoji} My creator reputation on @SentinelBags:\n\n` +
    `Score: ${profile.reputationScore}/100 — ${profile.reputationTier.toUpperCase()}\n` +
    `Tokens: ${profile.totalTokens} launched · ${profile.safeCount} safe · ${profile.ruggedCount} rugged\n` +
    `Rug rate: ${rugRate}%\n\n` +
    `Verified by Sentinel AI on Bags.fm\n${dashboardUrl}`
  );

  const copyText = async () => {
    const text =
      `${tierEmoji} Sentinel Creator Score: ${profile.reputationScore}/100 (${profile.reputationTier.toUpperCase()})\n` +
      `${profile.totalTokens} tokens · ${profile.safeCount} safe · ${rugRate}% rug rate\n` +
      `${dashboardUrl}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-sentinel-border/50 bg-sentinel-surface/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-sentinel-border/30 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Reputation Card</h3>
        <span className="text-[10px] text-gray-600">Share on socials</span>
      </div>

      {/* Card preview */}
      <div className="p-4">
        <div
          className="rounded-xl p-5 space-y-4"
          style={{ background: 'linear-gradient(135deg, #0a0e1a 0%, #0f1629 100%)', border: `1px solid ${tierColor}30` }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
                <path d="M16 3L4 8v8c0 6.627 5.148 12.347 12 13.93C22.852 28.347 28 22.627 28 16V8L16 3z" fill="rgba(6,182,212,0.15)" stroke="rgba(6,182,212,0.5)" strokeWidth="1.5"/>
                <circle cx="16" cy="16" r="4" fill="none" stroke="#06b6d4" strokeWidth="1.5"/>
                <circle cx="16" cy="16" r="1.5" fill="#06b6d4"/>
              </svg>
              <span className="text-xs font-bold text-sentinel-accent tracking-widest">SENTINEL</span>
            </div>
            <span className="text-[10px] text-gray-600 font-mono">{shortWallet}</span>
          </div>

          {/* Score */}
          <div className="flex items-center gap-4">
            <div>
              <div className="text-5xl font-black" style={{ color: tierColor }}>{profile.reputationScore}</div>
              <div className="text-xs font-bold uppercase tracking-widest mt-0.5" style={{ color: tierColor }}>
                {tierEmoji} {profile.reputationTier}
              </div>
            </div>
            <div className="flex-1 space-y-1.5">
              <div className="text-[10px] text-gray-500 flex justify-between">
                <span>Reputation</span>
                <span style={{ color: tierColor }}>{profile.reputationScore}%</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${profile.reputationScore}%`, background: tierColor }} />
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 pt-1">
            {[
              { label: 'Tokens', value: String(profile.totalTokens), color: '#94a3b8' },
              { label: 'Safe', value: String(profile.safeCount), color: '#22c55e' },
              { label: 'Rug rate', value: `${rugRate}%`, color: rugRate > 0 ? '#ef4444' : '#22c55e' },
            ].map(s => (
              <div key={s.label} className="text-center p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-sm font-bold" style={{ color: s.color }}>{s.value}</div>
                <div className="text-[9px] text-gray-600 uppercase tracking-wider mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="text-[9px] text-gray-700 text-center">Verified by Sentinel AI · bags.fm</div>
        </div>
      </div>

      {/* Share buttons */}
      <div className="px-4 pb-4 flex items-center gap-2">
        <a
          href={`https://twitter.com/intent/tweet?text=${twitterText}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-[#1DA1F2]/10 border border-[#1DA1F2]/20 text-[#1DA1F2] text-xs font-medium hover:bg-[#1DA1F2]/20 transition-all"
        >
          𝕏 Share on Twitter
        </a>
        <button
          onClick={copyText}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-sentinel-surface/40 border border-sentinel-border/50 text-gray-400 text-xs font-medium hover:text-white transition-all"
        >
          {copied ? '✓ Copied!' : '📋 Copy text'}
        </button>
        <a
          href={getCreatorCardUrl(wallet)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1 py-2 px-3 rounded-lg bg-sentinel-surface/40 border border-sentinel-border/50 text-gray-400 text-xs font-medium hover:text-white transition-all"
          title="Open SVG card"
        >
          🖼️ Card
        </a>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-3 rounded-lg border border-sentinel-border/50 bg-sentinel-surface/30 text-center">
      <p className={`text-lg font-bold ${color ?? 'text-white'}`}>{value}</p>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

function SignalChip({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  const borderClass = warn ? 'border-sentinel-danger/30 bg-sentinel-danger/5'
    : good ? 'border-sentinel-safe/30 bg-sentinel-safe/5'
    : 'border-sentinel-border/30 bg-sentinel-surface/30';
  const valueClass = warn ? 'text-sentinel-danger' : good ? 'text-sentinel-safe' : 'text-white';

  return (
    <div className={`p-2 rounded-lg border ${borderClass} text-center`}>
      <p className={`text-sm font-bold ${valueClass}`}>{value}</p>
      <p className="text-[9px] text-gray-500 uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}
