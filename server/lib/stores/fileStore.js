// Local-mode connection store: a single JSON file (lowdb). Used by the desktop
// app and `npm run dev`. Single user, so `ownerId` is accepted (to match the
// Firestore store's interface) but ignored.
//
// HELIX_DATA_DIR points at the OS per-user app data directory in the packaged
// Electron app so connections survive updates/reinstalls.
//
// Passwords are never stored in plaintext: they are sealed with ../secretBox (the OS credential
// store in the desktop app, a locally keyed AES-GCM fallback in dev) and only opened inside
// getById(), for server-side calls to Helix. A file written by an older version, which held the
// password in the clear, is migrated the first time it is loaded.

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const secrets = require('../secretBox');

const dataDir = process.env.HELIX_DATA_DIR || path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

const db = low(new FileSync(path.join(dataDir, 'connections.json')));
db.defaults({ connections: [] }).write();

// Imported form lists live in their own file so the (large) lists don't ride
// along on every connection read.
const lists = low(new FileSync(path.join(dataDir, 'formlists.json')));
lists.defaults({ lists: {} }).write();

// Fields a caller may set on update. Anything else (id, passwordEnc, createdAt, …) is ignored.
const UPDATABLE = ['name', 'baseUrl', 'username', 'authString', 'ignoreSSL', 'arHost', 'arPort'];

const seal = (id, plain) => secrets.encrypt(plain, { dataDir, id });

// Opening an OS-backed value can prompt for keychain access, so remember what we have already opened.
// Keyed by the token itself, so a changed password can never be served from here.
const opened = new Map();
function open(conn) {
  if (!conn.passwordEnc) return { password: '', readable: false };
  const hit = opened.get(conn.passwordEnc);
  if (hit && hit.id === conn.id) return { password: hit.pw, readable: true };
  try {
    const pw = secrets.decrypt(conn.passwordEnc, { dataDir, id: conn.id });
    opened.set(conn.passwordEnc, { id: conn.id, pw });
    return { password: pw, readable: true };
  } catch (e) {
    return { password: '', readable: false, reason: e.code };
  }
}

/** What the browser may see: no password material, but whether the saved one can still be used. */
function publicView(conn) {
  const { password, passwordEnc, ...safe } = conn;
  return { ...safe, passwordReadable: open(conn).readable };
}

/**
 * Bring a data file up to date:
 *  - legacy plaintext `password` -> sealed `passwordEnc` (verified by opening it again before the
 *    plaintext is dropped; if anything fails the file is left exactly as it was)
 *  - file-scheme values -> OS storage once the desktop app makes that available
 */
function migrate() {
  const before = db.get('connections').value();
  let changed = false;
  const after = before.map((c) => {
    try {
      if (c.password !== undefined && !c.passwordEnc) {
        const token = seal(c.id, c.password);
        if (secrets.decrypt(token, { dataDir, id: c.id }) !== c.password) throw new Error('verification failed');
        const { password, ...rest } = c;
        changed = true;
        return { ...rest, passwordEnc: token };
      }
      if (c.passwordEnc && secrets.schemeOf(c.passwordEnc) === 'file' && secrets.osAvailable()) {
        const pw = secrets.decrypt(c.passwordEnc, { dataDir, id: c.id });
        const token = seal(c.id, pw);
        if (secrets.schemeOf(token) === 'os') { changed = true; return { ...c, passwordEnc: token }; }
      }
    } catch (e) {
      console.warn(`[connections] could not secure the saved password for "${c.name}": ${e.message}`);
    }
    return c;
  });
  if (changed) db.set('connections', after).write();
}
migrate();

module.exports = {
  async getAll() {
    return db.get('connections').value().map(publicView);
  },

  // Includes the password — only for server-side use when calling Helix. If the saved password
  // can't be opened (e.g. this data folder was copied to another computer), `passwordUnreadable`
  // is set and the caller should ask the user to re-enter it rather than send an empty one.
  async getById(_ownerId, id) {
    const conn = db.get('connections').find({ id }).value();
    if (!conn) return undefined;
    const { password, passwordEnc, ...rest } = conn;
    const o = open(conn);
    return o.readable ? { ...rest, password: o.password } : { ...rest, password: '', passwordUnreadable: true };
  },

  async create(_ownerId, { name, baseUrl, username, password, authString = '', ignoreSSL = false, arHost = '', arPort = null }) {
    const id = uuidv4();
    const conn = {
      id,
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      username,
      passwordEnc: seal(id, password),
      authString,   // optional — required by some Helix SSO/LDAP configs
      ignoreSSL,
      arHost,       // native AR API endpoint for workflow browsing (Client Gateway), local mode only
      arPort,
      createdAt: new Date().toISOString()
    };
    db.get('connections').push(conn).write();
    return publicView(conn);
  },

  async update(_ownerId, id, updates) {
    const ref = db.get('connections').find({ id });
    const current = ref.value();
    if (!current) return null;
    const patch = {};
    for (const k of UPDATABLE) if (updates[k] !== undefined) patch[k] = updates[k];
    if (typeof updates.password === 'string' && updates.password.length > 0) patch.passwordEnc = seal(id, updates.password);
    const merged = { ...current, ...patch, id };
    delete merged.password;
    ref.assign(merged).write();
    // `assign` keeps keys it isn't given, so make sure a legacy plaintext field is really gone
    if (ref.value().password !== undefined) { ref.unset('password').write(); }
    return publicView(ref.value());
  },

  async delete(_ownerId, id) {
    db.get('connections').remove({ id }).write();
    lists.unset(['lists', id]).write();
    return true;
  },

  // Form list imported from the Mid-Tier object list: { text, importedAt } or null
  async getFormList(_ownerId, id) {
    return lists.get(['lists', id]).value() || null;
  },

  async setFormList(_ownerId, id, { text, importedAt }) {
    lists.set(['lists', id], { text, importedAt }).write();
  },

  async deleteFormList(_ownerId, id) {
    lists.unset(['lists', id]).write();
  }
};

module.exports.__migrate = migrate;   // exercised by tests
