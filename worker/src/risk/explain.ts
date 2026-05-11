/**
 * Sentinel AI Analyst — generates human-readable risk explanations
 * using Cloudflare Workers AI (llama-3.1-8b-instruct, free, no API key needed).
 *
 * Input:  RiskScore breakdown + token metadata
 * Output: { why, pattern, action, confidence }
 */

import type { RiskScore } from '../../../shared/types';

export interface RiskExplanation {
  why: string;        // "Why this token is risky right now"
  pattern: string;    // "Behavioral pattern detected"
  action: string;     // "Suggested action for a trader"
  confidence: 'high' | 'medium' | 'low';
  generatedAt: number;
}

interface AiEnv {
  AI?: Ai;
}

function scoreLabel(s: number): string {
  if (s >= 80) return 'very strong';
  if (s >= 60) return 'acceptable';
  if (s >= 40) return 'weak';
  if (s >= 20) return 'very weak';
  return 'critical failure';
}

function buildPrompt(score: RiskScore, tokenName?: string): string {
  const b = score.breakdown;
  const name = tokenName || score.mint.slice(0, 8) + '…';
  const tier = score.tier.toUpperCase();

  const signals = [
    `- Honeypot protection: ${scoreLabel(b.honeypot)} (${b.honeypot}/100)`,
    `- LP lock: ${scoreLabel(b.lpLocked)} (${b.lpLocked}/100)`,
    `- Mint authority revoked: ${scoreLabel(b.mintAuthority)} (${b.mintAuthority}/100)`,
    `- Freeze authority revoked: ${scoreLabel(b.freezeAuthority)} (${b.freezeAuthority}/100)`,
    `- Top holder concentration: ${scoreLabel(b.topHolderPct)} (${b.topHolderPct}/100)`,
    `- Liquidity depth: ${scoreLabel(b.liquidityDepth)} (${b.liquidityDepth}/100)`,
    `- Volume health: ${scoreLabel(b.volumeHealth)} (${b.volumeHealth}/100)`,
    `- Creator reputation: ${scoreLabel(b.creatorReputation)} (${b.creatorReputation}/100)`,
  ].join('\n');

  const pump = score.pumpSignal
    ? `\nBehavioral signals:\n- Pump score: ${score.pumpSignal.pumpScore}/100\n- Phase: ${score.pumpSignal.phase}\n- Confidence: ${score.pumpSignal.confidence}/100`
    : '';

  return `You are Sentinel, an AI risk analyst for Bags.fm (Solana token launchpad).

Analyze this token and respond in JSON with exactly these 4 fields:
- "why": 1-2 sentences explaining WHY the token is risky or safe RIGHT NOW based on the signals
- "pattern": 1 sentence naming the behavioral pattern (e.g. "Early-stage rug setup", "Healthy accumulation", "Whale exit in progress")
- "action": 1 sentence of actionable advice for a trader (e.g. "Avoid until LP is locked", "Safe to trade with normal caution", "Exit position — high dump probability")
- "confidence": one of "high", "medium", or "low" depending on signal quality

Token: ${name}
Overall risk score: ${score.score}/100 (tier: ${tier})

Signal breakdown (higher = safer):
${signals}${pump}

Respond ONLY with valid JSON, no extra text.`;
}

function parseConfidence(score: RiskScore): RiskExplanation['confidence'] {
  // Confidence is high if we have good data coverage (non-50 defaults)
  const b = score.breakdown;
  const defaults = [b.honeypot, b.lpLocked, b.mintAuthority, b.freezeAuthority]
    .filter((v) => v === 50).length;
  if (defaults >= 3) return 'low';
  if (defaults >= 1) return 'medium';
  return 'high';
}

export async function generateRiskExplanation(
  score: RiskScore,
  env: AiEnv,
  tokenName?: string,
): Promise<RiskExplanation> {
  const fallback = buildFallback(score, tokenName);

  if (!env.AI) return fallback;

  try {
    const prompt = buildPrompt(score, tokenName);

    const result = await (env.AI as any).run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are Sentinel AI Analyst. Always respond with valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    const text: string = result?.response ?? result?.choices?.[0]?.message?.content ?? '';

    // Extract JSON from response (model sometimes wraps in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      why: String(parsed.why || fallback.why).slice(0, 300),
      pattern: String(parsed.pattern || fallback.pattern).slice(0, 150),
      action: String(parsed.action || fallback.action).slice(0, 200),
      confidence: (['high', 'medium', 'low'].includes(parsed.confidence)
        ? parsed.confidence
        : parseConfidence(score)) as RiskExplanation['confidence'],
      generatedAt: Date.now(),
    };
  } catch {
    return fallback;
  }
}

/** Rule-based fallback when AI is unavailable */
function buildFallback(score: RiskScore, tokenName?: string): RiskExplanation {
  const b = score.breakdown;
  const name = tokenName || 'This token';
  const confidence = parseConfidence(score);

  if (score.tier === 'rug') {
    return {
      why: `${name} has been flagged as a critical-risk token — honeypot or critical security failure detected.`,
      pattern: 'Confirmed critical-risk or honeypot pattern',
      action: 'Do not interact with this token under any circumstances.',
      confidence: 'high',
      generatedAt: Date.now(),
    };
  }

  const weakest: string[] = [];
  if (b.lpLocked < 40) weakest.push('unlocked LP');
  if (b.mintAuthority < 40) weakest.push('active mint authority');
  if (b.topHolderPct < 40) weakest.push('high holder concentration');
  if (b.creatorReputation < 40) weakest.push('low creator reputation');
  if (b.liquidityDepth < 40) weakest.push('thin liquidity');

  if (score.tier === 'danger') {
    const issues = weakest.length > 0 ? weakest.join(', ') : 'multiple risk factors';
    return {
      why: `${name} scores ${score.score}/100 due to ${issues}, indicating high probability of loss.`,
      pattern: weakest.includes('active mint authority') ? 'Mint risk — creator can inflate supply' :
               weakest.includes('unlocked LP') ? 'Liquidity critical risk — LP can be removed' :
               'Multiple compounding risk factors',
      action: 'Avoid trading. Wait for LP lock and mint authority revocation.',
      confidence,
      generatedAt: Date.now(),
    };
  }

  if (score.tier === 'caution') {
    const issues = weakest.length > 0 ? weakest.join(', ') : 'some risk signals';
    return {
      why: `${name} shows caution signals: ${issues}. Not critically dangerous but requires attention.`,
      pattern: 'Early-stage or partially secured token',
      action: 'Trade with reduced position size. Monitor for LP lock and authority revocation.',
      confidence,
      generatedAt: Date.now(),
    };
  }

  // safe
  return {
    why: `${name} passes all major security checks with a score of ${score.score}/100. No critical risks detected.`,
    pattern: 'Secured token — standard Bags listing',
    action: 'Safe to trade with normal caution. Monitor volume for unusual activity.',
    confidence,
    generatedAt: Date.now(),
  };
}
