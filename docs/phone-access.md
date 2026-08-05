# Open Local computer on a phone

The installed desktop app can make **Local computer** available to a paired
phone while the desktop app is running. Phone access is off after every app
start. It does not expose saved remote servers or reuse their sign-ins.

A paired phone has the same power as Local computer in the desktop app: it can
read the local sessions and files and run terminals and coding agents as your
operating-system user. Start it only on a network you trust, pair only devices
you control, and select **Stop phone access** when you are done.

## On the same network

1. Open **Settings → Servers** in the desktop app.
2. On **Local computer**, select **Open on phone**.
3. Select **Same network** or **Both**, choose the Ethernet or Wi-Fi address the
   phone can reach, keep port `32354` unless it conflicts, and select **Start
   phone access**.
4. Trust the dedicated phone-access CA on the phone. Compare the SHA-256
   fingerprint shown by the desktop before trusting it. Installing a private CA
   is a device-wide security decision; remove it when you no longer want direct
   LAN access.
5. Scan the access QR or copy its exact HTTPS link. The code expires and works
   once. Use **Create another code** to pair another browser or device.

The dialog lists only private IPv4/IPv6 addresses; globally routable interfaces
are deliberately unavailable in LAN mode. The gateway binds only the selected
private network address. If the computer changes Wi-Fi, sleeps, loses that
address, or a firewall blocks the selected port, the
old link stops working. Stop phone access, choose the current address, and
start it again. A changed address is also a different browser origin, so an old
installed PWA and its browser storage do not move to the new link.

## Away from the LAN with Tailscale

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) is the
recommended way to reach the private gateway from mobile data or another
network. Serve gives the computer a tailnet-only HTTPS address with a publicly
trusted certificate and forwards it to the gateway's loopback listener. It does
not require router port forwarding.

1. [Install Tailscale](https://tailscale.com/download) on the computer and the
   phone.
2. Sign both devices into the same tailnet and allow the phone's VPN
   configuration. If the phone belongs to another tailnet, an administrator
   must explicitly share or grant access instead.
3. In **Open on phone**, start **Tailscale** or **Both** access.
4. In a terminal on the computer, run the exact command shown by the app. With
   the default port it is:

   ```bash
   tailscale serve 32354
   ```

   Follow Tailscale's browser consent if HTTPS is not enabled for the tailnet.
   Leave this foreground command running while you use the phone; press
   **Ctrl-C** when finished.
5. Select **Check setup** in the desktop dialog, verify the detected exact
   `https://<machine>.<tailnet>.ts.net` address, then select **Confirm checked
   address**. Confirmation performs another fresh read-only check: the desktop
   must be online, Serve must proxy `/` to the displayed `127.0.0.1` port, and
   Funnel must be off. Then scan its QR. Pair
   this address even if the same phone was already paired over the LAN, because
   browser sessions belong to one exact origin.

Tailscale access-control rules still apply. If the link does not open, confirm
that both devices are connected, the computer is awake, incoming connections
are not blocked by Shields Up, and the tailnet policy permits the phone to
reach the computer. See [Tailscale access controls](https://tailscale.com/docs/features/access-control)
and the [`tailscale serve` reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Do not use **Tailscale Funnel** for this feature. Funnel publishes a service to
the public Internet; phone access is designed to remain private to paired
devices and, when used remotely, the tailnet.

The desktop app only checks Tailscale status. It never installs or signs in to
Tailscale, changes tailnet policy, starts Serve or Funnel, opens firewall ports,
or changes the router.

## Pairing and revoking devices

The QR contains a short-lived, single-use secret in the URL fragment. The
desktop credential is never part of it. Redeeming the code creates a private
browser session for that one origin.

- **Create another code** leaves existing paired devices connected and creates
  one new code.
- **Revoke** disconnects that paired browser and terminates its live requests
  and WebSockets.
- **Stop phone access** revokes every phone session and closes both the LAN and
  loopback listeners. Local computer sessions keep running in the desktop app.
- Quitting the desktop app also stops phone access. It never starts
  automatically after relaunch.

## Trusting or removing the LAN certificate

The LAN listener uses a dedicated local CA because an IP address on a private
network cannot normally receive a public web certificate. Export the CA from
the trusted desktop dialog when possible. If you download `/ca.crt` over the
LAN, compare its SHA-256 fingerprint with the value shown in the desktop before
trusting it.

Follow the platform steps in [HTTPS and certificates](https-and-certificates.md)
to install, fully trust, or remove the CA on iOS, Android, macOS, Windows, or
Linux. Tailscale Serve uses its own trusted HTTPS certificate and does not need
this CA.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **Open on phone** is unavailable | Local computer must finish starting. Remote-server management remains available when it cannot start. |
| The port is already in use | Stop the other listener or choose another unprivileged port in the dialog, then use that same port in the Serve command. |
| The LAN QR does not open | Put both devices on the same reachable network, select the correct interface, allow the port through the host firewall, and keep the desktop awake. Guest Wi-Fi can isolate devices. |
| The certificate warning remains | Install and fully trust the dedicated CA, verify its fingerprint, then completely close and reopen the browser. |
| The Tailscale QR is unavailable | Connect Tailscale, run the displayed foreground Serve command, complete HTTPS consent, then select **Check setup**. |
| The Tailscale URL times out | Check tailnet membership/sharing, access-control policy, Shields Up, phone VPN permission, desktop sleep, and whether the Serve command is still running. |
| An old PWA no longer connects | Open the current exact LAN or `ts.net` URL and install that origin again; browser storage and PWAs do not migrate between origins. |
| A revoked phone still shows the shell | A service worker can retain public shell files, but APIs, terminals, and WebSockets are closed. Reloading shows that the private server is unavailable. |
