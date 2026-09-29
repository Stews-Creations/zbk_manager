const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');

const { ServerSession, describeServerFolder } = require('../src/main/lib/session');
const { readProperty } = require('../src/main/lib/properties');
const { VERSION_MANIFEST_URL, downloadVerified } = require('../src/main/lib/jar');
const { hostResourcePack } = require('../src/main/lib/resource-pack');
const { makeTempDir, makeWorld, writeFiles } = require('./helpers');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-server.js');
const JAR = Buffer.from('stand-in server jar');
const JAR_SHA1 = crypto.createHash('sha1').update(JAR).digest('hex');

/** Answer Mojang requests locally and record what was asked for. */
function fakeMojang({ sha1 = JAR_SHA1 } = {}) {
  const requests = [];
  const json = body => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async url => {
    requests.push(url);
    if (url === VERSION_MANIFEST_URL) return json({ versions: [{ id: '26.2', url: 'https://meta.test/26.2.json' }] });
    if (url === 'https://meta.test/26.2.json') {
      return json({
        downloads: { server: { url: 'https://data.test/server.jar', sha1, size: JAR.length } },
        javaVersion: { majorVersion: 25 }
      });
    }
    if (url === 'https://data.test/server.jar') {
      return { ok: true, status: 200, headers: new Headers(), body: (async function* () { yield JAR; })() };
    }
    return { ok: false, status: 404 };
  };
  return { fetchImpl, requests };
}

/**
 * Create the session before any temporary folder so it is stopped first;
 * Windows cannot delete a folder a running server is using.
 */
function makeSession(t, overrides = {}) {
  const session = new ServerSession({
    javaCommand: process.execPath,
    launchArgs: [FAKE_SERVER],
    checkJavaImpl: async () => ({ installed: true, version: '25.0.1', major: 25 }),
    ...fakeMojang(),
    ...overrides
  });
  t.after(() => stopAndWait(session));
  return session;
}

async function makeOptions(t, overrides = {}) {
  const world = await makeWorld(await makeTempDir(t, 'world'));
  const serverDir = path.join(await makeTempDir(t, 'server'), 'ZBK Server');
  return {
    serverDir,
    worldPath: world,
    version: '26.2',
    eulaAccepted: true,
    replaceWorld: false,
    resourcePack: { mode: 'none' },
    settings: { port: 25570, maxPlayers: 6, memoryGb: 2 },
    ...overrides
  };
}

function waitForState(session, state) {
  if (session.state === state) return Promise.resolve();
  return new Promise(resolve => {
    const listener = status => {
      if (status.state !== state) return;
      session.removeListener('status', listener);
      resolve();
    };
    session.on('status', listener);
  });
}

function waitForPlayers(session, predicate) {
  if (predicate(session.snapshot())) return Promise.resolve();
  return new Promise(resolve => {
    const listener = () => {
      if (!predicate(session.snapshot())) return;
      session.removeListener('players', listener);
      resolve();
    };
    session.on('players', listener);
  });
}

async function stopAndWait(session) {
  if (session.state === 'stopped') return;
  session.stop({ force: true });
  await waitForState(session, 'stopped');
}

test('refuses to prepare anything until the EULA is accepted', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t, { eulaAccepted: false });

  await assert.rejects(session.run(options), /EULA/);

  assert.equal(session.state, 'stopped');
  await assert.rejects(fs.stat(options.serverDir));
});

test('prepares the folder, shares the pack, and tracks players and admins', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  options.resourcePack = {
    mode: 'host',
    zipPath: path.join(options.worldPath, 'resourcepacks', 'resources.zip'),
    hostAddress: '127.0.0.1',
    port: 0,
    required: true
  };
  const log = [];
  session.on('log', text => log.push(text));

  await session.run(options);
  await waitForState(session, 'running');
  await waitForPlayers(session, state => state.players.includes('Stew'));

  // The world is copied without its lock, and the original is untouched.
  const world = path.join(options.serverDir, 'world');
  assert.equal((await fs.stat(path.join(world, 'level.dat'))).isFile(), true);
  assert.equal((await fs.stat(path.join(world, 'datapacks', 'zombies_build_kit', 'pack.mcmeta'))).isFile(), true);
  await assert.rejects(fs.stat(path.join(world, 'session.lock')));
  assert.equal(await fs.readFile(path.join(options.worldPath, 'session.lock'), 'utf8'), 'locked');

  assert.deepEqual(await fs.readFile(path.join(options.serverDir, 'server.jar')), JAR);
  assert.equal(await fs.readFile(path.join(options.serverDir, 'eula.txt'), 'utf8'), 'eula=true\n');

  const properties = await fs.readFile(path.join(options.serverDir, 'server.properties'), 'utf8');
  const packUrl = readProperty(properties, 'resource-pack');
  assert.equal(readProperty(properties, 'level-name'), 'world');
  assert.equal(readProperty(properties, 'server-port'), '25570');
  assert.equal(readProperty(properties, 'max-players'), '6');
  assert.equal(readProperty(properties, 'require-resource-pack'), 'true');
  assert.match(packUrl, /^http:\/\/127\.0\.0\.1:\d+\/resource_pack\.zip$/);

  // Players download exactly the file whose hash was written.
  const served = Buffer.from(await (await fetch(packUrl)).arrayBuffer());
  assert.equal(crypto.createHash('sha1').update(served).digest('hex'), readProperty(properties, 'resource-pack-sha1'));

  // Chat that imitates the server must not grant admin.
  assert.deepEqual(session.snapshot().operators, []);

  assert.equal(session.setOperator('Stew', true), true);
  await waitForPlayers(session, state => state.operators.includes('Stew'));
  assert.equal(session.setOperator('Stew', false), true);
  await waitForPlayers(session, state => !state.operators.includes('Stew'));
  assert.equal(session.setOperator('Stew\nstop', true), false);

  session.stop();
  await waitForState(session, 'stopped');
  assert.deepEqual(session.snapshot().players, []);
  await assert.rejects(fetch(packUrl));
  assert.ok(log.join('').includes('Server stopped (exit code 0).'));

  const folder = await describeServerFolder(options.serverDir);
  assert.equal(folder.hasWorld, true);
  assert.equal(folder.worldSource, options.worldPath);
  assert.equal(folder.minecraftVersion, '26.2');
});

test('copies linked datapack folders into the server as real files', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  const source = await makeTempDir(t, 'linked');
  await writeFiles(source, {
    'my_map/pack.mcmeta': '{"pack":{"description":"linked"}}',
    'my_map/data/my_map/function/start.mcfunction': 'say linked'
  });
  await fs.symlink(path.join(source, 'my_map'), path.join(options.worldPath, 'datapacks', 'my_map'), 'junction');

  await session.run(options);

  const copied = path.join(options.serverDir, 'world', 'datapacks', 'my_map');
  assert.equal((await fs.lstat(copied)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(copied, 'data', 'my_map', 'function', 'start.mcfunction'), 'utf8'), 'say linked');

  // Plain folders in the same world are copied alongside the linked one.
  const plain = path.join(options.serverDir, 'world', 'datapacks', 'zombies_build_kit');
  assert.equal((await fs.lstat(plain)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(plain, 'pack.mcmeta'))).isFile(), true);
});

test('advertises a host name and its public port instead of this computer', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  options.resourcePack = {
    mode: 'host',
    zipPath: path.join(options.worldPath, 'resourcepacks', 'resources.zip'),
    hostAddress: 'packs.example.net:41234',
    port: 0,
    required: true
  };

  await session.run(options);

  const properties = await fs.readFile(path.join(options.serverDir, 'server.properties'), 'utf8');
  assert.equal(readProperty(properties, 'resource-pack'), 'http://packs.example.net:41234/resource_pack.zip');

  // The pack is still served locally for the tunnel to forward.
  assert.notEqual(session.packHost.port, 41234);
  const served = await fetch(`http://127.0.0.1:${session.packHost.port}/resource_pack.zip`);
  assert.equal(served.status, 200);
  await served.arrayBuffer();

  const invalid = makeSession(t);
  await assert.rejects(
    invalid.run({ ...options, resourcePack: { ...options.resourcePack, hostAddress: 'not an address' } }),
    /host name or IP address/
  );
});

test('keeps server progress unless a fresh copy is requested', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  const marker = path.join(options.serverDir, 'world', 'progress.txt');

  await session.run(options);
  await waitForState(session, 'running');
  await fs.writeFile(marker, 'played on the server');
  session.stop();
  await waitForState(session, 'stopped');

  await session.run(options);
  await waitForState(session, 'running');
  assert.equal(await fs.readFile(marker, 'utf8'), 'played on the server');
  session.stop();
  await waitForState(session, 'stopped');

  await session.run({ ...options, replaceWorld: true });
  await waitForState(session, 'running');
  await assert.rejects(fs.stat(marker));
});

test('keeps settings added to server.properties by hand', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  await writeFiles(options.serverDir, { 'server.properties': 'difficulty=hard\nresource-pack=https\\://old.test/pack.zip\n' });

  await session.run(options);

  const properties = await fs.readFile(path.join(options.serverDir, 'server.properties'), 'utf8');
  assert.equal(readProperty(properties, 'difficulty'), 'hard');
  assert.equal(readProperty(properties, 'resource-pack'), '');
  assert.equal(readProperty(properties, 'require-resource-pack'), 'false');
});

test('rejects a download that does not match the published checksum', async t => {
  const session = makeSession(t, fakeMojang({ sha1: '0'.repeat(40) }));
  const options = await makeOptions(t);

  await assert.rejects(session.run(options), /checksum/);

  assert.equal(session.state, 'stopped');
  await assert.rejects(fs.stat(path.join(options.serverDir, 'server.jar')));
  await assert.rejects(fs.stat(path.join(options.serverDir, 'server.jar.download')));
});

test('reports Java that is missing or too old', async t => {
  const options = await makeOptions(t);

  const missing = makeSession(t, { checkJavaImpl: async () => ({ installed: false, version: null, major: null }) });
  await assert.rejects(missing.run(options), /Java was not found\. Install Java 25/);

  const old = makeSession(t, { checkJavaImpl: async () => ({ installed: true, version: '21.0.1', major: 21 }) });
  await assert.rejects(old.run(options), /needs Java 25, but Java 21 is installed/);
});

test('refuses a server folder placed inside the world', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  options.serverDir = path.join(options.worldPath, 'server');

  await assert.rejects(session.run(options), /overlap/);
});

test('ends a server that ignores the stop command when forced', async t => {
  const session = makeSession(t);
  const options = await makeOptions(t);
  process.env.FAKE_SERVER_IGNORE_STOP = '1';
  t.after(() => { delete process.env.FAKE_SERVER_IGNORE_STOP; });

  await session.run(options);
  await waitForState(session, 'running');

  session.stop();
  assert.equal(session.state, 'stopping');
  session.stop();
  await once(session, 'status');
  assert.equal(session.state, 'stopped');
});

test('downloads over a real connection and verifies the file', async t => {
  const dir = await makeTempDir(t, 'download');
  const source = path.join(dir, 'source.bin');
  const contents = crypto.randomBytes(300000);
  await fs.writeFile(source, contents);
  const host = await hostResourcePack(source, 0);
  t.after(() => host.close());

  const url = `http://127.0.0.1:${host.port}/resource_pack.zip`;
  const sha1 = crypto.createHash('sha1').update(contents).digest('hex');
  const destination = path.join(dir, 'server.jar');
  const progress = [];

  await downloadVerified({ url, sha1, size: contents.length }, destination, percent => progress.push(percent));

  assert.deepEqual(await fs.readFile(destination), contents);
  assert.equal(progress.at(-1), 100);

  // A failed check leaves the verified file in place.
  await assert.rejects(downloadVerified({ url, sha1: '0'.repeat(40), size: contents.length }, destination), /checksum/);
  assert.deepEqual(await fs.readFile(destination), contents);
  await assert.rejects(fs.stat(`${destination}.download`));
});
