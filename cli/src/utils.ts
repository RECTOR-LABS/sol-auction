import * as anchor from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import chalk from "chalk";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// -- SOL conversion --

export function solToLamports(sol: number): anchor.BN {
  return new anchor.BN(Math.round(sol * LAMPORTS_PER_SOL));
}

export function lamportsToSol(lamports: anchor.BN | number): string {
  const num = typeof lamports === "number" ? lamports : lamports.toNumber();
  return (num / LAMPORTS_PER_SOL).toFixed(4);
}

// -- PDA derivation --

export function deriveAuctionPda(
  programId: PublicKey,
  seller: PublicKey,
  auctionId: anchor.BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("auction"),
      seller.toBuffer(),
      auctionId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

export function deriveVaultPda(
  programId: PublicKey,
  auctionPda: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), auctionPda.toBuffer()],
    programId
  );
}

export function deriveHousePda(
  programId: PublicKey,
  authority: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("house"), authority.toBuffer()],
    programId
  );
}

export function deriveBidPda(
  programId: PublicKey,
  auctionPda: PublicKey,
  bidder: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("bid"),
      auctionPda.toBuffer(),
      bidder.toBuffer(),
    ],
    programId
  );
}

// -- Sealed bid helpers --

export function computeCommitmentHash(
  amount: anchor.BN,
  nonce: Buffer
): Buffer {
  const input = Buffer.concat([
    amount.toArrayLike(Buffer, "le", 8),
    nonce,
  ]);
  return Buffer.from(keccak_256(input));
}

export function generateNonce(): Buffer {
  return crypto.randomBytes(32);
}

export function saveNonce(auctionPda: string, nonce: Buffer): string {
  const dir = path.resolve(process.cwd(), ".sol-auction");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `nonce-${auctionPda}.hex`);
  fs.writeFileSync(filePath, nonce.toString("hex"));
  return filePath;
}

export function loadNonce(auctionPda: string): Buffer | null {
  const filePath = path.resolve(
    process.cwd(),
    ".sol-auction",
    `nonce-${auctionPda}.hex`
  );
  if (!fs.existsSync(filePath)) return null;
  return Buffer.from(fs.readFileSync(filePath, "utf-8").trim(), "hex");
}

// -- Formatting --

export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatPubkey(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  if (s.length <= 12) return s;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// -- Output helpers --

export function success(msg: string): void {
  console.log(chalk.green.bold("  ✓ ") + msg);
}

export function info(label: string, value: string): void {
  console.log(chalk.gray(`  ${label}: `) + chalk.white(value));
}

export function warn(msg: string): void {
  console.log(chalk.yellow.bold("  ⚠ ") + msg);
}

export function error(msg: string): void {
  console.log(chalk.red.bold("  ✗ ") + msg);
}

export function header(title: string): void {
  console.log();
  console.log(chalk.cyan.bold(`  ${title}`));
  console.log(chalk.cyan("  " + "─".repeat(title.length + 2)));
}

// -- Error handling --

export function handleError(err: unknown): never {
  if (err instanceof anchor.AnchorError) {
    error(`Program error [${err.error.errorCode.code}]: ${err.error.errorMessage}`);
  } else if (err instanceof Error) {
    error(err.message);
  } else {
    error(String(err));
  }
  process.exit(1);
}
