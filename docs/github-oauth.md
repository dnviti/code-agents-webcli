# GitHub OAuth

Sign-in is GitHub-only. The app cannot serve a login page without an OAuth App,
so this is the one piece of setup you cannot skip.

## Create the OAuth App

1. Go to <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth
   App**.
2. **Application name** — anything.
3. **Homepage URL** — your public base URL, e.g. `https://localhost:32352` or
   `https://agents.example.com`.
4. **Authorization callback URL** — your public base URL with
   `/auth/github/callback` appended:

   ```text
   https://agents.example.com/auth/github/callback
   ```

   For a local install that is:

   ```text
   https://localhost:32352/auth/github/callback
   ```

   The scheme is `https` **even locally** — the server
   [does not serve plain http](https-and-certificates.md).

5. Register it, then generate a client secret. You need the **client ID** and the
   **client secret**.

The callback URL has to match the public base URL you give the app exactly. A
mismatch is the single most common setup failure: sign-in appears to work and
then returns you to the wrong host, or GitHub refuses with a redirect_uri error.

## Find your numeric user ID

The allow-list is keyed by GitHub's numeric user ID, not by login — logins can be
changed and reused, numeric IDs cannot.

```bash
curl -s https://api.github.com/users/<your-login> | grep '"id"'
```

## The allow-list

**An empty allow-list denies every sign-in.** This is deliberate: the failure
mode of an allow-list that defaults to open is that the internet gets a shell on
your machine.

Set it during [first-run setup](configuration.md#first-run-setup), or with:

```bash
cc-web --allowed-github-ids 12345,67890
```

Anyone on that list can sign in and **run commands on the host as the user
running the server**. There is no sandbox, no per-user OS account, and no command
filtering — the app exists to give people a terminal. List only accounts you
would give SSH to.

There is an explicit opt-out for the case where you genuinely want any GitHub
account to be able to sign in:

```bash
cc-web --allow-any-github-user
```

Its help text calls it dangerous, and it means it. Use it only where something
else already restricts who can reach the port.

## The installer account

The **first account that ever signs in** becomes the *installer*. That identity
is pinned, so deleting the account does not promote whoever signed in second.

The installer alone can:

- [apply an update](updating.md) from the web UI,
- change [runtime profiles](runtimes.md#runtime-profiles), which are server-wide.

Everyone else sees those screens read-only. If an account on the pin is later
removed from the allow-list, the pin moves — otherwise rights nobody can sign in
to exercise would lock the page for everyone.

## What the app stores

Credentials go into the local SQLite database, never into the systemd unit or a
command line that would show up in `ps`. See
[Configuration](configuration.md#where-state-lives).

The database is therefore sensitive: it holds OAuth configuration and live auth
session records. It is created with `0600` permissions inside a `0700`
directory.
