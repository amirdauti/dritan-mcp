#!/usr/bin/env node
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DritanClient, type SwapBuildRequest, type KnownDexStream } from "dritan-sdk";
import { Connection, Keypair, VersionedTransaction, clusterApiUrl } from "@solana/web3.js";
import { z } from "zod";

const DEFAULT_WALLET_DIR = join(homedir(), ".config", "dritan-mcp", "wallets");

const server = new Server(
  {
    name: "dritan-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

function getDritanClient(): DritanClient {
  const apiKey = process.env.DRITAN_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DRITAN_API_KEY in environment");
  }

  return new DritanClient({
    apiKey,
    baseUrl: process.env.DRITAN_BASE_URL,
    wsBaseUrl: process.env.DRITAN_WS_BASE_URL,
  });
}

function getPlatformInstallHint(binary: "solana-keygen"): { platform: string; install: string[] } {
  switch (process.platform) {
    case "darwin":
      return {
        platform: "macOS",
        install: [
          "sh -c \"$(curl -sSfL https://release.anza.xyz/stable/install)\"",
          "export PATH=\"$HOME/.local/share/solana/install/active_release/bin:$PATH\"",
          "solana-keygen --version",
        ],
      };
    case "linux":
      return {
        platform: "Linux",
        install: [
          "sh -c \"$(curl -sSfL https://release.anza.xyz/stable/install)\"",
          "export PATH=\"$HOME/.local/share/solana/install/active_release/bin:$PATH\"",
          "solana-keygen --version",
        ],
      };
    case "win32":
      return {
        platform: "Windows",
        install: [
          "Install WSL2 (recommended) and run Linux install inside WSL.",
          "Or follow Solana/Anza Windows instructions, then ensure `solana-keygen` is in PATH.",
        ],
      };
    default:
      return {
        platform: process.platform,
        install: ["Install Solana CLI and ensure `solana-keygen` is available in PATH."],
      };
  }
}

function checkSolanaCli(): {
  ok: boolean;
  binary: string;
  version: string | null;
  installHint: { platform: string; install: string[] };
} {
  const installHint = getPlatformInstallHint("solana-keygen");
  const cmd = spawnSync("solana-keygen", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (cmd.error || cmd.status !== 0) {
    return {
      ok: false,
      binary: "solana-keygen",
      version: null,
      installHint,
    };
  }

  return {
    ok: true,
    binary: "solana-keygen",
    version: (cmd.stdout || "").trim() || null,
    installHint,
  };
}

function ensureWalletDir(walletDir: string): void {
  mkdirSync(walletDir, { recursive: true });
}

function toWalletPath(name: string, walletDir?: string): string {
  const dir = resolve(walletDir ?? DEFAULT_WALLET_DIR);
  ensureWalletDir(dir);
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  return resolve(join(dir, `${safeName}.json`));
}

function createLocalWalletFile(walletPath: string): { walletPath: string; address: string } {
  const dir = dirname(walletPath);
  ensureWalletDir(dir);

  if (existsSync(walletPath)) {
    throw new Error(`Wallet already exists: ${walletPath}`);
  }

  const cmd = spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "-o", walletPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (cmd.error) {
    const hint = getPlatformInstallHint("solana-keygen");
    throw new Error(
      `SOLANA_CLI_MISSING: failed to run solana-keygen (${cmd.error.message}). Install steps (${hint.platform}): ${hint.install.join(
        " && ",
      )}`,
    );
  }
  if (cmd.status !== 0) {
    throw new Error(`solana-keygen failed (${cmd.status}): ${cmd.stderr || cmd.stdout}`);
  }

  const keypair = loadKeypairFromPath(walletPath);
  return { walletPath, address: keypair.publicKey.toBase58() };
}

function loadKeypairFromPath(walletPath: string): Keypair {
  const bytes = JSON.parse(readFileSync(walletPath, "utf8")) as unknown;
  if (!Array.isArray(bytes) || bytes.some((v) => typeof v !== "number")) {
    throw new Error(`Invalid wallet file format: ${walletPath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function getRpcUrl(rpcUrl?: string): string {
  return rpcUrl || process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
}

function ok(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

const walletCreateSchema = z.object({
  name: z.string().min(1).default("agent-wallet"),
  walletDir: z.string().min(1).optional(),
});

const walletPathSchema = z.object({
  walletPath: z.string().min(1),
});

const walletBalanceSchema = walletPathSchema.extend({
  rpcUrl: z.string().url().optional(),
});

const marketSnapshotSchema = z.object({
  mint: z.string().min(1),
  mode: z.enum(["price", "metadata", "risk", "first-buyers", "aggregated"]).default("aggregated"),
});

const marketStreamSampleSchema = z.object({
  dex: z.enum(["pumpamm", "pumpfun", "launchlab", "dlmm", "damm2", "damm1", "dbc"]),
  durationMs: z.number().int().min(500).max(60_000).default(10_000),
  maxEvents: z.number().int().min(1).max(250).default(20),
});

const swapBuildSchema = z.object({
  walletPath: z.string().min(1).optional(),
  userPublicKey: z.string().min(1).optional(),
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amount: z.union([z.number().int().positive(), z.string().min(1)]),
  slippageBps: z.number().int().min(1).max(5000).optional(),
  swapType: z.string().min(1).optional(),
  feeWallet: z.string().min(1).optional(),
  feeBps: z.number().int().min(0).max(10_000).optional(),
  feePercent: z.number().min(0).max(100).optional(),
});

const swapSignBroadcastSchema = z.object({
  walletPath: z.string().min(1),
  transactionBase64: z.string().min(1),
});

const tools: Tool[] = [
  {
    name: "system_check_prereqs",
    description:
      "Check whether required local binaries are installed (currently solana-keygen) and return install commands.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "wallet_create_local",
    description: "Create a local Solana wallet using solana-keygen and return path + public address.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Wallet name, used as <name>.json" },
        walletDir: { type: "string", description: "Optional wallet directory path" },
      },
    },
  },
  {
    name: "wallet_get_address",
    description: "Get the public address for a local Solana wallet file.",
    inputSchema: {
      type: "object",
      required: ["walletPath"],
      properties: {
        walletPath: { type: "string" },
      },
    },
  },
  {
    name: "wallet_get_balance",
    description: "Get SOL balance for a local wallet address from a Solana RPC endpoint.",
    inputSchema: {
      type: "object",
      required: ["walletPath"],
      properties: {
        walletPath: { type: "string" },
        rpcUrl: { type: "string" },
      },
    },
  },
  {
    name: "market_get_snapshot",
    description: "Fetch token market snapshot via Dritan SDK (price/metadata/risk/first-buyers/aggregated).",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
        mode: {
          type: "string",
          enum: ["price", "metadata", "risk", "first-buyers", "aggregated"],
        },
      },
    },
  },
  {
    name: "market_stream_sample",
    description: "Open a DEX websocket stream and collect events for a short duration.",
    inputSchema: {
      type: "object",
      required: ["dex"],
      properties: {
        dex: {
          type: "string",
          enum: ["pumpamm", "pumpfun", "launchlab", "dlmm", "damm2", "damm1", "dbc"],
        },
        durationMs: { type: "number" },
        maxEvents: { type: "number" },
      },
    },
  },
  {
    name: "swap_build",
    description: "Build an unsigned swap transaction with Dritan.",
    inputSchema: {
      type: "object",
      required: ["inputMint", "outputMint", "amount"],
      properties: {
        walletPath: { type: "string" },
        userPublicKey: { type: "string" },
        inputMint: { type: "string" },
        outputMint: { type: "string" },
        amount: { anyOf: [{ type: "number" }, { type: "string" }] },
        slippageBps: { type: "number" },
        swapType: { type: "string" },
        feeWallet: { type: "string" },
        feeBps: { type: "number" },
        feePercent: { type: "number" },
      },
    },
  },
  {
    name: "swap_sign_and_broadcast",
    description:
      "Sign a base64 swap transaction with a local wallet and broadcast through Dritan.",
    inputSchema: {
      type: "object",
      required: ["walletPath", "transactionBase64"],
      properties: {
        walletPath: { type: "string" },
        transactionBase64: { type: "string" },
      },
    },
  },
  {
    name: "swap_build_sign_and_broadcast",
    description:
      "Convenience tool: build swap, sign locally with wallet, and broadcast in one call.",
    inputSchema: {
      type: "object",
      required: ["walletPath", "inputMint", "outputMint", "amount"],
      properties: {
        walletPath: { type: "string" },
        inputMint: { type: "string" },
        outputMint: { type: "string" },
        amount: { anyOf: [{ type: "number" }, { type: "string" }] },
        slippageBps: { type: "number" },
        swapType: { type: "string" },
        feeWallet: { type: "string" },
        feeBps: { type: "number" },
        feePercent: { type: "number" },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments ?? {};

    switch (request.params.name) {
      case "system_check_prereqs": {
        const solanaCli = checkSolanaCli();
        return ok({
          ready: solanaCli.ok,
          checks: [solanaCli],
          nextAction: solanaCli.ok
            ? "Environment ready."
            : "Install Solana CLI using installHint, then retry wallet_create_local.",
        });
      }

      case "wallet_create_local": {
        const input = walletCreateSchema.parse(args);
        const walletPath = toWalletPath(input.name, input.walletDir);
        const created = createLocalWalletFile(walletPath);
        return ok(created);
      }

      case "wallet_get_address": {
        const input = walletPathSchema.parse(args);
        const keypair = loadKeypairFromPath(resolve(input.walletPath));
        return ok({ walletPath: resolve(input.walletPath), address: keypair.publicKey.toBase58() });
      }

      case "wallet_get_balance": {
        const input = walletBalanceSchema.parse(args);
        const keypair = loadKeypairFromPath(resolve(input.walletPath));
        const rpcUrl = getRpcUrl(input.rpcUrl);
        const conn = new Connection(rpcUrl, "confirmed");
        const lamports = await conn.getBalance(keypair.publicKey, "confirmed");
        return ok({
          walletPath: resolve(input.walletPath),
          address: keypair.publicKey.toBase58(),
          rpcUrl,
          lamports,
          sol: lamports / 1_000_000_000,
        });
      }

      case "market_get_snapshot": {
        const input = marketSnapshotSchema.parse(args);
        const client = getDritanClient();

        if (input.mode === "price") return ok(await client.getTokenPrice(input.mint));
        if (input.mode === "metadata") return ok(await client.getTokenMetadata(input.mint));
        if (input.mode === "risk") return ok(await client.getTokenRisk(input.mint));
        if (input.mode === "first-buyers") return ok(await client.getFirstBuyers(input.mint));
        return ok(await client.getTokenAggregated(input.mint));
      }

      case "market_stream_sample": {
        const input = marketStreamSampleSchema.parse(args);
        const client = getDritanClient();
        const events: unknown[] = [];
        let opened = false;
        let closed = false;

        const done = new Promise<void>((resolvePromise) => {
          const handle = client.streamDex(input.dex as KnownDexStream, {
            onOpen: () => {
              opened = true;
            },
            onClose: () => {
              closed = true;
              resolvePromise();
            },
            onMessage: (event) => {
              events.push(event);
              if (events.length >= input.maxEvents) {
                handle.close();
              }
            },
          });

          setTimeout(() => {
            if (!closed) {
              handle.close();
            }
          }, input.durationMs);
        });

        await done;
        return ok({ dex: input.dex, opened, closed, eventsCaptured: events.length, sample: events });
      }

      case "swap_build": {
        const input = swapBuildSchema.parse(args);
        const client = getDritanClient();

        const resolvedUserPublicKey = input.userPublicKey
          ? input.userPublicKey
          : input.walletPath
            ? loadKeypairFromPath(resolve(input.walletPath)).publicKey.toBase58()
            : null;

        if (!resolvedUserPublicKey) {
          throw new Error("Provide either userPublicKey or walletPath");
        }

        const body: SwapBuildRequest = {
          userPublicKey: resolvedUserPublicKey,
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          amount: input.amount,
          slippageBps: input.slippageBps,
          swapType: input.swapType,
          feeWallet: input.feeWallet,
          feeBps: input.feeBps,
          feePercent: input.feePercent,
        };

        return ok(await client.buildSwap(body));
      }

      case "swap_sign_and_broadcast": {
        const input = swapSignBroadcastSchema.parse(args);
        const keypair = loadKeypairFromPath(resolve(input.walletPath));
        const tx = VersionedTransaction.deserialize(Buffer.from(input.transactionBase64, "base64"));
        tx.sign([keypair]);
        const signedTransactionBase64 = Buffer.from(tx.serialize()).toString("base64");

        const client = getDritanClient();
        const result = await client.broadcastSwap(signedTransactionBase64);

        return ok({
          signature: result.signature,
          signer: keypair.publicKey.toBase58(),
        });
      }

      case "swap_build_sign_and_broadcast": {
        const input = swapBuildSchema.extend({ walletPath: z.string().min(1) }).parse(args);
        const walletPath = resolve(input.walletPath);
        const keypair = loadKeypairFromPath(walletPath);
        const client = getDritanClient();

        const built = await client.buildSwap({
          userPublicKey: keypair.publicKey.toBase58(),
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          amount: input.amount,
          slippageBps: input.slippageBps,
          swapType: input.swapType,
          feeWallet: input.feeWallet,
          feeBps: input.feeBps,
          feePercent: input.feePercent,
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
        tx.sign([keypair]);
        const signedTransactionBase64 = Buffer.from(tx.serialize()).toString("base64");
        const sent = await client.broadcastSwap(signedTransactionBase64);

        return ok({
          signer: keypair.publicKey.toBase58(),
          fees: built.fees,
          quote: built.quote,
          signature: sent.signature,
        });
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
