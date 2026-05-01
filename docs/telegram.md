# Telegram (Sentinel bot) — setup + troubleshooting

Sentinel has **two Telegram surfaces**:

- **Public channel**: `@SentinelRiskAlerts` — autonomous cron broadcasts for high-signal events.
- **Bot (DM)**: `@Sentinelbags_bot` — self-serve commands + creator alerts subscriptions.

---

## For users (non-technical)

1) Open the bot DM and send `/start`:

- Bot deep link: `https://t.me/Sentinelbags_bot?start=sentinel`

2) Use commands:

- `/help`
- `/status <mint>` — current score + tier
- `/why <mint>` — explanation (AI when available)
- `/watch <mint>` — add to watchlist
- `/unwatch <mint>` — remove from watchlist
- `/list` — show watchlist
- `/report` — quick summary

3) Optional: connect “Creator Alerts” in the dashboard to receive **LP unlock / LP drain** alerts for your own tokens (wallet-filtered).

---

## For developers (webhook)

Sentinel receives Telegram updates via webhook:

- Worker endpoint: `POST /v1/telegram/webhook`

### 1) Set webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://sentinel-api.apiworkersdev.workers.dev/v1/telegram/webhook"
```

### 2) Verify webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

You should see your Worker URL in `url` and no recent `last_error_message`.

### 3) Optional hardening (recommended)

If `TELEGRAM_WEBHOOK_SECRET` is set on the Worker, Sentinel requires one of:

- Telegram header: `x-telegram-bot-api-secret-token: <secret>` (preferred)
- Or query string: `?secret=<secret>`

Telegram supports setting `secret_token` during `setWebhook`:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://sentinel-api.apiworkersdev.workers.dev/v1/telegram/webhook" \
  -d "secret_token=<YOUR_SECRET>"
```

---

## Troubleshooting

### “Could not resolve chatId”
This is **dashboard subscription** behavior (not webhook). Fix:

- DM the bot first (send `/start`)
- Then retry “Connect Telegram” in the dashboard

### Bot doesn’t respond in DM
Common causes:

- Webhook not set (run `setWebhook` above)
- Wrong bot token
- A secret is required but not configured on Telegram webhook

### Too much noise
Use:

- Creator wallet filter in dashboard subscriptions (only your tokens)
- Watchlist deltas (only when tier worsens or score drops hard)

