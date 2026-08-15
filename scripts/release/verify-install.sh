#!/usr/bin/env bash
#
# Prove the documented install actually works, from the working tree.
#
# The README promises one command:
#
#   npx --allow-git=all github:dnviti/code-agents-webcli
#
# Every part of that is easy to break without noticing on a developer machine,
# which already has a populated npm cache, a C++ toolchain, and node_modules
# sitting in the checkout. So this does the pessimistic version: it snapshots
# the tracked working tree into a throwaway git repository, installs *that* by
# git URL into an empty prefix with an isolated cache, and runs the result.
#
# It fails on three things a normal test run cannot see:
#   1. the `prepare` build not working outside the checkout,
#   2. anything in the tree needing to be compiled,
#   3. the installed package not actually starting.
#
# Usage: scripts/release/verify-install.sh [--keep]
set -euo pipefail

# `npm run` exports the caller's npm config as environment variables. Do not
# let a developer's personal install-script allow-list become CLI policy for
# the nested, deliberately unapproved install below.
unset npm_config_allow_scripts NPM_CONFIG_ALLOW_SCRIPTS npm_config_userconfig NPM_CONFIG_USERCONFIG

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cawcli-verify-install.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo "Left behind for inspection: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

SOURCE_REPO="$WORK/source.git"
PREFIX="$WORK/prefix"
CACHE="$WORK/npm-cache"
LOG="$WORK/install.log"
USER_CONFIG="$WORK/empty-user-npmrc"
mkdir -p "$SOURCE_REPO" "$PREFIX" "$CACHE"
touch "$USER_CONFIG"

echo "==> Snapshotting the tracked working tree"
# Tracked + untracked-but-not-ignored, so uncommitted work is exercised too.
# node_modules/ and dist/ are gitignored, so neither comes along — which is the
# whole point: the install has to build them itself.
#
# Filtered for existence because `git ls-files` still lists files deleted in the
# working tree but not yet staged, and tar treats a missing member as fatal.
(
  cd "$REPO_ROOT"
  git ls-files -co --exclude-standard -z \
    | while IFS= read -r -d '' entry; do
        [[ -e "$entry" ]] && printf '%s\0' "$entry"
      done
) | tar -C "$REPO_ROOT" --null -T - -cf - \
  | tar -C "$SOURCE_REPO" -xf -

(
  cd "$SOURCE_REPO"
  git init -q
  git config user.email install-verify@example.invalid
  git config user.name "install verification"
  git add -A
  git commit -q -m "snapshot under test"
)

echo "==> Installing from a git URL into an empty prefix"
echo "    (isolated cache, no scripts pre-approved, nothing prebuilt)"
printf '{"name":"install-verification","version":"1.0.0","private":true}\n' > "$PREFIX/package.json"

set +e
# A developer-level allowScripts entry would make this project-scoped install
# fail on npm 12 before the package under test is even resolved. Use an empty
# user config so the probe measures the repository, not the invoking machine.
npm_config_userconfig="$USER_CONFIG" npm install \
  --prefix "$PREFIX" \
  --cache "$CACHE" \
  --allow-git=all \
  --no-audit --no-fund --loglevel=info \
  "git+file://$SOURCE_REPO" > "$LOG" 2>&1
INSTALL_STATUS=$?
set -e

if [[ "$INSTALL_STATUS" != "0" ]]; then
  echo "FAIL: the install itself failed (exit $INSTALL_STATUS)"
  tail -40 "$LOG"
  exit 1
fi
echo "    install OK"

echo "==> Checking nothing had to be compiled"
# node-gyp only ever appears when a package is being built from source, and
# EALLOWSCRIPTS/blocked-script notices mean npm refused to run one. Either is a
# broken promise, even though the install as a whole may still have exited 0.
if grep -Eqi 'node-gyp|gyp info|EALLOWSCRIPTS|prebuild-install' "$LOG"; then
  echo "FAIL: something in the tree compiles or wants an install script:"
  grep -Ein 'node-gyp|gyp info|EALLOWSCRIPTS|prebuild-install' "$LOG" | head -20
  exit 1
fi
echo "    nothing compiled"

echo "==> Checking no blocked install scripts are pending"
BLOCKED="$(npm_config_userconfig="$USER_CONFIG" npm install-scripts ls --prefix "$PREFIX" 2>/dev/null || true)"
if printf '%s' "$BLOCKED" | grep -Eqi 'node-pty|better-sqlite3|blocked'; then
  echo "FAIL: the install left blocked scripts behind:"
  printf '%s\n' "$BLOCKED"
  exit 1
fi
echo "    none pending"

BIN="$PREFIX/node_modules/.bin/cc-web"
echo "==> Running the installed binary: $BIN --version"
if [[ ! -x "$BIN" ]]; then
  echo "FAIL: $BIN was not installed or is not executable"
  ls -la "$PREFIX/node_modules/.bin" || true
  exit 1
fi

VERSION="$("$BIN" --version 2>&1)" || {
  echo "FAIL: the installed binary did not run"
  echo "$VERSION"
  exit 1
}
echo "    reported version: $VERSION"

echo "==> Checking the server module actually loads (pty + sqlite bindings)"
node -e '
  const path = require("path");
  const root = path.join(process.argv[1], "node_modules", "code-agents-webcli");
  require(path.join(root, "dist", "server", "index.js"));
  const { ptySource } = require(path.join(root, "dist", "server", "services", "pty.js"));
  const { openDatabase } = require(path.join(root, "dist", "server", "services", "sqlite.js"));
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
  db.prepare("INSERT INTO probe (id) VALUES (?)").run(1);
  if (db.prepare("SELECT COUNT(*) AS c FROM probe").get().c !== 1) {
    throw new Error("sqlite round-trip failed");
  }
  db.close();
  console.log("    server loads; pty binding =", ptySource() + "; sqlite round-trip OK");
' "$PREFIX"

SIZE="$(du -sh "$PREFIX/node_modules" | cut -f1)"
echo
echo "PASS — one command, no compiler, no approvals. Installed tree: $SIZE"
