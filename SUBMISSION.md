# Sentinel - Autonomous Risk Agent for Bags Tokens

## One-line Summary

Sentinel is an autonomous risk agent for Bags tokens. It detects token deterioration early, explains why, suppresses alert noise, and sends actionable warnings before generic tools fully classify the collapse.

## Track

- Primary track: AI Agents
- Secondary fit: Bags API, Creator Tools, Risk Intelligence, Social Finance

## Project Links

Live dashboard: [https://sentinel-dashboard-3uy.pages.dev/](https://sentinel-dashboard-3uy.pages.dev/)

Repository: [https://github.com/loquit-tud/sentinel](https://github.com/loquit-tud/sentinel)

Judge guide: [https://github.com/loquit-tud/sentinel/blob/master/JUDGE.md](https://github.com/loquit-tud/sentinel/blob/master/JUDGE.md)

Health endpoint: [https://sentinel-api.apiworkersdev.workers.dev/health](https://sentinel-api.apiworkersdev.workers.dev/health)

Agent Decision Log: [https://sentinel-api.apiworkersdev.workers.dev/v1/agent/decisions?limit=10](https://sentinel-api.apiworkersdev.workers.dev/v1/agent/decisions?limit=10)

Live alert feed: [https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed?format=json](https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed?format=json)

Confirmed catches: [https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=10](https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=10)

Telegram alerts: [https://t.me/SentinelRiskAlerts](https://t.me/SentinelRiskAlerts)

$SENT Bags token: [https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS](https://bags.fm/token/Az1LWLGFs63XscCQGeZyn5qVV31SRKtYn53hMB6bBAGS)

## Problem

Bags tokens can deteriorate quickly.

Traders usually discover the risk too late: after liquidity has already moved, after holder concentration becomes dangerous, or after generic scanners finally classify the token as rugged.

Most scanners are reactive. They label the collapse after it is already obvious.

Sentinel is built to detect deterioration earlier.

## Solution

Sentinel continuously monitors Bags tokens and runs an autonomous risk cycle.

Every cycle, the system:

1. Fetches Bags token data.
2. Scores tokens using multi-source risk signals.
3. Compares current state against previous baselines.
4. Detects deterioration events.
5. Classifies each event as an agent decision.
6. Sends alerts only when the signal is strong enough.
7. Suppresses repeated or noisy alerts to avoid spam.
8. Stores evidence for judge and user verification.

Sentinel is not just a dashboard. The dashboard is only the interface.

The core product is the autonomous agent loop behind it.

## Agent Decisions

Each suspicious event is classified into one of four decisions:

### ESCALATE

High-confidence deterioration.

The agent sends an alert.

### WATCH

Suspicious movement, but not enough confidence yet.

The agent waits for confirmation instead of creating noise.

### SUPPRESS

Repeated or noisy alert.

The agent suppresses it to avoid spamming users.

### DOWNGRADE

Risk decreased or signal weakened.

The agent takes no action.

This decision layer makes Sentinel different from a basic scanner or alert feed.

## Risk Signals

Sentinel combines multiple risk signals:

- liquidity deterioration
- holder concentration
- mint authority risk
- freeze authority risk
- LP lock status
- volume health
- creator reputation
- source confidence
- previous score baseline
- repeat alert detection

The system separates risk from confidence.

A token can be risky, but low-confidence.

A token can look safe, but still be marked low-confidence if important sources are missing.

This prevents missing data from being treated as neutral-safe.

## Bags Integration

Sentinel is Bags-native.

It monitors Bags tokens, uses Bags-related token and fee context, and includes a Bags-launched project token: $SENT.

The project integrates with Bags ecosystem surfaces such as:

- token discovery
- fee-related data
- creator token monitoring
- risk context for Bags tokens
- $SENT token gating
- public API endpoints for validation

The goal is not to build a generic Solana scanner with a Bags label.

The goal is to build a risk agent specifically for Bags traders and creators.

## Live Validation

Judges can validate the project without installing anything.

Recommended validation flow:

1. Open the live dashboard.
2. Check the health endpoint.
3. Inspect the Agent Decision Log.
4. Inspect live alerts.
5. Inspect confirmed catches.
6. Open the Telegram alert channel.
7. Review the repo and test status.
8. Review the Bags integration section.

## Why It Matters

Bags is designed around creator tokens and fast-moving token communities.

That creates a need for fast, explainable, noise-controlled risk monitoring.

Sentinel helps traders and creators avoid blind spots by answering four questions:

1. Is this token deteriorating?
2. Why is it deteriorating?
3. Is the signal strong enough to alert?
4. Is this a new risk or just repeated noise?

## What We Built

During the hackathon, we built and shipped:

- live dashboard
- public API
- autonomous monitoring loop
- risk scoring engine
- alert feed
- confirmed catch evidence
- Telegram alerting
- Agent Decision Log endpoint
- judge-first validation guide
- Bags-native project token
- test coverage and typecheck validation

## Technical Architecture

Frontend:

- React
- TypeScript
- Tailwind
- Cloudflare Pages

Backend:

- Cloudflare Workers
- TypeScript
- Workers KV
- scheduled cron execution
- public REST API

Core system:

- risk scoring engine
- Bags token monitoring
- evidence logging
- Telegram alerting
- agent decision mapping
- false-positive suppression
- source confidence handling

## Demo Flow

The demo focuses on one clear story:

Sentinel detects token deterioration early, explains the reason, decides whether to escalate or suppress, and provides verifiable evidence.

Recommended demo order:

1. Show the dashboard.
2. Show the live health endpoint.
3. Show the Agent Decision Log.
4. Show a confirmed catch.
5. Explain the agent decision.
6. Show suppressed repeat or noise handling.
7. Show Telegram alert proof.
8. Show Bags integration and repository.

## Differentiator

Sentinel is not trying to be another token dashboard.

Sentinel is an autonomous risk agent for Bags tokens.

The strongest differentiator is the combination of:

- early deterioration detection
- agent decisions
- confidence-aware scoring
- noise suppression
- public evidence trail
- Bags-native positioning

## Current Status

Sentinel is live and publicly testable.

The system has:

- live dashboard
- live API
- live alert feed
- agent decision endpoint
- confirmed catch endpoint
- Telegram alert channel
- public repository
- typechecked codebase
- test suite

## Future Work

Next planned improvements:

- deeper creator trust integration into the main score
- stronger confidence scoring by source
- better historical accuracy reports
- richer Telegram bot workflows
- user-specific watchlists
- advanced Bags creator risk profiles
- webhook integrations for teams and trading communities

## Final Claim

Sentinel helps Bags traders avoid blind spots.

It watches token deterioration continuously, explains the evidence, suppresses noisy repeats, and alerts before the collapse is obvious.

## DoraHacks Short Description

Sentinel is an autonomous risk agent for Bags tokens. It monitors token deterioration, explains risk signals, suppresses noisy repeat alerts, and sends actionable warnings before generic tools fully classify a collapse.

## DoraHacks Pitch (Long Description)

Sentinel is an autonomous risk agent built for the Bags ecosystem.

Bags tokens can deteriorate quickly, and most scanners only become useful after the collapse is already obvious. Sentinel focuses on early deterioration signals instead of only final rug labels.

The agent continuously monitors Bags tokens, scores them using multiple risk signals, compares current state against previous baselines, and classifies suspicious events into clear decisions: ESCALATE, WATCH, SUPPRESS, or DOWNGRADE.

ESCALATE means the agent has enough evidence to alert.
WATCH means the signal is suspicious but not confirmed.
SUPPRESS means the event is repeated or noisy and should not spam users.
DOWNGRADE means the risk weakened.

Sentinel combines liquidity movement, holder concentration, token authority risk, volume health, creator reputation, and data-source confidence. It separates risk score from confidence so missing data is not treated as neutral-safe.

The project is live with a public dashboard, API, Agent Decision Log endpoint, live alert feed, confirmed catch evidence, Telegram alerts, Bags-native integration, and a Bags-launched project token.

The goal is simple: help Bags traders and creators avoid blind spots by detecting token deterioration earlier, explaining why it matters, and making alerts actionable instead of noisy.

## Video Title

Sentinel - Autonomous Risk Agent for Bags Tokens

## Video Description

Sentinel monitors Bags tokens for early deterioration, explains the evidence, suppresses repeated alert noise, and sends actionable Telegram warnings. This demo shows the live dashboard, health endpoint, Agent Decision Log, confirmed catch evidence, and Bags-native integration.

## Final Pre-Submission Check

- Ensure Markdown heading spacing is clean in README and JUDGE.
- Revoke any exposed local token and refresh credentials.
- Confirm JUDGE renders correctly in GitHub UI.
- Confirm DoraHacks points to the correct repo.
- Keep demo focused on agent decision, evidence, and alert flow.
