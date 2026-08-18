'use strict';
/**
 * Function Compute (Aliyun FC 3.0, nodejs20 built-in runtime) adapter.
 * The zip root must contain this file as index.js. FC invokes the handler
 * per request; there is no listening port on FC (see lib/core.js which is
 * shared with the local server).
 *
 * NOTE: FC nodejs20 has no node:sqlite — set STORAGE=json so the app uses
 * the atomic JSON-file store (data/ is under /tmp on FC; see RUNBOOK).
 */
const { openStore } = require('./lib/storage');
const { handleRequest } = require('./lib/core');
const handlers = require('./lib/handlers');

const store = openStore();
try { require('./lib/stack-builder').migrate(store); } catch (e) { /* non-fatal */ }
try { require('./lib/seed').seedStore(store); } catch (e) { /* idempotent, non-fatal */ }
handlers.configure({ baseUrl: process.env.BASE_URL || '' });

exports.handler = (event, context, callback) => {
  let req;
  try { req = JSON.parse(event.toString()); } catch { return callback(null, { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"error":"bad event"}' }); }

  const method = (req.requestContext && req.requestContext.http && req.requestContext.http.method) || 'GET';
  const path = req.rawPath || (req.requestContext && req.requestContext.http && req.requestContext.http.path) || '/';
  const bodyRaw = req.isBase64Encoded ? Buffer.from(req.body || '', 'base64').toString('utf8') : (req.body || '');
  const query = req.queryParameters || {};

  handleRequest(store, { method, path, query, headers: req.headers || {}, bodyRaw, ip: (req.requestContext && req.requestContext.http && req.requestContext.http.sourceIp) || '' })
    .then((result) => {
      const headers = { ...result.headers };
      if (Buffer.isBuffer(result.body)) {
        return callback(null, { statusCode: result.status, headers, body: result.body.toString('base64'), isBase64Encoded: true });
      }
      callback(null, { statusCode: result.status, headers, body: result.body });
    })
    .catch((err) => {
      console.error(err);
      callback(null, { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'Internal server error' });
    });
};
