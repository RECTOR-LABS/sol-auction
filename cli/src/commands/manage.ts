import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { getProgram, getExplorerUrl } from "../client.js";
import {
  lamportsToSol,
  deriveVaultPda,
  deriveBidPda,
  formatTimestamp,
  success,
  info,
  header,
  handleError,
} from "../utils.js";
import chalk from "chalk";

export function registerManageCommands(program: Command): void {
  program
    .command("settle")
    .description("Settle a completed auction (transfer item + payment)")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .requiredOption("--winner <PUBKEY>", "Winner's public key")
    .option("--house <PUBKEY>", "Auction house PDA (auto-detected if omitted)")
    .action(async (auctionPdaStr: string, opts) => {
      try {
        const { program: prog } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const winner = new PublicKey(opts.winner);

        // Fetch auction config
        const accounts = prog.account as any;
        const auctionAccount = await accounts.auctionConfig.fetch(auctionPda);
        const itemMint = auctionAccount.itemMint as PublicKey;
        const seller = auctionAccount.seller as PublicKey;

        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);
        const [winnerBidEscrow] = deriveBidPda(
          prog.programId,
          auctionPda,
          winner
        );
        const winnerAta = getAssociatedTokenAddressSync(itemMint, winner);

        // Find auction house
        let housePda: PublicKey;
        let treasury: PublicKey;
        if (opts.house) {
          housePda = new PublicKey(opts.house);
          const houseAccount = await accounts.auctionHouse.fetch(housePda);
          treasury = houseAccount.treasury as PublicKey;
        } else {
          const houses = await accounts.auctionHouse.all();
          if (houses.length === 0) throw new Error("No auction house found");
          housePda = houses[0].publicKey;
          treasury = houses[0].account.treasury as PublicKey;
        }

        header("Settling Auction");
        info("Auction", auctionPda.toBase58());
        info("Winner", winner.toBase58());

        const tx = await prog.methods
          .settleAuction()
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            itemMint,
            winnerItemAccount: winnerAta,
            winnerBidEscrow,
            winner,
            seller,
            auctionHouse: housePda,
            treasury,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log();
        success("Auction settled!");
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("cancel")
    .description("Cancel an auction (only if no bids placed)")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .action(async (auctionPdaStr: string) => {
      try {
        const { program: prog, wallet } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const seller = wallet.publicKey;

        // Fetch auction to get mint
        const auctionAccount = await (prog.account as any).auctionConfig.fetch(
          auctionPda
        );
        const itemMint = auctionAccount.itemMint as PublicKey;

        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);
        const sellerAta = getAssociatedTokenAddressSync(itemMint, seller);

        header("Cancelling Auction");
        info("Auction", auctionPda.toBase58());

        const tx = await prog.methods
          .cancelAuction()
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            itemMint,
            sellerItemAccount: sellerAta,
            seller,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log();
        success("Auction cancelled!");
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("close-bidding")
    .description(
      "Close bidding phase for a sealed auction (permissionless crank)"
    )
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .action(async (auctionPdaStr: string) => {
      try {
        const { program: prog } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);

        header("Closing Bidding Phase");
        info("Auction", auctionPda.toBase58());

        const tx = await prog.methods
          .closeBidding()
          .accounts({
            auctionConfig: auctionPda,
          })
          .rpc();

        console.log();
        success("Bidding phase closed — reveal phase started!");
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("status")
    .description("Display current auction status")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .action(async (auctionPdaStr: string) => {
      try {
        const { program: prog } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);

        const auction = await (prog.account as any).auctionConfig.fetch(
          auctionPda
        );
        const now = Math.floor(Date.now() / 1000);

        header("Auction Status");
        info("PDA", auctionPda.toBase58());
        info("Seller", (auction.seller as PublicKey).toBase58());
        info("Item Mint", (auction.itemMint as PublicKey).toBase58());
        info("Auction ID", (auction.auctionId as anchor.BN).toString());

        // Status
        const status = parseStatus(auction.status);
        const statusColor =
          status === "Active"
            ? chalk.green(status)
            : status === "Settled"
            ? chalk.blue(status)
            : status === "Cancelled"
            ? chalk.red(status)
            : chalk.yellow(status);
        info("Status", statusColor);

        // Timing
        const startTime = (auction.startTime as anchor.BN).toNumber();
        const endTime = (auction.endTime as anchor.BN).toNumber();
        info("Start Time", formatTimestamp(startTime));
        info("End Time", formatTimestamp(endTime));

        if (now < startTime) {
          info("Time Until Start", `${startTime - now}s`);
        } else if (now < endTime) {
          info("Time Remaining", `${endTime - now}s`);
        } else {
          info("Ended", `${now - endTime}s ago`);
        }

        // Type-specific info
        const auctionType = auction.auctionType as any;
        console.log();

        if (auctionType.english) {
          const e = auctionType.english;
          info("Type", chalk.cyan("English (Ascending)"));
          info("Start Price", `${lamportsToSol(e.startPrice)} SOL`);
          info("Min Increment", `${lamportsToSol(e.minIncrement)} SOL`);
          info(
            "Anti-Snipe",
            `${(e.antiSnipeDuration as anchor.BN).toNumber()}s`
          );
          info("Highest Bid", `${lamportsToSol(e.highestBid)} SOL`);
          info("Bid Count", e.bidCount.toString());
          if (e.highestBidder) {
            info("Highest Bidder", (e.highestBidder as PublicKey).toBase58());
          }
        } else if (auctionType.dutch) {
          const d = auctionType.dutch;
          info("Type", chalk.magenta("Dutch (Descending)"));
          info("Start Price", `${lamportsToSol(d.startPrice)} SOL`);
          info("Reserve Price", `${lamportsToSol(d.reservePrice)} SOL`);

          // Calculate current price (linear decay)
          if (now >= startTime && now <= endTime) {
            const elapsed = now - startTime;
            const duration = endTime - startTime;
            const startP = (d.startPrice as anchor.BN).toNumber();
            const reserveP = (d.reservePrice as anchor.BN).toNumber();
            const currentPrice =
              startP - Math.floor(((startP - reserveP) * elapsed) / duration);
            info(
              "Current Price",
              chalk.bold(`${lamportsToSol(currentPrice)} SOL`)
            );
          }
        } else if (auctionType.sealedVickrey) {
          const s = auctionType.sealedVickrey;
          info("Type", chalk.yellow("Sealed-Bid Vickrey"));
          info("Min Collateral", `${lamportsToSol(s.minCollateral)} SOL`);
          const revealEnd = (s.revealEndTime as anchor.BN).toNumber();
          info("Reveal End", formatTimestamp(revealEnd));
          info("Bid Count", s.bidCount.toString());

          if (status === "RevealPhase" || status === "Settled") {
            info("Highest Bid", `${lamportsToSol(s.highestBid)} SOL`);
            info("Second Bid", `${lamportsToSol(s.secondBid)} SOL`);
            if (s.winner) {
              info("Winner", (s.winner as PublicKey).toBase58());
            }
          }

          if (now < endTime) {
            info("Phase", chalk.green("Bidding"));
          } else if (now < revealEnd) {
            info("Phase", chalk.yellow("Reveal"));
            info("Reveal Time Left", `${revealEnd - now}s`);
          } else {
            info("Phase", chalk.red("Reveal Ended"));
          }
        }

        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}

function parseStatus(status: any): string {
  if (status.created !== undefined) return "Created";
  if (status.active !== undefined) return "Active";
  if (status.biddingClosed !== undefined) return "BiddingClosed";
  if (status.revealPhase !== undefined) return "RevealPhase";
  if (status.settled !== undefined) return "Settled";
  if (status.cancelled !== undefined) return "Cancelled";
  return "Unknown";
}
