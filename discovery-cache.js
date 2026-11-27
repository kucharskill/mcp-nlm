import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const modern = version => typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= '2026-07-28';
export const discoveryMethods = new Set(['initialize', 'server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
const collections = { 'tools/list': 'tools', 'prompts/list': 'prompts', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => JSON.stringify(name) + ':' + canonical(value[name])).join(',') + '}';
  return JSON.stringify(value);
}

export function targetKey({ command, args = [], cwd, env = process.env, excludeEnv = [], platform = process.platform }) {
  const normalize = name => platform === 'win32' ? name.toUpperCase() : name;
  const excluded = new Set(['CODEX_TOOL_CALL_ID', ...excludeEnv].map(normalize));
  const environment = new Map();
  // Match Windows' case-insensitive environment lookup, including duplicate aliases.
  for (const name of Object.keys(env).sort()) {
    const normalized = normalize(name);
    if (!excluded.has(normalized) && env[name] !== undefined && !environment.has(normalized)) environment.set(normalized, String(env[name]));
  }
  return digest([command, args, resolve(cwd || process.cwd()), [...environment].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
}

export function contract(params = {}, legacy = false) {
  if (legacy) {
    const { clientInfo, _meta, ...rest } = params;
    const { progressToken, ...meta } = _meta || {};
    return digest({ ...rest, ...(Object.keys(meta).length ? { _meta: meta } : {}) });
  }
  const meta = params._meta || {};
  return digest({ protocolVersion: meta['io.modelcontextprotocol/protocolVersion'], capabilities: meta['io.modelcontextprotocol/clientCapabilities'] || {} });
}

export function slot(method, context, params = {}) {
  if (!discoveryMethods.has(method) || params.cursor) return null;
  const { _meta, ...options } = params;
  return digest([method, context, method === 'initialize' ? {} : options]);
}

export function identity(result) {
  const info = result?.serverInfo || result?._meta?.['io.modelcontextprotocol/serverInfo'];
  return object(info) && typeof info.name === 'string' && typeof info.version === 'string' ? digest(info) : null;
}

// Only discovery results enter the file. Do not retain response/session metadata.
export function cacheable(method, result) {
  if (!object(result)) return null;
  let value;
  if (method === 'initialize') {
    if (typeof result.protocolVersion !== 'string' || modern(result.protocolVersion) || !identity(result) || !object(result.capabilities)) return null;
    value = { protocolVersion: result.protocolVersion, capabilities: result.capabilities, serverInfo: result.serverInfo };
    if (typeof result.instructions === 'string') value.instructions = result.instructions;
  } else if (method === 'server/discover') {
    if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.length || !result.supportedVersions.every(v => typeof v === 'string') || !object(result.capabilities)) return null;
    value = { supportedVersions: result.supportedVersions, capabilities: result.capabilities };
    if (typeof result.instructions === 'string') value.instructions = result.instructions;
    if (object(result._meta)) value._meta = result._meta;
    if (result.resultType === 'complete') value.resultType = 'complete';
  } else {
    const collection = collections[method];
    if (!collection || !Array.isArray(result[collection]) || result.nextCursor) return null;
    if (!result[collection].every(item => object(item) && (method === 'resources/list' ? typeof item.uri === 'string' : typeof item.name === 'string')
        && (method !== 'tools/list' || (object(item.inputSchema) && item.inputSchema.type === 'object')))) return null;
    value = { [collection]: result[collection] };
    if (object(result._meta)) value._meta = result._meta;
    if (result.resultType === 'complete') value.resultType = 'complete';
  }
  // Session identifiers are never persisted, even when placed inside vendor metadata.
  const clean = item => {
    if (Array.isArray(item)) return item.map(clean);
    if (!object(item)) return item;
    return Object.fromEntries(Object.entries(item).filter(([name]) => !/^(?:session(?:[_-]?id)?|mcp-session-id|progressToken|requestId|subscriptionId)$/i.test(name)).map(([name, child]) => [name, clean(child)]));
  };
  const cleaned = clean(value);
  // Avoid changing a schema that legitimately uses a filtered property name.
  return canonical(cleaned) === canonical(value) ? structuredClone(value) : null;
}

export class DiscoveryCache {
  constructor(target, { directory = join(tmpdir(), 'uvx', 'nlm', 'discovery'), ttlMs = 600_000, excludeEnv = [] } = {}) {
    this.key = targetKey({ ...target, excludeEnv });
    this.path = join(directory, this.key + '.json');
    this.directory = directory;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 600_000;
  }

  async document() {
    try {
      if ((await stat(this.path)).size > 8 * 1024 * 1024) return null;
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data.schema !== 1 || data.key !== this.key || typeof data.revision !== 'string'
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.revision)
          || !Number.isFinite(data.expiresAt) || !object(data.entries)
          || !(data.identity === null || /^[a-f0-9]{64}$/.test(data.identity))) return null;
      return data;
    } catch { return null; }
  }

  async read(cacheSlot, method) {
    const data = await this.document();
    const entry = data?.entries[cacheSlot];
    const now = Date.now();
    const result = data?.expiresAt > now && entry?.method === method && Number.isFinite(entry.savedAt) && Number.isFinite(entry.expiresAt) && entry.savedAt <= now
      && entry.expiresAt > now && entry.expiresAt <= entry.savedAt + this.ttlMs && this.ttlMs > 0 && cacheable(method, entry.result);
    return { revision: data?.revision || null, result: result || null, identity: data?.identity || null };
  }

  async update(change) {
    // A short exclusive lock serializes writers. Busy/read-only caches are safe misses.
    const lockPath = this.path + '.lock';
    let lock;
    let temporary;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 20; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (error.code !== 'EEXIST') return;
          if (attempt === 19) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const next = change(await this.document());
      if (!next) return;
      temporary = this.path + `.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch {
      // Discovery must remain usable if cache IO fails.
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (lock) { await lock.close(); await rm(lockPath, { force: true }).catch(() => {}); }
    }
  }

  async put(cacheSlot, method, result, revision, backendIdentity) {
    const value = cacheable(method, result);
    if (!cacheSlot || !value || !this.ttlMs) return;
    await this.update(current => {
      // Do not restore an entry invalidated while this discovery was in flight.
      if ((current?.revision || null) !== revision) return null;
      if (current?.identity && backendIdentity && current.identity !== backendIdentity) return null;
      const now = Date.now();
      const entries = Object.fromEntries(Object.entries(current?.entries || {}).filter(([, entry]) => entry?.expiresAt > now));
      entries[cacheSlot] = { method, savedAt: now, expiresAt: now + this.ttlMs, result: value };
      return { schema: 1, key: this.key, revision: current?.revision || randomUUID(), identity: backendIdentity || current?.identity || null, expiresAt: now + this.ttlMs, entries };
    });
  }

  async invalidate() {
    await this.update(() => ({ schema: 1, key: this.key, revision: randomUUID(), identity: null, expiresAt: 0, entries: {} }));
  }
}
