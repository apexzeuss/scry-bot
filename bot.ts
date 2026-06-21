/**
 * bot.ts — Telegram demo bot for scry-skill ("Scry").
 *
 * Lets anyone test the skill's wallet risk scoring live in chat. It imports the
 * SAME scoring logic the skill uses, so what the bot reports matches the skill.
 *
 * Commands:
 *   /scan <wallet>   plain-English safety check for a Solana wallet
 *   /watch [time]    watch live for risky new tokens (e.g. /watch 30m, /watch 1h)
 *   /help            usage
 * You can also just paste a wallet address with no command.
 *
 * Run:   cp .env.example .env  (add BOT_TOKEN)  &&  npm install  &&  npm start
 * Verify wiring without a token:  npm run selftest
 */

import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
// Vendored copy of the skill's scorer so the bot is self-contained and
// deployable on its own. Refresh it with `npm run sync-scorer`.
import { scanWallet, WalletRiskReport } from "./scorer/scan_wallet.ts";
import { watchDeployments, WatchController, WatchFlag } from "./watcher.ts";

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Curated examples for /demo so anyone can see the value with zero setup.
const DEMO_SAFE = "8VRnS42EtHKv2xLvTeABZypUjjAdbJ6KHZciB1RoWbLy"; // deep, organic history
const DEMO_RISKY = "7i1ggLj7RHFf4TqrzEax9fNihKPzhBXQZkpUc4R3n8Zn"; // brand-new thin deployer

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const shortAddr = (a: string) =>
  a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;

// ---------------------------------------------------------------------------
// /scan — turn the technical report into plain English
// ---------------------------------------------------------------------------

/** Pick a few plain-language reasons from the signals, strongest first. */
function plainReasons(r: WalletRiskReport): string[] {
  const s = r.signals;
  const samplingOff = r.notes.some((n) =>
    n.startsWith("Transaction sampling unavailable"),
  );
  // For established/high-volume wallets the scorer softens wash + diversity, so
  // don't surface them as warnings here either (they're expected for power users).
  const established = r.notes.some((n) =>
    n.startsWith("Established/high-volume wallet"),
  );
  const empty = s.tx_count_sampled === 0;
  const good: string[] = [];
  const bad: string[] = [];

  // History / age
  if (empty) {
    bad.push("⚠️  Brand new or unused, so there's no track record to judge");
  } else if (s.account_age_is_lower_bound) {
    good.push("✅  Very active, with a long real history");
  } else if (s.account_age_days >= 90) {
    good.push(`✅  Been around a while (about ${Math.round(s.account_age_days / 30)} months)`);
  } else if (s.account_age_days <= 7) {
    bad.push(`⚠️  Very new wallet (only ${s.account_age_days} day${s.account_age_days === 1 ? "" : "s"} old)`);
  }

  // Thin / spammy activity
  if (!empty && s.tx_count_sampled <= 5) {
    bad.push("⚠️  Barely any activity");
  }
  if (s.failed_tx_ratio >= 0.3) {
    bad.push("⚠️  Lots of failed transactions (bot-like)");
  }

  // Dumping
  if (s.dump_behavior_score >= 0.5) {
    bad.push("⚠️  Buys tokens then dumps them fast");
  } else if (!empty && s.dump_behavior_score <= 0.25) {
    good.push("✅  No real signs of dumping");
  }

  // Wash trading + app diversity (only if we had the data, and not for
  // established wallets where those signals are softened / expected).
  if (!samplingOff && !established) {
    if (s.wash_trading_score >= 0.6) {
      bad.push("⚠️  Trades in loops with the same few wallets");
    } else if (!empty) {
      good.push("✅  No wash-trading loops");
    }
    if (s.distinct_programs >= 5) {
      good.push("✅  Uses lots of different apps (looks organic)");
    } else if (!empty && s.distinct_programs <= 1) {
      bad.push("⚠️  Only ever touches a tiny set of apps");
    }
  } else if (established && s.distinct_programs >= 5) {
    good.push("✅  Uses lots of different apps (looks organic)");
  }

  // Scam pattern
  if (s.rug_history_flag) {
    bad.push("⚠️  Matches a common scam pattern");
  } else if (r.risk_level === "low") {
    good.push("✅  Nothing matching known scam patterns");
  }

  // Show the warnings first (they matter most), then the reassurances.
  const ordered = [...bad, ...good];
  return ordered.slice(0, 4);
}

function verdict(r: WalletRiskReport): { head: string; sub: string } {
  const empty = r.signals.tx_count_sampled === 0;
  if (r.risk_level === "high")
    return { head: "🔴 Be careful", sub: "This wallet looks risky." };
  if (r.risk_level === "medium") {
    if (empty)
      return {
        head: "🟡 Not enough to go on",
        sub: "This wallet has little or no history, so I can't really vouch for it.",
      };
    return {
      head: "🟡 Mixed signals",
      sub: "Some things check out, some don't. Worth a closer look.",
    };
  }
  return { head: "🟢 Looks safe", sub: "This wallet seems trustworthy." };
}

/** The raw numbers behind the verdict, in friendly labels. */
function detailsBlock(r: WalletRiskReport): string[] {
  const s = r.signals;
  const samplingOff = r.notes.some((n) =>
    n.startsWith("Transaction sampling unavailable"),
  );
  const notChecked = "not checked (needs faster data)";

  const age = s.account_age_is_lower_bound
    ? "very active (lots of recent history)"
    : `${s.account_age_days} day${s.account_age_days === 1 ? "" : "s"} old`;

  return [
    "<b>The data</b>",
    `• Wallet: <code>${esc(r.address)}</code>`,
    `• Confidence: ${r.confidence} (${r.signals_available}/${r.signals_total} signals${r.rpc_degraded ? ", RPC degraded" : ""})`,
    `• Age: ${age}`,
    `• Transactions seen: ${s.tx_count_sampled.toLocaleString()}`,
    `• Different apps used: ${samplingOff ? notChecked : s.distinct_programs}`,
    `• Wash-trading: ${samplingOff ? notChecked : `${s.wash_trading_score} / 1 (0 = none)`}`,
    `• Dumping: ${s.dump_behavior_score} / 1 (0 = holds, 1 = dumps)`,
    `• Known scam pattern: ${s.rug_history_flag ? "⚠️ yes" : "no"}`,
  ];
}

function formatReport(r: WalletRiskReport): string {
  const v = verdict(r);
  const lines = [
    `<b>${v.head}</b>`,
    v.sub,
    `Risk score: <b>${r.risk_score} / 100</b>  (lower is safer)`,
    "",
    "<b>What I found:</b>",
    ...plainReasons(r),
    "",
    ...detailsBlock(r),
    "",
    "<i>Quick gut-check from public Solana data, not financial advice. Always do your own research too.</i>",
  ];
  return lines.join("\n");
}

async function handleScan(rawAddress: string): Promise<string> {
  const address = rawAddress.trim().split(/\s+/)[0];
  if (!address) {
    return "Send me a Solana wallet address and I'll check it. 🙂";
  }
  try {
    const report = await scanWallet(address, {
      rpcUrl: process.env.SOLANA_RPC_URL,
    });
    return formatReport(report);
  } catch (err: any) {
    return `Hmm, I couldn't read that one. Double-check it's a Solana wallet address?\n\n<i>(${esc(err?.message ?? String(err))})</i>`;
  }
}

// ---------------------------------------------------------------------------
// /watch — watch live for a duration, streaming flags as they appear
// ---------------------------------------------------------------------------

interface ActiveWatch {
  controller: WatchController;
  timer: NodeJS.Timeout;
  count: number;
}

const DEFAULT_WATCH_MS = 15 * 60 * 1000;
const MAX_WATCH_MS = 60 * 60 * 1000;
const activeWatches = new Map<number, ActiveWatch>();

/** Parse "30m" / "1h" / "45s" / bare number (minutes). */
function parseDuration(arg: string): { ms: number; label: string } {
  const m = arg.trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return { ms: DEFAULT_WATCH_MS, label: "15 minutes" };
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "h" ? 3600_000 : 60_000;
  const ms = Math.min(Math.max(n * mult, 60_000), MAX_WATCH_MS);
  return { ms, label: humanize(ms) };
}

function humanize(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total % 3600 === 0) {
    const h = total / 3600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (total >= 60) {
    const min = Math.round(total / 60);
    return `${min} minute${min === 1 ? "" : "s"}`;
  }
  return `${total} seconds`;
}

function formatFlag(f: WatchFlag): string {
  const lines = [
    `⚠️ <b>New risky token just launched</b>`,
    `<code>${esc(shortAddr(f.mint))}</code>`,
    "",
    ...f.reasons.map((r) => `• ${r}`),
  ];
  return lines.join("\n");
}

function stopWatch(chatId: number) {
  const w = activeWatches.get(chatId);
  if (!w) return;
  clearTimeout(w.timer);
  w.controller.stop();
  activeWatches.delete(chatId);
}

type Send = (html: string) => Promise<unknown>;

function startWatch(chatId: number, ms: number, send: Send) {
  stopWatch(chatId); // one watch per chat

  const controller = watchDeployments(
    { rpcUrl: process.env.SOLANA_RPC_URL, durationMs: ms, minScore: 67 },
    (flag) => {
      const w = activeWatches.get(chatId);
      if (w) w.count++;
      void send(formatFlag(flag));
    },
  );

  activeWatches.set(chatId, {
    controller,
    count: 0,
    timer: setTimeout(() => finish(chatId, send), ms),
  });
}

function finish(chatId: number, send: Send) {
  const w = activeWatches.get(chatId);
  const count = w?.count ?? 0;
  stopWatch(chatId);
  if (count === 0) {
    void send(
      "✅ All quiet. No risky new tokens in that window. That's usually a good sign. 🙂",
    );
  } else {
    void send(`✅ Done watching. I flagged ${count} token${count === 1 ? "" : "s"} worth a look.`);
  }
}

// ---------------------------------------------------------------------------
// Self-test (no Telegram token needed)
// ---------------------------------------------------------------------------

async function selfTest() {
  const addr =
    process.argv.find((a, i) => i > 2 && !a.startsWith("--")) ??
    "DTSUkYHd2e9P2HLyZfbLarsbDdPhQUhZnWjRYuJZQRC8";
  console.log(`[selftest] scanning ${addr} via imported scanWallet()...\n`);
  const report = await scanWallet(addr, { rpcUrl: process.env.SOLANA_RPC_URL });
  console.log(formatReport(report).replace(/<[^>]+>/g, ""));
  console.log("\n[selftest] OK — bot is correctly wired to the skill's scorer.");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const noPreview = { link_preview_options: { is_disabled: true } } as const;

// Tappable main menu so users don't have to know any commands.
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback("Scan a wallet", "scan_prompt")],
  [Markup.button.callback("See a quick demo", "demo")],
  [Markup.button.callback("Watch new tokens", "watch_menu")],
  [Markup.button.callback("How it works", "help")],
]);

const watchMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback("5 min", "watch:5"),
    Markup.button.callback("30 min", "watch:30"),
    Markup.button.callback("1 hour", "watch:60"),
  ],
]);

function welcomeText(name?: string): string {
  const who = name ? ` ${name}` : "";
  return (
    `🔮 <b>Hey${who}.</b> I'm Scry.\n\n` +
    "I check Solana wallets and tokens so you don't get rugged.\n\n" +
    "What would you like to do?"
  );
}

const HELP_TEXT =
  "<b>How Scry works</b>\n\n" +
  "<b>Scan a wallet</b> — paste any Solana address and I'll tell you, in plain English, whether it looks safe (0-100 risk score).\n\n" +
  "<b>See a demo</b> — I scan one healthy wallet and one risky one so you can see the difference.\n\n" +
  "<b>Watch new tokens</b> — I watch new launches live and ping you when one looks like a rug or honeypot.\n\n" +
  "<i>A gut-check from public Solana data, not financial advice.</i>";

// Reusable flows so both commands and button taps share one code path.
async function runDemo(ctx: any) {
  await ctx.replyWithHTML(
    "Here are two real wallets so you can see the difference.",
    noPreview,
  );
  await ctx.replyWithChatAction("typing");
  await ctx.replyWithHTML("<b>1. A wallet with a long, healthy history</b>", noPreview);
  await ctx.replyWithHTML(await handleScan(DEMO_SAFE), noPreview);
  await ctx.replyWithChatAction("typing");
  await ctx.replyWithHTML(
    "<b>2. A brand-new wallet that just deployed a token</b>",
    noPreview,
  );
  await ctx.replyWithHTML(await handleScan(DEMO_RISKY), noPreview);
  await ctx.replyWithHTML(
    "Want to check your own? Just paste any Solana wallet address.",
    noPreview,
  );
}

async function beginWatch(ctx: any, minutes: number) {
  const ms = Math.min(Math.max(minutes, 1), 60) * 60_000;
  await ctx.replyWithHTML(
    `Watching for risky new tokens for the next <b>${humanize(ms)}</b>.\n` +
      "I'll ping you the moment I spot one. (Tap /stop to end early.)",
    noPreview,
  );
  startWatch(ctx.chat.id, ms, (html: string) => ctx.replyWithHTML(html, noPreview));
}

/** Run the watcher for a few seconds and print flags (verify without Telegram). */
async function watchTest() {
  const secs = Number(
    process.argv[process.argv.indexOf("--watchtest") + 1] || 45,
  );
  console.log(`[watchtest] watching live for ${secs}s...\n`);
  let n = 0;
  const ctrl = watchDeployments(
    { rpcUrl: process.env.SOLANA_RPC_URL, durationMs: secs * 1000, minScore: 67 },
    (f) => {
      n++;
      console.log(`🚩 ${f.mint}\n   ${f.reasons.join("\n   ")}\n`);
    },
  );
  await new Promise((r) => setTimeout(r, secs * 1000 + 1500));
  ctrl.stop();
  console.log(`[watchtest] done. ${n} risky token(s) flagged.`);
}

async function main() {
  if (process.argv.includes("--selftest")) {
    await selfTest();
    return;
  }
  if (process.argv.includes("--watchtest")) {
    await watchTest();
    return;
  }

  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error(
      "BOT_TOKEN is not set. Copy .env.example to .env and add your @BotFather token.\n" +
        "To verify the scoring wiring without a token, run: npm run selftest",
    );
    process.exit(1);
  }

  const bot = new Telegraf(token);
  const menu = { ...noPreview, ...mainMenu };

  // Populate the "/" command menu so typing "/" shows the options.
  bot.telegram
    .setMyCommands([
      { command: "scan", description: "Check a Solana wallet's safety" },
      { command: "demo", description: "See a quick example" },
      { command: "watch", description: "Watch for risky new tokens" },
      { command: "stop", description: "Stop watching" },
      { command: "help", description: "How Scry works" },
    ])
    .catch(() => {});

  // Personalized, button-driven welcome.
  bot.start((ctx) =>
    ctx.replyWithHTML(welcomeText(ctx.from?.first_name), menu),
  );
  bot.help((ctx) => ctx.replyWithHTML(HELP_TEXT, menu));

  // ---- Button taps ----
  bot.action("scan_prompt", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      "Paste any Solana wallet address and I'll check it for you.",
      noPreview,
    );
  });
  bot.action("demo", async (ctx) => {
    await ctx.answerCbQuery();
    await runDemo(ctx);
  });
  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(HELP_TEXT, menu);
  });
  bot.action("watch_menu", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      "How long should I watch for risky new tokens?",
      { ...noPreview, ...watchMenu },
    );
  });
  bot.action(/^watch:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await beginWatch(ctx, Number(ctx.match[1]));
  });

  // ---- Typed commands (still work for power users) ----
  bot.command("scan", async (ctx) => {
    const arg = ctx.message.text.replace(/^\/scan(@\w+)?/, "").trim();
    await ctx.replyWithChatAction("typing");
    await ctx.replyWithHTML(await handleScan(arg), noPreview);
  });
  bot.command("demo", (ctx) => runDemo(ctx));
  bot.command("watch", async (ctx) => {
    const arg = ctx.message.text.replace(/^\/watch(@\w+)?/, "").trim();
    const { ms, label } = parseDuration(arg);
    await ctx.replyWithHTML(
      `👀 Watching for risky new tokens for the next <b>${label}</b>.\n` +
        "I'll ping you the moment I spot one. (Send /stop to end early.)",
      noPreview,
    );
    startWatch(ctx.chat.id, ms, (html) => ctx.replyWithHTML(html, noPreview));
  });
  bot.command("stop", async (ctx) => {
    const was = activeWatches.has(ctx.chat.id);
    stopWatch(ctx.chat.id);
    await ctx.reply(was ? "🛑 Stopped watching." : "Nothing was running. 🙂");
  });

  // Bare wallet address (no command) -> just scan it.
  bot.hears(ADDRESS_RE, async (ctx) => {
    await ctx.replyWithChatAction("typing");
    await ctx.replyWithHTML(await handleScan(ctx.message.text), noPreview);
  });

  await bot.launch(() => console.log("Bot is running. Press Ctrl-C to stop."));

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
