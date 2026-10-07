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

function textSnippet(data, max = 200) {
  if (typeof data !== 'string') return '';
  return data
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')              // title + CSS in the page head are noise
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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

// What a network-level failure means, in words a user can act on
const NETWORK_ERRORS = {
  ECONNRESET: 'The connection to Helix was reset mid-request. Try again. If it keeps happening: some Helix servers refuse searches with no qualification (add a Company filter or an extra qualification), and very large forms can also trigger it (narrow the search or limit "Fields to compare").',
  EPIPE: 'The connection to Helix was dropped mid-request. This is usually temporary — try again.',
  ENOTFOUND: 'Could not find that Helix address (DNS lookup failed) — check the Base URL.',
  EAI_AGAIN: 'The DNS lookup for Helix failed temporarily — try again.',
  EHOSTUNREACH: 'Cannot reach the Helix server (host unreachable).',
  ENETUNREACH: 'Cannot reach the Helix server (network unreachable).'
};

// Where the failing request was going (host + path only — no query, no credentials)
function requestTarget(err) {
  try {
    const url = new URL(err.config.url, err.config.baseURL);
    return `${(err.config.method || 'get').toUpperCase()} ${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

module.exports = function errorHandler(err, req, res, next) {
  // Set by routes that call two instances at once, so users know which side failed
  const context = err.helixContext ? `${err.helixContext}: ` : '';

  // Errors from Helix (or something in front of it): keep the status, say what it said
  if (err.response) {
    const message = context + describeUpstreamError(err.response);
    console.error('[Error]', err.message, '|', requestTarget(err), '| upstream says:', message);
    return res.status(err.response.status).json({
      error: message,
      helixStatus: err.response.status,
      detail: parseBody(err.response.data)
    });
  }

  console.error('[Error]', err.message, requestTarget(err) ? `| ${requestTarget(err)}` : '');

  if (NETWORK_ERRORS[err.code]) {
    return res.status(502).json({ error: context + NETWORK_ERRORS[err.code], code: err.code });
  }

  // Network / timeout
  if (err.code === 'ECONNREFUSED') {
    return res.status(502).json({ error: context + 'Cannot reach Helix server — connection refused' });
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
    return res.status(504).json({ error: context + 'Helix server timed out' });
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
