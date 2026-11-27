import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryCache, targetKey } from '../discovery-cache.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'fixtures/backend.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

async function scenario(t, defaults = {}) {
  const base = join(root, '.tmp', 'tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'discovery-'));
  const statePath = join(directory, 'state.json');
  const logPath = join(directory, 'events.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '1' }));
  await writeFile(logPath, '');
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    assert.equal(dirname(directory), base);
    await rm(directory, { recursive: true, force: true });
  });
  function client(options = {}, env = {}) {
    const config = { backend, cwd: root, directory: join(directory, 'cache'), ...defaults, ...options };
    const child = spawn(process.execPath, [join(root, 'fixtures/proxy.mjs'), JSON.stringify(config)], {
      env: { ...process.env, FIXTURE_STATE: statePath, FIXTURE_LOG: logPath, ...env },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    const pending = new Map();
    let sequence = 0;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (!message.method && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message);
      }
    });
    const exited = new Promise(resolve => child.on('exit', code => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Proxy exited (${code}): ${stderr}`)); }
      resolve(code);
    }));
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const call = (method, params = {}) => new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}; ${stderr}`)); }, 8000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      send({ id, method, params });
    });
    const initialize = async (params = {}) => {
      const result = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' }, ...params });
      send({ method: 'notifications/initialized' });
      return result;
    };
    const close = async () => {
      if (child.exitCode !== null) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 4000);
      try { await exited; } finally { clearTimeout(timer); }
    };
    const result = { call, send, initialize, close, child, messages, config };
    clients.push(result);
    return result;
  }
  const events = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const state = value => writeFile(statePath, JSON.stringify(value));
  const document = async () => {
    const files = (await readdir(join(directory, 'cache'))).filter(name => name.endsWith('.json'));
    return JSON.parse(await readFile(join(directory, 'cache', files[0]), 'utf8'));
  };
  return { client, events, state, document, directory };
}

test('legacy ping is local, modern ping is rejected, and neither launches upstream', async t => {
  const s = await scenario(t);
  const c = s.client();
  assert.deepEqual((await c.call('ping')).result, {});
  assert.equal((await c.call('ping', { _meta: modernMeta })).error.code, -32601);
  assert.deepEqual(await s.events(), []);
});

test('cold discovery persists complete metadata; a second process initializes and lists without upstream', async t => {
  const s = await scenario(t);
  const first = s.client({}, { CODEX_TOOL_CALL_ID: 'first', CACHE_TEST_SECRET: 'synthetic-secret-never-persist' });
  const init = await first.initialize();
  const list = await first.call('tools/list');
  for (const method of ['prompts/list', 'resources/list', 'resources/templates/list']) assert.ok((await first.call(method)).result);
  await first.close();
  const second = s.client({}, { CODEX_TOOL_CALL_ID: 'second', CACHE_TEST_SECRET: 'synthetic-secret-never-persist' });
  assert.deepEqual((await second.initialize()).result.capabilities, init.result.capabilities);
  assert.deepEqual((await second.call('tools/list')).result, list.result);
  for (const method of ['prompts/list', 'resources/list', 'resources/templates/list']) await second.call(method);
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 1);
  const document = await s.document();
  const text = JSON.stringify(document);
  assert.equal(text.includes('synthetic-secret-never-persist'), false);
  assert.equal(text.includes('CODEX_TOOL_CALL_ID'), false);
  assert.equal(text.includes('do-not-cache'), false);
  assert.equal(text.includes('sessionId'), false);
  assert.equal(list.result.tools[0]._meta.vendor.tags[0], 'fixture');
  const operation = await second.call('tools/call', { name: 'read', arguments: { value: 'untouched' } });
  assert.equal(operation.result.structuredContent.ephemeralEnv, 'second');
  assert.equal(operation.result.structuredContent.params.arguments.value, 'untouched');
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 2);
  assert.equal(JSON.stringify(await s.document()).includes('fixture result'), false);
});

test('cache keys cover args, cwd, all env and canonical Windows exclusions', () => {
  const base = { command: 'uvx', args: ['--from', 'package@latest'], cwd: root, env: { A: '1', Secret: '2', CODEX_TOOL_CALL_ID: 'old' }, platform: 'win32' };
  assert.equal(targetKey(base), targetKey({ ...base, env: { secret: '2', codex_tool_call_id: 'new', a: '1' } }));
  for (const change of [{ args: ['different'] }, { cwd: join(root, '.tmp') }, { env: { ...base.env, A: '2' } }, { env: { ...base.env, EXTRA: 'yes' } }]) assert.notEqual(targetKey(base), targetKey({ ...base, ...change }));
  assert.equal(targetKey({ ...base, excludeEnv: ['secret'] }), targetKey({ ...base, excludeEnv: ['SECRET'], env: { ...base.env, Secret: 'changed' } }));
  assert.notEqual(targetKey({ ...base, args: ['a,b', 'c'] }), targetKey({ ...base, args: ['a', 'b,c'] }));
});

test('changed env, args, and cwd cause real cache misses', async t => {
  const s = await scenario(t);
  const altCwd = join(s.directory, 'cwd');
  await mkdir(altCwd);
  for (const [options, env] of [[{}, {}], [{}, { CACHE_EXTRA: 'changed' }], [{ extraArgs: ['different'] }, {}], [{ cwd: altCwd }, {}]]) {
    const c = s.client(options, env);
    await c.initialize(); await c.call('tools/list'); await c.close();
  }
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 4);
});

test('TTL and malformed/old cache safely miss; hits never extend expiresAt', async t => {
  const s = await scenario(t);
  const first = s.client(); await first.initialize(); await first.call('tools/list'); await first.close();
  const expiry = (await s.document()).expiresAt;
  const second = s.client(); await second.initialize(); await second.call('tools/list'); await second.close();
  assert.equal((await s.document()).expiresAt, expiry);
  const cachePath = join(s.directory, 'cache', (await readdir(join(s.directory, 'cache'))).find(name => name.endsWith('.json')));
  const expired = await s.document();
  assert.ok(Object.values(expired.entries).every(entry => entry.expiresAt - entry.savedAt === 600_000));
  expired.expiresAt = Date.now() - 1;
  for (const entry of Object.values(expired.entries)) { entry.savedAt = Date.now() - 600_001; entry.expiresAt = Date.now() - 1; }
  await writeFile(cachePath, JSON.stringify(expired));
  const third = s.client(); await third.initialize(); await third.call('tools/list'); await third.close();
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 2);
  for (const broken of ['{truncated', JSON.stringify({ schema: 0 }), JSON.stringify({ ...(await s.document()), entries: { broken: true } })]) {
    await writeFile(cachePath, broken);
    const c = s.client(); await c.initialize(); await c.call('tools/list'); await c.close();
  }
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 5);
});

test('warm hits and keep-alives do not reset idle; real operations use long idle', async t => {
  const s = await scenario(t, { discoveryMs: 300, idleMs: 700 });
  const c = s.client();
  await c.initialize(); await c.call('tools/list');
  const operation = await c.call('tools/call', { name: 'read', arguments: {} });
  const pid = operation.result.structuredContent.pid;
  const deadline = Date.now() + 900;
  while (Date.now() < deadline) { await pause(50); await c.call('ping'); await c.call('tools/list'); }
  const next = await c.call('tools/call', { name: 'read', arguments: {} });
  assert.notEqual(next.result.structuredContent.pid, pid);
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 2);
});

test('real operation remains active across short discovery idle and still receives cancellation', async t => {
  const s = await scenario(t, { discoveryMs: 50, idleMs: 80 });
  const c = s.client(); await c.initialize(); await c.call('tools/list');
  const operation = c.call('tools/call', { name: 'slow', arguments: { delay: 250 } });
  await pause(50);
  c.send({ method: 'notifications/cancelled', params: { requestId: 3 } });
  await c.call('tools/list');
  assert.ok((await operation).result);
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 1);
  assert.ok((await s.events()).some(event => event.method === 'notifications/cancelled'));
});

test('list_changed invalidates shared cache and prevents stale in-flight writes', async t => {
  const s = await scenario(t);
  const first = s.client(); await first.initialize(); await first.call('tools/list');
  const second = s.client(); await second.initialize(); await second.call('tools/list');
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 1);
  await s.state({ version: '1', tool: 'updated' });
  await first.call('tools/call', { name: 'notify', arguments: {} });
  assert.equal((await second.call('tools/list')).result.tools[0].name, 'updated');
  await first.close(); await second.close();
  await s.state({ version: '1', tool: 'newer', notifyDuringList: true });
  const third = s.client({ extraArgs: ['separate-key'] }); await third.initialize(); await third.call('tools/list');
  const files = await readdir(join(s.directory, 'cache'));
  const records = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(s.directory, 'cache', name), 'utf8'))));
  assert.ok(records.some(record => Object.keys(record.entries).length === 0));
});

test('ping bypasses an outstanding operation and never reaches the backend', async t => {
  const s = await scenario(t);
  const c = s.client(); await c.initialize();
  let completed = false;
  const operation = c.call('tools/call', { name: 'slow', arguments: { delay: 300 } }).then(result => { completed = true; return result; });
  await pause(30);
  assert.deepEqual((await c.call('ping')).result, {});
  assert.equal(completed, false);
  await operation;
  assert.equal((await s.events()).some(event => event.method === 'ping'), false);
});

test('client capability contracts do not reuse each other and cursors are not persisted', async t => {
  const s = await scenario(t);
  const first = s.client(); await first.initialize(); await first.call('tools/list'); await first.close();
  const second = s.client(); await second.initialize({ capabilities: { roots: { listChanged: true } } });
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 2);
  await second.call('tools/list', { cursor: 'one-off-cursor' });
  assert.equal(JSON.stringify(await s.document()).includes('opaque-session-cursor'), false);
  assert.equal(JSON.stringify(await s.document()).includes('one-off-cursor'), false);
});

test('modern cancellation requires no response and does not keep upstream permanently alive', async t => {
  const s = await scenario(t, { discoveryMs: 50, idleMs: 80 });
  const c = s.client();
  await c.call('server/discover', { _meta: modernMeta });
  c.send({ id: 'cancel-me', method: 'tools/call', params: { name: 'slow', arguments: { delay: 200 }, _meta: modernMeta } });
  await pause(20);
  c.send({ method: 'notifications/cancelled', params: { requestId: 'cancel-me', _meta: modernMeta } });
  await pause(400);
  await c.call('tools/call', { name: 'read', _meta: modernMeta });
  assert.equal(c.messages.some(message => message.id === 'cancel-me'), false);
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 2);
});

test('observed identity changes invalidate all shared discovery', async t => {
  const s = await scenario(t);
  const first = s.client(); await first.initialize(); await first.call('tools/list');
  await s.state({ version: '2', tool: 'v2' });
  await first.call('tools/call', { name: 'identity', arguments: {} });
  const second = s.client();
  assert.equal((await second.initialize()).result.serverInfo.version, '2');
  assert.equal((await second.call('tools/list')).result.tools[0].name, 'v2');
});

test('cached protocol negotiation is exact; incompatible restarted capabilities require reconnect', async t => {
  const s = await scenario(t);
  const first = s.client();
  assert.equal((await first.initialize({ protocolVersion: '1900-01-01' })).result.protocolVersion, '2025-11-25');
  await first.call('tools/list'); await first.close();
  const second = s.client();
  assert.equal((await second.initialize({ protocolVersion: '1900-01-01' })).result.protocolVersion, '2025-11-25');
  await s.state({ version: '2', capabilities: { tools: {} } });
  const failure = await second.call('tools/call', { name: 'read' });
  assert.match(failure.error.message, /capabilities changed/);
  assert.equal((await s.events()).filter(event => event.method === 'tools/call').length, 0);
  assert.equal(Object.keys((await s.document()).entries).length, 0);
});

test('an unavailable cache fails open and a backend exit after a result does not duplicate responses', async t => {
  const s = await scenario(t);
  const blocked = join(s.directory, 'not-a-directory');
  await writeFile(blocked, 'fixture');
  const c = s.client({ directory: blocked });
  assert.ok((await c.initialize()).result);
  await s.state({ version: '1', exitAfterList: true });
  assert.equal((await c.call('tools/list')).result.tools[0].name, 'fixture');
  await pause(100);
  assert.equal(c.messages.filter(message => message.id === 2).length, 1);
  const second = s.client();
  await second.initialize(); await second.call('tools/list');
  await pause(100);
  assert.equal(second.messages.filter(message => message.id === 2).length, 1);
});

test('modern discover/tools are cached without a legacy handshake or ping RPC', async t => {
  const s = await scenario(t);
  const first = s.client();
  const discover = await first.call('server/discover', { _meta: modernMeta });
  await first.call('tools/list', { _meta: modernMeta }); await first.close();
  const second = s.client();
  assert.deepEqual((await second.call('server/discover', { _meta: modernMeta })).result, discover.result);
  await second.call('tools/list', { _meta: modernMeta });
  assert.equal((await s.events()).filter(event => event.method === 'spawn').length, 1);
  assert.equal((await second.call('ping', { _meta: modernMeta })).error.code, -32601);
  await second.call('tools/call', { name: 'read', _meta: modernMeta });
  assert.equal((await s.events()).filter(event => event.method === 'initialize' || event.method === 'ping').length, 0);
});

test('concurrent writers leave valid atomic JSON and invalidated generations cannot be resurrected', async t => {
  const s = await scenario(t);
  const target = { command: 'fixture', args: [], cwd: root, env: {} };
  const cache = new DiscoveryCache(target, { directory: join(s.directory, 'cache') });
  const result = { tools: [{ name: 'one', inputSchema: { type: 'object' } }] };
  const initial = await cache.read('initial', 'tools/list');
  await cache.put('initial', 'tools/list', result, initial.revision, null);
  const lease = await cache.read('initial', 'tools/list');
  await Promise.all(Array.from({ length: 8 }, (_, i) => new DiscoveryCache(target, { directory: cache.directory }).put('slot' + i, 'tools/list', result, lease.revision, null)));
  assert.equal(Object.keys((await cache.document()).entries).length, 9);
  await cache.invalidate();
  await cache.put('stale', 'tools/list', result, lease.revision, null);
  assert.equal((await cache.read('stale', 'tools/list')).result, null);
  assert.equal((await readdir(cache.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});
