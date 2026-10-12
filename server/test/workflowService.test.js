const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { WorkflowService, resolveConfig } = require('../lib/workflowService');

const FAKE = path.join(__dirname, 'fakeArHelper.js');
// Same JSON-lines protocol as the real helper, but plain node and canned data.
const spawnFake = () => spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
const READY = { ready: true, java: 'java', libDir: '/x', javaMajor: 8, problems: [] };
const conn = { id: 'c1', username: 'u', password: 'pw', arPort: 46000 };

const make = (opts = {}) => new WorkflowService({ config: READY, spawnFn: spawnFake, idleMs: 60000, ...opts });

test('describes an object with resolved field names across the forms it references', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  const d = await svc.describe(conn, 'filter', 'HPD:INC:ResolveStatus_100');
  assert.equal(d.runIf, `'Status' = 4 AND 'Short Description' != $NULL$`);
  assert.deepEqual(d.executeOn, ['Modify', 'Submit']);
  assert.equal(d.application, 'Remedy Change Management');
  assert.equal(d.actions[0].label, `Set Fields from 'CTM:Support Group'`);
  assert.equal(
    d.actions[0].lines[0],
    `'Company' = 'CTM:Support Group'.'Company' WHERE 'Support Group Name' = $Short Description$`
  );
  assert.equal(d.actions[1].label, 'Message — Error #1291409');
  assert.ok(d.raw && d.raw.name === 'HPD:INC:ResolveStatus_100', 'raw definition is included for single objects');
});

test('lists a form\'s workflow by kind and searches names across the server', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  const w = await svc.formWorkflow(conn, 'HPD:Help Desk');
  assert.deepEqual(w.filters, ['HPD:INC:ResolveStatus_100']);
  assert.deepEqual(w.escalations, []);
  const s = await svc.search(conn, 'filter', 'validate');
  assert.deepEqual(s, { total: 2, matched: 1, names: ['CTM:SG:Validate'] });
});

test('batch description reports per-object failures instead of failing the batch', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  const r = await svc.describeMany(conn, 'filter', ['HPD:INC:ResolveStatus_100', 'Nope']);
  assert.ok(r[0].summary && !r[0].summary.raw);
  assert.match(r[1].error, /does not exist/);
  await assert.rejects(svc.describe(conn, 'filter', 'Nope'), (e) => e.status === 404);
  await assert.rejects(svc.describeMany(conn, 'filter', Array(51).fill('x')), (e) => e.status === 400);
  await assert.rejects(svc.describeMany(conn, 'widget', ['x']), (e) => e.status === 400);
});

test('login failure is a 502 that names the endpoint and mentions the gateway', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  await assert.rejects(svc.forms({ ...conn, password: 'bad', arHost: '127.0.0.1' }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /127\.0\.0\.1:46000/);
    assert.match(e.message, /Authentication failed/);
    assert.match(e.message, /Client Gateway/);
    return true;
  });
  assert.equal(svc.sessions.size, 0, 'a failed login must not leave a dead session behind');
});

test('missing AR port and unusable Java config give actionable 400s', async () => {
  await assert.rejects(make().forms({ ...conn, arPort: null }), (e) => e.status === 400 && /port/.test(e.message));
  const notReady = make({ config: { ...READY, ready: false, problems: ['Java was not found.'] } });
  await assert.rejects(notReady.forms(conn), (e) => e.status === 400 && /Java was not found/.test(e.message));
});

test('a crashed helper is replaced on the next request', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  await svc.forms(conn);
  const first = svc.sessions.get('c1').proc;
  first.child.kill('SIGKILL');
  await new Promise((r) => first.child.once('exit', r));
  assert.deepEqual(await svc.formWorkflow(conn, 'HPD:Help Desk').then((w) => w.form), 'HPD:Help Desk');
  assert.notEqual(svc.sessions.get('c1').proc, first);
});

test('results are cached per connection (one helper round trip)', async (t) => {
  const svc = make();
  t.after(() => svc.closeAll());
  const proc = (await svc._session(conn)).proc;
  let calls = 0;
  const orig = proc.request.bind(proc);
  proc.request = (cmd, ...rest) => { if (cmd === 'listForms') calls++; return orig(cmd, ...rest); };
  await svc.forms(conn);
  await svc.forms(conn);
  assert.equal(calls, 1);
});

test('resolveConfig reports what is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-lib-'));
  try {
    let c = resolveConfig({ env: {}, dataDir: dir, checkJava: false });
    assert.equal(c.ready, false);
    assert.match(c.problems[0], /HELIX_AR_LIB/);
    c = resolveConfig({ env: { HELIX_AR_LIB: dir }, dataDir: dir, checkJava: false });
    assert.match(c.problems[0], /No arapi/);
    fs.writeFileSync(path.join(dir, 'arapi990.jar'), '');
    c = resolveConfig({ env: { HELIX_AR_LIB: dir }, dataDir: dir, checkJava: false });
    assert.equal(c.ready, true);
    // a workflow.json in the data dir works too (what the desktop app will write)
    fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({ libDir: dir }));
    c = resolveConfig({ env: {}, dataDir: dir, checkJava: false });
    assert.equal(c.ready, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findApiLibDir accepts the lib folder, a parent, or the jar itself', () => {
  const { findApiLibDir } = require('../lib/workflowService');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-kit-'));
  try {
    const lib = path.join(root, 'x64', 'plugins', 'com.bmc.arsys.studio.api_25.4.1.build001', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'arapi990.jar'), '');
    fs.mkdirSync(path.join(root, 'x64', 'plugins', 'other.plugin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'x64', 'plugins', 'other.plugin', 'lib', 'unrelated.jar'), '');

    assert.equal(findApiLibDir(lib), lib);
    assert.equal(findApiLibDir(path.join(lib, 'arapi990.jar')), lib);
    assert.equal(findApiLibDir(root), lib, 'searches down from the kit folder');
    assert.equal(findApiLibDir(path.join(root, 'nope')), null);
    assert.equal(findApiLibDir(''), null);
    assert.equal(findApiLibDir(path.join(root, 'x64', 'plugins', 'other.plugin')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
