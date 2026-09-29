/**
 * check_package.js - Inspect a finished build before it is published.
 *
 * Usage: node tools/check_package.js [dist folder] [expected version]
 *
 * Confirms that the installer and portable executable exist, that the license
 * documents ship beside the app unchanged, that third-party notices are
 * present, and that the packaged app holds only application files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
const version = process.argv[3] || require(path.join(root, 'package.json')).version;

const LICENSE_DOCUMENTS = [
  'LICENSE.md',
  'NOTICE',
  'MEDIA_PERMISSION.md',
  'CC-BY-NC-4.0.txt',
  'PolyForm-Noncommercial-1.0.0.txt'
];
const THIRD_PARTY_NOTICES = ['LICENSE.electron.txt', 'LICENSES.chromium.html'];
const REQUIRED_APP_FILES = [
  'package.json',
  'assets/icon.png',
  'src/main/main.js',
  'src/main/preload.js',
  'src/renderer/index.html'
];
const ALLOWED_APP_ROOTS = ['package.json', 'assets', 'src'];
const LOCAL_ONLY = /(^|\/)(AGENTS(\.override)?\.md|CLAUDE\.md|GEMINI\.md|SKILL\.md|\.codex|\.claude|\.agents|\.cursor|\.mcp\.json|\.env)(\/|$)/i;

const problems = [];
const fail = message => problems.push(message);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** Read the file table at the start of an asar archive. */
function readAsarIndex(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(handle, sizes, 0, 16, 0);
    const length = sizes.readUInt32LE(12);
    const json = Buffer.alloc(length);
    fs.readSync(handle, json, 0, length, 16);
    return { index: JSON.parse(json.toString('utf8')), dataStart: 8 + sizes.readUInt32LE(4) };
  } finally {
    fs.closeSync(handle);
  }
}

function listEntries(node, prefix = '') {
  const entries = [];
  for (const [name, child] of Object.entries(node.files || {})) {
    const entry = prefix ? `${prefix}/${name}` : name;
    if (child.files) entries.push(...listEntries(child, entry));
    else entries.push({ path: entry, ...child });
  }
  return entries;
}

function readEntry(file, dataStart, entry) {
  const handle = fs.openSync(file, 'r');
  try {
    const contents = Buffer.alloc(entry.size);
    fs.readSync(handle, contents, 0, entry.size, dataStart + Number(entry.offset));
    return contents;
  } finally {
    fs.closeSync(handle);
  }
}

// -- Installers --

const installers = [
  `ZBK-Server-Setup-${version}.exe`,
  `ZBK-Server-${version}-portable.exe`
];
for (const name of installers) {
  if (!isFile(path.join(dist, name))) fail(`${name} was not built`);
}

// -- License documents and notices --

const unpacked = path.join(dist, 'win-unpacked');
for (const name of LICENSE_DOCUMENTS) {
  const packaged = path.join(unpacked, 'LICENSES', name);
  const source = path.join(root, 'LICENSES', name);
  if (!isFile(packaged)) fail(`LICENSES/${name} is missing from the app folder`);
  else if (!fs.readFileSync(packaged).equals(fs.readFileSync(source))) fail(`LICENSES/${name} differs from the repository copy`);
}
for (const name of THIRD_PARTY_NOTICES) {
  if (!isFile(path.join(unpacked, name))) fail(`${name} is missing from the app folder`);
}

// -- Packaged application --

const archive = path.join(unpacked, 'resources', 'app.asar');
if (!isFile(archive)) {
  fail('resources/app.asar is missing');
} else {
  const { index, dataStart } = readAsarIndex(archive);
  const entries = listEntries(index);
  const paths = new Set(entries.map(entry => entry.path));

  for (const name of REQUIRED_APP_FILES) {
    if (!paths.has(name)) fail(`The packaged app is missing ${name}`);
  }
  for (const entry of entries) {
    if (LOCAL_ONLY.test(entry.path)) fail(`The packaged app contains a local-only file: ${entry.path}`);
    if (!ALLOWED_APP_ROOTS.includes(entry.path.split('/')[0])) fail(`The packaged app contains an unexpected file: ${entry.path}`);
  }

  const manifest = entries.find(entry => entry.path === 'package.json');
  if (manifest) {
    const packaged = JSON.parse(readEntry(archive, dataStart, manifest).toString('utf8'));
    if (packaged.version !== version) fail(`The packaged app is version ${packaged.version}, expected ${version}`);
  }
  console.log(`Packaged app: ${entries.length} files`);
}

// -- Result --

if (problems.length) {
  for (const problem of problems) console.error(`FAILED: ${problem}`);
  process.exit(1);
}

const sums = installers.map(name => `${sha256(path.join(dist, name))}  ${name}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
for (const line of sums) console.log(line);
console.log(`ZBK Server ${version} passed the package checks.`);
