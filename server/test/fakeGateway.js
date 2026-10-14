// Stand-in for the Kaazing gateway process: listens on the given ports until told to stop.
// argv: <port>... [--exit-with <code> <message>]
const net = require('node:net');
const args = process.argv.slice(2).filter((a) => a !== 'org.kaazing.gateway.server.Main');
const ix = args.indexOf('--exit-with');
if (ix !== -1) {
  console.error(args.slice(ix + 2).join(' '));
  process.exit(Number(args[ix + 1]));
}
const servers = args.filter((a) => /^\d+$/.test(a)).map((p) => net.createServer((s) => s.end()).listen(Number(p), '127.0.0.1'));
process.on('SIGTERM', () => { servers.forEach((s) => s.close()); process.exit(0); });
console.log(`fake gateway listening on ${args.join(',')}`);
setInterval(() => {}, 1000);
