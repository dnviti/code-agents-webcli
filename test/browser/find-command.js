'use strict';

const fs = require('node:fs');
const path = require('node:path');

function environmentPath(environment) {
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH');
  return key ? environment[key] || '' : '';
}

function executableExtensions(command, platform, environment) {
  if (platform !== 'win32' || path.win32.extname(command)) return [''];
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATHEXT');
  const value = key ? environment[key] : undefined;
  return (value || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
}

function systemExecutable(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findCommand(commands, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const isExecutable = options.isExecutable || systemExecutable;
  const directories = environmentPath(environment)
    .split(delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ''))
    .filter(Boolean);

  for (const command of commands) {
    for (const directory of directories) {
      for (const extension of executableExtensions(command, platform, environment)) {
        const candidate = pathApi.join(directory, `${command}${extension}`);
        if (isExecutable(candidate, platform)) return candidate;
      }
    }
  }
  return null;
}

module.exports = { findCommand };
