// Netlify Function: the whole Express API behind /api/*.
//
// This is the hosted entry point, so it forces hosted mode itself — if the
// HELIX_MODE env var were ever forgotten in the Netlify UI, the function would
// otherwise come up in local mode (no login). Failing closed matters more.
process.env.HELIX_MODE = 'hosted';

const serverless = require('serverless-http');
const { createApp } = require('../../server/app');

const handler = serverless(createApp());

// Netlify may hand us either the original path (/api/connections) or the
// function path (/.netlify/functions/api/connections), depending on whether the
// request came through the /api/* redirect or was called directly. Normalize
// both to the /api/... form Express routes on.
exports.handler = async (event, context) => {
  let path = (event.path || '/').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!path.startsWith('/api')) path = '/api' + (path === '/' ? '' : path);
  return handler({ ...event, path }, context);
};
