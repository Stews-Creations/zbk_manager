/**
 * properties.js - Update server.properties without discarding other settings.
 *
 * Only the named keys change. Comments, unknown keys, and their order are kept
 * so edits made by hand or by Minecraft itself survive.
 */

function escapeValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/^ /, '\\ ');
}

function lineKey(line) {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;
  const match = trimmed.match(/^((?:\\.|[^=:\s\\])+)\s*[=:]?/);
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

/** Return the text with each key in updates set, appending missing keys. */
function mergeProperties(text, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const merged = lines.map(line => {
    const key = lineKey(line);
    if (key === null || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${escapeValue(value)}`;
  });

  for (const [key, value] of pending) merged.push(`${key}=${escapeValue(value)}`);
  return merged.join('\n') + '\n';
}

/** Read the current value of one key, or null when it is not set. */
function readProperty(text, key) {
  for (const line of (text || '').split(/\r?\n/)) {
    if (lineKey(line) !== key) continue;
    const match = line.trimStart().match(/^(?:\\.|[^=:\s\\])+\s*[=:]?\s*(.*)$/);
    return match ? match[1].replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char)) : '';
  }
  return null;
}

module.exports = { mergeProperties, readProperty };
