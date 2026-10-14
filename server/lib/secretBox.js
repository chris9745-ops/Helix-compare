/**
 * Encrypts saved Helix passwords for the local (desktop / dev) store.
 *
 * Two schemes, chosen when sealing:
 *   os    — the operating system's credential store, via Electron's safeStorage (macOS Keychain,
 *           Windows DPAPI, Linux libsecret). The key never exists on disk next to the data, so a copied or
 *           backed-up data folder is useless on its own. Used whenever the desktop app provides it.
 *   file  — AES-256-GCM with a random key kept in `.secret-key` (mode 0600) beside the data. Used for
 *           `npm run dev`, where there is no OS store. It keeps passwords out of a plaintext file that gets
 *           synced, backed up or pasted into a bug report, but it does NOT protect against another
 *           process running as the same user — the key is a file that user can read.
 *
 * Every payload carries the connection id it belongs to and is checked on the way out, so one
 * connection's ciphertext cannot be pasted onto another.
 *
 * Token format: `hdt1:<scheme>:<base64>`.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = 'hdt1';
const AAD = Buffer.from('helix-dev-tool:connection-password');

class SecretError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

let osProvider = null;

/** { isAvailable(): bool, encrypt(str): Buffer, decrypt(Buffer): str } — Electron's safeStorage fits. */
function setOsProvider(provider) { osProvider = provider || null; }

function osAvailable() {
  try { return !!(osProvider && osProvider.isAvailable()); } catch { return false; }
}

function loadKey(dataDir, { create }) {
  const file = path.join(dataDir, '.secret-key');
  const read = () => { try { const b = fs.readFileSync(file); return b.length === 32 ? b : null; } catch { return null; } };
  const existing = read();
  if (existing) return existing;
  if (!create) throw new SecretError('The encryption key for saved passwords is missing.', 'no-key');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;           // another process created it first — use theirs
  }
  const key = read();
  if (!key) throw new SecretError('Could not create the encryption key.', 'no-key');
  return key;
}

/** Seal `plain` for connection `id`. */
function encrypt(plain, { dataDir, id }) {
  const payload = JSON.stringify({ id: String(id), pw: String(plain) });
  if (osAvailable()) {
    return `${MAGIC}:os:${Buffer.from(osProvider.encrypt(payload)).toString('base64')}`;
  }
  const key = loadKey(dataDir, { create: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return `${MAGIC}:file:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

/** Open a token for connection `id`. Throws SecretError when it can't be read. */
function decrypt(token, { dataDir, id }) {
  const m = /^hdt1:(os|file):([A-Za-z0-9+/=]+)$/.exec(String(token || ''));
  if (!m) throw new SecretError('Not a recognised encrypted value.', 'format');
  const raw = Buffer.from(m[2], 'base64');
  let payload;
  try {
    if (m[1] === 'os') {
      if (!osAvailable()) throw new SecretError('This password was saved with the operating system\'s secure storage, which is not available here.', 'os-unavailable');
      payload = osProvider.decrypt(raw);
    } else {
      if (raw.length < 29) throw new SecretError('Encrypted value is too short.', 'format');
      const key = loadKey(dataDir, { create: false });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(raw.subarray(12, 28));
      payload = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
  } catch (e) {
    if (e instanceof SecretError) throw e;
    throw new SecretError('The saved password could not be decrypted.', 'decrypt');
  }
  let parsed;
  try { parsed = JSON.parse(payload); } catch { throw new SecretError('The saved password is corrupt.', 'format'); }
  if (!parsed || parsed.id !== String(id) || typeof parsed.pw !== 'string') {
    throw new SecretError('The saved password does not belong to this connection.', 'mismatch');
  }
  return parsed.pw;
}

const isSealed = (v) => typeof v === 'string' && v.startsWith(`${MAGIC}:`);
const schemeOf = (token) => { const m = /^hdt1:(os|file):/.exec(String(token || '')); return m ? m[1] : null; };

module.exports = { encrypt, decrypt, isSealed, schemeOf, setOsProvider, osAvailable, SecretError };
