/**
 * Bags Partner Integration — REST API.
 *
 * Sentinel registers as a Bags partner to receive a % of fees
 * from tokens that integrate with us. This module handles:
 * - Partner config creation (returns unsigned tx)
 * - Partner claim stats (claimed vs unclaimed fees)
 * - Partner fee claim transactions (returns unsigned txs)
 */
import { BAGS_API_BASE } from '../../../shared/constants';

// ── Types ────────────────────────────────────────────────

export interface PartnerConfig {
  partner: string;               // wallet pubkey
  bps: number;                   // basis points (e.g. 100 = 1%)
  totalClaimedFees: string;      // lamports (string for BigInt safety)
  totalAccumulatedFees: string;
  totalLifetimeAccumulatedFees: string;
}

export interface PartnerClaimStats {
  claimedFees: string;           // lamports
  unclaimedFees: string;         // lamports
  claimedFeesUsd: number;
  unclaimedFeesUsd: number;
}

export interface PartnerTxResult {
  transaction: string;           // base58 unsigned
  blockhash: string;
  lastValidBlockHeight: number;
}

// ── Helpers ──────────────────────────────────────────────

async function bagsGet<T>(path: string, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(`${BAGS_API_BASE}${path}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bags partner API ${res.status}: ${text}`);
  }

  const data = await res.json() as { success: boolean; response?: T; error?: string };
  if (!data.success || !data.response) {
    throw new Error(data.error ?? 'Bags partner API returned failure');
  }
  return data.response;
}

async function bagsPost<T>(path: string, body: unknown, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(`${BAGS_API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bags partner API ${res.status}: ${text}`);
  }

  const data = await res.json() as { success: boolean; response?: T; error?: string };
  if (!data.success || !data.response) {
    throw new Error(data.error ?? 'Bags partner API returned failure');
  }
  return data.response;
}

// ── Partner Config ───────────────────────────────────────

/**
 * Get the on-chain partner config for a wallet.
 * Returns null if the wallet has no partner config created yet.
 */
export async function getPartnerConfig(
  wallet: string,
  apiKey?: string,
): Promise<PartnerConfig | null> {
  try {
    const r = await bagsGet<{ claimedFees?: string; unclaimedFees?: string }>(
      `/fee-share/partner-config/stats?partner=${wallet}`,
      apiKey,
    );
    return {
      partner: wallet,
      bps: 0,
      totalClaimedFees: r.claimedFees ?? '0',
      totalAccumulatedFees: r.unclaimedFees ?? '0',
      totalLifetimeAccumulatedFees: r.claimedFees ?? '0',
    };
  } catch {
    return null;
  }
}

/**
 * Request a partner config creation transaction.
 * The caller must sign with their wallet to finalize on-chain.
 */
export async function getPartnerCreationTx(
  partnerWallet: string,
  apiKey?: string,
): Promise<PartnerTxResult> {
  // SDK uses: POST /fee-share/partner-config/creation-tx  { partnerWallet }
  // Response: { transaction: { transaction: base58, blockhash: string }, ... }
  const raw = await bagsPost<{
    transaction: { transaction: string; blockhash: string; lastValidBlockHeight: number };
  }>('/fee-share/partner-config/creation-tx', { partnerWallet }, apiKey);

  return {
    transaction: raw.transaction.transaction,
    blockhash: raw.transaction.blockhash,
    lastValidBlockHeight: raw.transaction.lastValidBlockHeight,
  };
}

/**
 * Get partner claim stats (claimed + unclaimed fees).
 */
export async function getPartnerClaimStats(
  wallet: string,
  apiKey?: string,
): Promise<PartnerClaimStats> {
  const raw = await bagsGet<{
    claimedFees: string;
    unclaimedFees: string;
  }>(`/fee-share/partner-config/stats?partner=${wallet}`, apiKey);

  const claimedLamports = BigInt(raw.claimedFees || '0');
  const unclaimedLamports = BigInt(raw.unclaimedFees || '0');
  const SOL_PRICE_EST = 150; // rough estimate

  return {
    claimedFees: raw.claimedFees,
    unclaimedFees: raw.unclaimedFees,
    claimedFeesUsd: Number(claimedLamports) / 1e9 * SOL_PRICE_EST,
    unclaimedFeesUsd: Number(unclaimedLamports) / 1e9 * SOL_PRICE_EST,
  };
}

/**
 * Get partner fee claim transactions (unsigned).
 * Returns array of txs that must be signed and sent.
 */
export async function getPartnerClaimTxs(
  wallet: string,
  apiKey?: string,
): Promise<PartnerTxResult[]> {
  const raw = await bagsPost<{
    transactions: Array<{ transaction: string; blockhash: string; lastValidBlockHeight: number }>;
  }>('/fee-share/partner-config/claim-tx', { partnerWallet: wallet }, apiKey);

  return raw.transactions.map((r) => ({
    transaction: r.transaction,
    blockhash: r.blockhash,
    lastValidBlockHeight: r.lastValidBlockHeight,
  }));
}
