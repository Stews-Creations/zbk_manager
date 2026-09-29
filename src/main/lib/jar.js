/**
 * jar.js - Find and download the official Minecraft server for a version.
 *
 * Downloads come from Mojang and are checked against the published SHA-1
 * before they replace an existing server.jar.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Mojang returned HTTP ${response.status}.`);
  return response.json();
}

/** Look up the server download and required Java for a Minecraft version. */
async function resolveServerDownload(version, fetchImpl = fetch) {
  const manifest = await fetchJson(VERSION_MANIFEST_URL, fetchImpl);
  const entry = manifest.versions.find(candidate => candidate.id === version);
  if (!entry) throw new Error(`Minecraft ${version} was not found in Mojang's version list.`);

  const details = await fetchJson(entry.url, fetchImpl);
  const server = details.downloads && details.downloads.server;
  if (!server) throw new Error(`Mojang does not publish a server for Minecraft ${version}.`);

  return {
    version,
    url: server.url,
    sha1: server.sha1,
    size: server.size,
    javaMajor: details.javaVersion ? details.javaVersion.majorVersion : null
  };
}

/**
 * Download to a temporary file, verify it, then move it into place.
 * onProgress receives a whole-number percentage.
 */
async function downloadVerified({ url, sha1, size }, destination, onProgress = () => {}, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`The download failed with HTTP ${response.status}.`);

  const temporary = `${destination}.download`;
  const total = size || Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha1');
  const file = fs.createWriteStream(temporary);
  let received = 0;
  let lastPercent = -1;

  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!file.write(chunk)) await new Promise(resolve => file.once('drain', resolve));
      if (total) {
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    }
    await new Promise((resolve, reject) => file.end(error => (error ? reject(error) : resolve())));

    const actual = hash.digest('hex');
    if (sha1 && actual !== sha1) {
      throw new Error('The downloaded server did not match Mojang\'s checksum. Try again.');
    }
    await fsp.rename(temporary, destination);
  } catch (error) {
    file.destroy();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

module.exports = { VERSION_MANIFEST_URL, resolveServerDownload, downloadVerified };
