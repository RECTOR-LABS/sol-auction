import { Command } from "commander";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getProgram, getExplorerUrl } from "../client.js";
import {
  solToLamports,
  deriveBidPda,
  computeCommitmentHash,
  generateNonce,
  saveNonce,
  loadNonce,
  success,
  info,
  warn,
  header,
  handleError,
} from "../utils.js";

export function registerSealedCommands(program: Command): void {
  program
    .command("submit-sealed")
    .description("Submit a sealed bid (commitment + collateral)")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .requiredOption(
      "--amount <SOL>",
      "Actual bid amount in SOL (hidden in commitment)",
      parseFloat
    )
    .requiredOption(
      "--collateral <SOL>",
      "Collateral to deposit in SOL",
      parseFloat
    )
    .option(
      "--nonce <HEX_OR_AUTO>",
      "32-byte nonce as hex, or 'auto' to generate",
      "auto"
    )
    .action(async (auctionPdaStr: string, opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const bidder = wallet.publicKey;
        const [bidEscrow] = deriveBidPda(prog.programId, auctionPda, bidder);

        const amount = solToLamports(opts.amount);
        const collateral = solToLamports(opts.collateral);

        // Generate or parse nonce
        let nonce: Buffer;
        if (opts.nonce === "auto") {
          nonce = generateNonce();
          const savedPath = saveNonce(auctionPdaStr, nonce);
          warn(`Nonce saved to ${savedPath} — you need this for reveal!`);
        } else {
          nonce = Buffer.from(opts.nonce, "hex");
          if (nonce.length !== 32) {
            throw new Error("Nonce must be exactly 32 bytes (64 hex chars)");
          }
        }

        // Compute commitment hash: keccak256(amount_le_bytes || nonce)
        const commitmentHash = computeCommitmentHash(amount, nonce);

        header("Submitting Sealed Bid");
        info("Auction", auctionPda.toBase58());
        info("Collateral", `${opts.collateral} SOL`);
        info("Commitment", commitmentHash.toString("hex").slice(0, 16) + "...");
        info("Nonce", nonce.toString("hex").slice(0, 16) + "...");

        const tx = await prog.methods
          .submitSealedBid(Array.from(commitmentHash) as number[], collateral)
          .accounts({
            auctionConfig: auctionPda,
            bidEscrow,
            bidder,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        console.log();
        success("Sealed bid submitted!");
        info("Bid Escrow", bidEscrow.toBase58());
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
        console.log();
        warn(
          "IMPORTANT: Save your nonce — without it you cannot reveal your bid!"
        );
        info("Nonce (full)", nonce.toString("hex"));
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("reveal")
    .description("Reveal a previously submitted sealed bid")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .requiredOption(
      "--amount <SOL>",
      "The actual bid amount in SOL",
      parseFloat
    )
    .option(
      "--nonce <HEX>",
      "32-byte nonce as hex (auto-loaded from saved file if omitted)"
    )
    .action(async (auctionPdaStr: string, opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const bidder = wallet.publicKey;
        const [bidEscrow] = deriveBidPda(prog.programId, auctionPda, bidder);

        const amount = solToLamports(opts.amount);

        // Load nonce from flag or saved file
        let nonce: Buffer;
        if (opts.nonce) {
          nonce = Buffer.from(opts.nonce, "hex");
        } else {
          const saved = loadNonce(auctionPdaStr);
          if (!saved) {
            throw new Error(
              "No nonce provided and no saved nonce found. " +
                "Pass --nonce <HEX> or ensure .sol-auction/nonce-<PDA>.hex exists."
            );
          }
          nonce = saved;
          info("Nonce", "loaded from saved file");
        }

        if (nonce.length !== 32) {
          throw new Error("Nonce must be exactly 32 bytes (64 hex chars)");
        }

        header("Revealing Sealed Bid");
        info("Auction", auctionPda.toBase58());
        info("Amount", `${opts.amount} SOL`);

        const tx = await prog.methods
          .revealBid(amount, Array.from(nonce) as number[])
          .accounts({
            auctionConfig: auctionPda,
            bidEscrow,
            bidder,
          })
          .rpc();

        console.log();
        success("Bid revealed!");
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });
}
