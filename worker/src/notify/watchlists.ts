export interface TelegramWatchlist {
  chatId: string;
  mints: string[];
  updatedAt: number;
}

export interface WatchBaseline {
  mint: string;
  score: number;
  tier: string;
  capturedAt: number;
}

const WATCHLIST_TTL = 90 * 24 * 60 * 60; // 90 days
const BASELINE_TTL = 30 * 24 * 60 * 60; // 30 days
const WATCH_INDEX_KEY = 'tg:watch:index';

function watchlistKey(chatId: string): string {
  return `tg:watch:${chatId}`;
}

function baselineKey(chatId: string, mint: string): string {
  return `tg:watch:baseline:${chatId}:${mint}`;
}

function watchIndexEntryKey(chatId: string): string {
  return `tg:watch:active:${chatId}`;
}

export async function getWatchlist(kv: KVNamespace, chatId: string): Promise<TelegramWatchlist> {
  const existing = await kv.get<TelegramWatchlist>(watchlistKey(chatId), 'json').catch(() => null);
  if (existing?.chatId && Array.isArray(existing.mints)) {
    return {
      chatId: String(existing.chatId),
      mints: Array.from(new Set(existing.mints.map((m) => String(m)))).slice(0, 50),
      updatedAt: typeof existing.updatedAt === 'number' ? existing.updatedAt : Date.now(),
    };
  }
  return { chatId, mints: [], updatedAt: Date.now() };
}

export async function listWatchlistChatIds(kv: KVNamespace): Promise<string[]> {
  const index = await kv.get<string[]>(WATCH_INDEX_KEY, 'json').catch(() => null);
  return Array.isArray(index) ? index.map(String) : [];
}

async function ensureChatInIndex(kv: KVNamespace, chatId: string): Promise<void> {
  const existing = (await kv.get<string[]>(WATCH_INDEX_KEY, 'json').catch(() => null)) ?? [];
  const set = new Set(Array.isArray(existing) ? existing.map(String) : []);
  if (!set.has(chatId)) {
    set.add(chatId);
    await kv.put(WATCH_INDEX_KEY, JSON.stringify(Array.from(set)), { expirationTtl: WATCHLIST_TTL });
  } else {
    // refresh TTL
    kv.put(WATCH_INDEX_KEY, JSON.stringify(Array.from(set)), { expirationTtl: WATCHLIST_TTL }).catch(() => {});
  }
  // per-chat marker (for debugging / cleanup)
  kv.put(watchIndexEntryKey(chatId), '1', { expirationTtl: WATCHLIST_TTL }).catch(() => {});
}

async function maybeRemoveChatFromIndex(kv: KVNamespace, chatId: string): Promise<void> {
  const wl = await getWatchlist(kv, chatId);
  if (wl.mints.length > 0) return;
  const existing = (await kv.get<string[]>(WATCH_INDEX_KEY, 'json').catch(() => null)) ?? [];
  const next = (Array.isArray(existing) ? existing.map(String) : []).filter((id) => id !== chatId);
  await kv.put(WATCH_INDEX_KEY, JSON.stringify(next), { expirationTtl: WATCHLIST_TTL });
  await kv.delete(watchIndexEntryKey(chatId)).catch(() => {});
}

export async function addWatchMint(kv: KVNamespace, chatId: string, mint: string): Promise<TelegramWatchlist> {
  const wl = await getWatchlist(kv, chatId);
  const next = Array.from(new Set([...wl.mints, mint])).slice(0, 50);
  const updated: TelegramWatchlist = { chatId, mints: next, updatedAt: Date.now() };
  await kv.put(watchlistKey(chatId), JSON.stringify(updated), { expirationTtl: WATCHLIST_TTL });
  await ensureChatInIndex(kv, chatId);
  return updated;
}

export async function removeWatchMint(kv: KVNamespace, chatId: string, mint: string): Promise<TelegramWatchlist> {
  const wl = await getWatchlist(kv, chatId);
  const next = wl.mints.filter((m) => m !== mint);
  const updated: TelegramWatchlist = { chatId, mints: next, updatedAt: Date.now() };
  await kv.put(watchlistKey(chatId), JSON.stringify(updated), { expirationTtl: WATCHLIST_TTL });
  await kv.delete(baselineKey(chatId, mint)).catch(() => {});
  await maybeRemoveChatFromIndex(kv, chatId);
  return updated;
}

export async function getBaseline(
  kv: KVNamespace,
  chatId: string,
  mint: string,
): Promise<WatchBaseline | null> {
  const b = await kv.get<WatchBaseline>(baselineKey(chatId, mint), 'json').catch(() => null);
  if (!b || typeof b.score !== 'number' || typeof b.tier !== 'string') return null;
  return {
    mint,
    score: b.score,
    tier: b.tier,
    capturedAt: typeof b.capturedAt === 'number' ? b.capturedAt : Date.now(),
  };
}

export async function putBaseline(
  kv: KVNamespace,
  chatId: string,
  baseline: WatchBaseline,
): Promise<void> {
  await kv.put(baselineKey(chatId, baseline.mint), JSON.stringify(baseline), { expirationTtl: BASELINE_TTL });
}

export function formatDeltaLine(params: {
  mint: string;
  symbol?: string | null;
  prev?: WatchBaseline | null;
  nextScore: number;
  nextTier: string;
}): string {
  const short = `${params.mint.slice(0, 4)}…${params.mint.slice(-4)}`;
  const label = params.symbol ? params.symbol : short;
  if (!params.prev) {
    return `• <b>${label}</b>: <b>${params.nextScore}/100</b> (${String(params.nextTier).toUpperCase()})`;
  }
  const delta = params.nextScore - params.prev.score;
  const d = delta === 0 ? '0' : (delta > 0 ? `+${delta}` : String(delta));
  const tierArrow = params.prev.tier === params.nextTier ? String(params.nextTier).toUpperCase() : `${String(params.prev.tier).toUpperCase()} → ${String(params.nextTier).toUpperCase()}`;
  return `• <b>${label}</b>: <b>${params.prev.score} → ${params.nextScore}</b> (${d}) · <b>${tierArrow}</b>`;
}

