# Sentinel ⬡

> **Don't trade blind.**

AI risk intelligence + wallet portfolio scanner for [Bags](https://bags.fm) traders & creators. Built for the [Bags Hackathon](https://bags.fm/hackathon) ($4M funding) — Track: **AI Agents**.

**$SENT**: [`Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS`](https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS) — launched on Bags

[![Live Dashboard](https://img.shields.io/badge/Dashboard-Live-06b6d4?style=flat-square)](https://sentinel-dashboard-3uy.pages.dev)
[![API](https://img.shields.io/badge/API-v0.14.0-22c55e?style=flat-square)](https://sentinel-api.apiworkersdev.workers.dev/health)
[![CI](https://github.com/loquit-doru/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/loquit-doru/sentinel/actions)
[![DoraHacks](https://img.shields.io/badge/DoraHacks-BUIDL-purple?style=flat-square)](https://dorahacks.io/buidl/24038)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://typescriptlang.org)

---

## Autonomous Agent Loop

Sentinel is not a dashboard — it's an **autonomous agent** that runs continuously without human input.

```
Every 15 min (Cloudflare cron)
  │
  ├─ Fetch top 100 Bags tokens
  ├─ Score each token (8 signals: RugCheck + Helius + Birdeye)
  ├─ Compare to previous scores
  │
  ├─ Score collapsed ≥40pts or tier → danger/rug?
  │     YES → record catch with timestamp + lead time
  │           broadcast to @SentinelRiskAlerts (Telegram channel)
  │           notify personal subscribers
  │
  └─ Update KV cache, pre-warm feed
```

**Live proof**:
- Telegram channel: [@SentinelRiskAlerts](https://t.me/SentinelRiskAlerts) — auto-posted by the agent, no human
- Catch log: [`GET /v1/watch/catches`](https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches) — timestamped evidence chain
- Recorded catch: **$BAG flagged 32 min before collapse** (score 65→35, initialAt `1776801667255`, caughtAt `1776803570712`)

This loop runs on Cloudflare Workers cron (`*/15 * * * *`), costs $0/month on the free tier, and has zero single points of failure.

---

## What it does

### 12 Pillars — fully implemented & deployed

#### 1. Risk Scoring Engine (core)
Real-time risk score **0-100** for any token on Bags. Combines 8 weighted signals from 4 data sources.

| Factor | Weight | Source |
|--------|--------|--------|
| Honeypot risks | 20% | RugCheck |
| LP Locked | 15% | RugCheck |
| Mint Authority | 15% | RugCheck |
| Freeze Authority | 10% | RugCheck |
| Top Holder % | 15% | Helius DAS |
| Liquidity Depth | 10% | Birdeye |
| Volume Health | 10% | Birdeye |
| Creator Reputation | 5% | Bags API |

**Tiers**: 🟢 Safe (70-100) · 🟡 Caution (40-69) · 🔴 Danger (10-39) · ⛔ Rug (0-9)

#### 2. Wallet X-Ray
Paste any Solana wallet → instant risk scan of ALL holdings. Portfolio health score + flagged tokens.

#### 3. Auto Fee Optimizer
Detect unclaimed creator fees, prioritize by risk urgency (critical/warning/safe), build unsigned claim transactions for wallet signing.

#### 4. BagsSwarm Intelligence
5-agent wallet advisory system. Analyzes wallet activity (unclaimed fees + portfolio risk) and recommends optimal actions:
- **fee-scanner** — Identify unclaimed fee positions and urgency
- **risk-sentinel** — Portfolio-wide risk exposure assessment
- **auto-claimer** — Claim optimization recommendations
- **launch-advisor** — Creator profile trust evaluation
- **trade-signal** — Token position exit signals

All 5 perspectives from a single Claude API call → majority (>50%) voting → single verdict with confidence score.

#### 5. Partner Integration (Bags-native)
Register as a Bags partner, query partner config + BPS allocation, claim partner fees. Full REST integration with Bags Partner API.

#### 6. $SENT Token Gating
Premium access tiers based on $SENT holdings (via Helius RPC):
- **Free**: 0 $SENT — basic features
- **Holder**: ≥1 $SENT — priority alerts, deeper scans, auto-claim
- **Whale**: ≥10,000 $SENT — API key, custom webhooks, bulk scanning

#### 7. Autonomous Telegram Alerts
Two alert layers:
- **@SentinelRiskAlerts** — public Telegram channel, auto-posted by the cron agent when a pre-rug catch fires
- **Personal subscribers** — `POST /v1/alerts/subscribe` with optional wallet → get DM'd for every catch
- Per-wallet fee monitor: register wallet + Telegram chat ID → get alerted when claimable fees cross threshold

#### 8. Autonomous Firewall
Pre-signature transaction screening — ALLOW / WARN / BLOCK decisions before your wallet signs. Auto-blocks rug-tier tokens, honeypots, and active LP drains. Per-wallet custom rules (whitelist/blocklist), configurable auto-protection settings, screening activity log, global stats.

#### 9. Insurance Pool
Community-backed rug protection. Stake $SENT in 3 tiers (Backer / Guardian / Whale Shield). File claims when tokens rug — auto-approved if risk score dropped 40+ points or token hit rug-tier. Pool health tracking, per-wallet claim history.

#### 10. Creator Trust Score
Advanced creator reputation with 8 behavioral signals: token age patterns, serial launcher detection (5+ tokens in 30 days), LP removal tracking, mint authority retention, holder concentration analysis, fee consistency. Weighted scoring with human-readable risk flags and verdict.

#### 11. Pre-Rug Simulator
"What if?" analysis for 6 rug scenarios: LP Pull, Mint Exploit, Whale Dump, Freeze Attack, Slow Rug, Honeypot Activation. Each with probability, estimated loss %, timeframe, explanation, and mitigations. Overall risk + worst-case identification.

#### 12. $SENT Fee Stats
Live fee-sharing display: 24h volume → 1% Bags fee → 30% distributed to $SENT holders. Per-holder daily earnings estimate. [`GET /v1/sent/fee-stats`](https://sentinel-api.apiworkersdev.workers.dev/v1/sent/fee-stats) — cached 5 min, powered by Birdeye.

---

## Bags Integration (how we're "built on Bags")

Sentinel isn't just "analytics for Bags tokens" — we're a **first-class Bags partner** that consumes the Bags Public API directly from Cloudflare Workers (REST calls, no SDK because the `@bagsfm/bags-sdk` npm package assumes a long-lived Node process with `@solana/web3.js` `Connection` — we need edge-compatible fetch).

| Bags API surface | Where we use it | File |
|---|---|---|
| `GET /token-launch/lifetime-fees/leaderboard` | Token discovery feed (top by fees) | [worker/src/feed/bags.ts](worker/src/feed/bags.ts) |
| `GET /token-launch/fee-share/wallet/all-positions` | Auto Fee Optimizer (unclaimed fees) | [worker/src/fees/bags-fee.ts](worker/src/fees/bags-fee.ts) |
| `POST /token-launch/fee-share/wallet/claim-all` | Unsigned claim tx builder | [worker/src/fees/bags-fee.ts](worker/src/fees/bags-fee.ts) |
| `GET /partner/config` · `POST /partner/create` | Partner registration + fee-share | [worker/src/partner/bags-partner.ts](worker/src/partner/bags-partner.ts) |
| `GET /partner/claim-stats` · `GET /partner/claim-txs` | Partner earnings + claims | [worker/src/partner/bags-partner.ts](worker/src/partner/bags-partner.ts) |
| `POST /token-launch/create` | Token Launch page (UI calls proxied) | [worker/src/token/](worker/src/token/) |
| `GET /trade/quote` · `POST /trade/build` | Swap quotes for firewall pre-screen | [worker/src/trade/swap.ts](worker/src/trade/swap.ts) |

**Auth**: `x-api-key: ${BAGS_API_KEY}` header, set via `wrangler secret put BAGS_API_KEY`.

**Endpoint base**: `BAGS_API_BASE` in [shared/constants.ts](shared/constants.ts) — single source of truth.

**$SENT launched on Bags** — [`Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS`](https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS). Token gating tiers check $SENT balance via Helius RPC: [worker/src/gate/sent-gate.ts](worker/src/gate).

---

## Evidence & Audit Trail

We don't ask for trust — we give you reproducible proof.

**Live Bags leaderboard scan** (refreshed every 15 min via cron):
- Top 50 tokens scored every cycle → cached in Workers KV (30 min TTL)
- Results file: [scripts/out/scan-summary.md](scripts/out/scan-summary.md) (regenerated on-demand)
- Reproduce locally: `npx tsx scripts/scan-top-tokens.ts`

**Current traction** (public endpoint):
```bash
curl https://sentinel-api.apiworkersdev.workers.dev/stats
# => { totalRequests, byEndpoint: { risk, fees, claim, feed }, today, yesterday }
```

**Methodology audit** — for any token, inspect our score *and* the raw signals:
```bash
curl "https://sentinel-api.apiworkersdev.workers.dev/v1/risk/token/<mint>"
# Returns: score, tier, breakdown { honeypot, lpLocked, mintAuthority,
# freezeAuthority, topHolderPct, liquidityDepth, volumeHealth, creatorReputation }
```
Each factor traces back to its source (RugCheck, Helius DAS, Birdeye, Bags) — see [EVIDENCE.md](EVIDENCE.md) for the full audit trail and methodology validation.

---

## Live URLs

| Service | URL |
|---------|-----|
| Dashboard | [sentinel-dashboard-3uy.pages.dev](https://sentinel-dashboard-3uy.pages.dev) |
| API | [sentinel-api.apiworkersdev.workers.dev](https://sentinel-api.apiworkersdev.workers.dev/health) |
| DoraHacks | [dorahacks.io/buidl/24038](https://dorahacks.io/buidl/24038) |
| $SENT Token | [bags.fm/token/Az1LWL...](https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS) |

---

## Getting Started

```bash
# Clone & install
git clone https://github.com/loquit-doru/sentinel.git
cd sentinel && npm install

# Create worker/.dev.vars with your API keys
cp worker/.dev.vars.example worker/.dev.vars

# Run locally
npm run dev:worker     # API on http://localhost:8787
npm run dev:dashboard  # Dashboard on http://localhost:5173

# Typecheck & test
npm run check          # All workspaces
npm --workspace worker run test
```

---

## Architecture

```
sentinel/
├── worker/                      → Cloudflare Workers + Hono (API backend)
│   └── src/
│       ├── risk/engine.ts       → 8-signal risk scoring
│       ├── portfolio/scanner.ts → Wallet X-Ray (batch risk)
│       ├── fees/                → Smart fees + Bags fee integration
│       ├── trade/swap.ts        → Trade quotes via Bags
│       ├── swarm/               → 5-agent majority-voting wallet advisor
│       ├── partner/             → Bags partner REST integration
│       ├── gate/                → $SENT token gating (Helius RPC)
│       ├── app-store/           → App store metadata + fee-share config
│       ├── alerts/              → Risk alert scanner
│       ├── monitor/             → Fee monitor + Telegram
│       ├── creator/             → Creator reputation profiler
│       └── badge/               → SVG risk badge generator
├── dashboard/                   → React 18 + Vite + TailwindCSS
│   └── src/pages/
│       ├── LandingPage.tsx      → Landing page
│       ├── FeedPage.tsx         → Token discovery feed
│       ├── RiskDetailPage.tsx   → Token risk detail
│       ├── WalletXRayPage.tsx   → Wallet X-Ray
│       ├── AlertFeedPage.tsx    → Risk alerts feed
│       ├── CreatorProfilePage.tsx → Creator reputation profile
│       ├── TokenLaunchPage.tsx  → Token launch
│       └── ClaimPage.tsx        → Claims management
├── mcp-server/                  → MCP Server (15 Claude tools)
│   └── src/
│       ├── tools.ts             → All 15 tool definitions
│       ├── client.ts            → API client
│       └── index.ts             → Server entry point
└── shared/                      → TypeScript types + constants
```

### API Endpoints (~38 routes)

#### Risk & Discovery
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/v1/risk/:mint` | Risk score (0-100) for any token |
| GET | `/v1/tokens/feed` | Top tokens by lifetime fees |
| GET | `/v1/portfolio/:wallet` | Wallet X-Ray (all holdings + risk) |
| GET | `/v1/creator/:wallet` | Creator reputation profile |

#### Fees & Claims
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/v1/fees/:wallet` | Claimable fee positions |
| POST | `/v1/fees/claim` | Build claim transactions |
| GET | `/v1/fees/:wallet/smart` | Risk-aware fee urgency snapshot |
| POST | `/v1/claims/prepare` | Create pending claim bundle (TTL) |
| GET | `/v1/claims/:claimId` | Read pending claim bundle |
| POST | `/v1/claims/:claimId/done` | Mark claim complete |

#### Swarm Intelligence
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/v1/swarm/:wallet` | Full 5-agent wallet advisory analysis |
| GET | `/v1/swarm/:wallet` | Get current swarm state for wallet |
| POST | `/v1/swarm/token/:mint` | Token-focused swarm analysis |

#### Bags-Native Integration
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/v1/partner/:wallet` | Partner config + BPS |
| POST | `/v1/partner/register` | Create partner registration tx |
| GET | `/v1/partner/:wallet/stats` | Partner claim stats |
| POST | `/v1/partner/:wallet/claim` | Get partner claim txs |
| GET | `/v1/gate/:wallet` | Check $SENT token gate |
| POST | `/v1/gate/check` | Verify access tier |
| GET | `/v1/app/info` | App store metadata |
| GET | `/v1/app/fee-share` | $SENT fee-share target config |
#### Autonomous Firewall
| Method | Route | Purpose |
|--------|-------|--------|
| POST | `/v1/firewall/screen` | Screen transaction → ALLOW/WARN/BLOCK |
| GET | `/v1/firewall/:wallet/config` | Wallet firewall config + rules |
| POST | `/v1/firewall/:wallet/rules` | Add whitelist/blocklist rule |
| DELETE | `/v1/firewall/:wallet/rules/:ruleId` | Remove rule |
| PATCH | `/v1/firewall/:wallet/settings` | Toggle auto-block settings |
| GET | `/v1/firewall/stats` | Global screening stats |
| GET | `/v1/firewall/:wallet/log` | Wallet screening activity log |

#### Insurance Pool
| Method | Route | Purpose |
|--------|-------|--------|
| GET | `/v1/insurance/pool` | Pool stats + health |
| GET | `/v1/insurance/commitments` | All backers/commitments |
| POST | `/v1/insurance/commit` | Pledge $SENT to pool |
| POST | `/v1/insurance/claim` | File insurance claim |
| GET | `/v1/insurance/claims/:wallet` | Wallet claim history |
| GET | `/v1/insurance/claims` | Recent claims feed |

#### Creator Trust & Rug Simulator
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/v1/creator/:wallet/trust` | Advanced trust score + signals + flags |
| POST | `/v1/risk/simulate-rug` | Simulate specific rug scenarios |
| GET | `/v1/risk/simulate-rug/:mint` | Simulate all 6 scenarios for a token |

#### Monitoring & System
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/v1/monitor/register` | Register wallet + Telegram target |
| POST | `/v1/monitor/test` | Send Telegram test ping |
| DELETE | `/v1/monitor/:wallet` | Unregister monitor |
| GET | `/health` | Service status |
| GET | `/stats` | API usage analytics |

### Stack

- **Backend**: Cloudflare Workers + Hono v4.7
- **Frontend**: React 18 + Vite + TailwindCSS
- **Blockchain**: @solana/web3.js + @bagsfm/bags-sdk v1.3.7
- **Risk Data**: RugCheck API + Birdeye API + Helius DAS + RPC
- **Cache**: Cloudflare KV (60s risk, 5min fees, 5min gate)
- **MCP**: Model Context Protocol — 16 tools for Claude
- **Analytics**: KV-based tracking (`ENABLE_KV_ANALYTICS=1`)

---

## $SENT Token Economics

Fee-share target configuration:

| Allocation | % | BPS |
|-----------|---|-----|
| Creator (Sentinel) | 40% | 4000 |
| Holders Reward | 30% | 3000 |
| Dev Fund | 20% | 2000 |
| Partner (Bags) | 10% | 1000 |

Access tiers unlock premium features based on $SENT holdings — no subscriptions, just hold the token.

---

## Claude Skills (MCP Server)

Sentinel exposes **15 tools** via the [Model Context Protocol](https://modelcontextprotocol.io) for AI-native integration.

### Available Tools

| Tool | Description |
|------|-------------|
| `get_risk_score` | Risk score (0-100) for any Solana token |
| `get_trending_tokens` | Top tokens by lifetime fees on Bags |
| `get_claimable_fees` | Unclaimed fees for a wallet |
| `get_smart_fees` | Risk-weighted fee urgency snapshot |
| `compare_tokens` | Side-by-side risk comparison (2-5 tokens) |
| `get_wallet_xray` | Portfolio health + flagged holdings |
| `get_creator_profile` | Creator reputation + rug signals |
| `get_trade_quote` | Trade quotes via Bags |
| `run_swarm_analysis` | Full 5-agent wallet advisory analysis |
| `get_alert_feed` | Recent risk alert catches feed |
| `get_partner_config` | Bags partner status + fee stats |
| `check_token_gate` | $SENT holding tier check |
| `get_app_info` | App store metadata |
| `get_sent_fee_share` | Token fee-share allocation |
| `get_service_status` | API health + usage stats |

### Setup in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": ["C:/path/to/sentinel/mcp-server/dist/index.js"]
    }
  }
}
```

Example prompts:
- *"How risky is token DezXAZ...B263?"*
- *"Run a swarm analysis on this token"*
- *"Check my wallet X-Ray for flagged tokens"*
- *"What's my $SENT tier?"*

---

## Bags Integration (native)

Sentinel is built Bags-native — deep integration at every layer:

- **Bags API**: Token feed (lifetime fees, creators), claimable positions, claim tx builder, trade quotes
- **Bags Partner**: On-chain partner registration, BPS allocation, fee claiming
- **$SENT on Bags**: Token launched on Bags, fee-share config (40/30/20/10 split)
- **Token Gating**: $SENT-based premium tiers via Helius RPC balance checks
- **Risk Engine**: Feeds RugCheck + Birdeye + Helius signals into Bags token context
- **MCP + Bags**: AI agents can query risk, fees, swarm, and partner data via Claude tools
- **App Store**: Ready for bags.fm/apply submission with full metadata

---

## Getting Started

```bash
# Install
npm install

# Development
npm run dev:worker       # API on :8787
npm run dev:dashboard    # Dashboard on :5173

# Typecheck all packages
npm --workspaces run check

# Deploy
npm run deploy:worker
npm run deploy:dashboard
```

### Environment Variables

Create `worker/.dev.vars` for local development:

```
BAGS_API_KEY=your_bags_api_key
HELIUS_API_KEY=your_helius_api_key
BIRDEYE_API_KEY=your_birdeye_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ENABLE_KV_ANALYTICS=0
```

Get API keys from:
- [Bags Developer Dashboard](https://dev.bags.fm)
- [Helius](https://helius.dev)
- [Birdeye](https://birdeye.so)

---

## Track

**AI Agents** — [The Bags Hackathon](https://bags.fm/hackathon) ($4M funding)

## License

MIT
