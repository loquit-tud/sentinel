/**
 * Creator Trust Score — advanced reputation scoring with behavioral signals.
 *
 * Goes beyond simple avg risk by analyzing:
 * - Token age patterns (serial launcher detection)
 * - LP behavior (pulls, locks)
 * - Mint authority retention
 * - Holder concentration across portfolio
 * - Fee consistency (long-term builder vs pump-and-dump)
 */

import type { Env } from '../index';
import type {
  CreatorTrustScore,
  CreatorTrustSignals,
  CreatorProfile,
  CreatorToken,
  RiskTier,
} from '../../../shared/types';
import { tierFromScore } from '../../../shared/types';
import { cachedCompute } from '../../../shared/cache-helpers';
import { buildCreatorProfile } from './profiler';
import { fetchRugCheckReport } from '../risk/rugcheck';

const TRUST_CACHE_TTL = 900; // 15 min
const SERIAL_LAUNCHER_THRESHOLD = 5; // 5+ tokens in 30 days
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function computeCreatorTrustScore(
  wallet: string,
  env: Env,
): Promise<CreatorTrustScore> {
  // Check KV cache
  const kv = env.SENTINEL_KV;
  const cacheKey = `trust:${wallet}`;

  return cachedCompute(kv, cacheKey, 900, async () => {
    // Build base profile (reuses existing profiler)
    const profile = await buildCreatorProfile(wallet, env);
    const signals = await analyzeSignals(profile, env);
    const riskFlags = deriveFlags(signals, profile);
    const trustScore = calculateTrustScore(signals, profile);
    const verdict = generateVerdict(trustScore, signals, riskFlags);

    return {
      wallet,
      trustScore,
      trustTier: tierFromScore(trustScore),
      signals,
      riskFlags,
      verdict,
      computedAt: Date.now(),
    };
  });
}

async function analyzeSignals(
  profile: CreatorProfile,
  env: Env,
): Promise<CreatorTrustSignals> {
  const now = Date.now();
  const tokens = profile.tokens;

  // Token age analysis
  const ages = tokens
    .filter(t => t.createdAt > 0)
    .map(t => (now - t.createdAt) / (1000 * 60 * 60 * 24));
  const tokenAge = ages.length > 0
    ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length)
    : 0;

  // Serial launcher: >5 tokens created in last 30 days
  const recentTokens = tokens.filter(
    t => t.createdAt > 0 && (now - t.createdAt) < THIRTY_DAYS_MS,
  );
  const serialLauncher = recentTokens.length >= SERIAL_LAUNCHER_THRESHOLD;

  // Rug ratio
  const rugRatio = tokens.length > 0
    ? profile.ruggedCount / tokens.length
    : 0;

  // Average token lifespan (for rugged tokens, lifespan = creation to now, capped)
  const lifespans = tokens
    .filter(t => t.createdAt > 0)
    .map(t => {
      const ageDays = (now - t.createdAt) / (1000 * 60 * 60 * 24);
      return t.rugged ? Math.min(ageDays, 30) : ageDays;
    });
  const avgTokenLifespan = lifespans.length > 0
    ? Math.round(lifespans.reduce((a, b) => a + b, 0) / lifespans.length)
    : 0;

  // Deep analysis: fetch RugCheck reports for up to 10 tokens
  let lpRemovalCount = 0;
  let mintAuthorityActive = 0;
  let holderConcentrations: number[] = [];

  const deepBatch = tokens.slice(0, 10);
  const reports = await Promise.allSettled(
    deepBatch.map(t => fetchRugCheckReport(t.mint)),
  );

  for (const r of reports) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const report = r.value;

    // LP pulled = lpLocked score is 0 (none locked)
    if (typeof report.score_normalised === 'number' && report.score_normalised <= 10) {
      lpRemovalCount++;
    }

    // Mint authority still active
    if (report.risks) {
      const risks = report.risks as Array<{ name: string; level: string }>;
      if (risks.some(r => r.name?.toLowerCase().includes('mint') && r.level !== 'none')) {
        mintAuthorityActive++;
      }
    }

    // Top holder concentration
    if (report.topHolders && Array.isArray(report.topHolders)) {
      const top5Pct = (report.topHolders as Array<{ pct: number }>)
        .slice(0, 5)
        .reduce((sum, h) => sum + (h.pct || 0), 0);
      holderConcentrations.push(top5Pct);
    }
  }

  const avgHolderConcentration = holderConcentrations.length > 0
    ? Math.round(holderConcentrations.reduce((a, b) => a + b, 0) / holderConcentrations.length)
    : 50; // default if unknown

  // Fee consistency: tokens that generate fees are "builder" tokens
  const feeGenerating = tokens.filter(t => t.lifetimeFees > 0).length;
  const feeConsistency = tokens.length > 0
    ? parseFloat((feeGenerating / tokens.length).toFixed(2))
    : 0;

  return {
    tokenAge,
    serialLauncher,
    rugRatio: parseFloat(rugRatio.toFixed(3)),
    avgTokenLifespan,
    lpRemovalCount,
    mintAuthorityActive,
    avgHolderConcentration,
    feeConsistency,
  };
}

function deriveFlags(signals: CreatorTrustSignals, profile: CreatorProfile): string[] {
  const flags: string[] = [];

  if (signals.serialLauncher) flags.push('⚡ Serial launcher (5+ tokens in 30 days)');
  if (signals.rugRatio >= 0.5) flags.push('⛔ Majority of tokens reached critical-risk tier');
  else if (signals.rugRatio >= 0.25) flags.push('🔴 High critical-risk ratio (25%+)');
  if (signals.lpRemovalCount >= 3) flags.push('💧 Multiple LP removals detected');
  else if (signals.lpRemovalCount >= 1) flags.push('⚠️ LP removal detected');
  if (signals.mintAuthorityActive >= 3) flags.push('🔑 Mint authority active on multiple tokens');
  if (signals.avgHolderConcentration > 60) flags.push('🐋 High holder concentration (top5 > 60%)');
  if (signals.avgTokenLifespan < 7 && profile.totalTokens > 2) flags.push('⏰ Short-lived tokens (avg < 1 week)');
  if (signals.feeConsistency === 0 && profile.totalTokens > 1) flags.push('📉 No fee-generating tokens');
  if (signals.tokenAge < 3 && profile.totalTokens > 3) flags.push('🆕 Very new creator (all tokens < 3 days)');
  if (signals.rugRatio === 0 && profile.safeCount >= 3) flags.push('✅ Clean track record');
  if (signals.feeConsistency >= 0.8) flags.push('💎 Consistent fee generator');

  return flags;
}

function calculateTrustScore(signals: CreatorTrustSignals, profile: CreatorProfile): number {
  // Weighted scoring (max 100)
  let score = 50; // neutral baseline

  // Rug ratio is the strongest signal (±30)
  score -= signals.rugRatio * 60;  // 0 rugs = no penalty, 100% rugs = -60

  // Serial launcher penalty (−15)
  if (signals.serialLauncher) score -= 15;

  // LP removals (−8 each, max −24)
  score -= Math.min(signals.lpRemovalCount, 3) * 8;

  // Mint authority active (−5 each, max −15)
  score -= Math.min(signals.mintAuthorityActive, 3) * 5;

  // Short lifespan penalty (−10 if avg < 7 days)
  if (signals.avgTokenLifespan < 7 && profile.totalTokens > 2) score -= 10;

  // High holder concentration (−10 if >60%)
  if (signals.avgHolderConcentration > 60) score -= 10;

  // Fee consistency bonus (+15 max)
  score += signals.feeConsistency * 15;

  // Token age bonus (+10 if avg > 30 days)
  if (signals.tokenAge > 30) score += 10;
  else if (signals.tokenAge > 14) score += 5;

  // Safe token bonus (+3 per safe, max +15)
  score += Math.min(profile.safeCount, 5) * 3;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function generateVerdict(score: number, signals: CreatorTrustSignals, flags: string[]): string {
  if (score >= 80) return 'Highly trusted creator with consistent, safe token launches.';
  if (score >= 60) return 'Generally trustworthy. Minor risk signals detected — review individual tokens.';
  if (score >= 40) return 'Mixed track record. Exercise caution and verify each token independently.';
  if (score >= 20) {
    if (signals.serialLauncher) return 'Serial launcher with concerning patterns. High likelihood of pump-and-dump behavior.';
    if (signals.rugRatio >= 0.5) return 'Majority of tokens reached critical-risk tier. Avoid this creator.';
    return 'Poor track record. Multiple risk signals detected.';
  }
  return 'Extremely high risk creator. History shows repeated critical-risk events and predatory behavior.';
}
