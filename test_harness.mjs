// Spawns the MCP server over stdio and drives a real handshake.
// Uses a throwaway key: EIP-3009 signing is offline, so this proves the
// payment wiring without spending anything.
import { spawn } from 'node:child_process';

const KEY = '0x' + '11'.repeat(32); // throwaway, zero balance
const child = spawn(process.execPath, ['index.js'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, X402_PRIVATE_KEY: KEY },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* not JSON (e.g. server banner) */
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: 'timeout' });
      }
    }, 30000);
  });
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'harness', version: '1' },
});
console.log('initialize ->', init.error ? 'ERROR ' + JSON.stringify(init.error) : 'ok, server=' + (init.result?.serverInfo?.name));

const list = await send('tools/list', {});
const tools = list.result?.tools || [];
console.log('tools/list  ->', tools.length, 'tools');
for (const t of tools) console.log('   -', t.name, '|', t.description.slice(0, 46) + '...');

console.log('\n--- live call: web_fetch (expect a payment attempt) ---');
const call = await send('tools/call', {
  name: 'web_fetch',
  arguments: { url: 'https://example.com', maxChars: 300 },
});
const txt = call.result?.content?.[0]?.text ?? JSON.stringify(call);
console.log('isError:', call.result?.isError);
const reason = (txt.match(/"verifyError":\s*"([^"]+)"/) || [])[1];
console.log('verifyError:', reason || '(none)');
console.log('full response length:', txt.length);

child.kill();
process.exit(0);
