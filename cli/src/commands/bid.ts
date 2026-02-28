import { Command } from "commander";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { getProgram, getExplorerUrl } from "../client.js";
import {
  solToLamports,
  deriveBidPda,
  deriveVaultPda,
  success,
  info,
  header,
  handleError,
} from "../utils.js";

export function registerBidCommands(program: Command): void {
  program
    .command("bid")
    .description("Place a bid on an English auction")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .requiredOption("--amount <SOL>", "Bid amount in SOL", parseFloat)
    .action(async (auctionPdaStr: string, opts) => {
      try {
        const { program: prog, wallet } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const bidder = wallet.publicKey;
        const [bidEscrow] = deriveBidPda(prog.programId, auctionPda, bidder);
        const amount = solToLamports(opts.amount);

        header("Placing Bid");
        info("Auction", auctionPda.toBase58());
        info("Amount", `${opts.amount} SOL`);
        info("Bidder", bidder.toBase58());

        const tx = await prog.methods
          .placeBid(amount)
          .accounts({
            auctionConfig: auctionPda,
            bidEscrow,
            bidder,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        console.log();
        success("Bid placed!");
        info("Bid Escrow", bidEscrow.toBase58());
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("buy")
    .description("Buy now from a Dutch auction")
    .argument("<AUCTION_PDA>", "Auction PDA address")
    .action(async (auctionPdaStr: string) => {
      try {
        const { program: prog, wallet } = getProgram();
        const auctionPda = new PublicKey(auctionPdaStr);
        const buyer = wallet.publicKey;

        // Fetch auction config to get mint, seller, and auction house
        const accounts = prog.account as any;
        const auctionAccount = await accounts.auctionConfig.fetch(auctionPda);
        const itemMint = auctionAccount.itemMint as PublicKey;
        const seller = auctionAccount.seller as PublicKey;

        const [vaultPda] = deriveVaultPda(prog.programId, auctionPda);
        const buyerAta = getAssociatedTokenAddressSync(itemMint, buyer);

        // Find first available auction house
        const auctionHouseAccounts = await accounts.auctionHouse.all();
        if (auctionHouseAccounts.length === 0) {
          throw new Error("No auction house found on-chain");
        }
        const houseAccount = auctionHouseAccounts[0];
        const housePda = houseAccount.publicKey;
        const treasury = houseAccount.account.treasury as PublicKey;

        header("Buying from Dutch Auction");
        info("Auction", auctionPda.toBase58());
        info("Item Mint", itemMint.toBase58());
        info("Buyer", buyer.toBase58());

        const tx = await prog.methods
          .buyNow()
          .accounts({
            auctionConfig: auctionPda,
            itemVault: vaultPda,
            itemMint,
            buyerItemAccount: buyerAta,
            seller,
            buyer,
            auctionHouse: housePda,
            treasury,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        console.log();
        success("Purchase complete!");
        info("Transaction", tx);
        info("Explorer", getExplorerUrl(tx));
      } catch (err) {
        handleError(err);
      }
    });
}
