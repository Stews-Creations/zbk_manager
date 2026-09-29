/**
 * main.js - Application entry point.
 *
 * Owns the window, the saved configuration, and the single server session.
 * The interface runs sandboxed and reaches this process only through the
 * requests registered here.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const { createConfigStore } = require('./config');
const { inspectWorld } = require('./lib/world');
const { inspectResourcePack } = require('./lib/resource-pack');
const { ServerSession, describeServerFolder } = require('./lib/session');
const { getLanAddress, checkJava } = require('./lib/system');
const { parseAddress } = require('./lib/address');

const LINKS = Object.freeze({
  eula: 'https://aka.ms/MinecraftEULA',
  java: 'https://adoptium.net/temurin/releases/'
});
const QUIT_WAIT_MS = 12000;

let window = null;
let config = null;
const session = new ServerSession();

// -- Helpers --

function send(channel, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function defaultServerDir() {
  return path.join(app.getPath('documents'), 'ZBK Server');
}

function serverDir() {
  return config.load().serverDir || defaultServerDir();
}

function defaultSavesDir() {
  return path.join(app.getPath('appData'), '.minecraft', 'saves');
}

async function inspectSavedWorld(worldPath) {
  return worldPath ? inspectWorld(worldPath) : null;
}

/** The ZIP chosen on the Resource pack page, or null when there is none. */
function selectedPackPath(saved, world) {
  if (saved.pack.source === 'world') return world && world.valid ? world.bundledResourcePack : null;
  if (saved.pack.source === 'file') return saved.pack.filePath || null;
  return null;
}

/**
 * Where players fetch the pack from: its own address when one is set,
 * otherwise the address players join with, otherwise this computer.
 */
function packAddress(saved) {
  if (saved.pack.hostAddress.trim()) return saved.pack.hostAddress.trim();
  const shared = parseAddress(saved.settings.joinAddress);
  return shared ? shared.host : getLanAddress();
}

async function describeSelection() {
  const saved = config.load();
  const world = await inspectSavedWorld(saved.worldPath);
  const packPath = selectedPackPath(saved, world);
  return {
    config: saved,
    world,
    bundledPack: world && world.valid && world.bundledResourcePack
      ? await inspectResourcePack(world.bundledResourcePack)
      : null,
    pack: packPath ? await inspectResourcePack(packPath) : null,
    serverFolder: await describeServerFolder(serverDir())
  };
}

// -- Requests from the interface --

function registerRequests() {
  ipcMain.handle('app:startup', async () => ({
    ...(await describeSelection()),
    system: {
      lanAddress: getLanAddress(),
      java: await checkJava(),
      defaultServerDir: defaultServerDir()
    },
    session: session.snapshot()
  }));

  ipcMain.handle('app:selection', () => describeSelection());

  ipcMain.handle('config:save', async (_event, changes) => {
    config.save(changes && typeof changes === 'object' ? changes : {});
    return describeSelection();
  });

  ipcMain.handle('world:choose', async () => {
    const saved = config.load();
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the world folder',
      defaultPath: saved.worldPath ? path.dirname(saved.worldPath) : defaultSavesDir(),
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const world = await inspectWorld(result.filePaths[0]);
    if (!world.valid) return { canceled: false, error: world.error };

    // A chosen ZIP file stays selected; otherwise follow what this world includes.
    let source = saved.pack.source;
    if (source !== 'file') source = world.bundledResourcePack ? 'world' : 'none';
    config.save({ worldPath: world.path, pack: { source } });
    return { canceled: false, selection: await describeSelection() };
  });

  ipcMain.handle('pack:choose', async () => {
    const saved = config.load();
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the resource pack ZIP',
      defaultPath: saved.pack.filePath ? path.dirname(saved.pack.filePath) : app.getPath('downloads'),
      filters: [{ name: 'Resource pack', extensions: ['zip'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const pack = await inspectResourcePack(result.filePaths[0]);
    if (!pack.valid) return { canceled: false, error: pack.error };

    config.save({ pack: { source: 'file', filePath: pack.path } });
    return { canceled: false, selection: await describeSelection() };
  });

  ipcMain.handle('server-folder:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose where the server is kept',
      defaultPath: serverDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    config.save({ serverDir: result.filePaths[0] });
    return { canceled: false, selection: await describeSelection() };
  });

  ipcMain.handle('server-folder:open', async () => {
    const error = await shell.openPath(serverDir());
    return { ok: !error, error };
  });

  ipcMain.handle('link:open', (_event, name) => {
    if (Object.prototype.hasOwnProperty.call(LINKS, name)) shell.openExternal(LINKS[name]);
  });

  ipcMain.handle('server:start', async (_event, request) => {
    const { replaceWorld = false, eulaAccepted = false } = request || {};
    const saved = eulaAccepted && !config.load().eulaAcceptedAt
      ? config.save({ eulaAcceptedAt: new Date().toISOString() })
      : config.load();

    const world = await inspectSavedWorld(saved.worldPath);
    const folder = await describeServerFolder(serverDir());
    if ((!world || !world.valid) && !folder.hasWorld) {
      return { ok: false, error: 'Choose a world on the World page first.' };
    }

    if (replaceWorld && folder.hasWorld) {
      const answer = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Replace the server world?',
        message: 'Replace the server world with a fresh copy?',
        detail: 'Everything players built or unlocked on the server will be erased. Your original world is not affected.',
        buttons: ['Cancel', 'Replace world'],
        defaultId: 0,
        cancelId: 0
      });
      if (answer.response !== 1) return { ok: false, canceled: true };
    }

    const packPath = selectedPackPath(saved, world);
    const version = saved.settings.version.trim()
      || (world && world.valid && world.minecraftVersion)
      || folder.minecraftVersion;

    try {
      await session.run({
        serverDir: serverDir(),
        worldPath: world && world.valid ? world.path : '',
        replaceWorld,
        version,
        eulaAccepted: Boolean(saved.eulaAcceptedAt),
        resourcePack: packPath
          ? {
            mode: saved.pack.delivery === 'url' ? 'url' : 'host',
            zipPath: packPath,
            hostAddress: packAddress(saved),
            port: saved.pack.port,
            url: saved.pack.url.trim(),
            required: saved.pack.required
          }
          : { mode: 'none' },
        settings: saved.settings
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('server:stop', (_event, force) => session.stop({ force: Boolean(force) }));
  ipcMain.handle('server:command', (_event, command) => session.send(command));
  ipcMain.handle('server:operator', (_event, name, enabled) => session.setOperator(name, Boolean(enabled)));
}

function forwardSessionEvents() {
  session.on('status', status => send('server:status', status));
  session.on('log', text => send('server:log', text));
  session.on('players', players => send('server:players', players));
}

// -- Window --

function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 700,
    title: 'ZBK Server',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#0e1112',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The interface is a single local page; it never navigates or opens windows.
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { window = null; });

  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// -- Lifecycle --

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    config = createConfigStore(app.getPath('userData'));
    registerRequests();
    forwardSessionEvents();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  // Let the server save the world before the app exits.
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting || session.state === 'stopped') return;
    event.preventDefault();
    quitting = true;

    const finish = () => app.quit();
    const timer = setTimeout(() => {
      session.stop({ force: true });
      finish();
    }, QUIT_WAIT_MS);
    session.on('status', status => {
      if (status.state !== 'stopped') return;
      clearTimeout(timer);
      finish();
    });
    session.stop();
  });
}
