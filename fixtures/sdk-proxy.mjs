import { StdioProxy } from '../proxy.js';
import { appendFileSync } from 'node:fs';
const options = JSON.parse(process.argv[2]);
const proxy = new StdioProxy({ command: process.execPath, args: [options.backend], cwd: options.cwd,
  env: process.env, cache: { directory: options.directory } });
proxy.connect(process.stdin, { write(line) {
  const message = JSON.parse(line);
  if (message.result) appendFileSync(options.responses, JSON.stringify(message.result) + '\n');
  return process.stdout.write(line);
} });
