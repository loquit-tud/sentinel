/**
 * Bags REST API integration for token launch + fee-share config.
 * All transactions are returned unsigned (base58) — client signs with wallet adapter.
 */
import { BAGS_API_BASE } from '../../../shared/constants';

// ── Types ────────────────────────────────────────────────

export interface CreateTokenInfoParams {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface TokenInfoResult {
  tokenMint: string;
  metadataUrl: string;
}

export interface LaunchTxParams {
  tokenMint: string;
  launchWallet: string;
  metadataUrl: string;
  configKey: string;
  initialBuyLamports: number;
}

export interface LaunchTxResult {
  transaction: string; // base58
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface FeeClaimerEntry {
  user: string;    // wallet base58
  userBps: number; // basis points
}

export interface FeeConfigParams {
  baseMint: string;  // token mint (e.g. $SENT)
  feeClaimers: FeeClaimerEntry[];
  payer: string; // wallet base58
}

export interface FeeConfigResult {
  needsCreation: boolean;
  transactions: Array<{
    tx: string; // base58
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  meteoraConfigKey: string;
}

// ── Helpers ──────────────────────────────────────────────

interface BagsResponse<T> {
  success: boolean;
  response?: T;
  error?: string;
}

async function bagsPost<T>(endpoint: string, body: unknown, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(`${BAGS_API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bags API ${res.status}: ${text}`);
  }

  const data = await res.json() as BagsResponse<T>;
  if (!data.success || !data.response) {
    throw new Error(data.error ?? 'Bags API returned failure');
  }
  return data.response;
}

// ── Create Token Info (metadata upload) ──────────────────

interface BagsTokenInfoResponse {
  tokenMint: string;
  tokenMetadata: string; // metadata URI
}

export async function createTokenInfo(
  params: CreateTokenInfoParams,
  apiKey?: string,
): Promise<TokenInfoResult> {
  const result = await bagsPost<BagsTokenInfoResponse>(
    '/token-launch/create-token-info',
    {
      name: params.name,
      symbol: params.symbol,
      description: params.description,
      imageUrl: params.imageUrl,
      website: params.website ?? '',
      twitter: params.twitter ?? '',
      telegram: params.telegram ?? '',
    },
    apiKey,
  );

  return {
    tokenMint: result.tokenMint,
    metadataUrl: result.tokenMetadata,
  };
}

// ── Create Launch Transaction ────────────────────────────

interface BagsLaunchTxResponse {
  transaction: string; // base58
  blockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

export async function createLaunchTransaction(
  params: LaunchTxParams,
  apiKey?: string,
): Promise<LaunchTxResult> {
  const result = await bagsPost<BagsLaunchTxResponse>(
    '/token-launch/create-launch-transaction',
    {
      tokenMint: params.tokenMint,
      launchWallet: params.launchWallet,
      metadataUrl: params.metadataUrl,
      configKey: params.configKey,
      initialBuyLamports: params.initialBuyLamports,
    },
    apiKey,
  );

  return {
    transaction: result.transaction,
    blockhash: result.blockhash.blockhash,
    lastValidBlockHeight: result.blockhash.lastValidBlockHeight,
  };
}

// ── Create Fee-Share Config ──────────────────────────────

interface BagsFeeConfigResponse {
  needsCreation: boolean;
  transactions: Array<{
    tx: string;
    blockhash: { blockhash: string; lastValidBlockHeight: number };
  }>;
  meteoraConfigKey: string;
}

export async function createFeeShareConfig(
  params: FeeConfigParams,
  apiKey?: string,
): Promise<FeeConfigResult> {
  const result = await bagsPost<BagsFeeConfigResponse>(
    '/fee-share/config',
    {
      baseMint: params.baseMint,
      basisPointsArray: params.feeClaimers.map((c) => c.userBps),
      claimersArray: params.feeClaimers.map((c) => c.user),
      payer: params.payer,
    },
    apiKey,
  );

  return {
    needsCreation: result.needsCreation,
    transactions: (result.transactions || []).map((t) => ({
      tx: t.tx,
      blockhash: t.blockhash.blockhash,
      lastValidBlockHeight: t.blockhash.lastValidBlockHeight,
    })),
    meteoraConfigKey: result.meteoraConfigKey,
  };
}
