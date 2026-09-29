/**
 * address.js - Read an address a player would type, such as a host name,
 * an IP address, or either one followed by a port.
 *
 * A host name or tunnel address lets a host share something other than their
 * own IP address.
 */

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * Return { host, port } for "host" or "host:port". port is null when absent.
 * Returns null when the text is not a usable address.
 */
function parseAddress(text) {
  const value = String(text || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  if (!value) return null;

  const parts = value.split(':');
  if (parts.length > 2 || !HOST.test(parts[0])) return null;
  if (parts.length === 1) return { host: parts[0], port: null };

  if (!/^\d{1,5}$/.test(parts[1])) return null;
  const port = Number(parts[1]);
  return port >= 1 && port <= 65535 ? { host: parts[0], port } : null;
}

module.exports = { parseAddress };
