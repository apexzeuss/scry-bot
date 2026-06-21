/**
 * watcher.ts — in-process deployment watcher for the bot.
 *
 * A self-contained version of the skill's deployment watcher so /watch works on
 * a standalone host (no sibling repo, no child process). It polls new blocks for
 * fresh token mints, applies fast hard rug checks, and only scores the deployer
 * wallet for tokens that already look risky (so it stays responsive).
 *
 * Flag criterion is the token's authorities, NOT supply concentration: every
 * brand-new token holds ~100% of supply before it trades, so concentration would
 * flag everything. Mint/freeze authority still being active is the real signal.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { scanWallet, WalletRiskReport } from "./scorer/scan_wallet.ts";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export interface TokenRisk {
  mint_authority_active: boolean;
  freeze_authority_active: boolean;
  top_holder_pct: number;
}

export interface WatchFlag {
  mint: string;
  deployer: string;
  deployer_risk_score: number; // -1 if not scored
  deployer_risk_level: string;
  token_risk: TokenRisk;
  reasons: string[]; // plain-English
}

export interface WatchController {
  stop: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keyToStr(k: any): string | undefined {
  if (!k) return undefined;
  if (typeof k === "string") return k;
  if (k.pubkey) return k.pubkey.toString();
  if (typeof k.toBase58 === "function") return k.toBase58();
  return undefined;
}

/** New token mints in a parsed block (top-level + inner/CPI instructions). */
function extractTokenMints(
  block: any,
  slot: number,
): { mint: string; deployer: string; slot: number }[] {
  const out: { mint: string; deployer: string; slot: number }[] = [];
  for (const tx of block.transactions ?? []) {
    if (tx.meta?.err) continue;
    const msg: any = tx.transaction.message;
    const accountKeys: any[] = msg.accountKeys ?? msg.staticAccountKeys ?? [];
    const deployer = keyToStr(accountKeys[0]);
    if (!deployer) continue;

    const innerIxs: any[] = (tx.meta?.innerInstructions ?? []).flatMap(
      (g: any) => g.instructions ?? [],
    );
    const instructions: any[] = [...(msg.instructions ?? []), ...innerIxs];
    for (const ix of instructions) {
      const program = ix.program as string | undefined;
      const programId = keyToStr(ix.programId);
      if (
        ix.parsed &&
        (program === "spl-token" || TOKEN_PROGRAMS.has(programId ?? "")) &&
        (ix.parsed.type === "initializeMint" ||
          ix.parsed.type === "initializeMint2")
      ) {
        const mint = ix.parsed.info?.mint;
        if (mint) out.push({ mint, deployer, slot });
      }
    }
  }
  return out;
}

/** Hard token rug checks (two single RPC calls). */
async function inspectToken(
  conn: Connection,
  mint: string,
): Promise<TokenRisk | null> {
  try {
    const mintKey = new PublicKey(mint);
    const info: any = await conn.getParsedAccountInfo(mintKey);
    const parsed = info.value?.data?.parsed?.info;
    if (!parsed) return null;
    const supply = Number(parsed.supply ?? 0);
    let topHolderPct = 0;
    try {
      const largest = await conn.getTokenLargestAccounts(mintKey);
      const top = largest.value?.[0]?.amount;
      if (top && supply > 0) topHolderPct = Number(top) / supply;
    } catch {
      /* optional */
    }
    return {
      mint_authority_active: parsed.mintAuthority != null,
      freeze_authority_active: parsed.freezeAuthority != null,
      top_holder_pct: Math.round(topHolderPct * 100) / 100,
    };
  } catch {
    return null;
  }
}

/** Token-level red flags worth surfacing (authorities, not launch concentration). */
function tokenRedFlags(t: TokenRisk): string[] {
  const r: string[] = [];
  if (t.freeze_authority_active)
    r.push("Can freeze your tokens (honeypot risk)");
  if (t.mint_authority_active)
    r.push("Creator can still mint unlimited new supply");
  return r;
}

/**
 * Watch for the given duration. Calls onFlag for each risky new token.
 * Returns a controller whose stop() ends it early.
 */
export function watchDeployments(
  opts: {
    rpcUrl?: string;
    durationMs: number;
    intervalMs?: number;
    minScore?: number;
  },
  onFlag: (f: WatchFlag) => void,
): WatchController {
  const conn = new Connection(opts.rpcUrl || DEFAULT_RPC, "confirmed");
  const interval = opts.intervalMs ?? 8_000;
  const minScore = opts.minScore ?? 67;
  const maxSlotsPerPoll = 22; // ~cover the stream between polls (~2.5 slots/s)
  const maxInspectPerPoll = 20; // bound fast RPC work
  const seen = new Set<string>();
  const deadline = Date.now() + opts.durationMs;
  let stopped = false;

  (async () => {
    let lastSlot = await conn.getSlot("confirmed").catch(() => 0);
    while (!stopped && Date.now() < deadline) {
      try {
        const tip = await conn.getSlot("confirmed");
        const from = Math.max(lastSlot + 1, tip - maxSlotsPerPoll + 1);
        let inspected = 0;
        for (let slot = from; slot <= tip && !stopped; slot++) {
          if (inspected >= maxInspectPerPoll) break;
          const block: any = await conn
            .getParsedBlock(slot, {
              maxSupportedTransactionVersion: 0,
              transactionDetails: "full",
              rewards: false,
            })
            .catch(() => null);
          if (!block) continue;

          for (const m of extractTokenMints(block, slot)) {
            if (stopped || inspected >= maxInspectPerPoll) break;
            if (seen.has(m.mint)) continue;
            seen.add(m.mint);
            inspected++;

            const t = await inspectToken(conn, m.mint);
            if (!t) continue;
            const reasons = tokenRedFlags(t);
            if (reasons.length === 0) continue; // fast filter: only risky tokens

            // Score the deployer only for already-flagged tokens (bounded).
            let report: WalletRiskReport | null = null;
            try {
              report = await scanWallet(m.deployer, { connection: conn });
            } catch {
              /* deployer score is best-effort */
            }
            if (report && report.risk_score >= minScore) {
              reasons.push(
                `Deployer wallet also scores ${report.risk_score}/100`,
              );
            }

            onFlag({
              mint: m.mint,
              deployer: m.deployer,
              deployer_risk_score: report?.risk_score ?? -1,
              deployer_risk_level: report?.risk_level ?? "unscored",
              token_risk: t,
              reasons,
            });
          }
        }
        lastSlot = tip;
      } catch {
        /* transient RPC hiccup; keep polling */
      }
      const wait = Math.min(interval, Math.max(0, deadline - Date.now()));
      if (wait > 0 && !stopped) await sleep(wait);
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}
