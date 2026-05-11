/**
 * Consolidated tier colors and labels for all badge/card renderers.
 * Prevents duplication across card.ts, creator-card.ts, embed.ts, svg.ts.
 */

import type { RiskTier, RiskBreakdown } from './types';

/**
 * Standard card render colors (opaque, darker backgrounds).
 * Used by: card.ts, creator-card.ts
 */
export const TIER_COLORS_CARD: Record<RiskTier, { bg: string; accent: string; label: string; emoji: string }> = {
  safe:    { bg: '#0f2a1a', accent: '#22c55e', label: 'SAFE',    emoji: '🟢' },
  caution: { bg: '#2a2510', accent: '#eab308', label: 'CAUTION', emoji: '🟡' },
  danger:  { bg: '#2a1010', accent: '#ef4444', label: 'DANGER',  emoji: '🟠' },
  rug:     { bg: '#2a0a0a', accent: '#991b1b', label: 'CRITICAL RISK', emoji: '🔴' },
};

/**
 * Creator card colors (with context-specific tier labels).
 * Used by: creator-card.ts
 */
export const TIER_COLORS_CREATOR: Record<RiskTier, { bg: string; accent: string; label: string; emoji: string }> = {
  safe:    { bg: '#0f2a1a', accent: '#22c55e', label: 'TRUSTED',    emoji: '🟢' },
  caution: { bg: '#2a2510', accent: '#eab308', label: 'MIXED',      emoji: '🟡' },
  danger:  { bg: '#2a1010', accent: '#ef4444', label: 'SUSPICIOUS', emoji: '🟠' },
  rug:     { bg: '#2a0a0a', accent: '#991b1b', label: 'CRITICAL RISK',     emoji: '🔴' },
};

/**
 * Embed widget colors (with semi-transparent ring overlays).
 * Used by: embed.ts
 */
export const TIER_COLORS_EMBED: Record<RiskTier, { bg: string; ring: string; label: string; emoji: string }> = {
  safe:    { bg: '#16a34a', ring: 'rgba(34,197,94,0.4)',  label: 'SAFE',     emoji: '🟢' },
  caution: { bg: '#ca8a04', ring: 'rgba(234,179,8,0.4)',  label: 'CAUTION',  emoji: '🟡' },
  danger:  { bg: '#dc2626', ring: 'rgba(239,68,68,0.4)',  label: 'DANGER',   emoji: '🟠' },
  rug:     { bg: '#7f1d1d', ring: 'rgba(153,27,27,0.4)',  label: 'CRITICAL RISK', emoji: '🔴' },
};

/**
 * SVG badge colors (minimal, flat).
 * Used by: svg.ts
 */
export const TIER_COLORS_SVG: Record<RiskTier, { bg: string; text: string; label: string }> = {
  safe:    { bg: '#16a34a', text: '#ffffff', label: 'SAFE' },
  caution: { bg: '#ca8a04', text: '#ffffff', label: 'CAUTION' },
  danger:  { bg: '#dc2626', text: '#ffffff', label: 'DANGER' },
  rug:     { bg: '#7f1d1d', text: '#ffffff', label: 'CRITICAL RISK' },
};

/**
 * Breakdown component labels for risk cards.
 * Maps RiskBreakdown keys to human-readable names.
 */
export const BREAKDOWN_LABELS: Record<keyof RiskBreakdown, string> = {
  honeypot: 'Honeypot',
  lpLocked: 'LP Lock',
  mintAuthority: 'Mint Auth',
  freezeAuthority: 'Freeze Auth',
  topHolderPct: 'Distribution',
  liquidityDepth: 'Liquidity',
  volumeHealth: 'Volume',
  creatorReputation: 'Creator Rep',
};
