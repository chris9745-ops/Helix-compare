/*
 * ar-helper.js — read-only BMC AR System workflow helper.
 *
 * Runs on the JDK's built-in Nashorn engine (Java 8–14), so no compiler is needed:
 *
 *   java -cp "<arapi lib dir>/*" jdk.nashorn.tools.Shell ar-helper.js -- [options]
 *
 * It speaks the native AR API (the arapi jar from a Developer Studio kit) — usually through a BMC
 * Helix Client Gateway on 127.0.0.1 — and exposes a small JSON-lines protocol:
 *
 *   stdin  : one JSON request per line   {"id":1,"cmd":"connect","host":"127.0.0.1","port":46000,...}
 *   stdout : one JSON response per line  {"id":1,"ok":true,"result":...} | {"id":1,"ok":false,"error":"..."}
 *
 * Options (after `--`):
 *   --spool <dir>        take requests from <dir>/req-<id>.json and answer <dir>/res-<id>.json
 *                        instead of stdin/stdout (development probing; create <dir> with mode 0700)
 *   --console-login      prompt for username/password on the controlling terminal and connect
 *                        (needs --host and --port); the password never touches a file or argv
 *   --host <h> --port <p>
 *
 * Safety: this helper is READ-ONLY. Only get and verify methods (getList..., getActiveLink...)
 * are ever invoked, and the generic `call` command refuses anything else. The password is never logged or echoed.
 */
var ARServerUser = Java.type('com.bmc.arsys.api.ARServerUser');
var JSystem = java.lang.System;
var NOARGS = Java.to([], 'java.lang.Object[]');
var PROTOCOL = 1;

// ---------------------------------------------------------------------------------------------
// Java object -> plain JSON (reflective, generic: every zero-arg public getter on an arapi model)
// ---------------------------------------------------------------------------------------------
var MAX_DEPTH = 24;

function lcfirst(s) { return s.charAt(0).toLowerCase() + s.substring(1); }

function isApiClass(cls) { return String(cls.getName()).indexOf('com.bmc.arsys.api.') === 0; }

function getterKey(name) {
  var m = /^(get|is|has)([A-Z].*)$/.exec(name);
  if (!m) return null;
  return m[1] === 'has' ? 'has' + m[2] : lcfirst(m[2]);
}

function reflect(o, cls, depth, path) {
  var res = { _type: String(cls.getSimpleName()) };
  var ms = cls.getMethods(), props = [], seenKey = {};
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i], n = String(m.getName());
    if (m.getParameterTypes().length !== 0) continue;
    if (java.lang.reflect.Modifier.isStatic(m.getModifiers())) continue;
    if (n === 'getClass' || m.getReturnType() === java.lang.Void.TYPE) continue;
    var key = getterKey(n);
    if (!key || seenKey[key]) continue;
    seenKey[key] = 1;
    props.push({ key: key, m: m });
  }
  props.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  var any = false;
  for (var j = 0; j < props.length; j++) {
    try {
      res[props[j].key] = ser(props[j].m.invoke(o, NOARGS), depth + 1, path);
      any = true;
    } catch (e) {
      /* a getter that doesn't apply to this variant (e.g. Value.intValue on a string) — omit */
    }
  }
  if (!any) res._string = String(o.toString());
  return res;
}

function ser(o, depth, path) {
  if (o === null || o === undefined) return null;
  var t = typeof o;
  if (t === 'string' || t === 'boolean') return o;
  if (t === 'number') return isFinite(o) ? o : String(o);
  if (t === 'function') return null;
  if (!Java.isJavaObject(o)) return String(o);
  if (o instanceof java.lang.Number) {
    var d = o.doubleValue();
    return isFinite(d) ? d : String(o);
  }
  if (o instanceof java.lang.Character) return String(o);
  var cls = o.getClass();
  if (cls.isArray()) {
    var len = java.lang.reflect.Array.getLength(o);
    if (cls.getComponentType() === java.lang.Byte.TYPE) return { _bytes: len };
    var arr = [];
    for (var a = 0; a < len; a++) arr.push(ser(java.lang.reflect.Array.get(o, a), depth + 1, path));
    return arr;
  }
  if (cls.isEnum()) return String(o.name());
  if (o instanceof java.util.Collection) {
    var list = [], it = o.iterator();
    while (it.hasNext()) list.push(ser(it.next(), depth + 1, path));
    return list;
  }
  if (o instanceof java.util.Map) {
    var map = {}, es = o.entrySet().iterator();
    while (es.hasNext()) {
      var e = es.next();
      map[String(e.getKey())] = ser(e.getValue(), depth + 1, path);
    }
    return map;
  }
  if (!isApiClass(cls)) return String(o.toString());
  switch (String(cls.getSimpleName())) {
    case 'QualifierInfo': return qualTree(o);
    case 'ArithmeticOrRelationalOperand': return operandTree(o);
    case 'DataType': case 'OperandType':
      var dm = /(\d+)/.exec(String(o.toString()));
      return dm ? parseInt(dm[1], 10) : String(o.toString());
    case 'Value': return { dt: ser(o.getDataType(), depth + 1, path), v: ser(o.getValue(), depth + 1, path) };
  }
  // enum-like wrappers (Keyword, DataType, ...): expose their numeric code
  try {
    var toInt = cls.getMethod('toInt');
    if (toInt.getReturnType() === java.lang.Integer.TYPE) return Number(toInt.invoke(o, NOARGS));
  } catch (noToInt) { /* ordinary model object */ }
  if (depth > MAX_DEPTH) return { _truncated: true, _type: String(cls.getSimpleName()) };
  if (path.containsKey(o)) return { _cycle: true, _type: String(cls.getSimpleName()) };
  path.put(o, true);
  try { return reflect(o, cls, depth, path); } finally { path.remove(o); }
}

/**
 * Qualifiers: {op:'and'|'or', l, r} | {op:'not', x} | {op:'rel', rel, l, r} | {op:'fromField'} | null.
 * Walked explicitly (not via reflection) so deep trees are never truncated. `rel` is an
 * AR_REL_OP_* code; operands are {t: AR_FIELD/VALUE/... type, v: id|{dt,v}|...}.
 */
function qualTree(q) {
  if (q === null || q === undefined) return null;
  var op = q.getOperation();
  if (op === 1 || op === 2) return { op: op === 1 ? 'and' : 'or', l: qualTree(q.getLeftOperand()), r: qualTree(q.getRightOperand()) };
  if (op === 3) return { op: 'not', x: qualTree(q.getNotOperand()) };
  if (op === 4) {
    var ri = q.getRelationalOperationInfo();
    return { op: 'rel', rel: ri.getOperation(), l: operandTree(ri.getLeftOperand()), r: operandTree(ri.getRightOperand()) };
  }
  if (op === 5) return { op: 'fromField' };
  return null;
}

function operandTree(o) {
  if (o === null || o === undefined) return null;
  var path = new java.util.IdentityHashMap();
  return { t: ser(o.getType(), 0, path), v: ser(o.getValue(), 1, path) };
}

function toJson(o) { return ser(o, 0, new java.util.IdentityHashMap()); }

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
function errInfo(e) {
  var ex = e && e.cause ? e.cause : e;          // reflection wraps the real exception
  var msg = '';
  try { msg = String(ex.getMessage ? ex.getMessage() : ex); } catch (x) { msg = String(ex); }
  var out = { message: msg };
  try {
    var last = ex.getLastStatus ? ex.getLastStatus() : null;
    if (last && last.size && last.size() > 0) {
      var s = last.get(0);
      out.messageNumber = s.getMessageNum();
      out.messageText = String(s.getMessageText());
      var ap = s.getAppendedText();
      if (ap) out.appendedText = String(ap);
    }
  } catch (x2) { /* no status */ }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Session + commands
// ---------------------------------------------------------------------------------------------
// (survive a dev `reload`, which re-executes this file in the same global scope)
var ctx = (typeof ctx !== 'undefined' && ctx) ? ctx : null;
var session = (typeof session !== 'undefined' && session) ? session : null;

function need() { if (!ctx) throw new Error('Not connected — send a connect request first.'); }

var READ_ONLY = /^(get|verify)[A-Za-z]*$/;

/** Invoke a server-context method by name using JSON-typed args (Nashorn can't apply() Java methods). */
function invoke(name, args) {
  var ms = ARServerUser.class.getMethods(), last = null;
  var RArray = java.lang.reflect.Array;
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (String(m.getName()) !== name) continue;
    var types = m.getParameterTypes();
    if (types.length !== args.length) continue;
    // Box into a real Java Object[] — a JS array would demote Long/Integer to doubles.
    var jargs = RArray.newInstance(java.lang.Object.class, types.length), ok = true;
    for (var j = 0; j < types.length && ok; j++) {
      var tn = String(types[j].getName()), v = args[j];
      if (v === null || v === undefined) RArray.set(jargs, j, null);
      else if (tn === 'long') RArray.set(jargs, j, new java.lang.Long(String(v)));
      else if (tn === 'int') RArray.set(jargs, j, new java.lang.Integer(String(v)));
      else if (tn === 'boolean') RArray.set(jargs, j, new java.lang.Boolean(!!v));
      else if (tn === 'java.lang.String' && typeof v === 'string') RArray.set(jargs, j, v);
      else if (tn === 'java.util.List' && Array.isArray(v)) {
        var al = new java.util.ArrayList();
        for (var q = 0; q < v.length; q++) al.add(String(v[q]));
        RArray.set(jargs, j, al);
      }
      else if (tn === '[I') RArray.set(jargs, j, Java.to(v, 'int[]'));
      else if (tn === '[Ljava.lang.String;') RArray.set(jargs, j, Java.to(v, 'java.lang.String[]'));
      else ok = false;                              // a parameter type we can't build from JSON
    }
    if (!ok) continue;
    try { return m.invoke(ctx, jargs); }
    catch (e) { last = e.cause || e; }
  }
  if (last) throw last;
  throw new Error('No ' + name + ' overload takes these ' + args.length + ' argument(s).');
}

var KINDS = {
  activeLink: { list: 'getListActiveLink', get: 'getActiveLink' },
  filter: { list: 'getListFilter', get: 'getFilter' },
  escalation: { list: 'getListEscalation', get: 'getEscalation' }
};

function toList(javaList) {
  var out = [];
  for (var i = 0; i < javaList.size(); i++) out.push(String(javaList.get(i)));
  return out;
}

function kindOf(k) {
  if (!KINDS[k]) throw new Error('Unknown workflow kind "' + k + '" (use activeLink, filter or escalation).');
  return KINDS[k];
}

var commands = {
  hello: function () {
    return {
      protocol: PROTOCOL,
      java: String(JSystem.getProperty('java.version')),
      engine: 'nashorn',
      connected: !!ctx,
      session: session
    };
  },

  connect: function (r) {
    if (!r.host || !r.port || !r.user) throw new Error('connect needs host, port and user.');
    var c = new ARServerUser();
    c.setServer(String(r.host));
    c.setPort(parseInt(r.port, 10));
    c.setUser(String(r.user));
    c.setPassword(String(r.password === undefined ? '' : r.password));
    if (r.authString) c.setAuthentication(String(r.authString));
    c.verifyUser();                              // throws on bad credentials / no gateway
    ctx = c;
    session = { host: String(r.host), port: parseInt(r.port, 10), user: String(r.user) };
    return session;
  },

  disconnect: function () {
    if (ctx) { try { ctx.logout(); } catch (e) { /* already gone */ } }
    ctx = null; session = null;
    return true;
  },

  /** Names of all workflow objects of a kind, optionally scoped to one form. */
  listWorkflow: function (r) {
    need();
    var k = kindOf(r.kind);
    var names = r.form ? ctx[k.list](String(r.form)) : ctx[k.list]();
    return toList(names);
  },

  /** One full definition, serialized generically. */
  getObject: function (r) {
    need();
    var k = kindOf(r.kind);
    return toJson(ctx[k.get](String(r.name)));
  },

  /** Several definitions in one round trip: [{name, object | error}] */
  getObjects: function (r) {
    need();
    var k = kindOf(r.kind), out = [];
    for (var i = 0; i < r.names.length; i++) {
      try { out.push({ name: r.names[i], object: toJson(ctx[k.get](String(r.names[i]))) }); }
      catch (e) { out.push({ name: r.names[i], error: errInfo(e).message }); }
    }
    return out;
  },

  /**
   * Full definitions in one round trip, for a form's workflow or a list of names. ~10x faster than
   * getObject per name; the result is the same serialization as getObject.
   */
  getObjectsBulk: function (r) {
    need();
    var method = { activeLink: 'getListActiveLinkObjects', filter: 'getListFilterObjects', escalation: 'getListEscalationObjects' }[r.kind];
    if (!method) throw new Error('Unknown workflow kind "' + r.kind + '".');
    var scope = r.form ? String(r.form) : r.names;
    if (!scope || (Array.isArray(scope) && scope.length === 0)) return [];
    // escalations only come with a (changed-since, criteria) overload
    var args = r.kind === 'escalation' ? [scope, 0, null] : [scope];
    return toJson(invoke(method, args));
  },

  /**
   * The views (VUIs) of a form: [{ id, name, locale, props }]. One getView per id; a form like
   * CTM:People has ~70 (locale and web/desktop variants).
   */
  getViews: function (r) {
    need();
    var form = String(r.form), ids = invoke('getListView', [form, 0]), out = [];
    for (var i = 0; i < ids.size(); i++) {
      var id = Number(ids.get(i));
      try {
        var v = invoke('getView', [form, id]);
        out.push({
          id: id,
          name: String(v.getName()),
          locale: v.getLocale() === null ? '' : String(v.getLocale()),
          props: toJson(v.getDisplayProperties())
        });
      } catch (e) { out.push({ id: id, name: '', locale: '', error: errInfo(e).message }); }
    }
    return out;
  },

  /**
   * Every field's display properties on ONE view: [{ id, name, dt, type, props }]. `props` is null
   * when the field isn't on that view. Property ids are AR_DPROP_* (3 = bbox, 20 = label, ...).
   */
  getFieldLayout: function (r) {
    need();
    var viewId = Number(r.viewId), list = ctx.getListFieldObjects(String(r.form)), out = [];
    for (var i = 0; i < list.size(); i++) {
      var f = list.get(i), props = null, di = f.getDisplayInstance();
      if (di) {
        var it = di.entrySet().iterator();
        while (it.hasNext()) {
          var e = it.next();
          if (Number(e.getKey()) === viewId) { props = toJson(e.getValue()); break; }
        }
      }
      var type = null;
      try { type = f.getFieldType(); } catch (x) { /* older field classes */ }
      out.push({ id: f.getFieldID(), name: String(f.getName()), dt: f.getDataType(), type: type, props: props });
    }
    return out;
  },

  /** Field id -> name/type for a form, to render qualifiers and assignments readably. */
  getFields: function (r) {
    need();
    var list = ctx.getListFieldObjects(String(r.form)), out = [];
    for (var i = 0; i < list.size(); i++) {
      var f = list.get(i);
      out.push({ id: f.getFieldID(), name: String(f.getName()), dt: f.getDataType() });
    }
    return out;
  },

  /** All forms, via getListForm (the type/hidden overloads are explored with `methods`). */
  listForms: function () {
    need();
    return toList(ctx.getListForm());
  },

  // ---- development probes (read-only by construction) ------------------------------------
  /** Method signatures on the server context (or on a named api class) matching a pattern. */
  methods: function (r) {
    var cls = r.on ? Java.type(String(r.on)).class : ARServerUser.class;
    var re = new RegExp(r.pattern || '.');
    var out = [], ms = cls.getMethods();
    for (var i = 0; i < ms.length; i++) {
      var n = String(ms[i].getName());
      if (!re.test(n)) continue;
      var t = ms[i].getParameterTypes(), s = [];
      for (var j = 0; j < t.length; j++) s.push(String(r.full ? t[j].getName() : t[j].getSimpleName()));
      out.push(n + '(' + s.join(', ') + ') -> ' + String(ms[i].getReturnType().getSimpleName()));
    }
    out.sort();
    return out;
  },

  /** Development only: re-run this script from disk, keeping the login. */
  reload: function (r) {
    var p = String(r.path || opt('--self') || '');
    if (!p) throw new Error('reload needs path (or start the helper with --self <this file>).');
    load(p);
    return 'reloaded ' + p;
  },

  /** Generic read-only invocation of a server-context method; the result is serialized. */
  call: function (r) {
    need();
    var name = String(r.method);
    if (!READ_ONLY.test(name)) throw new Error('Refused: "' + name + '" is not a read-only (get*/verify*) call.');
    var args = r.args || [];
    var res = invoke(name, args);
    var limit = r.limit || 50, js = toJson(res);
    return { total: js && js.length !== undefined ? js.length : undefined, value: js && js.length > limit ? js.slice(0, limit) : js };
  }
};

function handle(req) {
  var res = { id: req.id };
  try {
    if (!commands[req.cmd]) throw new Error('Unknown command "' + req.cmd + '".');
    res.result = commands[req.cmd](req);
    res.ok = true;
  } catch (e) {
    res.ok = false;
    var info = errInfo(e);
    res.error = info.message;
    if (info.messageNumber !== undefined) { res.messageNumber = info.messageNumber; res.messageText = info.messageText; }
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------
var ARGS = (typeof ARGS !== 'undefined') ? ARGS
  : (typeof arguments !== 'undefined') ? Array.prototype.slice.call(arguments).map(String) : [];
function opt(name) { for (var i = 0; i < ARGS.length - 1; i++) if (ARGS[i] === name) return ARGS[i + 1]; return null; }
function flag(name) { return ARGS.indexOf(name) !== -1; }

function stdioLoop() {
  var br = new java.io.BufferedReader(new java.io.InputStreamReader(JSystem['in'], 'UTF-8'));
  var line;
  while ((line = br.readLine()) !== null) {
    line = String(line).trim();
    if (!line) continue;
    var req;
    try { req = JSON.parse(line); }
    catch (e) { out({ id: null, ok: false, error: 'Request is not valid JSON.' }); continue; }
    out(handle(req));
    if (req.cmd === 'exit') break;
  }
}
function out(o) { JSystem.out.println(JSON.stringify(o)); JSystem.out.flush(); }
commands.exit = function () { commands.disconnect(); return true; };

function spoolLoop(dir) {
  var Files = java.nio.file.Files, Paths = java.nio.file.Paths, StandardCopyOption = java.nio.file.StandardCopyOption;
  var base = Paths.get(dir);
  print('Spool mode: watching ' + dir + '  (create a file named "stop" there to end)');
  var startedAt = JSystem.currentTimeMillis();
  for (;;) {
    var stop = base.resolve('stop');
    if (Files.exists(stop)) {
      var fresh = stop.toFile().lastModified() >= startedAt;
      Files['delete'](stop);
      if (fresh) { print('Stop requested - logging out and exiting.'); break; }
      print('Ignored a stale "stop" file from before this helper started.');
    }
    var files = new java.io.File(dir).listFiles();
    var names = [];
    if (files) for (var i = 0; i < files.length; i++) {
      var n = String(files[i].getName());
      if (/^req-.+\.json$/.test(n)) names.push(n);
    }
    names.sort();
    for (var k = 0; k < names.length; k++) {
      var reqPath = base.resolve(names[k]), req;
      try { req = JSON.parse(String(new java.lang.String(Files.readAllBytes(reqPath), 'UTF-8'))); }
      catch (e) { continue; }                     // half-written; pick it up on the next pass
      var res = handle(req);
      var id = names[k].replace(/^req-/, '').replace(/\.json$/, '');
      var tmp = base.resolve('res-' + id + '.tmp'), fin = base.resolve('res-' + id + '.json');
      Files.write(tmp, new java.lang.String(JSON.stringify(res)).getBytes('UTF-8'));
      Files.move(tmp, fin, StandardCopyOption.REPLACE_EXISTING);
      Files['delete'](reqPath);
    }
    java.lang.Thread.sleep(100);
  }
  commands.disconnect();
}

function consoleLogin() {
  var con = JSystem.console();
  if (!con) throw new Error('--console-login needs a real terminal.');
  var host = opt('--host') || '127.0.0.1', port = opt('--port');
  if (!port) throw new Error('--console-login needs --port.');
  print('Connecting to ' + host + ':' + port + ' (read-only helper)');
  var user = con.readLine('Helix username: ');
  var pw = new java.lang.String(con.readPassword('Helix password (not shown): '));
  var r = handle({ id: 0, cmd: 'connect', host: host, port: port, user: String(user), password: String(pw) });
  pw = null;
  if (!r.ok) throw new Error('Login failed: ' + r.error);
  print('Connected as ' + session.user + '.');
}

if (typeof MAIN_RUNNING === 'undefined') {
  MAIN_RUNNING = true;
  if (flag('--console-login')) consoleLogin();
  var spool = opt('--spool');
  if (spool) spoolLoop(spool); else stdioLoop();
}
