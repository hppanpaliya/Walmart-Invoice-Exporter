/**
 * Local mock of walmart.com for extension e2e tests.
 *
 * Chromium is pointed at a local HTTP proxy; CONNECT tunnels for walmart
 * hosts terminate at a local HTTPS server presenting a freshly generated
 * self-signed cert (accepted via --ignore-certificate-errors). Everything
 * else is refused, so tests can NEVER reach the real Walmart — including
 * tabs the extension opens itself, which bypass Playwright's route API.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const listPayload = require(path.join(REPO_ROOT, 'tests', 'fixtures', 'purchase-history.json'));
const detailPayload = require(path.join(REPO_ROOT, 'tests', 'fixtures', 'order-detail.json'));

const ALLOWED_HOSTS = /(^|\.)walmart\.com$|(^|\.)walmartimages\.com$/;

function buildListPayload() {
  const payload = JSON.parse(JSON.stringify(listPayload));
  payload.props.pageProps.initialData.data.purchaseHistory.pageInfo = {};
  return payload;
}

function mockHtml(title, payload) {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>', title, '</title></head><body>',
    `<h1>${title}</h1>`,
    '<script id="__NEXT_DATA__" type="application/json">',
    JSON.stringify(payload),
    '</script></body></html>',
  ].join('');
}

/** Generate a throwaway self-signed cert for www.walmart.com (2-day TTL). */
function generateCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=www.walmart.com',
    '-addext', 'subjectAltName=DNS:www.walmart.com,DNS:*.walmart.com,DNS:*.walmartimages.com',
  ], { stdio: 'pipe' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir };
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'https://www.walmart.com');
  if (/^\/orders\/\d+/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(mockHtml('Order details', detailPayload));
    return;
  }
  if (url.pathname.startsWith('/orders')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(mockHtml('Purchase history', buildListPayload()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>mock walmart</body></html>');
}

/**
 * Start the mock: HTTPS origin + CONNECT proxy.
 * @returns {Promise<{proxyPort: number, close: () => Promise<void>}>}
 */
async function startMockWalmart() {
  const { key, cert, dir } = generateCert();

  const origin = https.createServer({ key, cert }, handleRequest);
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port;

  const proxy = net.createServer((clientSocket) => {
    clientSocket.once('data', (chunk) => {
      const header = chunk.toString('utf8');
      const match = /^CONNECT\s+([^\s:]+):(\d+)/.exec(header);
      if (!match || !ALLOWED_HOSTS.test(match[1])) {
        clientSocket.end('HTTP/1.1 502 Blocked by test harness\r\n\r\n');
        return;
      }
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    clientSocket.on('error', () => {});
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  return {
    proxyPort: proxy.address().port,
    close: async () => {
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => origin.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startMockWalmart };
