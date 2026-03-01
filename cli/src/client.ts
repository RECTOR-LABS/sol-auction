import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IDL_PATH = path.resolve(__dirname, "../../target/idl/sol_auction.json");

function loadIdl(): any {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`IDL not found at ${IDL_PATH}. Run 'anchor build' first.`);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
}

export interface ProgramClient {
  program: Program;
  provider: anchor.AnchorProvider;
  wallet: Keypair;
}

export function getProgram(): ProgramClient {
  const clusterUrl =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const walletPath =
    process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet keypair not found at ${walletPath}. ` +
        `Set ANCHOR_WALLET or run 'solana-keygen new'.`
    );
  }

  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  const connection = new Connection(clusterUrl, "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new Program(idl, provider);

  return { program, provider, wallet: walletKeypair };
}

export function getExplorerUrl(signature: string): string {
  const clusterUrl =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

  let cluster = "devnet";
  if (clusterUrl.includes("mainnet")) cluster = "";
  else if (clusterUrl.includes("localhost") || clusterUrl.includes("127.0.0.1"))
    cluster = "custom&customUrl=http://localhost:8899";

  const base = "https://explorer.solana.com/tx/" + signature;
  return cluster ? `${base}?cluster=${cluster}` : base;
}
