/**
 * Embeddable SVG badge generator.
 *
 * GET /v1/badge/:mint → returns an SVG image that shows:
 *   "Sentinel Score: 72 · Safe"
 *
 * Creators embed this in their docs/sites. Caches in KV for 60s.
 */

import type { RiskTier } from '../../../shared/types';

const TIER_COLORS: Record<RiskTier, { bg: string; text: string; label: string }> = {
  safe:    { bg: '#16a34a', text: '#ffffff', label: 'SAFE' },
  caution: { bg: '#ca8a04', text: '#ffffff', label: 'CAUTION' },
  danger:  { bg: '#dc2626', text: '#ffffff', label: 'DANGER' },
  rug:     { bg: '#7f1d1d', text: '#ffffff', label: 'CRITICAL RISK' },
};

export function renderBadgeSVG(score: number, tier: RiskTier, symbol: string): string {
  const colors = TIER_COLORS[tier];
  const labelWidth = 105;
  const scoreText = `${score} · ${colors.label}`;
  const scoreWidth = scoreText.length * 7.2 + 16;
  const totalWidth = labelWidth + scoreWidth;

  // Shield.io inspired flat badge
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="Sentinel: ${scoreText}">
  <title>Sentinel Score for ${symbol}: ${score} (${tier})</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#1e293b"/>
    <rect x="${labelWidth}" width="${scoreWidth}" height="20" fill="${colors.bg}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">Sentinel Score</text>
    <text x="${labelWidth / 2}" y="14" fill="#fff">Sentinel Score</text>
    <text aria-hidden="true" x="${labelWidth + scoreWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${scoreText}</text>
    <text x="${labelWidth + scoreWidth / 2}" y="14" fill="${colors.text}">${scoreText}</text>
  </g>
</svg>`;
}
