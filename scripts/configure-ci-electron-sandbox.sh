#!/usr/bin/env bash
set -euo pipefail

# Electron 43 downloads its pinned binary lazily on the first require. Resolve
# that package from this checkout, trigger the verified download as the runner
# user, and only then elevate the helper beside the resolved executable.
if [ -n "${ELECTRON_OVERRIDE_DIST_PATH:-}" ]; then
  echo 'ELECTRON_OVERRIDE_DIST_PATH is not allowed while configuring the CI sandbox.' >&2
  exit 1
fi

workspace_root="$(pwd -P)"
package_entry="$(node -p 'require.resolve("electron")')"
package_root="$(realpath -e -- "$(dirname -- "$package_entry")")"
expected_package_root="$workspace_root/node_modules/electron"
if [ "$package_root" != "$expected_package_root" ]; then
  echo "Electron resolved outside this checkout: $package_root" >&2
  exit 1
fi

node -e 'require("electron")'
electron_executable="$(realpath -e -- "$(node -p 'require("electron")')")"
dist_root="$(realpath -e -- "$package_root/dist")"
if [ "$(dirname -- "$electron_executable")" != "$dist_root" ] \
  || [ ! -f "$electron_executable" ] || [ -L "$electron_executable" ]; then
  echo "Electron executable is not a regular immediate child of its distribution: $electron_executable" >&2
  exit 1
fi

candidate="$(dirname -- "$electron_executable")/chrome-sandbox"
if [ ! -e "$candidate" ]; then
  echo "Electron sandbox helper is missing: $candidate" >&2
  exit 1
fi
target="$(realpath -e -- "$candidate")"
candidate_link="$(readlink -- "$candidate" 2>/dev/null || printf '<regular>')"
printf 'Electron sandbox candidate: %s -> %s\n' "$candidate_link" "$target"
if [ "$(dirname -- "$target")" != "$dist_root" ] || [ ! -f "$target" ] || [ -L "$target" ]; then
  echo "Electron sandbox helper escapes its distribution or is not a regular file: $target" >&2
  exit 1
fi

sudo chown root:root -- "$target"
sudo chmod 4755 -- "$target"
sandbox_mode="$(stat -c '%u:%g:%a' -- "$target")"
printf 'Electron sandbox helper identity: %s\n' "$sandbox_mode"
if [ "$sandbox_mode" != '0:0:4755' ]; then
  echo "Electron sandbox helper has insecure identity or mode: $sandbox_mode" >&2
  exit 1
fi
