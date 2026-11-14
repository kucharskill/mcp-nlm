import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StdioProxy } from '../proxy.js';

const fixture = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
let ready = false;
let refreshCount = 0;
let operationCount = 0;
createInterface({input: process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'notifications/initialized') { ready = true; return; }
 if(m.method === 'initialize') { send({jsonrpc:'2.0', id:m.id, result:{protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}}); return; }
 if(m.method === 'crash') { process.exit(7); }
 if(m.method === 'tools/call' && m.params.name === 'refresh_auth') {
   refreshCount++;
   const profile = m.params.arguments?.profile;
   if(profile === 'timeout') return;
   if(profile === 'late') { setTimeout(() => send({jsonrpc:'2.0',id:m.id,result:{structuredContent:{status:'success'}}}),200); return; }
   if(profile === 'crash') process.exit(7);
   setTimeout(() => send({jsonrpc:'2.0',id:m.id,result:{content:[],structuredContent:{status:profile === 'fail' ? 'error' : 'success'}}}),30);
   return;
 }
 if(m.method === 'tools/call' && ['expired','ordinary-error','success-with-auth-text'].includes(m.params.name)) {
   operationCount++;
   const name = m.params.name;
   send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:name === 'ordinary-error' ? 'Invalid notebook id' : 'Authentication expired. Run nlm login'}],isError:name !== 'success-with-auth-text',_meta:{operationCount,refreshCount}}});
   return;
 }
 if(!m.method) { send({jsonrpc:'2.0',method:'notifications/fixture',params:m}); return; }
 if(m.method === 'server-request') { send({jsonrpc:'2.0',id:'server-1',method:'sampling/createMessage',params:{sample:true}}); }
 const reply = () => send({jsonrpc:'2.0',id:m.id,result:{ready,pid:process.pid,method:m.method,params:m.params}});
 if(m.method === 'slow') setTimeout(reply, 180); else reply();
});
`;

async function waitFor(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function setup(t, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1);
    }
  });
  const proxy = new StdioProxy({ command: process.execPath, args: ['--input-type=module', '-e', fixture], discoveryMs: 80, idleMs: 400, ...options });
  proxy.connect(input, output);
  t.after(() => proxy.close());
  const send = m => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const call = async (id, method, params = {}) => {
    send({ id, method, params });
    await waitFor(() => messages.some(m => m.id === id && !m.method));
    return messages.find(m => m.id === id && !m.method);
  };
  const initialize = async () => {
    await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    send({ method: 'notifications/initialized' });
  };
  return { proxy, messages, send, call, initialize, input };
}

test('discovery stops upstream; next call replays handshake and preserves arguments', async t => {
  const s = setup(t);
  await s.initialize();
  const first = await s.call(2, 'tools/list');
  await waitFor(() => !s.proxy.child);
  const params = { name: 'upstream-tool', arguments: { nested: [1, 'ą', { flag: true }] }, _meta: { progressToken: 'p' } };
  const second = await s.call('call-3', 'tools/call', params);
  assert.equal(second.result.ready, true);
  assert.notEqual(second.result.pid, first.result.pid);
  assert.deepEqual(second.result.params, params);
  assert.equal(s.messages.filter(m => m.result?.serverInfo).length, 1);
});

test('latest request selects delay and pending work cannot expire', async t => {
  const s = setup(t);
  await s.initialize();
  await s.call(2, 'tools/call');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(s.proxy.child);
  await s.call(3, 'tools/list');
  const response = await s.call(4, 'slow');
  assert.ok(response.result);
  assert.ok(s.proxy.child);
  await s.call(5, 'tools/list');
  await waitFor(() => !s.proxy.child);
});

test('server requests and client responses pass through', async t => {
  const s = setup(t);
  await s.initialize();
  await s.call(2, 'server-request');
  const request = s.messages.find(m => m.id === 'server-1');
  assert.equal(request.method, 'sampling/createMessage');
  s.send({ id: 'server-1', result: { accepted: true } });
  await waitFor(() => s.messages.some(m => m.method === 'notifications/fixture'));
  assert.deepEqual(s.messages.find(m => m.method === 'notifications/fixture').params.result, { accepted: true });
});

test('crash fails outstanding call and next call starts a fresh upstream', async t => {
  const s = setup(t);
  await s.initialize();
  const failure = await s.call(2, 'crash');
  assert.equal(failure.error.code, -32603);
  const recovered = await s.call(3, 'tools/list');
  assert.equal(recovered.result.ready, true);
});

test('closing client input stops upstream', async t => {
  const s = setup(t);
  await s.initialize();
  s.input.end();
  await waitFor(() => s.proxy.closed && !s.proxy.child);
});

test('auth recovery shares one refresh, preserves original errors, and never retries operations', async t => {
  const s = setup(t);
  await s.initialize();
  const [first, second] = await Promise.all([
    s.call(2, 'tools/call', { name: 'expired', arguments: {} }),
    s.call(3, 'tools/call', { name: 'expired', arguments: {} }),
  ]);
  assert.equal(first.result.isError, true);
  assert.equal(first.result.content[0].text, 'Authentication expired. Run nlm login');
  assert.match(first.result.content[1].text, /refreshed successfully/);
  assert.match(second.result.content[1].text, /not retried/);
  const probe = await s.call(4, 'tools/call', { name: 'ordinary-error', arguments: {} });
  assert.deepEqual(probe.result._meta, { operationCount: 3, refreshCount: 1 });
});

test('ordinary errors and successful content mentioning auth pass through unchanged', async t => {
  const s = setup(t);
  await s.initialize();
  for (const [id, name] of [[2, 'ordinary-error'], [3, 'success-with-auth-text']]) {
    const response = await s.call(id, 'tools/call', { name, arguments: {} });
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result._meta.refreshCount, 0);
  }
});

test('explicit refresh is not intercepted; failed recovery passes profile and returns guidance', async t => {
  const s = setup(t);
  await s.initialize();
  const explicit = await s.call(2, 'tools/call', { name: 'refresh_auth', arguments: { profile: 'fail' } });
  assert.equal(explicit.result.structuredContent.status, 'error');
  assert.equal(explicit.result.content.length, 0);
  const failure = await s.call(3, 'tools/call', { name: 'expired', arguments: { profile: 'fail' } });
  assert.match(failure.result.content[1].text, /failed or timed out/);
});

test('recovery timeout and process crash both release original request', async t => {
  const s = setup(t, { startupMs: 100 });
  await s.initialize();
  const timeout = await s.call(2, 'tools/call', { name: 'expired', arguments: { profile: 'timeout' } });
  assert.match(timeout.result.content[1].text, /timed out/);
  const crash = await s.call(3, 'tools/call', { name: 'expired', arguments: { profile: 'crash' } });
  assert.equal(crash.error.code, -32603);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(s.messages.filter(m => m.id === 3).length, 1);
});

test('late internal refresh responses never leak to client', async t => {
  const s = setup(t, { startupMs: 50 });
  await s.initialize();
  await s.call(2, 'tools/call', { name: 'expired', arguments: { profile: 'late' } });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(s.messages.some(m => typeof m.id === 'string' && m.id.startsWith('proxy-refresh-')), false);
  assert.equal(s.messages.filter(m => m.id === 2).length, 1);
});
