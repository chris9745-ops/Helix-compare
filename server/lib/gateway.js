/**
 * Starts, stops and reports on the BMC Helix Client Gateway (Kaazing KWIC) from inside the app, so
 * nobody needs a terminal to use the Workflow, Form layout and Recent changes pages.
 *
 * The gateway is BMC's software and config (which carries BMC tokens): this module only runs it.
 * It never returns config contents — only service names and the local ports they listen on.
 *
 * Three situations are told apart:
 *   running   the app started it (or adopted one it started before a restart)
 *   external  something is listening on its ports that this app did not start — typically a terminal.
 *             Starting would fail on the ports, and stopping isn't ours to do; the user is told where.
 *   stopped   nothing listening.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { readSettings, writeSettings } = require('./workflowService');

const LOG_LINES = 400;
const MAIN_CLASS = 'org.kaazing.gateway.server.Main';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── config + folder discovery ────────────────────────────────────────────────

/**
 * Local ports the gateway listens on, read from its kwic-config.xml: `<accept>tcp://${gateway.ip}:${port.x}`
 * with the `${…}` placeholders resolved from the config's own <property> entries. Only names and ports
 * are returned; no other value from the file ever leaves this function.
 */
function parseGatewayConfig(xml) {
  const props = {};
  // names may carry attributes, e.g. <name desc="Local client gateway port">port.dev-arapi</name>
  for (const m of String(xml).matchAll(/<property>\s*<name(?:\s[^>]*)?>\s*([^<]+?)\s*<\/name>\s*<value(?:\s[^>]*)?>\s*([^<]*?)\s*<\/value>\s*<\/property>/g)) {
    props[m[1]] = m[2];
  }
  const resolve = (s) => s.replace(/\$\{([^}]+)\}/g, (all, k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : all));
  const services = [];
  for (const sm of String(xml).matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    const body = sm[1];
    const name = ((/<name(?:\s[^>]*)?>\s*([^<]*?)\s*<\/name>/.exec(body) || [])[1] || '').trim();
    for (const a of body.matchAll(/<accept>\s*([^<]*?)\s*<\/accept>/g)) {
      const m = /^tcp:\/\/([^:/]+):(\d{1,5})(?:\/|$)/.exec(resolve(a[1]));
      if (m) services.push({ name: name || `port ${m[2]}`, host: m[1], port: Number(m[2]) });
    }
  }
  return services;
}

/** The folder that holds conf/kwic-config.xml and lib/ — given it, its parent, or a kwic-* child. */
function findGatewayHome(input) {
  const raw = String(input || '').trim().replace(/^~(?=$|[\\/])/, process.env.HOME || '~');
  if (!raw || !fs.existsSync(raw)) return null;
  const ok = (d) => fs.existsSync(path.join(d, 'conf', 'kwic-config.xml')) && fs.existsSync(path.join(d, 'lib'));
  const candidates = [raw, path.join(raw, 'kwic')];
  try {
    for (const e of fs.readdirSync(raw, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^kwic/i.test(e.name)) continue;
      candidates.push(path.join(raw, e.name), path.join(raw, e.name, e.name));
    }
  } catch { /* unreadable */ }
  return candidates.find(ok) || null;
}

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function processLooksLikeGateway(pid) {
  if (process.platform === 'win32') return false;      // no portable check; don't adopt blindly
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).includes(MAIN_CLASS);
  } catch { return false; }
}

// ── manager ──────────────────────────────────────────────────────────────────

class GatewayManager {
  /**
   * dataDir      app data directory (settings live in workflow.json there; the default gateway folder is
   *              a sibling named `gateway`)
   * javaPath()   which java to run
   * spawnFn/probe  injectable for tests
   */
  constructor({ dataDir, javaPath = () => 'java', spawnFn = spawn, probe = tcpProbe, startTimeoutMs = 40000, stopTimeoutMs = 8000, env = process.env } = {}) {
    this.dataDir = dataDir;
    this.javaPath = javaPath;
    this.spawnFn = spawnFn;
    this.probe = probe;
    this.startTimeoutMs = startTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.env = env;
    this.child = null;
    this.adoptedPid = null;
    this.startedAt = null;
    this.logBuf = [];
    this.stopping = false;
    this.hooked = false;
  }

  // -- configuration --------------------------------------------------------

  settings() { return readSettings(this.dataDir); }

  /** { dir, source } or null when no gateway folder can be found. */
  home() {
    const s = this.settings();
    const tries = [
      [this.env.HELIX_GATEWAY_DIR, 'environment'],
      [s.gatewayDir, 'settings'],
      [path.join(path.dirname(this.dataDir), 'gateway'), 'default']
    ];
    for (const [value, source] of tries) {
      if (!value) continue;
      const dir = findGatewayHome(value);
      if (dir) return { dir, source };
    }
    return null;
  }

  saveSettings({ gatewayDir, autoStart }) {
    const patch = {};
    if (gatewayDir !== undefined) {
      const raw = String(gatewayDir).trim();
      if (raw) {
        const dir = findGatewayHome(raw);
        if (!dir) {
          throw httpError(400, `No gateway was found at "${raw}". Pick the folder that contains conf/kwic-config.xml and lib (the BMC Client Gateway / Kaazing KWIC folder).`);
        }
        patch.gatewayDir = dir;
      } else patch.gatewayDir = '';
    }
    if (autoStart !== undefined) patch.gatewayAutoStart = !!autoStart;
    writeSettings(this.dataDir, patch);
  }

  // -- state ----------------------------------------------------------------

  _services(home) {
    try {
      return parseGatewayConfig(fs.readFileSync(path.join(home.dir, 'conf', 'kwic-config.xml'), 'utf8'));
    } catch { return []; }
  }

  _pidFile() { return path.join(this.dataDir, 'gateway.pid'); }

  _adopt() {
    if (this.child || this.adoptedPid) return;
    try {
      const pid = parseInt(fs.readFileSync(this._pidFile(), 'utf8'), 10);
      if (pid > 0 && processLooksLikeGateway(pid)) this.adoptedPid = pid;
      else fs.rmSync(this._pidFile(), { force: true });
    } catch { /* no pid file */ }
  }

  _ours() {
    return (this.child && this.child.exitCode === null && !this.child.killed) || !!this.adoptedPid;
  }

  async status() {
    this._adopt();
    const home = this.home();
    const settings = this.settings();
    const base = {
      dir: home ? home.dir : null, source: home ? home.source : null,
      autoStart: !!settings.gatewayAutoStart, problems: [], services: [], pid: null, startedAt: null
    };
    if (!home) {
      return {
        ...base, state: 'unconfigured',
        problems: ['No Client Gateway folder was found. Choose the folder that holds conf/kwic-config.xml and lib.']
      };
    }
    const services = this._services(home);
    if (!services.length) base.problems.push('No local ports could be read from the gateway configuration.');
    const withState = await Promise.all(services.map(async (s) => ({ ...s, listening: await this.probe(s.port, s.host === 'localhost' ? '127.0.0.1' : s.host) })));
    const anyUp = withState.some((s) => s.listening);
    let state;
    if (this.stopping) state = 'stopping';
    else if (this._ours()) state = anyUp ? 'running' : 'starting';
    else state = anyUp ? 'external' : 'stopped';
    return {
      ...base, state, services: withState,
      pid: this.child ? this.child.pid : this.adoptedPid,
      startedAt: this._ours() && this.startedAt ? this.startedAt.toISOString() : null
    };
  }

  log(lines = 100) { return this.logBuf.slice(-Math.max(1, Math.min(lines, LOG_LINES))); }

  _push(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) this.logBuf.push(line.slice(0, 500));
    }
    if (this.logBuf.length > LOG_LINES) this.logBuf.splice(0, this.logBuf.length - LOG_LINES);
  }

  // -- control --------------------------------------------------------------

  async start() {
    const home = this.home();
    if (!home) throw httpError(400, 'No Client Gateway folder was found. Choose the folder that holds conf/kwic-config.xml and lib.');
    const before = await this.status();
    if (before.state === 'running' || before.state === 'starting') return before;
    if (before.state === 'external') {
      throw httpError(409,
        'A gateway is already running on this computer (started outside this app, probably in a terminal). ' +
        'You can use it as it is, or stop it where you started it and then start it here.');
    }
    if (!before.services.length) throw httpError(400, 'The gateway configuration has no local ports to listen on.');

    // The gateway insists on these folders existing, and removes `temp` when it shuts down — so they
    // have to be (re)created before every start rather than assumed to be there.
    const bin = path.join(home.dir, 'bin');
    for (const d of ['bin', 'temp', 'log']) fs.mkdirSync(path.join(home.dir, d), { recursive: true });
    const sep = process.platform === 'win32' ? ';' : ':';
    const args = [
      '-Xmx512m',
      '-DGATEWAY_CONFIG=../conf/kwic-config.xml',
      '-Dcom.kaazing.kwic.logging=on',
      '-cp', `../lib/*${sep}../lib/ext/*`,
      MAIN_CLASS
    ];
    this.logBuf = [];
    this._push(`[app] starting gateway from ${home.dir}`);
    const child = this.spawnFn(this.javaPath(), args, { cwd: bin, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.adoptedPid = null;
    this.startedAt = new Date();
    this._hookExit();
    child.stdout.on('data', (d) => this._push(d));
    child.stderr.on('data', (d) => this._push(d));

    let spawnError = null;
    child.once('error', (e) => { spawnError = e; this._push(`[app] could not start: ${e.message}`); });
    child.once('exit', (code, signal) => {
      this._push(`[app] gateway exited (${signal || `code ${code}`})`);
      if (this.child === child) this.child = null;
      this.stopping = false;
      fs.rmSync(this._pidFile(), { force: true });
    });
    if (child.pid) {
      try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(this._pidFile(), String(child.pid), { mode: 0o600 }); } catch { /* best effort */ }
    }

    const deadline = Date.now() + this.startTimeoutMs;
    let firstUpAt = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      if (spawnError) {
        this.child = null;
        const hint = spawnError.code === 'ENOENT' ? ' Java was not found — set its path under Setup.' : '';
        throw httpError(400, `The gateway could not be started: ${spawnError.message}.${hint}`);
      }
      if (child.exitCode !== null || child.signalCode) {
        const tail = this.log(8).filter((l) => !l.startsWith('[app]')).join('\n');
        throw httpError(500, `The gateway stopped right after starting${tail ? `:\n${tail}` : '.'}`);
      }
      const s = await this.status();
      const up = s.services.filter((x) => x.listening).length;
      if (up > 0 && firstUpAt === null) firstUpAt = Date.now();
      // ports open one after another: wait for all of them, but don't hold the request open for a
      // port that never comes (a few seconds after the first is plenty)
      if (up > 0 && (up === s.services.length || Date.now() - firstUpAt > 3000)) return s;
      if (Date.now() > deadline) return s;          // still starting; the page keeps polling
    }
  }

  async stop() {
    this._adopt();
    const s = await this.status();
    if (s.state === 'unconfigured') throw httpError(400, 'No Client Gateway folder was found.');
    if (!this._ours()) {
      if (s.state === 'external') {
        throw httpError(409, 'This gateway was started outside the app (probably in a terminal), so it has to be stopped there — press Ctrl-C in that window.');
      }
      return s;                                     // already stopped
    }
    this.stopping = true;
    const pid = this.child ? this.child.pid : this.adoptedPid;
    const exited = this.child
      ? new Promise((resolve) => this.child.once('exit', resolve))
      : new Promise((resolve) => {
        const t = setInterval(() => { try { process.kill(pid, 0); } catch { clearInterval(t); resolve(); } }, 200);
      });
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    const killer = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, this.stopTimeoutMs);
    await Promise.race([exited, new Promise((r) => setTimeout(r, this.stopTimeoutMs + 3000))]);
    clearTimeout(killer);
    this.stopping = false;
    this.child = null;
    this.adoptedPid = null;
    fs.rmSync(this._pidFile(), { force: true });
    this._push('[app] gateway stopped');
    return this.status();
  }

  /** Start on launch when the user asked for it. Never throws. */
  async autoStartIfConfigured() {
    try {
      if (!this.settings().gatewayAutoStart) return null;
      const s = await this.status();
      if (s.state !== 'stopped') return s;
      return await this.start();
    } catch (e) {
      this._push(`[app] auto-start failed: ${e.message}`);
      return null;
    }
  }

  killNow() {
    try { if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM'); } catch { /* ignore */ }
    try { fs.rmSync(this._pidFile(), { force: true }); } catch { /* ignore */ }
  }

  /** The gateway must not outlive the app that started it (it would hold the ports and be unmanaged). */
  _hookExit() {
    if (this.hooked) return;
    this.hooked = true;
    process.once('exit', () => this.killNow());
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => { this.killNow(); process.exit(sig === 'SIGINT' ? 130 : 143); });
    }
    process.once('SIGUSR2', () => { this.killNow(); process.kill(process.pid, 'SIGUSR2'); });   // nodemon restart
  }
}

let shared = null;
module.exports = {
  GatewayManager, parseGatewayConfig, findGatewayHome, tcpProbe,
  getGateway() {
    if (!shared) {
      const dataDir = process.env.HELIX_DATA_DIR || path.join(__dirname, '../data');
      const { resolveConfig } = require('./workflowService');
      shared = new GatewayManager({ dataDir, javaPath: () => resolveConfig({ checkJava: false }).java });
    }
    return shared;
  },
  setGateway(g) { shared = g; }                    // tests
};
