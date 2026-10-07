const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CREDENTIAL_ENC_KEY = crypto.randomBytes(32).toString('base64');
const { makeFakeDb, installFakeFirebaseAdmin } = require('./fakeFirestore');
const db = makeFakeDb();
installFakeFirebaseAdmin(db);
const store = require('../lib/stores/firestoreStore');

const base = { name: 'Dev', baseUrl: 'https://dev.example.com/', username: 'svc', password: 'p@ss-w0rd' };

test('create: stores only ciphertext, returns no password', async () => {
  const created = await store.create('alice', base);
  assert.equal(created.baseUrl, 'https://dev.example.com');
  assert.equal(created.password, undefined);
  assert.equal(created.passwordEnc, undefined);

  const raw = db._data.get(`users/alice/connections/${created.id}`);
  assert.ok(raw.passwordEnc.startsWith('v1:'));
  assert.ok(!JSON.stringify(raw).includes('p@ss-w0rd'), 'plaintext password must never reach the database');
});

test('getAll: no secrets in the list, newest last, only that user', async () => {
  await store.create('alice', { ...base, name: 'Prod' });
  await store.create('bob', { ...base, name: 'Bobs' });
  const list = await store.getAll('alice');
  assert.deepEqual(list.map(c => c.name).sort(), ['Dev', 'Prod']);
  for (const c of list) {
    assert.equal(c.password, undefined);
    assert.equal(c.passwordEnc, undefined);
  }
});

test('getById: decrypts for the owner (server-side use only)', async () => {
  const [first] = await store.getAll('alice');
  const full = await store.getById('alice', first.id);
  assert.equal(full.password, 'p@ss-w0rd');
});

test('isolation: another user cannot read someone else\'s connection', async () => {
  const [first] = await store.getAll('alice');
  assert.equal(await store.getById('bob', first.id), undefined);
});

test('a ciphertext moved into another user\'s document does not decrypt', async () => {
  const [first] = await store.getAll('alice');
  const stolen = db._data.get(`users/alice/connections/${first.id}`);
  db._data.set(`users/bob/connections/${first.id}`, { ...stolen });   // attacker copies the doc
  await assert.rejects(() => store.getById('bob', first.id));
});

test('update: re-encrypts a new password, ignores attempts to overwrite internals', async () => {
  const [first] = await store.getAll('alice');
  const updated = await store.update('alice', first.id, {
    name: 'Renamed',
    password: 'new-pass',
    passwordEnc: 'v1:evil:evil:evil',
    id: 'hijacked',
    createdAt: 'yesterday'
  });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal((await store.getById('alice', first.id)).password, 'new-pass');
});

test('update: unknown id returns null; delete removes', async () => {
  assert.equal(await store.update('alice', 'nope', { name: 'x' }), null);
  const [first] = await store.getAll('alice');
  await store.delete('alice', first.id);
  assert.equal(await store.getById('alice', first.id), undefined);
});
