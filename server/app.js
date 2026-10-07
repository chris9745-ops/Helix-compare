require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const { isHosted } = require('./config');
const { createAuthMiddleware } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

// Builds the Express app without starting a listener, so the exact same app
// runs as a local server (index.js / Electron) and inside the Netlify function.
//
//   serveClient    — also serve the built React app from client/dist (desktop/
//                    local builds). On Netlify the CDN serves it instead.
//   verifyIdToken  — override how Firebase ID tokens are verified (tests).
function createApp({ serveClient = false, verifyIdToken } = {}) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(morgan('dev'));
  // 2 MB: a pasted list of ~2,000+ forms is well over the 100 kB default
  app.use(express.json({ limit: '2mb' }));

  // Health check stays public (no data, used for uptime checks)
  app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // Everything else under /api needs an identified caller
  app.use('/api', createAuthMiddleware({ verifyIdToken }));

  app.get('/api/me', (req, res) => res.json({ email: req.user.email, hosted: isHosted() }));
  app.use('/api/connections', require('./routes/connections'));
  app.use('/api/helix', require('./routes/helix'));
  app.use('/api/compare', require('./routes/compare'));

  // Unknown /api paths get a JSON 404 rather than falling through to the SPA
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built React app when it exists (desktop / production builds). In
  // dev, Vite's own server on :5173 handles the frontend and proxies /api here.
  const clientDist = path.join(__dirname, '../client/dist');
  if (serveClient && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handler must be last
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
