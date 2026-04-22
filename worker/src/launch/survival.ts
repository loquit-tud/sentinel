/**
 * Launch Survival Engine — Deterministic Exploit Surface Analyzer
 *
 * Takes pre-launch token parameters and outputs a survival score +
 * failure modes across 3 known exploit patterns:
 *   1. Sniper Attack (first-block front-running)
 *   2. Coordinated Dump (whale accumulation + coordinated exit)
 *   3. Wash Trading Loop (fake volume → real exit)
 *
 * This is NOT a simulation engine. It is a rule-based structural
 * vulnerability classifier using deterministic thresholds derived
 * from observed Solana launch exploit patterns.
 */

export interface SurvivalInput {
  /** Initial liquidity in USD */
  liquidity: number;
  /** LP lock duration in hours (0 = unlocked) */
  lpLockHours: number;
  /** Dev wallet percentage of total supply (0–100) */
  devWalletPct: number;
  /** Expected initial unique holder count at launch */
  holderCount: number;
  /** Top holder concentration percentage (0–100, lower = safer) */
  topHolderPct: number;
  /** Optional: volume in USD (required for wash trading check) */
  volume?: number;
  /** Optional: total buy + sell trades (required for wash trading check) */
  totalTrades?: number;
}

export interface AttackScenario {
  name: string;
  triggered: boolean;
  severity: number; // 0–100
  explanation: string;
}

export interface SurvivalResult {
  survivalScore: number; // 0–100 (higher = safer)
  survivalLabel: 'Safe' | 'Vulnerable' | 'High Risk' | 'Critical';
  scenarios: {
    sniper: AttackScenario;
    dump: AttackScenario;
    wash: AttackScenario;
  };
  worstScenario: 'sniper' | 'dump' | 'wash' | null;
  recommendation: string;
}

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function computeSniper(input: SurvivalInput): AttackScenario {
  const { liquidity, lpLockHours, devWalletPct, holderCount } = input;
  const lpLocked = lpLockHours >= 24;

  const triggered =
    liquidity < 50_000 &&
    holderCount < 80 &&
    devWalletPct >= 5 &&
    !lpLocked;

  const severity = clamp(
    (1 - liquidity / 100_000) * 40 +
    Math.max(0, 80 - holderCount) * 0.3 +
    devWalletPct * 3 +
    (lpLocked ? 0 : 20),
  );

  return {
    name: 'Sniper Attack',
    triggered,
    severity: triggered ? severity : Math.min(severity, 30),
    explanation:
      'Low liquidity and concentrated early holders allow fast entry-exit price distortion in the first 60 seconds after launch.',
  };
}

function computeDump(input: SurvivalInput): AttackScenario {
  const { liquidity, devWalletPct, holderCount, topHolderPct } = input;

  const triggered =
    devWalletPct >= 10 &&
    topHolderPct >= 25 &&
    liquidity >= 30_000;

  const severity = clamp(
    devWalletPct * 2 +
    topHolderPct * 1.5 +
    Math.min(liquidity / 200_000, 1) * 30 +
    (holderCount < 200 ? 20 : 0),
  );

  return {
    name: 'Coordinated Dump',
    triggered,
    severity: triggered ? severity : Math.min(severity, 25),
    explanation:
      'High insider concentration combined with sufficient liquidity creates conditions where coordinated holders can exit together without immediate collapse detection.',
  };
}

function computeWash(input: SurvivalInput): AttackScenario {
  const { liquidity, holderCount, volume, totalTrades } = input;

  // If volume/trades not provided, we can't fully assess — partial score only
  if (volume === undefined || totalTrades === undefined) {
    return {
      name: 'Wash Trading Loop',
      triggered: false,
      severity: 0,
      explanation:
        'Insufficient data — provide expected 24h volume and trade count to assess wash trading risk.',
    };
  }

  const tradeIntensity = totalTrades / Math.max(holderCount, 1);
  const volumeToLiquidity = volume / Math.max(liquidity, 1);

  const triggered =
    tradeIntensity > 3 &&
    volumeToLiquidity > 1.5 &&
    holderCount < 150;

  const severity = clamp(
    tradeIntensity * 15 +
    volumeToLiquidity * 20 +
    Math.max(0, 150 - holderCount) * 0.2,
  );

  return {
    name: 'Wash Trading Loop',
    triggered,
    severity: triggered ? severity : Math.min(severity, 20),
    explanation:
      'Abnormally high trading activity relative to unique holders suggests artificial volume generation that can mislead early buyers before liquidity exits.',
  };
}

function labelFromScore(score: number): SurvivalResult['survivalLabel'] {
  if (score >= 75) return 'Safe';
  if (score >= 50) return 'Vulnerable';
  if (score >= 25) return 'High Risk';
  return 'Critical';
}

function buildRecommendation(
  sniper: AttackScenario,
  dump: AttackScenario,
  wash: AttackScenario,
  input: SurvivalInput,
): string {
  const tips: string[] = [];

  if (sniper.triggered) {
    if (input.liquidity < 50_000) tips.push('increase initial liquidity above $50K');
    if (input.lpLockHours < 24) tips.push('lock LP for at least 24 hours');
    if (input.holderCount < 80) tips.push('distribute to more wallets before launch');
  }
  if (dump.triggered) {
    if (input.devWalletPct >= 10) tips.push(`reduce dev allocation below 10% (currently ${input.devWalletPct}%)`);
    if (input.topHolderPct >= 25) tips.push(`reduce top holder concentration below 25% (currently ${input.topHolderPct}%)`);
  }
  if (wash.triggered) {
    tips.push('monitor trade intensity in the first hour and set volume alerts');
  }

  if (tips.length === 0) return 'Launch parameters look structurally sound. Monitor early trading closely.';
  return 'To improve survival: ' + tips.join('; ') + '.';
}

export function computeSurvival(input: SurvivalInput): SurvivalResult {
  const sniper = computeSniper(input);
  const dump = computeDump(input);
  const wash = computeWash(input);

  const maxSeverity = Math.max(sniper.severity, dump.severity, wash.severity);
  const survivalScore = clamp(100 - maxSeverity);

  let worstScenario: SurvivalResult['worstScenario'] = null;
  if (maxSeverity > 0) {
    if (sniper.severity >= dump.severity && sniper.severity >= wash.severity) worstScenario = 'sniper';
    else if (dump.severity >= wash.severity) worstScenario = 'dump';
    else worstScenario = 'wash';
  }

  return {
    survivalScore,
    survivalLabel: labelFromScore(survivalScore),
    scenarios: { sniper, dump, wash },
    worstScenario,
    recommendation: buildRecommendation(sniper, dump, wash, input),
  };
}
