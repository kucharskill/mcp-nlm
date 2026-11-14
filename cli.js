#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioProxy } from './proxy.js';

const cwd = join(tmpdir(), 'uvx', 'nlm');
const data = process.env.NOTEBOOKLM_MCP_CLI_PATH || join(cwd, 'data');
await mkdir(data, { recursive: true });
const proxy = new StdioProxy({
  command: 'uvx',
  args: ['--from', 'notebooklm-mcp-cli@latest', 'notebooklm-mcp'],
  cwd,
  env: { ...process.env, NOTEBOOKLM_MCP_CLI_PATH: data },
});
proxy.connect(process.stdin, process.stdout);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await proxy.close(); process.exit(0); });
}
