#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CAPABILITIES, probeCapabilities } = require('./capabilities.js');
const {
  capabilityManifest,
  strictCapabilityManifest,
  requiredCapabilitiesFor,
} = require('./capability-manifest.js');

function discoverTests(root = process.cwd()) {
  const testDirectory = path.join(root, 'test');
  return fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

function parseArguments(argv) {
  let strict = false;
  let forwarding = false;
  const mochaArgs = [];
  const testFiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      forwarding = true;
      mochaArgs.push(argument);
    } else if (!forwarding && argument === '--strict') {
      strict = true;
    } else if (!forwarding && argument === '--test-file') {
      const testFile = argv[index + 1];
      if (!testFile || testFile.startsWith('--')) {
        throw new Error('--test-file requires an exact discovered test path');
      }
      testFiles.push(testFile);
      index += 1;
    } else if (!forwarding && argument.startsWith('--test-file=')) {
      const testFile = argument.slice('--test-file='.length);
      if (!testFile) throw new Error('--test-file requires an exact discovered test path');
      testFiles.push(testFile);
    } else {
      mochaArgs.push(argument);
    }
  }
  return { strict, testFiles, mochaArgs };
}

function validateManifest(files, manifest = capabilityManifest) {
  const discovered = new Set(files);
  for (const [file, capabilities] of Object.entries(manifest)) {
    if (!discovered.has(file)) throw new Error(`Capability manifest references undiscovered test file: ${file}`);
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(`Capability manifest references unknown capability ${capability} for ${file}`);
      }
    }
  }
}

function planTestRun(files, results, root = process.cwd(), options = {}) {
  const eligible = [];
  const skipped = [];
  for (const file of files) {
    const missing = requiredCapabilitiesFor(file, root, options)
      .filter((capability) => !results[capability]?.available)
      .map((capability) => ({ capability, detail: results[capability]?.detail || 'not probed' }));
    if (missing.length) skipped.push({ file, missing });
    else eligible.push(file);
  }
  return { eligible, skipped };
}

function selectTestFiles(discovered, requested) {
  if (!requested.length) return discovered;
  const available = new Set(discovered);
  for (const file of requested) {
    if (!available.has(file)) throw new Error(`--test-file must name a discovered test file: ${file}`);
  }
  return requested;
}

function formatSkipped(skipped, strict = false) {
  const heading = strict
    ? 'Required test capabilities are unavailable; strict mode will not start Mocha:'
    : 'Skipped test files because required capabilities are unavailable:';
  return [heading, ...skipped.map(({ file, missing }) => (
    `- ${file}: ${missing.map(({ capability, detail }) => `${capability} (${detail})`).join(', ')}`
  ))].join('\n');
}

function formatCounts(selected, plan) {
  return `Test selection: selected ${selected}, eligible ${plan.eligible.length}, skipped ${plan.skipped.length}.`;
}

async function runMochaInProcess(args, root = process.cwd()) {
  // Some restricted runners permit the initial Node process but deny nested
  // child processes.  The programmatic runner keeps the inherited streams,
  // while its completion callback gives this wrapper the real failure count.
  const Mocha = require('mocha');
  const { loadOptions } = require('mocha/lib/cli/options');
  const options = loadOptions(args);
  const files = options._ || [];
  delete options._;
  const mocha = new Mocha(options);
  for (const file of files) mocha.addFile(path.resolve(root, file));
  await mocha.loadFilesAsync();
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => resolve(failures ? 1 : 0));
    } catch (error) {
      reject(error);
    }
  });
}

async function withStrictTestEnvironment(strict, operation, environment = process.env) {
  if (!strict) return operation();
  const hadValue = Object.prototype.hasOwnProperty.call(environment, 'CCWEB_TEST_STRICT');
  const previous = environment.CCWEB_TEST_STRICT;
  environment.CCWEB_TEST_STRICT = '1';
  try {
    return await operation();
  } finally {
    if (hadValue) environment.CCWEB_TEST_STRICT = previous;
    else delete environment.CCWEB_TEST_STRICT;
  }
}

function flushStream(stream) {
  return new Promise((resolve) => {
    try { stream.write('', resolve); } catch { resolve(); }
  });
}

async function finishCliRun(result, options = {}) {
  const setExitCode = options.setExitCode || ((status) => { process.exitCode = status; });
  if (!result.inProcess) {
    setExitCode(result.status);
    return;
  }
  await Promise.all([
    flushStream(options.stdout || process.stdout),
    flushStream(options.stderr || process.stderr),
  ]);
  (options.exit || process.exit)(result.status);
}

async function runTestCommand(options = {}) {
  const root = options.root || process.cwd();
  const print = options.print || console.log;
  const parsed = parseArguments(options.argv || process.argv.slice(2));
  const discovered = options.files || discoverTests(root);
  const files = selectTestFiles(discovered, parsed.testFiles);
  // Validate against the complete repository even when a caller injects a
  // smaller file list for a focused contract test.
  validateManifest(discoverTests(root), options.manifest || capabilityManifest);
  validateManifest(discoverTests(root), options.strictManifest || strictCapabilityManifest);
  const capabilityOptions = { strict: parsed.strict };
  const needed = [...new Set(files.flatMap((file) => requiredCapabilitiesFor(file, root, capabilityOptions)))];
  const results = options.results || await (options.probeCapabilities || probeCapabilities)(needed);
  const plan = planTestRun(files, results, root, capabilityOptions);

  print(formatCounts(files.length, plan));
  if (plan.skipped.length) print(formatSkipped(plan.skipped, parsed.strict));
  if (parsed.strict && plan.skipped.length) return { status: 1, plan, strictFailure: true };
  if (!plan.eligible.length) return { status: 0, plan, strictFailure: false };

  const mocha = require.resolve('mocha/bin/mocha.js');
  const mochaArgs = [
    mocha,
    '--exit',
    ...parsed.mochaArgs,
    ...plan.eligible,
  ];
  const childEnvironment = {
    ...process.env,
    ...(parsed.strict ? { CCWEB_TEST_STRICT: '1' } : {}),
  };
  const child = (options.spawnSync || spawnSync)(process.execPath, mochaArgs, {
    cwd: root,
    stdio: 'inherit',
    env: childEnvironment,
  });
  if (child.error) {
    if (child.error.code === 'EPERM') {
      print('Mocha subprocess is unavailable; running eligible tests in-process with inherited stdio.');
      const status = await withStrictTestEnvironment(parsed.strict, () => (
        (options.runInProcessMocha || runMochaInProcess)(mochaArgs.slice(1), root)
      ));
      return { status: Number.isInteger(status) ? status : 1, plan, strictFailure: false, inProcess: true };
    }
    print(`Unable to start Mocha: ${child.error.message}`);
    return { status: 1, plan, strictFailure: false };
  }
  return { status: Number.isInteger(child.status) ? child.status : 1, plan, strictFailure: false };
}

if (require.main === module) {
  runTestCommand().then(finishCliRun).catch(async (error) => {
    console.error(error.stack || error.message);
    await finishCliRun({ status: 1, inProcess: true });
  });
}

module.exports = {
  discoverTests,
  formatSkipped,
  formatCounts,
  finishCliRun,
  parseArguments,
  planTestRun,
  runMochaInProcess,
  runTestCommand,
  selectTestFiles,
  validateManifest,
  withStrictTestEnvironment,
};
