// AES-256-GCM encryption for Helix passwords stored in Firestore.
//
// The key lives only in the CREDENTIAL_ENC_KEY env var (base64, 32 bytes), so a
// copy of the database alone doesn't expose any passwords. `aad` binds each
// ciphertext to its owner+connection id: a ciphertext copied into another
// user's document (or another connection) fails to decrypt instead of
// silently handing over someone else's credentials.
//
// Format: v1:<iv>:<authTag>:<ciphertext>   (each part base64)

const crypto = require('crypto');

const VERSION = 'v1';

function getKey() {
  const b64 = (process.env.CREDENTIAL_ENC_KEY || '').trim();
  if (!b64) throw new Error('CREDENTIAL_ENC_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENC_KEY must decode to exactly 32 bytes (generate with: openssl rand -base64 32)');
  }
  return key;
}

function encrypt(plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(payload, aad) {
  const [version, iv, tag, ct] = String(payload).split(':');
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error('Unrecognized ciphertext format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
