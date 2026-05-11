# GitHub Update — 2026-05-11

## Summary
This update focused on detection reliability hardening, public alert wording consistency, and share/X copy cleanup.

## What Changed

### Detection reliability hardening
- Added targeted tests for scanner false-positive controls.
- Added targeted tests for pre-rug baseline-age and drop-threshold guards.
- Added targeted tests for DBC pool drain threshold behavior.
- Added scheduled cron integration tests for mass-drain suppression in Telegram channel broadcasting.

Files:
- `worker/tests/detection-hardening.test.ts`
- `worker/tests/scheduled-cron.test.ts`

### Alert wording consistency
- Softened user-facing language from "rug" terms to "critical risk" where applicable.
- Updated alert titles/descriptions and creator trust phrasing.

Files:
- `worker/src/alerts/scanner.ts`
- `worker/src/notify/alert-subscriptions.ts`
- `worker/src/notify/telegram.ts`
- `worker/src/risk/explain.ts`
- `worker/src/risk/phase.ts`
- `worker/src/creator/trust-score.ts`
- `worker/src/badge/svg.ts`
- `worker/src/badge/embed.ts`
- `worker/src/badge/card.ts`
- `worker/src/badge/creator-card.ts`

### Share/X copy update
- Changed generated alert headline from "RUG ALERT" to "RISK ALERT".
- Replaced `#BagsFM` with `@BagsApp` in generated share/tweet text.

Files:
- `worker/src/index.ts`
- `worker/src/notify/x.ts`

### Test updates
- Updated existing badge/share tests to match the new label "CRITICAL RISK".

Files:
- `worker/tests/badge-svg.test.ts`
- `worker/tests/share-card.test.ts`

## Validation
- `npm run test` -> 114/114 passing
- `npx tsc --noEmit` -> passing

## Why this matters
- Reduces the chance of false public panic from noisy data-source outages.
- Preserves strong detection behavior while improving public communication tone.
- Improves confidence in cron orchestration behavior under edge-case conditions.
