const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CREDENTIAL_ENC_KEY = crypto.randomBytes(32).toString('base64');
const { encrypt, decrypt } = require('../lib/crypto');

test('round-trips a password', () => {
  const enc = encrypt('s3cret pässword ✓', 'alice:conn1');
  assert.match(enc, /^v1:/);
  assert.equal(decrypt(enc, 'alice:conn1'), 's3cret pässword ✓');
});

test('never contains the plaintext and uses a fresh IV each time', () => {
  const a = encrypt('hunter2', 'u:c');
  const b = encrypt('hunter2', 'u:c');
  assert.ok(!a.includes('hunter2'));
  assert.notEqual(a, b);
});

test('refuses to decrypt under a different owner/connection (AAD binding)', () => {
  const enc = encrypt('hunter2', 'alice:conn1');
  assert.throws(() => decrypt(enc, 'bob:conn1'));
  assert.throws(() => decrypt(enc, 'alice:conn2'));
});

test('detects tampering', () => {
  const [v, iv, tag, ct] = encrypt('hunter2', 'u:c').split(':');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decrypt([v, iv, tag, flipped.toString('base64')].join(':'), 'u:c'));
});

test('rejects malformed payloads', () => {
  assert.throws(() => decrypt('not-a-ciphertext', 'u:c'), /Unrecognized/);
  assert.throws(() => decrypt('v9:a:b:c', 'u:c'), /Unrecognized/);
});

test('rejects a missing or wrong-length key', () => {
  const saved = process.env.CREDENTIAL_ENC_KEY;
  try {
    process.env.CREDENTIAL_ENC_KEY = '';
    assert.throws(() => encrypt('x', 'a'), /not set/);
    process.env.CREDENTIAL_ENC_KEY = Buffer.from('too short').toString('base64');
    assert.throws(() => encrypt('x', 'a'), /32 bytes/);
  } finally {
    process.env.CREDENTIAL_ENC_KEY = saved;
  }
});

test('a different key cannot decrypt', () => {
  const enc = encrypt('hunter2', 'u:c');
  const saved = process.env.CREDENTIAL_ENC_KEY;
  try {
    process.env.CREDENTIAL_ENC_KEY = crypto.randomBytes(32).toString('base64');
    assert.throws(() => decrypt(enc, 'u:c'));
  } finally {
    process.env.CREDENTIAL_ENC_KEY = saved;
  }
});
