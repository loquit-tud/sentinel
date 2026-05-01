/**
 * Bags App Store — metadata for bags.fm/apply + bags.fm/apps.
 *
 * Centralizes all app store metadata so the dashboard
 * and API can serve consistent info for the app listing.
 */
import { SENT_MINT, SENTINEL_TEAM_WALLET, SENTINEL_HOLDERS_WALLET } from '../../../shared/constants';

// ── Types ────────────────────────────────────────────────

export interface AppStoreInfo {
  name: string;
  tagline: string;
  description: string;
  category: string;
  token: {
    symbol: string;
    mint: string;
    bagsUrl: string;
  };
  links: {
    dashboard: string;
    api: string;
    github: string;
    dorahacks: string;
    docs: string;
  };
  features: string[];
  version: string;
  updatedAt: string;
}

// ── App Store Metadata ───────────────────────────────────

export function getAppStoreInfo(): AppStoreInfo {
  return {
    name: 'Sentinel',
    tagline: "Don't trade blind.",
    description:
      'AI risk intelligence + wallet portfolio scanner for Bags traders & creators. ' +
      'Risk scores 0-100 for any token, wallet X-ray, auto fee optimization, ' +
      'creator reputation, and Telegram risk alerts.',
    category: 'AI Agents',
    token: {
      symbol: 'SENT',
      mint: SENT_MINT,
      bagsUrl: `https://bags.fm/token/${SENT_MINT}`,
    },
    links: {
      dashboard: 'https://sentinel-dashboard-3uy.pages.dev',
      api: 'https://sentinel-api.apiworkersdev.workers.dev',
      github: 'https://github.com/loquit-doru/sentinel',
      // Fill after submitting on DoraHacks (use the final BUIDL URL).
      dorahacks: 'https://dorahacks.io/hackathon/the-bags-hackathon/detail/',
      docs: 'https://sentinel-api.apiworkersdev.workers.dev/health',
    },
    features: [
      'Risk Scoring Engine (8 weighted signals → 0-100)',
      'Wallet X-Ray (portfolio health + flagged tokens)',
      'Auto Fee Optimizer (smart claim prioritization)',
      'MCP Server (12 Claude tools)',
      'Telegram Alerts (risk + fee + volume)',
      '$SENT Token Gating (holder/whale tiers)',
    ],
    version: '0.13.0',
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

// ── $SENT Fee Share Allocation ───────────────────────────

export interface SentFeeShareConfig {
  tokenMint: string;
  tokenSymbol: string;
  allocations: {
    creatorPct: number;   // Sentinel team
    holdersPct: number;   // $SENT holders
    devFundPct: number;   // Dev / ops
    partnerPct: number;   // Bags partner fee
  };
  /** BPS values for on-chain fee-share config */
  feeClaimers: Array<{
    label: string;
    wallet: string;        // placeholder — fill with real wallets
    bps: number;
  }>;
}

/**
 * Target $SENT fee share config.
 * 40% creator, 30% holders, 20% dev fund, 10% partner.
 */
export function getSentFeeShareTarget(): SentFeeShareConfig {
  return {
    tokenMint: SENT_MINT,
    tokenSymbol: 'SENT',
    allocations: {
      creatorPct: 40,
      holdersPct: 30,
      devFundPct: 20,
      partnerPct: 10,
    },
    feeClaimers: [
      { label: 'Creator (Sentinel)', wallet: SENTINEL_TEAM_WALLET, bps: 4000 },
      { label: 'Holders Reward',     wallet: SENTINEL_HOLDERS_WALLET, bps: 3000 },
      { label: 'Dev Fund',           wallet: SENTINEL_TEAM_WALLET, bps: 2000 },
      // Partner (Bags) wallet — update with official Bags partner address after registration
      { label: 'Partner (Bags)',     wallet: SENTINEL_TEAM_WALLET, bps: 1000 },
    ],
  };
}
