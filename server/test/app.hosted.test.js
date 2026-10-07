const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

Object.assign(process.env, {
  HELIX_MODE: 'hosted',
  ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
  CREDENTIAL_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_CLIENT_EMAIL: 'svc@test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: 'not-used-in-tests'
});

const { makeFakeDb, installFakeFirebaseAdmin } = require('./fakeFirestore');
const db = makeFakeDb();
installFakeFirebaseAdmin(db);

const helix = require('../lib/helixClient');
const { createApp } = require('../app');

// Pretend to be Firebase: tokens are just names we recognise.
const TOKENS = {
  'alice-token': { uid: 'uid-alice', email: 'Alice@Example.com', email_verified: true },
  'bob-token': { uid: 'uid-bob', email: 'bob@example.com', email_verified: true },
  'mallory-token': { uid: 'uid-mallory', email: 'mallory@evil.com', email_verified: true },
  'unverified-token': { uid: 'uid-alice', email: 'alice@example.com', email_verified: false }
};
const verifyIdToken = async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; };

let server, base;
test.before(async () => {
  server = http.createServer(createApp({ verifyIdToken })).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const conn = (name) => ({ name, baseUrl: 'https://tenant.onbmc.com', username: 'u', password: 'hunter2' });

test('health is public', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('everything else requires a valid, allowlisted, verified identity', async () => {
  assert.equal((await call('GET', '/api/connections')).status, 401);
  assert.equal((await call('GET', '/api/connections', { token: 'garbage' })).status, 401);

  const stranger = await call('GET', '/api/connections', { token: 'mallory-token' });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.code, 'not_allowed');

  assert.equal((await call('GET', '/api/connections', { token: 'unverified-token' })).status, 403);
  assert.equal((await call('GET', '/api/me', { token: 'alice-token' })).status, 200);
});

test('every protected route family rejects anonymous callers', async () => {
  for (const [m, p] of [['GET', '/api/me'], ['POST', '/api/connections'], ['GET', '/api/helix/forms'],
                        ['POST', '/api/compare/data'], ['GET', '/api/helix/diagnostic']]) {
    assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
  }
});

test('create returns no secrets and stores ciphertext', async () => {
  const r = await call('POST', '/api/connections', { token: 'alice-token', body: conn('Alice Dev') });
  assert.equal(r.status, 201);
  assert.equal(r.json.password, undefined);
  assert.equal(r.json.passwordEnc, undefined);
  assert.ok(!JSON.stringify([...db._data.values()]).includes('hunter2'));
});

test('users only see and use their own connections', async () => {
  const aliceList = (await call('GET', '/api/connections', { token: 'alice-token' })).json;
  assert.equal(aliceList.length, 1);
  const aliceId = aliceList[0].id;

  assert.deepEqual((await call('GET', '/api/connections', { token: 'bob-token' })).json, []);
  assert.equal((await call('POST', `/api/connections/${aliceId}/test`, { token: 'bob-token' })).status, 404);

  // bob can't smuggle alice's id into a compare, or a helix call
  const bobOwn = (await call('POST', '/api/connections', { token: 'bob-token', body: conn('Bob') })).json;
  const cmp = await call('POST', '/api/compare/data', {
    token: 'bob-token',
    body: { leftConnId: aliceId, rightConnId: bobOwn.id, formName: 'F', keyField: 'K' }
  });
  assert.equal(cmp.status, 404);
  assert.match(cmp.json.error, /Left connection not found/);

  const res = await fetch(`${base}/api/helix/forms`, { headers: { authorization: 'Bearer bob-token', 'x-connection-id': aliceId } });
  assert.equal(res.status, 404);
});

test('hosted-mode connection validation', async () => {
  const post = (body) => call('POST', '/api/connections', { token: 'alice-token', body });
  assert.equal((await post({ ...conn('x'), baseUrl: 'http://tenant.onbmc.com' })).status, 400);
  assert.equal((await post({ ...conn('x'), baseUrl: 'https://localhost:8443' })).status, 400);
  assert.equal((await post({ ...conn('x'), baseUrl: 'https://169.254.169.254' })).status, 400);
  assert.equal((await post({ ...conn('x'), baseUrl: 'not a url' })).status, 400);
  const tls = await post({ ...conn('x'), ignoreSSL: true });
  assert.equal(tls.status, 400);
  assert.match(tls.json.error, /Ignore SSL/);
  assert.equal((await post({ name: 'x' })).status, 400);
});

test('authString is saved (regression: the route used to drop it)', async () => {
  const r = await call('POST', '/api/connections', { token: 'alice-token', body: { ...conn('LDAP'), authString: 'CORP-LDAP' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.authString, 'CORP-LDAP');
});

test('compare runs under the caller and returns a slimmed diff', async () => {
  const id1 = (await call('POST', '/api/connections', { token: 'alice-token', body: conn('L') })).json.id;
  const id2 = (await call('POST', '/api/connections', { token: 'alice-token', body: conn('R') })).json.id;

  const original = helix.queryEntries;
  helix.queryEntries = async (c) => ({
    entries: c.name === 'L'
      ? [{ values: { Name: 'same', V: '1' } }, { values: { Name: 'chg', V: 'old' } }, { values: { Name: 'onlyL', V: 'x' } }]
      : [{ values: { Name: 'same', V: '1' } }, { values: { Name: 'chg', V: 'new' } }, { values: { Name: 'onlyR', V: 'y' } }]
  });
  try {
    const r = await call('POST', '/api/compare/data', {
      token: 'alice-token', body: { leftConnId: id1, rightConnId: id2, formName: 'F', keyField: 'Name' }
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.summary, { added: 1, removed: 1, modified: 1, unchanged: 1 });
    assert.deepEqual(r.json.removed, [{ key: 'onlyL' }]);
    assert.deepEqual(r.json.added, [{ key: 'onlyR' }]);
    assert.deepEqual(r.json.modified, [{ key: 'chg', fieldDiffs: [{ field: 'V', left: 'old', right: 'new' }] }]);
    assert.deepEqual(r.json.unchanged, [{ key: 'same', left: { Name: 'same', V: '1' } }]);
  } finally {
    helix.queryEntries = original;
  }
});

test('unknown API paths get a JSON 404', async () => {
  const r = await call('GET', '/api/nope', { token: 'alice-token' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Not found');
});

test('fails closed when hosted config is incomplete', async () => {
  const saved = process.env.CREDENTIAL_ENC_KEY;
  delete process.env.CREDENTIAL_ENC_KEY;
  try {
    const r = await call('GET', '/api/connections', { token: 'alice-token' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json.missing, ['CREDENTIAL_ENC_KEY']);
  } finally {
    process.env.CREDENTIAL_ENC_KEY = saved;
  }
});

test('an empty allowlist locks everyone out', async () => {
  const saved = process.env.ALLOWED_EMAILS;
  process.env.ALLOWED_EMAILS = '   ';
  try {
    assert.equal((await call('GET', '/api/connections', { token: 'alice-token' })).status, 500); // counted as missing config
  } finally {
    process.env.ALLOWED_EMAILS = saved;
  }
});
