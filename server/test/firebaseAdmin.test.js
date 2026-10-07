const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.FIREBASE_CLIENT_EMAIL = 'svc@test-project.iam.gserviceaccount.com';

async function freshApp(keyEnv) {
  const { getApps, deleteApp } = require('firebase-admin/app');
  for (const a of getApps()) await deleteApp(a);
  delete require.cache[require.resolve('../lib/firebaseAdmin')];
  process.env.FIREBASE_PRIVATE_KEY = keyEnv;
  return require('../lib/firebaseAdmin').getApp();
}

// Netlify's UI lets people paste a key as real multi-line text, as one line with
// literal "\n" sequences, or with surrounding quotes. All three must work.
test('accepts a real multi-line PEM', async () => {
  assert.ok(await freshApp(privateKey));
});

test('accepts a one-line PEM with literal \\n sequences', async () => {
  assert.ok(await freshApp(privateKey.replace(/\n/g, '\\n')));
});

test('accepts a quoted one-line PEM (as copied from the service-account JSON)', async () => {
  assert.ok(await freshApp(`"${privateKey.replace(/\n/g, '\\n')}"`));
});

test('rejects a clearly broken key rather than failing later', async () => {
  await assert.rejects(() => freshApp('this is not a key'));
});
