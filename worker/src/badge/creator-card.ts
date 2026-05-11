/**
 * Shareable creator reputation card generator (1200×630 — Twitter/OG standard).
 *
 * GET /v1/card/creator/:wallet → returns SVG card with:
 *   - Creator wallet
 *   - Reputation score gauge
 *   - Token stats (total, safe, rugged)
 *   - Token mini-list with scores
 *   - Trust tier badge
 *   - Sentinel branding + CTA
 */

import type { CreatorProfile } from '../../../shared/types';
import { TIER_COLORS_CREATOR } from '../../../shared/badge-colors';
import { barColor, escapeXml } from '../../../shared/badge-utils';

const TIER_COLORS = TIER_COLORS_CREATOR;

export function renderCreatorCardSVG(profile: CreatorProfile): string {
  const { wallet, reputationScore, reputationTier, totalTokens, safeCount, ruggedCount, tokens } = profile;
  const colors = TIER_COLORS[reputationTier];
  const shortWallet = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const cautionCount = totalTokens - safeCount - ruggedCount;

  // Score arc (circular gauge)
  const cx = 160, cy = 210, r = 100;
  const startAngle = 135;
  const totalArc = 270;
  const scoreAngle = startAngle + (reputationScore / 100) * totalArc;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const arcX = (angle: number) => cx + r * Math.cos(toRad(angle));
  const arcY = (angle: number) => cy + r * Math.sin(toRad(angle));

  const bgStartX = arcX(startAngle).toFixed(1);
  const bgStartY = arcY(startAngle).toFixed(1);
  const bgEndX = arcX(startAngle + totalArc).toFixed(1);
  const bgEndY = arcY(startAngle + totalArc).toFixed(1);

  const fgEndX = arcX(scoreAngle).toFixed(1);
  const fgEndY = arcY(scoreAngle).toFixed(1);
  const fgLargeArc = scoreAngle - startAngle > 180 ? 1 : 0;

  const bgPath = `M ${bgStartX} ${bgStartY} A ${r} ${r} 0 1 1 ${bgEndX} ${bgEndY}`;
  const fgPath = reputationScore > 0
    ? `M ${bgStartX} ${bgStartY} A ${r} ${r} 0 ${fgLargeArc} 1 ${fgEndX} ${fgEndY}`
    : '';

  // Token list (top 6)
  const displayTokens = tokens.slice(0, 6);
  const tokenListSvg = displayTokens
    .map((t, i) => {
      const y = 130 + i * 52;
      const name = escapeXml(t.name.length > 14 ? t.name.slice(0, 14) + '…' : t.name);
      const sym = escapeXml(t.symbol.length > 6 ? t.symbol.slice(0, 6) : t.symbol);
      const sc = t.riskScore;
      const col = barColor(sc);
      const rugBadge = t.rugged
        ? `<rect x="880" y="${y - 12}" width="60" height="20" rx="4" fill="#991b1b" opacity="0.3"/>
          <text x="910" y="${y + 2}" font-family="monospace" font-size="11" fill="#ef4444" text-anchor="middle" font-weight="bold">RISK</text>`
        : '';
      return `
        <g>
          <rect x="470" y="${y - 16}" width="700" height="42" rx="8" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
          <text x="490" y="${y + 6}" font-family="system-ui,sans-serif" font-size="14" fill="white" font-weight="500">${name}</text>
          <text x="650" y="${y + 6}" font-family="monospace" font-size="12" fill="#6b7280">${sym}</text>
          <rect x="740" y="${y - 4}" width="120" height="14" rx="3" fill="rgba(255,255,255,0.05)"/>
          <rect x="740" y="${y - 4}" width="${Math.max(2, (sc / 100) * 120)}" height="14" rx="3" fill="${col}" opacity="0.7"/>
          <text x="870" y="${y + 7}" font-family="monospace" font-size="13" fill="${col}" font-weight="bold">${sc}</text>
          ${rugBadge}
        </g>`;
    })
    .join('');

  const moreCount = tokens.length - displayTokens.length;
  const moreLabel = moreCount > 0
    ? `<text x="820" y="${130 + displayTokens.length * 52 + 8}" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">+${moreCount} more tokens</text>`
    : '';

  const now = new Date().toISOString().split('T')[0];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="cbg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0a0e1a"/>
      <stop offset="100%" stop-color="${colors.bg}"/>
    </linearGradient>
    <filter id="cglow">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#cbg)" rx="16"/>
  <rect x="0.5" y="0.5" width="1199" height="629" rx="16" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- Header area -->
  <text x="60" y="60" font-family="system-ui,sans-serif" font-size="13" fill="#6b7280" letter-spacing="2">CREATOR TRUST REPORT</text>
  <text x="60" y="90" font-family="monospace" font-size="18" fill="white" font-weight="bold">${escapeXml(shortWallet)}</text>
  <text x="60" y="110" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280">${now}</text>

  <!-- Score gauge -->
  <path d="${bgPath}" stroke="rgba(255,255,255,0.08)" stroke-width="18" fill="none" stroke-linecap="round"/>
  ${fgPath ? `<path d="${fgPath}" stroke="${colors.accent}" stroke-width="18" fill="none" stroke-linecap="round" filter="url(#cglow)"/>` : ''}

  <!-- Score value -->
  <text x="${cx}" y="${cy + 10}" font-family="system-ui,sans-serif" font-size="56" fill="white" text-anchor="middle" font-weight="bold">${reputationScore}</text>
  <text x="${cx}" y="${cy + 35}" font-family="system-ui,sans-serif" font-size="14" fill="#6b7280" text-anchor="middle">/ 100</text>

  <!-- Tier badge -->
  <rect x="${cx - 60}" y="${cy + 50}" width="120" height="32" rx="8" fill="${colors.accent}" opacity="0.15" stroke="${colors.accent}" stroke-width="1" opacity="0.4"/>
  <text x="${cx}" y="${cy + 72}" font-family="system-ui,sans-serif" font-size="14" fill="${colors.accent}" text-anchor="middle" font-weight="bold">${colors.emoji} ${colors.label}</text>

  <!-- Stats cards -->
  <rect x="40" y="370" width="120" height="72" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="100" y="400" font-family="system-ui,sans-serif" font-size="28" fill="white" text-anchor="middle" font-weight="bold">${totalTokens}</text>
  <text x="100" y="422" font-family="system-ui,sans-serif" font-size="11" fill="#6b7280" text-anchor="middle">Tokens</text>

  <rect x="172" y="370" width="120" height="72" rx="10" fill="rgba(34,197,94,0.05)" stroke="rgba(34,197,94,0.15)" stroke-width="1"/>
  <text x="232" y="400" font-family="system-ui,sans-serif" font-size="28" fill="#22c55e" text-anchor="middle" font-weight="bold">${safeCount}</text>
  <text x="232" y="422" font-family="system-ui,sans-serif" font-size="11" fill="#22c55e" text-anchor="middle" opacity="0.7">Safe</text>

  <rect x="40" y="454" width="120" height="72" rx="10" fill="rgba(234,179,8,0.05)" stroke="rgba(234,179,8,0.15)" stroke-width="1"/>
  <text x="100" y="484" font-family="system-ui,sans-serif" font-size="28" fill="#eab308" text-anchor="middle" font-weight="bold">${cautionCount}</text>
  <text x="100" y="506" font-family="system-ui,sans-serif" font-size="11" fill="#eab308" text-anchor="middle" opacity="0.7">Caution</text>

  <rect x="172" y="454" width="120" height="72" rx="10" fill="rgba(239,68,68,0.05)" stroke="rgba(239,68,68,0.15)" stroke-width="1"/>
  <text x="232" y="484" font-family="system-ui,sans-serif" font-size="28" fill="#ef4444" text-anchor="middle" font-weight="bold">${ruggedCount}</text>
  <text x="232" y="506" font-family="system-ui,sans-serif" font-size="11" fill="#ef4444" text-anchor="middle" opacity="0.7">Critical</text>

  <!-- Divider -->
  <line x1="440" y1="100" x2="440" y2="550" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- Token list header -->
  <text x="470" y="110" font-family="system-ui,sans-serif" font-size="13" fill="#6b7280" letter-spacing="1">TOKEN HISTORY</text>
  ${tokenListSvg}
  ${moreLabel}

  <!-- Footer -->
  <rect x="0" y="570" width="1200" height="60" fill="rgba(0,0,0,0.3)"/>
  <text x="60" y="605" font-family="system-ui,sans-serif" font-size="14" fill="${colors.accent}" font-weight="bold">🛡️ Sentinel</text>
  <text x="170" y="605" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280">Don't trade blind — scan every creator on bags.fm</text>
  <text x="1140" y="605" font-family="monospace" font-size="11" fill="#4b5563" text-anchor="end">sentinel-dashboard-3uy.pages.dev</text>
</svg>`;
}
