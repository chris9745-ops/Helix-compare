const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-formlist-'));
process.env.HELIX_DATA_DIR = dataDir;
delete process.env.HELIX_MODE;

const store = require('../lib/connectionStore');
const { createApp } = require('../app');

let server, base, connId;
test.before(async () => {
  server = http.createServer(createApp()).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Dev', baseUrl: 'http://localhost:9', username: 'u', password: 'p' })
  });
  connId = (await r.json()).id;
});
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

test('starts empty', async () => {
  const r = await call('GET', `/api/connections/${connId}/forms`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { forms: [], importedAt: null });
});

test('imports a full-size table paste (6,576 rows is far over the old 100 kB body limit)', async () => {
  const rows = Array.from({ length: 6576 }, (_, i) => `PFX${i % 40}:Realistic_Looking_Form_Name_With_Some_Length_${i}\tonbmc-s\t${i % 9 === 0 ? 'Join' : 'Form'}`);
  const text = ['Name\tServer\tType', ...rows].join('\n');
  assert.ok(text.length > 100 * 1024, 'precondition: bigger than the default Express JSON limit');

  const put = await call('PUT', `/api/connections/${connId}/forms`, { text });
  assert.equal(put.status, 200);
  assert.equal(put.json.count, 6576);

  const got = await call('GET', `/api/connections/${connId}/forms`);
  assert.equal(got.json.forms.length, 6576);
  assert.ok(got.json.importedAt);
  assert.deepEqual(got.json.forms.find(f => f.name === 'PFX0:Realistic_Looking_Form_Name_With_Some_Length_0'), { name: 'PFX0:Realistic_Looking_Form_Name_With_Some_Length_0', type: 'Join' });
});

test('the connection list stays light (no form list riding along)', async () => {
  const list = (await call('GET', '/api/connections')).json;
  assert.ok(JSON.stringify(list).length < 2000);
});

test('rejects text with no form names, and unknown connections', async () => {
  const empty = await call('PUT', `/api/connections/${connId}/forms`, { text: '   \n  ' });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /No form names found/);
  assert.equal((await call('PUT', `/api/connections/${connId}/forms`, {})).status, 400);
  assert.equal((await call('GET', '/api/connections/nope/forms')).status, 404);
  assert.equal((await call('PUT', '/api/connections/nope/forms', { text: 'A:B' })).status, 404);
});

test('re-importing replaces the previous list; delete clears it', async () => {
  await call('PUT', `/api/connections/${connId}/forms`, { text: 'Only:One\nOnly:Two' });
  assert.deepEqual((await call('GET', `/api/connections/${connId}/forms`)).json.forms.map(f => f.name), ['Only:One', 'Only:Two']);
  assert.equal((await call('DELETE', `/api/connections/${connId}/forms`)).status, 204);
  assert.deepEqual((await call('GET', `/api/connections/${connId}/forms`)).json.forms, []);
});

test('deleting a connection also removes its stored form list', async () => {
  await call('PUT', `/api/connections/${connId}/forms`, { text: 'Some:Form' });
  assert.ok(await store.getFormList('local', connId));
  assert.equal((await call('DELETE', `/api/connections/${connId}`)).status, 204);
  assert.equal(await store.getFormList('local', connId), null);
});
