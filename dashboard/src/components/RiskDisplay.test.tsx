import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreGauge, TierBadge } from './RiskDisplay';

describe('ScoreGauge', () => {
  it('renders numeric score', () => {
    render(<ScoreGauge score={75} tier="safe" />);
    expect(screen.getByText('75')).toBeInTheDocument();
  });

  it('shows tier label', () => {
    render(<ScoreGauge score={25} tier="danger" />);
    expect(screen.getByText('danger')).toBeInTheDocument();
  });
});

describe('TierBadge', () => {
  it('renders each tier label', () => {
    const { rerender } = render(<TierBadge tier="safe" />);
    expect(screen.getByText('safe')).toBeInTheDocument();
    rerender(<TierBadge tier="caution" />);
    expect(screen.getByText('caution')).toBeInTheDocument();
    rerender(<TierBadge tier="danger" />);
    expect(screen.getByText('danger')).toBeInTheDocument();
    rerender(<TierBadge tier="rug" />);
    expect(screen.getByText('rug')).toBeInTheDocument();
  });
});
