/**
 * Workflow (Active Link / Filter / Escalation) access through the native AR API.
 *
 * REST can't see workflow objects, so this drives workflow-helper/ar-helper.js — a small
 * read-only process on the JDK's built-in Nashorn engine that speaks the AR API (arapi jar from
 * the user's own Developer Studio kit) over a BMC Helix Client Gateway on 127.0.0.1.
 *
 * One helper process per connection, started on demand and closed after being idle. Desktop /
 * local mode only: the gateway lives on the user's machine, which a Netlify function can't reach.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { describeObject, referencedForms } = require('./arRender');

const KINDS = ['activeLink', 'filter', 'escalation'];
const REQUEST_TIMEOUT_MS = 180000;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const NAMES_TTL_MS = 60 * 1000;
const FIELDS_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH = 50;
const BULK_CHUNK = 100;

// In the packaged app the script must live outside app.asar so a real `java` can read it.
const HELPER_SCRIPT = path.join(__dirname, '../../workflow-helper/ar-helper.js')
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── configuration ────────────────────────────────────────────────────────────────────────────
function readSettings(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'workflow.json'), 'utf8')); } catch { return {}; }
}

function javaMajor(javaPath) {
  const r = spawnSync(javaPath, ['-version'], { encoding: 'utf8', timeout: 8000 });
  if (r.error) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr || ''}${r.stdout || ''}`);
  if (!m) return null;
  return m[1] === '1' ? parseInt(m[2], 10) : parseInt(m[1], 10);   // 1.8 -> 8
}

/** Where Java and the arapi jars are, and whether that's usable. Never throws. */
function resolveConfig({ env = process.env, dataDir = env.HELIX_DATA_DIR || path.join(__dirname, '../data'), checkJava = true } = {}) {
  const settings = readSettings(dataDir);
  const libDir = (env.HELIX_AR_LIB || settings.libDir || '').trim();
  const java = (env.HELIX_JAVA || settings.javaPath || (env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java')).trim();
  const problems = [];

  if (!libDir) {
    problems.push('The AR API jar folder is not set. Point HELIX_AR_LIB (or workflow.json "libDir") at the folder holding arapi*.jar from your Developer Studio kit.');
  } else if (!fs.existsSync(libDir)) {
    problems.push(`The AR API jar folder does not exist: ${libDir}`);
  } else if (!fs.readdirSync(libDir).some((f) => /^arapi.*\.jar$/i.test(f))) {
    problems.push(`No arapi*.jar found in ${libDir}`);
  }

  let major = null;
  if (checkJava) {
    major = javaMajor(java);
    if (major === null) problems.push(`Java was not found (tried "${java}"). Install a Java 8–14 runtime.`);
    else if (major > 14) problems.push(`Java ${major} has no Nashorn engine (removed in 15). Use a Java 8–14 runtime via HELIX_JAVA.`);
  }
  return { java, libDir, javaMajor: major, problems, ready: problems.length === 0 };
}

// ── one helper process ───────────────────────────────────────────────────────────────────────
class HelperProcess {
  constructor({ command, args, spawnFn = spawn }) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = '';
    this.exited = false;
    this.child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (e) => this._fail(new Error(`Could not start Java helper: ${e.message}`)));
    this.child.on('exit', (code) => this._fail(new Error(
      `The workflow helper stopped (exit ${code})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ''}`)));
    this.child.stderr.on('data', (d) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }   // stray JVM output
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error || 'Helper request failed'), { arMessageNumber: msg.messageNumber }));
    });
  }

  _fail(err) {
    this.exited = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  request(cmd, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error('The workflow helper is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The workflow helper did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  close() {
    if (this.exited) return;
    try { this.child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'exit' })}\n`); } catch { /* gone */ }
    setTimeout(() => { if (!this.exited) this.child.kill(); }, 2000).unref();
  }
}

// ── the service ──────────────────────────────────────────────────────────────────────────────
class WorkflowService {
  constructor({ config, spawnFn, idleMs = IDLE_CLOSE_MS } = {}) {
    this.config = config || resolveConfig();
    this.spawnFn = spawnFn;
    this.idleMs = idleMs;
    this.sessions = new Map();   // connectionId -> { proc, conn, cache, timer }
  }

  status() {
    const { java, libDir, javaMajor: major, problems, ready } = this.config;
    return { ready, java, libDir, javaMajor: major, problems };
  }

  _command() {
    const { java, libDir } = this.config;
    return {
      command: java,
      args: ['-cp', `${path.join(libDir, '*')}`, 'jdk.nashorn.tools.Shell', HELPER_SCRIPT, '--']
    };
  }

  _touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.close(entry.connId), this.idleMs);
    entry.timer.unref();
  }

  async _session(conn) {
    const existing = this.sessions.get(conn.id);
    if (existing && !existing.proc.exited) {
      this._touch(existing);
      return existing;
    }
    if (!this.config.ready) throw httpError(400, this.config.problems.join(' '));
    if (!conn.arPort) {
      throw httpError(400, 'Set the AR server port for this connection first (the Client Gateway port, e.g. 46000 for Dev).');
    }
    const { command, args } = this._command();
    const proc = new HelperProcess({ command, args, spawnFn: this.spawnFn });
    const entry = { connId: conn.id, proc, cache: new Map(), timer: null };
    this.sessions.set(conn.id, entry);
    try {
      await proc.request('connect', {
        host: conn.arHost || '127.0.0.1', port: conn.arPort,
        user: conn.username, password: conn.password, authString: conn.authString || undefined
      }, 60000);
    } catch (e) {
      this.close(conn.id);
      e.status = 502;
      e.message = `Could not log in to the AR server at ${conn.arHost || '127.0.0.1'}:${conn.arPort} — ${e.message}. Is the Client Gateway running?`;
      throw e;
    }
    this._touch(entry);
    return entry;
  }

  async _request(conn, cmd, payload, timeoutMs) {
    const entry = await this._session(conn);
    try {
      return await entry.proc.request(cmd, payload, timeoutMs);
    } catch (e) {
      if (entry.proc.exited) this.sessions.delete(conn.id);
      // ARERR 366 = no such active link/filter/escalation, 303 = no such form
      const missing = [303, 366].includes(e.arMessageNumber) || /does not exist/i.test(e.message);
      if (!e.status) e.status = missing ? 404 : 502;
      throw e;
    }
  }

  async _cached(conn, key, ttl, load) {
    const entry = await this._session(conn);
    const hit = entry.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await load();
    entry.cache.set(key, { at: Date.now(), value });
    return value;
  }

  forms(conn) {
    return this._cached(conn, 'forms', FIELDS_TTL_MS, () => this._request(conn, 'listForms'));
  }

  /** Names of one form's active links, filters and escalations. */
  async formWorkflow(conn, form) {
    const names = (kind) => this._cached(conn, `names:${kind}:${form}`, NAMES_TTL_MS,
      () => this._request(conn, 'listWorkflow', { kind, form }));
    const [activeLinks, filters, escalations] = await Promise.all(KINDS.map(names));
    return { form, activeLinks, filters, escalations };
  }

  /** Every object name of a kind on the server (cached). */
  allNames(conn, kind) {
    this._kind(kind);
    return this._cached(conn, `all:${kind}`, FIELDS_TTL_MS,
      () => this._request(conn, 'listWorkflow', { kind }, REQUEST_TIMEOUT_MS));
  }

  /**
   * Full raw definitions as Map name -> definition. `scope` is { form } (everything attached to
   * a form, one round trip) or { names } (fetched in chunks).
   */
  async fetchObjects(conn, kind, scope) {
    this._kind(kind);
    const out = new Map();
    const add = (list) => { for (const o of list || []) out.set(o.name, o); };
    if (scope.form) {
      add(await this._request(conn, 'getObjectsBulk', { kind, form: scope.form }, REQUEST_TIMEOUT_MS));
    } else {
      const names = scope.names || [];
      for (let i = 0; i < names.length; i += BULK_CHUNK) {
        add(await this._request(conn, 'getObjectsBulk', { kind, names: names.slice(i, i + BULK_CHUNK) }, REQUEST_TIMEOUT_MS));
      }
    }
    return out;
  }

  /** Case-insensitive substring search across every object name of a kind. */
  async search(conn, kind, q, limit = 200) {
    const all = await this.allNames(conn, kind);
    const needle = String(q || '').toLowerCase();
    const hits = needle ? all.filter((n) => n.toLowerCase().includes(needle)) : all;
    return { total: all.length, matched: hits.length, names: hits.slice(0, limit) };
  }

  _kind(kind) {
    if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  }

  async _fieldMap(conn, form) {
    const list = await this._cached(conn, `fields:${form}`, FIELDS_TTL_MS, async () => {
      try { return await this._request(conn, 'getFields', { form }); } catch { return []; }
    });
    return new Map(list.map((f) => [f.id, f.name]));
  }

  /** Readable description (+ raw definition) of one workflow object. */
  async describe(conn, kind, name, { includeRaw = true } = {}) {
    this._kind(kind);
    const raw = await this._request(conn, 'getObject', { kind, name });
    const maps = new Map();
    for (const form of referencedForms(raw)) maps.set(form, await this._fieldMap(conn, form));
    const description = describeObject(kind, raw, { fields: (form, id) => (maps.get(form) || new Map()).get(id) || null });
    return includeRaw ? { ...description, raw } : description;
  }

  /** Several objects at once (for a list pane). Failures are reported per object. */
  async describeMany(conn, kind, names) {
    this._kind(kind);
    if (!Array.isArray(names) || !names.length) throw httpError(400, 'names must be a non-empty array');
    if (names.length > MAX_BATCH) throw httpError(400, `At most ${MAX_BATCH} objects per request`);
    const out = [];
    for (const name of names) {
      try { out.push({ name, summary: await this.describe(conn, kind, name, { includeRaw: false }) }); }
      catch (e) { out.push({ name, error: e.message }); }
    }
    return out;
  }

  close(connId) {
    const entry = this.sessions.get(connId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.sessions.delete(connId);
    entry.proc.close();
  }

  closeAll() { [...this.sessions.keys()].forEach((id) => this.close(id)); }
}

let shared = null;
module.exports = {
  WorkflowService, HelperProcess, resolveConfig, KINDS, MAX_BATCH,
  getService() { if (!shared) shared = new WorkflowService(); return shared; },
  setService(svc) { shared = svc; }          // tests
};
