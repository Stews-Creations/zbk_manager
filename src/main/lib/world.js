/**
 * world.js - Inspect a Minecraft world folder before it is used on a server.
 *
 * Reports what the world already contains: datapacks, structures carried by
 * those datapacks or saved in the world, and a bundled resource pack. Nothing
 * is modified.
 */

const fs = require('fs/promises');
const path = require('path');

const { listZipEntries } = require('./zip');
const { readLevelSummary } = require('./nbt');

// Map add-ons also use the zbk namespace for event tags, so the base pack is
// identified by its load function.
const BASE_PACK_MARKER = 'data/zbk/function/load.mcfunction';

// Singleplayer loads a world pack from one of these locations.
const BUNDLED_PACK_LOCATIONS = [
  path.join('resourcepacks', 'resources.zip'),
  'resources.zip'
];

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// Structure templates live in a namespace's structure folder. Older packs and
// worlds used the plural name.
const STRUCTURE_FOLDERS = ['structure', 'structures'];
const PACKED_STRUCTURE = /^data\/[^/]+\/structures?\/.+\.nbt$/i;

function unusable(name, kind, problem) {
  return { name, kind, valid: false, isBasePack: false, structures: 0, problem };
}

async function inspectDatapackFolder(folder, name) {
  if (!await exists(path.join(folder, 'pack.mcmeta'))) return unusable(name, 'folder', 'pack.mcmeta is missing');
  return {
    name,
    kind: 'folder',
    valid: true,
    isBasePack: await exists(path.join(folder, BASE_PACK_MARKER)),
    structures: await countStructures(path.join(folder, 'data'))
  };
}

async function inspectDatapackZip(zipPath, name) {
  try {
    const entries = await listZipEntries(zipPath);
    if (!entries.includes('pack.mcmeta')) return unusable(name, 'zip', 'pack.mcmeta is not at the top of the ZIP');
    return {
      name,
      kind: 'zip',
      valid: true,
      isBasePack: entries.includes(BASE_PACK_MARKER),
      structures: entries.filter(entry => PACKED_STRUCTURE.test(entry)).length
    };
  } catch (error) {
    return unusable(name, 'zip', error.message);
  }
}

/** List the datapacks installed in the world, following linked folders. */
async function listDatapacks(worldPath) {
  const root = path.join(worldPath, 'datapacks');
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }

  const packs = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const target = path.join(root, name);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      packs.push(unusable(name, 'folder', 'the linked folder is missing'));
      continue;
    }
    if (stat.isDirectory()) packs.push(await inspectDatapackFolder(target, name));
    else if (name.toLowerCase().endsWith('.zip')) packs.push(await inspectDatapackZip(target, name));
  }
  return packs;
}

async function countFiles(folder, extension) {
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) count += await countFiles(target, extension);
    else if (entry.name.toLowerCase().endsWith(extension)) count += 1;
  }
  return count;
}

/**
 * Count structure templates under a folder of namespaces. This is a datapack's
 * data folder, or the generated folder where a world keeps structures saved
 * in game.
 */
async function countStructures(root) {
  let namespaces;
  try {
    namespaces = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) continue;
    for (const folder of STRUCTURE_FOLDERS) {
      count += await countFiles(path.join(root, namespace.name, folder), '.nbt');
    }
  }
  return count;
}

async function findBundledResourcePack(worldPath) {
  for (const location of BUNDLED_PACK_LOCATIONS) {
    const target = path.join(worldPath, location);
    try {
      if ((await fs.stat(target)).isFile()) return target;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** Describe a world folder. Returns { valid: false, error } when unusable. */
async function inspectWorld(worldPath) {
  if (!worldPath || !await exists(worldPath)) {
    return { valid: false, error: 'That folder no longer exists.' };
  }

  const levelPath = path.join(worldPath, 'level.dat');
  if (!await exists(levelPath)) {
    return {
      valid: false,
      error: 'No level.dat was found. Choose the world folder itself, the one that contains level.dat.'
    };
  }

  let summary = { levelName: null, minecraftVersion: null, isSnapshot: false };
  try {
    summary = readLevelSummary(await fs.readFile(levelPath));
  } catch {
    // The version can still be entered by hand.
  }

  const datapacks = await listDatapacks(worldPath);
  const datapackStructures = datapacks.reduce((total, pack) => total + pack.structures, 0);
  const savedStructures = await countStructures(path.join(worldPath, 'generated'));
  return {
    valid: true,
    path: worldPath,
    folderName: path.basename(worldPath),
    levelName: summary.levelName,
    minecraftVersion: summary.minecraftVersion,
    isSnapshot: summary.isSnapshot,
    datapacks,
    hasBasePack: datapacks.some(pack => pack.valid && pack.isBasePack),
    datapackStructures,
    savedStructures,
    structures: datapackStructures + savedStructures,
    bundledResourcePack: await findBundledResourcePack(worldPath)
  };
}

module.exports = { inspectWorld, listDatapacks, countStructures, findBundledResourcePack };
