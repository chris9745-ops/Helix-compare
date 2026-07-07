module.exports = function errorHandler(err, req, res, next) {
  console.error('[Error]', err.message);

  // Axios errors from Helix
  if (err.response) {
    const status = err.response.status;
    const helixMsg = err.response.data?.messageText || err.response.data?.message || err.response.statusText;
    return res.status(status).json({
      error: helixMsg || 'Helix API error',
      helixStatus: status,
      detail: err.response.data
    });
  }

  // Network / timeout
  if (err.code === 'ECONNREFUSED') {
    return res.status(502).json({ error: 'Cannot reach Helix server — connection refused' });
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Helix server timed out' });
  }
  if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'CERT_HAS_EXPIRED') {
    return res.status(502).json({ error: 'SSL certificate error — enable "Ignore SSL" for this connection' });
  }

  res.status(500).json({ error: err.message || 'Internal server error' });
};
