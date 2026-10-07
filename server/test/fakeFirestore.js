// Minimal in-memory stand-in for the slice of the Firestore Admin API that
// firestoreStore uses (collection/doc/get/set/update/delete), plus a helper to
// splice it in place of server/lib/firebaseAdmin so no network is needed.

function makeFakeDb() {
  const data = new Map(); // "users/alice/connections/<id>" -> doc

  const docRef = (path) => ({
    id: path.split('/').pop(),
    async get() {
      const d = data.get(path);
      return { exists: d !== undefined, id: path.split('/').pop(), data: () => (d === undefined ? undefined : structuredClone(d)) };
    },
    async set(value) { data.set(path, structuredClone(value)); },
    async update(patch) { data.set(path, { ...data.get(path), ...structuredClone(patch) }); },
    async delete() { data.delete(path); },
    collection: (name) => colRef(`${path}/${name}`)
  });

  const colRef = (path) => ({
    doc: (id) => docRef(`${path}/${id}`),
    async get() {
      const prefix = `${path}/`;
      const docs = [...data.entries()]
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(([key, value]) => ({ id: key.split('/').pop(), data: () => structuredClone(value) }));
      return { docs };
    }
  });

  return { collection: (name) => colRef(name), _data: data };
}

// Replace firebaseAdmin with a fake exposing the given db. Call BEFORE requiring
// anything that depends on it.
function installFakeFirebaseAdmin(db) {
  const modPath = require.resolve('../lib/firebaseAdmin');
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true,
    exports: {
      getDb: () => db,
      getApp: () => ({}),
      verifyIdToken: async () => { throw new Error('verifyIdToken should be injected in tests'); }
    }
  };
}

module.exports = { makeFakeDb, installFakeFirebaseAdmin };
