import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('tmp/releases/package-manifest.json', 'utf8'));
const prerelease = manifest.version.includes('-');
if (process.env.RELEASE_PRERELEASE !== undefined) assert.equal(prerelease, process.env.RELEASE_PRERELEASE === 'true');
const response = await fetch(`https://registry.npmjs.org/${manifest.name}/${manifest.version}`);
if (response.ok) {
  const published = await response.json();
  assert.equal(published.dist?.integrity, manifest.integrity, 'Published archive differs; do not replace an immutable version');
  console.log('Identical version already published.');
} else {
  assert.equal(response.status, 404, 'Registry check failed');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'publish', `tmp/releases/${manifest.archive}`, '--access', 'public', '--provenance', '--tag', prerelease ? 'next' : 'latest'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
