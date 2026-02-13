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
import {
  DritanClient,
  MeteoraThsClient,
  type SwapBuildRequest,
  type KnownDexStream,
  type TokenOhlcvResponse,
} from "dritan-sdk";
import { Connection, Keypair, VersionedTransaction, clusterApiUrl } from "@solana/web3.js";
import { z } from "zod";

const DEFAULT_WALLET_DIR = join(homedir(), ".config", "dritan-mcp", "wallets");
const STREAM_DEXES = [
  "pumpamm",
  "pumpfun",
  "launchlab",
  "dlmm",
  "damm2",
  "damm1",
  "dbc",
  "amm",
  "cpmm",
  "clmm",
  "orca",
] as const;

const server = new Server(
  {
    name: "dritan-mcp",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: [
      "This server requires a DRITAN_API_KEY environment variable to use market data and swap tools.",
      "Get your API key at https://dritan.dev and configure it:",
      "  claude mcp add dritan-mcp -e DRITAN_API_KEY=<your-key> -- npx @dritan/mcp@latest",
      "Without the key, only system_check_prereqs and wallet tools (create_local, get_address, get_balance) will work.",
    ].join("\n"),
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

function getThsClient(): MeteoraThsClient {
  return new MeteoraThsClient({
    baseUrl: process.env.METEORA_THS_BASE_URL,
  });
}

async function searchTokens(
  client: DritanClient,
  query: string,
  options?: { limit?: number; cursor?: string; page?: number },
): Promise<unknown> {
  const sdkSearch = (client as unknown as {
    searchTokens?: (
      q: string,
      opts?: { limit?: number; cursor?: string; page?: number },
    ) => Promise<unknown>;
  }).searchTokens;
  if (typeof sdkSearch === "function") {
    return await sdkSearch(query, options);
  }

  // Backward-compatible fallback for environments where dritan-sdk hasn't been upgraded yet.
  const apiKey = process.env.DRITAN_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DRITAN_API_KEY in environment");
  }
  const baseUrl = process.env.DRITAN_BASE_URL ?? "https://us-east.dritan.dev";
  const url = new URL("/token/search", baseUrl);
  url.searchParams.set("query", query);
  if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options?.cursor) {
    url.searchParams.set("cursor", options.cursor);
  } else if (options?.page !== undefined) {
    url.searchParams.set("page", String(options.page));
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token search failed (${response.status}): ${text}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: true, raw: text };
  }
}

async function checkDritanHealth(): Promise<{
  ok: boolean;
  status: number;
  url: string;
  body: string | null;
}> {
  const baseUrl = process.env.DRITAN_BASE_URL ?? "https://us-east.dritan.dev";
  const url = new URL("/health", baseUrl).toString();
  const apiKey = process.env.DRITAN_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  const body = await response.text().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    url,
    body,
  };
}

function toEpochMs(ts: number): number {
  return ts > 1_000_000_000_000 ? ts : ts * 1000;
}

function formatChartLabel(ts: number): string {
  const date = new Date(toEpochMs(ts));
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function buildOhlcvChartUrl(
  mint: string,
  timeframe: string,
  bars: TokenOhlcvResponse["closed"],
  width: number,
  height: number,
): string {
  const labels = bars.map((bar) => formatChartLabel(bar.time));
  const closeSeries = bars.map((bar) => Number(bar.close.toFixed(12)));
  const volumeSeries = bars.map((bar) => Number(bar.volume.toFixed(12)));

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "line",
          label: "Close",
          data: closeSeries,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.2)",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
          yAxisID: "price",
        },
        {
          type: "bar",
          label: "Volume",
          data: volumeSeries,
          backgroundColor: "rgba(16,185,129,0.25)",
          borderWidth: 0,
          yAxisID: "volume",
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true },
        title: {
          display: true,
          text: `${mint} ${timeframe.toUpperCase()} OHLCV`,
        },
      },
      scales: {
        price: { type: "linear", position: "left" },
        volume: { type: "linear", position: "right", grid: { drawOnChartArea: false } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=${width}&h=${height}&f=png&c=${encoded}`;
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

const tokenMintSchema = z.object({
  mint: z.string().min(1),
});

const tokenSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
});

const marketStreamSampleSchema = z.object({
  dex: z.enum(STREAM_DEXES),
  durationMs: z.number().int().min(500).max(60_000).default(10_000),
  maxEvents: z.number().int().min(1).max(250).default(20),
});

const tokenOhlcvSchema = z.object({
  mint: z.string().min(1),
  timeframe: z.string().min(1),
  timeTo: z.number().int().positive().optional(),
});

const tokenOhlcvChartSchema = tokenOhlcvSchema.extend({
  includeActive: z.boolean().default(true),
  maxPoints: z.number().int().min(10).max(500).default(120),
  width: z.number().int().min(300).max(2000).default(1200),
  height: z.number().int().min(200).max(1200).default(600),
});

const walletAddressSchema = z.object({
  wallet: z.string().min(1),
});

const walletPerformanceSchema = walletAddressSchema.extend({
  showHistoricPnL: z.boolean().optional(),
  holdingCheck: z.boolean().optional(),
  hideDetails: z.boolean().optional(),
});

const walletTokenPerformanceSchema = walletAddressSchema.extend({
  tokenMint: z.string().min(1),
});

const walletPortfolioChartSchema = walletAddressSchema.extend({
  days: z.number().int().min(1).max(3650).optional(),
});

const walletTradeHistorySchema = walletAddressSchema.extend({
  cursor: z.string().min(1).optional(),
});

const walletHoldingsPageSchema = walletAddressSchema.extend({
  page: z.number().int().min(1),
});

const walletStreamSampleSchema = z.object({
  wallets: z.array(z.string().min(1)).min(1).max(100),
  durationMs: z.number().int().min(500).max(60_000).default(10_000),
  maxEvents: z.number().int().min(1).max(250).default(20),
});

const thsScoreSchema = z.object({
  wallet: z.string().min(1),
  debug: z.boolean().optional(),
  breakdown: z.boolean().optional(),
});

const thsScoreTokensSchema = thsScoreSchema.extend({
  tokenMints: z.array(z.string().min(1)).min(1).max(200),
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
    name: "dritan_health",
    description: "Check data plane health endpoint via Dritan SDK.",
    inputSchema: {
      type: "object",
      properties: {},
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
    name: "token_search",
    description:
      "Search tokens by ticker/name and resolve mint addresses (first step for ticker-based chart requests).",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Ticker or token name, e.g. WIF or $WIF" },
        limit: { type: "number", description: "Optional result limit (1-50)" },
        cursor: { type: "string", description: "Optional cursor for pagination" },
        page: { type: "number", description: "Optional page (used when cursor is absent)" },
      },
    },
  },
  {
    name: "token_get_price",
    description: "Fetch token price via Dritan (same as market_get_snapshot mode=price).",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_metadata",
    description: "Fetch token metadata via Dritan.",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_risk",
    description: "Fetch token risk via Dritan (same as market_get_snapshot mode=risk).",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_first_buyers",
    description: "Fetch first buyers via Dritan.",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_aggregated",
    description: "Fetch aggregated token data via Dritan (same as market_get_snapshot mode=aggregated).",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_deployer_stats",
    description: "Fetch token deployer stats via Dritan.",
    inputSchema: {
      type: "object",
      required: ["mint"],
      properties: {
        mint: { type: "string" },
      },
    },
  },
  {
    name: "token_get_ohlcv",
    description: "Fetch OHLCV candles for a token and timeframe.",
    inputSchema: {
      type: "object",
      required: ["mint", "timeframe"],
      properties: {
        mint: { type: "string" },
        timeframe: { type: "string", description: "e.g. 1m, 5m, 1h, 1d" },
        timeTo: { type: "number" },
      },
    },
  },
  {
    name: "token_get_ohlcv_chart",
    description:
      "Build a shareable chart URL from token OHLCV candles so agents can send an actual chart in chat (resolve ticker with token_search first).",
    inputSchema: {
      type: "object",
      required: ["mint", "timeframe"],
      properties: {
        mint: { type: "string" },
        timeframe: { type: "string", description: "e.g. 1m, 5m, 1h, 1d" },
        timeTo: { type: "number" },
        includeActive: { type: "boolean" },
        maxPoints: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  },
  {
    name: "wallet_get_performance",
    description: "Fetch wallet performance via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        showHistoricPnL: { type: "boolean" },
        holdingCheck: { type: "boolean" },
        hideDetails: { type: "boolean" },
      },
    },
  },
  {
    name: "wallet_get_token_performance",
    description: "Fetch wallet performance for a specific token mint via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet", "tokenMint"],
      properties: {
        wallet: { type: "string" },
        tokenMint: { type: "string" },
      },
    },
  },
  {
    name: "wallet_get_portfolio_chart",
    description: "Fetch wallet portfolio chart series via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        days: { type: "number" },
      },
    },
  },
  {
    name: "wallet_get_summary",
    description: "Fetch basic wallet summary via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
      },
    },
  },
  {
    name: "wallet_get_trade_history",
    description: "Fetch wallet trade history via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "wallet_get_holdings",
    description: "Fetch wallet holdings via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
      },
    },
  },
  {
    name: "wallet_get_holdings_page",
    description: "Fetch paginated wallet holdings via Dritan.",
    inputSchema: {
      type: "object",
      required: ["wallet", "page"],
      properties: {
        wallet: { type: "string" },
        page: { type: "number" },
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
          enum: STREAM_DEXES as unknown as string[],
        },
        durationMs: { type: "number" },
        maxEvents: { type: "number" },
      },
    },
  },
  {
    name: "wallet_stream_sample",
    description: "Open the wallet websocket stream and collect events for selected wallets.",
    inputSchema: {
      type: "object",
      required: ["wallets"],
      properties: {
        wallets: { type: "array", items: { type: "string" } },
        durationMs: { type: "number" },
        maxEvents: { type: "number" },
      },
    },
  },
  {
    name: "ths_health",
    description: "Check Meteora THS service health.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ths_get_score",
    description: "Fetch THS score for a wallet.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        debug: { type: "boolean" },
        breakdown: { type: "boolean" },
      },
    },
  },
  {
    name: "ths_get_score_tokens_get",
    description: "Fetch THS score for selected token mints using GET.",
    inputSchema: {
      type: "object",
      required: ["wallet", "tokenMints"],
      properties: {
        wallet: { type: "string" },
        tokenMints: { type: "array", items: { type: "string" } },
        debug: { type: "boolean" },
        breakdown: { type: "boolean" },
      },
    },
  },
  {
    name: "ths_get_score_tokens_post",
    description: "Fetch THS score for selected token mints using POST.",
    inputSchema: {
      type: "object",
      required: ["wallet", "tokenMints"],
      properties: {
        wallet: { type: "string" },
        tokenMints: { type: "array", items: { type: "string" } },
        debug: { type: "boolean" },
        breakdown: { type: "boolean" },
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
        const apiKeySet = !!process.env.DRITAN_API_KEY;
        return ok({
          ready: solanaCli.ok && apiKeySet,
          checks: [
            solanaCli,
            {
              ok: apiKeySet,
              name: "DRITAN_API_KEY",
              hint: apiKeySet
                ? "API key is configured."
                : "Missing DRITAN_API_KEY. Get your key at https://dritan.dev and set it as an environment variable.",
            },
          ],
          nextAction: !apiKeySet
            ? "Set DRITAN_API_KEY environment variable. Get your key at https://dritan.dev"
            : !solanaCli.ok
              ? "Install Solana CLI using installHint, then retry wallet_create_local."
              : "Environment ready.",
        });
      }

      case "dritan_health": {
        return ok(await checkDritanHealth());
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

      case "token_get_price": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getTokenPrice(input.mint));
      }

      case "token_search": {
        const input = tokenSearchSchema.parse(args);
        const client = getDritanClient();
        return ok(
          await searchTokens(client, input.query, {
            limit: input.limit,
            cursor: input.cursor,
            page: input.page,
          }),
        );
      }

      case "token_get_metadata": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getTokenMetadata(input.mint));
      }

      case "token_get_risk": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getTokenRisk(input.mint));
      }

      case "token_get_first_buyers": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getFirstBuyers(input.mint));
      }

      case "token_get_aggregated": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getTokenAggregated(input.mint));
      }

      case "token_get_deployer_stats": {
        const input = tokenMintSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getDeployerStats(input.mint));
      }

      case "token_get_ohlcv": {
        const input = tokenOhlcvSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getTokenOhlcv(input.mint, input.timeframe, { timeTo: input.timeTo }));
      }

      case "token_get_ohlcv_chart": {
        const input = tokenOhlcvChartSchema.parse(args);
        const client = getDritanClient();
        const ohlcv = await client.getTokenOhlcv(input.mint, input.timeframe, { timeTo: input.timeTo });
        const bars = [...(ohlcv.closed ?? [])];
        if (input.includeActive && ohlcv.active) {
          bars.push(ohlcv.active);
        }
        const trimmedBars = bars.slice(-input.maxPoints);
        if (trimmedBars.length === 0) {
          throw new Error(`No OHLCV data available for ${input.mint} (${input.timeframe})`);
        }

        const chartUrl = buildOhlcvChartUrl(
          input.mint,
          input.timeframe,
          trimmedBars,
          input.width,
          input.height,
        );

        return ok({
          mint: input.mint,
          timeframe: input.timeframe,
          points: trimmedBars.length,
          chartUrl,
          markdown: `![${input.mint} ${input.timeframe} chart](${chartUrl})`,
          lastBar: trimmedBars[trimmedBars.length - 1],
        });
      }

      case "wallet_get_performance": {
        const input = walletPerformanceSchema.parse(args);
        const client = getDritanClient();
        return ok(
          await client.getWalletPerformance(input.wallet, {
            showHistoricPnL: input.showHistoricPnL,
            holdingCheck: input.holdingCheck,
            hideDetails: input.hideDetails,
          }),
        );
      }

      case "wallet_get_token_performance": {
        const input = walletTokenPerformanceSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getWalletTokenPerformance(input.wallet, input.tokenMint));
      }

      case "wallet_get_portfolio_chart": {
        const input = walletPortfolioChartSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getWalletPortfolioChart(input.wallet, { days: input.days }));
      }

      case "wallet_get_summary": {
        const input = walletAddressSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getBasicWalletInformation(input.wallet));
      }

      case "wallet_get_trade_history": {
        const input = walletTradeHistorySchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getWalletTradeHistory(input.wallet, { cursor: input.cursor }));
      }

      case "wallet_get_holdings": {
        const input = walletAddressSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getWalletHoldings(input.wallet));
      }

      case "wallet_get_holdings_page": {
        const input = walletHoldingsPageSchema.parse(args);
        const client = getDritanClient();
        return ok(await client.getWalletHoldingsPage(input.wallet, input.page));
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

      case "wallet_stream_sample": {
        const input = walletStreamSampleSchema.parse(args);
        const client = getDritanClient();
        const events: unknown[] = [];
        let opened = false;
        let closed = false;

        const done = new Promise<void>((resolvePromise) => {
          const handle = client.streamDex("wallet-stream", {
            onOpen: () => {
              opened = true;
              try {
                (handle.socket as any).send(
                  JSON.stringify({
                    method: "subscribeWallets",
                    wallets: input.wallets,
                  }),
                );
              } catch {
                // no-op
              }
            },
            onClose: () => {
              closed = true;
              resolvePromise();
            },
            onMessage: (event: unknown) => {
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
        return ok({
          wallets: input.wallets,
          opened,
          closed,
          eventsCaptured: events.length,
          sample: events,
        });
      }

      case "ths_health": {
        const ths = getThsClient();
        return ok({ ok: await ths.health() });
      }

      case "ths_get_score": {
        const input = thsScoreSchema.parse(args);
        const ths = getThsClient();
        return ok(
          await ths.getThsScore(input.wallet, {
            debug: input.debug,
            breakdown: input.breakdown,
          }),
        );
      }

      case "ths_get_score_tokens_get": {
        const input = thsScoreTokensSchema.parse(args);
        const ths = getThsClient();
        return ok(
          await ths.getThsScoreForTokens(input.wallet, input.tokenMints, {
            debug: input.debug,
            breakdown: input.breakdown,
          }),
        );
      }

      case "ths_get_score_tokens_post": {
        const input = thsScoreTokensSchema.parse(args);
        const ths = getThsClient();
        return ok(
          await ths.postThsScoreForTokens(input.wallet, input.tokenMints, {
            debug: input.debug,
            breakdown: input.breakdown,
          }),
        );
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
