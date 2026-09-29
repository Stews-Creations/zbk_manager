/**
 * helpers.js - Builders for the small archives and worlds used by the tests.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/** Build an uncompressed ZIP from { name: contents }. */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(contents);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function nbtString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function nbtNamed(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), nbtString(name), payload]);
}

function nbtCompound(children) {
  return Buffer.concat([...children, Buffer.from([0])]);
}

/** Build a gzipped level.dat holding a world name and game version. */
function buildLevelDat(levelName, version) {
  const id = Buffer.alloc(4);
  id.writeInt32BE(4790);
  const data = nbtCompound([
    nbtNamed(11, 'Padding', Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2])),
    nbtNamed(10, 'Version', nbtCompound([
      nbtNamed(1, 'Snapshot', Buffer.from([0])),
      nbtNamed(3, 'Id', id),
      nbtNamed(8, 'Name', nbtString(version))
    ])),
    nbtNamed(8, 'LevelName', nbtString(levelName))
  ]);
  return zlib.gzipSync(nbtNamed(10, '', nbtCompound([nbtNamed(10, 'Data', data)])));
}

async function makeTempDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `zbk-server-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

async function writeFiles(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

const PACK_META = JSON.stringify({ pack: { description: 'test' } });

/** Create a world folder with the base pack and a bundled resource pack. */
async function makeWorld(root, { levelName = 'Test World', version = '26.2' } = {}) {
  await writeFiles(root, {
    'level.dat': buildLevelDat(levelName, version),
    'session.lock': 'locked',
    'datapacks/zombies_build_kit/pack.mcmeta': PACK_META,
    'datapacks/zombies_build_kit/data/zbk/function/load.mcfunction': 'say hi',
    'datapacks/zombies_build_kit/data/zbk/structure/perks/machine.nbt': 'nbt',
    'datapacks/zombies_build_kit/data/zbk/structure/doors/gate.nbt': 'nbt',
    'generated/minecraft/structure/room.nbt': 'nbt',
    'resourcepacks/resources.zip': buildZip({ 'pack.mcmeta': PACK_META, 'assets/zbk/sounds.json': '{}' })
  });
  return root;
}

module.exports = { buildZip, buildLevelDat, makeTempDir, writeFiles, makeWorld, PACK_META };
