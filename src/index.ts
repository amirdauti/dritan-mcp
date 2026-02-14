#!/usr/bin/env node
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
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
  type WalletHoldingsResponse,
  type WalletPnlResponse,
} from "dritan-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import { z } from "zod";

const DEFAULT_WALLET_DIR = process.cwd();
const DEFAULT_API_KEY_STORE_PATH = resolve(process.cwd(), ".dritan-mcp", "auth.json");
const LAMPORTS_PER_SOL = 1_000_000_000;
type ApiKeySource = "none" | "env" | "runtime" | "x402" | "persisted";
type PersistedApiKeyRecord = {
  apiKey: string;
  source: Exclude<ApiKeySource, "none">;
  updatedAt: string;
};
function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function apiKeyPreview(apiKey: string | null): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}...`;
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}
function getApiKeyStorePath(): string {
  const configured = process.env.DRITAN_MCP_AUTH_FILE?.trim();
  return configured ? resolve(configured) : DEFAULT_API_KEY_STORE_PATH;
}
const API_KEY_STORE_PATH = getApiKeyStorePath();

function loadPersistedApiKey(): string | null {
  if (!existsSync(API_KEY_STORE_PATH)) return null;
  try {
    const raw = readFileSync(API_KEY_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedApiKeyRecord>;
    return normalizeApiKey(parsed.apiKey);
  } catch (error) {
    console.warn(
      `[dritan-mcp] Failed to read persisted API key from ${API_KEY_STORE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function persistApiKey(apiKey: string, source: Exclude<ApiKeySource, "none">): void {
  const payload: PersistedApiKeyRecord = {
    apiKey,
    source,
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(API_KEY_STORE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(API_KEY_STORE_PATH, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn(
      `[dritan-mcp] Failed to persist API key to ${API_KEY_STORE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function clearPersistedApiKey(): boolean {
  if (!existsSync(API_KEY_STORE_PATH)) return false;
  try {
    rmSync(API_KEY_STORE_PATH, { force: true });
    return true;
  } catch (error) {
    console.warn(
      `[dritan-mcp] Failed to remove persisted API key file ${API_KEY_STORE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

const persistedStartupKey = loadPersistedApiKey();
const envStartupKey = normalizeApiKey(process.env.DRITAN_API_KEY);
let runtimeApiKey: string | null = persistedStartupKey ?? envStartupKey;
let runtimeApiKeySource: ApiKeySource = persistedStartupKey ? "persisted" : envStartupKey ? "env" : "none";
if (runtimeApiKey) {
  process.env.DRITAN_API_KEY = runtimeApiKey;
}

function setRuntimeApiKey(apiKey: string, source: Exclude<ApiKeySource, "none" | "env"> | "env"): string {
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) {
    throw new Error("apiKey is required");
  }
  runtimeApiKey = normalized;
  runtimeApiKeySource = source;
  persistApiKey(normalized, source);
  process.env.DRITAN_API_KEY = normalized;
  return normalized;
}

function getActiveApiKey(): string | null {
  if (runtimeApiKey) return runtimeApiKey;
  const fromPersisted = loadPersistedApiKey();
  if (fromPersisted) {
    runtimeApiKey = fromPersisted;
    runtimeApiKeySource = "persisted";
    process.env.DRITAN_API_KEY = fromPersisted;
    return fromPersisted;
  }
  const fromEnv = normalizeApiKey(process.env.DRITAN_API_KEY);
  if (fromEnv) {
    runtimeApiKey = fromEnv;
    runtimeApiKeySource = "env";
    return fromEnv;
  }
  runtimeApiKeySource = "none";
  return null;
}

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
      "API-key onboarding policy when DRITAN_API_KEY is missing:",
      "Default path is x402-first. Do not ask user for an API key first.",
      "1) x402 pay-per-use key flow (default):",
      "   a) Create a local agent wallet with wallet_create_local (saved in current working directory by default).",
      "   b) Ask user how much SOL they want to allocate and provide both wallet address and backup file path.",
      "   c) If no active key exists, create quote -> pay from agent wallet -> claim key.",
      "2) Fallback only: if user explicitly declines funding or x402 cannot proceed, then offer free key flow at https://dritan.dev.",
      `After key is obtained, set it with auth_set_api_key (no restart needed); MCP persists it at ${API_KEY_STORE_PATH} for restart recovery.`,
      "Suggested setup command:",
      "  claude mcp add dritan-mcp -e DRITAN_API_KEY=<your-key> -- npx @dritan/mcp@latest",
    ].join("\n"),
  },
);

function getControlBaseUrl(): string {
  return process.env.DRITAN_CONTROL_BASE_URL ?? "https://api.dritan.dev";
}

function missingApiKeyError(): Error {
  return new Error(
    [
      "Missing DRITAN_API_KEY in environment.",
      `No active key found in persisted auth store (${API_KEY_STORE_PATH}).`,
      "Onboarding is x402-first by default: use wallet and x402 tools before asking user for an API key.",
      "Paid flow order: create wallet in current directory -> tell user funding amount + backup file path -> if no key exists then create/claim x402 key.",
      "Fallback only if user declines funding or x402 is not possible: user can create a free key at https://dritan.dev and set DRITAN_API_KEY.",
      "You can activate a key immediately with auth_set_api_key without restarting MCP; key is persisted locally for restart recovery.",
    ].join(" "),
  );
}

const postAuthCapabilities = [
  "Token intelligence: token search, price, metadata, risk, first buyers, deployer stats.",
  "Charts: OHLCV data and shareable line-volume/candlestick chart URLs.",
  "Wallet analytics: summary, holdings, trade history, performance, plus shareable holdings/portfolio/PnL chart URLs.",
  "Trader discovery: Meteora THS wallet score lookups plus top-wallet leaderboard.",
  "Execution: build/sign/broadcast swaps and monitor wallet/DEX streams.",
];

function buildPostAuthGuidance() {
  return {
    capabilities: postAuthCapabilities,
    suggestedNextPrompt:
      "Tell me your goal and I can proceed: token research, smart-wallet discovery, chart generation, or swap execution.",
  };
}

function getDritanClient(): DritanClient {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    throw missingApiKeyError();
  }

  return new DritanClient({
    apiKey,
    baseUrl: process.env.DRITAN_BASE_URL,
    controlBaseUrl: getControlBaseUrl(),
    wsBaseUrl: process.env.DRITAN_WS_BASE_URL,
  });
}

function getX402Client(): DritanClient {
  return new DritanClient({
    // x402 endpoints are public; SDK constructor still needs a string.
    apiKey: getActiveApiKey() ?? "x402_public_endpoints",
    baseUrl: process.env.DRITAN_BASE_URL,
    controlBaseUrl: getControlBaseUrl(),
    wsBaseUrl: process.env.DRITAN_WS_BASE_URL,
  });
}

function getThsClient(): MeteoraThsClient {
  return new MeteoraThsClient({
    baseUrl: process.env.METEORA_THS_BASE_URL,
  });
}

async function getThsTopWallets(
  ths: MeteoraThsClient,
  options: { page?: number; limit?: number } = {},
): Promise<unknown> {
  const sdkMethod = (ths as unknown as {
    getTopWalletsByScore?: (opts?: { page?: number; limit?: number }) => Promise<unknown>;
  }).getTopWalletsByScore;
  if (typeof sdkMethod === "function") {
    return await sdkMethod.call(ths, options);
  }

  const baseUrl = (ths as unknown as { baseUrl?: string }).baseUrl ?? "https://ths.dritan.dev";
  const url = new URL("/ths/top-wallets", baseUrl);
  if (options.page !== undefined) url.searchParams.set("page", String(options.page));
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Meteora THS request failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as unknown;
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
    return await sdkSearch.call(client, query, options);
  }

  // Backward-compatible fallback for environments where dritan-sdk hasn't been upgraded yet.
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    throw missingApiKeyError();
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

type X402QuoteInput = {
  durationMinutes: number;
  name?: string;
  scopes?: string[];
  payerWallet?: string;
};

type X402CreateKeyInput = {
  quoteId: string;
  paymentTxSignature: string;
  payerWallet?: string;
  name?: string;
  scopes?: string[];
};

async function x402GetPricing(client: DritanClient): Promise<unknown> {
  const sdkMethod = (client as unknown as { getX402Pricing?: () => Promise<unknown> }).getX402Pricing;
  if (typeof sdkMethod === "function") {
    return await sdkMethod.call(client);
  }

  const url = new URL("/v1/x402/pricing", getControlBaseUrl());
  const response = await fetch(url.toString(), { method: "GET" });
  const text = await response.text();
  if (!response.ok) throw new Error(`x402 pricing failed (${response.status}): ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

async function x402CreateQuote(client: DritanClient, input: X402QuoteInput): Promise<unknown> {
  const sdkMethod = (client as unknown as {
    createX402ApiKeyQuote?: (payload: X402QuoteInput) => Promise<unknown>;
  }).createX402ApiKeyQuote;
  if (typeof sdkMethod === "function") {
    return await sdkMethod.call(client, input);
  }

  const url = new URL("/v1/x402/api-keys/quote", getControlBaseUrl());
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`x402 quote failed (${response.status}): ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

async function x402CreateApiKey(client: DritanClient, input: X402CreateKeyInput): Promise<unknown> {
  const sdkMethod = (client as unknown as {
    createX402ApiKey?: (payload: X402CreateKeyInput) => Promise<unknown>;
  }).createX402ApiKey;
  if (typeof sdkMethod === "function") {
    return await sdkMethod.call(client, input);
  }

  const url = new URL("/v1/x402/api-keys", getControlBaseUrl());
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`x402 create key failed (${response.status}): ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
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

type OhlcvChartType = "line-volume" | "candlestick";

function buildLineVolumeOhlcvChartConfig(
  mint: string,
  timeframe: string,
  bars: TokenOhlcvResponse["closed"],
): Record<string, unknown> {
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

  return config;
}

function buildCandlestickOhlcvChartConfig(
  mint: string,
  timeframe: string,
  bars: TokenOhlcvResponse["closed"],
): Record<string, unknown> {
  const labels = bars.map((bar) => formatChartLabel(bar.time));
  const candles = bars.map((bar, index) => ({
    x: labels[index],
    o: Number(bar.open.toFixed(12)),
    h: Number(bar.high.toFixed(12)),
    l: Number(bar.low.toFixed(12)),
    c: Number(bar.close.toFixed(12)),
  }));
  const volumeSeries = bars.map((bar) => Number(bar.volume.toFixed(12)));
  const volumeColors = bars.map((bar) =>
    bar.close >= bar.open ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)",
  );

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Volume",
          data: volumeSeries,
          backgroundColor: volumeColors,
          borderWidth: 0,
          yAxisID: "volume",
          barPercentage: 0.9,
          categoryPercentage: 1,
          maxBarThickness: 14,
          order: 1,
        },
        {
          type: "candlestick",
          label: "OHLC",
          data: candles,
          yAxisID: "price",
          parsing: false,
          order: 2,
          color: {
            up: "#10b981",
            down: "#ef4444",
            unchanged: "#94a3b8",
          },
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true },
        title: {
          display: true,
          text: `${mint} ${timeframe.toUpperCase()} Candlestick`,
        },
      },
      scales: {
        x: { type: "category" },
        price: { type: "linear", position: "left" },
        volume: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  return config;
}

function buildQuickChartDirectUrl(config: Record<string, unknown>, width: number, height: number): string {
  const encoded = encodeURIComponent(JSON.stringify(config));
  // QuickChart defaults to Chart.js v2. Our config uses v3+/v4 scale syntax (`options.scales.{id}`),
  // so pinning `v=4` prevents runtime render errors like "Cannot read properties of undefined (reading 'options')".
  return `https://quickchart.io/chart?w=${width}&h=${height}&f=png&v=4&c=${encoded}`;
}

async function buildQuickChartShortUrl(
  config: Record<string, unknown>,
  width: number,
  height: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chart: config,
        width,
        height,
        format: "png",
        version: "4",
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { url?: unknown };
    return typeof payload.url === "string" && payload.url.length > 0 ? payload.url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildOhlcvChartConfig(
  chartType: OhlcvChartType,
  mint: string,
  timeframe: string,
  bars: TokenOhlcvResponse["closed"],
): Record<string, unknown> {
  if (chartType === "candlestick") {
    return buildCandlestickOhlcvChartConfig(mint, timeframe, bars);
  }
  return buildLineVolumeOhlcvChartConfig(mint, timeframe, bars);
}

type ChartUrlInfo = {
  chartUrl: string;
  chartUrlType: "short" | "direct";
};

async function resolveChartUrl(
  config: Record<string, unknown>,
  width: number,
  height: number,
): Promise<ChartUrlInfo> {
  const shortChartUrl = await buildQuickChartShortUrl(config, width, height);
  return {
    chartUrl: shortChartUrl ?? buildQuickChartDirectUrl(config, width, height),
    chartUrlType: shortChartUrl ? "short" : "direct",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function colorAt(index: number): string {
  const palette = [
    "#2563eb",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#06b6d4",
    "#84cc16",
    "#f97316",
    "#14b8a6",
    "#e11d48",
    "#6366f1",
    "#22c55e",
  ];
  return palette[index % palette.length];
}

type WalletHoldingsSlice = {
  label: string;
  mint: string;
  value: number;
};

function buildWalletHoldingsSlices(holdings: WalletHoldingsResponse, top: number): WalletHoldingsSlice[] {
  const slices = (holdings.tokens ?? [])
    .map((position) => {
      const value = toFiniteNumber(position.value);
      if (value == null || value <= 0) return null;
      const token = asRecord(position.token) ?? {};
      const symbol = typeof token.symbol === "string" ? token.symbol.trim() : "";
      const mint =
        typeof token.mint === "string" && token.mint.trim()
          ? token.mint
          : typeof (token as { address?: unknown }).address === "string"
            ? ((token as { address: string }).address ?? "")
            : "";
      const fallbackLabel = mint ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : "Unknown";
      return {
        label: symbol || fallbackLabel,
        mint,
        value,
      };
    })
    .filter((slice): slice is WalletHoldingsSlice => slice !== null)
    .sort((a, b) => b.value - a.value);

  const topSlices = slices.slice(0, top);
  const othersValue = slices.slice(top).reduce((sum, item) => sum + item.value, 0);
  if (othersValue > 0) {
    topSlices.push({ label: "Others", mint: "", value: othersValue });
  }
  return topSlices;
}

function buildWalletHoldingsChartConfig(wallet: string, slices: WalletHoldingsSlice[]): Record<string, unknown> {
  return {
    type: "doughnut",
    data: {
      labels: slices.map((slice) => slice.label),
      datasets: [
        {
          label: "Value",
          data: slices.map((slice) => Number(slice.value.toFixed(6))),
          backgroundColor: slices.map((_, index) => colorAt(index)),
          borderColor: "#0f172a",
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${wallet} Holdings Allocation`,
        },
        legend: {
          position: "right",
        },
      },
    },
  };
}

type PortfolioPoint = {
  label: string;
  value: number;
  sortTs: number | null;
};

function toSortTimestamp(label: string): number | null {
  const asNumber = Number(label);
  if (Number.isFinite(asNumber) && asNumber > 0) return toEpochMs(asNumber);
  const asDate = Date.parse(label);
  return Number.isFinite(asDate) ? asDate : null;
}

function formatTimeLabel(value: string): string {
  const sortTs = toSortTimestamp(value);
  if (sortTs == null) return value;
  return new Date(sortTs).toISOString().replace("T", " ").slice(0, 16);
}

function buildPortfolioPoints(history: Record<string, number>, maxPoints: number): PortfolioPoint[] {
  const entries = Object.entries(history ?? {})
    .map(([label, raw]) => {
      const value = toFiniteNumber(raw);
      if (value == null) return null;
      return {
        label,
        value,
        sortTs: toSortTimestamp(label),
      };
    })
    .filter((entry): entry is PortfolioPoint => entry !== null);

  entries.sort((a, b) => {
    if (a.sortTs != null && b.sortTs != null) return a.sortTs - b.sortTs;
    if (a.sortTs != null) return -1;
    if (b.sortTs != null) return 1;
    return a.label.localeCompare(b.label);
  });

  return entries.slice(-maxPoints);
}

function buildWalletPortfolioVisualChartConfig(wallet: string, points: PortfolioPoint[]): Record<string, unknown> {
  return {
    type: "line",
    data: {
      labels: points.map((point) => formatTimeLabel(point.label)),
      datasets: [
        {
          label: "Portfolio Value",
          data: points.map((point) => Number(point.value.toFixed(6))),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.2)",
          fill: true,
          pointRadius: 0,
          tension: 0.2,
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${wallet} Portfolio Value`,
        },
        legend: { display: true },
      },
      scales: {
        y: {
          type: "linear",
          beginAtZero: false,
        },
      },
    },
  };
}

type PnlMetric = {
  label: string;
  value: number;
};

function lookupNumberByAliases(
  record: Record<string, unknown>,
  aliases: readonly string[],
): number | null {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    lowered.set(key.toLowerCase(), value);
  }
  for (const alias of aliases) {
    const matched = lowered.get(alias.toLowerCase());
    const num = toFiniteNumber(matched);
    if (num != null) return num;
  }
  return null;
}

function extractPnlSummaryMetrics(performance: WalletPnlResponse): PnlMetric[] {
  const root = asRecord(performance) ?? {};
  const summary = asRecord(root.summary) ?? {};
  const source = Object.keys(summary).length > 0 ? summary : root;
  const metricDefs: Array<{ label: string; aliases: string[] }> = [
    { label: "Total PnL", aliases: ["totalPnl", "total_pnl", "netPnl", "net_pnl", "pnl"] },
    { label: "Realized PnL", aliases: ["realizedPnl", "realized_pnl"] },
    { label: "Unrealized PnL", aliases: ["unrealizedPnl", "unrealized_pnl"] },
    { label: "Total Profit", aliases: ["totalProfit", "total_profit", "profit", "grossProfit"] },
    { label: "Total Loss", aliases: ["totalLoss", "total_loss", "loss", "grossLoss"] },
  ];

  return metricDefs
    .map(({ label, aliases }) => {
      const value = lookupNumberByAliases(source, aliases);
      return value == null ? null : { label, value };
    })
    .filter((metric): metric is PnlMetric => metric !== null);
}

function extractPnlTokenMetrics(performance: WalletPnlResponse, maxTokens: number): PnlMetric[] {
  const root = asRecord(performance) ?? {};
  const tokens = asRecord(root.tokens) ?? {};
  const aliases = [
    "pnl",
    "totalPnl",
    "total_pnl",
    "realizedPnl",
    "realized_pnl",
    "profit",
    "profitUsd",
    "profit_usd",
  ];

  return Object.entries(tokens)
    .map(([tokenKey, payload]) => {
      const stats = asRecord(payload) ?? {};
      const labelFromPayload =
        typeof stats.symbol === "string" && stats.symbol.trim()
          ? stats.symbol
          : typeof stats.name === "string" && stats.name.trim()
            ? stats.name
            : tokenKey;
      const value = lookupNumberByAliases(stats, aliases);
      return value == null ? null : { label: labelFromPayload, value };
    })
    .filter((metric): metric is PnlMetric => metric !== null)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, maxTokens);
}

type HistoryPoint = {
  label: string;
  value: number;
  sortTs: number | null;
};

function extractHistoryPoints(value: unknown, maxPoints: number): HistoryPoint[] | null {
  const arrayValue = Array.isArray(value) ? value : null;
  if (arrayValue) {
    const points = arrayValue
      .map((item, index) => {
        const asNum = toFiniteNumber(item);
        if (asNum != null) {
          return { label: String(index + 1), value: asNum, sortTs: index };
        }

        const row = asRecord(item);
        if (!row) return null;
        const pointValue = toFiniteNumber(row.value) ?? toFiniteNumber(row.pnl) ?? toFiniteNumber(row.total);
        if (pointValue == null) return null;
        const rawLabel =
          (typeof row.time === "string" && row.time) ||
          (typeof row.date === "string" && row.date) ||
          (typeof row.ts === "string" && row.ts) ||
          (typeof row.time === "number" && String(row.time)) ||
          String(index + 1);
        return {
          label: rawLabel,
          value: pointValue,
          sortTs: toSortTimestamp(rawLabel),
        };
      })
      .filter((point): point is HistoryPoint => point !== null);

    if (points.length >= 2) {
      points.sort((a, b) => {
        if (a.sortTs != null && b.sortTs != null) return a.sortTs - b.sortTs;
        return a.label.localeCompare(b.label);
      });
      return points.slice(-maxPoints);
    }
  }

  const record = asRecord(value);
  if (!record) return null;

  const points = Object.entries(record)
    .map(([label, rawValue]) => {
      const asNum = toFiniteNumber(rawValue);
      if (asNum == null) return null;
      return {
        label,
        value: asNum,
        sortTs: toSortTimestamp(label),
      };
    })
    .filter((point): point is HistoryPoint => point !== null);

  if (points.length < 2) return null;
  points.sort((a, b) => {
    if (a.sortTs != null && b.sortTs != null) return a.sortTs - b.sortTs;
    if (a.sortTs != null) return -1;
    if (b.sortTs != null) return 1;
    return a.label.localeCompare(b.label);
  });
  return points.slice(-maxPoints);
}

function extractPnlHistory(performance: WalletPnlResponse, maxPoints: number): HistoryPoint[] | null {
  const root = asRecord(performance) ?? {};
  const summary = asRecord(root.summary) ?? {};
  const candidates = ["historicPnl", "historic_pnl", "historicalPnl", "historical_pnl", "pnlHistory", "history"];

  for (const scope of [root, summary]) {
    for (const key of candidates) {
      const history = extractHistoryPoints(scope[key], maxPoints);
      if (history && history.length >= 2) return history;
    }
  }
  return null;
}

function buildWalletPnlHistoryChartConfig(wallet: string, points: HistoryPoint[]): Record<string, unknown> {
  return {
    type: "line",
    data: {
      labels: points.map((point) => formatTimeLabel(point.label)),
      datasets: [
        {
          label: "PnL",
          data: points.map((point) => Number(point.value.toFixed(6))),
          borderColor: "#16a34a",
          backgroundColor: "rgba(22,163,74,0.2)",
          fill: true,
          pointRadius: 0,
          tension: 0.2,
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: `${wallet} PnL History` },
      },
      scales: {
        y: { type: "linear", beginAtZero: false },
      },
    },
  };
}

function buildWalletPnlMetricChartConfig(
  wallet: string,
  metrics: PnlMetric[],
  title: string,
): Record<string, unknown> {
  return {
    type: "bar",
    data: {
      labels: metrics.map((metric) => metric.label),
      datasets: [
        {
          label: "Value",
          data: metrics.map((metric) => Number(metric.value.toFixed(6))),
          backgroundColor: metrics.map((metric, index) =>
            metric.value >= 0 ? `rgba(16,185,129,${0.25 + (index % 3) * 0.1})` : "rgba(239,68,68,0.35)",
          ),
          borderColor: metrics.map((metric) => (metric.value >= 0 ? "#059669" : "#dc2626")),
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: metrics.length > 8 ? "y" : "x",
      plugins: {
        title: { display: true, text: `${wallet} ${title}` },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: false },
      },
    },
  };
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

function createLocalWalletFile(walletPath: string): {
  walletPath: string;
  backupFilePath: string;
  address: string;
  walletDir: string;
} {
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
  return {
    walletPath,
    backupFilePath: walletPath,
    walletDir: dir,
    address: keypair.publicKey.toBase58(),
  };
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

const authSetApiKeySchema = z.object({
  apiKey: z.string().min(8),
});

const authClearApiKeySchema = z.object({
  clearEnv: z.boolean().optional(),
});

const walletPathSchema = z.object({
  walletPath: z.string().min(1),
});

const walletBalanceSchema = walletPathSchema.extend({
  rpcUrl: z.string().url().optional(),
});

const walletTransferSchema = z
  .object({
    walletPath: z.string().min(1),
    toAddress: z.string().min(32),
    lamports: z.number().int().positive().optional(),
    sol: z.number().positive().optional(),
    rpcUrl: z.string().url().optional(),
  })
  .refine((v) => v.lamports != null || v.sol != null, {
    message: "Either lamports or sol is required",
    path: ["lamports"],
  });

const x402QuoteSchema = z.object({
  durationMinutes: z.number().int().min(1).max(60 * 24 * 30),
  name: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string().min(1).max(120)).max(64).optional(),
  payerWallet: z.string().min(32).max(80).optional(),
});

const x402CreateApiKeySchema = z.object({
  quoteId: z.string().min(1),
  paymentTxSignature: z.string().min(40),
  payerWallet: z.string().min(32).max(80).optional(),
  name: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string().min(1).max(120)).max(64).optional(),
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
  chartType: z.enum(["line-volume", "candlestick"]).default("candlestick"),
  includeActive: z.boolean().default(true),
  maxPoints: z.number().int().min(10).max(500).default(30),
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

const walletPortfolioVisualSchema = walletPortfolioChartSchema.extend({
  maxPoints: z.number().int().min(10).max(500).default(90),
  width: z.number().int().min(300).max(2000).default(1200),
  height: z.number().int().min(200).max(1200).default(600),
});

const walletTradeHistorySchema = walletAddressSchema.extend({
  cursor: z.string().min(1).optional(),
});

const walletHoldingsPageSchema = walletAddressSchema.extend({
  page: z.number().int().min(1),
});

const walletHoldingsChartSchema = walletAddressSchema.extend({
  top: z.number().int().min(3).max(20).default(10),
  width: z.number().int().min(300).max(2000).default(900),
  height: z.number().int().min(200).max(1200).default(600),
});

const walletPerformanceChartSchema = walletAddressSchema.extend({
  showHistoricPnL: z.boolean().default(true),
  holdingCheck: z.boolean().optional(),
  hideDetails: z.boolean().optional(),
  maxPoints: z.number().int().min(10).max(500).default(90),
  maxTokens: z.number().int().min(3).max(25).default(12),
  width: z.number().int().min(300).max(2000).default(1200),
  height: z.number().int().min(200).max(1200).default(600),
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

const thsTopWalletsSchema = z.object({
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
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
    name: "auth_status",
    description:
      "Show current API key status for this MCP session (active source, preview, and onboarding options).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "auth_set_api_key",
    description:
      "Set the active Dritan API key for this running MCP process and persist it locally for restart recovery.",
    inputSchema: {
      type: "object",
      required: ["apiKey"],
      properties: {
        apiKey: { type: "string" },
      },
    },
  },
  {
    name: "auth_clear_api_key",
    description:
      "Clear the active in-memory API key and delete the persisted auth file. Optionally clear DRITAN_API_KEY in this process env.",
    inputSchema: {
      type: "object",
      properties: {
        clearEnv: { type: "boolean", description: "Also remove DRITAN_API_KEY from this process environment." },
      },
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
    name: "wallet_transfer_sol",
    description: "Send SOL from a local wallet to a destination wallet (used in x402 paid key flow).",
    inputSchema: {
      type: "object",
      required: ["walletPath", "toAddress"],
      properties: {
        walletPath: { type: "string" },
        toAddress: { type: "string" },
        lamports: { type: "number", description: "Integer lamports to transfer" },
        sol: { type: "number", description: "SOL amount to transfer (used when lamports is not provided)" },
        rpcUrl: { type: "string" },
      },
    },
  },
  {
    name: "x402_get_pricing",
    description: "Get x402 pricing and receiver wallet for paid time-limited API keys.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "x402_create_api_key_quote",
    description:
      "Create an x402 payment quote for a time-limited API key (returns quoteId, receiverWallet, and exact SOL amount).",
    inputSchema: {
      type: "object",
      required: ["durationMinutes"],
      properties: {
        durationMinutes: { type: "number", description: "Minutes for key validity (1 to 43200)." },
        name: { type: "string", description: "Optional key name." },
        payerWallet: { type: "string", description: "Optional payer wallet to lock quote payer." },
        scopes: { type: "array", items: { type: "string" }, description: "Optional scopes." },
      },
    },
  },
  {
    name: "x402_create_api_key",
    description: "Claim a paid x402 API key using quoteId and payment transaction signature.",
    inputSchema: {
      type: "object",
      required: ["quoteId", "paymentTxSignature"],
      properties: {
        quoteId: { type: "string" },
        paymentTxSignature: { type: "string" },
        payerWallet: { type: "string" },
        name: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
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
      "Build a shareable chart URL from token OHLCV candles so agents can send an actual chart in chat (resolve ticker with token_search first). Supports line-volume or candlestick charts.",
    inputSchema: {
      type: "object",
      required: ["mint", "timeframe"],
      properties: {
        mint: { type: "string" },
        timeframe: { type: "string", description: "e.g. 1m, 5m, 1h, 1d" },
        timeTo: { type: "number" },
        chartType: {
          type: "string",
          enum: ["line-volume", "candlestick"],
          description: "Chart style. Default candlestick.",
        },
        includeActive: { type: "boolean" },
        maxPoints: { type: "number", description: "Number of candles to render (default 30)." },
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
    name: "wallet_get_portfolio_chart_visual",
    description:
      "Build a shareable line chart URL for wallet portfolio history so agents can send a graphical portfolio view.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        days: { type: "number", description: "Optional lookback days passed to portfolio endpoint." },
        maxPoints: { type: "number", description: "Number of points to render (default 90)." },
        width: { type: "number" },
        height: { type: "number" },
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
    name: "wallet_get_holdings_chart",
    description:
      "Build a shareable holdings allocation chart URL from wallet holdings so agents can show token balance distribution.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        top: { type: "number", description: "Top token count before grouping remainder into Others (default 10)." },
        width: { type: "number" },
        height: { type: "number" },
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
    name: "wallet_get_performance_chart",
    description:
      "Build a shareable wallet PnL chart URL (history when available, otherwise summary/token PnL bars) for graphical performance views.",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        showHistoricPnL: { type: "boolean" },
        holdingCheck: { type: "boolean" },
        hideDetails: { type: "boolean" },
        maxPoints: { type: "number", description: "Max history points when rendering PnL history (default 90)." },
        maxTokens: {
          type: "number",
          description: "Max token bars when history/summary is unavailable (default 12).",
        },
        width: { type: "number" },
        height: { type: "number" },
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
    name: "ths_get_top_wallets",
    description: "Fetch paginated top wallets ranked by THS score.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        limit: { type: "number" },
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
        const activeApiKey = getActiveApiKey();
        const apiKeySet = !!activeApiKey;
        const persistedApiKeyPresent = existsSync(API_KEY_STORE_PATH);
        return ok({
          ready: solanaCli.ok && apiKeySet,
          readyForX402Onboarding: solanaCli.ok,
          apiKeyStorePath: API_KEY_STORE_PATH,
          persistedApiKeyPresent,
          checks: [
            solanaCli,
            {
              ok: apiKeySet,
              name: "DRITAN_API_KEY",
              source: runtimeApiKeySource,
              preview: apiKeyPreview(activeApiKey),
              hint: apiKeySet
                ? "API key is configured."
                : "Missing active API key. Start x402 flow first (wallet_create_local -> fund wallet -> quote/claim). Use free key only as fallback.",
            },
          ],
          nextAction: !apiKeySet
            ? "Run x402-first onboarding now: wallet_create_local -> share wallet + backup file path -> ask funding amount -> x402_create_api_key_quote -> wallet_transfer_sol -> x402_create_api_key. Offer free key only if user declines or x402 cannot proceed."
            : !solanaCli.ok
              ? "Install Solana CLI using installHint, then retry wallet_create_local."
              : "Environment ready.",
        });
      }

      case "auth_status": {
        const activeApiKey = getActiveApiKey();
        return ok({
          apiKeyConfigured: !!activeApiKey,
          source: runtimeApiKeySource,
          preview: apiKeyPreview(activeApiKey),
          controlBaseUrl: getControlBaseUrl(),
          apiKeyStorePath: API_KEY_STORE_PATH,
          persistedApiKeyPresent: existsSync(API_KEY_STORE_PATH),
          onboardingOptions: [
            "Default (x402-first): create wallet in current directory -> share wallet + backup file path -> user funds wallet -> if no key exists, quote/transfer/claim key.",
            "Fallback only: if user declines funding or x402 cannot proceed, user can create key at https://dritan.dev and set it with auth_set_api_key.",
          ],
          ...(activeApiKey ? buildPostAuthGuidance() : {}),
        });
      }

      case "auth_set_api_key": {
        const input = authSetApiKeySchema.parse(args);
        const activated = setRuntimeApiKey(input.apiKey, "runtime");
        return ok({
          ok: true,
          message: "API key activated and persisted for this MCP session without restart.",
          source: runtimeApiKeySource,
          preview: apiKeyPreview(activated),
          apiKeyStorePath: API_KEY_STORE_PATH,
          ...buildPostAuthGuidance(),
        });
      }

      case "auth_clear_api_key": {
        const input = authClearApiKeySchema.parse(args);
        runtimeApiKey = null;
        runtimeApiKeySource = "none";
        const persistedApiKeyRemoved = clearPersistedApiKey();
        const envCleared = !!input.clearEnv;
        if (envCleared) {
          delete process.env.DRITAN_API_KEY;
        }
        return ok({
          ok: true,
          source: runtimeApiKeySource,
          persistedApiKeyRemoved,
          envCleared,
          apiKeyStorePath: API_KEY_STORE_PATH,
          message:
            "Active key cleared from memory and persisted store. If clearEnv=false and env still has DRITAN_API_KEY, restarting may load that env key.",
        });
      }

      case "dritan_health": {
        return ok(await checkDritanHealth());
      }

      case "wallet_create_local": {
        const input = walletCreateSchema.parse(args);
        const walletPath = toWalletPath(input.name, input.walletDir);
        const created = createLocalWalletFile(walletPath);
        return ok({
          ...created,
          fundingInstruction:
            "Ask the user how much SOL they want to allocate to this wallet, and tell them this backup file path.",
        });
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

      case "wallet_transfer_sol": {
        const input = walletTransferSchema.parse(args);
        const walletPath = resolve(input.walletPath);
        const keypair = loadKeypairFromPath(walletPath);
        const rpcUrl = getRpcUrl(input.rpcUrl);
        const conn = new Connection(rpcUrl, "confirmed");

        const lamportsRaw =
          input.lamports != null ? input.lamports : Math.round((input.sol ?? 0) * LAMPORTS_PER_SOL);
        if (!Number.isSafeInteger(lamportsRaw) || lamportsRaw <= 0) {
          throw new Error("Transfer amount must be a positive safe integer number of lamports.");
        }

        const toPubkey = new PublicKey(input.toAddress);
        const latest = await conn.getLatestBlockhash("confirmed");
        const tx = new Transaction({
          feePayer: keypair.publicKey,
          recentBlockhash: latest.blockhash,
        }).add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey,
            lamports: lamportsRaw,
          }),
        );
        tx.sign(keypair);

        const signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        const confirmation = await conn.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (confirmation.value.err) {
          throw new Error(`Transfer failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return ok({
          walletPath,
          fromAddress: keypair.publicKey.toBase58(),
          toAddress: toPubkey.toBase58(),
          rpcUrl,
          lamports: lamportsRaw,
          sol: lamportsRaw / LAMPORTS_PER_SOL,
          signature,
          explorerUrl: `https://solscan.io/tx/${signature}`,
        });
      }

      case "x402_get_pricing": {
        const client = getX402Client();
        const pricing = await x402GetPricing(client);
        return ok({
          ...((pricing as Record<string, unknown>) ?? {}),
          onboardingOptions: [
            "Default (x402-first): create wallet in current directory -> share wallet + backup path -> user funds wallet -> if no key exists, quote/payment/claim.",
            "Fallback only: user gets API key at https://dritan.dev and provides it as DRITAN_API_KEY if x402 cannot proceed.",
          ],
        });
      }

      case "x402_create_api_key_quote": {
        const input = x402QuoteSchema.parse(args);
        const client = getX402Client();
        const activeApiKey = getActiveApiKey();
        const quote = await x402CreateQuote(client, input);
        return ok({
          ...((quote as Record<string, unknown>) ?? {}),
          apiKeyAlreadyConfigured: !!activeApiKey,
          keyPreview: apiKeyPreview(activeApiKey),
          nextSteps: [
            "Ensure agent has a local wallet in current directory (wallet_create_local + wallet_get_address) and tell user the backup file path.",
            "Ask user how much SOL they want to allocate; user funds the agent wallet.",
            "Only proceed if no API key is active; otherwise skip paid key creation.",
            "Transfer quoted SOL amount to receiver wallet using wallet_transfer_sol.",
            "Claim key with x402_create_api_key using returned tx signature (MCP auto-activates returned apiKey).",
          ],
        });
      }

      case "x402_create_api_key": {
        const input = x402CreateApiKeySchema.parse(args);
        const client = getX402Client();
        const created = await x402CreateApiKey(client, input);
        const payload =
          typeof created === "object" && created !== null
            ? { ...(created as Record<string, unknown>) }
            : ({ value: created } as Record<string, unknown>);
        if (typeof payload.apiKey === "string") {
          const activated = setRuntimeApiKey(payload.apiKey, "x402");
          payload.mcpAuth = {
            activated: true,
            source: runtimeApiKeySource,
            preview: apiKeyPreview(activated),
            apiKeyStorePath: API_KEY_STORE_PATH,
            message:
              "x402-created API key is active for this MCP session and persisted locally for restart recovery (no restart needed).",
          };
          Object.assign(payload, buildPostAuthGuidance());
        }
        return ok(payload);
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

        const chartConfig = buildOhlcvChartConfig(
          input.chartType,
          input.mint,
          input.timeframe,
          trimmedBars,
        );
        const shortChartUrl = await buildQuickChartShortUrl(chartConfig, input.width, input.height);
        const chartUrl = shortChartUrl ?? buildQuickChartDirectUrl(chartConfig, input.width, input.height);

        return ok({
          mint: input.mint,
          timeframe: input.timeframe,
          chartType: input.chartType,
          points: trimmedBars.length,
          chartUrlType: shortChartUrl ? "short" : "direct",
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

      case "wallet_get_performance_chart": {
        const input = walletPerformanceChartSchema.parse(args);
        const client = getDritanClient();
        const performance = await client.getWalletPerformance(input.wallet, {
          showHistoricPnL: input.showHistoricPnL,
          holdingCheck: input.holdingCheck,
          hideDetails: input.hideDetails,
        });

        const history = extractPnlHistory(performance, input.maxPoints);
        if (history && history.length > 1) {
          const config = buildWalletPnlHistoryChartConfig(input.wallet, history);
          const { chartUrl, chartUrlType } = await resolveChartUrl(config, input.width, input.height);
          return ok({
            wallet: input.wallet,
            chartMode: "history",
            points: history.length,
            chartUrlType,
            chartUrl,
            markdown: `![${input.wallet} pnl history](${chartUrl})`,
            latestValue: history[history.length - 1].value,
          });
        }

        const summaryMetrics = extractPnlSummaryMetrics(performance);
        if (summaryMetrics.length >= 2) {
          const config = buildWalletPnlMetricChartConfig(input.wallet, summaryMetrics, "PnL Summary");
          const { chartUrl, chartUrlType } = await resolveChartUrl(config, input.width, input.height);
          return ok({
            wallet: input.wallet,
            chartMode: "summary",
            metrics: summaryMetrics,
            chartUrlType,
            chartUrl,
            markdown: `![${input.wallet} pnl summary](${chartUrl})`,
          });
        }

        const tokenMetrics = extractPnlTokenMetrics(performance, input.maxTokens);
        if (tokenMetrics.length >= 1) {
          const config = buildWalletPnlMetricChartConfig(input.wallet, tokenMetrics, "Token PnL");
          const { chartUrl, chartUrlType } = await resolveChartUrl(config, input.width, input.height);
          return ok({
            wallet: input.wallet,
            chartMode: "tokens",
            metrics: tokenMetrics,
            chartUrlType,
            chartUrl,
            markdown: `![${input.wallet} token pnl](${chartUrl})`,
          });
        }

        throw new Error("No chartable PnL fields found in wallet performance response.");
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

      case "wallet_get_portfolio_chart_visual": {
        const input = walletPortfolioVisualSchema.parse(args);
        const client = getDritanClient();
        const portfolio = await client.getWalletPortfolioChart(input.wallet, { days: input.days });
        const points = buildPortfolioPoints(portfolio.history ?? {}, input.maxPoints);
        if (points.length === 0) {
          throw new Error(`No portfolio history points available for ${input.wallet}.`);
        }

        const config = buildWalletPortfolioVisualChartConfig(input.wallet, points);
        const { chartUrl, chartUrlType } = await resolveChartUrl(config, input.width, input.height);
        return ok({
          wallet: input.wallet,
          days: input.days ?? null,
          points: points.length,
          chartUrlType,
          chartUrl,
          markdown: `![${input.wallet} portfolio chart](${chartUrl})`,
          latestValue: points[points.length - 1].value,
          summary: {
            total: portfolio.total,
            totalInvested: portfolio.totalInvested,
            totalWins: portfolio.totalWins,
            totalLosses: portfolio.totalLosses,
            winPercentage: portfolio.winPercentage,
          },
        });
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

      case "wallet_get_holdings_chart": {
        const input = walletHoldingsChartSchema.parse(args);
        const client = getDritanClient();
        const holdings = await client.getWalletHoldings(input.wallet);
        const slices = buildWalletHoldingsSlices(holdings, input.top);
        if (slices.length === 0) {
          throw new Error(`No chartable holdings values available for ${input.wallet}.`);
        }
        const totalValue = slices.reduce((sum, slice) => sum + slice.value, 0);
        const config = buildWalletHoldingsChartConfig(input.wallet, slices);
        const { chartUrl, chartUrlType } = await resolveChartUrl(config, input.width, input.height);
        return ok({
          wallet: input.wallet,
          top: input.top,
          chartUrlType,
          chartUrl,
          markdown: `![${input.wallet} holdings allocation](${chartUrl})`,
          totalValue,
          totalValueCompact: formatCompactNumber(totalValue),
          slices: slices.map((slice) => ({
            ...slice,
            percentage: Number(((slice.value / totalValue) * 100).toFixed(2)),
          })),
        });
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

      case "ths_get_top_wallets": {
        const input = thsTopWalletsSchema.parse(args);
        const ths = getThsClient();
        return ok(await getThsTopWallets(ths, input));
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
