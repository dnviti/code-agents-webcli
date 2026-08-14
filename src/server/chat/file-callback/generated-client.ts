/**
 * Plain JavaScript embedded into generated remote clients. Keeping one source
 * here prevents the MCP bridge and pi extension from drifting onto different
 * crypto or path-validation protocols.
 */
export const FILE_CALLBACK_GENERATED_CLIENT_SOURCE = String.raw`
const CALLBACK_AAD_PREFIX = 'ccweb-file-callback-v1:';
const CALLBACK_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

function callbackAad(kind, id) { return CALLBACK_AAD_PREFIX + kind + ':' + id; }
function callbackKey(token) {
  return crypto.createHash('sha256').update('ccweb-file-callback-key-v1\0').update(token).digest();
}
function callbackSameDirectory(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
function callbackFdAccessPath(handle) {
  return process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : '/dev/fd/' + handle.fd;
}
function callbackChildName(file) {
  const name = path.basename(file);
  if (!name || name === '.' || name === '..' || name.includes('/') ||
      name.includes('\\') || name.includes('\0')) {
    throw new Error('unsafe callback child: ' + file);
  }
  return name;
}
function callbackChildPath(opened, file) {
  return path.join(opened.accessPath, callbackChildName(file));
}
async function callbackOpenDirectory(directory, expected) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('unsafe callback directory: ' + directory);
  }
  try {
    const stat = await handle.stat();
    const identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isDirectory() || (expected && !callbackSameDirectory(identity, expected))) {
      throw new Error('unsafe callback directory: ' + directory);
    }
    const accessPath = callbackFdAccessPath(handle);
    const anchored = await fs.stat(accessPath).catch(() => null);
    if (!anchored || !anchored.isDirectory() || !callbackSameDirectory(anchored, identity)) {
      throw new Error('callback fd access is unavailable');
    }
    return { handle, accessPath, path: directory, ...identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
async function callbackDirectory(directory, expected) {
  const opened = await callbackOpenDirectory(directory, expected);
  await opened.handle.close();
  return { path: directory, dev: opened.dev, ino: opened.ino };
}
async function callbackVerifyVisible(directory, opened) {
  const visible = await callbackOpenDirectory(directory.path, directory).catch(() => null);
  if (!visible) throw new Error('unsafe callback directory: ' + directory.path);
  try {
    const current = await opened.handle.stat();
    if (!callbackSameDirectory(current, visible)) {
      throw new Error('unsafe callback directory: ' + directory.path);
    }
  } finally {
    await visible.handle.close();
  }
}
async function callbackWithDirectory(directory, operation) {
  const opened = await callbackOpenDirectory(directory.path, directory);
  try {
    const result = await operation(opened);
    await callbackVerifyVisible(directory, opened);
    return result;
  } finally {
    await opened.handle.close();
  }
}
async function callbackAssertDirectory(directory) {
  await callbackWithDirectory(directory, async () => undefined);
}
async function callbackLayout(directory) {
  const base = await callbackDirectory(path.dirname(directory));
  const layout = await callbackWithDirectory(base, async (openedBase) => {
    const openedEndpoint = await callbackOpenDirectory(
      callbackChildPath(openedBase, path.basename(directory)),
    );
    try {
      const children = [];
      try {
        for (const name of ['requests', 'replies', 'cancelled']) {
          children.push(await callbackOpenDirectory(callbackChildPath(openedEndpoint, name)));
        }
        return {
          base,
          endpoint: { path: directory, dev: openedEndpoint.dev, ino: openedEndpoint.ino },
          requests: { path: path.join(directory, 'requests'), dev: children[0].dev, ino: children[0].ino },
          replies: { path: path.join(directory, 'replies'), dev: children[1].dev, ino: children[1].ino },
          cancelled: { path: path.join(directory, 'cancelled'), dev: children[2].dev, ino: children[2].ino },
        };
      } finally {
        await Promise.all(children.map((child) => child.handle.close()));
      }
    } finally {
      await openedEndpoint.handle.close();
    }
  });
  await callbackAssertLayout(layout);
  return layout;
}
async function callbackAssertLayout(layout) {
  await Promise.all([
    callbackAssertDirectory(layout.base),
    callbackAssertDirectory(layout.endpoint),
    callbackAssertDirectory(layout.requests),
    callbackAssertDirectory(layout.replies),
    callbackAssertDirectory(layout.cancelled),
  ]);
}
function callbackEncrypt(token, associatedData, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', callbackKey(token), iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}
function callbackDecrypt(token, associatedData, value) {
  try {
    if (!value || value.v !== 1 || typeof value.iv !== 'string' ||
        typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') {
      throw new Error('invalid envelope');
    }
    const iv = Buffer.from(value.iv, 'base64url');
    const tag = Buffer.from(value.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', callbackKey(token), iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('invalid encrypted callback envelope');
  }
}
async function callbackAtomic(directory, file, token, associatedData, value) {
  await callbackWithDirectory(directory, async (opened) => {
    const targetName = callbackChildName(file);
    const target = callbackChildPath(opened, targetName);
    const temporary = callbackChildPath(
      opened, targetName + '.' + crypto.randomBytes(12).toString('hex') + '.tmp',
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(callbackEncrypt(token, associatedData, value)), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  });
}
async function callbackRead(directory, file, token, associatedData) {
  return callbackWithDirectory(directory, async (opened) => {
    let handle;
    try {
      handle = await fs.open(callbackChildPath(opened, file), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('unsafe callback file: ' + file);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CALLBACK_MAX_ENVELOPE_BYTES) {
        throw new Error('invalid encrypted callback envelope');
      }
      const serialized = await handle.readFile({ encoding: 'utf8' });
      return callbackDecrypt(token, associatedData, JSON.parse(serialized));
    } catch (error) {
      if (error?.message?.startsWith('unsafe callback')) throw error;
      throw new Error('invalid encrypted callback envelope');
    } finally {
      await handle.close();
    }
  });
}
async function callbackUnlink(directory, file) {
  await callbackWithDirectory(directory, async (opened) => {
    await fs.unlink(callbackChildPath(opened, file))
      .catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  });
}
`;
