const assert = require('assert');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// The app is HTTPS-only because a plain-http origin off localhost is not a
// secure context, and a browser then withholds the service worker — no
// installable app, no offline shell, no clipboard. That was a real bug: the PWA
// worked at http://localhost and was silently unavailable at http://192.168.x.x,
// which is how this server is normally reached.
//
// Two things here are worth locking down. The certificate has to keep covering
// this machine without being reissued on every start, and the port has to carry
// a WebSocket — the terminal is a WebSocket, so a demultiplexer that broke the
// upgrade would take the whole app with it while every page still loaded fine.

const ROOT = path.join(__dirname, '..');
const tlsModule = path.join(ROOT, 'dist', 'server', 'services', 'tls.js');

const built = fs.existsSync(tlsModule);
const describeBuilt = built ? describe : describe.skip;
if (!built) {
  console.log('Skipping TLS checks: run `npm run build` first.');
}

describeBuilt('TLS material', function () {
  this.timeout(30000);

  let tls;
  let dir;

  before(function () {
    tls = require(tlsModule);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-tls-'));
  });

  after(function () {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('covers localhost and every address this machine answers on', function () {
    const material = tls.ensureCertificates(dir);
    assert.ok(material.issued, 'the first call has to issue');

    const { dns, ip } = tls.localHosts();
    assert.ok(dns.includes('localhost'), 'localhost must be covered');
    for (const host of [...dns, ...ip]) {
      assert.ok(material.hosts.includes(host), `${host} is reachable but not in the certificate`);
    }
  });

  it('does not reissue on the next start', function () {
    // openssl prints IPv6 SANs expanded, so `::1` comes back as
    // 0:0:0:0:0:0:0:1. Comparing those literally made every restart issue a new
    // certificate, which invalidates whatever the browser had already accepted.
    assert.strictEqual(tls.ensureCertificates(dir).issued, false);
    assert.strictEqual(tls.ensureCertificates(dir).issued, false);
  });

  it('keeps the private keys unreadable by anyone else', function () {
    const material = tls.ensureCertificates(dir);
    for (const key of [material.keyFile, path.join(path.dirname(material.caFile), 'ca.key')]) {
      const mode = fs.statSync(key).mode & 0o777;
      assert.strictEqual(mode, 0o600, `${path.basename(key)} is mode ${mode.toString(8)}`);
    }
  });

  it('issues inside the lifetime browsers accept', function () {
    const material = tls.ensureCertificates(dir);
    const { execFileSync } = require('child_process');
    const out = execFileSync('openssl', ['x509', '-in', material.certFile, '-noout', '-enddate'], {
      encoding: 'utf8',
    });
    const days = (Date.parse(out.match(/notAfter=(.+)/)[1]) - Date.now()) / 86400000;
    assert.ok(days > 300, `expires in ${Math.round(days)} days`);
    // Chrome and Safari refuse server certificates valid for more than 398 days.
    assert.ok(days <= 398, `lifetime of ${Math.round(days)} days is over the 398-day limit`);
  });
});

// Every device has to fetch /ca.crt before it can trust this server, so the
// route is the front door to the whole arrangement. It answered 404 for every
// request while the file sat there readable: express refuses any path with a
// dot-segment, and the data directory is `~/.code-agents-webcli`. There was no
// error and no log — just a phone that could not be onboarded.
describeBuilt('CA certificate route', function () {
  this.timeout(30000);

  let tls;
  let dir;
  let caFile;

  before(function () {
    tls = require(tlsModule);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-ca-'));
    // A dot-directory, because that is what the real data directory is.
    const dotted = path.join(dir, '.code-agents-webcli');
    fs.mkdirSync(dotted, { recursive: true });
    caFile = tls.ensureCertificates(dotted).caFile;
    assert.ok(caFile.includes('/.code-agents-webcli/'), 'the fixture must use a dot-segment');
  });

  after(function () {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function invoke(getCaFile) {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      send(body) { this.body = body; return this; },
    };
    tls.caCertificateHandler(getCaFile)({}, res);
    return res;
  }

  it('serves the certificate from a dot-directory', function () {
    const res = invoke(() => caFile);
    assert.strictEqual(res.statusCode, 200, 'a dot-segment in the path must not 404');
    assert.ok(
      res.body.toString().startsWith('-----BEGIN CERTIFICATE-----'),
      'the body must be the PEM certificate',
    );
    assert.strictEqual(res.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(res.headers['content-disposition'], /filename="code-agents-webcli-ca\.crt"/);
  });

  it('explains itself when the deployment brought its own certificate', function () {
    const res = invoke(() => undefined);
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body.toString(), /--cert/);
  });
});

describeBuilt('HTTPS-only port', function () {
  this.timeout(30000);

  let tls;
  let dir;
  let listener;
  let port;
  let ca;

  before(async function () {
    tls = require(tlsModule);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-port-'));
    const material = tls.ensureCertificates(dir);
    ca = fs.readFileSync(material.caFile);

    const secure = https.createServer(
      {
        cert: fs.readFileSync(material.certFile),
        key: fs.readFileSync(material.keyFile),
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure');
      },
    );
    const wss = new WebSocket.Server({ server: secure });
    wss.on('connection', (ws) => ws.send('hello'));

    listener = tls.createHttpsOnlyPort(secure);
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    port = listener.address().port;
  });

  after(function () {
    if (listener) listener.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function get(url, options) {
    return new Promise((resolve, reject) => {
      const req = (url.startsWith('https') ? https : require('http')).get(url, options || {}, (res) => {
        res.resume();
        resolve(res);
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('timed out')));
    });
  }

  it('serves over TLS, and the chain verifies against the generated CA', async function () {
    const res = await get(`https://127.0.0.1:${port}/`, { ca, servername: 'localhost' });
    assert.strictEqual(res.statusCode, 200);
  });

  it('redirects plain http to https instead of dropping the connection', async function () {
    const res = await get(`http://127.0.0.1:${port}/login?x=1`);
    assert.strictEqual(res.statusCode, 308);
    assert.strictEqual(res.headers.location, `https://127.0.0.1:${port}/login?x=1`);
  });

  it('carries a WebSocket, which is the terminal', async function () {
    // The demultiplexer hands the socket to the TLS server and must resume it
    // only after that server has attached its handlers. Resuming a tick too
    // early makes the handshake hang with no error on either side, so this
    // asserts a message actually arrives rather than just that connect resolved.
    const message = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ca, servername: 'localhost' });
      const timer = setTimeout(() => reject(new Error('no message: the upgrade hung')), 8000);
      ws.on('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.strictEqual(message, 'hello');
  });
});
