const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const adapter = new FileSync(path.join(__dirname, '../data/connections.json'));
const db = low(adapter);

db.defaults({ connections: [] }).write();

module.exports = {
  getAll() {
    return db.get('connections').value().map(c => ({
      ...c,
      password: undefined // never send passwords to client
    }));
  },

  getById(id) {
    return db.get('connections').find({ id }).value();
  },

  create({ name, baseUrl, username, password, authString = '', ignoreSSL = false }) {
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
    const { password: _, ...safe } = conn;
    return safe;
  },

  update(id, updates) {
    const conn = db.get('connections').find({ id });
    if (!conn.value()) return null;
    const merged = { ...conn.value(), ...updates, id };
    conn.assign(merged).write();
    const { password: _, ...safe } = merged;
    return safe;
  },

  delete(id) {
    db.get('connections').remove({ id }).write();
    return true;
  }
};
