// Local-mode connection store: a single JSON file (lowdb). Used by the desktop
// app and `npm run dev`. Single user, so `ownerId` is accepted (to match the
// Firestore store's interface) but ignored.
//
// HELIX_DATA_DIR points at the OS per-user app data directory in the packaged
// Electron app so connections survive updates/reinstalls.

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const dataDir = process.env.HELIX_DATA_DIR || path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

const db = low(new FileSync(path.join(dataDir, 'connections.json')));
db.defaults({ connections: [] }).write();

const stripPassword = ({ password, ...safe }) => safe;

module.exports = {
  async getAll() {
    return db.get('connections').value().map(stripPassword);
  },

  // Includes the password — only for server-side use when calling Helix.
  async getById(_ownerId, id) {
    return db.get('connections').find({ id }).value();
  },

  async create(_ownerId, { name, baseUrl, username, password, authString = '', ignoreSSL = false }) {
    const conn = {
      id: uuidv4(),
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      username,
      password,
      authString,   // optional — required by some Helix SSO/LDAP configs
      ignoreSSL,
      createdAt: new Date().toISOString()
    };
    db.get('connections').push(conn).write();
    return stripPassword(conn);
  },

  async update(_ownerId, id, updates) {
    const conn = db.get('connections').find({ id });
    if (!conn.value()) return null;
    const merged = { ...conn.value(), ...updates, id };
    conn.assign(merged).write();
    return stripPassword(merged);
  },

  async delete(_ownerId, id) {
    db.get('connections').remove({ id }).write();
    return true;
  }
};
