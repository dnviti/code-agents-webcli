const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function sha512(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}

function createReleaseFixture(version = '6.1.0') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-release-assets-'));
  const names = {
    appImage: `Code-Agents-Web-CLI-${version}-linux-x64.AppImage`,
    deb: `Code-Agents-Web-CLI-${version}-linux-x64.deb`,
    rpm: `Code-Agents-Web-CLI-${version}-linux-x64.rpm`,
    flatpak: `Code-Agents-Web-CLI-${version}-linux-x64.flatpak`,
    flatpakRef: `Code-Agents-Web-CLI-${version}-linux-x64.flatpakref`,
    flatpakRepo: `Code-Agents-Web-CLI-${version}-linux-x64.flatpakrepo`,
    windows: `Code-Agents-Web-CLI-${version}-win-x64.exe`,
    windowsBlockmap: `Code-Agents-Web-CLI-${version}-win-x64.exe.blockmap`,
    macX64Dmg: `Code-Agents-Web-CLI-${version}-mac-x64.dmg`,
    macArm64Dmg: `Code-Agents-Web-CLI-${version}-mac-arm64.dmg`,
    macX64Zip: `Code-Agents-Web-CLI-${version}-mac-x64.zip`,
    macArm64Zip: `Code-Agents-Web-CLI-${version}-mac-arm64.zip`,
    macX64Blockmap: `Code-Agents-Web-CLI-${version}-mac-x64.zip.blockmap`,
    macArm64Blockmap: `Code-Agents-Web-CLI-${version}-mac-arm64.zip.blockmap`,
  };
  const contents = {};
  let index = 1;
  for (const [key, name] of Object.entries(names)) {
    const buffer = Buffer.alloc(64 + index, index);
    contents[key] = buffer;
    fs.writeFileSync(path.join(directory, name), buffer);
    index += 1;
  }
  const manifest = (artifact, extra = {}) => ({
    version,
    files: [{
      url: names[artifact],
      sha512: sha512(contents[artifact]),
      size: contents[artifact].length,
      ...extra,
    }],
    path: names[artifact],
    sha512: sha512(contents[artifact]),
  });
  const manifests = {
    'latest.yml': manifest('windows'),
    'latest-linux.yml': manifest('appImage', { blockMapSize: 12 }),
    'latest-x64-mac.yml': manifest('macX64Zip'),
    'latest-arm64-mac.yml': manifest('macArm64Zip'),
  };
  for (const [name, value] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  }
  const human = [
    'appImage', 'deb', 'rpm', 'flatpak', 'flatpakRef', 'flatpakRepo', 'windows', 'macX64Dmg', 'macArm64Dmg',
  ];
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), human.map((key) => {
    const digest = crypto.createHash('sha256').update(contents[key]).digest('hex');
    return `${digest}  ${names[key]}`;
  }).join('\n') + '\n');
  return { contents, directory, manifests, names, version };
}

describe('desktop release update pipeline', function () {
  it('pins native updates to the project and supports optional release signing', function () {
    const builder = read('electron-builder.yml');
    const notarize = read('scripts', 'release', 'notarize.js');
    const releasePr = read('scripts', 'release', 'release-pr.sh');
    const verifyInstall = read('scripts', 'release', 'verify-install.sh');
    const pkg = JSON.parse(read('package.json'));
    assert.match(builder, /publish:\s*\n\s*provider: github\s*\n\s*owner: dnviti\s*\n\s*repo: code-agents-webcli/);
    assert.match(builder, /forceCodeSigning: false/);
    assert.match(builder, /hardenedRuntime: true/);
    assert.match(builder, /entitlements: build\/entitlements\.mac\.plist/);
    assert.match(builder, /- zip/);
    assert.match(builder, /afterSign: scripts\/release\/notarize\.js/);
    assert.match(notarize, /CODE_AGENTS_WEBCLI_SKIP_NOTARIZATION === '1'/);
    assert.match(notarize, /cannot be both required and explicitly disabled/);
    assert.match(releasePr, /--bump requires patch, minor, or major/);
    assert.match(releasePr, /unknown argument/);
    assert.match(verifyInstall, /dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/\.\./);
    assert.match(builder, /--talk-name=org\.freedesktop\.portal\.Flatpak/);
    assert.match(builder, /--talk-name=org\.freedesktop\.Flatpak/);
    assert.match(builder, /flatpak-update-public-key\.asc/);
    assert.match(builder, /artifactName: Code-Agents-Web-CLI-\$\{version\}-linux-x64\.\$\{ext\}/);
    assert.ok(pkg.dependencies['electron-updater']);
    assert.strictEqual(pkg.dependencies['@particle/dbus-next'], '0.11.4');
    assert.strictEqual(pkg.dependencies.openpgp, '6.3.1');
    assert.ok(pkg.devDependencies['@electron/notarize']);
  });

  it('keeps stable feeds staged until signing, Flatpak verification, and Pages deployment pass', function () {
    const workflow = read('.github', 'workflows', 'release-on-main.yml');
    assert.match(workflow, /environment: release/);
    assert.match(workflow, /group: tagged-release-stable-feeds/);
    assert.match(workflow, /public-releases\.json/);
    assert.match(workflow, /not newer than public/);
    for (const name of [
      'WINDOWS_CSC_LINK', 'MACOS_CSC_LINK', 'APPLE_API_KEY_BASE64',
      'FLATPAK_GPG_PRIVATE_KEY', 'FLATPAK_GPG_KEY_ID', 'FLATPAK_GPG_PASSPHRASE',
    ]) {
      assert.match(workflow, new RegExp(name));
    }
    assert.match(workflow, /scripts\/release\/release-flatpak-repository\.sh/);
    assert.match(workflow, /scripts\/release\/validate-release-assets\.js/);
    assert.match(workflow, /scripts\/release\/validate-flatpak-permissions\.js/);
    assert.match(workflow, /actions\/deploy-pages@[0-9a-f]{40}/);
    assert.doesNotMatch(workflow, /uses: [^\s]+@v\d/);
    assert.match(workflow, /draft: true/);
    assert.match(workflow, /overwrite_files: false/);
    assert.match(workflow, /releases\/tags\/\$EXPECTED_TAG/);
    assert.match(workflow, /published versions are immutable/);
    assert.match(workflow, /Could not prove release .* is unused/);
    assert.match(workflow, /gh release edit .*--draft=false/);
    assert.match(workflow, /--config\.publish\.channel=latest-x64/);
    assert.match(workflow, /--config\.publish\.channel=latest-arm64/);
    assert.match(workflow, /--config\.forceCodeSigning=\$signing/);
    assert.match(workflow, /--config\.win\.signExecutable=false/);
    assert.match(workflow, /--config\.mac\.identity=null/);
    assert.match(workflow, /--config\.mac\.hardenedRuntime=false/);
    assert.match(workflow, /signing is not configured; the package will be built unsigned/);
    assert.match(workflow, /Incomplete \$platform signing identity/);
    assert.match(workflow, /needs\.release-identities\.outputs\.all_signed == 'true'/);
    assert.match(workflow, /Stable feeds require an exact X\.Y\.Z semantic version/);
    assert.match(workflow, /Verify the versioned HTTPS candidate and unchanged stable ref/);
    assert.match(workflow, /cmp "\$local_repository\/summary" "\$verify\/summary"/);
    assert.match(workflow, /cmp "\$local_repository\/update-info\.json" "\$verify\/update-info\.json"/);
    assert.match(workflow, /gpgv --keyring "\$verify\/repository\.gpg"/);
    assert.match(workflow, /flatpak --user remote-ls code-agents-webcli-candidate/);
    assert.match(workflow, /SignerCertificate\.Subject -cne \$env:WINDOWS_CERT_SUBJECT/);
    assert.match(workflow, /--config\.win\.signtoolOptions\.publisherName=\$WINDOWS_CERT_SUBJECT/);
    assert.match(workflow, /Updater publisher pin mismatch/);
    assert.match(workflow, /Embed the trusted Flatpak manifest key/);
    assert.match(workflow, /TeamIdentifier/);
    assert.match(workflow, /MACOS_CERT_AUTHORITY/);
    assert.match(workflow, /release\/\*\.zip\.blockmap/);
    assert.match(workflow, /Code-Agents-Web-CLI-\$\{VERSION\}-mac-x64\.dmg/);
    assert.match(workflow, /Code-Agents-Web-CLI-\$\{VERSION\}-mac-arm64\.dmg/);
    assert.match(workflow, /Code-Agents-Web-CLI-\$\{VERSION\}-mac-x64\.zip/);
    assert.match(workflow, /Code-Agents-Web-CLI-\$\{VERSION\}-mac-arm64\.zip/);
    assert.match(workflow, /latest-x64-mac\.yml/);
    assert.match(workflow, /latest-arm64-mac\.yml/);
    assert.doesNotMatch(workflow, /release\/\*\.AppImage\.blockmap/);
    assert.match(workflow, /cp -a docs\/\. pages-root\//);
    assert.match(workflow, /flatpak-candidates\/\$\{\{ needs\.verify\.outputs\.tag \}\}/);
    assert.match(workflow, /flatpak-repository-previous/);
    assert.match(workflow, /! -path '\*\/flatpak-repository-previous\/\*'/);
    assert.match(workflow, /gh release edit .*--draft=false --repo "\$GH_REPO"/);
    assert.match(workflow, /Hide native feed if Flatpak activation fails/);
    assert.match(workflow, /--draft=true --repo "\$GH_REPO"/);
    assert.match(workflow, /Verify an interrupted draft is byte-identical/);
    assert.match(workflow, /DESKTOP_UPDATER_QUALIFICATION_RUN_ID/);
    assert.match(workflow, /validate-desktop-updater-qualification\.js/);
    assert.match(workflow, /environment: desktop-updater-qualification/);
    assert.match(workflow, /desktop-updater-evidence-\$package_name/);
    assert.match(workflow, /Revalidate every candidate byte and stable tip before promotion/);
    assert.match(workflow, /validate-release-assets\.js "\$RUNNER_TEMP\/promotion-assets"/);
    assert.match(workflow, /Verify the activated signed stable ref over HTTPS/);
    assert.match(workflow, /github-pages-flatpak-rollback/);
    const qualification = read('.github', 'workflows', 'desktop-updater-qualification.yml');
    assert.match(qualification, /environment: release/);
    assert.match(qualification, /desktop-updater-evidence-\$package/);
    assert.match(qualification, /validate-desktop-updater-trial-evidence\.js/);
    assert.match(qualification, /INPUT_TAG: \$\{\{ inputs\.tag \}\}/);
    assert.doesNotMatch(qualification, /tag='\$\{\{ inputs\.tag \}\}'/);
    for (const label of ['windows_evidence', 'appimage_evidence', 'flatpak_evidence', 'macos_x64_evidence', 'macos_arm64_evidence']) {
      assert.match(qualification, new RegExp(label));
    }
  });

  it('builds and smokes unsigned native packages on each supported desktop host', function () {
    const ci = read('.github', 'workflows', 'ci.yml');
    const pkg = JSON.parse(read('package.json'));
    assert.strictEqual(pkg.engines.node, '>=24.16.0');
    for (const script of [
      'desktop:dist:win:unsigned',
      'desktop:dist:mac:x64:unsigned',
      'desktop:dist:mac:arm64:unsigned',
    ]) assert.ok(pkg.scripts[script], `missing ${script}`);
    assert.match(pkg.scripts['desktop:dist:win:unsigned'], /--config\.win\.signExecutable=false/);
    assert.match(pkg.scripts['desktop:dist:mac:x64:unsigned'], /--config\.mac\.identity=null/);
    assert.match(pkg.scripts['desktop:dist:mac:arm64:unsigned'], /--config\.mac\.identity=null/);
    assert.match(pkg.scripts['desktop:dist:mac:x64:unsigned'], /--config\.mac\.hardenedRuntime=false/);
    assert.match(pkg.scripts['desktop:dist:mac:arm64:unsigned'], /--config\.mac\.hardenedRuntime=false/);
    assert.match(pkg.scripts['desktop:dist:mac:x64:unsigned'], /CODE_AGENTS_WEBCLI_SKIP_NOTARIZATION=1/);
    assert.match(pkg.scripts['desktop:dist:mac:arm64:unsigned'], /CODE_AGENTS_WEBCLI_SKIP_NOTARIZATION=1/);
    assert.match(ci, /native-packaged-smoke:/);
    for (const runner of ['windows-latest', 'macos-15-intel', 'macos-15']) {
      assert.match(ci, new RegExp(`os: ${runner}`));
    }
    assert.match(ci, /DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK/);
    assert.match(ci, /WORKSPACE_ENTRY_HELPER_OK app\.asar/);
    assert.match(ci, /Exercise the native workspace helper and serialized database/);
    assert.match(ci, /npm run test:strict -- --test-file test\/workspace-portable-storage\.test\.js --test-file test\/sqlite-adapter\.test\.js/);
    assert.doesNotMatch(ci, /npx mocha --exit test\/workspace-portable-storage\.test\.js test\/sqlite-adapter\.test\.js/);
    assert.doesNotMatch(ci, /run:\s+npm test(?:\s|$)/);
  });

  it('requires and validates the complete unsigned updater asset set before publishing', function () {
    const workflow = read('.github', 'workflows', 'release-on-main.yml');
    const unsigned = workflow.slice(
      workflow.indexOf('  unsigned-release:'),
      workflow.indexOf('\n  flatpak-pages-stage:'),
    );
    assert.match(
      unsigned,
      /node "\$GITHUB_WORKSPACE\/scripts\/release\/validate-release-assets\.js" "\$PWD" "\$VERSION" --unsigned/,
    );
    const packageLoop = /for name in \\\n([\s\S]*?)\s*; do/.exec(unsigned);
    assert.ok(packageLoop, 'unsigned release must name its complete expected asset set');
    const namedAssets = [...packageLoop[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepStrictEqual(namedAssets, [
      'Code-Agents-Web-CLI-${VERSION}-linux-x64.AppImage',
      'Code-Agents-Web-CLI-${VERSION}-linux-x64.deb',
      'Code-Agents-Web-CLI-${VERSION}-linux-x64.rpm',
      'Code-Agents-Web-CLI-${VERSION}-linux-x64.flatpak',
      'Code-Agents-Web-CLI-${VERSION}-win-x64.exe',
      'Code-Agents-Web-CLI-${VERSION}-win-x64.exe.blockmap',
      'Code-Agents-Web-CLI-${VERSION}-mac-x64.dmg',
      'Code-Agents-Web-CLI-${VERSION}-mac-arm64.dmg',
      'Code-Agents-Web-CLI-${VERSION}-mac-x64.zip',
      'Code-Agents-Web-CLI-${VERSION}-mac-arm64.zip',
      'Code-Agents-Web-CLI-${VERSION}-mac-x64.zip.blockmap',
      'Code-Agents-Web-CLI-${VERSION}-mac-arm64.zip.blockmap',
      'latest.yml',
      'latest-linux.yml',
      'latest-x64-mac.yml',
      'latest-arm64-mac.yml',
    ]);
  });

  it('fails closed rather than publishing an interrupted signed draft as unsigned', function () {
    const workflow = YAML.parse(read('.github', 'workflows', 'release-on-main.yml'));
    const unsigned = workflow.jobs['unsigned-release'];
    const guard = unsigned.steps.find((step) => step.name === 'Refuse unsigned resume of a draft release');
    assert.ok(guard, 'the unsigned job must have an explicit draft-resume guard');
    assert.strictEqual(guard.if, "needs.verify.outputs.resume_draft == 'true'");
    assert.match(guard.run, /interrupted signed draft can contain signed-only assets/i);
    assert.match(guard.run, /Delete the draft release manually, then re-run this tag workflow from a clean release slot/i);
    assert.match(guard.run, /exit 1/);

    const releaseCheck = unsigned.steps.find((step) => step.name === 'Refuse to replace an already published release');
    assert.ok(releaseCheck, 'the unsigned job must check its release slot before publishing');
    assert.doesNotMatch(releaseCheck.run, /200:true\) ;;/);
    assert.match(
      releaseCheck.run,
      /200:true\) echo "Unsigned releases cannot resume draft \$tag; delete the draft and restart from a clean release slot\." >&2; exit 1 ;;/,
    );
  });

  it('exposes only boolean signing decisions from the protected identity check', function () {
    const workflow = read('.github', 'workflows', 'release-on-main.yml');
    const identityJob = workflow.slice(
      workflow.indexOf('  release-identities:'),
      workflow.indexOf('\n  desktop:'),
    );
    assert.match(identityJob, /outputs:\n\s+windows: .*outputs\.windows/);
    assert.match(identityJob, /macos: .*outputs\.macos/);
    assert.match(identityJob, /flatpak: .*outputs\.flatpak/);
    assert.match(identityJob, /all_signed: .*outputs\.all_signed/);
    assert.doesNotMatch(identityJob, /echo .*CSC_LINK.*GITHUB_OUTPUT/);
    assert.doesNotMatch(identityJob, /echo .*GPG_PRIVATE_KEY.*GITHUB_OUTPUT/);
    assert.match(identityJob, /Partial desktop signing configuration is unsafe/);
    assert.match(workflow, /runner\.os == 'macOS' && secrets\.MACOS_CSC_LINK \|\| ''/);
  });

  it('validates exact updater assets, hashes, sizes, and embedded AppImage metadata', function () {
    const fixture = createReleaseFixture();
    const validate = () => childProcess.execFileSync('node', [
      'scripts/release/validate-release-assets.js', fixture.directory, fixture.version,
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    try {
      assert.match(validate(), /exact updater metadata/);

      const windowsManifest = fixture.manifests['latest.yml'];
      windowsManifest.files[0].url = `nested/${fixture.names.windows}`;
      fs.writeFileSync(path.join(fixture.directory, 'latest.yml'), JSON.stringify(windowsManifest));
      assert.throws(validate, /exact release-asset basename/);
      windowsManifest.files[0].url = fixture.names.windows;
      fs.writeFileSync(path.join(fixture.directory, 'latest.yml'), JSON.stringify(windowsManifest));

      fs.appendFileSync(path.join(fixture.directory, fixture.names.macArm64Zip), 'tampered');
      assert.throws(validate, /declares size .* actual size is/);
      fs.writeFileSync(path.join(fixture.directory, fixture.names.macArm64Zip), fixture.contents.macArm64Zip);

      const appImageManifest = fixture.manifests['latest-linux.yml'];
      delete appImageManifest.files[0].blockMapSize;
      fs.writeFileSync(path.join(fixture.directory, 'latest-linux.yml'), JSON.stringify(appImageManifest));
      assert.throws(validate, /positive embedded blockMapSize/);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('validates unsigned updater manifests without requiring unavailable Flatpak remote descriptors', function () {
    const fixture = createReleaseFixture(JSON.parse(read('package.json')).version);
    const validateUnsigned = () => childProcess.execFileSync('node', [
      'scripts/release/validate-release-assets.js', fixture.directory, '--unsigned',
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    try {
      for (const key of ['flatpakRef', 'flatpakRepo']) {
        fs.rmSync(path.join(fixture.directory, fixture.names[key]));
      }
      const checksums = fs.readFileSync(path.join(fixture.directory, 'SHA256SUMS'), 'utf8')
        .split('\n')
        .filter((line) => !line.endsWith(fixture.names.flatpakRef) && !line.endsWith(fixture.names.flatpakRepo))
        .join('\n');
      fs.writeFileSync(path.join(fixture.directory, 'SHA256SUMS'), checksums);
      assert.match(validateUnsigned(), /exact updater metadata.*unsigned/);

      fixture.manifests['latest.yml'].files[0].sha512 = 'not-the-asset-hash';
      fs.writeFileSync(path.join(fixture.directory, 'latest.yml'), JSON.stringify(fixture.manifests['latest.yml']));
      assert.throws(validateUnsigned, /sha512 does not match/);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('makes Flatpak bundles repository-aware and does not accept an unsigned fallback', function () {
    const script = read('scripts', 'release', 'release-flatpak-repository.sh');
    assert.match(script, /FLATPAK_GPG_PRIVATE_KEY/);
    assert.match(script, /FLATPAK_GPG_PASSPHRASE/);
    assert.match(script, /flatpak build-sign/);
    assert.match(script, /flatpak build-update-repo/);
    assert.match(script, /--generate-static-deltas/);
    assert.match(script, /--gpg-sign=/);
    assert.match(script, /flatpak build-bundle --repo-url=/);
    assert.match(script, /update-info\.json\.asc/);
    assert.match(script, /gpgv --keyring/);
    assert.match(script, /flatpak-repository-previous|\$\{repository\}-previous/);
    assert.match(script, /previous signed Flatpak activation manifest is inconsistent/);
    assert.match(script, /\.flatpakref/);
    assert.match(script, /RuntimeRepo=https:\/\/dl\.flathub\.org\/repo\/flathub\.flatpakrepo/);
    assert.match(script, /remote-add --gpg-import=/);
    assert.match(script, /pull --depth=-1 previous/);
    assert.match(script, /static-delta generate/);
    assert.match(script, /previous_commit-\$commit/);
  });

  it('installs and launches the produced Flatpak under X11 before deleting its test data', function () {
    const workflow = read('.github', 'workflows', 'release-on-main.yml');
    const start = workflow.indexOf('- name: Smoke the installed Flatpak artifact');
    const end = workflow.indexOf('- uses: actions/upload-artifact@', start);
    assert.ok(start >= 0 && end > start, 'the installed Flatpak smoke precedes artifact upload');
    const smoke = workflow.slice(start, end);
    assert.match(smoke, /flatpak install --user --noninteractive --no-deps --bundle "\$bundle"/);
    assert.match(smoke, /timeout --signal=TERM 120s dbus-run-session --/);
    assert.match(smoke, /xvfb-run -a flatpak run --user --die-with-parent/);
    assert.match(smoke, /--socket=x11 --nosocket=wayland/);
    assert.match(smoke, /--env=CODE_AGENTS_WEBCLI_DESKTOP_SMOKE=1/);
    assert.match(smoke, /--env=ELECTRON_OZONE_PLATFORM_HINT=x11/);
    for (const marker of [
      'DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK',
      'DESKTOP_PACKAGED_RENDERER_SMOKE_OK',
      'DESKTOP_SMOKE_OK',
    ]) {
      assert.match(smoke, new RegExp(marker));
    }
    assert.match(smoke, /flatpak uninstall --user --noninteractive --delete-data "\$app_id"/);
    assert.match(smoke, /test ! -e "\$app_data"/);
    assert.match(smoke, /Native[\s\S]*document-portal consent remains a manual packaged-platform check/);
    assert.ok(
      smoke.indexOf('flatpak install') < smoke.indexOf('xvfb-run')
        && smoke.indexOf('xvfb-run') < smoke.lastIndexOf('flatpak uninstall'),
      'the generated package is installed, launched, and only then uninstalled',
    );
  });

  it('rejects a Flatpak permission expansion unless the exact bridge tag is approved', function () {
    const script = read('scripts', 'release', 'validate-flatpak-permissions.js');
    assert.match(script, /updaterBridgeTag === releaseTag/);
    assert.match(script, /added\.length === 1/);
    assert.match(script, /org\.freedesktop\.portal\.Flatpak/);
    assert.match(script, /releaseTag === 'v6\.1\.1'/);
    assert.match(script, /org\.freedesktop\.Flatpak/);
  });

  it('requires exact installed old-to-new evidence for all five package paths', function () {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-updater-qualification-'));
    const filename = path.join(temporary, 'qualification.json');
    const assets = path.join(temporary, 'assets');
    const feed = path.join(temporary, 'feed');
    fs.mkdirSync(assets);
    fs.mkdirSync(feed);
    const tag = 'v6.2.0';
    const commit = 'a'.repeat(40);
    let evidenceIndex = 12345;
    const assetNames = {
      'windows-nsis': 'Code-Agents-Web-CLI-6.2.0-win-x64.exe',
      'linux-appimage': 'Code-Agents-Web-CLI-6.2.0-linux-x64.AppImage',
      'macos-x64': 'Code-Agents-Web-CLI-6.2.0-mac-x64.zip',
      'macos-arm64': 'Code-Agents-Web-CLI-6.2.0-mac-arm64.zip',
    };
    const packages = ['windows-nsis', 'linux-appimage', 'linux-flatpak', 'macos-x64', 'macos-arm64'];
    const flatpakCommit = 'b'.repeat(64);
    const flatpakFiles = {
      'code-agents-webcli.gpg': Buffer.from('public-key'),
      summary: Buffer.from('signed-summary'),
      'summary.sig': Buffer.from('summary-signature'),
      'update-info.json': Buffer.from(JSON.stringify({ version: '6.2.0', commit: flatpakCommit })),
      'update-info.json.asc': Buffer.from('manifest-signature'),
    };
    for (const [name, contents] of Object.entries(flatpakFiles)) fs.writeFileSync(path.join(feed, name), contents);
    const releaseAssets = {};
    const value = {
      schemaVersion: 2,
      tag,
      commit,
      baseVersion: '6.1.0',
      targetVersion: '6.2.0',
      completedAt: new Date().toISOString(),
      releaseAssets,
      results: Object.fromEntries(packages.map((name) => {
        if (name === 'linux-flatpak') {
          return [name, {
            passed: true,
            evidence: `https://github.com/dnviti/code-agents-webcli/actions/runs/${evidenceIndex++}`,
            payload: {
              kind: 'flatpak-repository',
              commit: flatpakCommit,
              files: Object.fromEntries(Object.entries(flatpakFiles).map(([filename, contents]) => [
                filename, crypto.createHash('sha256').update(contents).digest('hex'),
              ])),
            },
          }];
        }
        const contents = Buffer.from(`qualified-${name}`);
        fs.writeFileSync(path.join(assets, assetNames[name]), contents);
        releaseAssets[assetNames[name]] = crypto.createHash('sha256').update(contents).digest('hex');
        return [name, {
          passed: true,
          evidence: `https://github.com/dnviti/code-agents-webcli/actions/runs/${evidenceIndex++}`,
          payload: {
            kind: 'asset',
            name: assetNames[name],
            sha256: crypto.createHash('sha256').update(contents).digest('hex'),
          },
        }];
      })),
    };
    const validate = () => childProcess.execFileSync('node', [
      'scripts/release/validate-desktop-updater-qualification.js', filename, tag, commit, assets, feed,
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    const evidenceFile = path.join(temporary, 'desktop-updater-evidence.json');
    const validateEvidence = (packageName) => childProcess.execFileSync('node', [
      'scripts/release/validate-desktop-updater-trial-evidence.js', evidenceFile, packageName, filename,
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    try {
      fs.writeFileSync(filename, JSON.stringify(value));
      assert.match(validate(), /installed old-to-new qualification/);
      fs.writeFileSync(evidenceFile, JSON.stringify({
        schemaVersion: 1,
        package: 'macos-x64',
        tag,
        commit,
        baseVersion: value.baseVersion,
        targetVersion: value.targetVersion,
        passed: true,
        completedAt: new Date().toISOString(),
        payload: value.results['macos-x64'].payload,
      }));
      assert.match(validateEvidence('macos-x64'), /installed-trial evidence/);
      const mismatchedEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      mismatchedEvidence.payload.sha256 = 'f'.repeat(64);
      fs.writeFileSync(evidenceFile, JSON.stringify(mismatchedEvidence));
      assert.throws(() => validateEvidence('macos-x64'), /does not match the staged candidate/);
      const macArmResult = structuredClone(value.results['macos-arm64']);
      delete value.results['macos-arm64'];
      fs.writeFileSync(filename, JSON.stringify(value));
      assert.throws(validate, /cover exactly every current desktop package/);
      value.results['macos-arm64'] = { ...macArmResult, evidence: 'https://example.test/run/1' };
      fs.writeFileSync(filename, JSON.stringify(value));
      assert.throws(validate, /successful same-repository evidence/);
      value.results['macos-arm64'] = { ...macArmResult, evidence: value.results['macos-x64'].evidence };
      fs.writeFileSync(filename, JSON.stringify(value));
      assert.throws(validate, /own installed-trial evidence run/);
      value.results['macos-arm64'] = {
        ...macArmResult,
        evidence: 'https://github.com/dnviti/code-agents-webcli/actions/runs/99999',
        payload: { ...macArmResult.payload, sha256: '0'.repeat(64) },
      };
      fs.writeFileSync(filename, JSON.stringify(value));
      assert.throws(validate, /exact updater payload|changed after qualification|payload is not in the bound draft/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('enforces the Flatpak permission migration gate mechanically', function () {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-flatpak-permissions-'));
    const previous = path.join(temporary, 'previous.yml');
    const current = path.join(temporary, 'current.yml');
    const config = (args) => `flatpak:\n  finishArgs:\n${args.map((arg) => `    - ${arg}`).join('\n')}\nwin:\n  target: nsis\n`;
    try {
      fs.writeFileSync(previous, config(['--share=network']));
      fs.writeFileSync(current, config(['--share=network', '--talk-name=org.freedesktop.portal.Flatpak']));
      assert.throws(() => childProcess.execFileSync('node', [
        'scripts/release/validate-flatpak-permissions.js', previous, current, 'v6.1.0', '',
      ], { cwd: root, stdio: 'pipe' }), /Flatpak finish-args expanded/);
      childProcess.execFileSync('node', [
        'scripts/release/validate-flatpak-permissions.js', previous, current, 'v6.1.0', 'v6.1.0',
      ], { cwd: root, stdio: 'pipe' });
      fs.writeFileSync(previous, config(['--share=network', '--talk-name=org.freedesktop.portal.Flatpak']));
      fs.writeFileSync(current, config([
        '--share=network',
        '--talk-name=org.freedesktop.portal.Flatpak',
        '--talk-name=org.freedesktop.Flatpak',
      ]));
      childProcess.execFileSync('node', [
        'scripts/release/validate-flatpak-permissions.js', previous, current, 'v6.1.1', 'v6.1.1',
      ], { cwd: root, stdio: 'pipe' });
      assert.throws(() => childProcess.execFileSync('node', [
        'scripts/release/validate-flatpak-permissions.js', previous, current, 'v6.1.2', 'v6.1.2',
      ], { cwd: root, stdio: 'pipe' }), /Flatpak finish-args expanded/);
      fs.writeFileSync(current, config([
        '--share=network',
        '--talk-name=org.freedesktop.portal.Flatpak',
        '--filesystem=host',
      ]));
      assert.throws(() => childProcess.execFileSync('node', [
        'scripts/release/validate-flatpak-permissions.js', previous, current, 'v6.1.0', 'v6.1.0',
      ], { cwd: root, stdio: 'pipe' }), /Future permission changes require/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
