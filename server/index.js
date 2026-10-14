// Local entry point — used by `npm run dev`, `npm start`, and the Electron
// desktop app. (The hosted site uses netlify/functions/api.js instead.)

const { createApp } = require('./app');

// Fixed — the Vite dev server proxy (client/vite.config.js) always targets
// localhost:3001, so this can't be overridden by an ambient PORT env var.
const PORT = 3001;

const app = createApp({ serveClient: true });

function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`\n🚀 Helix Dev Tool server running on http://localhost:${server.address().port}\n`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Start the gateway on launch when the user turned that on. Deliberately not inside start(), which
// the tests call; only the real entry points (here and Electron's main) do this.
function autoStartGateway() {
  if (require('./config').isHosted()) return;
  require('./lib/gateway').getGateway().autoStartIfConfigured();
}

if (require.main === module) {
  start().then(autoStartGateway).catch(err => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use — is another copy of Helix Dev Tool running?`
      : err);
    process.exit(1);
  });
}

module.exports = { app, start, autoStartGateway };
