/**
 * Shareable social card generator (1200×630 — Twitter/OG standard).
 *
 * GET /v1/card/:mint → returns SVG card with:
 *   - Token symbol + mint
 *   - Large score gauge
 *   - Tier verdict
 *   - 8 breakdown bars
 *   - Sentinel branding + CTA
 *
 * Designed for Twitter link previews and direct sharing.
 */

import type { RiskTier } from '../../../shared/types';
import { TIER_COLORS_CARD, BREAKDOWN_LABELS } from '../../../shared/badge-colors';
import { barColor, escapeXml } from '../../../shared/badge-utils';

const TIER_COLORS = TIER_COLORS_CARD;

export function renderShareCardSVG(
  score: number,
  tier: RiskTier,
  breakdown: RiskBreakdown,
  symbol: string,
  mint: string,
): string {
  const colors = TIER_COLORS[tier];
  const safeSymbol = escapeXml(symbol || 'Unknown');
  const shortMint = `${mint.slice(0, 6)}...${mint.slice(-4)}`;

  // Score arc (circular gauge)
  const cx = 160, cy = 200, r = 100;
  const startAngle = 135;
  const totalArc = 270;
  const scoreAngle = startAngle + (score / 100) * totalArc;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const arcEndX = cx + r * Math.cos(toRad(scoreAngle));
  const arcEndY = cy + r * Math.sin(toRad(scoreAngle));
  const bgEndX = cx + r * Math.cos(toRad(startAngle + totalArc));
  const bgEndY = cy + r * Math.sin(toRad(startAngle + totalArc));
  const startX = cx + r * Math.cos(toRad(startAngle));
  const startY = cy + r * Math.sin(toRad(startAngle));

  const largeArcBg = totalArc > 180 ? 1 : 0;
  const largeArcScore = (score / 100) * totalArc > 180 ? 1 : 0;

  // Breakdown bars
  const entries = Object.entries(breakdown) as [keyof RiskBreakdown, number][];
  const barStartY = 90;
  const barHeight = 18;
  const barGap = 12;
  const barMaxWidth = 280;
  const barX = 380;

  const bars = entries.map(([key, value], i) => {
    const y = barStartY + i * (barHeight + barGap);
    const w = Math.max(2, (value / 100) * barMaxWidth);
    const color = barColor(value);
    return `
    <text x="${barX}" y="${y + 13}" fill="#94a3b8" font-size="13" font-family="Inter,system-ui,sans-serif">${BREAKDOWN_LABELS[key]}</text>
    <rect x="${barX + 110}" y="${y}" width="${barMaxWidth}" height="${barHeight}" rx="4" fill="#1e293b"/>
    <rect x="${barX + 110}" y="${y}" width="${w}" height="${barHeight}" rx="4" fill="${color}"/>
    <text x="${barX + 110 + barMaxWidth + 10}" y="${y + 13}" fill="#cbd5e1" font-size="12" font-family="Inter,system-ui,sans-serif">${value}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0e1a"/>
      <stop offset="100%" stop-color="${colors.bg}"/>
    </linearGradient>
    <linearGradient id="scoreFill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${colors.accent}" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="${colors.accent}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Subtle grid pattern -->
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5" opacity="0.3"/>
  </pattern>
  <rect width="1200" height="630" fill="url(#grid)"/>

  <!-- Top bar -->
  <rect width="1200" height="3" fill="${colors.accent}"/>

  <!-- Sentinel logo text -->
  <text x="40" y="50" fill="#06b6d4" font-size="18" font-weight="700" font-family="Inter,system-ui,sans-serif" letter-spacing="3">SENTINEL</text>
  <text x="170" y="50" fill="#64748b" font-size="14" font-family="Inter,system-ui,sans-serif">Risk Intelligence</text>

  <!-- Token info -->
  <text x="160" y="380" text-anchor="middle" fill="#f8fafc" font-size="32" font-weight="700" font-family="Inter,system-ui,sans-serif">${safeSymbol}</text>
  <text x="160" y="410" text-anchor="middle" fill="#64748b" font-size="14" font-family="Inter,system-ui,sans-serif">${shortMint}</text>

  <!-- Score gauge background arc -->
  <path d="M ${startX} ${startY} A ${r} ${r} 0 ${largeArcBg} 1 ${bgEndX} ${bgEndY}"
        fill="none" stroke="#1e293b" stroke-width="14" stroke-linecap="round"/>

  <!-- Score gauge filled arc -->
  ${score > 0 ? `<path d="M ${startX} ${startY} A ${r} ${r} 0 ${largeArcScore} 1 ${arcEndX} ${arcEndY}"
        fill="none" stroke="url(#scoreFill)" stroke-width="14" stroke-linecap="round"/>` : ''}

  <!-- Score number -->
  <text x="${cx}" y="${cy + 15}" text-anchor="middle" fill="#f8fafc" font-size="56" font-weight="800" font-family="Inter,system-ui,sans-serif">${score}</text>
  <text x="${cx}" y="${cy + 40}" text-anchor="middle" fill="#94a3b8" font-size="14" font-family="Inter,system-ui,sans-serif">/ 100</text>

  <!-- Tier badge -->
  <rect x="${cx - 55}" y="${cy + 50}" width="110" height="30" rx="15" fill="${colors.accent}" opacity="0.2"/>
  <rect x="${cx - 55}" y="${cy + 50}" width="110" height="30" rx="15" fill="none" stroke="${colors.accent}" stroke-width="1.5"/>
  <text x="${cx}" y="${cy + 70}" text-anchor="middle" fill="${colors.accent}" font-size="14" font-weight="700" font-family="Inter,system-ui,sans-serif">${colors.label}</text>

  <!-- Divider -->
  <line x1="340" y1="80" x2="340" y2="430" stroke="#1e293b" stroke-width="1"/>

  <!-- Breakdown title -->
  <text x="${barX}" y="72" fill="#cbd5e1" font-size="16" font-weight="600" font-family="Inter,system-ui,sans-serif">Risk Breakdown</text>

  <!-- Breakdown bars -->
  ${bars}

  <!-- Bottom section -->
  <rect y="500" width="1200" height="130" fill="#0a0e1a" opacity="0.8"/>
  <line y1="500" x2="1200" y2="500" stroke="#1e293b" stroke-width="1"/>

  <!-- CTA -->
  <text x="40" y="545" fill="#f8fafc" font-size="20" font-weight="600" font-family="Inter,system-ui,sans-serif">Check any Bags token before you ape</text>
  <text x="40" y="575" fill="#64748b" font-size="16" font-family="Inter,system-ui,sans-serif">sentinel-dashboard-3uy.pages.dev</text>

  <!-- $SENT branding -->
  <text x="1160" y="545" text-anchor="end" fill="#06b6d4" font-size="14" font-weight="600" font-family="Inter,system-ui,sans-serif">Powered by $SENT</text>
  <text x="1160" y="575" text-anchor="end" fill="#64748b" font-size="13" font-family="Inter,system-ui,sans-serif">AI Risk Intelligence for Bags</text>

  <!-- Timestamp -->
  <text x="1160" y="615" text-anchor="end" fill="#475569" font-size="11" font-family="Inter,system-ui,sans-serif">Scanned ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</text>
</svg>`;
}
