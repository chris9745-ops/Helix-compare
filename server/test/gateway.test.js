const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { GatewayManager, parseGatewayConfig, findGatewayHome } = require('../lib/gateway');

const FAKE = path.join(__dirname, 'fakeGateway.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** A gateway folder shaped like KWIC's, with a config that uses ${property} ports like BMC's. */
function makeGateway(root, ports) {
  const dir = path.join(root, 'kwic');
  fs.mkdirSync(path.join(dir, 'conf'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'conf', 'kwic-config.xml'), `<?xml version="1.0"?>
<gateway-config>
  <properties>
    <property><name>gateway.ip</name><value>127.0.0.1</value></property>
    <property><name>gateway.hostname</name><value>localhost</value></property>
    <property><name>gateway.base.port</name><value>${ports.mgmt}</value></property>
    <property><name>port.dev-arapi</name><value>${ports.dev}</value></property>
    <property><name>port.prod-arapi</name><value>${ports.prod}</value></property>
    <property><name>secret.token</name><value>SHOULD-NEVER-APPEAR-IN-OUTPUT</value></property>
  </properties>
  <service>
    <name>commandcenter</name>
    <accept>http://\${gateway.hostname}:\${gateway.base.port}/commandcenter</accept>
    <type>directory</type>
  </service>
  <service>
    <name> hms dev arapi access</name>
    <accept>tcp://\${gateway.ip}:\${port.dev-arapi}</accept>
    <type>proxy</type>
    <connect>wss://example.invalid/arapi</connect>
  </service>
  <service>
    <name> hms prod arapi access</name>
    <accept>tcp://\${gateway.ip}:\${port.prod-arapi}</accept>
    <accept>tcp://\${gateway.ip}:\${port.unknown-thing}</accept>
    <type>proxy</type>
  </service>
</gateway-config>`);
  return dir;
}

async function setup(t, { spawnFn, extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ports = { mgmt: await freePort(), dev: await freePort(), prod: await freePort() };
  const dir = makeGateway(path.join(root, 'gateway'), ports);
  const mgr = new GatewayManager({
    dataDir,
    javaPath: () => 'java',
    // ignore the java command line: run the stand-in on the configured ports instead
    spawnFn: spawnFn || ((cmd, args, opts) => spawn(process.execPath, [FAKE, 'org.kaazing.gateway.server.Main', String(ports.dev), String(ports.prod)], opts)),
    startTimeoutMs: 8000, stopTimeoutMs: 3000, env: {}, ...extra
  });
  t.after(async () => { mgr.killNow(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, dir, ports, mgr };
}

// ── config parsing + discovery ───────────────────────────────────────────────

test('ports are resolved from the config properties; secrets, http and unresolved entries are not exposed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cfg-'));
  const dir = makeGateway(root, { mgmt: 8000, dev: 46000, prod: 48000 });
  const xml = fs.readFileSync(path.join(dir, 'conf', 'kwic-config.xml'), 'utf8');
  const services = parseGatewayConfig(xml);
  assert.deepEqual(services.map((s) => [s.name, s.port]), [['hms dev arapi access', 46000], ['hms prod arapi access', 48000]]);
  assert.ok(!JSON.stringify(services).includes('SHOULD-NEVER-APPEAR'));
  fs.rmSync(root, { recursive: true, force: true });
});

test("property and service names with attributes (BMC's real config uses desc=\"…\") still resolve", () => {
  const xml = `<gateway-config><properties>
    <property><name desc="Local client gateway IP">gateway.ip</name><value>127.0.0.1</value></property>
    <property><name desc="Local client gateway Devlopment port">port.dev-arapi</name><value>46000</value></property>
  </properties>
  <service><name desc="dev">hms dev arapi access</name><accept>tcp://\${gateway.ip}:\${port.dev-arapi}</accept></service>
  </gateway-config>`;
  assert.deepEqual(parseGatewayConfig(xml), [{ name: 'hms dev arapi access', host: '127.0.0.1', port: 46000 }]);
});

test('findGatewayHome accepts the folder, its parent, or a kwic-* child, and rejects anything else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-find-'));
  const dir = makeGateway(path.join(root, 'gateway'), { mgmt: 1, dev: 2, prod: 3 });
  assert.equal(findGatewayHome(dir), dir);
  assert.equal(findGatewayHome(path.dirname(dir)), dir);
  const versioned = path.join(root, 'zip', 'kwic-5.9.13');
  fs.mkdirSync(path.dirname(versioned), { recursive: true });
  fs.cpSync(dir, versioned, { recursive: true });
  assert.equal(findGatewayHome(path.dirname(versioned)), versioned);
  assert.equal(findGatewayHome(path.join(root, 'nope')), null);
  assert.equal(findGatewayHome(root), null);
  assert.equal(findGatewayHome(''), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('start brings the ports up, stop takes them down, and the log records both', async (t) => {
  const { mgr, ports, dir } = await setup(t, {});
  // default location is <dataDir>/../gateway, which the fixture builds
  let s = await mgr.status();
  assert.equal(s.state, 'stopped');
  assert.deepEqual(s.services.map((x) => x.port).sort(), [ports.dev, ports.prod].sort());
  assert.equal(s.source, 'default');

  s = await mgr.start();
  assert.equal(s.state, 'running');
  assert.ok(s.pid > 0);
  assert.ok(s.services.every((x) => x.listening));
  assert.ok(s.startedAt);
  assert.ok(mgr.log().some((l) => l.includes('fake gateway listening')));
  for (const d of ['bin', 'temp', 'log']) {
    assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), `${d}/ must exist for the gateway to start`);
  }

  // a second start is a no-op, not a second process
  assert.equal((await mgr.start()).pid, s.pid);

  s = await mgr.stop();
  assert.equal(s.state, 'stopped');
  assert.ok(s.services.every((x) => !x.listening));
  assert.ok(mgr.log().some((l) => l.includes('gateway stopped')));
});

test('something already listening that this app did not start is reported as external, and not touched', async (t) => {
  const { mgr, ports } = await setup(t, {});
  const squatter = net.createServer().listen(ports.dev, '127.0.0.1');
  await new Promise((r) => squatter.once('listening', r));
  t.after(() => squatter.close());

  const s = await mgr.status();
  assert.equal(s.state, 'external');
  await assert.rejects(mgr.start(), (e) => e.status === 409 && /already running/.test(e.message));
  await assert.rejects(mgr.stop(), (e) => e.status === 409 && /Ctrl-C/.test(e.message));
});

test('a gateway that dies on startup reports why, instead of hanging on "starting"', async (t) => {
  const { mgr } = await setup(t, {
    spawnFn: (cmd, args, opts) => spawn(process.execPath, [FAKE, '--exit-with', '3', 'Address already in use: bind'], opts)
  });
  await assert.rejects(mgr.start(), (e) => e.status === 500 && /stopped right after starting/.test(e.message) && /Address already in use/.test(e.message));
  assert.equal((await mgr.status()).state, 'stopped');
});

test('a missing Java is a clear 400 pointing at Setup', async (t) => {
  const { mgr } = await setup(t, {
    spawnFn: (cmd, args, opts) => spawn('/definitely/not/java', args, opts)
  });
  await assert.rejects(mgr.start(), (e) => e.status === 400 && /Java was not found/.test(e.message));
});

test('no gateway folder = unconfigured, and start says what to do', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-none-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const mgr = new GatewayManager({ dataDir, env: {} });
  assert.equal((await mgr.status()).state, 'unconfigured');
  await assert.rejects(mgr.start(), (e) => e.status === 400 && /conf\/kwic-config\.xml/.test(e.message));
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings: a valid folder is stored (resolved), a bad one is refused, auto-start toggles', async (t) => {
  const { mgr, root, dir } = await setup(t, {});
  mgr.saveSettings({ gatewayDir: path.dirname(dir) });
  assert.equal((await mgr.status()).source, 'settings');
  assert.equal(mgr.settings().gatewayDir, dir, 'stored as the resolved folder, not what was typed');

  assert.throws(() => mgr.saveSettings({ gatewayDir: path.join(root, 'nothing-here') }), (e) => e.status === 400 && /No gateway was found/.test(e.message));
  assert.equal(mgr.settings().gatewayDir, dir, 'a refused value must not overwrite the good one');

  mgr.saveSettings({ autoStart: true });
  assert.equal((await mgr.status()).autoStart, true);
  mgr.saveSettings({ autoStart: false });
  assert.equal((await mgr.status()).autoStart, false);
});

test('auto-start only acts when enabled and the gateway is stopped, and never throws', async (t) => {
  const { mgr } = await setup(t, {});
  assert.equal(await mgr.autoStartIfConfigured(), null, 'off by default');
  mgr.saveSettings({ autoStart: true });
  const s = await mgr.autoStartIfConfigured();
  assert.equal(s.state, 'running');
  assert.equal((await mgr.autoStartIfConfigured()).state, 'running', 'already running: left alone');
  await mgr.stop();

  const broken = await setup(t, { spawnFn: () => { throw new Error('boom'); } });
  broken.mgr.saveSettings({ autoStart: true });
  assert.equal(await broken.mgr.autoStartIfConfigured(), null);
  assert.ok(broken.mgr.log().some((l) => /auto-start failed/.test(l)));
});

test('a gateway this app started before a restart is adopted via its pid file and can be stopped', { skip: process.platform === 'win32' }, async (t) => {
  const { mgr, dataDir, ports } = await setup(t, {});
  // an "old" gateway process, started by a previous run of the app
  const orphan = spawn(process.execPath, [FAKE, 'org.kaazing.gateway.server.Main', String(ports.dev), String(ports.prod)], { stdio: 'ignore' });
  t.after(() => { try { orphan.kill('SIGKILL'); } catch { /* gone */ } });
  fs.writeFileSync(path.join(dataDir, 'gateway.pid'), String(orphan.pid));
  await new Promise((r) => setTimeout(r, 500));

  const s = await mgr.status();
  assert.equal(s.state, 'running', 'adopted, not "external"');
  assert.equal(s.pid, orphan.pid);

  const after = await mgr.stop();
  assert.equal(after.state, 'stopped');
});

test('a stale pid file pointing at an unrelated process is ignored and cleaned up', { skip: process.platform === 'win32' }, async (t) => {
  const { mgr, dataDir } = await setup(t, {});
  fs.writeFileSync(path.join(dataDir, 'gateway.pid'), String(process.pid));   // this test runner: alive, not a gateway
  assert.equal((await mgr.status()).state, 'stopped');
  assert.equal(fs.existsSync(path.join(dataDir, 'gateway.pid')), false);
});
