import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StdioProxy } from '../proxy.js';

const fixture = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
let ready = false;
createInterface({input: process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'notifications/initialized') { ready = true; return; }
 if(m.method === 'initialize') { send({jsonrpc:'2.0', id:m.id, result:{protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}}); return; }
 if(m.method === 'crash') { process.exit(7); }
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

function setup(t) {
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
  const proxy = new StdioProxy({ command: process.execPath, args: ['--input-type=module', '-e', fixture], discoveryMs: 80, idleMs: 400 });
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
