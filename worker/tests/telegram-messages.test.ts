import { describe, it, expect } from 'vitest';
import { buildLpDrainMessage, buildFeeAlertMessage } from '../src/notify/telegram';

describe('buildLpDrainMessage', () => {
  const BASE_ARGS = [
    'SOL',
    'Solana',
    'So11111111111111111111111111111111111111112',
    50_000,
    10_000,
    80,
    'critical' as const,
    'https://sentinel.example.com/token/So11',
  ] as const;

  it('includes token symbol and name', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('SOL');
    expect(msg).toContain('Solana');
  });

  it('shows shortened mint address', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('So11');
    expect(msg).toContain('1112');
    expect(msg).toContain('…');
  });

  it('shows liquidity before and after', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('50,000');
    expect(msg).toContain('10,000');
  });

  it('shows drop percentage', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('-80.0%');
  });

  it('uses RUG ALERT header for critical severity', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('🚨');
    expect(msg).toContain('LP DRAIN DETECTED');
    expect(msg).toContain('Severe drain');
  });

  it('uses Warning header for non-critical severity', () => {
    const msg = buildLpDrainMessage('SOL', 'Solana', 'So111', 50_000, 35_000, 30, 'warning', 'https://example.com');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('LP drain detected (early)');
    expect(msg.toLowerCase()).toContain('monitor closely');
  });

  it('includes dashboard link', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('https://sentinel.example.com/token/So11');
    expect(msg).toContain('View token on Sentinel');
  });

  it('uses HTML formatting', () => {
    const msg = buildLpDrainMessage(...BASE_ARGS);
    expect(msg).toContain('<b>');
    expect(msg).toContain('<code>');
    expect(msg).toContain('<a href=');
  });
});

describe('buildFeeAlertMessage', () => {
  it('uses URGENT header when criticalCount > 0', () => {
    const msg = buildFeeAlertMessage('Abc123xyz', 150, 80, 3, 5, 'https://sentinel.example.com');
    expect(msg).toContain('🚨');
    expect(msg).toContain('URGENT');
    expect(msg).toContain('3 token(s) at risk');
  });

  it('uses unclaimed fees header when urgentUsd > 1 but no critical', () => {
    const msg = buildFeeAlertMessage('Abc123xyz', 150, 50, 0, 5, 'https://sentinel.example.com');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('Unclaimed fees detected');
  });

  it('uses fee update header for low amounts', () => {
    const msg = buildFeeAlertMessage('Abc123xyz', 10, 0.5, 0, 2, 'https://sentinel.example.com');
    expect(msg).toContain('💰');
    expect(msg).toContain('Fee update');
  });

  it('shows shortened wallet address', () => {
    const msg = buildFeeAlertMessage('AbcDEFGhijKLM', 10, 0, 0, 1, 'https://example.com');
    expect(msg).toContain('AbcD');
    expect(msg).toContain('jKLM');
  });

  it('shows total and urgent amounts', () => {
    const msg = buildFeeAlertMessage('Abc123', 150.55, 80.20, 0, 5, 'https://example.com');
    expect(msg).toContain('$150.55');
    expect(msg).toContain('$80.20');
  });

  it('includes position count', () => {
    const msg = buildFeeAlertMessage('Abc123', 100, 0, 0, 7, 'https://example.com');
    expect(msg).toContain('7 position(s)');
  });

  it('appends claimId to URL when provided', () => {
    const msg = buildFeeAlertMessage('Abc123', 100, 50, 1, 3, 'https://example.com', 'claim-456');
    expect(msg).toContain('https://example.com?claim=claim-456');
  });

  it('uses base URL when no claimId', () => {
    const msg = buildFeeAlertMessage('Abc123', 100, 50, 1, 3, 'https://example.com');
    expect(msg).toContain('href="https://example.com"');
  });

  it('does not show urgent line when urgentUsd equals totalUsd', () => {
    const msg = buildFeeAlertMessage('Abc123', 100, 100, 2, 3, 'https://example.com');
    // When urgentUsd === totalUsd, the "Urgent (risky tokens)" line is skipped
    expect(msg).not.toContain('Urgent (risky tokens)');
  });
});
