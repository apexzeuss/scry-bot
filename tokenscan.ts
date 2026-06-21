/**
 * tokenscan.ts — degen-grade token report.
 *
 * Beyond the basic mint authorities, this answers what a trader actually asks:
 *  - Is there money here?         -> liquidity / market cap / volume / age (DexScreener)
 *  - Am I about to get dumped on? -> top-holder concentration + holder count
 *  - Is the dev a known rugger?   -> score the deployer wallet with the same scorer
 *
 * Everything is best-effort and parallel: a failure in one source leaves that
 * field null rather than failing the whole report.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { scanWallet } from "./scorer/scan_wallet.ts";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export interface TokenReport {
  mint: string;
  decimals: number;
  // authorities
  mint_authority_active: boolean;
  freeze_authority_active: boolean;
  // distribution
  top_holder_pct: number; // largest single account / supply (may be the LP)
  top10_pct: number; // top 10 accounts / supply (may include the LP)
  holder_count: number | null; // best-effort via Helius DAS
  // market (DexScreener)
  has_market: boolean;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  age_days: number | null;
  // deployer
  deployer: string | null;
  deployer_risk_score: number | null;
  deployer_risk_level: string | null;
}

/** Returns null if the address is not a token mint (caller falls back to wallet). */
export async function scanTokenFull(
  mint: string,
  rpcUrl?: string,
): Promise<TokenReport | null> {
  const conn = new Connection(rpcUrl || DEFAULT_RPC, "confirmed");
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }

  // Mint account first — also our token-vs-wallet detector.
  const info: any = await conn.getParsedAccountInfo(mintKey).catch(() => null);
  const data = info?.value?.data;
  if (data?.parsed?.type !== "mint") return null;
  const parsed = data.parsed.info;
  const supply = Number(parsed.supply ?? 0);
  const decimals = Number(parsed.decimals ?? 0);

  const report: TokenReport = {
    mint: mintKey.toBase58(),
    decimals,
    mint_authority_active: parsed.mintAuthority != null,
    freeze_authority_active: parsed.freezeAuthority != null,
    top_holder_pct: 0,
    top10_pct: 0,
    holder_count: null,
    has_market: false,
    liquidity_usd: null,
    market_cap_usd: null,
    volume_24h_usd: null,
    age_days: null,
    deployer: null,
    deployer_risk_score: null,
    deployer_risk_level: null,
  };

  await Promise.allSettled([
    concentration(conn, mintKey, supply, report),
    market(mintKey.toBase58(), report),
    holderCount(rpcUrl, mintKey.toBase58(), report),
    deployer(conn, mintKey, rpcUrl, report),
  ]);

  return report;
}

/** Top-1 and top-10 concentration from the largest token accounts. */
async function concentration(
  conn: Connection,
  mintKey: PublicKey,
  supply: number,
  report: TokenReport,
) {
  if (supply <= 0) return;
  const largest = await conn.getTokenLargestAccounts(mintKey);
  const amounts = largest.value.map((a) => Number(a.amount));
  if (amounts.length === 0) return;
  report.top_holder_pct = round2(amounts[0] / supply);
  const top10 = amounts.slice(0, 10).reduce((s, n) => s + n, 0);
  report.top10_pct = round2(top10 / supply);
}

/** Liquidity / market cap / volume / age from DexScreener (free, no key). */
async function market(mint: string, report: TokenReport) {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return;
  const json: any = await res.json();
  const pairs: any[] = json?.pairs ?? [];
  if (pairs.length === 0) return;
  // Use the deepest pool as the canonical market.
  const best = pairs.sort(
    (a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0),
  )[0];
  report.has_market = true;
  report.liquidity_usd = numOrNull(best?.liquidity?.usd);
  report.market_cap_usd = numOrNull(best?.marketCap ?? best?.fdv);
  report.volume_24h_usd = numOrNull(best?.volume?.h24);
  if (best?.pairCreatedAt) {
    report.age_days = round1((Date.now() - best.pairCreatedAt) / 86_400_000);
  }
}

/** Holder count via Helius DAS getTokenAccounts (Helius RPC only). */
async function holderCount(
  rpcUrl: string | undefined,
  mint: string,
  report: TokenReport,
) {
  if (!rpcUrl || !/helius/i.test(rpcUrl)) return; // DAS is Helius-specific
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "scry",
      method: "getTokenAccounts",
      params: { mint, limit: 1000, options: { showZeroBalance: false } },
    }),
  });
  if (!res.ok) return;
  const json: any = await res.json();
  const accts: any[] = json?.result?.token_accounts ?? [];
  if (accts.length === 0 && json?.result?.total == null) return;
  // 1000 is our page cap; report as a floor if we hit it.
  report.holder_count = accts.length >= 1000 ? 1000 : accts.length;
}

/** Find the mint's creator (oldest signer) and score that wallet. */
async function deployer(
  conn: Connection,
  mintKey: PublicKey,
  rpcUrl: string | undefined,
  report: TokenReport,
) {
  // Page back to the oldest signature (the mint creation), bounded.
  let before: string | undefined;
  let oldest: string | undefined;
  let reachedStart = false;
  for (let page = 0; page < 3; page++) {
    const sigs = await conn.getSignaturesForAddress(mintKey, {
      limit: 1000,
      before,
    });
    if (sigs.length === 0) {
      reachedStart = true;
      break;
    }
    oldest = sigs[sigs.length - 1].signature;
    before = oldest;
    if (sigs.length < 1000) {
      reachedStart = true;
      break;
    }
  }
  if (!oldest || !reachedStart) return; // couldn't confirm the creation tx
  const tx = await conn.getParsedTransaction(oldest, {
    maxSupportedTransactionVersion: 0,
  });
  const keys: any[] = tx?.transaction.message.accountKeys ?? [];
  const feePayer = keys.find((k) => k.signer)?.pubkey?.toBase58();
  if (!feePayer) return;
  report.deployer = feePayer;
  const scored = await scanWallet(feePayer, { connection: conn });
  report.deployer_risk_score = scored.risk_score;
  report.deployer_risk_level = scored.risk_level;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const numOrNull = (n: any): number | null =>
  typeof n === "number" && isFinite(n) ? n : null;
