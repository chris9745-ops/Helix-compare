const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cmp-err-'));
process.env.HELIX_DATA_DIR = dataDir;
delete process.env.HELIX_MODE;

const helix = require('../lib/helixClient');
const { createApp } = require('../app');

let server, base, leftId, rightId;
test.before(async () => {
  server = http.createServer(createApp()).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const post = async (name) => (await (await fetch(`${base}/api/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, baseUrl: 'http://localhost:9', username: 'u', password: 'p' })
  })).json()).id;
  leftId = await post('Dev');
  rightId = await post('Prod');
});
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const compare = async () => {
  const res = await fetch(`${base}/api/compare/data`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leftConnId: leftId, rightConnId: rightId, formName: 'F', keyField: 'K' })
  });
  return { status: res.status, json: await res.json() };
};

test('a connection reset names the side that failed and says what to do', async () => {
  const original = helix.queryEntries;
  helix.queryEntries = async (c) => {
    if (c.name === 'Prod') throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return { entries: [] };
  };
  const log = console.error; console.error = () => {};
  try {
    const r = await compare();
    assert.equal(r.status, 502);
    assert.match(r.json.error, /^Right connection "Prod": The connection to Helix was reset/);
    assert.match(r.json.error, /try again/i);
  } finally { helix.queryEntries = original; console.error = log; }
});

test('an upstream HTTP error also says which side it came from', async () => {
  const original = helix.queryEntries;
  helix.queryEntries = async (c) => {
    if (c.name === 'Dev') {
      throw Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404, statusText: '', data: [{ messageText: 'Form does not exist on server', messageAppendedText: 'F' }] }
      });
    }
    return { entries: [] };
  };
  const log = console.error; console.error = () => {};
  try {
    const r = await compare();
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'Left connection "Dev": Form does not exist on server: F');
  } finally { helix.queryEntries = original; console.error = log; }
});
