/**
 * Message Helpers — consolidated Telegram message template builders.
 *
 * Encapsulates: confidence line, risk line, market line, LP lock/mint lines.
 */

export interface MessageLineParams {
  riskScore?: number;
  riskTier?: string;
  dataConfidence?: number;
  missingSignals?: string[];
  marketPubkey?: string;
  lpMint?: string;
  lpLockedPct?: number;
  lpLockedUsd?: number;
}

/**
 * Build data confidence line with optional missing signals.
 */
export function buildConfidenceLine(dataConfidence?: number, missingSignals?: string[]): string | null {
  const missing = (missingSignals ?? []).filter(Boolean);
  if (typeof dataConfidence === 'number') {
    return `📌 Data confidence: <b>${Math.round(dataConfidence * 100)}%</b>` +
      (missing.length > 0 ? ` · missing: <code>${missing.join(', ')}</code>` : '');
  }
  if (missing.length > 0) {
    return `📌 Missing signals: <code>${missing.join(', ')}</code>`;
  }
  return null;
}

/**
 * Build risk score line.
 */
export function buildRiskLine(riskScore?: number, riskTier?: string): string | null {
  if (typeof riskScore === 'number' && riskTier) {
    return `🧠 Risk score: <b>${riskScore}/100</b> (${String(riskTier).toUpperCase()})`;
  }
  return null;
}

/**
 * Build market pubkey line (truncated).
 */
export function buildMarketLine(marketPubkey?: string): string | null {
  if (marketPubkey) {
    return `🏊 Pool: <code>${marketPubkey.slice(0, 4)}…${marketPubkey.slice(-4)}</code>`;
  }
  return null;
}

/**
 * Build LP locked percentage/USD line.
 */
export function buildLpLockLine(lpLockedPct?: number, lpLockedUsd?: number): string | null {
  if (typeof lpLockedPct === 'number') {
    return `🔒 LP locked: <b>${lpLockedPct.toFixed(0)}%</b>` +
      (typeof lpLockedUsd === 'number' ? ` (~$${lpLockedUsd.toLocaleString()})` : '');
  }
  return null;
}

/**
 * Build LP mint line (truncated).
 */
export function buildLpMintLine(lpMint?: string): string | null {
  if (lpMint) {
    return `🧾 LP mint: <code>${lpMint.slice(0, 4)}…${lpMint.slice(-4)}</code>`;
  }
  return null;
}

/**
 * Build all message lines from params object.
 */
export function buildMessageLines(params: MessageLineParams): string[] {
  return [
    buildRiskLine(params.riskScore, params.riskTier),
    buildConfidenceLine(params.dataConfidence, params.missingSignals),
    buildMarketLine(params.marketPubkey),
    buildLpLockLine(params.lpLockedPct, params.lpLockedUsd),
    buildLpMintLine(params.lpMint),
  ].filter(Boolean) as string[];
}
