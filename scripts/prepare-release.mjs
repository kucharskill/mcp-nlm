import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(lock.version, metadata.version);
assert.equal(lock.packages[''].version, metadata.version);
const directory = resolve('.tmp/releases');
await mkdir(directory, { recursive: true });
const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', directory], { encoding: 'utf8' });
if (packed.status !== 0) throw new Error(packed.stderr);
const reports = JSON.parse(packed.stdout);
const report = Array.isArray(reports) ? reports[0] : reports[metadata.name];
const archive = await readFile(join(directory, report.filename));
const tar = gunzipSync(archive);
const files = [];
for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
  const header = tar.subarray(offset, offset + 512);
  const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
  const name = field(0, 100);
  const size = parseInt(field(124, 12).trim(), 8) || 0;
  assert.ok(['0', ''].includes(field(156, 1)), `Unexpected tar entry type: ${name}`);
  files.push(name);
  offset += 512 + Math.ceil(size / 512) * 512;
}
assert.deepEqual(files.sort(), ['package/LICENSE', 'package/README.md', 'package/cli.js', 'package/discovery-cache.js', 'package/package.json', 'package/proxy.js'].sort());
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
assert.equal(integrity, report.integrity);
const manifest = { name: metadata.name, version: metadata.version, archive: report.filename, integrity, files };
await writeFile(join(directory, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
