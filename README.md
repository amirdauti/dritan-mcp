# dritan-mcp

MCP server for personal agents to use `dritan-sdk` for market data and swap execution, with local Solana wallet signing.

## Requirements

- Node.js 20+
- `solana-keygen` available in `PATH`
- Optional: Dritan API key (`DRITAN_API_KEY`) for market/swap tools.
- For paid onboarding without an existing key, use x402 tools.

## Setup

```bash
npm install
cp .env.example .env
```

## Install As MCP (npx)

```bash
npx @dritan/mcp@latest
```

Codex example:

```bash
codex mcp add dritan npx \"@dritan/mcp@latest\"
```

## Run

```bash
npm run dev
# or
npm run build && npm start
```

## Tools

- `system_check_prereqs`
- `auth_status`
- `auth_set_api_key`
- `wallet_create_local`
- `wallet_get_address`
- `wallet_get_balance`
- `wallet_transfer_sol`
- `x402_get_pricing`
- `x402_create_api_key_quote`
- `x402_create_api_key`
- `dritan_health`
- `market_get_snapshot`
- `token_search`
- `token_get_price`
- `token_get_metadata`
- `token_get_risk`
- `token_get_first_buyers`
- `token_get_aggregated`
- `token_get_deployer_stats`
- `token_get_ohlcv`
- `token_get_ohlcv_chart`
- `wallet_get_performance`
- `wallet_get_token_performance`
- `wallet_get_portfolio_chart`
- `wallet_get_summary`
- `wallet_get_trade_history`
- `wallet_get_holdings`
- `wallet_get_holdings_page`
- `market_stream_sample`
- `wallet_stream_sample`
- `ths_health`
- `ths_get_score`
- `ths_get_score_tokens_get`
- `ths_get_score_tokens_post`
- `ths_get_top_wallets`
- `swap_build`
- `swap_sign_and_broadcast`
- `swap_build_sign_and_broadcast`

## Notes

- Wallets default to the current working directory (`process.cwd()`).
- Private keys never leave local files; only public address/signature are returned.
- `swap_sign_and_broadcast` signs locally, then broadcasts via Dritan.
- `auth_set_api_key` activates a key for the running MCP process without restart.
- `auth_set_api_key` and successful `x402_create_api_key` responses include a capability summary so agents can immediately guide users to next actions.
- Agent onboarding without `DRITAN_API_KEY` should present two options:
  - Option 1: paid x402 flow (`wallet_create_local` in current directory -> share wallet + backup file path -> user chooses SOL amount and funds agent wallet -> if no key exists use `x402_create_api_key_quote` -> `wallet_transfer_sol` -> `x402_create_api_key`).
  - Option 2: user gets a free key at `https://dritan.dev`.
- `x402_create_api_key` auto-activates returned keys for the current MCP session.
- `token_get_ohlcv_chart` returns a shareable chart URL plus a ready-to-send markdown image snippet.
- `token_get_ohlcv_chart` supports `chartType: "line-volume" | "candlestick"` (default is `candlestick`).
- `ths_get_top_wallets` returns a paginated leaderboard of THS-ranked wallets (`page`, `limit`) for smart-wallet discovery workflows.
- Ticker workflow for chart requests: `token_search` -> extract mint -> `token_get_ohlcv` or `token_get_ohlcv_chart`.
- If users ask for `$WIF` style symbols, always resolve mint with `token_search` first.
- If Solana CLI is missing, run `system_check_prereqs` and follow returned install steps.
