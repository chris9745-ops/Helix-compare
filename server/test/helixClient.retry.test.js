const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const helix = require('../lib/helixClient');

// A stand-in Helix whose first N hits on each endpoint are cut off mid-request
// (what ECONNRESET looks like to the client), then behaves normally.
function startFakeHelix({ dropFirst = { login: 1, entry: 1 } } = {}) {
  const hits = { login: 0, entry: 0 };
  const connectionHeaders = [];
  const server = http.createServer((req, res) => {
    connectionHeaders.push(req.headers.connection);
    const kind = req.url.startsWith('/api/jwt/login') ? 'login' : 'entry';
    hits[kind]++;
    if (hits[kind] <= dropFirst[kind]) return req.socket.destroy();
    if (kind === 'login') return res.end('fake-jwt-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ entries: [{ values: { Name: 'A' } }] }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, hits, connectionHeaders, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

const conn = (baseUrl, id) => ({ id, baseUrl, username: 'u', password: 'p' });

test('recovers from one connection reset on the login and one on the query', async () => {
  const fake = await startFakeHelix({ dropFirst: { login: 1, entry: 1 } });
  try {
    const data = await helix.queryEntries(conn(fake.baseUrl, 'retry-ok'), 'SomeForm');
    assert.deepEqual(data.entries[0].values, { Name: 'A' });
    assert.equal(fake.hits.login, 2, 'login retried once');
    assert.equal(fake.hits.entry, 2, 'query retried once');
  } finally { fake.server.close(); }
});

test('retries only ONCE: a persistent reset is reported, not looped on', async () => {
  const fake = await startFakeHelix({ dropFirst: { login: 0, entry: 99 } });
  try {
    await assert.rejects(
      () => helix.queryEntries(conn(fake.baseUrl, 'retry-once'), 'SomeForm'),
      (err) => err.code === 'ECONNRESET'
    );
    assert.equal(fake.hits.entry, 2, 'exactly one retry');
  } finally { fake.server.close(); }
});

test('does not retry real HTTP errors (a 401 is an answer, not a flaky connection)', async () => {
  let loginHits = 0;
  const server = http.createServer((req, res) => {
    loginHits++;
    res.statusCode = 401;
    res.end('[{"messageType":"ERROR","messageText":"Authentication failed"}]');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => helix.testConnection(conn(`http://127.0.0.1:${server.address().port}`, 'no-retry-401')),
      (err) => err.response && err.response.status === 401
    );
    assert.equal(loginHits, 1);
  } finally { server.close(); }
});

test('does not keep connections alive between calls (the serverless stale-socket problem)', async () => {
  const fake = await startFakeHelix({ dropFirst: { login: 0, entry: 0 } });
  try {
    await helix.queryEntries(conn(fake.baseUrl, 'no-keepalive'), 'SomeForm');
    assert.ok(fake.connectionHeaders.length >= 2);
    for (const header of fake.connectionHeaders) assert.equal(header, 'close');
  } finally { fake.server.close(); }
});
