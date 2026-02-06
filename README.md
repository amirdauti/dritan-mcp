# dritan-mcp

MCP server for personal agents to use `dritan-sdk` for market data and swap execution, with local Solana wallet signing.

## Requirements

- Node.js 20+
- `solana-keygen` available in `PATH`
- Dritan API key (`DRITAN_API_KEY`)

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
- `wallet_create_local`
- `wallet_get_address`
- `wallet_get_balance`
- `market_get_snapshot`
- `token_get_price`
- `token_get_risk`
- `token_get_aggregated`
- `market_stream_sample`
- `swap_build`
- `swap_sign_and_broadcast`
- `swap_build_sign_and_broadcast`

## Notes

- Wallets default to `~/.config/dritan-mcp/wallets`.
- Private keys never leave local files; only public address/signature are returned.
- `swap_sign_and_broadcast` signs locally, then broadcasts via Dritan.
- If Solana CLI is missing, run `system_check_prereqs` and follow returned install steps.
