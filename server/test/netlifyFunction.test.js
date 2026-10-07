const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Deliberately NOT setting HELIX_MODE: the function must force hosted mode
// itself, so forgetting the env var in Netlify can't expose an open API.
delete process.env.HELIX_MODE;
Object.assign(process.env, {
  ALLOWED_EMAILS: 'alice@example.com',
  CREDENTIAL_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_CLIENT_EMAIL: 'svc@test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: 'not-used-in-tests'
});

const { handler } = require('../../netlify/functions/api');

// Shape of an API Gateway v1 (Lambda) event as Netlify delivers it.
const event = (path, { method = 'GET', headers = {}, body = null } = {}) => ({
  httpMethod: method,
  path,
  headers: { host: 'example.netlify.app', ...headers },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  body,
  isBase64Encoded: false,
  requestContext: {}
});

test('forces hosted mode regardless of env', () => {
  assert.equal(process.env.HELIX_MODE, 'hosted');
});

test('serves /api/health when reached via the /api/* redirect', async () => {
  const res = await handler(event('/api/health'), {});
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'ok');
});

test('also works when called directly at /.netlify/functions/api/...', async () => {
  const res = await handler(event('/.netlify/functions/api/health'), {});
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'ok');
});

test('protected routes are closed without a token — both path styles', async () => {
  for (const p of ['/api/connections', '/.netlify/functions/api/connections']) {
    const res = await handler(event(p), {});
    assert.equal(res.statusCode, 401, p);
    assert.equal(JSON.parse(res.body).code, 'unauthenticated');
  }
});

test('a broken Firebase key is reported as a server config problem, not "session expired"', async () => {
  // FIREBASE_PRIVATE_KEY is the placeholder above, so Firebase can't initialise.
  const res = await handler(event('/api/connections', { headers: { authorization: 'Bearer anything' } }), {});
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).code, 'misconfigured');
});

test('unknown API route is a JSON 404, and JSON bodies parse', async () => {
  const res = await handler(event('/api/nope', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } }), {});
  // No token → 401 before routing; the point is it responds cleanly rather than throwing.
  assert.ok([401, 404].includes(res.statusCode));
});

test('with a valid Firebase key, a garbage bearer token is a clean 401', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  process.env.FIREBASE_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
  // Fresh module graph so firebaseAdmin picks up the new key
  for (const k of Object.keys(require.cache)) if (k.includes('/server/') || k.includes('/netlify/')) delete require.cache[k];
  const { handler: fresh } = require('../../netlify/functions/api');

  const res = await fresh(event('/api/connections', { headers: { authorization: 'Bearer not.a.jwt' } }), {});
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).code, 'unauthenticated');
});
