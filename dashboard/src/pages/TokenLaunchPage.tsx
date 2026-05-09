import { useState } from 'react';
import { SENTINEL_API_ORIGIN, runStressTest } from '../api';
import type { SurvivalResult, AttackScenario } from '../api';

// ── Helpers ───────────────────────────────────────────────

const LABEL_CONFIG: Record<SurvivalResult['survivalLabel'], { color: string; bg: string; border: string }> = {
  Safe:       { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  Vulnerable: { color: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30' },
  'High Risk':{ color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30' },
  Critical:   { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30' },
};

const SCENARIO_ICON: Record<string, string> = {
  'Sniper Attack':       '🎯',
  'Coordinated Dump':    '🐋',
  'Wash Trading Loop':   '🔄',
};

function ScenarioCard({ scenario }: { scenario: AttackScenario }) {
  const triggered = scenario.triggered;
  const sev = scenario.severity;
  const sevColor = sev >= 70 ? 'text-red-400' : sev >= 40 ? 'text-orange-400' : sev >= 20 ? 'text-yellow-400' : 'text-emerald-400';
  const barColor = sev >= 70 ? 'bg-red-500' : sev >= 40 ? 'bg-orange-500' : sev >= 20 ? 'bg-yellow-500' : 'bg-emerald-500';

  return (
    <div
      className={`rounded-2xl border p-4 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.03)] ${
        triggered
          ? 'border-red-500/35 bg-red-500/5'
          : 'border-white/[0.08] bg-slate-950/25'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-sm text-white">
          {SCENARIO_ICON[scenario.name] ?? '⚠️'} {scenario.name}
        </span>
        <div className="flex items-center gap-2">
          {triggered && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
              TRIGGERED
            </span>
          )}
          <span className={`text-sm font-bold ${sevColor}`}>{Math.round(sev)}/100</span>
        </div>
      </div>

      {/* Severity bar */}
      <div className="h-1.5 w-full bg-white/10 rounded-full mb-3">
        <div
          className={`h-1.5 rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${sev}%` }}
        />
      </div>

      <p className="text-xs text-slate-400 leading-relaxed">{scenario.explanation}</p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

interface FormState {
  liquidity: string;
  lpLockHours: string;
  devWalletPct: string;
  holderCount: string;
  topHolderPct: string;
  volume: string;
  totalTrades: string;
}

const DEFAULT_FORM: FormState = {
  liquidity:    '',
  lpLockHours:  '',
  devWalletPct: '',
  holderCount:  '',
  topHolderPct: '',
  volume:       '',
  totalTrades:  '',
};

export function TokenLaunchPage() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [result, setResult] = useState<SurvivalResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(prev => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const liquidity    = Number(form.liquidity);
    const lpLockHours  = Number(form.lpLockHours);
    const devWalletPct = Number(form.devWalletPct);
    const holderCount  = Number(form.holderCount);
    const topHolderPct = Number(form.topHolderPct);

    if ([liquidity, lpLockHours, devWalletPct, holderCount, topHolderPct].some(isNaN)) {
      setError('Please fill in all required fields with valid numbers.');
      return;
    }

    setLoading(true);
    try {
      const res = await runStressTest({
        liquidity,
        lpLockHours,
        devWalletPct,
        holderCount,
        topHolderPct,
        volume:      form.volume      ? Number(form.volume)      : undefined,
        totalTrades: form.totalTrades ? Number(form.totalTrades) : undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const labelCfg = result ? LABEL_CONFIG[result.survivalLabel] : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="rounded-2xl border border-white/[0.08] bg-slate-950/35 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.03)] p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Launch</div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Survival check</h1>
            <p className="text-slate-400 text-sm leading-relaxed mt-1">
              Stress-test launch parameters with deterministic scenario models. This is structural analysis — not a market prediction.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-start sm:justify-end">
            <a
              href={`${SENTINEL_API_ORIGIN}/v1/demo`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-xl border border-slate-800/70 bg-slate-950/30 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-slate-700 hover:bg-slate-900/40 transition-colors"
            >
              Proof viewer <span className="ml-1 font-mono text-slate-400">/v1/demo</span> ↗
            </a>
            <a
              href="https://github.com/loquit-tud/sentinel/blob/master/EVIDENCE.md"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition-colors"
            >
              Methodology <span className="ml-1 font-mono text-cyan-300/80">EVIDENCE.md</span> ↗
            </a>
          </div>
        </div>
        <p className="text-[11px] text-slate-600 mt-3">
          API: <span className="font-mono text-slate-500">POST {SENTINEL_API_ORIGIN}/v1/launch/stress-test</span>
        </p>
      </div>

      {/* Form */}
      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-2xl border border-white/[0.08] bg-slate-950/25 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.03)] p-6"
      >
        <div className="grid grid-cols-2 gap-4">
          <InputField label="Initial Liquidity (USD)" placeholder="e.g. 25000" value={form.liquidity} onChange={set('liquidity')} required />
          <InputField label="LP Lock Duration (hours)" placeholder="e.g. 24" value={form.lpLockHours} onChange={set('lpLockHours')} required />
          <InputField label="Dev Wallet % of Supply" placeholder="e.g. 15" value={form.devWalletPct} onChange={set('devWalletPct')} required />
          <InputField label="Initial Holder Count" placeholder="e.g. 50" value={form.holderCount} onChange={set('holderCount')} required />
          <InputField label="Top Holder Concentration %" placeholder="e.g. 30" value={form.topHolderPct} onChange={set('topHolderPct')} required />
        </div>

        <details className="group">
          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 transition-colors">
            + Advanced (wash trading analysis)
          </summary>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <InputField label="Expected 24h Volume (USD)" placeholder="optional" value={form.volume} onChange={set('volume')} />
            <InputField label="Expected Total Trades" placeholder="optional" value={form.totalTrades} onChange={set('totalTrades')} />
          </div>
        </details>

        {error && (
          <p className="text-red-400 text-sm">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-400 hover:from-cyan-400 hover:to-cyan-300 text-slate-950 font-bold transition-colors disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : 'Run exploit-surface analysis'}
        </button>
      </form>

      {/* Results */}
      {result && labelCfg && (
        <div className="space-y-4">
          <div className={`rounded-2xl border ${labelCfg.border} ${labelCfg.bg} p-6 flex flex-col sm:flex-row items-start sm:items-center gap-6 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.03)]`}>
            <div className="text-center">
              <div className={`text-5xl font-black ${labelCfg.color}`}>{result.survivalScore}</div>
              <div className="text-xs text-slate-400 mt-1">Survival Score</div>
            </div>
            <div>
              <div className={`text-xl font-bold ${labelCfg.color} mb-1`}>{result.survivalLabel}</div>
              <p className="text-sm text-slate-300 leading-relaxed">{result.recommendation}</p>
            </div>
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Exploit Surface Breakdown</h2>
            <ScenarioCard scenario={result.scenarios.sniper} />
            <ScenarioCard scenario={result.scenarios.dump} />
            <ScenarioCard scenario={result.scenarios.wash} />
          </div>

          {result.worstScenario && (
            <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4 text-sm text-orange-200 backdrop-blur-md">
              <span className="font-semibold">Primary modeled risk surface: </span>
              {result.scenarios[result.worstScenario].name} —{' '}
              severity {Math.round(result.scenarios[result.worstScenario].severity)}/100
              <div className="text-[11px] text-orange-200/70 mt-2">
                Illustrative severity from the scenario rubric — not a guarantee of how markets behave.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reusable input ────────────────────────────────────────

function InputField({
  label, placeholder, value, onChange, required,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 mb-1 block">{label}{required && <span className="text-red-400 ml-0.5">*</span>}</span>
      <input
        type="number"
        min="0"
        step="any"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        className="w-full bg-slate-950/35 border border-white/[0.10] rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 shadow-[0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-md focus:outline-none focus:border-cyan-500/45 focus:ring-2 focus:ring-cyan-500/15 transition-colors"
      />
    </label>
  );
}
