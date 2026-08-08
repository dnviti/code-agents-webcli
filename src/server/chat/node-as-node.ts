/**
 * Environment for a node child this app asks the agent to spawn.
 *
 * The desktop app is packaged as an Electron binary, and `process.execPath`
 * inside Electron is that binary, not node. Electron runs node scripts only
 * when told it is acting as node (`ELECTRON_RUN_AS_NODE=1`). Every child this
 * app hands a runtime — the ccweb question server (MCP), the pi extension
 * launcher, the Claude permission hook — is such a node script, so when we are
 * running as Electron and the child will re-execute our own binary (the
 * default, `nodePath = process.execPath`), the child env must carry that flag.
 *
 * The web/server build runs on actual node, where the flag is meaningless, and
 * a container child runs the image's own `node`; neither should see it.
 *
 * Blended into the child descriptors so the runtime passes it through when it
 * spawns the MCP server / hook; a bare host path on the payload's far side
 * would be read by Rust or Go code that does not know node's runtime quirks.
 */
export function electronAsNodeEnv(nodePath: string): Record<string, string> {
  if (!process.versions.electron) return {};
  if (nodePath !== process.execPath) return {};
  return { ELECTRON_RUN_AS_NODE: '1' };
}
