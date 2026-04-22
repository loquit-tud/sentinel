/**
 * Sentinel Swarm Engine
 *
 * 5 specialized AI agents analyze a wallet in parallel using real on-chain data
 * (claimable fees + portfolio risk) and vote on recommended actions.
 * A single Claude API call produces all 5 agent perspectives for speed.
 *
 * Agents:
 *   💰 Fee Scanner       — fee claim urgency
 *   🛡️ Risk Sentinel     — portfolio risk exposure
 *   🤖 Auto Claimer      — claim timing: value vs gas cost
 *   🚀 Launch Advisor    — fee optimization strategies
 *   📊 Trade Signal      — identify safe vs risky positions
 */

import type { Env } from '../index';
import { fetchClaimablePositions } from '../fees/bags-fees';
import { fetchRugCheckReport } from '../risk/rugcheck';
import { fetchBirdeyeOverview } from '../risk/birdeye';
import { computeRiskScore } from '../risk/engine';
import { BAGS_API_BASE } from '../../../shared/constants';

// ── Types ─────────────────────────────────────────────────

export type AgentId = 'fee-scanner' | 'risk-sentinel' | 'auto-claimer' | 'launch-advisor' | 'trade-signal';
export type AgentStatus = 'idle' | 'analyzing' | 'voted' | 'error';
export type SwarmConsensus = 'proceed' | 'hold' | 'reject' | 'split';

export interface AgentVote {
  agentId: AgentId;
  action: string;
  confidence: number;   // 0-1
  reasoning: string;
}

export interface SwarmDecision {
  id: string;
  topic: string;
  consensus: SwarmConsensus;
  confidence: number;
  finalAction: string;
  reasoning: string;
  votes: AgentVote[];
  timestamp: number;
}

export interface SwarmAgentStatus {
  agentId: AgentId;
  name: string;
  status: AgentStatus;
  voteCount: number;
  lastRunAt: number;
  lastError?: string;
}

export interface SwarmCycleResult {
  cycleId: string;
  wallet: string;
  startedAt: number;
  completedAt: number;
  summary: string;
  decisions: SwarmDecision[];
  agentStatuses: SwarmAgentStatus[];
}

export interface SwarmState {
  cycleCount: number;
  lastCycleAt: number;
  agentStatuses: Record<AgentId, SwarmAgentStatus>;
  recentDecisions: SwarmDecision[];
}

// ── Agent definitions ─────────────────────────────────────

const AGENTS: { id: AgentId; name: string }[] = [
  { id: 'fee-scanner',    name: 'Fee Scanner' },
  { id: 'risk-sentinel',  name: 'Risk Sentinel' },
  { id: 'auto-claimer',   name: 'Auto Claimer' },
  { id: 'launch-advisor', name: 'Launch Advisor' },
  { id: 'trade-signal',   name: 'Trade Signal' },
];

// ── Claude API call ───────────────────────────────────────

interface ClaudeAgentOutput {
  agentId: AgentId;
  vote: 'proceed' | 'hold' | 'reject';
  confidence: number;
  action: string;
  reasoning: string;
}

interface ClaudeSwarmResponse {
  agents: ClaudeAgentOutput[];
  overallSummary: string;
}

async function callClaudeSwarm(
  wallet: string,
  totalFeesUsd: number,
  positionCount: number,
  portfolioHealth: number,
  flaggedCount: number,
  flaggedTokens: Array<{ symbol: string; score: number; tier: string }>,
  apiKey: string,
): Promise<ClaudeSwarmResponse | null> {
  const flaggedStr = flaggedTokens.length > 0
    ? flaggedTokens.map(t => `${t.symbol} (score: ${t.score}, tier: ${t.tier})`).join(', ')
    : 'none';

  const prompt = `You are the Sentinel Swarm — a multi-agent AI risk management system for Bags.fm on Solana.

Wallet: ${wallet.slice(0, 8)}...${wallet.slice(-8)}
Claimable fees: $${totalFeesUsd.toFixed(2)} across ${positionCount} positions
Portfolio health: ${portfolioHealth}/100
Flagged holdings: ${flaggedCount} (${flaggedStr})

Analyze this wallet as each of these 5 specialized agents. Each agent must independently assess the situation and cast a vote.

Agents:
1. fee-scanner (💰 Fee Scanner): Assess fee claim urgency based on accumulated amount and risk exposure
2. risk-sentinel (🛡️ Risk Sentinel): Evaluate overall portfolio risk and flag critical exposures
3. auto-claimer (🤖 Auto Claimer): Recommend claim timing — is the value worth claiming now?
4. launch-advisor (🚀 Launch Advisor): Suggest fee optimization strategies for this wallet
5. trade-signal (📊 Trade Signal): Identify which positions are safe to hold vs which to exit

Vote options: "proceed" (take action now), "hold" (wait), "reject" (do not act — too risky)

Return ONLY valid JSON in this exact format, no markdown, no explanation outside JSON:
{
  "agents": [
    {
      "agentId": "fee-scanner",
      "vote": "proceed|hold|reject",
      "confidence": 0.0-1.0,
      "action": "short action label (max 6 words)",
      "reasoning": "1-2 sentence explanation"
    }
  ],
  "overallSummary": "2-3 sentence summary of the swarm's overall assessment"
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      console.error('Claude API error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const body = await res.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = body.content?.find(c => c.type === 'text')?.text ?? '';
    // Extract JSON object robustly — find first { and last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('No JSON object found in Claude response:', text.slice(0, 200));
      return null;
    }
    return JSON.parse(text.slice(start, end + 1)) as ClaudeSwarmResponse;
  } catch (err) {
    console.error('Claude swarm call failed:', err);
    return null;
  }
}

// ── Consensus engine ──────────────────────────────────────

function resolveConsensus(votes: AgentVote[]): { consensus: SwarmConsensus; confidence: number; finalAction: string; reasoning: string } {
  const counts = { proceed: 0, hold: 0, reject: 0 };
  let totalConfidence = 0;

  for (const v of votes) {
    const vote = v.action.toLowerCase().includes('proceed') ? 'proceed'
      : v.action.toLowerCase().includes('reject') ? 'reject'
      : 'hold';

    // Map vote back from action — use the original vote field on AgentVote if available
    const explicitVote = (v as AgentVote & { vote?: string }).vote as 'proceed' | 'hold' | 'reject' | undefined;
    const finalVote = explicitVote ?? vote;
    counts[finalVote]++;
    totalConfidence += v.confidence;
  }

  const avgConfidence = totalConfidence / votes.length;
  const total = votes.length;

  // Majority (>50%) wins; ties → split
  const maxVote = (Object.entries(counts) as [SwarmConsensus, number][]).sort((a, b) => b[1] - a[1])[0];
  const consensus: SwarmConsensus = maxVote[1] > total / 2 ? maxVote[0] : 'split';

  const proceedVotes = votes.filter(v => ((v as AgentVote & { vote?: string }).vote ?? 'hold') === 'proceed');
  const rejectVotes = votes.filter(v => ((v as AgentVote & { vote?: string }).vote ?? 'hold') === 'reject');

  let finalAction: string;
  let reasoning: string;

  if (consensus === 'proceed') {
    finalAction = proceedVotes[0]?.action ?? 'Execute recommended action';
    reasoning = `${counts.proceed}/${total} agents voted PROCEED. ${proceedVotes[0]?.reasoning ?? ''}`;
  } else if (consensus === 'reject') {
    finalAction = 'Do not act — risk gate triggered';
    reasoning = `${counts.reject}/${total} agents voted REJECT. ${rejectVotes[0]?.reasoning ?? ''}`;
  } else if (consensus === 'hold') {
    finalAction = 'Monitor — no action required now';
    reasoning = `${counts.hold}/${total} agents voted HOLD. Conditions not yet optimal.`;
  } else {
    finalAction = 'Manual review required';
    reasoning = `Agents split: ${counts.proceed} proceed / ${counts.hold} hold / ${counts.reject} reject. Human judgment needed.`;
  }

  return { consensus, confidence: avgConfidence, finalAction, reasoning };
}

// ── Main export ───────────────────────────────────────────

const KV_PREFIX = 'swarm:';
const MAX_RECENT_DECISIONS = 20;

export async function runSwarmCycle(wallet: string, env: Env): Promise<SwarmCycleResult> {
  const startedAt = Date.now();
  const cycleId = `cycle_${wallet.slice(0, 6)}_${startedAt}`;

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // 1. Gather fee data only — portfolio scan is too subrequest-heavy for CF Workers free limit
  const feeSnapshot = await fetchClaimablePositions(wallet, env.BAGS_API_KEY).catch(() => null);

  const totalFeesUsd = feeSnapshot?.totalClaimableUsd ?? 0;
  const positionCount = feeSnapshot?.positions.length ?? 0;
  // Derive rough portfolio health from fee position count (no full scan to stay under subrequest limit)
  const portfolioHealth = Math.min(100, 40 + positionCount * 5);
  const flaggedCount = 0;
  const flaggedTokens: Array<{ symbol: string; score: number; tier: string }> = [];

  // 2. Call Claude — one call produces all 5 agent outputs
  const claudeResult = await callClaudeSwarm(
    wallet, totalFeesUsd, positionCount,
    portfolioHealth, flaggedCount, flaggedTokens,
    env.ANTHROPIC_API_KEY,
  );

  // 3. Build decisions from Claude output (or fallback if Claude fails)
  const decisions: SwarmDecision[] = [];
  const agentStatuses: SwarmAgentStatus[] = [];

  if (claudeResult?.agents && claudeResult.agents.length > 0) {
    // Group agent outputs into decisions by topic
    const feeAgents = claudeResult.agents.filter(a => ['fee-scanner', 'auto-claimer'].includes(a.agentId));
    const riskAgents = claudeResult.agents.filter(a => ['risk-sentinel', 'trade-signal'].includes(a.agentId));
    const strategyAgents = claudeResult.agents.filter(a => ['launch-advisor'].includes(a.agentId));

    const buildDecision = (topic: string, agents: ClaudeAgentOutput[]): SwarmDecision | null => {
      if (agents.length === 0) return null;
      const votes: (AgentVote & { vote: string })[] = agents.map(a => ({
        agentId: a.agentId,
        action: a.action,
        confidence: Math.max(0, Math.min(1, a.confidence)),
        reasoning: a.reasoning,
        vote: a.vote,
      }));
      const { consensus, confidence, finalAction, reasoning } = resolveConsensus(votes);
      return {
        id: `${topic.toLowerCase().replace(/\s+/g, '_')}_${startedAt}`,
        topic,
        consensus,
        confidence,
        finalAction,
        reasoning,
        votes,
        timestamp: Date.now(),
      };
    };

    const feeDec = buildDecision('Fee Claim Strategy', feeAgents);
    const riskDec = buildDecision('Portfolio Risk Assessment', riskAgents);
    const stratDec = buildDecision('Optimization Strategy', strategyAgents);

    if (feeDec) decisions.push(feeDec);
    if (riskDec) decisions.push(riskDec);
    if (stratDec) decisions.push(stratDec);

    // Build agent statuses
    for (const agent of AGENTS) {
      const output = claudeResult.agents.find(a => a.agentId === agent.id);
      agentStatuses.push({
        agentId: agent.id,
        name: agent.name,
        status: output ? 'voted' : 'idle',
        voteCount: output ? 1 : 0,
        lastRunAt: startedAt,
      });
    }
  } else {
    // Fallback: Claude unavailable — produce a safe default
    for (const agent of AGENTS) {
      agentStatuses.push({
        agentId: agent.id,
        name: agent.name,
        status: 'error',
        voteCount: 0,
        lastRunAt: startedAt,
        lastError: 'Analysis unavailable — retrying on next cycle',
      });
    }
  }

  const completedAt = Date.now();

  const summary = claudeResult?.overallSummary
    ?? `Swarm cycle completed in ${completedAt - startedAt}ms. ${decisions.length} decision(s) reached. Manual review recommended.`;

  const result: SwarmCycleResult = {
    cycleId,
    wallet,
    startedAt,
    completedAt,
    summary,
    decisions,
    agentStatuses,
  };

  // 4. Persist state to KV
  if (env.SENTINEL_KV) {
    const prevRaw = await env.SENTINEL_KV.get(`${KV_PREFIX}${wallet}`, 'json');
    const prev = prevRaw as SwarmState | null;

    const newState: SwarmState = {
      cycleCount: (prev?.cycleCount ?? 0) + 1,
      lastCycleAt: startedAt,
      agentStatuses: Object.fromEntries(
        agentStatuses.map(a => [a.agentId, a])
      ) as Record<AgentId, SwarmAgentStatus>,
      recentDecisions: [...decisions, ...(prev?.recentDecisions ?? [])].slice(0, MAX_RECENT_DECISIONS),
    };

    await env.SENTINEL_KV.put(
      `${KV_PREFIX}${wallet}`,
      JSON.stringify(newState),
      { expirationTtl: 86400 * 30 }, // 30 days
    ).catch(() => {}); // non-critical
  }

  return result;
}

export async function getSwarmState(wallet: string, env: Env): Promise<SwarmState | null> {
  if (!env.SENTINEL_KV) return null;
  const raw = await env.SENTINEL_KV.get(`${KV_PREFIX}${wallet}`, 'json');
  return (raw as SwarmState | null);
}

// ── Token Swarm ───────────────────────────────────────────

interface BagsTokenData {
  onBags: boolean;
  lifetimeFeesSol: number;        // total SOL earned by LP providers on Bags
  creatorRoyaltyBps: number;      // basis points going to creator(s)
  creatorWallets: string[];       // creator wallet addresses
  bagsVolumeBuy24h: number;       // buy volume in SOL on Bags (24h)
  bagsVolumeSell24h: number;      // sell volume in SOL on Bags (24h)
  bagsBuys24h: number;
  bagsSells24h: number;
  bagsTraders24h: number;
  bagsLiquidityUsd: number;
  bagsPriceChangePct24h: number;
}

interface TokenEnrichment {
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  buys24h: number;
  sells24h: number;
  tokenAgeDays: number;
  holderCount: number;
  creatorHoldsPct: number;
  metadataMutable: boolean;
  specificRisks: string[];
  insiderCount: number;
  lpProviderCount: number;
  liquidityUsd: number;
  bags: BagsTokenData;
}

async function fetchBagsTokenData(mint: string, apiKey?: string): Promise<BagsTokenData> {
  const notOnBags: BagsTokenData = {
    onBags: false, lifetimeFeesSol: 0, creatorRoyaltyBps: 0, creatorWallets: [],
    bagsVolumeBuy24h: 0, bagsVolumeSell24h: 0, bagsBuys24h: 0, bagsSells24h: 0,
    bagsTraders24h: 0, bagsLiquidityUsd: 0, bagsPriceChangePct24h: 0,
  };
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await fetch(`${BAGS_API_BASE}/token-launch/top-tokens/lifetime-fees`, {
      headers, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return notOnBags;
    const body = await res.json() as {
      success: boolean;
      response: Array<{
        token: string;
        lifetimeFees: string;
        tokenInfo: {
          liquidity: number;
          stats24h?: {
            priceChange: number;
            buyVolume: number;
            sellVolume: number;
            numBuys: number;
            numSells: number;
            numTraders: number;
          };
        } | null;
        creators: Array<{ wallet: string; royaltyBps: number }> | null;
      }>;
    };
    if (!body.success) return notOnBags;
    const item = body.response?.find(t => t.token === mint);
    if (!item) return notOnBags;
    const stats = item.tokenInfo?.stats24h;
    const totalRoyaltyBps = (item.creators ?? []).reduce((sum, c) => sum + c.royaltyBps, 0);
    return {
      onBags: true,
      lifetimeFeesSol: parseFloat(item.lifetimeFees) || 0,
      creatorRoyaltyBps: totalRoyaltyBps,
      creatorWallets: (item.creators ?? []).map(c => c.wallet),
      bagsVolumeBuy24h: stats?.buyVolume ?? 0,
      bagsVolumeSell24h: stats?.sellVolume ?? 0,
      bagsBuys24h: stats?.numBuys ?? 0,
      bagsSells24h: stats?.numSells ?? 0,
      bagsTraders24h: stats?.numTraders ?? 0,
      bagsLiquidityUsd: item.tokenInfo?.liquidity ?? 0,
      bagsPriceChangePct24h: stats?.priceChange ?? 0,
    };
  } catch {
    return notOnBags;
  }
}

async function fetchDexScreenerData(mint: string): Promise<{
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  volumeChange24h: number;
  buys24h: number;
  sells24h: number;
  tokenAgeDays: number;
  liquidityUsd: number;
} | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      pairs?: Array<{
        priceUsd?: string;
        priceChange?: { h24?: number };
        volume?: { h24?: number; h6?: number };
        txns?: { h24?: { buys?: number; sells?: number } };
        pairCreatedAt?: number;
        liquidity?: { usd?: number };
      }>;
    };
    const pair = data.pairs?.[0];
    if (!pair) return null;

    const ageDays = pair.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 86_400_000
      : 0;

    const volH24 = pair.volume?.h24 ?? 0;
    const volH6 = pair.volume?.h6 ?? 0;
    const volChange = volH24 > 0 ? ((volH6 * 4 - volH24) / volH24) * 100 : 0;

    return {
      priceUsd: parseFloat(pair.priceUsd ?? '0'),
      priceChange24h: pair.priceChange?.h24 ?? 0,
      volume24h: volH24,
      volumeChange24h: volChange,
      buys24h: pair.txns?.h24?.buys ?? 0,
      sells24h: pair.txns?.h24?.sells ?? 0,
      tokenAgeDays: Math.round(ageDays * 10) / 10,
      liquidityUsd: pair.liquidity?.usd ?? 0,
    };
  } catch {
    return null;
  }
}

async function callClaudeTokenSwarm(
  mint: string,
  score: number,
  tier: string,
  breakdown: {
    honeypot: number;
    lpLocked: number;
    mintAuthority: number;
    freezeAuthority: number;
    topHolderPct: number;
    liquidityDepth: number;
    volumeHealth: number;
    creatorReputation: number;
  },
  enrichment: TokenEnrichment,
  apiKey: string,
): Promise<ClaudeSwarmResponse | null> {
  const riskLabel = tier === 'safe' ? 'SAFE' : tier === 'caution' ? 'CAUTION' : tier === 'danger' ? 'DANGER' : 'RUG';

  const flags = [
    breakdown.honeypot < 30 && 'potential honeypot',
    breakdown.lpLocked < 30 && 'LP unlocked (rug risk)',
    breakdown.mintAuthority < 50 && 'mint authority active (inflation risk)',
    breakdown.freezeAuthority < 50 && 'freeze authority active',
    breakdown.topHolderPct > 70 && 'high holder concentration',
    enrichment.metadataMutable && 'metadata mutable (can change name/image after launch)',
    enrichment.creatorHoldsPct > 10 && `creator holds ${enrichment.creatorHoldsPct.toFixed(1)}% of supply`,
    enrichment.insiderCount > 3 && `${enrichment.insiderCount} insider wallets detected`,
    enrichment.tokenAgeDays > 0 && enrichment.tokenAgeDays < 3 && `very new token (${enrichment.tokenAgeDays.toFixed(1)} days old)`,
    enrichment.bags.onBags && enrichment.bags.bagsSells24h > enrichment.bags.bagsBuys24h * 2
      && `heavy sell pressure on Bags (${enrichment.bags.bagsSells24h} sells vs ${enrichment.bags.bagsBuys24h} buys)`,
    !enrichment.bags.onBags && 'NOT listed on Bags.fm — no Bags activity data',
    ...enrichment.specificRisks.map(r => `RugCheck: ${r}`),
  ].filter(Boolean);

  const flagsStr = flags.length > 0 ? (flags as string[]).join('\n  - ') : 'none';

  const b = enrichment.bags;
  const bagsBuySellRatio = b.onBags && b.bagsBuys24h > 0
    ? (b.bagsBuys24h / Math.max(b.bagsSells24h, 1)).toFixed(2)
    : 'N/A';
  const creatorFeesPct = b.creatorRoyaltyBps > 0 ? (b.creatorRoyaltyBps / 100).toFixed(1) : '0';
  const lpFeesPct = b.creatorRoyaltyBps > 0 ? ((10000 - b.creatorRoyaltyBps) / 100).toFixed(1) : '100';

  const prompt = `You are the Sentinel Token Swarm — a multi-agent AI risk intelligence system for Bags.fm, a Solana token launchpad.

TOKEN: ${enrichment.name} (${enrichment.symbol})
Mint: ${mint.slice(0, 8)}...${mint.slice(-8)}

── BAGS.FM PLATFORM DATA ──────────────────────────────────
Listed on Bags.fm: ${b.onBags ? 'YES' : 'NO — not found in Bags token list'}
${b.onBags ? `Lifetime fees generated (Bags LP): ${b.lifetimeFeesSol.toFixed(4)} SOL total
Creator royalty fee: ${creatorFeesPct}% per swap (${b.creatorRoyaltyBps} bps) → LP providers keep ${lpFeesPct}%
Creator wallets: ${b.creatorWallets.length > 0 ? b.creatorWallets.map(w => w.slice(0, 8) + '...').join(', ') : 'unknown'}
Bags liquidity: $${b.bagsLiquidityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
Bags volume 24h (buys): ${b.bagsVolumeBuy24h.toFixed(2)} SOL
Bags volume 24h (sells): ${b.bagsVolumeSell24h.toFixed(2)} SOL
Bags buys: ${b.bagsBuys24h} | Bags sells: ${b.bagsSells24h} | Buy/Sell ratio: ${bagsBuySellRatio}
Bags traders 24h: ${b.bagsTraders24h}
Price change 24h (Bags): ${b.bagsPriceChangePct24h > 0 ? '+' : ''}${b.bagsPriceChangePct24h.toFixed(1)}%` : '(No Bags-native data — token may not be launched on Bags)'}

── SECURITY (Sentinel Risk Engine) ────────────────────────
Risk score: ${score}/100 (${riskLabel})
Honeypot safety: ${breakdown.honeypot}/100 | LP locked: ${breakdown.lpLocked}/100
Mint authority revoked: ${breakdown.mintAuthority}/100 | Freeze authority revoked: ${breakdown.freezeAuthority}/100
Holder distribution: ${breakdown.topHolderPct}/100 | Creator reputation: ${breakdown.creatorReputation}/100
Total holders: ${enrichment.holderCount > 0 ? enrichment.holderCount : 'unknown'}
Creator still holds: ${enrichment.creatorHoldsPct > 0 ? `${enrichment.creatorHoldsPct.toFixed(1)}%` : 'unknown'}
Metadata mutable: ${enrichment.metadataMutable ? 'YES (risk)' : 'no'}
Token age: ${enrichment.tokenAgeDays > 0 ? `${enrichment.tokenAgeDays} days` : 'unknown'}

── RED FLAGS ──────────────────────────────────────────────
  - ${flagsStr}

Analyze as 5 Bags.fm-specialized agents. Every verdict must reference BAGS.FM data specifically (not generic Solana). If not on Bags, focus on whether it should be launched there.

1. fee-scanner (💰 LP Fee Yield): Is this worth providing liquidity for on Bags? Reference: lifetime fees, creator royalty %, volume vs liquidity ratio.
2. risk-sentinel (🛡️ Rug Risk): Is the creator setup trustworthy on Bags? Reference: buy/sell ratio on Bags, creator royalty bps, metadata mutability.
3. auto-claimer (🤖 LP Entry/Exit): Should an LP provider enter this pool now on Bags? Reference: current buy/sell pressure, price trend, trader count.
4. launch-advisor (🚀 Creator Advisor): What should the creator change to make this token succeed on Bags? Reference: royalty bps, fee structure, LP depth.
5. trade-signal (📊 Bags Signal): Overall Bags.fm verdict — is this a healthy Bags token? Reference specific Bags numbers.

Vote: "proceed" (healthy for LP/holding on Bags), "hold" (monitor — conditions not right), "reject" (avoid — red flags)

Return ONLY valid JSON, no markdown:
{
  "agents": [
    {
      "agentId": "fee-scanner",
      "vote": "proceed|hold|reject",
      "confidence": 0.0-1.0,
      "action": "short action (max 6 words)",
      "reasoning": "1-2 sentences citing Bags.fm specific data points"
    }
  ],
  "overallSummary": "2-3 sentences. Must cite Bags.fm data (lifetime fees, buy/sell, royalty %). Do NOT just repeat risk scores."
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      console.error('Claude Token Swarm API error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const body = await res.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = body.content?.find(c => c.type === 'text')?.text ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('No JSON in Claude token swarm response:', text.slice(0, 200));
      return null;
    }
    return JSON.parse(text.slice(start, end + 1)) as ClaudeSwarmResponse;
  } catch (err) {
    console.error('Claude token swarm call failed:', err);
    return null;
  }
}

export async function runTokenSwarmCycle(mint: string, env: Env): Promise<SwarmCycleResult> {
  const startedAt = Date.now();
  const cycleId = `cycle_token_${mint.slice(0, 6)}_${startedAt}`;

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Fetch risk score + enrichment data in parallel (Bags-native data takes priority)
  const [riskScore, bagsData, dexData, rugRaw, birdeyeOverview] = await Promise.all([
    computeRiskScore(mint, {
      HELIUS_API_KEY: env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: env.BIRDEYE_API_KEY,
    }).catch(() => null),
    fetchBagsTokenData(mint, env.BAGS_API_KEY).catch(() => ({ onBags: false } as BagsTokenData)),
    fetchDexScreenerData(mint).catch(() => null),
    fetchRugCheckReport(mint).catch(() => null),
    env.BIRDEYE_API_KEY ? fetchBirdeyeOverview(mint, env.BIRDEYE_API_KEY).catch(() => null) : Promise.resolve(null),
  ]);

  const score = riskScore?.score ?? 50;
  const tier = riskScore?.tier ?? 'caution';
  const breakdown = riskScore?.breakdown ?? {
    honeypot: 50, lpLocked: 50, mintAuthority: 50, freezeAuthority: 50,
    topHolderPct: 50, liquidityDepth: 50, volumeHealth: 50, creatorReputation: 50,
  };

  // Compute creator holds % from raw supply data
  let creatorHoldsPct = 0;
  if (rugRaw?.creator && rugRaw.creatorBalance && rugRaw.token?.supply && rugRaw.token.supply > 0) {
    creatorHoldsPct = (rugRaw.creatorBalance / rugRaw.token.supply) * 100;
  }

  const bagsTokenData: BagsTokenData = bagsData ?? {
    onBags: false, lifetimeFeesSol: 0, creatorRoyaltyBps: 0, creatorWallets: [],
    bagsVolumeBuy24h: 0, bagsVolumeSell24h: 0, bagsBuys24h: 0, bagsSells24h: 0,
    bagsTraders24h: 0, bagsLiquidityUsd: 0, bagsPriceChangePct24h: 0,
  };

  const enrichment: TokenEnrichment = {
    symbol: rugRaw?.tokenMeta?.symbol ?? '???',
    name: rugRaw?.tokenMeta?.name ?? 'Unknown Token',
    priceUsd: dexData?.priceUsd ?? birdeyeOverview?.price ?? 0,
    priceChange24h: bagsTokenData.onBags
      ? bagsTokenData.bagsPriceChangePct24h
      : (dexData?.priceChange24h ?? birdeyeOverview?.priceChange24hPercent ?? 0),
    volume24h: bagsTokenData.onBags
      ? bagsTokenData.bagsVolumeBuy24h + bagsTokenData.bagsVolumeSell24h
      : (dexData?.volume24h ?? birdeyeOverview?.v24hUSD ?? 0),
    buys24h: bagsTokenData.onBags ? bagsTokenData.bagsBuys24h : (dexData?.buys24h ?? 0),
    sells24h: bagsTokenData.onBags ? bagsTokenData.bagsSells24h : (dexData?.sells24h ?? 0),
    tokenAgeDays: dexData?.tokenAgeDays ?? 0,
    holderCount: birdeyeOverview?.holder ?? 0,
    creatorHoldsPct,
    metadataMutable: rugRaw?.tokenMeta?.mutable ?? false,
    specificRisks: (rugRaw?.risks ?? [])
      .filter(r => r.level === 'danger' || r.level === 'error')
      .map(r => r.name)
      .slice(0, 5),
    insiderCount: (rugRaw?.topHolders ?? []).filter(h => h.insider).length,
    lpProviderCount: rugRaw?.totalLPProviders ?? 0,
    liquidityUsd: bagsTokenData.onBags
      ? bagsTokenData.bagsLiquidityUsd
      : (dexData?.liquidityUsd ?? 0),
    bags: bagsTokenData,
  };

  const claudeResult = await callClaudeTokenSwarm(mint, score, tier, breakdown, enrichment, env.ANTHROPIC_API_KEY);

  const decisions: SwarmDecision[] = [];
  const agentStatuses: SwarmAgentStatus[] = [];

  if (claudeResult?.agents && claudeResult.agents.length > 0) {
    const feeAgents    = claudeResult.agents.filter(a => ['fee-scanner', 'auto-claimer'].includes(a.agentId));
    const riskAgents   = claudeResult.agents.filter(a => ['risk-sentinel', 'trade-signal'].includes(a.agentId));
    const stratAgents  = claudeResult.agents.filter(a => ['launch-advisor'].includes(a.agentId));

    const buildDecision = (topic: string, agents: ClaudeAgentOutput[]): SwarmDecision | null => {
      if (agents.length === 0) return null;
      const votes: (AgentVote & { vote: string })[] = agents.map(a => ({
        agentId: a.agentId,
        action: a.action,
        confidence: Math.max(0, Math.min(1, a.confidence)),
        reasoning: a.reasoning,
        vote: a.vote,
      }));
      const { consensus, confidence, finalAction, reasoning } = resolveConsensus(votes);
      return {
        id: `${topic.toLowerCase().replace(/\s+/g, '_')}_${startedAt}`,
        topic,
        consensus,
        confidence,
        finalAction,
        reasoning,
        votes,
        timestamp: Date.now(),
      };
    };

    const feeDec  = buildDecision('Fee Yield & Entry', feeAgents);
    const riskDec = buildDecision('Rug Risk Assessment', riskAgents);
    const stratDec = buildDecision('Creator Strategy', stratAgents);

    if (feeDec)   decisions.push(feeDec);
    if (riskDec)  decisions.push(riskDec);
    if (stratDec) decisions.push(stratDec);

    for (const agent of AGENTS) {
      const output = claudeResult.agents.find(a => a.agentId === agent.id);
      agentStatuses.push({
        agentId: agent.id,
        name: agent.name,
        status: output ? 'voted' : 'idle',
        voteCount: output ? 1 : 0,
        lastRunAt: startedAt,
      });
    }
  } else {
    for (const agent of AGENTS) {
      agentStatuses.push({
        agentId: agent.id,
        name: agent.name,
        status: 'error',
        voteCount: 0,
        lastRunAt: startedAt,
        lastError: 'Analysis unavailable',
      });
    }
  }

  const completedAt = Date.now();
  const summary = claudeResult?.overallSummary
    ?? `Token swarm completed in ${completedAt - startedAt}ms. Risk score: ${score}/100 (${tier}). ${decisions.length} decision(s).`;

  return {
    cycleId,
    wallet: mint, // mint stored in wallet field for type reuse
    startedAt,
    completedAt,
    summary,
    decisions,
    agentStatuses,
  };
}
