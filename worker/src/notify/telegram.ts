const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    date?: number;
    chat?: TelegramChat;
  };
  channel_post?: {
    date?: number;
    chat?: TelegramChat;
  };
}

export interface TelegramNotifyParams {
  botToken: string;
  chatId: string;
  message: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export interface ResolveTelegramChatParams {
  botToken: string;
  username?: string;
}

export async function resolveTelegramChatId(params: ResolveTelegramChatParams): Promise<string | null> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${params.botToken}/getUpdates`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Telegram getUpdates ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }

    const body = await res.json() as { ok?: boolean; result?: TelegramUpdate[] };
    if (!body.ok || !Array.isArray(body.result) || body.result.length === 0) {
      return null;
    }

    const normalizedUsername = params.username?.trim().replace(/^@/, '').toLowerCase();

    const candidates = body.result
      .map((u) => {
        const source = u.message ?? u.channel_post;
        const chat = source?.chat;
        return {
          updateId: u.update_id,
          date: source?.date ?? 0,
          chat,
        };
      })
      .filter((c) => c.chat && c.chat.type === 'private');

    if (candidates.length === 0) {
      return null;
    }

    const filtered = normalizedUsername
      ? candidates.filter((c) => (c.chat?.username ?? '').toLowerCase() === normalizedUsername)
      : candidates;

    if (filtered.length === 0) {
      return null;
    }

    filtered.sort((a, b) => {
      if (a.date !== b.date) return b.date - a.date;
      return b.updateId - a.updateId;
    });

    const chatId = filtered[0].chat?.id;
    if (chatId === undefined || chatId === null) return null;
    return String(chatId);
  } catch (err) {
    console.error('Telegram getUpdates error:', err);
    return null;
  }
}

export async function sendTelegramMessage(params: TelegramNotifyParams): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${params.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: params.chatId,
        text: params.message,
        parse_mode: params.parseMode ?? 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Telegram API ${res.status}: ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

export function buildLpDrainMessage(
  tokenSymbol: string,
  tokenName: string,
  mint: string,
  prevLiquidityUsd: number,
  currentLiquidityUsd: number,
  dropPct: number,
  severity: 'critical' | 'warning',
  dashboardUrl: string,
): string {
  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const header = severity === 'critical'
    ? `🚨 <b>RUG ALERT: ${tokenSymbol} LP DRAINING</b>`
    : `⚠️ <b>LP Drain Warning: ${tokenSymbol}</b>`;

  return [
    header,
    '',
    `🪙 Token: <b>${tokenName}</b> (<code>${short}</code>)`,
    `💧 Liquidity: <b>$${prevLiquidityUsd.toLocaleString()}</b> → <b>$${currentLiquidityUsd.toLocaleString()}</b>`,
    `📉 Drop: <b>-${dropPct.toFixed(1)}%</b> since last scan`,
    '',
    severity === 'critical'
      ? '🔴 <b>Exit window may be closing. Act fast.</b>'
      : '🟡 Monitor closely — potential early-stage drain.',
    '',
    `<a href="${dashboardUrl}">📊 View on Sentinel</a>`,
  ].join('\n');
}

export async function broadcastAlert(
  botToken: string,
  channelId: string,
  message: string,
): Promise<boolean> {
  return sendTelegramMessage({ botToken, chatId: channelId, message });
}

export function buildFeeAlertMessage(
  wallet: string,
  totalUsd: number,
  urgentUsd: number,
  criticalCount: number,
  positionCount: number,
  dashboardUrl: string,
  claimId?: string,
): string {
  const shortWallet = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

  let header: string;
  if (criticalCount > 0) {
    header = `🚨 <b>URGENT: ${criticalCount} token(s) at risk!</b>`;
  } else if (urgentUsd > 1) {
    header = `⚠️ <b>Unclaimed fees detected</b>`;
  } else {
    header = `💰 <b>Fee update</b>`;
  }

  const claimUrl = claimId
    ? `${dashboardUrl}?claim=${claimId}`
    : dashboardUrl;

  const lines = [
    header,
    '',
    `👛 Wallet: <code>${shortWallet}</code>`,
    `💵 Total unclaimed: <b>$${totalUsd.toFixed(2)}</b>`,
  ];

  if (urgentUsd > 0 && urgentUsd !== totalUsd) {
    lines.push(`🔴 Urgent (risky tokens): <b>$${urgentUsd.toFixed(2)}</b>`);
  }

  lines.push(
    `📊 ${positionCount} position(s)`,
    '',
    `<a href="${claimUrl}">⚡ Claim now on Sentinel</a>`,
  );

  if (claimId) {
    lines.push('', '<i>Link expires in 1 hour. Opens wallet → 1-click claim.</i>');
  }

  return lines.join('\n');
}

export function buildGuardianTokenMessage(params: {
  label?: string;
  tokenMint: string;
  riskScore: number;
  riskTier: string;
  previousScore?: number;
  dashboardUrl: string;
}): string {
  const shortMint = `${params.tokenMint.slice(0, 4)}…${params.tokenMint.slice(-4)}`;
  const lines = [
    '🛡️ <b>Community Guardian Alert</b>',
    '',
    params.label ? `🏷️ Watchlist: <b>${params.label}</b>` : null,
    `🪙 Token: <code>${shortMint}</code>`,
    `📉 Risk score: <b>${params.riskScore}/100</b> (${params.riskTier.toUpperCase()})`,
  ].filter(Boolean) as string[];

  if (typeof params.previousScore === 'number') {
    lines.push(`↘️ Previous score: <b>${params.previousScore}/100</b>`);
  }

  lines.push('', `<a href="${params.dashboardUrl}?risk=${params.tokenMint}">Open Sentinel risk view</a>`);
  return lines.join('\n');
}

export function buildGuardianCreatorMessage(params: {
  label?: string;
  creatorWallet: string;
  trustScore: number;
  previousScore?: number;
  dashboardUrl: string;
}): string {
  const shortWallet = `${params.creatorWallet.slice(0, 4)}…${params.creatorWallet.slice(-4)}`;
  const lines = [
    '🧠 <b>Creator Guardian Alert</b>',
    '',
    params.label ? `🏷️ Watchlist: <b>${params.label}</b>` : null,
    `👤 Creator: <code>${shortWallet}</code>`,
    `📉 Trust score: <b>${params.trustScore}/100</b>`,
  ].filter(Boolean) as string[];

  if (typeof params.previousScore === 'number') {
    lines.push(`↘️ Previous trust: <b>${params.previousScore}/100</b>`);
  }

  lines.push('', `<a href="${params.dashboardUrl}?creator=${params.creatorWallet}">Open Sentinel creator view</a>`);
  return lines.join('\n');
}
