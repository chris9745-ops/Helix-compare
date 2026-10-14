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
const arLayout = require('./arLayout');
const { assertPasswordUsable } = require('./connectionGuard');
const defExport = require('./defExport');

const KINDS = ['activeLink', 'filter', 'escalation'];
const REQUEST_TIMEOUT_MS = 180000;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const NAMES_TTL_MS = 60 * 1000;
const FIELDS_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH = 50;
const RECENT_LIMIT = 10000;   // objects per kind; beyond this the window is too wide to be useful
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

/**
 * Accepts what a person is likely to give us — the lib folder, the kit folder above it, a path
 * to the jar itself, or the unpacked Developer Studio plugins folder — and finds the folder
 * that actually holds arapi*.jar. Returns null when none is found.
 */
function findApiLibDir(input) {
  const start = String(input || '').trim().replace(/^~(?=$|\/)/, process.env.HOME || '~');
  if (!start || !fs.existsSync(start)) return null;
  const hasJar = (d) => { try { return fs.readdirSync(d).some((f) => /^arapi.*\.jar$/i.test(f)); } catch { return false; } };
  let dir = start;
  if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  const queue = [[dir, 0]];
  let visited = 0;
  while (queue.length && visited++ < 3000) {   // cap, so pointing at ~/Downloads can't crawl the disk
    const [d, depth] = queue.shift();
    if (hasJar(d)) return d;
    if (depth >= 5) continue;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    // prefer the usual layout: …/com.bmc.arsys.studio.api_*/lib
    entries.sort((a, b) => Number(/studio\.api/.test(b.name)) - Number(/studio\.api/.test(a.name)));
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) queue.push([path.join(d, e.name), depth + 1]);
  }
  return null;
}

function writeSettings(dataDir, patch) {
  fs.mkdirSync(dataDir, { recursive: true });
  const next = { ...readSettings(dataDir), ...patch };
  for (const k of Object.keys(next)) if (!next[k]) delete next[k];
  fs.writeFileSync(path.join(dataDir, 'workflow.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
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
  const source = env.HELIX_AR_LIB ? 'environment' : settings.libDir ? 'settings' : 'unset';
  return { java, libDir, javaMajor: major, problems, ready: problems.length === 0, source, settingsFile: path.join(dataDir, 'workflow.json') };
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
    const { java, libDir, javaMajor: major, problems, ready, source, settingsFile } = this.config;
    return { ready, java, libDir, javaMajor: major, problems, source: source || 'unset', settingsFile: settingsFile || null };
  }

  /** Re-read configuration (after the settings changed); open helpers are closed so they restart cleanly. */
  reconfigure(config) {
    this.closeAll();
    this.config = config || resolveConfig();
    return this.status();
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
    assertPasswordUsable(conn);
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

  /** Raw helper output for a form's views and for one view's field display properties (cached). */
  viewsRaw(conn, form) {
    return this._cached(conn, `views:${form}`, FIELDS_TTL_MS, () => this._request(conn, 'getViews', { form }, REQUEST_TIMEOUT_MS));
  }

  fieldLayoutRaw(conn, form, viewId) {
    return this._cached(conn, `layout:${form}:${viewId}`, FIELDS_TTL_MS,
      () => this._request(conn, 'getFieldLayout', { form, viewId }, REQUEST_TIMEOUT_MS));
  }

  /**
   * Workflow objects changed since a point in time, newest first. `user` filters on who last
   * changed them; `byUser` is counted BEFORE that filter so the page can offer the other names.
   */
  async recentChanges(conn, { since, kinds, form, user }) {
    if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw httpError(400, 'A valid start date is required.');
    if (since.getTime() > Date.now()) throw httpError(400, 'The start date is in the future.');
    const wanted = (kinds && kinds.length ? kinds : KINDS).filter((k) => KINDS.includes(k));
    if (!wanted.length) throw httpError(400, `kinds must include one of: ${KINDS.join(', ')}`);
    const seconds = Math.floor(since.getTime() / 1000);
    const all = [];
    const counts = {};
    for (const kind of wanted) {
      const names = await this._request(conn, 'listWorkflow', { kind, form: form || undefined, since: seconds }, REQUEST_TIMEOUT_MS);
      if (names.length > RECENT_LIMIT) {
        throw httpError(400, `${names.length.toLocaleString()} ${kind} objects changed in that window — narrow the dates or pick a form.`);
      }
      counts[kind] = names.length;
      const defs = await this.fetchObjects(conn, kind, { names });
      for (const [name, o] of defs) {
        const forms = Array.isArray(o.formList) ? o.formList : [];
        const t = o.lastUpdateTime && Number.isFinite(o.lastUpdateTime.value) ? o.lastUpdateTime.value : 0;
        const props = o.properties || {};
        all.push({
          kind, name,
          changedAt: t ? new Date(t * 1000).toISOString() : null,
          changedBy: o.lastChangedBy || '',
          enabled: o.enable !== false,
          primaryForm: o.primaryForm || forms[0] || null,
          formCount: forms.length,
          owner: o.owner || null,
          application: props['90002'] && props['90002'].v ? String(props['90002'].v) : null
        });
      }
    }
    const byUser = {};
    for (const r of all) byUser[r.changedBy || '(unknown)'] = (byUser[r.changedBy || '(unknown)'] || 0) + 1;
    const u = String(user || '').trim().toLowerCase();
    const rows = (u ? all.filter((r) => r.changedBy.toLowerCase() === u) : all)
      .sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || '') || a.name.localeCompare(b.name));
    return { since: since.toISOString(), kinds: wanted, form: form || null, counts, byUser, rows };
  }

  /**
   * The server's own definition export for objects [{kind,name}] (already validated/sorted), in
   * files of at most PART_SIZE objects. format: 'def' | 'xml'. Read-only on the server.
   */
  async exportDefs(conn, items, format = 'def') {
    if (!['def', 'xml'].includes(format)) throw httpError(400, 'format must be "def" or "xml".');
    const parts = [];
    for (const part of defExport.chunk(items)) {
      const r = await this._request(conn, 'exportDef', { items: defExport.toHelperItems(part), format }, REQUEST_TIMEOUT_MS);
      if (!r || !r.text) throw httpError(502, 'The server returned an empty export. Check that these objects still exist.');
      parts.push({ count: part.length, text: r.text, items: part });
    }
    return parts;
  }

  /** Forms the workflow objects are attached to or refer to — what must exist on the import target. */
  async exportDependencies(conn, items) {
    const attached = new Set(), referenced = new Set();
    for (const kind of KINDS) {
      const names = items.filter((i) => i.kind === kind).map((i) => i.name);
      if (!names.length) continue;
      const defs = await this.fetchObjects(conn, kind, { names });
      for (const raw of defs.values()) {
        (raw.formList || []).forEach((f) => attached.add(f));
        referencedForms(raw).forEach((f) => referenced.add(f));
      }
    }
    for (const i of items) if (i.kind === 'form') referenced.add(i.name);
    return { attachedForms: [...attached], referencedForms: [...referenced] };
  }

  /** A form's views (base views first). */
  async layoutViews(conn, form) {
    if (!String(form || '').trim()) throw httpError(400, 'form is required');
    return arLayout.normalizeViews(await this.viewsRaw(conn, form));
  }

  /** Fields on one view, normalised for drawing and comparing. */
  async layout(conn, form, viewId) {
    if (!Number.isInteger(viewId)) throw httpError(400, 'view must be a view id');
    return arLayout.normalizeFields(await this.fieldLayoutRaw(conn, form, viewId));
  }

  /** The same view (matched by internal name) on two servers, diffed field by field. */
  async compareLayout(left, right, form, viewName) {
    if (!String(viewName || '').trim()) throw httpError(400, 'view is required');
    const [lv, rv] = await Promise.all([this.layoutViews(left, form), this.layoutViews(right, form)]);
    const l = arLayout.findViewByName(lv, viewName), r = arLayout.findViewByName(rv, viewName);
    if (!l || !r) {
      const where = !l && !r ? 'either server' : !l ? 'the left server' : 'the right server';
      throw httpError(404, `The view "${viewName}" does not exist on ${where}.`);
    }
    const [lf, rf] = await Promise.all([this.layout(left, form, l.id), this.layout(right, form, r.id)]);
    // base views that exist on one server only — a whole view added or missing matters more than its fields
    const names = (list) => new Set(list.filter((v) => v.isBase).map((v) => v.name));
    const [ln, rn] = [names(lv), names(rv)];
    const onlyOn = (list, other) => list.filter((v) => v.isBase && !other.has(v.name)).map((v) => ({ name: v.name, label: v.label }));
    return {
      view: { name: l.name, label: l.label }, leftViewId: l.id, rightViewId: r.id,
      views: { onlyLeft: onlyOn(lv, rn), onlyRight: onlyOn(rv, ln) },
      ...arLayout.compareLayouts(lf, rf)
    };
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
  WorkflowService, HelperProcess, resolveConfig, findApiLibDir, writeSettings, readSettings, javaMajor, KINDS, MAX_BATCH,
  getService() { if (!shared) shared = new WorkflowService(); return shared; },
  setService(svc) { shared = svc; }          // tests
};
