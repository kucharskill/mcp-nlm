import { pathToFileURL } from 'node:url';
import { StdioProxy as SourceProxy } from '../proxy.js';

const options = JSON.parse(process.argv[2]);
const Proxy = options.module ? (await import(pathToFileURL(options.module))).StdioProxy : SourceProxy;
const proxy = new Proxy({
  command: process.execPath,
  args: [options.backend, ...(options.extraArgs || [])],
  cwd: options.cwd,
  env: process.env,
  discoveryMs: options.discoveryMs || 300,
  idleMs: options.idleMs || 600,
  cache: { directory: options.directory, ttlMs: options.ttlMs ?? 600_000, excludeEnv: options.excludeEnv || [] },
});
proxy.connect(process.stdin, process.stdout);
