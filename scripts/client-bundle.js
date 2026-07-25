/**
 * The esbuild settings the shipped client bundle is built with.
 *
 * Shared with the browser checks so they exercise the same output the user
 * gets. They used to be bundled unminified at a different target, which meant a
 * defect the production settings introduced could not be reproduced by any
 * test — see CLIENT_TARGET below for the one that got through.
 */

/**
 * es2021, not es2020, for the logical assignment operators (`||=`, `&&=`, `??=`).
 *
 * At es2020 esbuild lowers them, and lowering `let r; ... (r ||= {})` while the
 * minifier drops the write-only `r` produced `void 0 || (i = {})` — an
 * assignment to a name declared nowhere, which throws `ReferenceError` in a
 * strict-mode bundle. It landed in xterm's DECRQM handler, so any program that
 * queried a terminal mode killed the write loop and the screen went black.
 *
 * Everything this app needs (xterm 6, WebGL) requires far newer engines than
 * the operators do (Chrome 85 / Safari 14 / Firefox 79), so nothing is lost.
 */
const CLIENT_TARGET = ['es2021'];

module.exports = { CLIENT_TARGET };
