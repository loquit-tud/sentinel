import { describe, it, expect } from 'vitest';
import { renderShareCardSVG } from '../src/badge/card';
import type { RiskBreakdown, RiskTier } from '../../shared/types';

const BASE_BREAKDOWN: RiskBreakdown = {
  honeypot: 100,
  lpLocked: 85,
  mintAuthority: 100,
  freezeAuthority: 100,
  topHolderPct: 55,
  liquidityDepth: 60,
  volumeHealth: 70,
  creatorReputation: 40,
};

describe('renderShareCardSVG', () => {
  it('returns valid SVG with correct dimensions (1200x630)', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'SOL', 'So11111111111111111111111111111111111111112');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('includes token symbol', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(svg).toContain('BONK');
  });

  it('shows shortened mint address', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'SOL', 'So11111111111111111111111111111111111111112');
    expect(svg).toContain('So1111');
    expect(svg).toContain('1112');
  });

  it('displays score number', () => {
    const svg = renderShareCardSVG(85, 'safe', BASE_BREAKDOWN, 'X', 'abc123def456');
    expect(svg).toContain('>85<');
  });

  it('shows tier label for each tier', () => {
    const tiers: [RiskTier, string][] = [
      ['safe', 'SAFE'],
      ['caution', 'CAUTION'],
      ['danger', 'DANGER'],
      ['rug', 'CRITICAL RISK'],
    ];
    for (const [tier, label] of tiers) {
      const svg = renderShareCardSVG(50, tier, BASE_BREAKDOWN, 'T', 'mint123');
      expect(svg).toContain(label);
    }
  });

  it('uses tier-specific accent colors', () => {
    expect(renderShareCardSVG(85, 'safe', BASE_BREAKDOWN, 'X', 'm')).toContain('#22c55e');
    expect(renderShareCardSVG(50, 'caution', BASE_BREAKDOWN, 'X', 'm')).toContain('#eab308');
    expect(renderShareCardSVG(20, 'danger', BASE_BREAKDOWN, 'X', 'm')).toContain('#ef4444');
    expect(renderShareCardSVG(5, 'rug', BASE_BREAKDOWN, 'X', 'm')).toContain('#991b1b');
  });

  it('renders all 8 breakdown bars', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'SOL', 'mint123');
    expect(svg).toContain('Honeypot');
    expect(svg).toContain('LP Lock');
    expect(svg).toContain('Mint Auth');
    expect(svg).toContain('Freeze Auth');
    expect(svg).toContain('Distribution');
    expect(svg).toContain('Liquidity');
    expect(svg).toContain('Volume');
    expect(svg).toContain('Creator Rep');
  });

  it('includes Sentinel branding', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'SOL', 'mint123');
    expect(svg).toContain('SENTINEL');
    expect(svg).toContain('Risk Intelligence');
    expect(svg).toContain('Powered by $SENT');
  });

  it('includes CTA with dashboard URL', () => {
    const svg = renderShareCardSVG(72, 'safe', BASE_BREAKDOWN, 'SOL', 'mint123');
    expect(svg).toContain('Check any Bags token');
    expect(svg).toContain('sentinel-dashboard');
  });

  it('escapes XML special characters in symbol', () => {
    const svg = renderShareCardSVG(50, 'caution', BASE_BREAKDOWN, '<SCAM>&', 'mint123');
    expect(svg).toContain('&lt;SCAM&gt;&amp;');
    expect(svg).not.toContain('<SCAM>');
  });

  it('handles zero score (no filled arc)', () => {
    const svg = renderShareCardSVG(0, 'rug', BASE_BREAKDOWN, 'RUG', 'mint123');
    expect(svg).toContain('>0<');
    // No score arc path when score = 0
    expect(svg).not.toContain('stroke="url(#scoreFill)"');
  });

  it('handles max score', () => {
    const svg = renderShareCardSVG(100, 'safe', BASE_BREAKDOWN, 'SAFE', 'mint123');
    expect(svg).toContain('>100<');
    expect(svg).toContain('stroke="url(#scoreFill)"');
  });
});
