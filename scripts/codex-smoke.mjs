// Run against the installed Codex RMCP client without accounts or production tools:
// node scripts/codex-smoke.mjs <absolute-path-to-codex-executable>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const binary = process.argv[2];
assert.ok(binary, 'Pass the installed Codex executable explicitly');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, '.tmp'); await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'codex-sdk-'));
const home = join(directory, 'home'); await mkdir(home);
const events = join(directory, 'events.jsonl');
const responses = join(directory, 'responses.jsonl');
const state = join(directory, 'state.json');
await writeFile(events, ''); await writeFile(responses, ''); await writeFile(state, '{"version":"1"}');
const config = { backend: join(root, 'fixtures/backend.mjs'), cwd: directory, directory: join(directory, 'discovery'), responses };
await writeFile(join(home, 'config.toml'), '[features]\nmcp_2026_07_28 = true\n[mcp_servers.fixture]\ncommand = ' + JSON.stringify(process.execPath)
  + '\nargs = ' + JSON.stringify([join(root, 'fixtures/sdk-proxy.mjs'), JSON.stringify(config)])
  + '\nstartup_timeout_sec = 10\nenv = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28", FIXTURE_LOG = ' + JSON.stringify(events) + ', FIXTURE_STATE = ' + JSON.stringify(state) + ' }\n');
const env = { ...process.env, CODEX_HOME: home, FIXTURE_LOG: events, FIXTURE_STATE: state };
const children = [];
try {
  const results = [];
  for (let replica = 0; replica < 2; replica++) {
    const child = spawn(binary, ['app-server', '--stdio'], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); child.stderr.on('data', () => {});
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    const pending = new Map(); let sequence = 0;
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line); const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    });
    const call = (method, params) => new Promise((resolveReply, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error('Codex timeout: ' + method)), 20000);
      pending.set(id, response => { clearTimeout(timer); response.error ? reject(new Error(JSON.stringify(response.error))) : resolveReply(response.result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await call('initialize', { clientInfo: { name: 'mcp-cache-regression', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    await call('experimentalFeature/enablement/set', { enablement: { mcp_2026_07_28: true } });
    const started = await call('thread/start', { cwd: directory, ephemeral: true });
    const inventory = await call('mcpServerStatus/list', { serverName: 'fixture', threadId: started.thread.id });
    const server = inventory.data.find(item => item.name === 'fixture');
    assert.equal(server.toolsError, null); assert.equal(server.runtimeStatus, 'connected');
    assert.ok(Object.keys(server.tools).length > 0);
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await exited; clearTimeout(timer);
    const publicResults = (await readFile(responses, 'utf8')).trim().split('\n').map(JSON.parse);
    results.push(publicResults); await writeFile(responses, '');
    const backendEvents = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(backendEvents.filter(e => e.method === 'spawn').length, 1, 'Warm replica must not start upstream');
    assert.equal(backendEvents.some(e => e.method === 'initialize'), false, 'Modern discovery must not use legacy initialize');
  }
  const byShape = results => results.map(r => JSON.stringify(r)).sort();
  assert.deepEqual(byShape(results[1]), byShape(results[0]));
  assert.ok(results[0].every(r => r.ttlMs === 0 && r.cacheScope === 'private' && r.futureField.keep.length === 2));
  console.log('Codex RMCP: cold/warm discovery connected; public results identical; ttlMs:0 retained; one backend across two replicas.');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  assert.equal(dirname(directory), base);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

