/**
 * DBC Pool Monitor — direct on-chain liquidity drain detection for PRE_GRAD Bags tokens.
 *
 * WHY THIS EXISTS:
 *   - PRE_GRAD tokens have no RugCheck report yet (404), no Birdeye/Helius price/holder data.
 *   - The risk engine returns score ~47 default for ALL of them → no movement → no catches.
 *   - But these tokens DO have real SOL locked in their bonding curve pool's WSOL vault.
 *   - When a creator drains the pool (rug), the WSOL token-account balance drops sharply.
 *
 * KEY INSIGHT (validated April 2026):
 *   - `dbcPoolKey` is the Meteora DBC pool DATA account; its lamports are just rent-exempt (~0.0038 SOL).
 *   - Real SOL liquidity sits in a WSOL token-account (mint = So111…) listed in `accountKeys[]` of the launch tx.
 *   - On first sight, we resolve `dbc:vault:${mint}` by scanning accountKeys via getMultipleAccounts(jsonParsed)
 *     and picking the entry whose parsed.info.mint === WSOL_MINT.
 *
 * MECHANISM:
 *   1. For each PRE_GRAD token in the batch, look up cached WSOL vault address in `dbc:vault:${mint}`.
 *   2. If missing, scan accountKeys (jsonParsed batch) → find WSOL token-account → cache forever.
 *   3. Fetch fresh lamports for all known vaults via `getMultipleAccounts` (base64 batched).
 *      Vault lamports = rent (2_039_280) + WSOL amount in lamports → SOL liquidity = lamports - 2_039_280.
 *   4. Snapshot `dbc:bal:${mint}` to KV (TTL 7d).
 *   5. If new SOL balance drops ≥DRAIN_PCT_THRESHOLD vs previous AND previous was ≥MIN_PREV_SOL → record catch.
 *
 * STORAGE:
 *   - `dbc:vault:${mint}` — string (vault address). TTL 30d, refreshed on use.
 *   - `dbc:bal:${mint}`   — { vault, lamports, sol, ts, dbcPoolKey, symbol }. TTL 7d.
 *
 * Note: Helius RPC is preferred (rate-limit headroom). Falls back to public mainnet-beta if no key.
 */

import type { TokenFeedItem } from '../../../shared/types';
import { HELIUS_RPC_BASE } from '../../../shared/constants';
import type { PreRugCatch } from './pre-rug-catcher';
import { recordCatchEvidence } from './catch-evidence';

const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280; // standard SPL token-account rent
const VAULT_TTL = 30 * 24 * 60 * 60;
const SNAP_TTL = 7 * 24 * 60 * 60;
const CATCH_TTL = 30 * 24 * 60 * 60;
const INDEX_KEY = 'watch:catches:index';
const STATS_KEY = 'watch:stats';
const MAX_INDEX_LEN = 100;

const MIN_LEAD_TIME_MS = 10 * 60 * 1000; // baseline must be ≥10min old
const DRAIN_PCT_THRESHOLD = 70;          // ≥70% balance drop = catch (was 50; sub-70% looks like organic sells)
const MIN_PREV_SOL = 1.0;                // require ≥1 SOL initial liquidity (was 0.5; sub-1 SOL pools are noise)
const RPC_BATCH_SIZE = 100;              // getMultipleAccounts limit

interface DbcBalanceSnapshot {
  mint: string;
  symbol: string;
  name: string;
  dbcPoolKey: string;
  vault: string;
  lamports: number;  // raw vault lamports (= rent + WSOL amount)
  sol: number;       // effective SOL liquidity = (lamports - rent) / 1e9
  ts: number;
}

interface MultiAccountRespBase64 {
  result?: {
    value: Array<{ lamports: number; data: [string, 'base64'] } | null>;
  };
  error?: { message: string };
}

interface ParsedTokenAccountValue {
  lamports: number;
  owner: string;
  data: {
    parsed?: {
      type: 'account';
      info: {
        mint: string;
        owner: string;
        tokenAmount: { amount: string; decimals: number; uiAmount: number };
      };
    };
    program?: string;
  };
}

interface MultiAccountRespParsed {
  result?: {
    value: Array<ParsedTokenAccountValue | null>;
  };
  error?: { message: string };
}

export interface DbcMonitorEnv {
  SENTINEL_KV?: KVNamespace;
  HELIUS_API_KEY?: string;
}

function rpcUrl(heliusKey: string | undefined): string {
  return heliusKey ? `${HELIUS_RPC_BASE}/?api-key=${heliusKey}` : PUBLIC_SOLANA_RPC;
}

/**
 * Fetch raw lamports for an array of accounts in batches (base64 encoding — cheap).
 * Returns map: address → lamports (null if account missing).
 */
async function fetchAccountLamports(
  accounts: string[],
  heliusKey: string | undefined,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (accounts.length === 0) return result;
  const url = rpcUrl(heliusKey);

  for (let i = 0; i < accounts.length; i += RPC_BATCH_SIZE) {
    const chunk = accounts.slice(i, i + RPC_BATCH_SIZE);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `dbc-bal-${i}`,
          method: 'getMultipleAccounts',
          params: [chunk, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.error(`[dbc-monitor] balances RPC ${res.status}`);
        continue;
      }
      const body = (await res.json()) as MultiAccountRespBase64;
      if (body.error) {
        console.error(`[dbc-monitor] balances RPC error: ${body.error.message}`);
        continue;
      }
      const values = body.result?.value ?? [];
      for (let j = 0; j < chunk.length; j++) {
        const acc = values[j];
        result.set(chunk[j], acc ? acc.lamports : null);
      }
    } catch (err) {
      console.error(`[dbc-monitor] balances batch failed:`, err);
    }
  }
  return result;
}

/**
 * Resolve the WSOL quote vault for a single token by scanning its launch accountKeys.
 * Returns the vault address (a SPL token-account whose mint = WSOL), or null if none found.
 *
 * Uses a single jsonParsed getMultipleAccounts call per token (~ accountKeys length, usually < 25).
 */
async function resolveWsolVault(
  accountKeys: string[],
  heliusKey: string | undefined,
): Promise<string | null> {
  if (accountKeys.length === 0) return null;
  // Filter out obviously-not-vault entries (system/program ids) to keep the request small.
  const candidates = accountKeys.filter(
    (k) => k.length >= 32 && !k.startsWith('11111111') && !k.includes('111111111111') && k !== WSOL_MINT,
  );
  if (candidates.length === 0) return null;

  const url = rpcUrl(heliusKey);
  // Single batch (Helius free plan rejects JSON-RPC batch arrays, but a single call with up to 100 keys is fine).
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'dbc-resolve',
        method: 'getMultipleAccounts',
        params: [candidates.slice(0, 100), { encoding: 'jsonParsed', commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as MultiAccountRespParsed;
    if (body.error || !body.result) return null;
    const values = body.result.value;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v?.data?.parsed?.type === 'account' && v.data.parsed.info?.mint === WSOL_MINT) {
        return candidates[i];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Append catch to the shared index used by pre-rug-catcher. */
async function addToIndex(kv: KVNamespace, c: PreRugCatch): Promise<void> {
  const existing = (await kv.get(INDEX_KEY, 'json')) as PreRugCatch[] | null;
  const list = existing ?? [];
  list.unshift(c);
  await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX_LEN)), { expirationTtl: CATCH_TTL });
}

/** Bump the catches counter + lastCatchAt in the shared stats blob. */
async function bumpStats(kv: KVNamespace, newCatches: number): Promise<void> {
  if (newCatches <= 0) return;
  const existing = (await kv.get(STATS_KEY, 'json')) as {
    tokensWatched: number;
    catches: number;
    lastRunAt: number;
    lastCatchAt: number | null;
    avgLeadTimeMs: number;
  } | null;
  const now = Date.now();
  const updated = {
    tokensWatched: existing?.tokensWatched ?? 0,
    catches: (existing?.catches ?? 0) + newCatches,
    lastRunAt: existing?.lastRunAt ?? now,
    lastCatchAt: now,
    avgLeadTimeMs: existing?.avgLeadTimeMs ?? 0,
  };
  await kv.put(STATS_KEY, JSON.stringify(updated), { expirationTtl: CATCH_TTL });
}

/**
 * Run a DBC pool monitoring tick over the supplied feed batch.
 * Returns count of new catches detected.
 */
export async function runDbcPoolMonitor(
  env: DbcMonitorEnv,
  batch: TokenFeedItem[],
): Promise<number> {
  const kv = env.SENTINEL_KV;
  if (!kv) return 0;

  // Filter to tokens with a known dbcPoolKey (PRE_GRAD only)
  const candidates = batch.filter((t) => !!t.dbcPoolKey);
  if (candidates.length === 0) {
    console.log('[dbc-monitor] no candidates with dbcPoolKey');
    return 0;
  }

  // Read all previous snapshots + cached vaults in parallel
  const [prevSnaps, cachedVaults] = await Promise.all([
    Promise.all(
      candidates.map((t) => kv.get(`dbc:bal:${t.mint}`, 'json') as Promise<DbcBalanceSnapshot | null>),
    ),
    Promise.all(candidates.map((t) => kv.get(`dbc:vault:${t.mint}`))),
  ]);

  // Resolve vaults for tokens that don't have one cached yet (sequential, ≤25 keys per call).
  const vaults: (string | null)[] = cachedVaults.slice();
  let resolvedCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (vaults[i]) continue;
    const accountKeys = candidates[i].accountKeys;
    if (!accountKeys || accountKeys.length === 0) continue;
    const vault = await resolveWsolVault(accountKeys, env.HELIUS_API_KEY);
    if (vault) {
      vaults[i] = vault;
      resolvedCount++;
      // Cache for 30 days; refresh-on-write keeps it warm.
      await kv.put(`dbc:vault:${candidates[i].mint}`, vault, { expirationTtl: VAULT_TTL });
    }
  }

  // Fetch fresh lamports for every token that has a vault.
  const vaultAddrs = vaults.filter((v): v is string => !!v);
  const balances = await fetchAccountLamports(vaultAddrs, env.HELIUS_API_KEY);

  console.log(
    `[dbc-monitor] candidates=${candidates.length} vaults_known=${vaultAddrs.length} resolved_now=${resolvedCount} balances_fetched=${[...balances.values()].filter((v) => v !== null).length}`,
  );

  let newCatches = 0;
  const now = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const token = candidates[i];
    const vault = vaults[i];
    if (!vault) continue;
    const lamports = balances.get(vault);
    if (lamports == null) continue; // vault account missing
    const sol = Math.max(0, (lamports - TOKEN_ACCOUNT_RENT_LAMPORTS) / 1e9);

    const prev = prevSnaps[i];

    // Check for drain ONLY if prev exists, is old enough, and had non-trivial liquidity
    if (prev && (now - prev.ts) >= MIN_LEAD_TIME_MS && prev.sol >= MIN_PREV_SOL) {
      const existingCatch = await kv.get(`watch:catch:${token.mint}`);
      if (!existingCatch) {
        const dropPct = ((prev.sol - sol) / prev.sol) * 100;
        if (dropPct >= DRAIN_PCT_THRESHOLD) {
          const catchRecord: PreRugCatch = {
            mint: token.mint,
            symbol: token.symbol ?? '',
            name: token.name ?? '',
            initialScore: 80,
            initialTier: 'safe',
            initialAt: prev.ts,
            caughtScore: 20,
            caughtTier: 'rug',
            caughtAt: now,
            scoreDrop: 60,
            tierTransition: 'safe→rug',
            reason: 'tier_crash',
            triggerSignals: [
              `Bonding curve liquidity drained ${dropPct.toFixed(0)}%`,
              `SOL balance: ${prev.sol.toFixed(2)} → ${sol.toFixed(2)}`,
              `WSOL vault: ${vault}`,
              `Pool: ${token.dbcPoolKey}`,
            ],
            creatorPrevRug: false,
          };
          await kv.put(`watch:catch:${token.mint}`, JSON.stringify(catchRecord), { expirationTtl: CATCH_TTL });
          await addToIndex(kv, catchRecord);

          await recordCatchEvidence({
            kv,
            caught: catchRecord,
            baseline: {
              mint: token.mint,
              symbol: token.symbol ?? '',
              name: token.name ?? '',
              score: 80,
              tier: 'safe',
              ts: prev.ts,
              liquidity: prev.sol,
            },
            riskAtCatch: {
              mint: token.mint,
              score: 20,
              tier: 'rug',
              breakdown: {
                honeypot: 0,
                lpLocked: 0,
                mintAuthority: 50,
                freezeAuthority: 50,
                topHolderPct: 50,
                liquidityDepth: 0,
                volumeHealth: 50,
                creatorReputation: 50,
              },
              timestamp: now,
              cached: false,
            },
          }).catch(() => {});

          console.log(
            `[dbc-monitor] CATCH ${token.symbol} ${token.mint.slice(0, 8)} drain ${dropPct.toFixed(0)}% (${prev.sol.toFixed(2)} → ${sol.toFixed(2)} SOL)`,
          );
          newCatches++;
        }
      }
    }

    const snap: DbcBalanceSnapshot = {
      mint: token.mint,
      symbol: token.symbol ?? '',
      name: token.name ?? '',
      dbcPoolKey: token.dbcPoolKey!,
      vault,
      lamports,
      sol,
      ts: now,
    };
    await kv.put(`dbc:bal:${token.mint}`, JSON.stringify(snap), { expirationTtl: SNAP_TTL });
  }

  await bumpStats(kv, newCatches);
  return newCatches;
}

/** Public read: current DBC pool balance snapshot for a mint. */
export async function getDbcSnapshot(kv: KVNamespace, mint: string): Promise<DbcBalanceSnapshot | null> {
  return kv.get(`dbc:bal:${mint}`, 'json') as Promise<DbcBalanceSnapshot | null>;
}
