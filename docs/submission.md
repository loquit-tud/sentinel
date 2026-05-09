# Sentinel — DoraHacks Submission Description

> Copy-paste this into the DoraHacks project description field.
> Plain text version below (no markdown) for the rich-text editor.

---

## PLAIN TEXT VERSION (paste into DoraHacks)

---

**Sentinel is the Bags risk agent that watches continuously, records evidence, and verifies outcomes after alerts.**

---

### The problem

On Bags, a token can deteriorate from a safe-looking baseline to severe risk in under an hour. By the time you manually check your portfolio, liquidity may already be drained. Most tools give you a score when you ask for one. Sentinel watches continuously and writes an audit trail when risk changes materially.

We got rugged on Bags. Not by an obvious scam — by a token that looked fine. LP was unlocked, mint authority was still active, top wallet held 18%. All visible on-chain. The problem was not missing data; the problem was that nobody was continuously watching and preserving evidence.

Sentinel exists to turn those visible changes into timestamped alerts, public evidence bundles, and post-alert outcome records.

---

### What Sentinel does differently

Sentinel is not just a dashboard. It is an autonomous agent running on Cloudflare Workers cron every 15 minutes. It scores the top Bags tokens against 8 on-chain signals (RugCheck, Helius DAS, Birdeye, Bags data), compares each score to a baseline snapshot, and decides what to do: watch quietly, rescan, log the event, broadcast to Telegram, or escalate. The decision is made by an LLM policy engine with a calibrated heuristic fallback.

The important distinction: Sentinel does not claim to forecast collapses. It detects risk deterioration from a prior baseline, records the evidence at alert time, and verifies the outcome after the alert through public endpoints.

---

### Evidence — verify live

On April 23, 2026, the agent flagged $BAG 32 minutes after the prior safe baseline snapshot.

Score dropped from 65 to 35. The baseline snapshot was taken at Unix timestamp 1776801667255. The catch was logged at 1776803570712. The difference is 32 minutes. The post-alert outcome is verified separately by the public evidence endpoints.

This was not triggered manually. It was logged by the scheduled cron agent on a routine 15-minute scan.

You can verify this right now:
- Catches log (live, JSON): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches
- Outcome tracker (live): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/accuracy
- Telegram channel (auto-posted by the agent, no human): https://t.me/SentinelRiskAlerts
- Raw score for any token: https://sentinel-api.apiworkersdev.workers.dev/v1/risk/<mint>

Everything on this page is reproducible from public on-chain data. EVIDENCE.md in the repo has the full methodology, factor weights, and a 50-token ground-truth scan with ground-truth alignment protocol.

---

### How Sentinel uses Bags

Sentinel is built specifically for Bags.

The token feed, price/volume data, creator wallet lookups, fee share stats, and partner API are all consumed from Bags-related surfaces. The scoring engine uses creator behavior as one of its risk inputs. The $SENT token was launched on Bags and gates premium tiers: holders get priority alerts and deeper scans via Helius. The Bags Partner API is integrated: Sentinel is a registered Bags partner (on-chain registration TX: 2RVRTcGEkzsepjga18MX9bsdSqcRS9cn9vrVSvV5fv6vbQPkk3mcB8AXocs4zwUNx5FQkMUgL8C6gFHdgRcTD8Ym).

Creators can filter Telegram alerts by their own wallet — they only receive alerts on tokens they launched. This is a Bags-native use case that doesn't exist anywhere else.

---

### What we shipped

The agent loop has been running since April. The worker exposes public evidence endpoints, a post-alert outcome tracker, Telegram alerting, token risk scoring, creator trust scoring, and Bags partner/fee surfaces. The codebase has gone through 4 rounds of page pruning — 11 pages removed because they were not Bags-native enough to earn their place. What's left is the trust layer we want judges to verify directly.

Stack: TypeScript 5.8, Cloudflare Workers (Hono + Durable Objects + KV + AI), React 18, Solana/Helius for holder distribution, Birdeye for market data, RugCheck for on-chain security signals.

---

### What's next

Sentinel's agent loop is the primitive. The next layer is creator early warning: alert creators when their own token is entering a high-risk distribution phase, with evidence they can share with their community. Then buyer-side: personal watchlists with configurable alert thresholds so traders set their own risk tolerance. The longer-term goal is to make Sentinel a trust API that wallets, launchpads, indexes, dashboards, and Telegram communities can consume.

---

### Links

- Dashboard: https://sentinel-dashboard-3uy.pages.dev
- API: https://sentinel-api.apiworkersdev.workers.dev
- GitHub: https://github.com/loquit-tud/sentinel
- Telegram: https://t.me/SentinelRiskAlerts
- $SENT: https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS
- Evidence: https://github.com/loquit-tud/sentinel/blob/master/EVIDENCE.md
- Catches (live): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches
- Outcomes (live): https://sentinel-api.apiworkersdev.workers.dev/v1/watch/accuracy
