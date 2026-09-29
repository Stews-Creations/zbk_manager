/**
 * session.js - Prepare a server folder and run the Minecraft server in it.
 *
 * The selected world is copied into the server folder, so the original save is
 * never changed by the server. A session owns one server process at a time and
 * reports everything through events:
 *
 *   status   { state, detail }        stopped | preparing | starting | running | stopping
 *   log      string                   console text, including this app's own notes
 *   players  { players, operators }   names currently online and known admins
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const { resolveServerDownload, downloadVerified } = require('./jar');
const { mergeProperties } = require('./properties');
const { inspectResourcePack, packIdFromSha1, hostResourcePack, sha1File, PACK_ROUTE } = require('./resource-pack');
const { isPlayerName, parseServerLine, createLineSplitter } = require('./log-events');
const { checkJava } = require('./system');
const { parseAddress } = require('./address');

const WORLD_FOLDER = 'world';
const JAR_FILE = 'server.jar';
const PACK_FILE = 'resource_pack.zip';
const DETAILS_FILE = 'zbk-server.json';
const SKIPPED_WORLD_FILES = new Set(['session.lock']);
const STOP_TIMEOUT_MS = 15000;

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function wholeNumber(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

/** Describe what a server folder already holds. */
async function describeServerFolder(serverDir) {
  const details = await readJson(path.join(serverDir, DETAILS_FILE), {});
  return {
    path: serverDir,
    hasWorld: await exists(path.join(serverDir, WORLD_FOLDER, 'level.dat')),
    hasJar: await exists(path.join(serverDir, JAR_FILE)),
    worldSource: details.worldSource || null,
    worldCopiedAt: details.worldCopiedAt || null,
    minecraftVersion: details.minecraftVersion || null
  };
}

class ServerSession extends EventEmitter {
  /**
   * The options exist so tests can substitute a stand-in server and avoid the
   * network.
   */
  constructor({ javaCommand = 'java', launchArgs = null, fetchImpl = fetch, checkJavaImpl = checkJava } = {}) {
    super();
    this.javaCommand = javaCommand;
    this.launchArgs = launchArgs;
    this.fetchImpl = fetchImpl;
    this.checkJavaImpl = checkJavaImpl;
    this.state = 'stopped';
    this.child = null;
    this.packHost = null;
    this.stopTimer = null;
    this.players = new Set();
    this.operators = new Set();
    this.startedAt = null;
  }

  // -- Reporting --

  setState(state, detail = '') {
    this.state = state;
    this.emit('status', { state, detail, startedAt: this.startedAt });
  }

  note(message) {
    this.emit('log', `[ZBK Server] ${message}\n`);
  }

  snapshot() {
    return {
      state: this.state,
      startedAt: this.startedAt,
      players: [...this.players].sort((a, b) => a.localeCompare(b)),
      operators: [...this.operators].sort((a, b) => a.localeCompare(b))
    };
  }

  emitPlayers() {
    const { players, operators } = this.snapshot();
    this.emit('players', { players, operators });
  }

  // -- Preparing --

  async copyWorld(worldPath, serverDir, replaceWorld) {
    const destination = path.join(serverDir, WORLD_FOLDER);
    const present = await exists(path.join(destination, 'level.dat'));
    if (present && !replaceWorld) {
      this.note('Keeping the world already in the server folder.');
      return;
    }

    if (!await exists(path.join(worldPath, 'level.dat'))) {
      throw new Error('The selected world no longer contains level.dat.');
    }
    if (isInside(worldPath, serverDir) || isInside(destination, worldPath)) {
      throw new Error('The server folder and the world folder overlap. Choose a server folder outside the world.');
    }

    this.note(present ? 'Replacing the server world with a fresh copy...' : 'Copying the world into the server folder...');
    await fsp.rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    // Linked datapack folders are copied as real files so the server owns them.
    await fsp.cp(worldPath, destination, {
      recursive: true,
      dereference: true,
      filter: source => !SKIPPED_WORLD_FILES.has(path.basename(source))
    });

    const detailsFile = path.join(serverDir, DETAILS_FILE);
    const details = await readJson(detailsFile, {});
    details.worldSource = worldPath;
    details.worldCopiedAt = new Date().toISOString();
    await fsp.writeFile(detailsFile, JSON.stringify(details, null, 2) + '\n');
    this.note('World copied.');
  }

  async ensureServerJar(version, serverDir) {
    const jar = path.join(serverDir, JAR_FILE);
    const detailsFile = path.join(serverDir, DETAILS_FILE);
    const details = await readJson(detailsFile, {});
    const present = await exists(jar);

    let download;
    try {
      download = await resolveServerDownload(version, this.fetchImpl);
    } catch (error) {
      if (present && details.minecraftVersion === version) {
        this.note(`Could not reach Mojang (${error.message}). Using the server already downloaded.`);
        return { javaMajor: details.javaMajor || null };
      }
      throw error;
    }

    if (present && await sha1File(jar) === download.sha1) {
      this.note(`Minecraft ${version} server is already downloaded.`);
    } else {
      this.note(`Downloading the Minecraft ${version} server from Mojang...`);
      await downloadVerified(download, jar, percent => {
        if (percent % 10 === 0) this.note(`Downloading... ${percent}%`);
      }, this.fetchImpl);
      this.note('Download verified.');
    }

    details.minecraftVersion = version;
    details.javaMajor = download.javaMajor;
    await fsp.writeFile(detailsFile, JSON.stringify(details, null, 2) + '\n');
    return { javaMajor: download.javaMajor };
  }

  async requireJava(javaMajor) {
    const java = await this.checkJavaImpl(this.javaCommand);
    if (!java.installed) {
      throw new Error(`Java was not found. Install Java${javaMajor ? ` ${javaMajor}` : ''} and restart this app.`);
    }
    if (javaMajor && java.major && java.major < javaMajor) {
      throw new Error(`This Minecraft version needs Java ${javaMajor}, but Java ${java.major} is installed.`);
    }
  }

  async prepareResourcePack(resourcePack, serverDir) {
    const mode = resourcePack && resourcePack.mode;
    if (!mode || mode === 'none') {
      this.note('No server resource pack. Players will see default textures and hear default sounds.');
      return { url: '', sha1: '' };
    }

    let sha1 = '';
    let hosted = null;
    if (resourcePack.zipPath) {
      const inspected = await inspectResourcePack(resourcePack.zipPath);
      if (!inspected.valid) throw new Error(`Resource pack: ${inspected.error}`);
      sha1 = inspected.sha1;

      if (mode === 'host') {
        hosted = path.join(serverDir, PACK_FILE);
        if (path.resolve(hosted) !== path.resolve(resourcePack.zipPath)) {
          await fsp.copyFile(resourcePack.zipPath, hosted);
        }
      }
    }

    if (mode === 'url') {
      let url;
      try {
        url = new URL(resourcePack.url);
      } catch {
        throw new Error('The resource pack address is not a valid web address.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The resource pack address must start with http:// or https://.');
      }
      if (!sha1) this.note('No local copy of the pack was chosen, so players cannot verify the download.');
      return { url: url.href, sha1 };
    }

    if (!hosted) throw new Error('Choose a resource pack ZIP to share from this computer.');
    const address = parseAddress(resourcePack.hostAddress);
    if (!address) {
      throw new Error('The address for the pack download must be a host name or IP address, with an optional port.');
    }

    // A tunnel can publish the download on a different port than the local one.
    this.packHost = await hostResourcePack(hosted, wholeNumber(resourcePack.port, 8123, 0, 65535));
    const url = `http://${address.host}:${address.port || this.packHost.port}${PACK_ROUTE}`;
    this.note(`Sharing the resource pack at ${url}`);
    return { url, sha1 };
  }

  async writeProperties(serverDir, settings, pack, required) {
    const file = path.join(serverDir, 'server.properties');
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      // A new file is created below.
    }

    const updates = {
      'level-name': WORLD_FOLDER,
      'server-port': wholeNumber(settings.port, 25565, 1, 65535),
      'max-players': wholeNumber(settings.maxPlayers, 8, 1, 1000),
      'resource-pack': pack.url,
      'resource-pack-sha1': pack.sha1,
      'resource-pack-id': pack.sha1 ? packIdFromSha1(pack.sha1) : '',
      'require-resource-pack': Boolean(pack.url && required)
    };
    if (typeof settings.motd === 'string' && settings.motd.trim()) updates.motd = settings.motd.trim();

    await fsp.writeFile(file, mergeProperties(text, updates));
  }

  async prepare(options) {
    const { serverDir, worldPath, version } = options;
    if (!options.eulaAccepted) throw new Error('Accept the Minecraft EULA before starting the server.');
    if (!serverDir) throw new Error('Choose a server folder.');
    if (!version) throw new Error('The Minecraft version is unknown. Enter it in Settings.');

    await fsp.mkdir(serverDir, { recursive: true });
    await this.copyWorld(worldPath, serverDir, Boolean(options.replaceWorld));
    const { javaMajor } = await this.ensureServerJar(version, serverDir);
    await this.requireJava(javaMajor);

    const pack = await this.prepareResourcePack(options.resourcePack, serverDir);
    const required = !options.resourcePack || options.resourcePack.required !== false;
    await this.writeProperties(serverDir, options.settings || {}, pack, required);
    await fsp.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    const operators = await readJson(path.join(serverDir, 'ops.json'), []);
    this.operators = new Set(operators.map(entry => entry && entry.name).filter(isPlayerName));
  }

  // -- Running --

  /** Prepare the folder, then start the server. Rejects with a readable error. */
  async run(options) {
    if (this.state !== 'stopped') throw new Error('The server is already running.');
    this.players.clear();
    this.startedAt = null;
    this.setState('preparing');

    try {
      await this.prepare(options);
      this.launch(options);
    } catch (error) {
      await this.closePackHost();
      this.note(`Could not start: ${error.message}`);
      this.setState('stopped', error.message);
      throw error;
    }
  }

  launch(options) {
    const memory = wholeNumber(options.settings && options.settings.memoryGb, 4, 1, 64);
    const args = this.launchArgs || ['-Xms1G', `-Xmx${memory}G`, '-jar', JAR_FILE, 'nogui'];

    const child = spawn(this.javaCommand, args, { cwd: options.serverDir, windowsHide: true });
    this.child = child;
    this.startedAt = Date.now();
    this.setState('starting');
    this.emitPlayers();

    const onLine = createLineSplitter(line => this.handleLine(line));
    const onData = data => {
      const text = data.toString();
      this.emit('log', text);
      onLine(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', error => {
      this.note(`The server could not be started: ${error.message}`);
      this.finish(child, null);
    });
    child.on('close', code => this.finish(child, code));
  }

  handleLine(line) {
    const event = parseServerLine(line);
    if (!event) return;

    switch (event.type) {
      case 'ready':
        if (this.state === 'starting') {
          this.setState('running');
          this.note('The server is ready. Players can join now.');
        }
        break;
      case 'join':
        this.players.add(event.name);
        this.emitPlayers();
        break;
      case 'leave':
        this.players.delete(event.name);
        this.emitPlayers();
        break;
      case 'op':
        this.operators.add(event.name);
        this.emitPlayers();
        break;
      case 'deop':
        this.operators.delete(event.name);
        this.emitPlayers();
        break;
      case 'hint':
        this.note(event.hint);
        break;
      default:
        break;
    }
  }

  async closePackHost() {
    const host = this.packHost;
    this.packHost = null;
    if (host) await host.close();
  }

  finish(child, code) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.players.clear();
    this.startedAt = null;
    this.closePackHost().catch(() => {});
    if (code !== null) this.note(`Server stopped (exit code ${code}).`);
    this.emitPlayers();
    this.setState('stopped');
  }

  /** Ask the server to save and stop. force ends it immediately. */
  stop({ force = false } = {}) {
    const child = this.child;
    if (!child) return false;

    if (force || this.state === 'stopping') {
      this.note('Ending the server now.');
      child.kill();
      return true;
    }

    this.setState('stopping');
    this.write('stop');
    this.stopTimer = setTimeout(() => {
      if (this.child === child) {
        this.note('The server did not stop in time, so it was ended.');
        child.kill();
      }
    }, STOP_TIMEOUT_MS);
    return true;
  }

  write(command) {
    const child = this.child;
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(`${command}\n`);
    return true;
  }

  /** Send one console command. Line breaks are removed so it stays one command. */
  send(command) {
    const text = String(command || '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
    if (!text) return false;
    this.emit('log', `> ${text}\n`);
    return this.write(text);
  }

  /** Give or remove admin rights for a player. */
  setOperator(name, enabled) {
    if (!isPlayerName(name)) return false;
    return this.send(`${enabled ? 'op' : 'deop'} ${name}`);
  }
}

module.exports = { ServerSession, describeServerFolder, isInside };
