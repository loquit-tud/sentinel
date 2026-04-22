import { useState } from 'react';
import { runStressTest } from '../api';
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
    <div className={`rounded-xl border p-4 ${triggered ? 'border-red-500/40 bg-red-500/5' : 'border-white/10 bg-white/5'}`}>
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
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Launch Survival Engine</h1>
        <p className="text-slate-400 text-sm leading-relaxed">
          Enter your pre-launch parameters. Sentinel analyzes structural exploit surfaces using
          deterministic attacker models — not simulation, not guessing.
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4 bg-white/5 border border-white/10 rounded-2xl p-6">
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
          className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold transition-colors disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : 'Run Exploit Surface Analysis'}
        </button>
      </form>

      {/* Results */}
      {result && labelCfg && (
        <div className="space-y-4">
          <div className={`rounded-2xl border ${labelCfg.border} ${labelCfg.bg} p-6 flex items-center gap-6`}>
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
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 text-sm text-orange-300">
              <span className="font-semibold">Primary vulnerability: </span>
              {result.scenarios[result.worstScenario].name} —{' '}
              severity {Math.round(result.scenarios[result.worstScenario].severity)}/100
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
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
      />
    </label>
  );
}
