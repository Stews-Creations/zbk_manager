const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');

const { inspectWorld } = require('../src/main/lib/world');
const { inspectResourcePack, packIdFromSha1, hostResourcePack } = require('../src/main/lib/resource-pack');
const { listZipEntries } = require('../src/main/lib/zip');
const { buildZip, makeTempDir, makeWorld, writeFiles, PACK_META } = require('./helpers');

test('lists ZIP entries from the central directory', async t => {
  const dir = await makeTempDir(t, 'zip');
  const zip = path.join(dir, 'pack.zip');
  await fs.writeFile(zip, buildZip({ 'pack.mcmeta': PACK_META, 'assets/zbk/a.json': '{}' }));

  assert.deepEqual(await listZipEntries(zip), ['pack.mcmeta', 'assets/zbk/a.json']);

  await fs.writeFile(zip, 'not a zip archive at all, only text');
  await assert.rejects(listZipEntries(zip), /not a ZIP archive/);
});

test('describes the packs, structures, and version a world contains', async t => {
  const world = await makeWorld(await makeTempDir(t, 'world'), { levelName: 'My Map', version: '26.2' });
  await writeFiles(world, {
    'datapacks/my_map.zip': buildZip({
      'pack.mcmeta': PACK_META,
      'data/my_map/function/a.mcfunction': '',
      'data/my_map/structure/spawn_room.nbt': 'nbt',
      'data/my_map/structures/legacy/vault.nbt': 'nbt',
      'data/my_map/loot_table/structure/not_a_template.nbt': 'nbt',
      'data/zbk/tags/function/event/round/round_start.json': '{}'
    }),
    'datapacks/broken/readme.txt': 'no metadata',
    'datapacks/broken/data/broken/structure/ignored.nbt': 'nbt'
  });

  const result = await inspectWorld(world);

  assert.equal(result.valid, true);
  assert.equal(result.levelName, 'My Map');
  assert.equal(result.minecraftVersion, '26.2');
  assert.equal(result.hasBasePack, true);
  assert.equal(result.bundledResourcePack, path.join(world, 'resourcepacks', 'resources.zip'));
  assert.deepEqual(
    result.datapacks.map(pack => [pack.name, pack.kind, pack.valid, pack.isBasePack, pack.structures]),
    [
      ['broken', 'folder', false, false, 0],
      ['my_map.zip', 'zip', true, false, 2],
      ['zombies_build_kit', 'folder', true, true, 2]
    ]
  );

  // Structures are counted wherever they live: in datapacks and in the world.
  assert.equal(result.datapackStructures, 4);
  assert.equal(result.savedStructures, 1);
  assert.equal(result.structures, 5);
});

test('reads datapacks through linked folders and reports broken links', async t => {
  const world = await makeWorld(await makeTempDir(t, 'world'));
  const source = await makeTempDir(t, 'linked');
  await writeFiles(source, { 'my_map/pack.mcmeta': PACK_META, 'gone/pack.mcmeta': PACK_META });
  await fs.symlink(path.join(source, 'my_map'), path.join(world, 'datapacks', 'my_map'), 'junction');
  await fs.symlink(path.join(source, 'gone'), path.join(world, 'datapacks', 'gone'), 'junction');
  await fs.rm(path.join(source, 'gone'), { recursive: true });

  const result = await inspectWorld(world);

  assert.deepEqual(
    result.datapacks.map(pack => [pack.name, pack.valid]),
    [['gone', false], ['my_map', true], ['zombies_build_kit', true]]
  );
  assert.match(result.datapacks[0].problem, /linked folder is missing/);
});

test('reports a world without the base pack or a bundled pack', async t => {
  const world = await makeTempDir(t, 'plain');
  await writeFiles(world, { 'level.dat': 'unreadable' });

  const result = await inspectWorld(world);

  assert.equal(result.valid, true);
  assert.equal(result.minecraftVersion, null);
  assert.equal(result.hasBasePack, false);
  assert.equal(result.savedStructures, 0);
  assert.equal(result.datapackStructures, 0);
  assert.equal(result.structures, 0);
  assert.equal(result.bundledResourcePack, null);
  assert.deepEqual(result.datapacks, []);
});

test('rejects a folder that is not a world', async t => {
  const dir = await makeTempDir(t, 'saves');
  const result = await inspectWorld(dir);
  assert.equal(result.valid, false);
  assert.match(result.error, /level\.dat/);
});

test('explains why a resource pack ZIP cannot be used', async t => {
  const dir = await makeTempDir(t, 'packs');
  await writeFiles(dir, {
    'good.zip': buildZip({ 'pack.mcmeta': PACK_META, 'assets/zbk/a.json': '{}' }),
    'nested.zip': buildZip({ 'my_pack/pack.mcmeta': PACK_META, 'my_pack/assets/zbk/a.json': '{}' }),
    'datapack.zip': buildZip({ 'pack.mcmeta': PACK_META, 'data/zbk/a.json': '{}' })
  });

  const good = await inspectResourcePack(path.join(dir, 'good.zip'));
  assert.equal(good.valid, true);
  assert.match(good.sha1, /^[0-9a-f]{40}$/);
  assert.match(packIdFromSha1(good.sha1), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const nested = await inspectResourcePack(path.join(dir, 'nested.zip'));
  assert.equal(nested.valid, false);
  assert.match(nested.error, /inside the "my_pack" folder/);

  const datapack = await inspectResourcePack(path.join(dir, 'datapack.zip'));
  assert.equal(datapack.valid, false);
  assert.match(datapack.error, /datapack/);
});

test('serves only the resource pack and moves to a free port', async t => {
  const dir = await makeTempDir(t, 'host');
  const zip = path.join(dir, 'pack.zip');
  const contents = buildZip({ 'pack.mcmeta': PACK_META, 'assets/zbk/a.json': '{}' });
  await fs.writeFile(zip, contents);

  const first = await hostResourcePack(zip, 0);
  t.after(() => first.close());
  const second = await hostResourcePack(zip, first.port);
  t.after(() => second.close());
  assert.notEqual(second.port, first.port);

  const pack = await fetch(`http://127.0.0.1:${first.port}/resource_pack.zip`);
  assert.equal(pack.status, 200);
  assert.deepEqual(Buffer.from(await pack.arrayBuffer()), contents);

  const other = await fetch(`http://127.0.0.1:${first.port}/pack.zip`);
  assert.equal(other.status, 404);
});
