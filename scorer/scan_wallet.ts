/**
 * scan_wallet.ts — Solana wallet risk scoring (core logic).
 *
 * Computes an explainable 0-100 risk score from on-chain behaviour using only
 * standard Solana RPC. No ML, no opaque models: every signal maps to a weight
 * documented in rules/risk-thresholds.md so a human (or judge) can verify it.
 *
 * Usage (CLI):
 *   tsx scripts/scan_wallet.ts <address> [--days N] [--json]
 *
 * Usage (import):
 *   import { scanWallet } from "./scan_wallet";
 *   const report = await scanWallet(address, { lookbackDays: 30 });
 *
 * RPC endpoint: set SOLANA_RPC_URL (e.g. a free Helius URL) for reliable deep
 * history. Falls back to the public mainnet endpoint, which is rate-limited.
 */

import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Config & weights (mirror of rules/risk-thresholds.md — keep in sync)
// ---------------------------------------------------------------------------

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/** Weights sum to 1.0. risk_score = round(100 * weighted sum of sub-scores). */
const WEIGHTS = {
  age: 0.3, // newer wallet -> riskier
  activity: 0.15, // thin / spammy history -> riskier
  diversity: 0.15, // narrow program set -> riskier
  wash: 0.2, // counterparty concentration -> riskier
  dump: 0.2, // acquire-then-empty pattern -> riskier
} as const;

// How much history to sample. Bounded to stay friendly to public RPC limits.
const MAX_SIGNATURES = 1000; // cap for age + activity counting
const SAMPLE_TX = 25; // recent txns to parse for diversity/wash

export interface ScanOptions {
  rpcUrl?: string;
  lookbackDays?: number; // if set, only count activity within this window
  connection?: Connection; // reuse a connection (watch_deployments passes one)
}

export interface WalletRiskReport {
  address: string;
  risk_score: number; // 0-100
  risk_level: "low" | "medium" | "high";
  signals: {
    account_age_days: number;
    account_age_is_lower_bound: boolean;
    tx_count_sampled: number;
    failed_tx_ratio: number;
    distinct_programs: number;
    wash_trading_score: number; // 0-1, counterparty concentration
    dump_behavior_score: number; // 0-1, empty-token-account ratio
    rug_history_flag: boolean; // heuristic proxy (see notes)
  };
  components: Record<keyof typeof WEIGHTS, number>; // each 0-1, pre-weight
  summary: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// RPC helpers with light retry/backoff (public RPC throttles aggressively)
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Exponential backoff: 600ms, 1.2s, 2.4s, 4.8s. Public RPC throttles hard;
      // a real Helius URL via SOLANA_RPC_URL avoids most of this.
      await sleep(600 * 2 ** i);
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Page backwards through signatures up to MAX_SIGNATURES. */
async function fetchSignatures(
  conn: Connection,
  pubkey: PublicKey,
): Promise<{ sigs: ConfirmedSignatureInfo[]; hitCap: boolean }> {
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (sigs.length < MAX_SIGNATURES) {
    const batch = await withRetry(() =>
      conn.getSignaturesForAddress(pubkey, { limit: 1000, before }),
    );
    if (batch.length === 0) break;
    sigs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return { sigs, hitCap: sigs.length >= MAX_SIGNATURES };
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

function computeAge(sigs: ConfirmedSignatureInfo[], hitCap: boolean) {
  const times = sigs
    .map((s) => s.blockTime)
    .filter((t): t is number => typeof t === "number");
  if (times.length === 0) {
    return { ageDays: 0, isLowerBound: false };
  }
  const oldest = Math.min(...times);
  const ageDays = Math.max(0, (Date.now() / 1000 - oldest) / 86400);
  // If we hit the signature cap, the wallet is at least this old (lower bound).
  return { ageDays: Math.round(ageDays), isLowerBound: hitCap };
}

/** Parse a sample of recent txns to get program diversity + counterparties. */
async function sampleTransactions(
  conn: Connection,
  self: PublicKey,
  sigs: ConfirmedSignatureInfo[],
) {
  const recent = sigs.slice(0, SAMPLE_TX).map((s) => s.signature);
  const parsed: (ParsedTransactionWithMeta | null)[] = [];
  // Fetch one at a time, not batched: the Helius free tier (and the public
  // endpoint) reject JSON-RPC *batch* requests, which getParsedTransactions(array)
  // sends. Single getParsedTransaction calls are allowed. Small pause between.
  for (let i = 0; i < recent.length; i++) {
    const tx = await withRetry(() =>
      conn.getParsedTransaction(recent[i], {
        maxSupportedTransactionVersion: 0,
      }),
    );
    parsed.push(tx);
    if (i + 1 < recent.length) await sleep(120);
  }

  const programs = new Set<string>();
  const counterparties = new Map<string, number>();
  const selfStr = self.toBase58();

  for (const tx of parsed) {
    if (!tx) continue;
    const msg = tx.transaction.message;
    for (const ix of msg.instructions) {
      programs.add(ix.programId.toBase58());
    }
    // Counterparties: writable, non-program account keys other than self.
    const seenThisTx = new Set<string>();
    for (const key of msg.accountKeys) {
      const k = key.pubkey.toBase58();
      if (k === selfStr || key.signer) continue;
      if (programs.has(k)) continue;
      if (!seenThisTx.has(k)) {
        counterparties.set(k, (counterparties.get(k) ?? 0) + 1);
        seenThisTx.add(k);
      }
    }
  }

  const sampleCount = parsed.filter(Boolean).length;
  const topCounterparty = Math.max(0, ...counterparties.values());
  const washScore = sampleCount > 0 ? topCounterparty / sampleCount : 0;

  return {
    distinctPrograms: programs.size,
    washScore: clamp01(washScore),
    sampleCount,
  };
}

/** Current token accounts: ratio of empty (0-balance) accounts = dump proxy. */
async function computeDumpBehavior(conn: Connection, owner: PublicKey) {
  let total = 0;
  let empty = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await withRetry(() =>
      conn.getParsedTokenAccountsByOwner(owner, { programId }),
    ).catch(() => ({ value: [] as any[] }));
    for (const acc of res.value) {
      total++;
      const amt = acc.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
      if (!amt || amt === 0) empty++;
    }
  }
  const dumpScore = total > 0 ? empty / total : 0;
  return { dumpScore: clamp01(dumpScore), tokenAccounts: total };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function ageRisk(ageDays: number): number {
  // 1.0 at <7d, linearly to 0 at >=180d.
  if (ageDays <= 7) return 1;
  if (ageDays >= 180) return 0;
  return clamp01(1 - (ageDays - 7) / (180 - 7));
}

function activityRisk(txCount: number, failedRatio: number): number {
  // Thin history is risky; high failure ratio (spam/bot) adds risk.
  const thin = txCount <= 0 ? 1 : clamp01(1 - txCount / 50); // 0 risk by ~50 txns
  return clamp01(0.6 * thin + 0.4 * failedRatio);
}

function diversityRisk(distinctPrograms: number): number {
  // Interacting with many distinct programs reads as organic.
  // 1.0 at 0-1 programs, 0 at >=8.
  return clamp01(1 - (distinctPrograms - 1) / (8 - 1));
}

export async function scanWallet(
  address: string,
  opts: ScanOptions = {},
): Promise<WalletRiskReport> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana address: ${address}`);
  }

  // Use || (not ??) so an empty SOLANA_RPC_URL ("") falls back to the default
  // endpoint instead of being treated as a valid (broken) URL.
  const conn =
    opts.connection ??
    new Connection(opts.rpcUrl || process.env.SOLANA_RPC_URL || DEFAULT_RPC, {
      commitment: "confirmed",
    });

  const notes: string[] = [];

  // --- gather raw data ---
  const { sigs, hitCap } = await fetchSignatures(conn, pubkey);

  // Optional lookback filter (for activity counting only).
  const cutoff = opts.lookbackDays
    ? Date.now() / 1000 - opts.lookbackDays * 86400
    : 0;
  const windowSigs = cutoff
    ? sigs.filter((s) => (s.blockTime ?? 0) >= cutoff)
    : sigs;

  const { ageDays, isLowerBound } = computeAge(sigs, hitCap);
  const failed = windowSigs.filter((s) => s.err != null).length;
  const failedRatio = windowSigs.length ? failed / windowSigs.length : 0;

  // Transaction-level sampling (diversity + wash) is an expensive RPC call that
  // public endpoints often refuse. Degrade gracefully instead of failing.
  let distinctPrograms = 0;
  let washScore = 0;
  let txSamplingAvailable = true;
  try {
    const sampled = await sampleTransactions(conn, pubkey, windowSigs);
    distinctPrograms = sampled.distinctPrograms;
    washScore = sampled.washScore;
  } catch {
    txSamplingAvailable = false;
    notes.push(
      "Transaction sampling unavailable on this RPC (public endpoints rate-limit getParsedTransactions). Diversity + wash signals were excluded and weights renormalized. Set SOLANA_RPC_URL to a Helius URL for the full signal set.",
    );
  }
  const { dumpScore, tokenAccounts } = await computeDumpBehavior(conn, pubkey);

  if (sigs.length === 0) {
    notes.push(
      "No transaction history found. Wallet is unused, brand new, or on a different cluster.",
    );
  }
  if (isLowerBound) {
    notes.push(
      `Hit ${MAX_SIGNATURES}-signature scan cap; account age is a lower bound (wallet is at least this old).`,
    );
  }
  notes.push(
    "rug_history_flag is a heuristic proxy (very new + thin + concentrated). Definitive rug detection requires enriched data (e.g. Helius enhanced transactions / DAS) — see rules/risk-thresholds.md.",
  );

  // --- components (0-1, pre-weight) ---
  const components = {
    age: ageRisk(ageDays),
    activity: activityRisk(windowSigs.length, failedRatio),
    diversity: diversityRisk(distinctPrograms),
    wash: washScore,
    dump: dumpScore,
  };

  // Maturity dampener: for clearly established/high-volume wallets, the wash and
  // diversity signals (read from only a 25-tx sample) are noisy and false-positive
  // on legit bots / power users who lean on one app. A wallet with a deep history
  // has already proven it isn't a throwaway, so soften those two signals.
  const established = isLowerBound || windowSigs.length >= 200;
  if (established) {
    components.wash *= 0.5;
    components.diversity *= 0.5;
    notes.push(
      "Established/high-volume wallet: wash + app-diversity signals softened (they are noisy on heavy wallets and would otherwise false-positive on legit power users).",
    );
  }

  // Renormalize over only the available signals so a missing input doesn't
  // silently drag the score toward zero.
  // - Drop diversity + wash when tx sampling failed.
  // - Drop age when we hit the signature cap: a busy wallet's recent history
  //   doesn't reveal true age, so 0d here would be a false "brand new" penalty.
  const active: (keyof typeof WEIGHTS)[] = [];
  if (!isLowerBound) active.push("age");
  active.push("activity");
  if (txSamplingAvailable) active.push("diversity", "wash");
  active.push("dump");
  if (isLowerBound) {
    notes.push(
      "Account age excluded from score: hit the signature cap, so true wallet age is unknown (the wallet is highly active). Age shown is a lower bound only.",
    );
  }
  const totalWeight = active.reduce((sum, k) => sum + WEIGHTS[k], 0);
  const raw =
    active.reduce((sum, k) => sum + components[k] * WEIGHTS[k], 0) / totalWeight;

  const risk_score = Math.round(100 * clamp01(raw));
  const risk_level: WalletRiskReport["risk_level"] =
    risk_score > 66 ? "high" : risk_score >= 34 ? "medium" : "low";

  // Heuristic rug proxy: very young + thin history + concentrated counterparty.
  const rug_history_flag =
    ageDays <= 14 && windowSigs.length <= 25 && washScore >= 0.5;

  const report: WalletRiskReport = {
    address: pubkey.toBase58(),
    risk_score,
    risk_level,
    signals: {
      account_age_days: ageDays,
      account_age_is_lower_bound: isLowerBound,
      tx_count_sampled: windowSigs.length,
      failed_tx_ratio: round2(failedRatio),
      distinct_programs: distinctPrograms,
      wash_trading_score: round2(washScore),
      dump_behavior_score: round2(dumpScore),
      rug_history_flag,
    },
    components: mapValues(components, round2),
    summary: buildSummary(risk_level, risk_score, {
      ageDays,
      txCount: windowSigs.length,
      distinctPrograms,
      washScore,
      dumpScore,
      tokenAccounts,
      rug_history_flag,
    }),
    notes,
  };

  return report;
}

function buildSummary(
  level: string,
  score: number,
  s: {
    ageDays: number;
    txCount: number;
    distinctPrograms: number;
    washScore: number;
    dumpScore: number;
    tokenAccounts: number;
    rug_history_flag: boolean;
  },
): string {
  const parts: string[] = [];
  parts.push(`${level.toUpperCase()} risk (${score}/100).`);
  parts.push(
    `~${s.ageDays}d old, ${s.txCount} sampled txns across ${s.distinctPrograms} distinct programs.`,
  );
  if (s.washScore >= 0.5)
    parts.push(`High counterparty concentration (${Math.round(s.washScore * 100)}%).`);
  if (s.dumpScore >= 0.5)
    parts.push(
      `${Math.round(s.dumpScore * 100)}% of token accounts are emptied (acquire-then-dump pattern).`,
    );
  if (s.rug_history_flag) parts.push("Matches young+thin+concentrated rug proxy.");
  if (level === "low") parts.push("Behaviour reads as organic.");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
function mapValues<K extends string, V, R>(
  obj: Record<K, V>,
  fn: (v: V) => R,
): Record<K, R> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, fn(v as V)]),
  ) as Record<K, R>;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("scan_wallet.ts");

if (isMain) {
  const args = process.argv.slice(2);
  const address = args.find((a) => !a.startsWith("--"));
  const jsonOut = args.includes("--json");
  const daysArg = args.find((a) => a.startsWith("--days"));
  const lookbackDays = daysArg
    ? Number(daysArg.split("=")[1] ?? args[args.indexOf(daysArg) + 1])
    : undefined;

  if (!address) {
    console.error("Usage: tsx scripts/scan_wallet.ts <address> [--days N] [--json]");
    process.exit(1);
  }

  scanWallet(address, { lookbackDays })
    .then((report) => {
      if (jsonOut) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHuman(report);
      }
    })
    .catch((err) => {
      console.error("Scan failed:", err.message ?? err);
      process.exit(1);
    });
}

function printHuman(r: WalletRiskReport) {
  const bar = (n: number) =>
    "█".repeat(Math.round(n * 10)).padEnd(10, "░");
  console.log("");
  console.log(`Wallet:     ${r.address}`);
  console.log(`Risk:       ${r.risk_level.toUpperCase()} (${r.risk_score}/100)`);
  console.log("");
  console.log("Signals:");
  console.log(`  account age:        ${r.signals.account_age_days}d${r.signals.account_age_is_lower_bound ? "+" : ""}`);
  console.log(`  sampled txns:       ${r.signals.tx_count_sampled}`);
  console.log(`  failed tx ratio:    ${r.signals.failed_tx_ratio}`);
  console.log(`  distinct programs:  ${r.signals.distinct_programs}`);
  console.log(`  wash concentration: ${r.signals.wash_trading_score}`);
  console.log(`  dump behaviour:     ${r.signals.dump_behavior_score}`);
  console.log(`  rug proxy flag:     ${r.signals.rug_history_flag}`);
  console.log("");
  console.log("Components (pre-weight, 0-1):");
  for (const [k, v] of Object.entries(r.components)) {
    console.log(`  ${k.padEnd(10)} ${bar(v)} ${v}`);
  }
  console.log("");
  console.log(`Summary: ${r.summary}`);
  if (r.notes.length) {
    console.log("");
    console.log("Notes:");
    for (const n of r.notes) console.log(`  - ${n}`);
  }
  console.log("");
}
