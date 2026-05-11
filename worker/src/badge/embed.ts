/**
 * Interactive HTML embed widget.
 *
 * GET /v1/embed/score?mint=...&theme=dark|light → returns standalone HTML
 * (frame-friendly, no X-Frame-Options) with live risk score and a
 * "Powered by Sentinel" backlink. Designed to be dropped in iframes
 * on creator sites, Twitter cards, blog posts.
 *
 * Sized 320×120 by default — perfect for a sidebar widget.
 */

import type { RiskTier } from '../../../shared/types';

const TIER_COLORS: Record<RiskTier, { bg: string; ring: string; label: string; emoji: string }> = {
  safe:    { bg: '#16a34a', ring: 'rgba(34,197,94,0.4)',  label: 'SAFE',     emoji: '🟢' },
  caution: { bg: '#ca8a04', ring: 'rgba(234,179,8,0.4)',  label: 'CAUTION',  emoji: '🟡' },
  danger:  { bg: '#dc2626', ring: 'rgba(239,68,68,0.4)',  label: 'DANGER',   emoji: '🟠' },
  rug:     { bg: '#7f1d1d', ring: 'rgba(153,27,27,0.4)',  label: 'CRITICAL RISK', emoji: '🔴' },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmbedParams {
  mint: string;
  symbol: string;
  score: number;
  tier: RiskTier;
  theme: 'dark' | 'light';
  origin: string;
}

export function renderEmbedHTML(params: EmbedParams): string {
  const { mint, symbol, score, tier, theme, origin } = params;
  const colors = TIER_COLORS[tier];
  const isDark = theme === 'dark';
  const bg = isDark ? '#0a0e1a' : '#ffffff';
  const surface = isDark ? '#111827' : '#f3f4f6';
  const text = isDark ? '#f3f4f6' : '#111827';
  const muted = isDark ? '#6b7280' : '#9ca3af';
  const border = isDark ? '#1f2937' : '#e5e7eb';
  const accent = '#06b6d4';
  const safeSymbol = escapeHtml(symbol || 'TOKEN');
  const safeMint = escapeHtml(mint);
  const shortMint = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const link = `${origin}/?risk=${encodeURIComponent(mint)}&utm_source=embed&utm_medium=widget&utm_campaign=score`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Score · ${safeSymbol}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;width:100%;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;color:${text}}
  a{color:inherit;text-decoration:none;display:block;height:100%;width:100%}
  .card{
    height:120px;width:100%;max-width:340px;
    background:${bg};border:1px solid ${border};border-radius:12px;
    padding:12px 14px;display:flex;flex-direction:column;justify-content:space-between;
    transition:border-color 160ms ease,transform 160ms ease;
  }
  a:hover .card{border-color:${accent};transform:translateY(-1px)}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .brand{display:flex;align-items:center;gap:6px;font-size:10px;color:${muted};text-transform:uppercase;letter-spacing:0.1em;font-weight:600}
  .brand-dot{width:6px;height:6px;border-radius:999px;background:${accent};box-shadow:0 0 8px ${accent}}
  .symbol{font-size:14px;font-weight:700;color:${text}}
  .mint{font-size:10px;color:${muted};font-family:ui-monospace,SF-Mono,monospace}
  .score-row{display:flex;align-items:center;gap:12px}
  .score-circle{
    width:54px;height:54px;border-radius:999px;
    background:${surface};border:2px solid ${colors.bg};
    box-shadow:0 0 0 3px ${colors.ring};
    display:flex;align-items:center;justify-content:center;
    font-size:20px;font-weight:800;color:${text};font-variant-numeric:tabular-nums;
  }
  .meta{flex:1;min-width:0}
  .verdict{
    display:inline-block;background:${colors.bg};color:#fff;
    font-size:10px;font-weight:700;letter-spacing:0.06em;
    padding:3px 8px;border-radius:5px;margin-bottom:4px;
  }
  .label{font-size:11px;color:${muted};line-height:1.3}
  .footer{font-size:9px;color:${muted};text-transform:uppercase;letter-spacing:0.1em}
  .footer span{color:${accent};font-weight:600}
</style>
</head>
<body>
<a href="${escapeHtml(link)}" target="_blank" rel="noopener" title="View full risk report on Sentinel">
  <div class="card">
    <div class="row">
      <div>
        <div class="symbol">$${safeSymbol}</div>
        <div class="mint" title="${safeMint}">${escapeHtml(shortMint)}</div>
      </div>
      <div class="brand">
        <span class="brand-dot"></span>
        <span>Sentinel</span>
      </div>
    </div>
    <div class="score-row">
      <div class="score-circle">${score}</div>
      <div class="meta">
        <div class="verdict">${colors.emoji} ${colors.label}</div>
        <div class="label">AI Risk Score · 8 factors · live on-chain</div>
      </div>
    </div>
    <div class="footer">Powered by <span>sentinel</span> · click to verify</div>
  </div>
</a>
</body>
</html>`;
}
