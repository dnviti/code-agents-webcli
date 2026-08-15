#!/usr/bin/env bash
# Construct the signed Flatpak repository and repository-aware bundle from the
# bundle electron-builder creates.  This is release infrastructure: it refuses
# to fall back to an unsigned repository or an untrusted remote.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/release/release-flatpak-repository.sh --input BUNDLE --output DIRECTORY --repository DIRECTORY --url HTTPS_URL

Environment:
  FLATPAK_GPG_PRIVATE_KEY  base64-encoded private OpenPGP key (required)
  FLATPAK_GPG_KEY_ID       exact 40-hex primary-key fingerprint (required)
  FLATPAK_GPG_PASSPHRASE  private-key passphrase (required)
EOF
  exit 64
}

input=''
output=''
repository=''
repository_url=''
# electron-builder normalizes the final Flatpak app-id component because
# Flatpak ref names do not permit hyphens there.
app_id='io.github.dnviti.code_agents_webcli'
branch='stable'
previous_version=''
previous_commit=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) input=${2:-}; shift 2 ;;
    --output) output=${2:-}; shift 2 ;;
    --repository) repository=${2:-}; shift 2 ;;
    --url) repository_url=${2:-}; shift 2 ;;
    --app-id) app_id=${2:-}; shift 2 ;;
    --branch) branch=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$input" && -f "$input" && -n "$output" && -n "$repository" && -n "$repository_url" ]] || usage
: "${FLATPAK_GPG_PRIVATE_KEY:?A Flatpak signing key is required}"
: "${FLATPAK_GPG_KEY_ID:?A Flatpak signing key id is required}"
: "${FLATPAK_GPG_PASSPHRASE:?A Flatpak signing key passphrase is required}"
[[ "$FLATPAK_GPG_KEY_ID" =~ ^[0-9A-Fa-f]{40}$ ]] \
  || { echo 'FLATPAK_GPG_KEY_ID must be the exact 40-hex primary-key fingerprint.' >&2; exit 1; }
command -v flatpak >/dev/null
command -v gpg >/dev/null
command -v ostree >/dev/null
command -v curl >/dev/null

mkdir -p "$output" "$repository"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
key_home="$scratch/gnupg"
mkdir -m 700 "$key_home"
key_file="$scratch/flatpak-signing-key.asc"
public_key="$scratch/flatpak-public-key.gpg"

printf '%s' "$FLATPAK_GPG_PRIVATE_KEY" | base64 --decode >"$key_file"
chmod 600 "$key_file"
gpg --batch --homedir "$key_home" --import "$key_file" >/dev/null 2>&1
actual_fingerprint="$(gpg --batch --homedir "$key_home" --with-colons --list-secret-keys \
  "$FLATPAK_GPG_KEY_ID" | awk -F: '$1 == "fpr" { print toupper($10); exit }')"
[[ "$actual_fingerprint" == "${FLATPAK_GPG_KEY_ID^^}" ]] \
  || { echo 'The imported Flatpak signing key does not match FLATPAK_GPG_KEY_ID.' >&2; exit 1; }
gpg --batch --homedir "$key_home" --export "$FLATPAK_GPG_KEY_ID" >"$public_key"
[[ -s "$public_key" ]] || { echo 'Could not export Flatpak public key.' >&2; exit 1; }

# Prime the isolated gpg-agent without putting the passphrase in argv. Flatpak's
# GPGME calls below use that same GNUPGHOME and therefore never need a pinentry
# dialog on the unattended release runner.
printf 'Code Agents Web CLI Flatpak release key check\n' >"$scratch/key-check"
printf '%s' "$FLATPAK_GPG_PASSPHRASE" | GNUPGHOME="$key_home" gpg --batch --yes \
  --pinentry-mode loopback --passphrase-fd 0 --local-user "$FLATPAK_GPG_KEY_ID" \
  --detach-sign --output "$scratch/key-check.sig" "$scratch/key-check"

# Pull the currently published signed ref before importing the new bundle. This
# preserves old commits and makes the static delta an actual old-to-new update
# instead of replacing Pages with a repository containing only its newest tip.
app_ref="app/$app_id/x86_64/$branch"
ostree --repo="$repository" init --mode=archive-z2
summary_url="${repository_url%/}/summary"
summary_status="$(curl --silent --show-error --location --proto '=https' --tlsv1.2 \
  --max-time 20 --output /dev/null --write-out '%{http_code}' "$summary_url" || true)"
case "$summary_status" in
  200)
    ostree --repo="$repository" remote add --gpg-import="$public_key" previous "$repository_url"
    ostree --repo="$repository" pull --depth=-1 previous "$app_ref"
    previous_commit="$(ostree --repo="$repository" rev-parse "previous:$app_ref")"
    [[ "$previous_commit" =~ ^[0-9a-f]{64}$ ]] \
      || { echo 'Could not resolve the previous Flatpak stable commit.' >&2; exit 1; }
    ostree --repo="$repository" refs --create="$app_ref" "$previous_commit"
    ostree --repo="$repository" remote delete previous
    # Preserve a fully signed copy whose stable ref still names the currently
    # public deployment. CI serves this at /flatpak while it verifies the new
    # repository at a versioned candidate URL, so staging cannot expose a
    # partial all-platform release.
    GNUPGHOME="$key_home" flatpak build-update-repo \
      --gpg-sign="$FLATPAK_GPG_KEY_ID" "$repository"
    cp -a "$repository" "${repository}-previous"
    for public_file in code-agents-webcli.flatpakref code-agents-webcli.flatpakrepo \
      update-info.json update-info.json.asc; do
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        "${repository_url%/}/$public_file" -o "${repository}-previous/$public_file"
    done
    cp "$public_key" "${repository}-previous/code-agents-webcli.gpg"
    gpgv --keyring "$public_key" "${repository}-previous/update-info.json.asc" \
      "${repository}-previous/update-info.json"
    PREVIOUS_UPDATE_INFO="${repository}-previous/update-info.json" \
      PREVIOUS_COMMIT="$previous_commit" PREVIOUS_APP_ID="$app_id" node <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.PREVIOUS_UPDATE_INFO, 'utf8'));
if (value.schemaVersion !== 1 || value.appId !== process.env.PREVIOUS_APP_ID
  || value.branch !== 'stable' || value.commit !== process.env.PREVIOUS_COMMIT
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(value.version || ''))) {
  throw new Error('The previous signed Flatpak activation manifest is inconsistent.');
}
NODE
    previous_version="$(PREVIOUS_UPDATE_INFO="${repository}-previous/update-info.json" \
      node -p "JSON.parse(require('fs').readFileSync(process.env.PREVIOUS_UPDATE_INFO, 'utf8')).version")"
    ;;
  404) ;; # First repository-aware release.
  *) echo "Could not read the existing Flatpak repository ($summary_status)." >&2; exit 1 ;;
esac

# Importing the builder bundle retains the app commit; build-update-repo then
# signs both the summary and the app metadata. A standalone bundle recreated
# below includes the remote URL/key, so installing it also configures updates.
GNUPGHOME="$key_home" flatpak build-import-bundle "$repository" "$input"
GNUPGHOME="$key_home" flatpak build-sign --gpg-sign="$FLATPAK_GPG_KEY_ID" \
  "$repository" "$app_id" "$branch"
GNUPGHOME="$key_home" flatpak build-update-repo \
  --gpg-sign="$FLATPAK_GPG_KEY_ID" --generate-static-deltas "$repository"

version="$(node -p "require('./package.json').version")"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || { echo 'Flatpak stable version must be X.Y.Z.' >&2; exit 1; }
if [[ -n "$previous_version" ]]; then
  PREVIOUS_VERSION="$previous_version" UPDATE_VERSION="$version" node <<'NODE'
const parse = (value) => value.split('.').map(BigInt);
const previous = parse(process.env.PREVIOUS_VERSION);
const update = parse(process.env.UPDATE_VERSION);
let comparison = 0;
for (let index = 0; index < 3; index += 1) {
  if (update[index] === previous[index]) continue;
  comparison = update[index] > previous[index] ? 1 : -1;
  break;
}
if (comparison <= 0) throw new Error('The Flatpak stable ref may only advance to a higher semantic version.');
NODE
fi
commit="$(ostree --repo="$repository" rev-parse "$app_ref")"
[[ "$commit" =~ ^[0-9a-f]{64}$ ]] || { echo 'Could not resolve the published Flatpak commit.' >&2; exit 1; }
if [[ -n "$previous_commit" ]]; then
  [[ "$commit" != "$previous_commit" ]] \
    || { echo 'The new Flatpak deployment is identical to the current stable deployment.' >&2; exit 1; }
  ostree static-delta generate --repo="$repository" \
    --from="$previous_commit" --to="$commit"
  # Re-sign the summary after the explicit old-to-new delta updates its index.
  GNUPGHOME="$key_home" flatpak build-update-repo \
    --gpg-sign="$FLATPAK_GPG_KEY_ID" "$repository"
  ostree static-delta list --repo="$repository" \
    | grep -F "$previous_commit-$commit" >/dev/null
fi
UPDATE_INFO_PATH="$repository/update-info.json" \
  UPDATE_INFO_VERSION="$version" UPDATE_INFO_COMMIT="$commit" UPDATE_INFO_APP_ID="$app_id" \
  node <<'NODE'
const fs = require('node:fs');
const value = {
  schemaVersion: 1,
  appId: process.env.UPDATE_INFO_APP_ID,
  branch: 'stable',
  version: process.env.UPDATE_INFO_VERSION,
  commit: process.env.UPDATE_INFO_COMMIT,
  releaseName: `Version ${process.env.UPDATE_INFO_VERSION}`,
  releaseDate: new Date().toISOString(),
};
fs.writeFileSync(process.env.UPDATE_INFO_PATH, `${JSON.stringify(value)}\n`, { mode: 0o644 });
NODE
printf '%s' "$FLATPAK_GPG_PASSPHRASE" | GNUPGHOME="$key_home" gpg --batch --yes \
  --pinentry-mode loopback --passphrase-fd 0 --armor --detach-sign \
  --local-user "$FLATPAK_GPG_KEY_ID" --output "$repository/update-info.json.asc" \
  "$repository/update-info.json"

bundle_name="Code-Agents-Web-CLI-${version}-linux-x64.flatpak"
ref_name="Code-Agents-Web-CLI-${version}-linux-x64.flatpakref"
repo_name="Code-Agents-Web-CLI-${version}-linux-x64.flatpakrepo"
bundle_path="$output/$bundle_name"

flatpak build-bundle --repo-url="$repository_url" --gpg-keys="$public_key" \
  "$repository" "$bundle_path" "$app_id" "$branch"

key_base64="$(base64 -w 0 "$public_key")"
cat >"$output/$ref_name" <<EOF
[Flatpak Ref]
Title=Code Agents Web CLI
Name=$app_id
Branch=$branch
Url=$repository_url
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
GPGKey=$key_base64
IsRuntime=false
EOF
cat >"$output/$repo_name" <<EOF
[Flatpak Repo]
Title=Code Agents Web CLI
Comment=Stable signed releases of Code Agents Web CLI
Url=$repository_url
GPGKey=$key_base64
Homepage=https://github.com/dnviti/code-agents-webcli
EOF
cp "$public_key" "$repository/code-agents-webcli.gpg"
cp "$output/$ref_name" "$repository/code-agents-webcli.flatpakref"
cp "$output/$repo_name" "$repository/code-agents-webcli.flatpakrepo"

# Validate that the produced summary is trusted by a fresh Flatpak user
# installation. remote-ls forces Flatpak to read/verify repository metadata
# without mutating a developer's real Flatpak configuration.
XDG_DATA_HOME="$scratch/data" flatpak --user remote-add --gpg-import="$public_key" \
  --if-not-exists code-agents-webcli-release "file://$repository"
XDG_DATA_HOME="$scratch/data" flatpak --user remote-ls code-agents-webcli-release \
  | grep -Fx "$app_id" >/dev/null
gpgv --keyring "$public_key" "$repository/update-info.json.asc" "$repository/update-info.json"
