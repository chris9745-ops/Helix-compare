const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secretBox');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secretbox-'));
// Stand-in for Electron's safeStorage: reversible, so tests can see that the OS path was used.
const fakeOs = (available = true) => ({
  isAvailable: () => available,
  encrypt: (s) => Buffer.from(`OS[${Buffer.from(s).toString('base64')}]`),
  decrypt: (b) => Buffer.from(/^OS\[(.*)\]$/.exec(b.toString())[1], 'base64').toString()
});

test.afterEach(() => secrets.setOsProvider(null));

test('round trip, including quotes, unicode and an empty password', () => {
  const dir = tmp();
  for (const pw of ['hunter2', 'p"a\'ss\\w;rd', 'пароль-密码-🔑', '']) {
    const token = secrets.encrypt(pw, { dataDir: dir, id: 'c1' });
    assert.match(token, /^hdt1:file:[A-Za-z0-9+/=]+$/);
    assert.equal(secrets.decrypt(token, { dataDir: dir, id: 'c1' }), pw);
  }
});

test('the ciphertext never contains the password and is different every time', () => {
  const dir = tmp();
  const a = secrets.encrypt('SuperSecret!9', { dataDir: dir, id: 'c1' });
  const b = secrets.encrypt('SuperSecret!9', { dataDir: dir, id: 'c1' });
  assert.notEqual(a, b, 'fresh IV per value');
  assert.ok(!a.includes('SuperSecret'));
  assert.ok(!Buffer.from(a.split(':')[2], 'base64').toString('latin1').includes('SuperSecret'));
});

test('the key file is created private (0600) and reused', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  secrets.encrypt('x', { dataDir: dir, id: 'c1' });
  const keyPath = path.join(dir, '.secret-key');
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  const key = fs.readFileSync(keyPath);
  assert.equal(key.length, 32);
  secrets.encrypt('y', { dataDir: dir, id: 'c2' });
  assert.deepEqual(fs.readFileSync(keyPath), key, 'second value must not rotate the key');
});

test('a value is bound to its connection id', () => {
  const dir = tmp();
  const token = secrets.encrypt('pw', { dataDir: dir, id: 'c1' });
  assert.throws(() => secrets.decrypt(token, { dataDir: dir, id: 'c2' }), (e) => e.code === 'mismatch');
});

test('tampering, wrong key and junk are all refused rather than returning garbage', () => {
  const dir = tmp();
  const token = secrets.encrypt('pw', { dataDir: dir, id: 'c1' });
  const [magic, scheme, b64] = token.split(':');
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 0x01;
  assert.throws(() => secrets.decrypt(`${magic}:${scheme}:${buf.toString('base64')}`, { dataDir: dir, id: 'c1' }), /could not be decrypted/);

  const other = tmp();                      // a different data folder = a different key
  secrets.encrypt('x', { dataDir: other, id: 'c1' });
  assert.throws(() => secrets.decrypt(token, { dataDir: other, id: 'c1' }), (e) => e.code === 'decrypt');

  const noKey = tmp();                      // key file gone entirely
  assert.throws(() => secrets.decrypt(token, { dataDir: noKey, id: 'c1' }), (e) => e.code === 'no-key');
  assert.throws(() => secrets.decrypt('plaintext', { dataDir: dir, id: 'c1' }), (e) => e.code === 'format');
  assert.throws(() => secrets.decrypt('hdt1:file:AAAA', { dataDir: dir, id: 'c1' }), (e) => e.code === 'format');
});

test('uses the OS credential store when the desktop app provides one, and says so in the token', () => {
  const dir = tmp();
  secrets.setOsProvider(fakeOs());
  const token = secrets.encrypt('pw', { dataDir: dir, id: 'c1' });
  assert.match(token, /^hdt1:os:/);
  assert.equal(secrets.schemeOf(token), 'os');
  assert.equal(secrets.decrypt(token, { dataDir: dir, id: 'c1' }), 'pw');
  assert.equal(fs.existsSync(path.join(dir, '.secret-key')), false, 'no key file is written when the OS store is used');
});

test('an OS-sealed value cannot be opened where the OS store is unavailable', () => {
  const dir = tmp();
  secrets.setOsProvider(fakeOs());
  const token = secrets.encrypt('pw', { dataDir: dir, id: 'c1' });
  secrets.setOsProvider(fakeOs(false));
  assert.throws(() => secrets.decrypt(token, { dataDir: dir, id: 'c1' }), (e) => e.code === 'os-unavailable');
  // …and sealing falls back to the file scheme rather than failing or writing plaintext
  assert.match(secrets.encrypt('pw', { dataDir: dir, id: 'c1' }), /^hdt1:file:/);
});

test('a provider that throws is treated as unavailable', () => {
  secrets.setOsProvider({ isAvailable: () => { throw new Error('keychain locked'); }, encrypt: () => { throw new Error('x'); }, decrypt: () => { throw new Error('x'); } });
  assert.equal(secrets.osAvailable(), false);
  assert.match(secrets.encrypt('pw', { dataDir: tmp(), id: 'c1' }), /^hdt1:file:/);
});
