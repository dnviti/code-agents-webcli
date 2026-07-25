# HTTPS and certificates

The server speaks HTTPS only, and generates its own certificate authority to do
it. This page explains why, and what you have to do once per device.

## Why there is no http mode

Not secrecy on a home network — capability. A browser treats a plain-http origin
that is not `localhost` as an **insecure context** and withholds the service
worker. No service worker means no installable app, no offline shell, no
clipboard API and no notifications.

Every one of those features worked when tested at `http://localhost` and was
silently missing for anyone opening the same server at `http://192.168.x.x` —
which is how it is normally reached. Serving http at all just moved the failure
somewhere harder to see.

Plain http requests to the port are answered with a **308 redirect** to the https
URL, so old bookmarks keep working. No content is served over http.

## The generated certificate

On first start the server creates a CA and a server certificate in:

```text
~/.code-agents-webcli/tls/
```

The certificate covers `localhost`, this machine's hostname, `<hostname>.local`,
and every non-internal IP address the machine answers on.

It is **reissued automatically** when it nears expiry or when the machine's
addresses change — a laptop moving between networks gets a fresh certificate
instead of a confusing TLS error. The CA itself is reused, so devices never have
to be re-trusted.

## Trusting the CA, once per device

Because the CA is local, each device has to be told to trust it. Download it
from `/ca.crt`. That route is deliberately reachable **without signing in**: a
device that does not trust the certificate cannot get as far as the login page.

### Linux — Chrome/Chromium, no root

```bash
curl -k https://<host>:32352/ca.crt -o ca.crt
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Code Agents Web CLI local CA" -i ca.crt
```

### Linux — system-wide

```bash
# Fedora / RHEL
sudo cp ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust

# Debian / Ubuntu
sudo cp ca.crt /usr/local/share/ca-certificates/code-agents-webcli.crt
sudo update-ca-certificates
```

### macOS

```bash
curl -k https://<host>:32352/ca.crt -o ca.crt
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ca.crt
```

### iOS / iPadOS

1. Open `https://<host>:32352/ca.crt` in **Safari** (not Chrome — it has to be
   Safari to install a profile).
2. Install the downloaded profile: Settings → Profile Downloaded.
3. Enable it: **Settings → General → About → Certificate Trust Settings**.

Step 3 is easy to miss and nothing works without it.

### Android

Settings → Security → Encryption & credentials → Install a certificate → **CA
certificate**.

## Using your own certificate

Pass both flags and nothing is generated:

```bash
cc-web --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

This is the right answer when the server is reachable at a real domain — a
Let's Encrypt certificate needs no per-device trust step at all. If you are
terminating TLS at a reverse proxy instead, see
[Running as a service](running-as-a-service.md#behind-a-reverse-proxy).

## Troubleshooting

**"Your connection is not private" / `ERR_CERT_AUTHORITY_INVALID`** — the device
has not trusted the CA yet, or (on iOS) the profile is installed but not enabled
under Certificate Trust Settings.

**It worked yesterday and now warns** — the machine changed IP address and the
certificate was reissued to match. The CA did not change, so this should not
happen; if it does, the device is likely trusting the *server* certificate rather
than the CA.

**The PWA will not install and the clipboard does not work** — you are on an
http origin, or on an https origin whose certificate the browser does not trust.
Both withhold a secure context.
