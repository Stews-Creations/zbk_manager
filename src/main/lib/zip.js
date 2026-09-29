/**
 * zip.js - List the entry names of a ZIP archive without extracting it.
 *
 * Reads only the central directory, so large packs are inspected quickly.
 */

const fs = require('fs/promises');

const END_SIGNATURE = 0x06054b50;
const ENTRY_SIGNATURE = 0x02014b50;
const END_LENGTH = 22;
const ENTRY_LENGTH = 46;
const MAX_COMMENT_LENGTH = 0xffff;

/** Return every entry name in the archive, using forward slashes. */
async function listZipEntries(zipPath) {
  const handle = await fs.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < END_LENGTH) throw new Error('This file is not a ZIP archive.');

    const tailLength = Math.min(size, END_LENGTH + MAX_COMMENT_LENGTH);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let end = -1;
    for (let i = tailLength - END_LENGTH; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_SIGNATURE) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error('This file is not a ZIP archive.');

    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported.');
    }
    if (directoryOffset + directorySize > size) throw new Error('The ZIP archive is damaged.');

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const names = [];
    let position = 0;
    for (let i = 0; i < count; i++) {
      if (position + ENTRY_LENGTH > directory.length || directory.readUInt32LE(position) !== ENTRY_SIGNATURE) {
        throw new Error('The ZIP archive is damaged.');
      }
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const nameStart = position + ENTRY_LENGTH;
      names.push(directory.toString('utf8', nameStart, nameStart + nameLength).replace(/\\/g, '/'));
      position = nameStart + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

module.exports = { listZipEntries };
