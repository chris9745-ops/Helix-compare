require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const connectionsRouter = require('./routes/connections');
const helixRouter = require('./routes/helix');
const compareRouter = require('./routes/compare');
const errorHandler = require('./middleware/errorHandler');

const app = express();
// Fixed — the Vite dev server proxy (client/vite.config.js) always targets
// localhost:3001, so this can't be overridden by an ambient PORT env var.
const PORT = 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(morgan('dev'));
app.use(express.json());

// API routes
app.use('/api/connections', connectionsRouter);
app.use('/api/helix', helixRouter);
app.use('/api/compare', compareRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve the built React app when it exists (production / packaged Electron
// builds). In dev mode the client/dist folder doesn't exist — Vite's own
// dev server on :5173 handles the frontend instead, proxying /api here.
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler must be last
app.use(errorHandler);

function start() {
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 Helix Dev Tool server running on http://localhost:${PORT}\n`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
