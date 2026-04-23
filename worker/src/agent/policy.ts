/**
 * Sentinel Agent Policy Engine
 *
 * This is the decision layer — the LLM (or heuristic fallback) decides WHAT TO DO,
 * not just what to say. It operates between scoring and action, and can choose:
 *
 *   monitor       — continue normal 15-min scan cycle
 *   rescan_soon   — reschedule token for faster re-check (2–5 min)
 *   log_alert     — record catch but suppress broadcast (low confidence / borderline)
 *   telegram_alert — broadcast to Telegram channel (high-confidence rug signal)
 *   escalate      — maximum urgency: active collapse in progress
 *
 * Input: score delta + context + agent memory → policy decision
 * Output: AgentPolicyDecision { action, alertLevel, confidence, reasoning, dynamicRescanMs }
 *
 * The LLM participates in DECISION POLICY, not just prose generation.
 * If LLM is unavailable, a calibrated heuristic fallback is used.
 */

import type { AgentAction, AgentPolicyDecision, AgentPolicyInput } from '../../../shared/types';

interface PolicyEnv {
  AI?: Ai;
}

const POLICY_PROMPT = `You are Sentinel's autonomous decision engine for Solana token risk on Bags.fm.

Given risk context, choose the appropriate action. Consider the full context, not just the score.

Actions (choose exactly one):
- "monitor": no immediate concern, normal 15-min cycle continues
- "rescan_soon": early warning signs detected, reschedule to 2-3 min
- "log_alert": risk threshold crossed but evidence is mixed — record internally, do NOT broadcast
- "telegram_alert": strong rug/dump signal, broadcast to traders immediately
- "escalate": active collapse in progress — maximum urgency, immediate broadcast

Rules:
- Only escalate if collapse/active exit is in progress (phase === collapse or score < 10)
- Only telegram_alert if score drop ≥ 20 AND tier reached danger/rug AND confidence ≥ 70
- Use log_alert if signals conflict or confidence is low (avoid noise)
- Use rescan_soon if trend is deteriorating but hasn't crossed thresholds yet
- Suppress (log_alert) if this creator has NO prior rug history and signals are marginal

Respond in JSON with exactly 3 fields:
- "action": one of the 5 actions above
- "confidence": 0-100 (how confident in this decision)
- "reasoning": 1 sentence — what made you choose this action

Be decisive. Lean toward log_alert over false telegram_alerts. Lean toward escalate only on real collapse.`;

function buildPolicyContext(input: AgentPolicyInput): string {
  const { score, scoreDrop, tierTransition, breakdown, phase, trend,
          creatorPrevRug, memory, prevScore } = input;

  const signals: string[] = [];
  if (scoreDrop >= 40) signals.push(`large score drop: −${scoreDrop} pts`);
  else if (scoreDrop >= 20) signals.push(`moderate score drop: −${scoreDrop} pts`);
  if (breakdown.honeypot < 30) signals.push('honeypot risk confirmed');
  if (breakdown.lpLocked < 30) signals.push('LP unlocked — drain possible');
  if (breakdown.mintAuthority < 50) signals.push('mint authority active');
  if (breakdown.topHolderPct < 30) signals.push(`extreme whale concentration`);
  if (breakdown.creatorReputation === 0) signals.push('creator linked to prior rugs');
  if (phase === 'collapse') signals.push('ACTIVE COLLAPSE in progress');
  if (phase === 'distribution') signals.push('smart money exiting now');
  if (phase === 'manipulation') signals.push('engineered movement detected');

  const trendStr = trend ? ` (trend: ${trend})` : '';
  const memoryStr = memory && memory.snapshots.length >= 2
    ? `\nAgent memory: ${memory.lastReasoning} — ${memory.snapshots.length} snapshots on record`
    : '\nAgent memory: first observation, no history';

  return `
Token risk context:
- Current score: ${score}/100 (tier: ${tierTransition ? tierTransition.split('→')[1]?.trim() ?? 'unknown' : 'unknown'})
- Previous score: ${prevScore ?? 'unknown'} → drop: ${scoreDrop} pts
- Tier transition: ${tierTransition ?? 'none'}
- Phase: ${phase ?? 'uncertain'}${trendStr}
- Creator repeat offender: ${creatorPrevRug ? 'YES — prior rug history' : 'no prior history'}
- Key signals: ${signals.length > 0 ? signals.join(', ') : 'no critical signals'}
- Liquidity depth score: ${breakdown.liquidityDepth}/100
- Volume health: ${breakdown.volumeHealth}/100${memoryStr}`;
}

/** Parse LLM JSON output safely */
function parsePolicyOutput(raw: string): { action: AgentAction; confidence: number; reasoning: string } | null {
  try {
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const validActions: AgentAction[] = ['monitor', 'rescan_soon', 'log_alert', 'telegram_alert', 'escalate'];
    if (!validActions.includes(parsed.action)) return null;
    return {
      action: parsed.action as AgentAction,
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 60)),
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };
  } catch {
    return null;
  }
}

/** Heuristic policy fallback — calibrated rules that avoid false positives */
function heuristicPolicy(input: AgentPolicyInput): { action: AgentAction; confidence: number; reasoning: string } {
  const { score, scoreDrop, breakdown, phase, trend, creatorPrevRug } = input;

  // Active collapse — escalate immediately
  if (phase === 'collapse' || score < 10) {
    return {
      action: 'escalate',
      confidence: 91,
      reasoning: 'Active collapse in progress — immediate broadcast required.',
    };
  }

  // Strong multi-signal rug pattern
  const criticalSignals = [
    breakdown.honeypot < 20,
    breakdown.lpLocked < 20,
    score < 15,
    scoreDrop >= 40,
    creatorPrevRug,
    phase === 'distribution',
  ].filter(Boolean).length;

  if (criticalSignals >= 3 && scoreDrop >= 25) {
    return {
      action: 'telegram_alert',
      confidence: Math.min(88, 60 + criticalSignals * 8),
      reasoning: `${criticalSignals} aligned critical signals — high-confidence rug pattern.`,
    };
  }

  // Tier crash to danger with moderate evidence
  if (scoreDrop >= 20 && score < 40) {
    if (creatorPrevRug || breakdown.lpLocked < 30 || breakdown.honeypot < 40) {
      return {
        action: 'telegram_alert',
        confidence: 72,
        reasoning: 'Score crossed danger threshold with corroborating risk signals.',
      };
    }
    return {
      action: 'log_alert',
      confidence: 65,
      reasoning: 'Score dropped significantly but signals are mixed — logging without broadcast.',
    };
  }

  // Deteriorating trend — rescan soon
  if (trend === 'dying' || trend === 'distributing' || phase === 'distribution') {
    return {
      action: 'rescan_soon',
      confidence: 70,
      reasoning: 'Deteriorating trend detected — shortening scan interval to 3 min.',
    };
  }

  // Marginal catch — suppress noise
  if (scoreDrop >= 15 && score < 50) {
    return {
      action: 'log_alert',
      confidence: 58,
      reasoning: 'Borderline risk signal — logging internally, insufficient for broadcast.',
    };
  }

  return {
    action: 'monitor',
    confidence: 85,
    reasoning: 'No critical signals — continuing normal monitoring cycle.',
  };
}

/** Main policy computation — LLM first, heuristic fallback */
export async function computeAgentPolicy(
  input: AgentPolicyInput,
  env: PolicyEnv
): Promise<AgentPolicyDecision> {
  const heuristic = heuristicPolicy(input);

  // Try LLM only for non-trivial situations (saves compute for clear cases)
  const isTrivialSafe = input.score >= 70 && input.scoreDrop < 15;
  const isTrivialCollapse = input.phase === 'collapse' || input.score < 10;

  let llmResult: { action: AgentAction; confidence: number; reasoning: string } | null = null;

  if (!isTrivialSafe && !isTrivialCollapse && env.AI) {
    try {
      const context = buildPolicyContext(input);
      const messages = [
        { role: 'system' as const, content: POLICY_PROMPT },
        { role: 'user' as const, content: context },
      ];
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages, max_tokens: 120 });
      const raw = typeof result === 'object' && 'response' in result
        ? String((result as { response: string }).response)
        : typeof result === 'string' ? result : '';
      llmResult = parsePolicyOutput(raw);
    } catch {
      // LLM unavailable — use heuristic (expected in dev/test)
    }
  }

  // Use LLM result if valid and confidence is high enough; otherwise heuristic
  const chosen = (llmResult && llmResult.confidence >= 55) ? llmResult : heuristic;
  const usedLlm = chosen === llmResult;

  // Dynamic rescan: if action is rescan_soon or escalate, shorten interval
  let dynamicRescanMs: number | undefined;
  if (chosen.action === 'rescan_soon') dynamicRescanMs = 3 * 60 * 1000;   // 3 min
  if (chosen.action === 'escalate')    dynamicRescanMs = 1 * 60 * 1000;   // 1 min

  // Alert level derived from action
  const alertLevel: AgentPolicyDecision['alertLevel'] =
    chosen.action === 'escalate'       ? 'critical' :
    chosen.action === 'telegram_alert' ? 'high'     :
    chosen.action === 'log_alert'      ? 'medium'   :
    chosen.action === 'rescan_soon'    ? 'low'      :
    'none';

  return {
    action: chosen.action,
    alertLevel,
    confidence: chosen.confidence,
    reasoning: chosen.reasoning,
    dynamicRescanMs,
    decidedBy: usedLlm ? 'llm' : 'heuristic',
    decidedAt: Date.now(),
  };
}
