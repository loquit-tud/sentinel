# Sentinel — DoraHacks Submission Description

> Copy-paste this into the DoraHacks project description field.
> Plain text version below (no markdown) for the rich-text editor.

---

## PLAIN TEXT VERSION (paste into DoraHacks)

---

**Sentinel is the agent that sleeps for you — and wakes you up before the collapse.**

---

### The problem

On Bags, a token can go from 60 to 20 in under an hour. By the time you check your portfolio, the LP is already gone. Every existing tool gives you a score when you ask for one. None of them watch continuously and tell you when to act.

We got rugged on Bags. Not by an obvious scam — by a token that looked fine. LP was unlocked, mint authority was still active, top wallet held 18%. All visible on-chain. None of it surfaced until after the collapse.

The signal was there 40 minutes early. Nobody was watching.

---

### What Sentinel does differently

Sentinel is not a dashboard. It's an autonomous agent running on Cloudflare Workers cron every 15 minutes. It scores the top 100 Bags tokens against 8 on-chain signals (RugCheck, Helius DAS, Birdeye), compares each score to a baseline snapshot, and decides what to do — watch quietly, rescan in 2 minutes, log the event, broadcast to Telegram, or escalate. The decision is made by an LLM policy engine with a calibrated heuristic fallback. You don't open a dashboard. You get a message before it matters.

---

### Evidence — verify live

On April 23, 2026, the agent flagged $BAG 32 minutes before its price collapsed.

Score dropped from 65 to 35. The baseline snapshot was taken at Unix timestamp 1776801667255. The catch was logged at 1776803570712. The difference is 32 minutes. The price moved after.

This was not triggered manually. It was logged by the scheduled cron agent on a routine 15-minute scan.

You can verify this right now:
- Catches log (live, JSON): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches
- Telegram channel (auto-posted by the agent, no human): https://t.me/SentinelRiskAlerts
- Raw score for any token: https://sentinel-api.apiworkersdev.workers.dev/v1/risk/<mint>

Everything on this page is reproducible from public on-chain data. EVIDENCE.md in the repo has the full methodology, factor weights, and a 50-token ground-truth scan with ground-truth alignment protocol.

---

### How Sentinel uses Bags

Sentinel is built specifically for Bags — it would not work anywhere else.

The token feed, price/volume data, creator wallet lookups, fee share stats, and partner API are all consumed from Bags. The scoring engine uses the Bags creator reputation signal as one of its 8 factors. The $SENT token was launched on Bags and gates premium tiers: holders get priority alerts and deeper scans via Helius. The Bags Partner API is integrated: Sentinel is a registered Bags partner (on-chain registration TX: 2RVRTcGEkzsepjga18MX9bsdSqcRS9cn9vrVSvV5fv6vbQPkk3mcB8AXocs4zwUNx5FQkMUgL8C6gFHdgRcTD8Ym).

Creators can filter Telegram alerts by their own wallet — they only receive alerts on tokens they launched. This is a Bags-native use case that doesn't exist anywhere else.

---

### What we shipped

The agent loop has been running since April. 102 unit tests on the scoring engine. The codebase has gone through 4 rounds of page pruning — 11 pages removed because they weren't Bags-native enough to earn their place. What's left works.

Stack: TypeScript 5.8, Cloudflare Workers (Hono + Durable Objects + KV + AI), React 18, Solana/Helius for holder distribution, Birdeye for market data, RugCheck for on-chain security signals.

---

### What's next

Sentinel's agent loop is the primitive. The next layer is creator early warning: detect when your own token is entering distribution phase before your community notices. Then buyer-side: personal watchlists with configurable alert thresholds so traders set their own risk tolerance. Both of these are Bags-native surfaces that no other tool is building.

---

### Links

- Dashboard: https://sentinel-dashboard-3uy.pages.dev
- API: https://sentinel-api.apiworkersdev.workers.dev
- GitHub: https://github.com/loquit-doru/sentinel
- Telegram: https://t.me/SentinelRiskAlerts
- $SENT: https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS
- Evidence: https://github.com/loquit-doru/sentinel/blob/master/EVIDENCE.md
- Catches (live): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches
