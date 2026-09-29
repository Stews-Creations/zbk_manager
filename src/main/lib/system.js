/**
 * system.js - Facts about this computer: its network address and Java.
 */

const os = require('os');
const { spawn } = require('child_process');

/** The address other computers on the same network use to reach this one. */
function getLanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

/** Extract the major version from `java -version` output. */
function parseJavaVersion(output) {
  const match = output.match(/version "([^"]+)"/);
  if (!match) return null;
  const parts = match[1].split(/[._-]/);
  const major = parts[0] === '1' ? Number(parts[1]) : Number(parts[0]);
  return { version: match[1], major: Number.isFinite(major) ? major : null };
}

/** Resolve to { installed, version, major } for the Java found on PATH. */
function checkJava(command = 'java') {
  return new Promise(resolve => {
    let output = '';
    let child;
    try {
      child = spawn(command, ['-version'], { windowsHide: true });
    } catch {
      resolve({ installed: false, version: null, major: null });
      return;
    }
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', () => resolve({ installed: false, version: null, major: null }));
    child.on('close', code => {
      const parsed = code === 0 ? parseJavaVersion(output) : null;
      resolve(parsed ? { installed: true, ...parsed } : { installed: false, version: null, major: null });
    });
  });
}

module.exports = { getLanAddress, parseJavaVersion, checkJava };
