// The local connection store keeps no plaintext passwords, migrates old files safely, and degrades
// to "re-enter your password" rather than sending an empty one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secretBox');
const STORE = require.resolve('../lib/stores/fileStore');

/** Load a fresh copy of the store pointed at `dir` (it reads HELIX_DATA_DIR once, at require time). */
function loadStore(dir) {
  process.env.HELIX_DATA_DIR = dir;
  delete require.cache[STORE];
  return require(STORE);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-'));
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'connections.json'), 'utf8'));
const rawText = (dir) => fs.readFileSync(path.join(dir, 'connections.json'), 'utf8');
const fakeOs = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`OS[${Buffer.from(s).toString('base64')}]`),
  decrypt: (b) => Buffer.from(/^OS\[(.*)\]$/.exec(b.toString())[1], 'base64').toString()
};

test.afterEach(() => { secrets.setOsProvider(null); delete process.env.HELIX_DATA_DIR; });

const NEW = { name: 'Dev', baseUrl: 'https://h.example/', username: 'u', password: 'Tr0ub4dor&3', authString: 'LDAP' };

test('a new connection is stored sealed — the password is nowhere in the file', async () => {
  const dir = tmp();
  const store = loadStore(dir);
  const created = await store.create('local', NEW);
  assert.equal(created.password, undefined);
  assert.equal(created.passwordEnc, undefined);
  assert.equal(created.passwordReadable, true);

  const disk = readJson(dir).connections[0];
  assert.equal(disk.password, undefined);
  assert.match(disk.passwordEnc, /^hdt1:file:/);
  assert.ok(!rawText(dir).includes('Tr0ub4dor'), 'plaintext must not appear anywhere in connections.json');

  const forServer = await store.getById('local', created.id);
  assert.equal(forServer.password, 'Tr0ub4dor&3');
  assert.equal(forServer.passwordEnc, undefined, 'ciphertext is not handed to callers either');
  assert.equal(forServer.passwordUnreadable, undefined);

  const listed = (await store.getAll())[0];
  assert.equal(listed.password, undefined);
  assert.equal(listed.passwordEnc, undefined);
  assert.equal(listed.authString, 'LDAP');
});

test('an old plaintext file is migrated: password sealed, plaintext gone, everything else intact', async () => {
  const dir = tmp();
  const legacy = {
    connections: [
      { id: 'a1', name: 'HMS Dev', baseUrl: 'https://d.example', username: 'nfoy', password: 'old-secret-1', authString: '', ignoreSSL: false, createdAt: '2026-07-07T02:06:31.011Z' },
      { id: 'b2', name: 'HMS Prod', baseUrl: 'https://p.example', username: 'nfoy', password: 'old-secret-2', authString: '', ignoreSSL: true, arHost: '127.0.0.1', arPort: 48000, createdAt: '2026-07-07T02:06:50.478Z' }
    ]
  };
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify(legacy));
  const store = loadStore(dir);

  const text = rawText(dir);
  assert.ok(!text.includes('old-secret-1') && !text.includes('old-secret-2'), 'no plaintext left after load');
  const disk = readJson(dir).connections;
  assert.equal(disk.length, 2);
  assert.deepEqual(disk.map((c) => c.password), [undefined, undefined]);
  assert.ok(disk.every((c) => /^hdt1:/.test(c.passwordEnc)));
  assert.deepEqual(
    disk.map(({ passwordEnc, ...rest }) => rest),
    legacy.connections.map(({ password, ...rest }) => rest),
    'ids, names, URLs, endpoints and timestamps survive untouched'
  );

  assert.equal((await store.getById('local', 'a1')).password, 'old-secret-1');
  assert.equal((await store.getById('local', 'b2')).password, 'old-secret-2');
});

test('migration is idempotent and re-opening an already-secured file changes nothing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify({
    connections: [{ id: 'a1', name: 'D', baseUrl: 'https://d.example', username: 'u', password: 'pw1', createdAt: 'x' }]
  }));
  loadStore(dir);
  const first = rawText(dir);
  loadStore(dir);
  assert.equal(rawText(dir), first);
});

test('file-scheme values are upgraded to the OS store once the desktop app provides it', async () => {
  const dir = tmp();
  let store = loadStore(dir);
  const { id } = await store.create('local', NEW);
  assert.match(readJson(dir).connections[0].passwordEnc, /^hdt1:file:/);

  secrets.setOsProvider(fakeOs);
  store = loadStore(dir);                         // what happens when the packaged app starts
  assert.match(readJson(dir).connections[0].passwordEnc, /^hdt1:os:/);
  assert.equal((await store.getById('local', id)).password, 'Tr0ub4dor&3');
});

test('update: new password is sealed; blank keeps the old one; protected fields cannot be injected', async () => {
  const dir = tmp();
  const store = loadStore(dir);
  const { id } = await store.create('local', NEW);

  await store.update('local', id, { name: 'Dev (renamed)', password: '' });
  assert.equal((await store.getById('local', id)).password, 'Tr0ub4dor&3', 'a blank password must not wipe the saved one');

  await store.update('local', id, { password: 'N3w-secret' });
  assert.equal((await store.getById('local', id)).password, 'N3w-secret');
  assert.ok(!rawText(dir).includes('N3w-secret'));

  const victim = await store.create('local', { ...NEW, name: 'Prod', password: 'prod-pw' });
  const stolen = readJson(dir).connections.find((c) => c.id === victim.id).passwordEnc;
  await store.update('local', id, { passwordEnc: stolen, id: 'hijack', createdAt: 'nope', password: undefined });
  const after = readJson(dir).connections.find((c) => c.id === id);
  assert.equal(after.id, id);
  assert.notEqual(after.passwordEnc, stolen, 'passwordEnc is not writable through update');
  assert.equal(after.createdAt === 'nope', false);
});

test("one connection's sealed password cannot be swapped onto another", async () => {
  const dir = tmp();
  const store = loadStore(dir);
  const a = await store.create('local', { ...NEW, name: 'A', password: 'pw-a' });
  const b = await store.create('local', { ...NEW, name: 'B', password: 'pw-b' });
  const file = readJson(dir);
  const [ea, eb] = file.connections.map((c) => c.passwordEnc);
  file.connections[0].passwordEnc = eb;
  file.connections[1].passwordEnc = ea;
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify(file));
  const swapped = loadStore(dir);
  assert.equal((await swapped.getById('local', a.id)).passwordUnreadable, true);
  assert.equal((await swapped.getById('local', b.id)).passwordUnreadable, true);
});

test('an unreadable password is flagged and never returned as an empty-but-valid one; re-entering heals it', async () => {
  const dir = tmp();
  let store = loadStore(dir);
  const { id } = await store.create('local', NEW);
  fs.rmSync(path.join(dir, '.secret-key'));        // e.g. the data folder was copied without its key
  store = loadStore(dir);

  const listed = (await store.getAll())[0];
  assert.equal(listed.passwordReadable, false);
  const c = await store.getById('local', id);
  assert.equal(c.passwordUnreadable, true);
  assert.equal(c.password, '');
  assert.equal(c.name, 'Dev', 'the rest of the connection is still usable/editable');

  await store.update('local', id, { password: 'again' });
  const healed = await store.getById('local', id);
  assert.equal(healed.password, 'again');
  assert.equal(healed.passwordUnreadable, undefined);
});

test('the same connection can be read after the store is reloaded', async () => {
  const dir = tmp();
  let store = loadStore(dir);
  const { id } = await store.create('local', NEW);
  store = loadStore(dir);
  assert.equal((await store.getById('local', id)).password, 'Tr0ub4dor&3');
});
