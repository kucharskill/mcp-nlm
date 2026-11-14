import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const discovery = new Set(['initialize', 'tools/list']);
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
  constructor({ command, args = [], cwd, env = process.env, discoveryMs = 60_000, idleMs = 1_800_000, startupMs = 60_000 }) {
    Object.assign(this, { command, args, cwd, env, discoveryMs, idleMs, startupMs });
    this.pending = new Set();
    this.requests = new Map();
    this.refreshes = new Map();
    this.internalIds = new Set();
    this.serverPending = new Set();
    this.delay = discoveryMs;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  connect(input, output) {
    this.output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', line => {
      clearTimeout(this.timer);
      this.queued = (this.queued || 0) + 1;
      this.queue = this.queue.then(() => this.receive(line)).catch(error => {
        process.stderr.write(`mcp-nlm: ${error.message}\n`);
      }).finally(() => { this.queued--; this.arm(); });
    });
    lines.on('close', () => { void this.close(); });
  }

  emit(message) { this.output.write(JSON.stringify(message) + '\n'); }
  write(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }

  async receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (this.closed) return;
    const request = message.method && Object.hasOwn(message, 'id');
    if (request) {
      this.delay = discovery.has(message.method) ? this.discoveryMs : this.idleMs;
      if (message.method === 'initialize') this.initialize = message;
    }
    if (message.method === 'notifications/initialized') {
      this.initialized = true;
      if (this.child) this.write(message);
      return;
    }
    // A late notification must not restart an idle server (e.g. cancellation).
    if (!request && !this.child) return;
    try {
      await this.ensureStarted(message.method === 'initialize');
      if (this.closed) return;
      if (request) {
        this.pending.add(key(message.id));
        this.requests.set(key(message.id), message);
      }
      else if (Object.hasOwn(message, 'id')) this.serverPending.delete(key(message.id));
      this.write(message);
    } catch (error) {
      if (request) this.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
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
      try { this.upstream(JSON.parse(line)); }
      catch (error) { process.stderr.write(`mcp-nlm: invalid upstream message: ${error.message}\n`); }
    });
    child.on('error', error => this.lost(child, error.message));
    child.on('exit', (code, signal) => this.lost(child, `Upstream exited (${signal || code})`));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (!firstInitialize && this.initialize) {
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

  upstream(message) {
    if (!message.method && this.internalIds.has(key(message.id))) {
      this.internalIds.delete(key(message.id));
      this.refreshes.get(key(message.id))?.(message);
      return;
    }
    if (this.bootstrap && message.id === this.bootstrap.id && !message.method) {
      const { resolve, reject, timer } = this.bootstrap;
      clearTimeout(timer);
      this.bootstrap = null;
      if (message.error) reject(new Error(message.error.message)); else resolve();
      return;
    }
    const request = this.requests.get(key(message.id));
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
    for (const finish of this.refreshes.values()) finish(null);
    this.internalIds.clear();
    this.serverPending.clear();
  }

  arm() {
    clearTimeout(this.timer);
    if (!this.closed && this.child && !this.pending.size && !this.serverPending.size && !this.queued && !this.bootstrap) {
      this.timer = setTimeout(() => { void this.stop(); }, this.delay);
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
      child.once('exit', () => { clearTimeout(timer); resolve(); });
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
