import { describe, it, expect } from 'vitest';
import { tierFromScore } from '../../shared/types';

describe('tierFromScore', () => {
  it('returns safe for scores >= 70', () => {
    expect(tierFromScore(70)).toBe('safe');
    expect(tierFromScore(85)).toBe('safe');
    expect(tierFromScore(100)).toBe('safe');
  });

  it('returns caution for scores 40-69', () => {
    expect(tierFromScore(40)).toBe('caution');
    expect(tierFromScore(55)).toBe('caution');
    expect(tierFromScore(69)).toBe('caution');
  });

  it('returns danger for scores 10-39', () => {
    expect(tierFromScore(10)).toBe('danger');
    expect(tierFromScore(25)).toBe('danger');
    expect(tierFromScore(39)).toBe('danger');
  });

  it('returns rug for scores < 10', () => {
    expect(tierFromScore(0)).toBe('rug');
    expect(tierFromScore(5)).toBe('rug');
    expect(tierFromScore(9)).toBe('rug');
  });
});
