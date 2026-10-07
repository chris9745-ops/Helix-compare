const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Never touch the real data directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-local-test-'));
process.env.HELIX_DATA_DIR = dataDir;
delete process.env.HELIX_MODE;

const { createApp } = require('../app');

let server, base;
test.before(async () => {
  server = http.createServer(createApp()).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

test('local mode needs no login', async () => {
  const r = await call('GET', '/api/connections');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
  const me = await call('GET', '/api/me');
  assert.equal(me.json.hosted, false);
});

test('create keeps authString and ignoreSSL, never returns the password', async () => {
  const r = await call('POST', '/api/connections', {
    name: 'Dev', baseUrl: 'http://localhost:8008/', username: 'u', password: 'pw', authString: 'LDAP', ignoreSSL: true
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.password, undefined);
  assert.equal(r.json.authString, 'LDAP');
  assert.equal(r.json.ignoreSSL, true);
  assert.equal(r.json.baseUrl, 'http://localhost:8008');

  const list = (await call('GET', '/api/connections')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].password, undefined);

  // Local mode keeps the existing on-disk behaviour (plaintext, per-user file)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'connections.json'), 'utf8'));
  assert.equal(onDisk.connections[0].password, 'pw');
});

test('validation and not-found errors come back as 4xx, not 500', async () => {
  assert.equal((await call('POST', '/api/connections', { name: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/connections', { name: 'x', baseUrl: 'nope', username: 'u', password: 'p' })).status, 400);
  assert.equal((await call('POST', '/api/connections/missing/test')).status, 404);
  const cmp = await call('POST', '/api/compare/data', { leftConnId: 'a', rightConnId: 'b', formName: 'F', keyField: 'K' });
  assert.equal(cmp.status, 404);
});

test('update and delete', async () => {
  const id = (await call('GET', '/api/connections')).json[0].id;
  const upd = await call('PUT', `/api/connections/${id}`, { name: 'Renamed' });
  assert.equal(upd.json.name, 'Renamed');
  assert.equal((await call('PUT', '/api/connections/missing', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', `/api/connections/${id}`)).status, 204);
  assert.deepEqual((await call('GET', '/api/connections')).json, []);
});
