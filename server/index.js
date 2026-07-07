require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const connectionsRouter = require('./routes/connections');
const helixRouter = require('./routes/helix');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(morgan('dev'));
app.use(express.json());

// API routes
app.use('/api/connections', connectionsRouter);
app.use('/api/helix', helixRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Error handler must be last
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n🚀 Helix Dev Tool server running on http://localhost:${PORT}\n`);
});
