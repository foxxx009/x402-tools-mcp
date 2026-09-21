# x402-tools-mcp

An MCP server that gives any AI agent six research and data tools, **paid per
call in USDC on Base** through [x402](https://www.x402.org).

No API keys. No subscription. No monthly minimum. You pay a cent or two when
your agent actually calls a tool.

| Tool | Price | What it does |
|---|---|---|
| `web_fetch` | $0.01 | Fetch a URL — status, final URL, title, cleaned text, top 20 links. For agents whose sandbox has no open-web access. |
| `domain_intel` | $0.02 | RDAP registrar + creation/expiry dates, DNS records (A/MX/NS/TXT), Certificate Transparency history via crt.sh. |
| `github_repo` | $0.02 | Repo facts: stars, forks, open issues, language, licence, last push, README excerpt. |
| `token_intel` | $0.02 | ERC-20 facts read from Base mainnet: name, symbol, decimals, total supply, USDC balance. |
| `repo_diligence` | $2.50 | Deep repo report — release cadence, contributor spread, issue/PR health, risk summary. |
| `web_brief` | $3.00 | Multi-URL consolidated brief with per-source attribution. |

## Why this exists

Agent sandboxes are frequently firewalled from the open web, and the usual
workaround — an API-key-gated scraping service — means a subscription, an
account, and a monthly floor you pay whether or not you use it. x402 removes
all three: the server answers `402 Payment Required`, the client signs a USDC
transfer authorisation, and the call proceeds. That is the whole handshake.

## Setup

**1. Fund a wallet.** Any Base wallet with a few dollars of USDC. It needs
**no ETH** — gas is paid by the settlement facilitator.

**2. Export the key.**

```bash
export X402_PRIVATE_KEY=0x<private key of that wallet>
```

**3. Register the server** with your MCP client:

```json
{
  "mcpServers": {
    "x402-tools": {
      "command": "npx",
      "args": ["-y", "x402-tools-mcp"],
      "env": {
        "X402_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Or run it locally:

```bash
git clone https://github.com/foxxx009/x402-tools-mcp
cd x402-tools-mcp && npm install
X402_PRIVATE_KEY=0x... node index.js
```

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `X402_PRIVATE_KEY` | yes | — |
| `X402_BASE_URL` | no | `https://fitze-x402-seller.app.workbuddy.host` |

`X402_BASE_URL` lets you point the same server at your own x402 seller.

## What leaves your machine

Only two things: the tool arguments, and an EIP-3009 signature authorising a
USDC transfer for the quoted amount. The private key never leaves the process.
Signing is local; settlement happens on Base.

## Notes

- Payments are USDC on **Base mainnet**. A testnet wallet will not work.
- Each call is charged on retry with `X-PAYMENT`; the 402 response always
  states the exact amount before you pay anything.
- `repo_diligence` and `web_brief` are priced higher because they do real
  multi-request work. Call them deliberately.

## Licence

MIT
