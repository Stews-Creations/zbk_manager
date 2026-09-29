/**
 * resource-pack.js - Validate a server resource pack and serve it to players.
 *
 * A dedicated server never sends files from its world folder. Players only
 * receive the pack named by the resource-pack address in server.properties,
 * so the pack is hashed and offered over HTTP from this computer.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const { listZipEntries } = require('./zip');

const PACK_ROUTE = '/resource_pack.zip';
const PORT_ATTEMPTS = 10;

/** Hash a file without loading it into memory. */
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Check that a ZIP is laid out the way Minecraft expects. */
async function inspectResourcePack(zipPath) {
  let stat;
  try {
    stat = await fsp.stat(zipPath);
  } catch {
    return { valid: false, error: 'That file no longer exists.' };
  }
  if (!stat.isFile() || !zipPath.toLowerCase().endsWith('.zip')) {
    return { valid: false, error: 'Choose a resource pack ZIP file.' };
  }

  let entries;
  try {
    entries = await listZipEntries(zipPath);
  } catch (error) {
    return { valid: false, error: error.message };
  }

  if (!entries.includes('pack.mcmeta')) {
    const nested = entries.find(entry => /^[^/]+\/pack\.mcmeta$/.test(entry));
    return {
      valid: false,
      error: nested
        ? `pack.mcmeta is inside the "${nested.split('/')[0]}" folder. Zip the contents of that folder so pack.mcmeta sits at the top of the ZIP.`
        : 'No pack.mcmeta was found. This does not look like a resource pack.'
    };
  }
  if (!entries.some(entry => entry.startsWith('assets/'))) {
    return { valid: false, error: 'No assets folder was found. This looks like a datapack, not a resource pack.' };
  }

  return {
    valid: true,
    path: zipPath,
    name: path.basename(zipPath),
    size: stat.size,
    sha1: await sha1File(zipPath)
  };
}

/** Minecraft wants a stable pack id; derive it from the content hash. */
function packIdFromSha1(sha1) {
  const hex = sha1.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * Serve one ZIP at /resource_pack.zip. Tries the next ports when the first is
 * busy. Resolves to { port, close }.
 */
async function hostResourcePack(zipPath, preferredPort) {
  const { size } = await fsp.stat(zipPath);

  const server = http.createServer((request, response) => {
    const route = (request.url || '').split('?')[0];
    if (route !== PACK_ROUTE || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(zipPath)
      .on('error', () => response.destroy())
      .pipe(response);
  });

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = preferredPort === 0 ? 0 : preferredPort + attempt;
    try {
      await listen(server, port);
      return {
        port: server.address().port,
        close: () => new Promise(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || preferredPort === 0) throw error;
    }
  }
  throw new Error(`Ports ${preferredPort} to ${preferredPort + PORT_ATTEMPTS - 1} are all in use.`);
}

module.exports = { PACK_ROUTE, sha1File, inspectResourcePack, packIdFromSha1, hostResourcePack };
