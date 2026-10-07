// Picks the connection store for the current mode. Only one backend is ever
// required: the file store touches the local disk at load time, which must not
// happen on Netlify (read-only filesystem), and the Firestore store needs
// firebase-admin, which the desktop app doesn't ship.
//
// Interface (all async; `ownerId` is the signed-in user's uid in hosted mode,
// ignored in local mode):
//   getAll(ownerId)                  -> connections without passwords
//   getById(ownerId, id)             -> one connection WITH password (server-side use only)
//   create(ownerId, data)            -> created connection without password
//   update(ownerId, id, updates)     -> updated connection without password, or null
//   delete(ownerId, id)

const { isHosted } = require('../config');

module.exports = isHosted()
  ? require('./stores/firestoreStore')
  : require('./stores/fileStore');
