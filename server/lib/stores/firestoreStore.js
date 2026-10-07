// Hosted-mode connection store: Firestore, one subcollection per signed-in user
// (users/{uid}/connections/{id}) so people only ever see their own connections.
//
// Passwords are encrypted (AES-256-GCM, key in an env var) before they touch
// the database and are only decrypted inside getById(), which is used
// server-side to call Helix. They are never returned to the browser.
// Firestore security rules deny all direct client access; only this server
// (Admin SDK) reads or writes.

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../firebaseAdmin');
const { encrypt, decrypt } = require('../crypto');

const connections = (ownerId) => getDb().collection('users').doc(ownerId).collection('connections');
const aad = (ownerId, id) => `${ownerId}:${id}`;

const publicView = ({ passwordEnc, ...safe }) => safe;

module.exports = {
  async getAll(ownerId) {
    const snap = await connections(ownerId).get();
    return snap.docs
      .map(d => publicView(d.data()))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  // Includes the decrypted password — only for server-side use when calling Helix.
  async getById(ownerId, id) {
    const snap = await connections(ownerId).doc(String(id)).get();
    if (!snap.exists) return undefined;
    const data = snap.data();
    return { ...publicView(data), password: decrypt(data.passwordEnc, aad(ownerId, String(id))) };
  },

  async create(ownerId, { name, baseUrl, username, password, authString = '', ignoreSSL = false }) {
    const id = uuidv4();
    const doc = {
      id,
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      username,
      passwordEnc: encrypt(password, aad(ownerId, id)),
      authString,
      ignoreSSL,
      createdAt: new Date().toISOString()
    };
    await connections(ownerId).doc(id).set(doc);
    return publicView(doc);
  },

  async update(ownerId, id, updates) {
    const ref = connections(ownerId).doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) return null;

    // Whitelist: never let a request overwrite id/passwordEnc/createdAt directly.
    const patch = {};
    for (const key of ['name', 'baseUrl', 'username', 'authString', 'ignoreSSL']) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }
    if (patch.baseUrl) patch.baseUrl = patch.baseUrl.replace(/\/$/, '');
    if (updates.password) patch.passwordEnc = encrypt(updates.password, aad(ownerId, String(id)));

    if (Object.keys(patch).length) await ref.update(patch);
    return publicView({ ...snap.data(), ...patch });
  },

  async delete(ownerId, id) {
    await connections(ownerId).doc(String(id)).delete();
    return true;
  }
};
