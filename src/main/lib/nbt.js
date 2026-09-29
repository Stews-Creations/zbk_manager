/**
 * nbt.js - Minimal reader for Minecraft Java NBT data.
 *
 * Used to read the world name and game version from level.dat. Numeric arrays
 * are skipped because nothing here needs them.
 */

const zlib = require('zlib');

const MAX_DEPTH = 64;

/** Parse an uncompressed NBT buffer into plain objects. */
function parseNbt(buffer) {
  let position = 0;

  function need(length) {
    if (length < 0 || position + length > buffer.length) throw new Error('NBT data ended unexpectedly.');
  }

  function readString() {
    need(2);
    const length = buffer.readUInt16BE(position);
    position += 2;
    need(length);
    const value = buffer.toString('utf8', position, position + length);
    position += length;
    return value;
  }

  function readLength() {
    need(4);
    const length = buffer.readInt32BE(position);
    position += 4;
    if (length < 0) throw new Error('NBT data contains an invalid length.');
    return length;
  }

  function skipArray(width) {
    const bytes = readLength() * width;
    need(bytes);
    position += bytes;
    return null;
  }

  function readPayload(type, depth) {
    if (depth > MAX_DEPTH) throw new Error('NBT data is nested too deeply.');
    switch (type) {
      case 1: need(1); position += 1; return buffer.readInt8(position - 1);
      case 2: need(2); position += 2; return buffer.readInt16BE(position - 2);
      case 3: need(4); position += 4; return buffer.readInt32BE(position - 4);
      case 4: need(8); position += 8; return buffer.readBigInt64BE(position - 8);
      case 5: need(4); position += 4; return buffer.readFloatBE(position - 4);
      case 6: need(8); position += 8; return buffer.readDoubleBE(position - 8);
      case 7: return skipArray(1);
      case 8: return readString();
      case 9: {
        need(1);
        const itemType = buffer.readUInt8(position);
        position += 1;
        const length = readLength();
        const items = [];
        for (let i = 0; i < length; i++) items.push(readPayload(itemType, depth + 1));
        return items;
      }
      case 10: {
        const value = {};
        for (;;) {
          need(1);
          const childType = buffer.readUInt8(position);
          position += 1;
          if (childType === 0) return value;
          const name = readString();
          value[name] = readPayload(childType, depth + 1);
        }
      }
      case 11: return skipArray(4);
      case 12: return skipArray(8);
      default: throw new Error(`NBT data contains an unknown tag type ${type}.`);
    }
  }

  need(1);
  const rootType = buffer.readUInt8(position);
  position += 1;
  if (rootType !== 10) throw new Error('NBT data does not start with a compound tag.');
  readString();
  return readPayload(10, 0);
}

/** Read the display name and game version recorded in a level.dat buffer. */
function readLevelSummary(levelDat) {
  const root = parseNbt(zlib.gunzipSync(levelDat));
  const data = root.Data || {};
  const version = data.Version || {};
  return {
    levelName: typeof data.LevelName === 'string' ? data.LevelName : null,
    minecraftVersion: typeof version.Name === 'string' ? version.Name : null,
    isSnapshot: version.Snapshot === 1
  };
}

module.exports = { parseNbt, readLevelSummary };
