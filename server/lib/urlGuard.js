// Validates a connection's base URL before it's saved.
//
// In hosted mode the server makes outbound requests to whatever URL a signed-in
// user saves, so we refuse non-HTTPS and loopback/private/link-local targets
// (basic SSRF protection). This checks the hostname as written; it does not
// resolve DNS, which is acceptable because only allowlisted users can add
// connections.

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') ||
    h.startsWith('fe80') || h.startsWith('::ffff:');
}

function isInternalHostname(host) {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
    h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':');
}

// Returns the URL string with any trailing slash removed, or throws a 400.
function validateBaseUrl(raw, { hosted = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('baseUrl is required');

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('baseUrl must be a full URL, e.g. https://your-instance.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('baseUrl must start with http:// or https://');
  }

  if (hosted) {
    if (url.protocol !== 'https:') throw badRequest('The hosted site only connects to https:// instances');
    const host = url.hostname;
    if (isPrivateIPv4(host) || isPrivateIPv6(host) || isInternalHostname(host)) {
      throw badRequest('The hosted site can only reach public Helix instances (not localhost/private network addresses)');
    }
  }

  return url.toString().replace(/\/$/, '');
}

module.exports = { validateBaseUrl };
