import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const send = (message, flushed) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', flushed);
const log = event => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(event) + '\n');
const state = () => JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'));
const info = () => ({ name: 'fixture', version: state().version || '1' });
const capabilities = () => state().capabilities || { tools: { listChanged: true }, prompts: {}, resources: {} };
log({ method: 'spawn', pid: process.pid });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log({ method: message.method || 'response', id: message.id });
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  const modern = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] >= '2026-07-28';
  const meta = { 'io.modelcontextprotocol/serverInfo': info() };
  const reply = (result, flushed) => send({ id: message.id, result: modern ? { ...result, resultType: 'complete', _meta: meta } : result }, flushed);
  if (message.method === 'initialize') {
    reply({ protocolVersion: message.params.protocolVersion === '1900-01-01' ? '2025-11-25' : message.params.protocolVersion, capabilities: capabilities(), serverInfo: info(), instructions: 'Fixture instructions', _meta: { sessionId: 'do-not-cache' } });
  } else if (message.method === 'server/discover') {
    reply({ supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: capabilities(), instructions: 'Fixture instructions' });
  } else if (message.method === 'tools/list') {
    if (state().notifyDuringList) send({ method: 'notifications/tools/list_changed' });
    const result = { tools: [{ name: state().tool || 'fixture', description: 'Full description', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, _meta: { vendor: { tags: ['fixture'] } } }] };
    if (message.params?.cursor) result.nextCursor = 'opaque-session-cursor';
    reply(result, state().exitAfterList ? () => process.exit(0) : undefined);
  } else if (message.method === 'prompts/list') reply({ prompts: [{ name: 'prompt', description: 'Prompt description', arguments: [{ name: 'topic' }] }] });
  else if (message.method === 'resources/list') reply({ resources: [{ uri: 'fixture://resource', name: 'resource' }] });
  else if (message.method === 'resources/templates/list') reply({ resourceTemplates: [{ name: 'template', uriTemplate: 'fixture://{id}' }] });
  else if (message.method === 'tools/call') {
    if (message.params.name === 'notify') send({ method: 'notifications/tools/list_changed' });
    const result = { content: [{ type: 'text', text: 'fixture result' }], structuredContent: { pid: process.pid, params: message.params, ephemeralEnv: process.env.CODEX_TOOL_CALL_ID || process.env.codex_tool_call_id, identity: info() } };
    if (message.params.name === 'identity') result._meta = meta;
    const delay = message.params.arguments?.delay || 0;
    setTimeout(() => reply(result), delay);
  } else send({ id: message.id, error: { code: -32601, message: 'Unknown method' } });
});
