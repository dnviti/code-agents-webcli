#!/usr/bin/env bash
set -euo pipefail

# GitHub's npm cache may materialize Electron's Chromium helper as a symlink.
# Replace only that workspace link with a regular copy before elevating its
# ownership, so sudo never follows a dependency-controlled link target.
sandbox="${1:-node_modules/electron/dist/chrome-sandbox}"
if [ -L "$sandbox" ]; then
  resolved="$(readlink -f -- "$sandbox")"
  if [ -z "$resolved" ] || [ ! -f "$resolved" ]; then
    echo 'Electron sandbox helper link has no regular target.' >&2
    exit 1
  fi
  staged="${sandbox}.ccweb-regular"
  trap 'rm -f -- "$staged"' EXIT
  install -m 0755 -- "$resolved" "$staged"
  mv -f -- "$staged" "$sandbox"
  trap - EXIT
fi

if [ ! -f "$sandbox" ] || [ -L "$sandbox" ]; then
  echo 'Missing or invalid Electron sandbox helper.' >&2
  exit 1
fi

sudo chown root:root -- "$sandbox"
sudo chmod 4755 -- "$sandbox"
sandbox_mode="$(stat -c '%u:%g %a' -- "$sandbox")"
echo "Electron sandbox helper: $sandbox_mode"
test "$sandbox_mode" = '0:0 4755'
