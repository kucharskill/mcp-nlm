import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const readNotebooks = args[0] === '--notebooks';
if (readNotebooks) args.shift();
const command = args.shift();
if (!command) throw new Error('Usage: node scripts/smoke.mjs [--notebooks] <command> [args...]');
const cwd = await mkdtemp(join(tmpdir(), 'mcp-nlm-smoke-'));
const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let id = 0;
let stderr = '';
let success = false;
child.stderr.on('data', chunk => { stderr += chunk; });
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (!success) for (const entry of pending.values()) entry.reject(new Error(`Process exited early: ${code || signal}; ${stderr.slice(-1500)}`));
    resolve(code);
  });
});
const timer = setTimeout(() => { child.kill(); }, 120_000);
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { child.kill(); return; }
  const entry = pending.get(message.id);
  if (entry && !message.method) {
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  }
});
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const call = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject }); send({ id, method, params });
});
try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'distribution-smoke-test', version: '1' } });
  assert.ok(init.serverInfo.name);
  send({ method: 'notifications/initialized' });
  const catalog = await call('tools/list');
  assert.ok(catalog.tools.some(tool => tool.name === 'notebook_list'));
  assert.ok(catalog.tools.every(tool => tool.inputSchema?.type === 'object'));
  console.log(JSON.stringify({ server: init.serverInfo, toolCount: catalog.tools.length }));
  if (readNotebooks) {
    const result = await call('tools/call', { name: 'notebook_list', arguments: { max_results: 3 } });
    const data = result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(data.status, 'success');
    console.log(JSON.stringify({ status: data.status, returned: data.notebooks.length, total: data.count }));
  }
  success = true;
} finally {
  child.stdin.end();
  const code = await exited;
  clearTimeout(timer);
  assert.equal(resolve(dirname(cwd)), resolve(tmpdir()));
  assert.ok(basename(cwd).startsWith('mcp-nlm-smoke-'));
  await rm(cwd, { recursive: true, force: true });
  assert.equal(code, 0);
}
