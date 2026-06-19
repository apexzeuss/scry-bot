# scry-bot

A thin **Telegram demo bot** for
[`scry-skill`](../scry-skill). It lets anyone
(judges, testers) try the skill's wallet risk scoring live in chat, with no
Claude Code setup.

It imports the **same** `scanWallet()` logic the skill uses, so the bot's output
matches the skill's exactly. This is a demo layer, not a separate product.

**Try it live: [@scry_intel_bot](https://t.me/scry_intel_bot)** — send `/demo`.

## Commands

- `/demo` — scans a known-safe and a known-risky wallet so you can see the value
  with zero setup. Best first command.
- `/scan <wallet>` — plain-English safety check for a Solana wallet (0-100).
  You can also just paste a wallet address with no command.
- `/watch [time]` — watch live for risky new tokens for a duration, e.g.
  `/watch 30m`, `/watch 1h` (default 15 minutes). Pings the chat as risky
  tokens launch, then sends a wrap-up. `/stop` ends it early.
- `/help` — usage.

## Layout

```
scry-bot/
  bot.ts            entry point (telegraf)
  .env.example      BOT_TOKEN, SOLANA_RPC_URL, SKILL_DIR
  package.json
  README.md
```

It expects the skill repo as a **sibling directory** (`../scry-skill`).
Override with `SKILL_DIR` in `.env` if it lives elsewhere.

## Setup

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, follow the prompts, and copy the token it gives you.

2. **Configure.**
   ```bash
   cp .env.example .env
   # paste your token into BOT_TOKEN
   # (recommended) set SOLANA_RPC_URL to a free Helius URL for full signals
   ```

3. **Install + run.**
   ```bash
   npm install
   npm start
   ```

4. **Verify wiring without a token** (handy before deploying):
   ```bash
   npm run selftest        # scans a sample wallet via the imported scorer
   npm run selftest -- <ADDRESS>
   ```

## Deploy (so it's always live for judges)

Any always-on Node host works. The bot uses long polling, so no public URL or
webhook is required.

The bot is **self-contained**: it ships a vendored copy of the scorer in
`scorer/`, so you only need to deploy this one folder (no sibling repo required).
Refresh the vendored scorer any time with `npm run sync-scorer`.

**Railway / Render (easiest):**
1. Push this `scry-bot` folder to its own GitHub repo.
2. New project from the repo. It auto-detects Node; start command is `npm start`
   (also declared in the `Procfile`).
3. Add env vars `BOT_TOKEN` and `SOLANA_RPC_URL` in the dashboard.
4. Deploy. The bot connects out to Telegram on its own, no public URL needed.

**VPS:** `npm install`, set the env vars, and run under `pm2` or a systemd unit
so it restarts on reboot.

Note: only run **one** instance per bot token at a time (Telegram rejects
duplicate pollers). So stop any local instance before the hosted one goes live.

## Disclaimer

Scores are behavioural heuristics to assist evaluation, **not financial advice**.

## License

MIT.
