import type { FeeClaimerEntry } from './launch';
import type { Env } from '../index';
import type { LaunchGuardIssue, LaunchGuardRecommendation, LaunchGuardResult } from '../../../shared/types';
import { computeCreatorTrustScore } from '../creator/trust-score';
import { simulateFeeShare } from '../fees/simulator';

interface LaunchGuardInput {
  launchWallet: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  feeClaimers: FeeClaimerEntry[];
}

function pushIssue(list: LaunchGuardIssue[], severity: LaunchGuardIssue['severity'], title: string, detail: string) {
  list.push({ severity, title, detail });
}

function pushRecommendation(list: LaunchGuardRecommendation[], label: string, action: string) {
  list.push({ label, action });
}

export async function evaluateLaunchGuard(input: LaunchGuardInput, env: Env): Promise<LaunchGuardResult> {
  const creatorTrust = await computeCreatorTrustScore(input.launchWallet, env);
  const issues: LaunchGuardIssue[] = [];
  const recommendations: LaunchGuardRecommendation[] = [];

  const uniqueRecipients = new Set(input.feeClaimers.map((entry) => entry.user)).size;
  const topRecipientBps = input.feeClaimers.reduce((max, entry) => Math.max(max, entry.userBps), 0);
  const topRecipientPct = topRecipientBps / 100;

  let metadataScore = 50;
  if (input.description.trim().length >= 80) metadataScore += 20;
  else pushIssue(issues, 'warning', 'Thin description', 'Token description is short. Add a clearer utility and risk disclosure.');
  if (input.website?.trim()) metadataScore += 10; else pushRecommendation(recommendations, 'Add website', 'Link a landing page or docs to improve launch credibility.');
  if (input.twitter?.trim()) metadataScore += 10; else pushRecommendation(recommendations, 'Add X profile', 'A public X account helps judges and users verify the project quickly.');
  if (input.telegram?.trim()) metadataScore += 10; else pushRecommendation(recommendations, 'Add Telegram', 'Community contact channel makes the launch feel alive and supportable.');
  metadataScore = Math.min(100, metadataScore);

  let feeConfigScore = 100;
  if (topRecipientPct > 70) {
    feeConfigScore -= 35;
    pushIssue(issues, 'critical', 'Over-concentrated fee split', `Top recipient controls ${topRecipientPct.toFixed(1)}% of fees.`);
    pushRecommendation(recommendations, 'Diversify fee shares', 'Keep the largest recipient under 60% and reserve budget for growth or community incentives.');
  } else if (topRecipientPct > 50) {
    feeConfigScore -= 20;
    pushIssue(issues, 'warning', 'Single recipient dominance', `Top recipient controls ${topRecipientPct.toFixed(1)}% of fees.`);
  } else {
    pushIssue(issues, 'positive', 'Balanced fee config', `Largest recipient controls ${topRecipientPct.toFixed(1)}% of fees.`);
  }

  if (uniqueRecipients < 2) {
    feeConfigScore -= 15;
    pushIssue(issues, 'warning', 'Single-recipient config', 'All fee shares go to one wallet. Judges will read this as weak ecosystem alignment.');
  } else {
    pushIssue(issues, 'positive', 'Multi-wallet alignment', `${uniqueRecipients} wallets participate in the fee split.`);
  }

  const simulated = simulateFeeShare({
    expectedDailyVolumeUsd: 25_000,
    feeRateBps: 100,
    allocations: input.feeClaimers.map((entry, index) => ({
      label: index === 0 ? 'Primary recipient' : `Recipient ${index + 1}`,
      bps: entry.userBps,
    })),
  });

  if (creatorTrust.trustScore < 40) {
    pushIssue(issues, 'critical', 'Weak creator trust', `Creator trust is ${creatorTrust.trustScore}/100 with tier ${creatorTrust.trustTier.toUpperCase()}.`);
    pushRecommendation(recommendations, 'Strengthen trust before launch', 'Delay launch or improve public proof, docs, and fee structure before going live.');
  } else if (creatorTrust.trustScore < 60) {
    pushIssue(issues, 'warning', 'Mixed creator reputation', `Creator trust is ${creatorTrust.trustScore}/100. The launch should ship with strong trust messaging.`);
  } else {
    pushIssue(issues, 'positive', 'Creator trust baseline', `Creator trust is ${creatorTrust.trustScore}/100.`);
  }

  const readinessScore = Math.max(0, Math.min(100, Math.round(
    creatorTrust.trustScore * 0.45 +
    feeConfigScore * 0.35 +
    metadataScore * 0.20,
  )));

  const verdict = readinessScore >= 75 ? 'ready' : readinessScore >= 50 ? 'review' : 'blocked';

  return {
    launchWallet: input.launchWallet,
    readinessScore,
    verdict,
    creatorTrustScore: creatorTrust.trustScore,
    creatorTrustTier: creatorTrust.trustTier,
    feeConfigScore,
    metadataScore,
    topRecipientPct,
    uniqueRecipients,
    issues,
    recommendations,
    simulatedDailyFeesUsd: simulated.dailyFeesUsd,
    simulatedMonthlyFeesUsd: simulated.monthlyFeesUsd,
    generatedAt: Date.now(),
  };
}