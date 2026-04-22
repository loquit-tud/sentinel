import { useState, useEffect, useCallback } from 'react';
import type { RiskScore, RiskBreakdown, TokenPhase } from '../../../shared/types';
import { ScoreGauge, TierBadge, BreakdownBar } from '../components/RiskDisplay';
import { fetchRiskScore, getShareCardUrl, buildTweetUrl, getSharePageUrl } from '../api';

const BREAKDOWN_LABELS: Record<keyof RiskBreakdown, { label: string; icon: string }> = {
  honeypot: { label: 'Honeypot Safety', icon: '🍯' },
  lpLocked: { label: 'LP Locked', icon: '🔒' },
  mintAuthority: { label: 'Mint Revoked', icon: '🏭' },
  freezeAuthority: { label: 'Freeze Revoked', icon: '❄️' },
  topHolderPct: { label: 'Holder Distribution', icon: '👥' },
  liquidityDepth: { label: 'Liquidity Depth', icon: '💧' },
  volumeHealth: { label: 'Volume Health', icon: '📊' },
  creatorReputation: { label: 'Creator Rep', icon: '⭐' },
};

const TIER_DESCRIPTIONS: Record<string, { title: string; desc: string }> = {
  safe: { title: 'Looks Safe', desc: 'Strong safety signals across the board. Standard caution still applies.' },
  caution: { title: 'Proceed with Caution', desc: 'Some risk factors detected. Do your own research before trading.' },
  danger: { title: 'High Risk', desc: 'Multiple red flags identified. Significant chance of loss.' },
  rug: { title: 'Likely Scam', desc: 'Critical risk indicators. Extremely high probability of rug pull.' },
};

const PHASE_CONFIG: Partial<Record<TokenPhase, { label: string; color: string; bg: string; border: string; icon: string; description: string }>> = {
  accumulation: {
    label: 'Accumulation',
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/25',
    icon: '🎯',
    description: 'Quiet positioning detected — potential pre-move setup. Buy pressure balanced, liquidity stable.',
  },
  manipulation: {
    label: 'Manipulation',
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/25',
    icon: '⚡',
    description: 'Few wallets controlling price movement. Low trader diversity with high price impact.',
  },
  distribution: {
    label: 'Distribution',
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/25',
    icon: '📤',
    description: 'Smart money exiting into retail liquidity. Sell pressure exceeds buy pressure.',
  },
  collapse: {
    label: 'Collapse',
    color: 'text-red-400',
    bg: 'bg-red-600/10',
    border: 'border-red-600/30',
    icon: '💀',
    description: 'Active exit event. Liquidity draining rapidly. Avoid.',
  },
  uncertain: {
    label: 'Uncertain',
    color: 'text-gray-400',
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/20',
    icon: '❓',
    description: 'Insufficient signal data for confident classification.',
  },
};

function PumpIntelligenceCard({ signal }: { signal: NonNullable<RiskScore['pumpSignal']> }) {
  const phase = PHASE_CONFIG[signal.phase] ?? PHASE_CONFIG.uncertain!;

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-xl p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">⚡ Pump Intelligence</h3>
        <span className="text-[10px] text-gray-600">confidence {signal.confidence}%</span>
      </div>

      {/* Phase banner */}
      <div className={`flex items-center gap-3 p-3 rounded-lg border mb-5 ${phase.bg} ${phase.border}`}>
        <span className="text-xl">{phase.icon}</span>
        <div>
          <p className={`text-sm font-bold ${phase.color}`}>{phase.label} Phase</p>
          <p className="text-xs text-gray-400 mt-0.5">{phase.description}</p>
        </div>
        <div className={`ml-auto text-2xl font-mono font-bold ${phase.color}`}>{signal.pumpScore}</div>
      </div>

      {/* Reasoning */}
      <p className="text-xs text-gray-400 leading-relaxed mb-5 italic">"{signal.reasoning}"</p>

      {/* Sub-scores */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Momentum',      value: signal.breakdown.momentumScore,     desc: 'Is it already moving?' },
          { label: 'Fragility',     value: signal.breakdown.fragilityScore,    desc: 'Is it pumpable?' },
          { label: 'Coordination',  value: signal.breakdown.coordinationScore, desc: 'Organic or engineered?' },
        ].map(({ label, value, desc }) => (
          <div key={label} className="bg-black/20 rounded-lg p-3 text-center">
            <p className="text-lg font-mono font-bold text-white">{value}</p>
            <p className="text-[10px] font-semibold text-gray-300 mt-0.5">{label}</p>
            <p className="text-[9px] text-gray-600 mt-0.5">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RiskDetailPage({ mint, onBack, connectedWallet }: { mint: string; onBack: () => void; connectedWallet?: string | null }) {
  const [score, setScore] = useState<RiskScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const scan = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRiskScore(mint, connectedWallet)
      .then(setScore)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mint, connectedWallet]);

  useEffect(() => { scan(); }, [scan]);

  const copyMint = () => {
    navigator.clipboard.writeText(mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const shortMint = `${mint.slice(0, 6)}...${mint.slice(-4)}`;

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Navigation bar */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-sm group"
        >
          <span className="inline-block transition-transform group-hover:-translate-x-0.5">←</span>
          Feed
        </button>
        <button
          onClick={copyMint}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 bg-sentinel-surface px-2.5 py-1 rounded-md border border-sentinel-border/50 hover:border-sentinel-border transition-all"
          title="Copy mint address"
        >
          <code className="truncate max-w-[140px] sm:max-w-none">{shortMint}</code>
          <span className="text-[10px]">{copied ? '✓' : '⧉'}</span>
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center py-20 space-y-4 animate-fade-in">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 border-4 border-sentinel-accent/10 rounded-full" />
            <div className="absolute inset-0 border-4 border-transparent border-t-sentinel-accent rounded-full animate-spin" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-gray-300 text-sm font-medium">Scanning token…</p>
            <p className="text-gray-600 text-xs">Checking RugCheck, Birdeye, Helius</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-sentinel-danger/5 border border-sentinel-danger/20 rounded-xl p-6 text-center space-y-3 animate-fade-in">
          <div className="text-3xl">⚠️</div>
          <p className="text-sentinel-danger font-semibold">Scan failed</p>
          <p className="text-gray-400 text-sm max-w-sm mx-auto">{error}</p>
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              onClick={scan}
              className="text-sm font-medium bg-sentinel-accent/10 text-sentinel-accent hover:bg-sentinel-accent/20 px-4 py-1.5 rounded-md transition-colors"
            >
              Retry scan
            </button>
            <button
              onClick={onBack}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              Go back
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {score && !loading && (
        <div className="space-y-5 animate-fade-in">
          {/* Score hero card */}
          <div className="bg-sentinel-surface border border-sentinel-border rounded-xl p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <ScoreGauge score={score.score} tier={score.tier} size={150} />
              <div className="flex-1 text-center sm:text-left space-y-3">
                <div className="flex items-center gap-2 justify-center sm:justify-start">
                  <TierBadge tier={score.tier} />
                  {score.cached && (
                    <span className="text-[10px] text-gray-600 bg-sentinel-border/50 px-1.5 py-0.5 rounded">cached</span>
                  )}
                </div>
                <div>
                  <p className="text-white font-semibold">{TIER_DESCRIPTIONS[score.tier].title}</p>
                  <p className="text-gray-400 text-sm mt-0.5">{TIER_DESCRIPTIONS[score.tier].desc}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Share bar */}
          <div className="bg-sentinel-surface border border-sentinel-border/60 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Share this score:</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={buildTweetUrl(mint, score.score, score.tier, '')}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#1d9bf0]/10 text-[#1d9bf0] hover:bg-[#1d9bf0]/20 border border-[#1d9bf0]/20 transition-all"
              >
                𝕏 Tweet
              </a>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(getSharePageUrl(mint));
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2000);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 border border-sentinel-border/50 transition-all"
              >
                {linkCopied ? '✓ Copied!' : '🔗 Copy Link'}
              </button>
              <a
                href={getShareCardUrl(mint)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 border border-sentinel-border/50 transition-all"
              >
                🖼️ Card
              </a>
            </div>
          </div>

          {/* Breakdown card */}
          <div className="bg-sentinel-surface border border-sentinel-border rounded-xl p-6">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">Risk Breakdown</h3>
            <div className="space-y-4">
              {(Object.keys(BREAKDOWN_LABELS) as (keyof RiskBreakdown)[]).map((key, i) => (
                <div key={String(key)} className="animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                  <BreakdownBar
                    label={`${BREAKDOWN_LABELS[key].icon} ${BREAKDOWN_LABELS[key].label}`}
                    value={score.breakdown[key]}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Pump Intelligence card */}
          {score.pumpSignal && <PumpIntelligenceCard signal={score.pumpSignal} />}

          {/* Footer info */}
          <div className="flex items-center justify-between text-xs text-gray-600 px-1">
            <span>Scored {new Date(score.timestamp).toLocaleString()}</span>
            <button
              onClick={scan}
              className="text-sentinel-accent/60 hover:text-sentinel-accent transition-colors"
            >
              ↻ Rescan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
