/**
 * Loopback HTTP server: answers GET and HEAD on `/` with a constant
 * plain-text greeting and refuses every other request with an explicit 4xx.
 *
 * Each flow is a small named function so it can be read and changed alone:
 *   - applySecurityHeaders / send / sendStatus: how every response is written.
 *   - requestPath / declaresOversizeBody / carriesBody / capRequestBody:
 *     what is inspected on the request.
 *   - handleRequest / respond: the dispatch order
 *     (declared body size -> response -> streamed body size).
 *   - handleExpectContinue / handleUnsupportedExpectation: `Expect` handling.
 *
 * Per-request work is a few header reads, one indexOf, one Map lookup and a
 * handful of setHeader calls. There is no URL parsing, no regular expression
 * and no dependency beyond Node's built-in http module.
 */
const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

/**
 * Hardening headers carried by every response the application writes
 * (CWE-693). Bodies are always inert plain text, so the policy denies every
 * fetch, all framing, caching, referrer leakage and powerful browser features.
 * X-Frame-Options duplicates `frame-ancestors` for clients without CSP 2.
 */
const SECURITY_HEADERS = Object.freeze([
  Object.freeze(['X-Content-Type-Options', 'nosniff']),
  Object.freeze(['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"]),
  Object.freeze(['X-Frame-Options', 'DENY']),
  Object.freeze(['Cache-Control', 'no-store']),
  Object.freeze(['Referrer-Policy', 'no-referrer']),
  Object.freeze(['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()']),
]);

/** Media type of every body this server writes, with an explicit charset. */
const CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Largest request body, in bytes, the server reads before refusing the
 * request. No route consumes a body, so the cap only bounds how much an
 * abusive client can make the server read.
 */
const MAX_BODY_BYTES = 1024;

/**
 * Explicit route table: exact request path -> allowed methods and the
 * constant body served on success. A Map keeps lookups free of prototype
 * keys such as `__proto__`. Any path not listed here is answered 404.
 */
const ROUTES = new Map([
  ['/', Object.freeze({ methods: Object.freeze(['GET', 'HEAD']), body: 'Hello, World!\n' })],
]);

/**
 * Sets the hardening headers on a response that has not been written yet.
 *
 * @param {http.ServerResponse} res
 */
function applySecurityHeaders(res) {
  for (const [name, value] of SECURITY_HEADERS) {
    res.setHeader(name, value);
  }
}

/**
 * Writes a complete plain-text response. It is the single place a response
 * is written, so no status can leave without the hardening headers.
 * Status-specific headers (Allow, Connection) are set by the caller first.
 * Content-Length is explicit so HEAD reports the size GET would send; Node
 * drops the body itself for HEAD.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} body
 */
function send(res, statusCode, body) {
  applySecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', CONTENT_TYPE);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/**
 * Writes an error response whose body is the standard reason phrase,
 * for example `Not Found\n`. It reveals nothing about the server.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 */
function sendStatus(res, statusCode) {
  send(res, statusCode, `${http.STATUS_CODES[statusCode]}\n`);
}

/**
 * Returns the request path: the request target up to the first `?`. It is
 * matched exactly, with no decoding or normalisation, so `/../`, `/%2F` and
 * absolute-form targets never alias a route.
 *
 * @param {string} url
 * @returns {string}
 */
function requestPath(url) {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Reports whether the declared Content-Length exceeds MAX_BODY_BYTES. Node's
 * parser has already rejected malformed or conflicting lengths with 400, so
 * the header is a plain decimal string here.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function declaresOversizeBody(req) {
  const declared = req.headers['content-length'];
  return declared !== undefined && Number(declared) > MAX_BODY_BYTES;
}

/**
 * Reports whether the request frames a body, by length or by chunking.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function carriesBody(req) {
  return req.headers['content-length'] !== undefined
    || req.headers['transfer-encoding'] !== undefined;
}

/**
 * Consumes and discards the request body, destroying the connection once
 * more than MAX_BODY_BYTES have arrived. This bounds chunked bodies, whose
 * size is not declared up front, and replaces Node's default of reading an
 * unread body to its end. Call it only after the response has been written,
 * so destroying the socket can never cut a response short.
 *
 * @param {http.IncomingMessage} req
 */
function capRequestBody(req) {
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES && !req.destroyed) {
      req.destroy();
    }
  });
}

/**
 * Answers a request whose declared body is within the cap: 404 for an
 * unknown path, 405 with Allow for a method the route does not accept,
 * otherwise 200 with the route's body.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function respond(req, res) {
  const route = ROUTES.get(requestPath(req.url));
  if (route === undefined) {
    sendStatus(res, 404);
    return;
  }
  if (!route.methods.includes(req.method)) {
    res.setHeader('Allow', route.methods.join(', '));
    sendStatus(res, 405);
    return;
  }
  send(res, 200, route.body);
}

/**
 * Request listener. A declared oversize body is refused with 413 before
 * routing, and the connection is closed rather than drained. Any other
 * request is answered, then its body, if it frames one, is capped.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleRequest(req, res) {
  if (declaresOversizeBody(req)) {
    res.setHeader('Connection', 'close');
    sendStatus(res, 413);
    return;
  }
  respond(req, res);
  if (carriesBody(req)) {
    capRequestBody(req);
  }
}

/**
 * `Expect: 100-continue` listener. It never sends 100 Continue, because no
 * route reads a body: the client receives the final response before sending
 * one, and the connection closes so an unsent body is never awaited.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleExpectContinue(req, res) {
  res.setHeader('Connection', 'close');
  handleRequest(req, res);
}

/**
 * Listener for any other `Expect` value: 417 Expectation Failed, with the
 * hardening headers that Node's built-in 417 would omit.
 *
 * @param {http.IncomingMessage} _req Unused; the response does not depend on it.
 * @param {http.ServerResponse} res
 */
function handleUnsupportedExpectation(_req, res) {
  res.setHeader('Connection', 'close');
  sendStatus(res, 417);
}

const server = http.createServer(handleRequest);
server.on('checkContinue', handleExpectContinue);
server.on('checkExpectation', handleUnsupportedExpectation);

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
