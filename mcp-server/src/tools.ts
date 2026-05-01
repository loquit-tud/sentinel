/**
 * MCP Tool definitions and handlers for Sentinel
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SentinelClient } from './client.js';

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function requireSolanaAddress(value: unknown, fieldName: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} is required`);
  }
  if (!SOLANA_ADDR_RE.test(text)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a valid Solana base58 address`);
  }
  return text;
}

function verdictFromTier(tier: string): string {
  switch (tier) {
    case 'safe':
      return 'LOW_RISK';
    case 'caution':
      return 'MEDIUM_RISK';
    case 'danger':
      return 'HIGH_RISK';
    case 'rug':
      return 'EXTREME_RISK';
    default:
      return 'UNKNOWN_RISK';
  }
}

function confidenceFromScore(score: number): 'high' | 'medium' {
  // Higher confidence near extremes, medium near boundaries.
  if (score <= 15 || score >= 85) return 'high';
  return 'medium';
}

function riskActionsByTier(tier: string): string[] {
  switch (tier) {
    case 'safe':
      return [
        'Monitor holder concentration and LP status periodically.',
        'Use position sizing limits despite low risk score.',
      ];
    case 'caution':
      return [
        'Reduce position size and tighten stop conditions.',
        'Re-check mint/freeze authority and LP lock before entry.',
      ];
    case 'danger':
      return [
        'Avoid new exposure until risk signals improve.',
        'If already exposed, prioritize de-risking and fee claims.',
      ];
    case 'rug':
      return [
        'Do not enter this token under normal risk policy.',
        'Exit exposure and avoid interacting with related contracts.',
      ];
    default:
      return ['Risk data incomplete. Re-run analysis shortly.'];
  }
}

export const tools = [
  {
    name: 'get_risk_score',
    description: `Get a decision-ready risk verdict (0-100) for any Solana token on Bags.fm.

Analyzes 8 weighted signals from 4 data sources:
- Honeypot risks (20%) — from RugCheck
- LP Lock status (15%) — from RugCheck
- Mint Authority (15%) — revoked = safe
- Freeze Authority (10%) — revoked = safe
- Top Holder concentration (15%) — from Helius DAS
- Liquidity depth (10%) — from Birdeye
- Volume health (10%) — from Birdeye
- Creator reputation (5%) — from Bags SDK

Returns a score with tier classification:
- 🟢 Safe (70-100): Low risk, fundamentals solid
- 🟡 Caution (40-69): Some flags, investigate further
- 🔴 Danger (10-39): Multiple red flags
- ⛔ Rug (0-9): Extremely high risk

Use this tool when a user asks: "is this safe?", "rug risk?", "should I enter/exit?".

Output is optimized for quick decisions:
- Verdict (LOW/MEDIUM/HIGH/EXTREME risk)
- Confidence
- Top weak signals
- Recommended actions`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        mint: {
          type: 'string',
          description: 'Solana token mint address (base58). Example: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (BONK)',
        },
      },
      required: ['mint'],
    },
  },
  {
    name: 'get_trending_tokens',
    description: `Get trending tokens on Bags.fm ranked by lifetime fees, with market context for fast triage.

Returns a list of tokens with: name, symbol, mint address, 24h volume, FDV, price change, lifetime fees, and risk score (if available).

Use this when a user asks what is hot now, where fees are accumulating, or which candidates deserve risk review first.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_claimable_fees',
    description: `Check unclaimed creator fees for a Solana wallet on Bags.fm and summarize claim opportunity.

Returns all token positions with claimable fees, including per-position amounts and total USD value.

Use this when a user asks about unclaimed earnings, claim timing, or cashflow available to claim now.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: {
          type: 'string',
          description: 'Solana wallet address (base58) to check for claimable fees',
        },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'compare_tokens',
    description: `Compare risk profiles of multiple Solana tokens side by side and rank safest options.

Fetches risk scores for 2-5 tokens and presents them in a comparison table. Useful for evaluating which token is safer to trade or invest in.

Use this when a user asks "which is safer" or needs a ranked shortlist before entry.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        mints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of 2-5 Solana token mint addresses to compare',
          minItems: 2,
          maxItems: 5,
        },
      },
      required: ['mints'],
    },
  },
  {
    name: 'get_wallet_xray',
    description: `Scan a Solana wallet and return portfolio health with flagged holdings.

Use this for wallet-level risk reviews ("is my wallet safe?").
Returns portfolio health score, number of flagged assets, and top risky holdings.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: {
          type: 'string',
          description: 'Solana wallet address (base58) to scan',
        },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'get_creator_profile',
    description: `Get creator reputation profile for a Solana wallet with rugged-history context.

Useful for due diligence on token creators: rugged history, average score, reputation tier, and risky tokens.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: {
          type: 'string',
          description: 'Creator wallet address (base58)',
        },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'get_service_status',
    description: `Get Sentinel API health and usage telemetry snapshot for demo readiness.

Use this tool before demos to verify service availability and show live traction metrics.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_partner_config',
    description: `Check Bags partner registration status and fee stats for a wallet.

Returns whether the wallet is registered as a Bags partner, current BPS allocation,
and claimed/unclaimed partner fees in both SOL and USD.

Use this to verify partner integration or check revenue from partner fees.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: { type: 'string', description: 'Partner wallet address (base58)' },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'check_token_gate',
    description: `Check $SENT token holding tier for a wallet.

Returns the wallet's $SENT balance and access tier:
- free: 0 $SENT (basic features only)
- holder: ≥1 $SENT (priority alerts, deeper scans, auto-claim)
- whale: ≥10,000 $SENT (API key, custom webhooks, bulk scanning)

Use this to verify premium access eligibility.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: { type: 'string', description: 'Solana wallet address (base58)' },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'get_app_info',
    description: `Get Sentinel app store profile and metadata.

Returns: name, tagline, description, category, token info, links, features list, version.
Useful for app store submissions, about pages, or integration docs.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_sent_fee_share',
    description: `Get the target $SENT token fee-share configuration.

Returns the planned allocation (creator/holders/dev/partner percentages) and
BPS values for on-chain fee-share config setup.

Use this to understand Sentinel's tokenomics and fee distribution.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_trade_quote',
    description: `Get a swap quote with integrated risk scoring for the output token.

Returns: expected output amount, price impact, and risk score/tier for the token you're buying.

Use this when a user asks "how much will I get if I swap X?", "is this trade safe?", or before recommending any trade.
Combines Jupiter-style quote data with Sentinel risk intelligence.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        inputMint: {
          type: 'string',
          description: 'Mint address of the token to sell (e.g., SOL mint: So11111111111111111111111111111111111111112)',
        },
        outputMint: {
          type: 'string',
          description: 'Mint address of the token to buy',
        },
        amount: {
          type: 'string',
          description: 'Amount to swap in lamports/smallest unit (e.g., "1000000000" for 1 SOL)',
        },
      },
      required: ['inputMint', 'outputMint', 'amount'],
    },
  },
  {
    name: 'get_smart_fees',
    description: `Get risk-aware fee claim recommendations for a wallet.

Unlike basic fee checking, this combines claimable amounts with risk scores to determine urgency:
- HIGH urgency: large claimable amount on a risky token (claim before potential rug)
- MEDIUM urgency: moderate amount, token is stable
- LOW urgency: small amount, safe to wait

Use this when a user asks "should I claim my fees now?", "which fees are urgent?", or "optimize my fee claims".`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: {
          type: 'string',
          description: 'Solana wallet address (base58)',
        },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'get_alert_feed',
    description: `Get the latest risk alerts detected by Sentinel's automated scanner.

Returns recent alerts including LP drain warnings, rug detections, and risk score changes.
Alerts have severity levels: critical, warning, info.

Use this when a user asks "any alerts?", "what's happening?", "any rugs detected?", or for a market safety overview.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

export async function handleToolCall(
  client: SentinelClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'get_risk_score': {
      const mint = requireSolanaAddress(args.mint, 'mint');
      const score = await client.getRiskScore(mint);

      const weakestSignals = Object.entries(score.breakdown)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([signal, value]) => ({ signal, value }));

      return {
        mint: score.mint,
        score: score.score,
        tier: score.tier,
        verdict: verdictFromTier(score.tier),
        confidence: confidenceFromScore(score.score),
        breakdown: score.breakdown,
        weakestSignals,
        recommendedActions: riskActionsByTier(score.tier),
        summary: `${score.tier.toUpperCase()} (${score.score}/100)`,
        cached: score.cached,
      };
    }

    case 'get_trending_tokens': {
      const tokens = await client.getTokenFeed();
      return {
        count: tokens.length,
        briefing: 'Top Bags tokens by lifetime fees. Start with high-fee, high-volume names and run risk scoring before action.',
        tokens: tokens.slice(0, 20).map((t) => ({
          name: t.name,
          symbol: t.symbol,
          mint: t.mint,
          volume24h: `$${t.volume24h.toLocaleString()}`,
          fdv: `$${t.fdv.toLocaleString()}`,
          priceChange24h: `${t.priceChangePct24h > 0 ? '+' : ''}${t.priceChangePct24h.toFixed(1)}%`,
          lifetimeFees: `$${t.lifetimeFees.toLocaleString()}`,
          riskScore: t.riskScore,
          riskTier: t.riskTier,
        })),
      };
    }

    case 'get_claimable_fees': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const snapshot = await client.getClaimableFees(wallet);

      const topPositions = snapshot.positions
        .slice()
        .sort((a, b) => b.claimableUsd - a.claimableUsd)
        .slice(0, 5);

      return {
        wallet: snapshot.wallet,
        totalClaimableUsd: `$${snapshot.totalClaimableUsd.toFixed(2)}`,
        positionCount: snapshot.positions.length,
        topPositions: topPositions.map((p) => ({
          token: `${p.tokenName} (${p.tokenSymbol})`,
          mint: p.tokenMint,
          claimable: `$${p.claimableUsd.toFixed(2)}`,
        })),
        recommendedAction:
          snapshot.totalClaimableUsd > 0
            ? 'Prepare and sign claim transactions for highest-value positions first.'
            : 'No immediate claim action required.',
        positions: snapshot.positions.map((p) => ({
          token: `${p.tokenName} (${p.tokenSymbol})`,
          mint: p.tokenMint,
          claimable: `$${p.claimableUsd.toFixed(2)}`,
        })),
      };
    }

    case 'compare_tokens': {
      const mints = args.mints as string[];
      if (!mints || mints.length < 2) {
        throw new McpError(ErrorCode.InvalidParams, 'mints must contain at least 2 addresses');
      }
      if (mints.length > 5) {
        throw new McpError(ErrorCode.InvalidParams, 'mints must contain at most 5 addresses');
      }

      for (const mint of mints) {
        if (!SOLANA_ADDR_RE.test(mint)) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid mint in mints: ${mint}`);
        }
      }

      const results = await Promise.allSettled(
        mints.map((m) => client.getRiskScore(m)),
      );

      const comparison = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          const s = r.value;
          return {
            mint: s.mint,
            score: s.score,
            tier: s.tier,
            breakdown: s.breakdown,
          };
        }
        return { mint: mints[i], error: 'Failed to fetch risk score' };
      });

      const safest = comparison
        .filter((c): c is typeof c & { score: number } => 'score' in c)
        .sort((a, b) => b.score - a.score)[0];

      return {
        comparison,
        ranking: comparison
          .filter((c): c is typeof c & { score: number } => 'score' in c)
          .sort((a, b) => b.score - a.score)
          .map((c) => ({ mint: c.mint, score: c.score, tier: c.tier })),
        recommendation: safest
          ? `Safest token: ${safest.mint} (score ${safest.score}/100, ${safest.tier})`
          : 'Could not determine safest token',
      };
    }

    case 'get_wallet_xray': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const xray = await client.getWalletXRay(wallet);

      const riskyHoldings = xray.holdings
        .filter((h) => typeof h.score === 'number' && h.score < 40)
        .sort((a, b) => (a.score ?? 999) - (b.score ?? 999))
        .slice(0, 10)
        .map((h) => ({ mint: h.mint, score: h.score, tier: h.tier, amount: h.amount }));

      return {
        wallet: xray.wallet,
        portfolioHealth: xray.portfolioHealth,
        portfolioVerdict: verdictFromTier(
          xray.portfolioHealth >= 70
            ? 'safe'
            : xray.portfolioHealth >= 40
              ? 'caution'
              : xray.portfolioHealth >= 10
                ? 'danger'
                : 'rug',
        ),
        flaggedCount: xray.flaggedCount,
        totalHoldingsScanned: xray.holdings.length,
        riskyHoldings,
        recommendedActions:
          xray.flaggedCount > 0
            ? ['Review flagged holdings first.', 'Reduce exposure to lowest-score assets.']
            : ['Portfolio risk is currently balanced. Continue periodic monitoring.'],
      };
    }

    case 'get_creator_profile': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const profile = await client.getCreatorProfile(wallet);

      return {
        wallet: profile.wallet,
        reputationScore: profile.reputationScore,
        reputationTier: profile.reputationTier,
        creatorVerdict: verdictFromTier(profile.reputationTier),
        totalTokens: profile.totalTokens,
        ruggedCount: profile.ruggedCount,
        safeCount: profile.safeCount,
        avgRiskScore: profile.avgRiskScore,
        riskiestTokens: profile.tokens.slice(0, 5).map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          riskScore: t.riskScore,
          riskTier: t.riskTier,
          rugged: t.rugged,
        })),
      };
    }

    case 'get_service_status': {
      const [health, stats] = await Promise.all([
        client.getHealth(),
        client.getStats(),
      ]);

      return {
        health,
        usage: {
          totalRequests: stats.totalRequests,
          todayRequests: stats.today.total,
          byEndpoint: stats.byEndpoint,
        },
        demoReady: health.status === 'ok',
      };
    }

    case 'get_partner_config': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const { config, registered } = await client.getPartnerConfig(wallet);

      if (!registered || !config) {
        return { wallet, registered: false, message: 'Not registered as a Bags partner. Use partner register flow to create on-chain config.' };
      }

      const stats = await client.getPartnerStats(wallet).catch(() => null);

      return {
        wallet,
        registered: true,
        bps: config.bps,
        bpsPct: `${(config.bps / 100).toFixed(2)}%`,
        totalLifetimeFees: config.totalLifetimeAccumulatedFees,
        stats: stats ? {
          claimed: `$${stats.claimedFeesUsd.toFixed(2)}`,
          unclaimed: `$${stats.unclaimedFeesUsd.toFixed(2)}`,
        } : null,
      };
    }

    case 'check_token_gate': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const gate = await client.checkTokenGate(wallet);

      return {
        wallet: gate.wallet,
        tier: gate.tier,
        sentBalance: gate.sentBalance,
        eligible: gate.eligible,
        tierDescription: gate.tier === 'whale' ? 'Full access (≥10,000 $SENT)'
          : gate.tier === 'holder' ? 'Premium access (≥1 $SENT)'
          : 'Free tier — hold $SENT to unlock premium features',
      };
    }

    case 'get_app_info': {
      const info = await client.getAppInfo();
      return {
        name: info.name,
        tagline: info.tagline,
        category: info.category,
        version: info.version,
        token: info.token,
        features: info.features,
        links: info.links,
      };
    }

    case 'get_sent_fee_share': {
      const config = await client.getSentFeeShare();
      return {
        token: `$${config.tokenSymbol} (${config.tokenMint})`,
        allocations: config.allocations,
        summary: `${config.allocations.creatorPct}% creator / ${config.allocations.holdersPct}% holders / ${config.allocations.devFundPct}% dev / ${config.allocations.partnerPct}% partner`,
        feeClaimers: config.feeClaimers.map(fc => `${fc.label}: ${fc.bps} bps`),
      };
    }

    case 'get_trade_quote': {
      const inputMint = typeof args.inputMint === 'string' ? args.inputMint.trim() : '';
      const outputMint = typeof args.outputMint === 'string' ? args.outputMint.trim() : '';
      const amount = typeof args.amount === 'string' ? args.amount.trim() : '';

      if (!inputMint || !outputMint || !amount) {
        throw new McpError(ErrorCode.InvalidParams, 'inputMint, outputMint, and amount are required');
      }

      const quote = await client.getTradeQuote(inputMint, outputMint, amount);

      return {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpact: `${quote.priceImpactPct.toFixed(2)}%`,
        riskScore: quote.riskScore,
        riskTier: quote.riskTier,
        riskVerdict: quote.riskTier ? verdictFromTier(quote.riskTier) : 'NO_DATA',
        safeToTrade: quote.riskScore !== null && quote.riskScore >= 40,
        warning: quote.riskScore !== null && quote.riskScore < 40
          ? `⚠️ Output token has ${verdictFromTier(quote.riskTier || '')} score (${quote.riskScore}/100). Consider alternatives.`
          : null,
      };
    }

    case 'get_smart_fees': {
      const wallet = requireSolanaAddress(args.wallet, 'wallet');
      const snapshot = await client.getSmartFees(wallet);

      const byUrgency = {
        high: snapshot.positions.filter(p => p.urgency === 'high'),
        medium: snapshot.positions.filter(p => p.urgency === 'medium'),
        low: snapshot.positions.filter(p => p.urgency === 'low'),
      };

      return {
        wallet: snapshot.wallet,
        totalClaimableUsd: `$${snapshot.totalClaimableUsd.toFixed(2)}`,
        highUrgencyCount: snapshot.highUrgencyCount,
        urgencyBreakdown: {
          high: byUrgency.high.map(p => ({ token: p.tokenSymbol, claimable: `$${p.claimableUsd.toFixed(2)}`, riskTier: p.riskTier })),
          medium: byUrgency.medium.map(p => ({ token: p.tokenSymbol, claimable: `$${p.claimableUsd.toFixed(2)}` })),
          low: byUrgency.low.map(p => ({ token: p.tokenSymbol, claimable: `$${p.claimableUsd.toFixed(2)}` })),
        },
        recommendation: snapshot.highUrgencyCount > 0
          ? `⚠️ ${snapshot.highUrgencyCount} high-urgency positions. Claim fees from risky tokens FIRST before potential LP drain.`
          : snapshot.totalClaimableUsd > 5
            ? 'Fees available. Safe to claim at your convenience — no urgent risks detected.'
            : 'Minimal fees. Wait for accumulation before claiming to save on gas.',
      };
    }

    case 'get_alert_feed': {
      const alerts = await client.getAlertFeed();

      const criticalAlerts = alerts.filter(a => a.severity === 'critical');
      const warningAlerts = alerts.filter(a => a.severity === 'warning');

      return {
        totalAlerts: alerts.length,
        critical: criticalAlerts.length,
        warnings: warningAlerts.length,
        recentAlerts: alerts.slice(0, 10).map(a => ({
          type: a.type,
          severity: a.severity,
          mint: a.mint,
          message: a.message,
          time: new Date(a.timestamp).toISOString(),
        })),
        summary: criticalAlerts.length > 0
          ? `🚨 ${criticalAlerts.length} CRITICAL alerts. Check immediately for LP drains or rug detections.`
          : warningAlerts.length > 0
            ? `⚠️ ${warningAlerts.length} warnings detected. Review flagged tokens.`
            : '✅ No active alerts. Market conditions appear stable.',
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }
}
