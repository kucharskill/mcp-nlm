import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendStartupEnv } from '../startup-env.js';

test('startup env appends one JSONL record per invocation and fails open', async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../.tmp/tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'startup-env-'));
  t.after(async () => {
    assert.equal(dirname(directory), base);
    await rm(directory, { recursive: true, force: true });
  });
  const env = { CODEX_TOOL_CALL_ID: 'first-replica', SYNTHETIC_TOKEN: 'fixture-only-value' };
  await appendStartupEnv(directory, env);
  env.CODEX_TOOL_CALL_ID = 'second-replica';
  await appendStartupEnv(directory, env);
  const file = join(directory, 'env-startup.jsonl');
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['env', 'pid', 'startedAt']);
    assert.equal(record.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));
    assert.equal(record.env.SYNTHETIC_TOKEN, 'fixture-only-value');
  }
  assert.equal(records[0].env.CODEX_TOOL_CALL_ID, 'first-replica');
  assert.equal(records[1].env.CODEX_TOOL_CALL_ID, 'second-replica');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const blocked = join(directory, 'not-a-directory');
  await writeFile(blocked, 'fixture');
  await assert.doesNotReject(appendStartupEnv(blocked, env));
});
