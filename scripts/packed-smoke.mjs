import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tar = gunzipSync(await readFile(process.argv[2] || join(root, '.tmp/releases', `mcp-nlm-${metadata.version}.tgz`)));
const base = join(root, '.tmp');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'packed-'));
const children = [];
try {
  await mkdir(join(directory, 'package'));
  const allowed = new Set(['LICENSE', 'README.md', 'cli.js', 'proxy.js', 'discovery-cache.js', 'startup-env.js', 'package.json']);
  for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const name = field(0, 100);
    const size = parseInt(field(124, 12).trim(), 8) || 0;
    const relative = name.replace(/^package\//, '');
    assert.ok(name === 'package/' + relative && allowed.has(relative));
    assert.ok(['0', ''].includes(field(156, 1)));
    await writeFile(join(directory, 'package', relative), tar.subarray(offset + 512, offset + 512 + size));
    allowed.delete(relative);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(allowed.size, 0);
  for (const argument of ['--version', '--help']) {
    const result = spawnSync(process.execPath, [join(directory, 'package/cli.js'), argument], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(argument === '--version' ? metadata.version : 'Usage:'));
  }
  const statePath = join(directory, 'state.json');
  const logPath = join(directory, 'events.jsonl');
  await writeFile(statePath, '{"version":"1"}'); await writeFile(logPath, '');
  const config = { module: join(directory, 'package/proxy.js'), backend: join(root, 'fixtures/backend.mjs'), cwd: directory, directory: join(directory, 'discovery') };
  for (let replica = 0; replica < 2; replica++) {
    const child = spawn(process.execPath, [join(root, 'fixtures/proxy.mjs'), JSON.stringify(config)], {
      cwd: directory, env: { ...process.env, FIXTURE_STATE: statePath, FIXTURE_LOG: logPath, CODEX_TOOL_CALL_ID: String(replica) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(child);
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    let id = 0;
    const pending = new Map();
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    createInterface({ input: child.stdout }).on('line', line => {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter && !response.method) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response); }
    });
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const call = (method, params = {}) => new Promise((resolveCall, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 8000);
      pending.set(requestId, { resolve: resolveCall, timer }); send({ id: requestId, method, params });
    });
    assert.deepEqual((await call('ping')).result, {});
    assert.ok((await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packed-smoke', version: '1' } })).result.capabilities.tools);
    send({ method: 'notifications/initialized' });
    assert.equal((await call('tools/list')).result.tools[0].name, 'fixture');
    const events = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.method === 'spawn').length, 1, 'Warm discovery should not start a backend in replica two');
    if (replica) assert.equal((await call('tools/call', { name: 'read', arguments: { value: 'fixture' } })).result.structuredContent.params.arguments.value, 'fixture');
    child.stdin.end();
    assert.equal(await exited, 0);
  }
  console.log('Packed CLI, local ping, cold/warm discovery in two processes, and fixture operation passed.');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  assert.equal(dirname(directory), base);
  await rm(directory, { recursive: true, force: true });
}
