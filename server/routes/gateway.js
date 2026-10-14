// Start / stop / status of the BMC Client Gateway on this computer. Desktop/local only — a hosted
// server has no gateway of its own and must not run one.
const express = require('express');
const router = express.Router();
const { isHosted } = require('../config');
const gateway = require('../lib/gateway');

router.use((req, res, next) => {
  if (isHosted()) {
    return res.status(501).json({ error: 'The gateway is managed by the desktop app on your own computer.' });
  }
  next();
});

const gw = () => gateway.getGateway();

router.get('/status', async (req, res) => res.json(await gw().status()));

router.post('/start', async (req, res) => res.json(await gw().start()));

router.post('/stop', async (req, res) => res.json(await gw().stop()));

router.get('/log', (req, res) => res.json({ lines: gw().log(parseInt(req.query.lines, 10) || 100) }));

router.put('/settings', async (req, res) => {
  const { gatewayDir, autoStart } = req.body || {};
  gw().saveSettings({ gatewayDir, autoStart });
  res.json(await gw().status());
});

module.exports = router;
