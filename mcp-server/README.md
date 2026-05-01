# Sentinel MCP Server — Claude Skill for Bags Risk Intelligence

**Sentinel** is an AI risk intelligence skill for Claude that protects Bags traders and creators from rug pulls, LP drains, and risky tokens on Solana.

## What It Does

| Tool | Description |
|------|-------------|
| `get_risk_score` | Score any Solana token 0-100 across 8 risk signals |
| `compare_tokens` | Compare up to 5 tokens side-by-side, ranked by safety |
| `get_wallet_xray` | Scan a wallet and flag all risky holdings |
| `get_creator_profile` | Check if a token creator has a rug history |
| `get_trade_quote` | Get swap quote with integrated risk scoring |
| `get_smart_fees` | Risk-aware fee claim urgency (claim before rug!) |
| `get_claimable_fees` | View all claimable Bags fees for a wallet |
| `get_alert_feed` | Real-time risk alerts (LP drains, rug detections) |
| `get_trending_tokens` | Top Bags tokens by lifetime fees + risk context |
| `get_creator_profile` | Creator reputation based on token history |
| `check_token_gate` | Check $SENT tier for a wallet |
| `get_partner_config` | Partner fee-share configuration |
| `get_service_status` | API health and usage stats |
| `get_app_info` | Sentinel app details and links |
| `get_sent_fee_share` | $SENT tokenomics and fee distribution |

## Quick Start

### 1. Install

```bash
npm install @sentinel/mcp-server
```

Or clone and build:
```bash
git clone https://github.com/your-org/sentinel.git
cd sentinel/mcp-server
npm install && npm run build
```

### 2. Configure Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": ["/path/to/sentinel/mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

Or with npx (after publish):
```json
{
  "mcpServers": {
    "sentinel": {
      "command": "npx",
      "args": ["@sentinel/mcp-server"]
    }
  }
}
```

### 3. Start Using

Open Claude Desktop and ask:

> "Check if token `Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS` is safe to buy"

> "Scan my wallet `YOUR_WALLET` for risky tokens"

> "Compare these 3 tokens and tell me which is safest"

> "Should I claim my Bags fees now or wait?"

## Example Conversations

**User**: Is this token safe? `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`

**Claude** (using Sentinel): 🟠 **DANGER** (score 28/100)
- Honeypot check: PASS
- LP Lock: FAIL (0% locked)
- Top holder owns 45% of supply
- Creator has 2 previous rugged tokens

Recommended: **Do not buy.** If holding, set a stop-loss and monitor.

---

**User**: Check my wallet fees

**Claude** (using Sentinel): You have $47.20 in claimable fees.
- ⚠️ **HIGH URGENCY**: $12.50 on RISKY_TOKEN (Danger tier, score 22) — claim immediately before potential LP drain
- 🟢 $34.70 across 3 safe tokens — claim when convenient

## Architecture

```
Claude Desktop ←→ MCP (stdio) ←→ Sentinel Worker API
                                    ├── RugCheck
                                    ├── Helius DAS
                                    ├── Birdeye
                                    └── Bags SDK
```

- **Transport**: stdio (standard MCP protocol)
- **API**: `https://sentinel-api.apiworkersdev.workers.dev`
- **Custom base URL**: `sentinel-mcp --base-url https://your-instance.example.com`

## Token: $SENT

| Tier | Requirement | Access |
|------|------------|--------|
| Free | — | Basic risk scores |
| Holder | ≥1 $SENT | Enhanced analysis, creator profiles |
| Whale | ≥10,000 $SENT | Full swarm intelligence, priority alerts |

Mint: `Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS`
Buy on Bags: [bags.fm/sent](https://bags.fm/sent)

## License

MIT
