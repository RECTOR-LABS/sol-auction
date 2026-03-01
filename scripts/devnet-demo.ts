/**
 * Devnet Demo Script — sol-auction
 *
 * Exercises all 3 auction types (English, Dutch, Sealed-Bid Vickrey) end-to-end
 * on devnet and outputs Solana Explorer links for every transaction.
 *
 * Usage:
 *   npx tsx scripts/devnet-demo.ts
 *
 * Requirements:
 *   - Program deployed to devnet at HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC
 *   - ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
 *   - ANCHOR_WALLET pointing to funded devnet keypair (~2 SOL needed)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ── Setup ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPLORER_BASE = "https://explorer.solana.com/tx/";
const CLUSTER = "devnet";

function explorerUrl(sig: string): string {
  return `${EXPLORER_BASE}${sig}?cluster=${CLUSTER}`;
}

function log(label: string, value: string = "") {
  console.log(`  ${label}${value ? ": " + value : ""}`);
}

function header(title: string) {
  console.log();
  console.log(`═══ ${title} ${"═".repeat(Math.max(0, 60 - title.length))}`);
}

function txLog(label: string, sig: string) {
  log(label, sig);
  log("  Explorer", explorerUrl(sig));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fundKeypair(
  connection: Connection,
  payer: Keypair,
  target: Keypair,
  lamports: number,
): Promise<string> {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: target.publicKey,
      lamports,
    }),
  );
  const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
  return sig;
}

// ── Main ───────────────────────────────────────────────

async function main() {
  console.log("\n🏛️  sol-auction Devnet Demo");
  console.log("─".repeat(60));

  // Load provider
  const clusterUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET
    || path.join(os.homedir(), "Documents/secret/solana-devnet.json");

  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))),
  );
  const connection = new Connection(clusterUrl, "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/sol_auction.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as any;

  const payer = walletKeypair;
  const authority = walletKeypair;

  log("Program ID", program.programId.toBase58());
  log("Authority", authority.publicKey.toBase58());

  const balance = await connection.getBalance(authority.publicKey);
  log("Balance", `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.error("\n  ✗ Insufficient balance. Need at least 0.05 SOL for demo.");
    process.exit(1);
  }

  // Track all tx signatures for summary
  const txLinks: { label: string; sig: string }[] = [];
  function recordTx(label: string, sig: string) {
    txLinks.push({ label, sig });
    txLog(label, sig);
  }

  // ── 1. Initialize Auction House ────────────────────

  header("1. Initialize Auction House");

  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house"), authority.publicKey.toBuffer()],
    program.programId,
  );

  let houseExists = false;
  try {
    await program.account.auctionHouse.fetch(housePda);
    houseExists = true;
    log("Status", "Already initialized");
    log("House PDA", housePda.toBase58());
  } catch {
    // Not yet initialized
  }

  if (!houseExists) {
    const sig = await program.methods
      .initializeHouse(250) // 2.5% fee
      .accounts({ authority: authority.publicKey })
      .rpc();
    recordTx("initialize_house", sig);
    log("House PDA", housePda.toBase58());
    log("Fee", "2.5%");
  }

  // Helper to create a token mint and fund seller's ATA with 1 token
  async function createItemToken(): Promise<{ mint: PublicKey; sellerAta: PublicKey }> {
    const mint = await createMint(connection, payer, authority.publicKey, null, 0);
    const sellerAta = await createAssociatedTokenAccount(connection, payer, mint, authority.publicKey);
    await mintTo(connection, payer, mint, sellerAta, authority, 1);
    return { mint, sellerAta };
  }

  // ── 2. English Auction (Full Lifecycle) ────────────

  header("2. English Auction — Full Lifecycle");

  const { mint: engMint, sellerAta: engSellerAta } = await createItemToken();
  log("Item Mint", engMint.toBase58());

  const engAuctionId = new anchor.BN(Date.now());
  const now = Math.floor(Date.now() / 1000);

  const [engAuctionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("auction"),
      authority.publicKey.toBuffer(),
      engAuctionId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [engVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), engAuctionPda.toBuffer()],
    program.programId,
  );

  // Create auction: start 0.005 SOL, increment 0.001 SOL, ends in 15s
  const engCreateSig = await program.methods
    .createAuction(
      engAuctionId,
      {
        english: {
          startPrice: new anchor.BN(0.005 * LAMPORTS_PER_SOL),
          minIncrement: new anchor.BN(0.001 * LAMPORTS_PER_SOL),
          antiSnipeDuration: new anchor.BN(0),
        },
      },
      new anchor.BN(now - 10),
      new anchor.BN(now + 15),
    )
    .accounts({
      seller: authority.publicKey,
      auctionHouse: housePda,
      itemMint: engMint,
      sellerItemAccount: engSellerAta,
    })
    .rpc();
  recordTx("create_auction (English)", engCreateSig);
  log("Auction PDA", engAuctionPda.toBase58());

  // Fund both bidders in parallel (bid + rent + fees)
  const bidder1 = Keypair.generate();
  const bidder2 = Keypair.generate();
  await Promise.all([
    fundKeypair(connection, payer, bidder1, 0.01 * LAMPORTS_PER_SOL),
    fundKeypair(connection, payer, bidder2, 0.015 * LAMPORTS_PER_SOL),
  ]);

  const bid1Sig = await program.methods
    .placeBid(new anchor.BN(0.005 * LAMPORTS_PER_SOL))
    .accounts({
      auctionConfig: engAuctionPda,
      bidder: bidder1.publicKey,
    })
    .signers([bidder1])
    .rpc();
  recordTx("place_bid (Bidder 1: 0.005 SOL)", bid1Sig);

  const bid2Sig = await program.methods
    .placeBid(new anchor.BN(0.008 * LAMPORTS_PER_SOL))
    .accounts({
      auctionConfig: engAuctionPda,
      bidder: bidder2.publicKey,
    })
    .signers([bidder2])
    .rpc();
  recordTx("place_bid (Bidder 2: 0.008 SOL)", bid2Sig);

  // Wait for auction to end
  const engWaitMs = Math.max(0, (now + 16) * 1000 - Date.now());
  log("Waiting", `for auction to end (~${Math.ceil(engWaitMs / 1000)}s)...`);
  await sleep(engWaitMs);

  // Settle
  const winnerAta = await createAssociatedTokenAccount(connection, payer, engMint, bidder2.publicKey);
  const [winnerBidEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), engAuctionPda.toBuffer(), bidder2.publicKey.toBuffer()],
    program.programId,
  );

  const settleSig = await program.methods
    .settleAuction()
    .accounts({
      auctionConfig: engAuctionPda,
      itemVault: engVaultPda,
      itemMint: engMint,
      winnerItemAccount: winnerAta,
      winnerBidEscrow,
      winner: bidder2.publicKey,
      seller: authority.publicKey,
      auctionHouse: housePda,
      treasury: authority.publicKey,
    })
    .rpc();
  recordTx("settle_auction (English)", settleSig);

  // Bidder 1 claims refund
  const [loserBidEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), engAuctionPda.toBuffer(), bidder1.publicKey.toBuffer()],
    program.programId,
  );

  const refundSig = await program.methods
    .claimRefund()
    .accounts({
      auctionConfig: engAuctionPda,
      bidEscrow: loserBidEscrow,
      bidder: bidder1.publicKey,
    })
    .signers([bidder1])
    .rpc();
  recordTx("claim_refund (Bidder 1)", refundSig);

  // Verify
  const engWinnerToken = await getAccount(connection, winnerAta);
  log("Verified", `Winner received ${Number(engWinnerToken.amount)} token(s)`);

  // ── 3. Dutch Auction (Buy Now) ─────────────────────

  header("3. Dutch Auction — Buy Now");

  const { mint: dutchMint, sellerAta: dutchSellerAta } = await createItemToken();
  log("Item Mint", dutchMint.toBase58());

  const dutchAuctionId = new anchor.BN(Date.now());
  const dutchNow = Math.floor(Date.now() / 1000);

  const [dutchAuctionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("auction"),
      authority.publicKey.toBuffer(),
      dutchAuctionId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [dutchVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), dutchAuctionPda.toBuffer()],
    program.programId,
  );

  // Start 0.02 SOL, reserve 0.005 SOL, duration 1 hour
  const dutchCreateSig = await program.methods
    .createAuction(
      dutchAuctionId,
      {
        dutch: {
          startPrice: new anchor.BN(0.02 * LAMPORTS_PER_SOL),
          reservePrice: new anchor.BN(0.005 * LAMPORTS_PER_SOL),
        },
      },
      new anchor.BN(dutchNow - 60),
      new anchor.BN(dutchNow + 3540),
    )
    .accounts({
      seller: authority.publicKey,
      auctionHouse: housePda,
      itemMint: dutchMint,
      sellerItemAccount: dutchSellerAta,
    })
    .rpc();
  recordTx("create_auction (Dutch)", dutchCreateSig);
  log("Auction PDA", dutchAuctionPda.toBase58());

  // Buyer (current price ~0.0197 SOL after 60s decay, fund with headroom)
  const buyer = Keypair.generate();
  await fundKeypair(connection, payer, buyer, 0.025 * LAMPORTS_PER_SOL);
  const buyerAta = await createAssociatedTokenAccount(connection, payer, dutchMint, buyer.publicKey);

  const buySig = await program.methods
    .buyNow()
    .accounts({
      auctionConfig: dutchAuctionPda,
      itemVault: dutchVaultPda,
      itemMint: dutchMint,
      buyerItemAccount: buyerAta,
      seller: authority.publicKey,
      buyer: buyer.publicKey,
      auctionHouse: housePda,
      treasury: authority.publicKey,
    })
    .signers([buyer])
    .rpc();
  recordTx("buy_now (Dutch)", buySig);

  const dutchBuyerToken = await getAccount(connection, buyerAta);
  log("Verified", `Buyer received ${Number(dutchBuyerToken.amount)} token(s)`);

  // ── 4. Sealed-Bid Vickrey Auction ──────────────────

  header("4. Sealed-Bid Vickrey Auction");

  const { mint: sealedMint, sellerAta: sealedSellerAta } = await createItemToken();
  log("Item Mint", sealedMint.toBase58());

  const sealedAuctionId = new anchor.BN(Date.now());
  const sealedNow = Math.floor(Date.now() / 1000);

  const [sealedAuctionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("auction"),
      authority.publicKey.toBuffer(),
      sealedAuctionId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [sealedVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), sealedAuctionPda.toBuffer()],
    program.programId,
  );

  // Bidding ends in 10s, reveal duration 60s after bidding ends
  const sealedCreateSig = await program.methods
    .createAuction(
      sealedAuctionId,
      {
        sealedVickrey: {
          minCollateral: new anchor.BN(0.005 * LAMPORTS_PER_SOL),
          revealDuration: new anchor.BN(60), // 60s reveal window after bidding ends
        },
      },
      new anchor.BN(sealedNow - 10),
      new anchor.BN(sealedNow + 10),
    )
    .accounts({
      seller: authority.publicKey,
      auctionHouse: housePda,
      itemMint: sealedMint,
      sellerItemAccount: sealedSellerAta,
    })
    .rpc();
  recordTx("create_auction (Sealed Vickrey)", sealedCreateSig);
  log("Auction PDA", sealedAuctionPda.toBase58());

  // Fund sealed bidders in parallel (collateral + rent + fees)
  const sealedBidder1 = Keypair.generate();
  const sealedBidder2 = Keypair.generate();
  await Promise.all([
    fundKeypair(connection, payer, sealedBidder1, 0.025 * LAMPORTS_PER_SOL),
    fundKeypair(connection, payer, sealedBidder2, 0.02 * LAMPORTS_PER_SOL),
  ]);

  // Bidder 1: actual bid 0.015 SOL
  const nonce1 = crypto.randomBytes(32);
  const amount1 = new anchor.BN(0.015 * LAMPORTS_PER_SOL);
  const hash1Input = Buffer.concat([amount1.toArrayLike(Buffer, "le", 8), nonce1]);
  const hash1 = Buffer.from(keccak_256(hash1Input));

  const sealed1Sig = await program.methods
    .submitSealedBid(
      Array.from(hash1),
      new anchor.BN(0.02 * LAMPORTS_PER_SOL), // collateral (must >= min_collateral)
    )
    .accounts({
      auctionConfig: sealedAuctionPda,
      bidder: sealedBidder1.publicKey,
    })
    .signers([sealedBidder1])
    .rpc();
  recordTx("submit_sealed_bid (Bidder 1)", sealed1Sig);

  // Bidder 2: actual bid 0.01 SOL
  const nonce2 = crypto.randomBytes(32);
  const amount2 = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
  const hash2Input = Buffer.concat([amount2.toArrayLike(Buffer, "le", 8), nonce2]);
  const hash2 = Buffer.from(keccak_256(hash2Input));

  const sealed2Sig = await program.methods
    .submitSealedBid(
      Array.from(hash2),
      new anchor.BN(0.015 * LAMPORTS_PER_SOL),
    )
    .accounts({
      auctionConfig: sealedAuctionPda,
      bidder: sealedBidder2.publicKey,
    })
    .signers([sealedBidder2])
    .rpc();
  recordTx("submit_sealed_bid (Bidder 2)", sealed2Sig);

  // Wait for bidding to end (extra buffer for devnet clock drift)
  const sealedBidWaitMs = Math.max(0, (sealedNow + 15) * 1000 - Date.now());
  log("Waiting", `for bidding phase to end (~${Math.ceil(sealedBidWaitMs / 1000)}s)...`);
  await sleep(sealedBidWaitMs);

  // Close bidding (permissionless crank) — retry on clock drift
  let closeSig: string;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      closeSig = await program.methods
        .closeBidding()
        .accounts({ auctionConfig: sealedAuctionPda })
        .rpc();
      break;
    } catch (e: any) {
      if (e.error?.errorCode?.code === "AuctionStillActive" && attempt < 4) {
        log("Retry", `devnet clock drift, waiting 3s (attempt ${attempt + 1}/5)...`);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  recordTx("close_bidding", closeSig!);

  // Reveal bids
  const reveal1Sig = await program.methods
    .revealBid(amount1, Array.from(nonce1))
    .accounts({
      auctionConfig: sealedAuctionPda,
      bidder: sealedBidder1.publicKey,
    })
    .signers([sealedBidder1])
    .rpc();
  recordTx("reveal_bid (Bidder 1: 0.015 SOL)", reveal1Sig);

  const reveal2Sig = await program.methods
    .revealBid(amount2, Array.from(nonce2))
    .accounts({
      auctionConfig: sealedAuctionPda,
      bidder: sealedBidder2.publicKey,
    })
    .signers([sealedBidder2])
    .rpc();
  recordTx("reveal_bid (Bidder 2: 0.01 SOL)", reveal2Sig);

  // Wait for reveal period to end: end_time + reveal_duration + buffer
  // reveal_end_time = (sealedNow + 10) + 60 = sealedNow + 70
  const revealWaitMs = Math.max(0, (sealedNow + 75) * 1000 - Date.now());
  log("Waiting", `for reveal period to end (~${Math.ceil(revealWaitMs / 1000)}s)...`);
  await sleep(revealWaitMs);

  // Settle (winner = bidder1 at 0.015 SOL, pays second price 0.01 SOL)
  const sealedWinnerAta = await createAssociatedTokenAccount(
    connection, payer, sealedMint, sealedBidder1.publicKey,
  );
  const [sealedWinnerBidEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), sealedAuctionPda.toBuffer(), sealedBidder1.publicKey.toBuffer()],
    program.programId,
  );

  const sealedSettleSig = await program.methods
    .settleAuction()
    .accounts({
      auctionConfig: sealedAuctionPda,
      itemVault: sealedVaultPda,
      itemMint: sealedMint,
      winnerItemAccount: sealedWinnerAta,
      winnerBidEscrow: sealedWinnerBidEscrow,
      winner: sealedBidder1.publicKey,
      seller: authority.publicKey,
      auctionHouse: housePda,
      treasury: authority.publicKey,
    })
    .rpc();
  recordTx("settle_auction (Vickrey — 2nd price)", sealedSettleSig);

  const sealedWinnerToken = await getAccount(connection, sealedWinnerAta);
  log("Verified", `Winner received ${Number(sealedWinnerToken.amount)} token(s) (pays 2nd price: 0.01 SOL)`);

  // Loser claims refund
  const [sealedLoserBidEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), sealedAuctionPda.toBuffer(), sealedBidder2.publicKey.toBuffer()],
    program.programId,
  );

  const sealedRefundSig = await program.methods
    .claimRefund()
    .accounts({
      auctionConfig: sealedAuctionPda,
      bidEscrow: sealedLoserBidEscrow,
      bidder: sealedBidder2.publicKey,
    })
    .signers([sealedBidder2])
    .rpc();
  recordTx("claim_refund (Sealed Bidder 2)", sealedRefundSig);

  // ── 5. Cancel Auction Demo ──────────────────────────

  header("5. Cancel Auction (no bids)");

  const { mint: cancelMint, sellerAta: cancelSellerAta } = await createItemToken();
  const cancelAuctionId = new anchor.BN(Date.now());
  const cancelNow = Math.floor(Date.now() / 1000);

  const [cancelAuctionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("auction"),
      authority.publicKey.toBuffer(),
      cancelAuctionId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [cancelVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), cancelAuctionPda.toBuffer()],
    program.programId,
  );

  const cancelCreateSig = await program.methods
    .createAuction(
      cancelAuctionId,
      {
        english: {
          startPrice: new anchor.BN(0.005 * LAMPORTS_PER_SOL),
          minIncrement: new anchor.BN(0.001 * LAMPORTS_PER_SOL),
          antiSnipeDuration: new anchor.BN(0),
        },
      },
      new anchor.BN(cancelNow - 10),
      new anchor.BN(cancelNow + 3600),
    )
    .accounts({
      seller: authority.publicKey,
      auctionHouse: housePda,
      itemMint: cancelMint,
      sellerItemAccount: cancelSellerAta,
    })
    .rpc();
  recordTx("create_auction (to cancel)", cancelCreateSig);

  const cancelSig = await program.methods
    .cancelAuction()
    .accounts({
      auctionConfig: cancelAuctionPda,
      itemVault: cancelVaultPda,
      itemMint: cancelMint,
      sellerItemAccount: cancelSellerAta,
      seller: authority.publicKey,
    })
    .rpc();
  recordTx("cancel_auction", cancelSig);

  const cancelledSellerToken = await getAccount(connection, cancelSellerAta);
  log("Verified", `Seller recovered ${Number(cancelledSellerToken.amount)} token(s)`);

  // ── Summary ─────────────────────────────────────────

  header("Transaction Summary");
  console.log();
  for (const { label, sig } of txLinks) {
    console.log(`  ${label}`);
    console.log(`    ${explorerUrl(sig)}`);
    console.log();
  }

  const finalBalance = await connection.getBalance(authority.publicKey);
  log("Final Balance", `${(finalBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log("Total Transactions", `${txLinks.length}`);
  console.log("\n  ✓ Demo complete!\n");
}

main().catch((err) => {
  console.error("\n  ✗ Demo failed:", err);
  process.exit(1);
});
