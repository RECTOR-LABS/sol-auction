import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { getProgram, getExplorerUrl } from "../client.js";
import {
  solToLamports,
  deriveAuctionPda,
  deriveVaultPda,
  deriveHousePda,
  success,
  info,
  header,
  handleError,
} from "../utils.js";

export function registerCreateCommands(program: Command): void {
  const create = program
    .command("create")
    .description("Create a new auction");

  create
    .command("english")
    .description("Create an English (ascending) auction")
    .requiredOption("--mint <MINT>", "Token mint address of the item")
    .requiredOption("--start-price <SOL>", "Starting price in SOL", parseFloat)
    .requiredOption("--duration <SECS>", "Auction duration in seconds", parseInt)
    .requiredOption("--min-increment <SOL>", "Minimum bid increment in SOL", parseFloat)
    .option("--anti-snipe <SECS>", "Anti-snipe extension in seconds", parseInt, 300)
    .option("--house <PUBKEY>", "Auction house PDA (auto-derived if omitted)")
    .action(async (opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const itemMint = new PublicKey(opts.mint);
        const seller = wallet.publicKey;

        // Generate auction ID from timestamp
        const auctionId = new anchor.BN(Date.now());
        const [auctionPda] = deriveAuctionPda(prog.programId, seller, auctionId);
        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);

        // Derive or use provided house
        const housePda = opts.house
          ? new PublicKey(opts.house)
          : deriveHousePda(prog.programId, seller)[0];

        const sellerAta = getAssociatedTokenAddressSync(itemMint, seller);

        const now = Math.floor(Date.now() / 1000);
        const startTime = new anchor.BN(now);
        const endTime = new anchor.BN(now + opts.duration);

        const auctionType = {
          english: {
            startPrice: solToLamports(opts.startPrice),
            minIncrement: solToLamports(opts.minIncrement),
            antiSnipeDuration: new anchor.BN(opts.antiSnipe),
          },
        };

        header("Creating English Auction");
        info("Item Mint", itemMint.toBase58());
        info("Start Price", `${opts.startPrice} SOL`);
        info("Min Increment", `${opts.minIncrement} SOL`);
        info("Duration", `${opts.duration}s`);
        info("Anti-Snipe", `${opts.antiSnipe}s`);

        const tx = await prog.methods
          .createAuction(auctionId, auctionType, startTime, endTime)
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            auctionHouse: housePda,
            itemMint,
            sellerItemAccount: sellerAta,
            seller,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log();
        success("Auction created!");
        info("Auction PDA", auctionPda.toBase58());
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  create
    .command("dutch")
    .description("Create a Dutch (descending) auction")
    .requiredOption("--mint <MINT>", "Token mint address of the item")
    .requiredOption("--start-price <SOL>", "Starting (highest) price in SOL", parseFloat)
    .requiredOption("--reserve <SOL>", "Reserve (floor) price in SOL", parseFloat)
    .requiredOption("--duration <SECS>", "Auction duration in seconds", parseInt)
    .option("--house <PUBKEY>", "Auction house PDA (auto-derived if omitted)")
    .action(async (opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const itemMint = new PublicKey(opts.mint);
        const seller = wallet.publicKey;

        const auctionId = new anchor.BN(Date.now());
        const [auctionPda] = deriveAuctionPda(prog.programId, seller, auctionId);
        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);

        const housePda = opts.house
          ? new PublicKey(opts.house)
          : deriveHousePda(prog.programId, seller)[0];

        const sellerAta = getAssociatedTokenAddressSync(itemMint, seller);

        const now = Math.floor(Date.now() / 1000);
        const startTime = new anchor.BN(now);
        const endTime = new anchor.BN(now + opts.duration);

        const auctionType = {
          dutch: {
            startPrice: solToLamports(opts.startPrice),
            reservePrice: solToLamports(opts.reserve),
          },
        };

        header("Creating Dutch Auction");
        info("Item Mint", itemMint.toBase58());
        info("Start Price", `${opts.startPrice} SOL`);
        info("Reserve Price", `${opts.reserve} SOL`);
        info("Duration", `${opts.duration}s`);

        const tx = await prog.methods
          .createAuction(auctionId, auctionType, startTime, endTime)
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            auctionHouse: housePda,
            itemMint,
            sellerItemAccount: sellerAta,
            seller,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log();
        success("Auction created!");
        info("Auction PDA", auctionPda.toBase58());
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  create
    .command("sealed")
    .description("Create a sealed-bid Vickrey auction")
    .requiredOption("--mint <MINT>", "Token mint address of the item")
    .requiredOption("--min-collateral <SOL>", "Minimum collateral in SOL", parseFloat)
    .requiredOption("--bid-duration <SECS>", "Bidding phase duration in seconds", parseInt)
    .requiredOption("--reveal-duration <SECS>", "Reveal phase duration in seconds", parseInt)
    .option("--house <PUBKEY>", "Auction house PDA (auto-derived if omitted)")
    .action(async (opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const itemMint = new PublicKey(opts.mint);
        const seller = wallet.publicKey;

        const auctionId = new anchor.BN(Date.now());
        const [auctionPda] = deriveAuctionPda(prog.programId, seller, auctionId);
        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);

        const housePda = opts.house
          ? new PublicKey(opts.house)
          : deriveHousePda(prog.programId, seller)[0];

        const sellerAta = getAssociatedTokenAddressSync(itemMint, seller);

        const now = Math.floor(Date.now() / 1000);
        const startTime = new anchor.BN(now);
        const endTime = new anchor.BN(now + opts.bidDuration);

        const auctionType = {
          sealedVickrey: {
            minCollateral: solToLamports(opts.minCollateral),
            revealDuration: new anchor.BN(opts.revealDuration),
          },
        };

        header("Creating Sealed-Bid Vickrey Auction");
        info("Item Mint", itemMint.toBase58());
        info("Min Collateral", `${opts.minCollateral} SOL`);
        info("Bid Duration", `${opts.bidDuration}s`);
        info("Reveal Duration", `${opts.revealDuration}s`);

        const tx = await prog.methods
          .createAuction(auctionId, auctionType, startTime, endTime)
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            auctionHouse: housePda,
            itemMint,
            sellerItemAccount: sellerAta,
            seller,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log();
        success("Auction created!");
        info("Auction PDA", auctionPda.toBase58());
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });
}
