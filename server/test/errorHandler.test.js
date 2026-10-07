const test = require('node:test');
const assert = require('node:assert/strict');
const errorHandler = require('../middleware/errorHandler');

// Drive the handler directly with a fake axios-style error
function run(err) {
  let out;
  const res = { status(code) { out = { code }; return this; }, json(body) { out.body = body; return this; } };
  const log = console.error; console.error = () => {};
  try { errorHandler(err, {}, res, () => {}); } finally { console.error = log; }
  return out;
}
const upstream = (status, data, statusText = '') =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, statusText, data } });

test("BMC's usual JSON-array body (already parsed) gives the real message", () => {
  const r = run(upstream(404, [{ messageType: 'ERROR', messageText: 'Form does not exist on server', messageAppendedText: 'NN:Nope', messageNumber: 303 }]));
  assert.equal(r.code, 404);
  assert.equal(r.body.error, 'Form does not exist on server: NN:Nope');
  assert.equal(r.body.helixStatus, 404);
});

test('the same body arriving as a raw string (login uses responseType text) is parsed too', () => {
  const raw = JSON.stringify([{ messageType: 'ERROR', messageText: 'Authentication failed', messageAppendedText: 'someone', messageNumber: 623 }]);
  const r = run(upstream(401, raw, 'Unauthorized'));
  assert.equal(r.code, 401);
  assert.equal(r.body.error, 'Authentication failed: someone');
  assert.ok(Array.isArray(r.body.detail), 'detail is returned parsed');
});

test('a JSON object body with a message field', () => {
  assert.equal(run(upstream(400, { message: 'Bad request thing' })).body.error, 'Bad request thing');
});

test('an HTML block page with an EMPTY status text (e.g. an edge firewall) names the status and the page text', () => {
  const html = '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>Reference #18.4f2c</p></body></html>';
  const r = run(upstream(403, html, ''));
  assert.equal(r.code, 403);
  assert.match(r.body.error, /^Helix returned HTTP 403 — /);
  assert.match(r.body.error, /Access Denied/);
  assert.doesNotMatch(r.body.error, /<|>/, 'markup is stripped');
});

test('no body and no status text still says the HTTP status, not a generic message', () => {
  const r = run(upstream(502, '', ''));
  assert.equal(r.body.error, 'Helix returned HTTP 502 with no message');
});

test('status text is included when present and no message is available', () => {
  assert.match(run(upstream(500, '', 'Internal Server Error')).body.error, /HTTP 500 Internal Server Error/);
});

test("a Tomcat 404 page surfaces the path that wasn't found, not the page's CSS", () => {
  const tomcat = '<!doctype html><html lang="en"><head><title>HTTP Status 404 \u2013 Not Found</title>' +
    '<style type="text/css">body {font-family:Tahoma,Arial,sans-serif;} h1, h2, h3, b {color:white;background-color:#525D76;}</style></head>' +
    '<body><h1>HTTP Status 404 \u2013 Not Found</h1><hr class="line" /><p><b>Type</b> Status Report</p>' +
    '<p><b>Message</b> /api/jwt/login/api/jwt/login</p><p><b>Description</b> The origin server did not find a current representation ' +
    'for the target resource or is not willing to disclose that one exists.</p><hr class="line" /><h3>Apache Tomcat/9.0.1</h3></body></html>';
  const r = run(upstream(404, tomcat, ''));
  assert.equal(r.code, 404);
  assert.match(r.body.error, /Message \/api\/jwt\/login\/api\/jwt\/login/);
  assert.doesNotMatch(r.body.error, /font-family|Tahoma|#525D76/);
});

test('long page text is truncated', () => {
  const r = run(upstream(403, 'x'.repeat(5000)));
  assert.ok(r.body.error.length < 260, `was ${r.body.error.length}`);
});

test('non-upstream errors are unchanged', () => {
  assert.equal(run(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code, 502);
  assert.equal(run(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code, 504);
  assert.equal(run(Object.assign(new Error('nope'), { status: 404 })).body.error, 'nope');
  assert.equal(run(new Error('boom')).code, 500);
});
