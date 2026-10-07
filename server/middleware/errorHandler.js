const { isHosted } = require('../config');

// Bodies come back in three shapes depending on the call: a parsed JSON array
// (BMC's usual [{ messageType, messageText, messageAppendedText, messageNumber }]),
// a parsed JSON object, or a raw string (the login call asks for text, and an
// edge/WAF block usually returns HTML). Normalise them so we can always say
// something specific rather than a generic "Helix API error".
function parseBody(data) {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return data; }
}

function textSnippet(data, max = 160) {
  if (typeof data !== 'string') return '';
  return data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function describeUpstreamError(response) {
  const body = parseBody(response.data);
  const first = Array.isArray(body) ? body[0] : body;

  const text = first && (first.messageText || first.message || first.error);
  if (text) {
    return first.messageAppendedText ? `${text}: ${first.messageAppendedText}` : String(text);
  }

  // No readable message — at least say what the server returned
  const status = `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`;
  const snippet = textSnippet(body);
  return `Helix returned ${status}${snippet ? ' — ' + snippet : ' with no message'}`;
}

module.exports = function errorHandler(err, req, res, next) {
  // Errors from Helix (or something in front of it): keep the status, say what it said
  if (err.response) {
    const message = describeUpstreamError(err.response);
    console.error('[Error]', err.message, '| upstream says:', message);
    return res.status(err.response.status).json({
      error: message,
      helixStatus: err.response.status,
      detail: parseBody(err.response.data)
    });
  }

  console.error('[Error]', err.message);

  // Network / timeout
  if (err.code === 'ECONNREFUSED') {
    return res.status(502).json({ error: 'Cannot reach Helix server — connection refused' });
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Helix server timed out' });
  }
  if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'CERT_HAS_EXPIRED') {
    return res.status(502).json({
      error: isHosted()
        ? 'SSL certificate error — the hosted site requires a valid certificate; use the desktop app for self-signed instances'
        : 'SSL certificate error — enable "Ignore SSL" for this connection'
    });
  }

  // Errors we raised ourselves with an explicit 4xx (validation, not found…)
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  res.status(500).json({ error: err.message || 'Internal server error' });
};
