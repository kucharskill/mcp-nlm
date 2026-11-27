import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Local-only startup evidence; failures must not prevent MCP startup. */
export async function appendStartupEnv(directory, env = process.env) {
  try {
    const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), env }) + '\n';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, 'env-startup.jsonl'), record, { mode: 0o600 });
  } catch {}
}
