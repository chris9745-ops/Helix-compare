const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Regression guard for a bug that only showed up after deploying: firebase-admin 14 -> jwks-rsa 4 ->
// jose 6 (ESM-only). Newer Node versions let CommonJS require() ES modules, so everything passed
// locally, but Netlify's function runtime can't, and every sign-in failed with ERR_REQUIRE_ESM.
//
// This loads the Firebase libraries in a child Node process with that capability switched OFF,
// reproducing Netlify's runtime. If someone upgrades firebase-admin past what Netlify can run,
// this fails here instead of in production.
test('Firebase libraries load without require(esm) support (as on Netlify\'s runtime)', () => {
  const script = [
    "require('jwks-rsa')",
    "require('firebase-admin/app')",
    "require('firebase-admin/auth')",
    "require('firebase-admin/firestore')"
  ].join(';');

  let run = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', script], { encoding: 'utf8' });
  // Older Node doesn't know the flag — but it also has no require(esm), so run it plain.
  if (/bad option/.test(run.stderr)) run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(run.status, 0, `Loading the Firebase libraries failed:\n${run.stderr}`);
});
