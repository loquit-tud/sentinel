# Sentinel Judge Guide

## One-line Summary

Sentinel is an autonomous risk agent for Bags tokens. It detects deteriorating tokens early, explains the evidence, suppresses noisy repeat alerts, and sends actionable warnings.

## Why This Matters

Bags tokens can deteriorate quickly. Traders often see the full collapse only after liquidity has already drained or generic tools have already marked the token as rugged.

Sentinel focuses on early deterioration, not just final rug classification.

## Validation Flow

### 1. Check that the system is live

Health endpoint:

[https://sentinel-api.apiworkersdev.workers.dev/health](https://sentinel-api.apiworkersdev.workers.dev/health)

Expected result:

- status is live or healthy
- monitored token count is visible
- worker API is reachable

### 2. Open the dashboard

[https://sentinel-dashboard-3uy.pages.dev/](https://sentinel-dashboard-3uy.pages.dev/)

What to look for:

- live risk monitoring
- active alerts
- evidence of Bags token coverage
- risk and catch stats

### 3. Inspect live alerts

[https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed?format=json](https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed?format=json)

What to look for:

- severity
- token mint
- risk reason
- timestamp
- repeat suppression metrics in debug output

### 4. Inspect agent decisions

[https://sentinel-api.apiworkersdev.workers.dev/v1/agent/decisions?limit=10](https://sentinel-api.apiworkersdev.workers.dev/v1/agent/decisions?limit=10)

What to look for:

- decision: ESCALATE, WATCH, SUPPRESS, DOWNGRADE
- confidence
- reason
- next action
- suppressed repeats

### 5. Inspect confirmed evidence

[https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=10](https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=10)

A strong example is a token where:

- score dropped from safe toward rug or high-risk
- liquidity collapsed
- Sentinel detected deterioration before generic tooling fully classified it

### 6. Review risk vs confidence

Sentinel separates:

- riskScore: how risky the token appears
- dataConfidence: how complete and reliable the data is
- missingSignals: unavailable data points

This prevents missing data from being treated as neutral-safe.

## Main Differentiator

Sentinel is not a generic token scanner.

It is a Bags-native autonomous risk agent focused on early deterioration, evidence, and alert quality.

## Recommended Demo Path

1. Show dashboard.
2. Show health endpoint.
3. Show confirmed catch evidence.
4. Show why the agent escalated or suppressed.
5. Show repeat suppression and source-health safeguards.
6. Show Telegram alert channel.
7. Show Bags-native integration points and tests.
