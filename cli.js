#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { StdioProxy } from './proxy.js';

const args = process.argv.slice(2);
if (args.length) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(metadata.version);
    process.exit(0);
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: mcp-nlm [--help | --version]\n\nStart the on-demand NotebookLM stdio MCP proxy (default).\nRequires Node.js 22+ and uvx on PATH.');
    process.exit(0);
  }
  console.error('Unknown argument. Run mcp-nlm --help.');
  process.exit(2);
}

const cwd = join(tmpdir(), 'uvx', 'nlm');
const data = process.env.NOTEBOOKLM_MCP_CLI_PATH || join(cwd, 'data');
await mkdir(data, { recursive: true });
const proxy = new StdioProxy({
  command: 'uvx',
  args: ['--from', 'notebooklm-mcp-cli@latest', 'notebooklm-mcp'],
  cwd,
  env: { ...process.env, NOTEBOOKLM_MCP_CLI_PATH: data },
  cache: {
    ttlMs: process.env.MCP_NLM_CACHE_TTL_MS === undefined ? 600_000 : Number(process.env.MCP_NLM_CACHE_TTL_MS),
    excludeEnv: (process.env.MCP_NLM_CACHE_EXCLUDE_ENV || '').split(',').map(name => name.trim()).filter(Boolean),
  },
});
proxy.connect(process.stdin, process.stdout);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await proxy.close(); process.exit(0); });
}
