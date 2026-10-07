const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBaseUrl } = require('../lib/urlGuard');
const { isEmailAllowed } = require('../config');

test('validateBaseUrl: local mode accepts http/https, trims trailing slash', () => {
  assert.equal(validateBaseUrl('https://helix.example.com/'), 'https://helix.example.com');
  assert.equal(validateBaseUrl('http://localhost:8008'), 'http://localhost:8008');
  assert.equal(validateBaseUrl('  https://a.example.com/path/  '), 'https://a.example.com/path');
});

test('validateBaseUrl: rejects non-URLs and other schemes', () => {
  for (const bad of ['', '   ', 'helix.example.com', 'ftp://x.example.com', 'javascript:alert(1)', null, 42]) {
    assert.throws(() => validateBaseUrl(bad), (e) => e.status === 400, `should reject ${JSON.stringify(bad)}`);
  }
});

test('validateBaseUrl: hosted mode accepts public https hosts', () => {
  assert.equal(validateBaseUrl('https://tenant-dev-restapi.onbmc.com', { hosted: true }), 'https://tenant-dev-restapi.onbmc.com');
  assert.equal(validateBaseUrl('https://8.8.8.8', { hosted: true }), 'https://8.8.8.8');
});

test('validateBaseUrl: hosted mode blocks http and internal targets (SSRF)', () => {
  const blocked = [
    'http://helix.example.com',
    'https://localhost', 'https://foo.localhost', 'https://127.0.0.1', 'https://127.1',
    'https://2130706433',                // decimal form of 127.0.0.1
    'https://10.1.2.3', 'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.1',
    'https://169.254.169.254',           // cloud metadata
    'https://100.64.0.1',
    'https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]',
    'https://intranet', 'https://printer.local', 'https://svc.internal'
  ];
  for (const url of blocked) {
    assert.throws(() => validateBaseUrl(url, { hosted: true }), (e) => e.status === 400, `should block ${url}`);
  }
});

test('validateBaseUrl: hosted mode does not over-block public look-alikes', () => {
  assert.doesNotThrow(() => validateBaseUrl('https://172.15.0.1', { hosted: true }));  // just outside 172.16/12
  assert.doesNotThrow(() => validateBaseUrl('https://192.169.0.1', { hosted: true }));
});

test('isEmailAllowed: exact match, case-insensitive', () => {
  const list = ['chris@example.com'];
  assert.equal(isEmailAllowed('Chris@Example.com', list), true);
  assert.equal(isEmailAllowed('other@example.com', list), false);
  assert.equal(isEmailAllowed('', list), false);
  assert.equal(isEmailAllowed(undefined, list), false);
});

test('isEmailAllowed: @domain entries match the whole domain only', () => {
  const list = ['@corp.com'];
  assert.equal(isEmailAllowed('anyone@corp.com', list), true);
  assert.equal(isEmailAllowed('anyone@evilcorp.com', list), false);
  assert.equal(isEmailAllowed('anyone@corp.com.evil.io', list), false);
});

test('isEmailAllowed: an empty allowlist allows nobody', () => {
  assert.equal(isEmailAllowed('chris@example.com', []), false);
});
