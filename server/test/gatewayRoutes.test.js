const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-routes-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.HELIX_DATA_DIR = dataDir;
delete process.env.HELIX_MODE;

const { createApp } = require('../app');
const gateway = require('../lib/gateway');
const FAKE = path.join(__dirname, 'fakeGateway.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let server, base, port;
test.before(async () => {
  port = await freePort();
  const dir = path.join(root, 'gateway', 'kwic');
  fs.mkdirSync(path.join(dir, 'conf'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'conf', 'kwic-config.xml'),
    `<gateway-config><properties><property><name>p</name><value>${port}</value></property></properties>` +
    '<service><name>dev api</name><accept>tcp://127.0.0.1:${p}</accept></service></gateway-config>');
  gateway.setGateway(new gateway.GatewayManager({
    dataDir, env: {}, startTimeoutMs: 8000, stopTimeoutMs: 3000,
    spawnFn: (c, a, o) => spawn(process.execPath, [FAKE, 'org.kaazing.gateway.server.Main', String(port)], o)
  }));
  server = http.createServer(createApp()).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  gateway.getGateway().killNow();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

test('status, start, log and stop over HTTP', async () => {
  const s0 = await call('GET', '/api/gateway/status');
  assert.equal(s0.status, 200);
  assert.equal(s0.json.state, 'stopped');
  assert.deepEqual(s0.json.services.map((s) => [s.name, s.port, s.listening]), [['dev api', port, false]]);

  const up = await call('POST', '/api/gateway/start');
  assert.equal(up.status, 200);
  assert.equal(up.json.state, 'running');
  assert.equal(up.json.services[0].listening, true);

  const log = await call('GET', '/api/gateway/log?lines=20');
  assert.ok(log.json.lines.some((l) => l.includes('fake gateway listening')));

  const down = await call('POST', '/api/gateway/stop');
  assert.equal(down.status, 200);
  assert.equal(down.json.state, 'stopped');
});

test('the status never carries config contents', async () => {
  const text = JSON.stringify((await call('GET', '/api/gateway/status')).json);
  assert.ok(!/accept|token|keystore/i.test(text.replace(/"autoStart"/g, '')), text);
});

test('settings validation and auto-start toggle', async () => {
  const bad = await call('PUT', '/api/gateway/settings', { gatewayDir: path.join(root, 'nope') });
  assert.equal(bad.status, 400);
  const on = await call('PUT', '/api/gateway/settings', { autoStart: true });
  assert.equal(on.json.autoStart, true);
  const off = await call('PUT', '/api/gateway/settings', { autoStart: false });
  assert.equal(off.json.autoStart, false);
});

test('hosted mode refuses with a 501 and never touches a process', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/gateway', require('../routes/gateway'));
  const srv = http.createServer(app).listen(0);
  await new Promise((r) => srv.once('listening', r));
  process.env.HELIX_MODE = 'hosted';
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/gateway/start`, { method: 'POST' });
    assert.equal(res.status, 501);
    assert.equal((await gateway.getGateway().status()).state, 'stopped');
  } finally {
    delete process.env.HELIX_MODE;
    srv.close();
  }
});
