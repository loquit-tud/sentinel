import { describe, it, expect } from 'vitest';
import { renderBadgeSVG } from '../src/badge/svg';
import type { RiskTier } from '../../shared/types';

describe('renderBadgeSVG', () => {
  it('returns valid SVG with xmlns', () => {
    const svg = renderBadgeSVG(72, 'safe', 'TEST');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/^<svg /);
    expect(svg).toMatch(/<\/svg>$/);
  });

  it('includes the score and tier label', () => {
    const svg = renderBadgeSVG(72, 'safe', 'TEST');
    expect(svg).toContain('72');
    expect(svg).toContain('SAFE');
  });

  it('includes symbol in title', () => {
    const svg = renderBadgeSVG(50, 'caution', 'SOL');
    expect(svg).toContain('Sentinel Score for SOL: 50 (caution)');
  });

  it('uses green for safe tier', () => {
    const svg = renderBadgeSVG(85, 'safe', 'X');
    expect(svg).toContain('#16a34a');
  });

  it('uses yellow for caution tier', () => {
    const svg = renderBadgeSVG(55, 'caution', 'X');
    expect(svg).toContain('#ca8a04');
  });

  it('uses red for danger tier', () => {
    const svg = renderBadgeSVG(20, 'danger', 'X');
    expect(svg).toContain('#dc2626');
  });

  it('uses dark red for rug tier', () => {
    const svg = renderBadgeSVG(5, 'rug', 'X');
    expect(svg).toContain('#7f1d1d');
    expect(svg).toContain('CRITICAL RISK');
  });

  it('renders different score text for different tiers', () => {
    const safe = renderBadgeSVG(99, 'safe', 'A');
    const rug = renderBadgeSVG(1, 'rug', 'A');
    // "99 · SAFE" vs "1 · CRITICAL RISK" — different text content
    expect(safe).toContain('SAFE');
    expect(rug).toContain('CRITICAL RISK');
    expect(safe).not.toContain('CRITICAL RISK');
  });

  it('has accessibility aria-label', () => {
    const svg = renderBadgeSVG(72, 'safe', 'TEST');
    expect(svg).toContain('aria-label="Sentinel: 72 · SAFE"');
  });

  it('renders correctly for all 4 tiers', () => {
    const tiers: RiskTier[] = ['safe', 'caution', 'danger', 'rug'];
    for (const tier of tiers) {
      const svg = renderBadgeSVG(50, tier, 'T');
      expect(svg).toContain('Sentinel Score');
      expect(svg).toContain('</svg>');
    }
  });
});
