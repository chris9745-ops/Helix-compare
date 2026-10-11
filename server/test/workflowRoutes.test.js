const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-wf-test-'));
process.env.HELIX_DATA_DIR = dataDir;
delete process.env.HELIX_MODE;

const { createApp } = require('../app');
const workflow = require('../lib/workflowService');

const FAKE = path.join(__dirname, 'fakeArHelper.js');
let server, base, connId;

test.before(async () => {
  workflow.setService(new workflow.WorkflowService({
    config: { ready: true, java: 'java', libDir: '/x', javaMajor: 8, problems: [] },
    spawnFn: () => spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] })
  }));
  server = http.createServer(createApp()).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  workflow.getService().closeAll();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

test('connections store the AR endpoint (validated) and never return the password', async () => {
  const bad = await call('POST', '/api/connections', {
    name: 'Dev', baseUrl: 'http://localhost:8008', username: 'u', password: 'p', arPort: 99999
  });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/connections', {
    name: 'Dev', baseUrl: 'http://localhost:8008', username: 'u', password: 'p', arHost: '127.0.0.1', arPort: '46000'
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.arPort, 46000);
  assert.equal(r.json.arHost, '127.0.0.1');
  assert.equal(r.json.password, undefined);
  connId = r.json.id;

  // a partial update must not wipe the endpoint
  const put = await call('PUT', `/api/connections/${connId}`, { name: 'Dev 2' });
  assert.equal(put.json.arPort, 46000);
  assert.equal((await call('PUT', `/api/connections/${connId}`, { arHost: 'bad host!' })).status, 400);
});

test('status, forms, form workflow, search and object endpoints', async () => {
  assert.equal((await call('GET', '/api/workflow/status')).json.ready, true);
  assert.deepEqual((await call('GET', `/api/workflow/${connId}/forms`)).json.forms, ['HPD:Help Desk', 'CTM:Support Group']);
  const fw = await call('GET', `/api/workflow/${connId}/form-workflow?form=${encodeURIComponent('HPD:Help Desk')}`);
  assert.deepEqual(fw.json.activeLinks, ['HPD:INC:ClearVendor_100']);
  const s = await call('GET', `/api/workflow/${connId}/search?kind=activeLink&q=other`);
  assert.deepEqual(s.json.names, ['SHR:Other_AL']);
  const o = await call('GET', `/api/workflow/${connId}/object?kind=activeLink&name=${encodeURIComponent('HPD:INC:ClearVendor_100')}`);
  assert.equal(o.json.enabled, false);
  assert.deepEqual(o.json.executeOn, ['Button/Menu Item', 'Display']);
  assert.equal(o.json.actions[0].lines[0], `'Short Description' = $USER$`);
});

test('validation and unknown connections are 4xx', async () => {
  assert.equal((await call('GET', `/api/workflow/${connId}/form-workflow`)).status, 400);
  assert.equal((await call('GET', `/api/workflow/${connId}/object?kind=filter`)).status, 400);
  assert.equal((await call('GET', `/api/workflow/${connId}/search?kind=nope`)).status, 400);
  assert.equal((await call('GET', '/api/workflow/missing/forms')).status, 404);
  assert.equal((await call('POST', `/api/workflow/${connId}/disconnect`)).status, 204);
});

test('deleting a connection closes its helper', async () => {
  await call('GET', `/api/workflow/${connId}/forms`);
  assert.equal(workflow.getService().sessions.has(connId), true);
  await call('DELETE', `/api/connections/${connId}`);
  assert.equal(workflow.getService().sessions.has(connId), false);
});

test('hosted mode refuses workflow routes with a clear 501 before touching any helper', async () => {
  const express = require('express');
  const router = require('../routes/workflow');
  const app = express();
  app.use((req, res, next) => { req.user = { uid: 'u', email: 'a@b.c' }; next(); });
  app.use('/api/workflow', router);
  const srv = http.createServer(app).listen(0);
  await new Promise((r) => srv.once('listening', r));
  process.env.HELIX_MODE = 'hosted';
  try {
    const before = workflow.getService().sessions.size;
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/workflow/${connId || 'x'}/forms`);
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /desktop app/);
    assert.equal(workflow.getService().sessions.size, before);
  } finally {
    delete process.env.HELIX_MODE;
    srv.close();
  }
});

// ── Dev vs Prod compare ──────────────────────────────────────────────────────
async function waitForJob(jobId) {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', `/api/workflow/compare/${jobId}`);
    if (r.json.status !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('compare job did not finish');
}

test('compare: form scope finds modified, only-in-dev, only-in-prod and ignores deployment metadata', async () => {
  const dev = (await call('POST', '/api/connections', {
    name: 'Dev', baseUrl: 'http://localhost:8008', username: 'u', password: 'p', arPort: 46000
  })).json;
  const prod = (await call('POST', '/api/connections', {
    name: 'Prod', baseUrl: 'http://localhost:8009', username: 'u', password: 'p', arPort: 48000
  })).json;

  const start = await call('POST', '/api/workflow/compare', {
    leftConnId: dev.id, rightConnId: prod.id, scope: { type: 'form', form: 'CTM:Support Group' },
    kinds: ['filter', 'activeLink']
  });
  assert.equal(start.status, 202);
  const job = await waitForJob(start.json.jobId);
  assert.equal(job.status, 'done', job.error);

  const f = job.result.summary.filter;
  assert.deepEqual({ ...f }, { left: 2, right: 3, onlyLeft: 0, onlyRight: 1, modified: 1, same: 1 });
  assert.deepEqual(job.result.summary.activeLink, { left: 1, right: 0, onlyLeft: 1, onlyRight: 0, modified: 0, same: 0 });

  const items = Object.fromEntries(job.result.items.map((i) => [`${i.kind}:${i.name}`, i]));
  assert.equal(items['filter:CTM:SG:Validate'].status, 'modified');
  assert.deepEqual(items['filter:CTM:SG:Validate'].aspects, ['Run If']);
  assert.equal(items['filter:CTM:SG:ProdOnly'].status, 'onlyRight');
  assert.equal(items['activeLink:CTM:SG:DevOnlyAL'].status, 'onlyLeft');
  assert.equal(items['filter:CTM:SG:Same'], undefined, 'identical apart from who changed it');

  // readable detail for the modified one
  const detail = await call('GET', `/api/workflow/compare/${start.json.jobId}/object?kind=filter&name=${encodeURIComponent('CTM:SG:Validate')}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.left.runIf, `'Company' = "Calbro"`);
  assert.equal(detail.json.right.runIf, `'Company' = "Federal"`);
  assert.deepEqual(detail.json.changes.map((c) => c.aspect), ['Run If']);

  // an object that exists on one side only still returns the other side as null
  const only = await call('GET', `/api/workflow/compare/${start.json.jobId}/object?kind=filter&name=${encodeURIComponent('CTM:SG:ProdOnly')}`);
  assert.equal(only.json.left, null);
  assert.equal(only.json.right.name, 'CTM:SG:ProdOnly');
});

test('compare: name-pattern scope matches across the whole server', async () => {
  const conns = (await call('GET', '/api/connections')).json;
  const dev = conns.find((c) => c.name === 'Dev'), prod = conns.find((c) => c.name === 'Prod');
  const start = await call('POST', '/api/workflow/compare', {
    leftConnId: dev.id, rightConnId: prod.id, scope: { type: 'pattern', pattern: 'CTM:SG:*' }, kinds: ['filter']
  });
  const job = await waitForJob(start.json.jobId);
  assert.equal(job.status, 'done', job.error);
  // dev's name list has CTM:SG:Validate; prod's has Validate, Same, ProdOnly
  assert.deepEqual(job.result.summary.filter, { left: 1, right: 3, onlyLeft: 0, onlyRight: 2, modified: 1, same: 0 });
});

test('compare: validation, unknown jobs and a missing form surface as clear errors', async () => {
  const conns = (await call('GET', '/api/connections')).json;
  const [dev, prod] = [conns.find((c) => c.name === 'Dev'), conns.find((c) => c.name === 'Prod')];
  const post = (body) => call('POST', '/api/workflow/compare', { leftConnId: dev.id, rightConnId: prod.id, ...body });

  assert.equal((await post({ scope: { type: 'form', form: ' ' } })).status, 400);
  assert.equal((await post({ scope: { type: 'pattern', pattern: '*a' } })).status, 400);
  assert.equal((await post({ scope: { type: 'weird' } })).status, 400);
  assert.equal((await post({ scope: { type: 'form', form: 'X' }, kinds: ['nope'] })).status, 400);
  assert.equal((await call('POST', '/api/workflow/compare', {
    leftConnId: dev.id, rightConnId: dev.id, scope: { type: 'form', form: 'X' }
  })).status, 400);
  assert.equal((await call('POST', '/api/workflow/compare', {
    leftConnId: 'nope', rightConnId: prod.id, scope: { type: 'form', form: 'X' }
  })).status, 404);
  assert.equal((await call('GET', '/api/workflow/compare/not-a-job')).status, 404);

  const start = await post({ scope: { type: 'form', form: 'No Such Form' }, kinds: ['filter'] });
  const job = await waitForJob(start.json.jobId);
  assert.equal(job.status, 'error');
  assert.match(job.error, /does not exist/);
});

// ── Setup panel ──────────────────────────────────────────────────────────────
test('settings: a kit folder is resolved to its lib dir, saved, and bad paths are refused', async () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-kit-'));
  const lib = path.join(kit, 'plugins', 'com.bmc.arsys.studio.api_1', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'arapi990.jar'), '');
  const saved = workflow.getService().config;
  try {
    const bad = await call('PUT', '/api/workflow/settings', { libDir: path.join(kit, 'missing') });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /No arapi\*\.jar was found/);
    assert.equal(fs.existsSync(path.join(dataDir, 'workflow.json')), false, 'nothing saved on failure');

    const nojava = await call('PUT', '/api/workflow/settings', { javaPath: '/definitely/not/java' });
    assert.equal(nojava.status, 400);

    const ok = await call('PUT', '/api/workflow/settings', { libDir: kit });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.libDir, lib);
    assert.equal(ok.json.source, 'settings');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'workflow.json'), 'utf8')).libDir, lib);

    // clearing it goes back to unset
    const cleared = await call('PUT', '/api/workflow/settings', { libDir: '' });
    assert.equal(cleared.json.source, 'unset');
  } finally {
    workflow.getService().reconfigure(saved);
    fs.rmSync(path.join(dataDir, 'workflow.json'), { force: true });
    fs.rmSync(kit, { recursive: true, force: true });
  }
});

// ── Form layout ──────────────────────────────────────────────────────────────
test('layout: views, fields and a Dev-vs-Prod compare by view name', async () => {
  const conns = (await call('GET', '/api/connections')).json;
  const dev = conns.find((c) => c.name === 'Dev'), prod = conns.find((c) => c.name === 'Prod');
  const form = encodeURIComponent('HPD:Help Desk');

  const views = (await call('GET', `/api/workflow/${dev.id}/layout/views?form=${form}`)).json.views;
  assert.deepEqual(views.map((v) => [v.name, v.isBase]), [
    ['Default Admin View', true], ['DevOnlyView', true], ['Default Admin View_fr', false]
  ], 'base views first (by label), translated copies after');
  assert.equal(views.filter((v) => v.isBase).length, 2);
  assert.equal(views.find((v) => v.name === 'Default Admin View').label, 'Default Administrator View');

  const base = views.find((v) => v.name === 'Default Admin View');
  const fields = (await call('GET', `/api/workflow/${dev.id}/layout?form=${form}&view=${base.id}`)).json.fields;
  assert.equal(fields.length, 5, 'the field that is not on the view is dropped');
  assert.equal(fields.find((f) => f.name === 'InsidePanel').parent, 4);

  const cmp = (await call('GET',
    `/api/workflow/layout-compare?leftConnId=${dev.id}&rightConnId=${prod.id}&form=${form}&view=${encodeURIComponent('Default Admin View')}`)).json;
  assert.deepEqual(cmp.summary, { left: 5, right: 6, onlyLeft: 0, onlyRight: 1, modified: 4, same: 1, reordered: 0 });
  assert.deepEqual(cmp.views.onlyLeft.map((v) => v.name), ['DevOnlyView'], 'a base view missing on Prod is called out');
  assert.deepEqual(cmp.views.onlyRight, []);
  const by = Object.fromEntries(cmp.items.map((i) => [i.name, i]));
  assert.deepEqual(by.Status.aspects, ['Label']);
  assert.deepEqual(by.Notes.aspects, ['Visibility']);
  assert.deepEqual(by['Request ID'].aspects, ['Position']);
  assert.deepEqual(by.InsidePanel.aspects, ['Size']);
  assert.equal(by.ProdOnlyField.status, 'onlyRight');
  assert.equal(by.Panel, undefined, 'unchanged');
});

test('layout: validation, missing views and unknown forms are clear 4xx/5xx errors', async () => {
  const conns = (await call('GET', '/api/connections')).json;
  const dev = conns.find((c) => c.name === 'Dev'), prod = conns.find((c) => c.name === 'Prod');
  assert.equal((await call('GET', `/api/workflow/${dev.id}/layout/views`)).status, 400);
  assert.equal((await call('GET', `/api/workflow/${dev.id}/layout?form=X`)).status, 400);
  const q = (view) => `/api/workflow/layout-compare?leftConnId=${dev.id}&rightConnId=${prod.id}&form=${encodeURIComponent('HPD:Help Desk')}&view=${encodeURIComponent(view)}`;
  const missing = await call('GET', q('DevOnlyView'));
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /does not exist on the right server/);
  assert.equal((await call('GET', q(''))).status, 400);
  assert.equal((await call('GET',
    `/api/workflow/layout-compare?leftConnId=${dev.id}&rightConnId=${dev.id}&form=x&view=y`)).status, 400);
  const noForm = await call('GET', `/api/workflow/${dev.id}/layout/views?form=${encodeURIComponent('No Such')}`);
  assert.match(noForm.json.error, /does not exist/);
});
