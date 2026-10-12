// Runs the helper's reflective overload matching under a real JDK (Nashorn, Java 8–14), using
// PrintStream.println — which, like the AR API's getListActiveLink, has same-arity overloads taking a
// String, a long, an int and a boolean. Regression guard for: asking for a form's workflow passed the
// form name to a `long` overload and died with `For input string: "CTM:People"`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, '../../workflow-helper/ar-helper.js');
const src = fs.readFileSync(HELPER, 'utf8');
const m = /\/\/ invoke:begin[\s\S]*?\/\/ invoke:end/.exec(src);

function runNashorn(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-invoke-'));
  const file = path.join(dir, 'case.js');
  fs.writeFileSync(file, `${m[0]}\n${body}`);
  try {
    const r = spawnSync('java', ['jdk.nashorn.tools.Shell', file], { encoding: 'utf8', timeout: 30000 });
    return { ...r, text: `${r.stdout || ''}${r.stderr || ''}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const probe = runNashorn("print('nashorn-ok');");
const available = probe.status === 0 && /nashorn-ok/.test(probe.text);

test('the invoke block is extractable from the helper', () => {
  assert.ok(m, 'invoke:begin / invoke:end markers must stay in ar-helper.js');
  assert.match(m[0], /function invokeOn\(/);
});

test('overloads are chosen by argument type, never by coercing a string to a number', { skip: !available && 'needs Java 8–14 with Nashorn' }, () => {
  const r = runNashorn(`
    var baos = new java.io.ByteArrayOutputStream();
    var ps = new java.io.PrintStream(baos, true);
    var out = {};
    function t(label, f) {
      baos.reset();
      try { f(); out[label] = { wrote: String(baos.toString()).replace(/\\r?\\n$/, '') }; }
      catch (e) { out[label] = { error: String(e.message || e) }; }
    }
    // run the string case repeatedly: getMethods() order is a JVM detail, so don't depend on one order
    for (var i = 0; i < 25; i++) t('form' + i, function () { invokeOn(ps, 'println', ['CTM:People']); });
    t('number',  function () { invokeOn(ps, 'println', [42]); });
    t('epoch',   function () { invokeOn(ps, 'println', [1700000000000]); });
    t('boolean', function () { invokeOn(ps, 'println', [true]); });
    t('digitsAsString', function () { invokeOn(ps, 'println', ['007']); });
    t('badType', function () { invokeOn(ps, 'println', [{ a: 1 }]); });
    t('badArity', function () { invokeOn(ps, 'println', [1, 2, 3]); });
    print(JSON.stringify(out));
  `);
  assert.equal(r.status, 0, r.text);
  const out = JSON.parse(r.text.trim().split('\n').pop());
  for (let i = 0; i < 25; i++) assert.deepEqual(out[`form${i}`], { wrote: 'CTM:People' });
  assert.deepEqual(out.number, { wrote: '42' });
  assert.deepEqual(out.epoch, { wrote: '1700000000000' }, 'a value too big for int goes to the long overload');
  assert.deepEqual(out.boolean, { wrote: 'true' });
  assert.deepEqual(out.digitsAsString, { wrote: '007' }, 'a numeric-looking string stays a string (no 7)');
  assert.match(out.badType.error, /No println overload accepts arguments of those types/);
  assert.match(out.badArity.error, /No println overload takes 3 argument/);
});
