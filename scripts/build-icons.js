#!/usr/bin/env node
// Rasterise the app icons from assets/icon.svg.
//
// The icons used to be generated per-request by an Express route that returned
// an SVG document for both the .svg and the .png URL. That is why the PWA was
// not installable on iOS: `apple-touch-icon` must be a real PNG, and Safari
// silently ignores anything that is not. Rasterising once at build time gives
// every platform the bytes it actually expects, and lets the icon be a designed
// asset in the repo rather than a template literal in a route handler.
//
// Requires ImageMagick with an SVG delegate (librsvg). Icons are committed
// build output: if ImageMagick is missing, existing files are left alone rather
// than the build failing, because a developer without it can still work.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'src', 'public', 'icons');

/** Sizes the manifest, the browser tab, iOS and Windows tiles ask for. */
const ANY_SIZES = [16, 32, 48, 144, 180, 192, 256, 512];
/** Android crops these, so they come from the padded artwork. */
const MASKABLE_SIZES = [192, 512];
/** Multi-resolution favicon, for the `/favicon.ico` browsers request unasked. */
const ICO_SIZES = [16, 32, 48];

function magick() {
  for (const bin of ['magick', 'convert']) {
    if (spawnSync('which', [bin], { stdio: 'ignore' }).status === 0) return bin;
  }
  return null;
}

function render(bin, src, size, dest) {
  // -background none keeps the artwork's own fill authoritative; the master
  // paints its own opaque square, so this only matters if that ever changes.
  execFileSync(bin, [
    '-background', 'none',
    '-density', '384',
    `${src}[${size}x${size}]`,
    '-resize', `${size}x${size}`,
    '-strip',
    `PNG32:${dest}`,
  ]);
}

function main() {
  const bin = magick();
  if (!bin) {
    console.log('[icons] ImageMagick not found; leaving the committed icons in place.');
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });

  const any = path.join(ASSETS, 'icon.svg');
  const maskable = path.join(ASSETS, 'icon-maskable.svg');

  for (const size of ANY_SIZES) {
    render(bin, any, size, path.join(OUT, `icon-${size}.png`));
  }
  for (const size of MASKABLE_SIZES) {
    render(bin, maskable, size, path.join(OUT, `icon-maskable-${size}.png`));
  }

  // The source SVG doubles as the scalable favicon modern browsers prefer.
  fs.copyFileSync(any, path.join(OUT, 'icon.svg'));

  execFileSync(bin, [
    ...ICO_SIZES.map((s) => path.join(OUT, `icon-${s}.png`)),
    path.join(ROOT, 'src', 'public', 'favicon.ico'),
  ]);

  const count = ANY_SIZES.length + MASKABLE_SIZES.length;
  console.log(`[icons] ${count} PNGs + favicon.ico from assets/icon.svg`);
}

main();
