#!/usr/bin/env node
/**
 * x402-tools-mcp — an MCP server that gives any agent six research / data
 * tools, paid per call over x402 (USDC on Base mainnet).
 *
 * There is no API key and no subscription. Each call costs a few cents; the
 * payment is an EIP-3009 signature settled on Base, handled entirely by the
 * official x402 client. Nothing is sent anywhere except the signed payment
 * authorisation and the tool arguments.
 *
 * Setup:
 *   1. Fund any Base wallet with a few dollars of USDC (the wallet needs no
 *      ETH — the facilitator pays gas).
 *   2. export X402_PRIVATE_KEY=0x<that wallet's private key>
 *   3. Add this server to your MCP client (see README).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createPaymentHeader, selectPaymentRequirements } from 'x402/client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const BASE_URL =
  process.env.X402_BASE_URL || 'https://fitze-x402-seller.app.workbuddy.host';

// ---------------------------------------------------------------------------
// Tool catalogue. Keep in sync with the seller's /tools/<name> endpoints.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'web_fetch',
    price: '$0.01',
    description:
      'Fetch a public URL and return status, final URL, page title, cleaned ' +
      'text (scripts/styles stripped) and the top 20 absolute links. Use when ' +
      'your own sandbox cannot reach the open web.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        maxChars: {
          type: 'number',
          description: 'Truncate cleaned text to this length (default 4000).',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'domain_intel',
    price: '$0.02',
    description:
      'Domain due diligence: RDAP registrar + creation/expiry dates + status, ' +
      'DNS records (A/MX/NS/TXT) and Certificate Transparency history via ' +
      'crt.sh. Use to vet a domain before trusting or linking to it.',
    schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Bare domain, e.g. example.com.',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'github_repo',
    price: '$0.02',
    description:
      'GitHub repository facts: description, stars, forks, open issues, ' +
      'language, licence, last push, default branch and README excerpt.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name, e.g. facebook/react.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'token_intel',
    price: '$0.02',
    description:
      'ERC-20 token facts read directly from Base mainnet: name, symbol, ' +
      'decimals, total supply and USDC balance of an address.',
    schema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'ERC-20 contract address (or holder address) on Base.',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'repo_diligence',
    price: '$2.50',
    description:
      'Deep repository diligence report: release cadence, contributor spread, ' +
      'issue/PR health, dependency signals and a plain-language risk summary. ' +
      'Use before depending on, investing in, or citing a repository.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name, e.g. owner/project.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'web_brief',
    price: '$3.00',
    description:
      'Cross-source brief: fetches several URLs and returns a consolidated ' +
      'summary with per-source attribution. Use for literature sweeps or ' +
      'competitive scans where you need citations, not raw pages.',
    schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of absolute http(s) URLs to summarise.',
        },
        maxSentences: {
          type: 'number',
          description: 'Sentences per source in the brief (default 8).',
        },
      },
      required: ['urls'],
    },
  },
  {
    name: 'free_url_check',
    price: 'FREE',
    description:
      'Check whether a public URL is reachable and what it is: HTTP status, ' +
      'final URL after redirects, content type and page title. Free, no ' +
      'payment. Use web_fetch for full text and links.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to check.' },
      },
      required: ['url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Wallet + x402 payment
// ---------------------------------------------------------------------------
function wallet() {
  const key = process.env.X402_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'X402_PRIVATE_KEY is not set. Export the private key (0x + 64 hex) of ' +
        'a Base wallet holding a few dollars of USDC. The wallet needs no ETH: ' +
        'gas is paid by the facilitator. Nothing else leaves your machine.'
    );
  }
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: base,
    transport: http(),
  });
}

/**
 * POST to the seller, paying the 402 challenge automatically.
 * Returns { status, body, paid }.
 */
async function paidCall(toolName, args) {
  const url = `${BASE_URL}/tools/${toolName}`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args || {}),
  };

  let res = await fetch(url, { ...init });
  if (res.status !== 402) {
    const text = await res.text();
    return { status: res.status, body: safeJson(text), paid: false };
  }

  const challenge = await res.json();
  const accepts = challenge.accepts || [];
  if (!accepts.length) {
    return {
      status: 402,
      body: { error: 'seller returned a 402 with no payment options', challenge },
      paid: false,
    };
  }

  const chosen = selectPaymentRequirements(accepts);
  const header = await createPaymentHeader(
    wallet(),
    challenge.x402Version ?? 1,
    chosen
  );

  // Send the proof three ways at once. Standard x402 is the header, but some
  // hosting gateways strip unknown request headers, so the seller also accepts
  // a query parameter and a body field. Duplicating costs nothing and makes the
  // call succeed behind any of them.
  const retryUrl = `${url}?x-payment=${encodeURIComponent(header)}`;
  res = await fetch(retryUrl, {
    method: 'POST',
    headers: { ...init.headers, 'X-PAYMENT': header },
    body: JSON.stringify({ ...(args || {}), 'x-payment': header }),
  });
  const text = await res.text();
  return { status: res.status, body: safeJson(text), paid: true };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'x402-tools-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: `[${t.price} per call, paid in USDC on Base] ${t.description}`,
    inputSchema: t.schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    // Free tool: no wallet, no signature — direct GET to the seller.
    if (tool.price === 'FREE') {
      const q = encodeURIComponent(JSON.stringify(req.params.arguments || {}));
      const r = await fetch(`${BASE_URL}/tools/free_url_check?q=${q}`);
      const text = await r.text();
      return {
        content: [{ type: 'text', text: r.status === 200 ? JSON.stringify(safeJson(text), null, 2) : `HTTP ${r.status}:\n` + text }],
        isError: r.status !== 200,
      };
    }
    const { status, body, paid } = await paidCall(name, req.params.arguments);
    const text =
      status === 200
        ? JSON.stringify(body, null, 2)
        : `Seller returned HTTP ${status}${paid ? ' after payment' : ''}:\n` +
          JSON.stringify(body, null, 2);
    return {
      content: [{ type: 'text', text }],
      isError: status !== 200,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
