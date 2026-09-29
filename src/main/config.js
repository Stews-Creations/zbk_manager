/**
 * config.js - Remember the user's choices between launches.
 *
 * Stored as JSON in the app's user data folder. Unknown or damaged files fall
 * back to the defaults.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  worldPath: '',
  serverDir: '',
  eulaAcceptedAt: '',
  pack: Object.freeze({
    source: 'world',
    filePath: '',
    delivery: 'host',
    hostAddress: '',
    port: 8123,
    url: '',
    required: true
  }),
  settings: Object.freeze({
    memoryGb: 4,
    port: 25565,
    maxPlayers: 8,
    motd: '',
    version: '',
    joinAddress: ''
  })
});

function withDefaults(stored) {
  const value = stored && typeof stored === 'object' ? stored : {};
  return {
    ...DEFAULTS,
    ...value,
    pack: { ...DEFAULTS.pack, ...(value.pack || {}) },
    settings: { ...DEFAULTS.settings, ...(value.settings || {}) }
  };
}

function createConfigStore(directory) {
  const file = path.join(directory, 'config.json');

  function load() {
    try {
      return withDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return withDefaults(null);
    }
  }

  /** Merge changes into the stored config and return the result. */
  function save(changes) {
    const current = load();
    const next = withDefaults({
      ...current,
      ...changes,
      pack: { ...current.pack, ...(changes.pack || {}) },
      settings: { ...current.settings, ...(changes.settings || {}) }
    });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  return { load, save };
}

module.exports = { createConfigStore, DEFAULTS };
