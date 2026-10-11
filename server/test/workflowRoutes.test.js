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
