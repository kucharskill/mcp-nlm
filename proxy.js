import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { DiscoveryCache, canonical, contract, discoveryMethods, identity, modern, slot } from './discovery-cache.js';

const key = id => JSON.stringify(id);

function authFailure(result) {
  let data = result?.structuredContent;
  if (!data) {
    try { data = JSON.parse(result?.content?.find(item => item.type === 'text')?.text); } catch {}
  }
  if (!result?.isError && data?.status !== 'error') return false;
  const error = typeof data?.error === 'string' ? data.error
    : result?.isError ? result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
  return /authentication|unauthenticated|credentials? (?:have |has )?expired|no auth(?:entication)? found|run ['"`]?nlm login/i.test(error || '');
}

export class StdioProxy {
  constructor({ command, args = [], cwd, env = process.env, discoveryMs = 60_000, idleMs = 1_800_000, startupMs = 60_000, cache = {} }) {
    Object.assign(this, { command, args, cwd, env, discoveryMs, idleMs, startupMs });
    this.args = [...args];
    this.cwd = cwd || process.cwd();
    this.env = { ...env };
    this.pending = new Set();
    this.requests = new Map();
    this.refreshes = new Map();
    this.internalIds = new Set();
    this.serverPending = new Set();
    this.delay = discoveryMs;
    this.queue = Promise.resolve();
    this.closed = false;
    this.cache = cache === false ? null : new DiscoveryCache({ command, args: this.args, cwd: this.cwd, env: this.env }, cache);
    this.cacheRequests = new Map();
    this.cancelled = new Set();
    this.upstreamQueue = Promise.resolve();
  }

  connect(input, output) {
    this.output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', line => {
      // Keep-alive must not queue behind startup, touch idle, or wake upstream.
      try { if (this.localPing(JSON.parse(line))) return; } catch {}
      this.queued = (this.queued || 0) + 1;
      this.queue = this.queue.then(() => this.receive(line)).catch(error => {
        process.stderr.write(`mcp-nlm: ${error.message}\n`);
      }).finally(() => { this.queued--; this.arm(); });
    });
    lines.on('close', () => { void this.close(); });
  }

  emit(message) { this.output.write(JSON.stringify(message) + '\n'); }
  write(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }

  localPing(message) {
    if (message?.method !== 'ping') return false;
    const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] || this.protocolVersion;
    if (Object.hasOwn(message, 'id')) this.emit(modern(version)
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'ping is not part of modern MCP' } }
      : { jsonrpc: '2.0', id: message.id, result: {} });
    return true;
  }

  async receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (this.closed) return;
    const request = message.method && Object.hasOwn(message, 'id');
    const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] || this.protocolVersion;
    if (this.localPing(message)) return;
    if (request) {
      if (message.method === 'initialize') {
        this.initialize = message;
        this.sessionContract = contract(message.params, true);
      }
      if (modern(version)) this.protocolVersion = version;
      if (this.cache && discoveryMethods.has(message.method)) {
        const context = message.method === 'initialize' ? this.sessionContract
          : modern(version) ? contract(message.params) : this.sessionContract;
        const cacheSlot = slot(message.method, context, message.params);
        if (cacheSlot && context) {
          const cached = await this.cache.read(cacheSlot, message.method);
          if (cached.result) {
            if (message.method === 'initialize') {
              this.initializeResult = cached.result;
              this.protocolVersion = cached.result.protocolVersion;
            }
            this.backendIdentity = cached.identity || this.backendIdentity;
            this.emit({ jsonrpc: '2.0', id: message.id, result: cached.result });
            return;
          }
          this.cacheRequests.set(key(message.id), { cacheSlot, revision: cached.revision });
          this.backendIdentity ||= cached.identity;
        }
      }
    }
    if (message.method === 'notifications/initialized') {
      this.initialized = true;
      if (this.child) this.write(message);
      return;
    }
    if (message.method === 'notifications/cancelled' && modern(version)) this.cancel(message.params?.requestId);
    // A late notification must not restart an idle server (e.g. cancellation).
    if (!request && !this.child) return;
    try {
      if (request) {
        this.cancelled.delete(key(message.id));
        this.delay = discoveryMethods.has(message.method) ? this.discoveryMs : this.idleMs;
        this.idleDeadline = null;
        clearTimeout(this.timer);
      }
      await this.ensureStarted(message.method === 'initialize');
      if (this.closed) return;
      if (request) {
        this.pending.add(key(message.id));
        this.requests.set(key(message.id), message);
      }
      else if (Object.hasOwn(message, 'id')) this.serverPending.delete(key(message.id));
      this.write(message);
    } catch (error) {
      if (request) {
        this.cacheRequests.delete(key(message.id));
        this.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      }
      else throw error;
    }
  }

  async ensureStarted(firstInitialize) {
    if (this.stopping) await this.stopping;
    if (this.closed || this.child) return;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      try {
        const message = JSON.parse(line);
        this.upstreamQueue = this.upstreamQueue.then(() => this.upstream(message)).catch(error => {
          process.stderr.write(`mcp-nlm: upstream handling failed: ${error.message}\n`);
        });
      }
      catch (error) { process.stderr.write(`mcp-nlm: invalid upstream message: ${error.message}\n`); }
    });
    child.on('error', error => this.lost(child, error.message));
    // Drain async cache writes/responses before reporting an upstream exit.
    child.on('close', (code, signal) => {
      void this.upstreamQueue.then(() => this.lost(child, `Upstream exited (${signal || code})`));
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (!firstInitialize && this.initialize && !modern(this.protocolVersion)) {
      const id = `proxy-initialize-${randomUUID()}`;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.bootstrap = null;
          reject(new Error('Upstream initialization timed out'));
          void this.stop();
        }, this.startupMs);
        this.bootstrap = { id, resolve, reject, timer };
        this.write({ ...this.initialize, id });
      });
      if (this.initialized) this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
  }

  async observe(result) {
    const next = identity(result);
    const changed = !!(next && this.backendIdentity && next !== this.backendIdentity);
    if (changed) {
      await this.cache?.invalidate();
    }
    if (next) this.backendIdentity = next;
    return changed;
  }

  async remember(request, result, lease, changed = false) {
    if (request.method === 'initialize') {
      this.protocolVersion = result.protocolVersion;
      this.initializeResult = result;
    }
    if (lease && changed && ['initialize', 'server/discover'].includes(request.method)) {
      lease = { ...lease, revision: (await this.cache.read(lease.cacheSlot, request.method)).revision };
    }
    if (lease) await this.cache?.put(lease.cacheSlot, request.method, result, lease.revision, this.backendIdentity);
  }

  async upstream(message) {
    if (message.method === 'ping') {
      if (Object.hasOwn(message, 'id')) this.write(modern(this.protocolVersion)
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'ping is not part of modern MCP' } }
        : { jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (!message.method && this.cancelled.has(key(message.id))) { this.cancelled.delete(key(message.id)); return; }
    if (message.method === 'notifications/cancelled' && modern(this.protocolVersion)) this.cancel(message.params?.requestId);
    if (/^notifications\/(?:tools|prompts|resources)\/list_changed$/.test(message.method || '')) await this.cache?.invalidate();
    const changed = await this.observe(message.result || message.params);
    if (!message.method && this.internalIds.has(key(message.id))) {
      this.internalIds.delete(key(message.id));
      this.refreshes.get(key(message.id))?.(message);
      return;
    }
    if (this.bootstrap && message.id === this.bootstrap.id && !message.method) {
      const { resolve, reject, timer } = this.bootstrap;
      if (message.error) reject(new Error(message.error.message));
      else {
        const previous = this.initializeResult;
        if (previous && (previous.protocolVersion !== message.result?.protocolVersion || canonical(previous.capabilities) !== canonical(message.result?.capabilities))) {
          await this.cache?.invalidate();
          reject(new Error('Upstream protocol or capabilities changed; reconnect the MCP client'));
          void this.stop();
        } else {
          const cacheSlot = slot('initialize', this.sessionContract, this.initialize.params);
          const cached = await this.cache?.read(cacheSlot, 'initialize');
          await this.remember(this.initialize, message.result, cached && { cacheSlot, revision: cached.revision });
          resolve();
        }
      }
      clearTimeout(timer);
      this.bootstrap = null;
      return;
    }
    const request = this.requests.get(key(message.id));
    if (request && !message.method && message.result) await this.remember(request, message.result, this.cacheRequests.get(key(message.id)), changed);
    if (!message.method) this.cacheRequests.delete(key(message.id));
    if (!message.method && request?.method === 'tools/call'
        && request.params?.name !== 'refresh_auth' && authFailure(message.result)) {
      void this.recover(message, request);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      if (message.method) this.serverPending.add(key(message.id));
      else { this.pending.delete(key(message.id)); this.requests.delete(key(message.id)); }
    }
    this.emit(message);
    this.arm();
  }

  cancel(id) {
    if (!this.pending.has(key(id))) return;
    this.pending.delete(key(id));
    this.requests.delete(key(id));
    this.cacheRequests.delete(key(id));
    this.cancelled.add(key(id));
  }

  async recover(message, request) {
    const profile = request.params?.arguments?.profile;
    const group = typeof profile === 'string' ? profile : '';
    this.recoveries ??= new Map();
    if (!this.recoveries.has(group)) {
      const refresh = new Promise(resolve => {
        const id = `proxy-refresh-${randomUUID()}`;
        const finish = response => {
          clearTimeout(timer);
          this.refreshes.delete(key(id));
          resolve(response);
        };
        const timer = setTimeout(() => finish(null), this.startupMs);
        this.refreshes.set(key(id), finish);
        this.internalIds.add(key(id));
        try {
          this.write({ jsonrpc: '2.0', id, method: 'tools/call', params: {
            name: 'refresh_auth', arguments: group ? { profile: group } : {},
            ...(request.params?._meta ? { _meta: request.params._meta } : {}),
          } });
        } catch { finish(null); }
      }).finally(() => this.recoveries.delete(group));
      this.recoveries.set(group, refresh);
    }
    const response = await this.recoveries.get(group);
    // A process failure already answered all outstanding client requests.
    if (!this.pending.has(key(message.id)) || this.closed) return;
    let data = response?.result?.structuredContent;
    if (!data) {
      try { data = JSON.parse(response?.result?.content?.find(item => item.type === 'text')?.text); } catch {}
    }
    const recovered = !response?.error && !response?.result?.isError && data?.status === 'success';
    const text = recovered
      ? 'Proxy: authentication was refreshed successfully. The original operation was not retried. Retry it if still needed; interactive login is not required.'
      : 'Proxy: one authentication refresh attempt failed or timed out. The original operation was not retried. Interactive nlm login may be required.';
    this.emit({ ...message, result: { ...message.result, content: [...(message.result.content || []), { type: 'text', text }] } });
    this.pending.delete(key(message.id));
    this.requests.delete(key(message.id));
    this.arm();
  }

  lost(child, reason) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.timer);
    if (this.bootstrap) {
      clearTimeout(this.bootstrap.timer);
      this.bootstrap.reject(new Error(reason));
      this.bootstrap = null;
    }
    for (const id of this.pending) this.emit({ jsonrpc: '2.0', id: JSON.parse(id), error: { code: -32603, message: reason } });
    this.pending.clear();
    this.requests.clear();
    this.cacheRequests.clear();
    for (const finish of this.refreshes.values()) finish(null);
    this.internalIds.clear();
    this.serverPending.clear();
    this.cancelled.clear();
  }

  arm() {
    clearTimeout(this.timer);
    if (!this.closed && this.child && !this.pending.size && !this.serverPending.size && !this.queued && !this.bootstrap) {
      this.idleDeadline ??= Date.now() + this.delay;
      this.timer = setTimeout(() => {
        if (!this.pending.size && !this.serverPending.size && !this.queued && !this.bootstrap) void this.stop();
      }, Math.max(0, this.idleDeadline - Date.now()));
      this.timer.unref();
    }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    clearTimeout(this.timer);
    this.stopping = new Promise(resolve => {
      const kill = () => {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill('SIGKILL');
      };
      const timer = setTimeout(kill, 3000);
      child.once('close', () => {
        clearTimeout(timer);
        void this.upstreamQueue.then(resolve);
      });
      child.stdin.end();
    });
    try { await this.stopping; } finally { this.stopping = null; }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.stop();
  }
}
