/**
 * Telegram Alert Subscriptions
 *
 * Allows users to subscribe their Telegram chat to Sentinel pre-rug alerts.
 * Subscriptions are stored in KV; notifications are sent during the cron cycle.
 *
 * KV keys:
 *  - `tg:sub:{chatId}`      — TelegramSubscription object. TTL 90d (refreshed on re-sub).
 *  - `tg:subs:index`        — string[] of chatIds. TTL 90d.
 *  - `tg:notified:{chatId}:{mint}` — dedup flag (sent = don't re-send). TTL 48h.
 */

import { sendTelegramMessage } from './telegram';

const SUB_TTL = 90 * 24 * 60 * 60;   // 90 days
const NOTIF_DEDUP_TTL = 48 * 60 * 60; // 48 hours
const INDEX_KEY = 'tg:subs:index';
const DASHBOARD_URL = 'https://sentinel-dashboard-3uy.pages.dev';

export interface TelegramSubscription {
  chatId: string;
  wallet?: string;          // optional: filter alerts to this wallet's tokens
  createdAt: number;
  updatedAt: number;
}

// ── Subscribe / Unsubscribe ──────────────────────────────

export async function subscribe(
  kv: KVNamespace,
  chatId: string,
  wallet?: string,
): Promise<void> {
  const sub: TelegramSubscription = {
    chatId,
    wallet: wallet?.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await kv.put(`tg:sub:${chatId}`, JSON.stringify(sub), { expirationTtl: SUB_TTL });

  // Update index
  const existing = ((await kv.get(INDEX_KEY, 'json')) as string[] | null) ?? [];
  if (!existing.includes(chatId)) {
    existing.push(chatId);
    await kv.put(INDEX_KEY, JSON.stringify(existing), { expirationTtl: SUB_TTL });
  }
}

export async function unsubscribe(kv: KVNamespace, chatId: string): Promise<void> {
  await kv.delete(`tg:sub:${chatId}`);
  const existing = ((await kv.get(INDEX_KEY, 'json')) as string[] | null) ?? [];
  const updated = existing.filter((id) => id !== chatId);
  await kv.put(INDEX_KEY, JSON.stringify(updated), { expirationTtl: SUB_TTL });
}

export async function getSubscription(
  kv: KVNamespace,
  chatId: string,
): Promise<TelegramSubscription | null> {
  return kv.get(`tg:sub:${chatId}`, 'json') as Promise<TelegramSubscription | null>;
}

export async function getSubscriberCount(kv: KVNamespace): Promise<number> {
  const index = ((await kv.get(INDEX_KEY, 'json')) as string[] | null) ?? [];
  return index.length;
}

// ── Broadcast catch to all subscribers ──────────────────

export interface CatchPayload {
  mint: string;
  symbol: string;
  name: string;
  initialScore: number;
  caughtScore: number;
  scoreDrop: number;
  tierTransition: string;
  initialAt: number;
  caughtAt: number;
  reason: string;
}

export function buildCatchMessage(c: CatchPayload): string {
  const leadMin = Math.round((c.caughtAt - c.initialAt) / 60_000);
  const short = `${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`;
  const tier = c.tierTransition.split('→')[1] ?? 'danger';
  const emoji = tier === 'rug' ? '🚨' : '⚠️';

  return [
    `${emoji} <b>SENTINEL ALERT: ${c.symbol} flagged</b>`,
    '',
    `🪙 <b>${c.name}</b> (<code>${short}</code>)`,
    `📉 Risk score: <b>${c.initialScore} → ${c.caughtScore}</b> (−${c.scoreDrop} pts)`,
    `🔀 Tier: <b>${c.tierTransition}</b>`,
    `⏱ Lead time: <b>${leadMin} min</b> before collapse`,
    `📊 Signal: ${c.reason === 'score_drop' ? 'Rapid score deterioration' : 'Tier crash detected'}`,
    '',
    `<a href="${DASHBOARD_URL}">🔍 View on Sentinel</a>`,
  ].join('\n');
}

/**
 * Notify all Telegram subscribers of a new pre-rug catch.
 * Deduplicates sends per (chatId, mint) over 48h.
 */
export async function notifySubscribersOfCatch(
  kv: KVNamespace,
  botToken: string,
  catchPayload: CatchPayload,
): Promise<void> {
  const index = ((await kv.get(INDEX_KEY, 'json')) as string[] | null) ?? [];
  if (index.length === 0) return;

  const message = buildCatchMessage(catchPayload);

  for (const chatId of index) {
    // Dedup: don't send same mint to same chat within 48h
    const dedupKey = `tg:notified:${chatId}:${catchPayload.mint}`;
    const alreadySent = await kv.get(dedupKey);
    if (alreadySent) continue;

    const sent = await sendTelegramMessage({ botToken, chatId, message });
    if (sent) {
      await kv.put(dedupKey, '1', { expirationTtl: NOTIF_DEDUP_TTL });
    }
  }
}
