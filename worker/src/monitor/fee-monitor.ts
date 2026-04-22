import type { MonitoredWallet } from '../../../shared/types';
import { fetchSmartFees } from '../fees/smart-fees';
import { computeRiskScore } from '../risk/engine';
import { computeCreatorTrustScore } from '../creator/trust-score';
import { sendTelegramMessage, buildFeeAlertMessage, buildGuardianTokenMessage, buildGuardianCreatorMessage } from '../notify/telegram';
import { prepareClaim } from '../claims/pending-claims';

const DASHBOARD_URL = 'https://sentinel-dashboard-3uy.pages.dev';
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between notifications
const KV_PREFIX = 'monitor:';

interface MonitorEnv {
  SENTINEL_KV?: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  HELIUS_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  BAGS_API_KEY?: string;
}

function safeParseWallet(raw: string | null): MonitoredWallet | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MonitoredWallet;
  } catch {
    return null;
  }
}

/** Get all registered monitored wallets from KV */
async function getMonitoredWallets(kv: KVNamespace): Promise<MonitoredWallet[]> {
  const list = await kv.list({ prefix: KV_PREFIX });
  const wallets: MonitoredWallet[] = [];

  for (const key of list.keys) {
    const raw = await kv.get(key.name);
    const data = safeParseWallet(raw);
    if (data) wallets.push(data);
  }

  return wallets;
}

/** Register a wallet for monitoring */
export async function registerWallet(
  wallet: string,
  telegramChatId: string | undefined,
  thresholdUsd: number,
  options: {
    label?: string;
    watchedTokenMints?: string[];
    watchedCreatorWallets?: string[];
  } | undefined,
  kv: KVNamespace,
): Promise<MonitoredWallet> {
  const existingRaw = await kv.get(`${KV_PREFIX}${wallet}`);
  const existing = safeParseWallet(existingRaw);

  const nextChatId = telegramChatId ?? existing?.telegramChatId;
  const nextThreshold = thresholdUsd;

  // Skip write if config is unchanged to preserve KV daily write quota.
  if (
    existing &&
    existing.wallet === wallet &&
    existing.telegramChatId === nextChatId &&
    existing.autoClaimThresholdUsd === nextThreshold &&
    existing.label === options?.label &&
    JSON.stringify(existing.watchedTokenMints ?? []) === JSON.stringify(options?.watchedTokenMints ?? []) &&
    JSON.stringify(existing.watchedCreatorWallets ?? []) === JSON.stringify(options?.watchedCreatorWallets ?? [])
  ) {
    return existing;
  }

  const entry: MonitoredWallet = {
    wallet,
    telegramChatId: nextChatId,
    autoClaimThresholdUsd: nextThreshold,
    registeredAt: existing?.registeredAt ?? Date.now(),
    lastNotifiedAt: existing?.lastNotifiedAt ?? 0,
    lastClaimableUsd: existing?.lastClaimableUsd ?? 0,
    label: options?.label,
    watchedTokenMints: options?.watchedTokenMints ?? existing?.watchedTokenMints ?? [],
    watchedCreatorWallets: options?.watchedCreatorWallets ?? existing?.watchedCreatorWallets ?? [],
    lastTokenScores: existing?.lastTokenScores ?? {},
    lastCreatorTrustScores: existing?.lastCreatorTrustScores ?? {},
  };

  try {
    await kv.put(`${KV_PREFIX}${wallet}`, JSON.stringify(entry), {
      expirationTtl: 86400 * 30, // 30 days
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('limit exceeded')) {
      throw new Error('KV_QUOTA_EXCEEDED');
    }
    throw err;
  }

  return entry;
}

/** Unregister a wallet */
export async function unregisterWallet(wallet: string, kv: KVNamespace): Promise<void> {
  await kv.delete(`${KV_PREFIX}${wallet}`);
}

/** Cron job: scan all monitored wallets and send alerts */
export async function runFeeMonitorScan(env: MonitorEnv): Promise<{
  scannedWallets: number;
  notificationsSent: number;
}> {
  const kv = env.SENTINEL_KV;
  if (!kv) return { scannedWallets: 0, notificationsSent: 0 };

  const wallets = await getMonitoredWallets(kv);
  if (wallets.length === 0) return { scannedWallets: 0, notificationsSent: 0 };

  let notificationsSent = 0;
  const now = Date.now();

  for (const entry of wallets) {
    try {
      const prevLastClaimable = entry.lastClaimableUsd;
      const prevLastNotified = entry.lastNotifiedAt;

      // Fetch smart fees (with risk enrichment)
      const snapshot = await fetchSmartFees(entry.wallet, env);

      // Update stored amount
      entry.lastClaimableUsd = snapshot.totalClaimableUsd;

      // Check if notification is warranted
      const shouldNotify =
        snapshot.totalClaimableUsd >= entry.autoClaimThresholdUsd &&
        snapshot.totalClaimableUsd > 0 &&
        (now - entry.lastNotifiedAt) > NOTIFY_COOLDOWN_MS;

      // Urgent override: skip cooldown for critical alerts
      const urgentOverride =
        snapshot.criticalCount > 0 &&
        snapshot.urgentClaimableUsd > 0.5 &&
        (now - entry.lastNotifiedAt) > 10 * 60 * 1000; // 10 min cooldown for urgent

      if ((shouldNotify || urgentOverride) && entry.telegramChatId && env.TELEGRAM_BOT_TOKEN) {
        // Create a pending claim so the deep link opens a ready-to-sign page
        let claimId: string | undefined;
        if (kv && snapshot.positions.length > 0) {
          try {
            const pending = await prepareClaim(
              entry.wallet,
              snapshot.positions,
              snapshot.totalClaimableUsd,
              snapshot.urgentClaimableUsd,
              snapshot.criticalCount,
              kv,
            );
            claimId = pending.id;
          } catch {
            // Non-critical: send notification without deep link
          }
        }

        const message = buildFeeAlertMessage(
          entry.wallet,
          snapshot.totalClaimableUsd,
          snapshot.urgentClaimableUsd,
          snapshot.criticalCount,
          snapshot.positions.length,
          DASHBOARD_URL,
          claimId,
        );

        const sent = await sendTelegramMessage({
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: entry.telegramChatId,
          message,
        });

        if (sent) {
          entry.lastNotifiedAt = now;
          notificationsSent++;
        }
      }

      // Persist only when state changed to reduce KV write pressure.
      const changed =
        entry.lastClaimableUsd !== prevLastClaimable ||
        entry.lastNotifiedAt !== prevLastNotified;

      if (changed) {
        await kv.put(`${KV_PREFIX}${entry.wallet}`, JSON.stringify(entry), {
          expirationTtl: 86400 * 30,
        });
      }

      const watchedTokens = entry.watchedTokenMints ?? [];
      for (const mint of watchedTokens) {
        if (!mint) continue;
        const risk = await computeRiskScore(mint, env as Parameters<typeof computeRiskScore>[1]);
        const previousScore = entry.lastTokenScores?.[mint];
        const tokenChanged = typeof previousScore === 'number' ? previousScore - risk.score >= 20 : false;
        const tokenCritical = risk.tier === 'danger' || risk.tier === 'rug';

        if ((tokenCritical || tokenChanged) && entry.telegramChatId && env.TELEGRAM_BOT_TOKEN) {
          const sent = await sendTelegramMessage({
            botToken: env.TELEGRAM_BOT_TOKEN,
            chatId: entry.telegramChatId,
            message: buildGuardianTokenMessage({
              label: entry.label,
              tokenMint: mint,
              riskScore: risk.score,
              riskTier: risk.tier,
              previousScore,
              dashboardUrl: DASHBOARD_URL,
            }),
          });
          if (sent) notificationsSent++;
        }

        entry.lastTokenScores = {
          ...(entry.lastTokenScores ?? {}),
          [mint]: risk.score,
        };
      }

      const watchedCreators = entry.watchedCreatorWallets ?? [];
      for (const creatorWallet of watchedCreators) {
        if (!creatorWallet) continue;
        const trust = await computeCreatorTrustScore(creatorWallet, env as Parameters<typeof computeCreatorTrustScore>[1]);
        const previousScore = entry.lastCreatorTrustScores?.[creatorWallet];
        const creatorChanged = typeof previousScore === 'number' ? previousScore - trust.trustScore >= 15 : false;
        const creatorCritical = trust.trustScore < 40;

        if ((creatorCritical || creatorChanged) && entry.telegramChatId && env.TELEGRAM_BOT_TOKEN) {
          const sent = await sendTelegramMessage({
            botToken: env.TELEGRAM_BOT_TOKEN,
            chatId: entry.telegramChatId,
            message: buildGuardianCreatorMessage({
              label: entry.label,
              creatorWallet,
              trustScore: trust.trustScore,
              previousScore,
              dashboardUrl: DASHBOARD_URL,
            }),
          });
          if (sent) notificationsSent++;
        }

        entry.lastCreatorTrustScores = {
          ...(entry.lastCreatorTrustScores ?? {}),
          [creatorWallet]: trust.trustScore,
        };
      }

      if (watchedTokens.length > 0 || watchedCreators.length > 0) {
        await kv.put(`${KV_PREFIX}${entry.wallet}`, JSON.stringify(entry), {
          expirationTtl: 86400 * 30,
        });
      }
    } catch (err) {
      console.error(`Fee monitor error for ${entry.wallet}:`, err);
    }
  }

  return { scannedWallets: wallets.length, notificationsSent };
}
