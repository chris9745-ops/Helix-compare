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

if (require.main === module) {
  start().catch(err => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use — is another copy of Helix Dev Tool running?`
      : err);
    process.exit(1);
  });
}

module.exports = { app, start };
