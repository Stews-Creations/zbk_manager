/**
 * app.js - Interface logic for the single ZBK Server page.
 *
 * The main process owns files and the server. This script shows what it
 * reports and sends the user's choices back through window.zbk.
 */

(function () {
  'use strict';

  const api = window.zbk;
  const SVG = 'http://www.w3.org/2000/svg';
  const MAX_CONSOLE_LINES = 3000;
  const DEFAULT_PORT = 25565;

  const STATUS_TEXT = {
    stopped: 'Stopped',
    preparing: 'Getting ready',
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping'
  };

  const NOTE_ICONS = { good: 'check', info: 'info', warn: 'alert', bad: 'alert' };

  const state = {
    selection: null,
    system: null,
    session: { state: 'stopped', startedAt: null, players: [], operators: [] }
  };

  let openLine = null;

  const $ = id => document.getElementById(id);

  // -- Small helpers --

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatUptime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const part = value => String(value).padStart(2, '0');
    return `${part(Math.floor(seconds / 3600))}:${part(Math.floor((seconds % 3600) / 60))}:${part(seconds % 60)}`;
  }

  function showMessage(id, text) {
    const node = $(id);
    node.textContent = text || '';
    node.hidden = !text;
  }

  /** Set a field's value unless the user is typing in it. */
  function setValue(id, value) {
    const input = $(id);
    if (document.activeElement !== input) input.value = value;
  }

  function chip(kind, text) {
    const item = element('li');
    item.dataset.kind = kind;
    if (kind === 'good') item.append(icon('check'));
    if (kind === 'warn') item.append(icon('alert'));
    item.append(element('span', '', text));
    return item;
  }

  /** Structures can come from datapacks or be saved in the world itself. */
  function structureChip(selected) {
    const item = chip('plain', plural(selected.structures, 'structure'));
    item.title = `${selected.datapackStructures} in datapacks, ${selected.savedStructures} saved in the world`;
    return item;
  }

  function note(kind, title, detail, action) {
    const item = element('li');
    item.dataset.kind = kind;
    item.append(icon(NOTE_ICONS[kind]));
    const body = element('span');
    body.append(element('span', 'note-title', title));
    if (detail) body.append(element('span', '', `${detail} `));
    if (action) {
      const button = element('button', 'link', action.label);
      button.type = 'button';
      button.addEventListener('click', action.run);
      body.append(button);
    }
    item.append(body);
    return item;
  }

  function setCardState(name, kind, label) {
    $(`card-${name}`).dataset.state = kind;
    $(`state-${name}`).textContent = label;
  }

  // -- Derived facts --

  const world = () => (state.selection && state.selection.world && state.selection.world.valid ? state.selection.world : null);
  const config = () => state.selection.config;
  const isStopped = () => state.session.state === 'stopped';
  const isLive = () => state.session.state === 'starting' || state.session.state === 'running';

  function worldTitle(value) {
    return value.levelName || value.folderName;
  }

  /** What the resource pack choices currently add up to. */
  function packSummary() {
    const { pack, bundledPack } = state.selection;
    const source = config().pack.source;
    if (source === 'none') return { kind: 'none' };
    if (source === 'world' && !world()) return { kind: 'missing', error: 'Choose a world first, or switch to a ZIP file.' };
    if (source === 'world' && !bundledPack) return { kind: 'missing', error: 'This world does not have a resource pack inside it. Switch to a ZIP file.' };
    if (!pack) return { kind: 'missing', error: 'Choose a resource pack ZIP.' };
    if (!pack.valid) return { kind: 'invalid', error: pack.error };
    if (config().pack.delivery === 'url' && !/^https?:\/\/\S+$/i.test(config().pack.url.trim())) {
      return { kind: 'invalid', error: 'Enter the download link for the resource pack.', open: true };
    }
    if (config().pack.delivery !== 'url' && config().pack.hostAddress.trim() && !parseAddress(config().pack.hostAddress)) {
      return { kind: 'invalid', error: 'The address for the pack download must be a host name or IP address, with an optional port.', open: true };
    }
    return { kind: 'ready', pack };
  }

  /** Split "host" or "host:port"; null when it is not a usable address. */
  function parseAddress(text) {
    const value = String(text || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
    const match = value.match(/^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/);
    if (!match) return null;
    const port = match[2] ? Number(match[2]) : null;
    return port === null || (port >= 1 && port <= 65535) ? { host: match[1], port } : null;
  }

  function packLink() {
    const saved = config().pack;
    if (saved.delivery === 'url') return saved.url.trim();
    const chosen = parseAddress(saved.hostAddress);
    const shared = parseAddress(config().settings.joinAddress);
    const host = (chosen && chosen.host) || (shared && shared.host) || state.system.lanAddress;
    return `http://${host}:${(chosen && chosen.port) || saved.port}/resource_pack.zip`;
  }

  function joinAddress() {
    const port = Number(config().settings.port) || DEFAULT_PORT;
    const shared = parseAddress(config().settings.joinAddress);
    if (shared && shared.port) return `${shared.host}:${shared.port}`;
    const host = shared ? shared.host : state.system.lanAddress;
    return port === DEFAULT_PORT ? host : `${host}:${port}`;
  }

  /** The first thing standing between the user and a running server. */
  function blocker() {
    if (!world() && !state.selection.serverFolder.hasWorld) {
      return { text: 'Choose a world to get started.', card: 'world', focus: 'choose-world' };
    }
    const pack = packSummary();
    if (pack.kind !== 'ready' && pack.kind !== 'none') return { text: pack.error, card: 'pack', focus: 'source-file' };
    if (!state.system.java.installed) return { text: 'Install Java to run the server.', card: 'server', focus: '' };
    if (config().settings.joinAddress.trim() && !parseAddress(config().settings.joinAddress)) {
      return { text: 'The address players join with is not a valid host name or IP address.', card: 'server', focus: 'setting-address' };
    }
    if (!config().eulaAcceptedAt) return { text: 'Agree to the Minecraft EULA to start.', card: 'server', focus: 'eula' };
    return null;
  }

  /** Draw the eye to the section that still needs something. */
  function pointAt({ card, focus }) {
    const section = $(`card-${card}`);
    section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    section.classList.remove('flash');
    void section.offsetWidth;
    section.classList.add('flash');
    if (focus) $(focus).focus({ preventScroll: true });
  }

  // -- World --

  function renderWorld() {
    const selected = world();
    const stored = state.selection.world;
    const locked = !isStopped();

    $('world-empty').hidden = Boolean(selected);
    $('world-card').hidden = !selected;
    $('choose-world').disabled = locked;
    $('change-world').disabled = locked;

    if (!selected) {
      setCardState('world', 'todo', 'Needed');
      if (stored && !stored.valid) showMessage('world-error', `The world chosen last time cannot be used. ${stored.error}`);
      return;
    }

    $('world-name').textContent = worldTitle(selected);
    $('world-path').textContent = selected.path;
    $('world-path').title = selected.path;

    const broken = selected.datapacks.filter(pack => !pack.valid);
    const chips = $('world-chips');
    chips.replaceChildren(
      chip(selected.minecraftVersion ? 'accent' : 'warn', selected.minecraftVersion ? `Minecraft ${selected.minecraftVersion}` : 'Version unknown'),
      chip(selected.hasBasePack ? 'good' : 'warn', selected.hasBasePack ? 'ZBK base pack' : 'No ZBK base pack'),
      chip('plain', plural(selected.datapacks.length, 'datapack')),
      structureChip(selected),
      chip(selected.bundledResourcePack ? 'good' : 'plain', selected.bundledResourcePack ? 'Resource pack inside' : 'No resource pack inside')
    );

    const notes = $('world-notes');
    notes.replaceChildren();
    if (!selected.hasBasePack) {
      notes.append(note('warn', 'ZBK base pack not found', 'ZBK gameplay will not run. Add the zombies_build_kit datapack to the world\'s datapacks folder, then choose the world again.'));
    }
    if (broken.length) {
      notes.append(note('warn', `${plural(broken.length, 'datapack')} will not load`, 'Open the list below to see why.'));
    }
    if (!selected.minecraftVersion) {
      notes.append(note('warn', 'The Minecraft version could not be read', 'Enter it under More settings in the Server section.'));
    }

    const list = $('world-datapacks');
    list.replaceChildren();
    if (!selected.datapacks.length) list.append(element('li', 'empty-row', 'This world has no datapacks.'));
    for (const pack of selected.datapacks) {
      const item = element('li');
      item.dataset.valid = String(pack.valid);
      item.append(element('span', 'pack-name', pack.name));
      if (pack.valid && pack.structures) item.append(element('span', 'pack-count', plural(pack.structures, 'structure')));
      const detail = pack.valid ? (pack.isBasePack ? 'ZBK base pack' : '') : `Will not load: ${pack.problem}`;
      if (detail) item.append(element('span', 'pack-note', detail));
      list.append(item);
    }

    if (selected.hasBasePack && !broken.length) setCardState('world', 'done', 'Ready');
    else setCardState('world', 'warn', 'Check');
  }

  // -- Resource pack --

  function renderPack() {
    const { pack, bundledPack } = state.selection;
    const saved = config().pack;
    const locked = !isStopped();
    const usableBundle = Boolean(bundledPack && bundledPack.valid);

    $('source-world').disabled = locked || !usableBundle;
    $('source-file').disabled = locked;
    $('source-none').disabled = locked;
    for (const radio of document.querySelectorAll('input[name="pack-source"]')) radio.checked = radio.value === saved.source;

    $('choice-world').hidden = saved.source !== 'world';
    $('choice-file').hidden = saved.source !== 'file';
    $('choice-none').hidden = saved.source !== 'none';

    $('option-world-detail').textContent = !world()
      ? 'No world chosen yet'
      : !bundledPack
        ? 'This world has no pack inside it'
        : usableBundle
          ? `resources.zip from the world, ${formatSize(bundledPack.size)}`
          : 'The pack inside the world cannot be used';
    $('bundled-notice').hidden = !usableBundle;

    const filePack = saved.source === 'file' ? pack : null;
    $('option-file-detail').textContent = !saved.filePath
      ? 'No file chosen'
      : filePack && filePack.valid
        ? `${filePack.name}, ${formatSize(filePack.size)}`
        : saved.filePath;
    $('choose-pack-label').textContent = saved.filePath ? 'Choose a different ZIP' : 'Choose ZIP file';
    $('choose-pack').disabled = locked;
    $('bundled-hint').hidden = !usableBundle;
    if (usableBundle) {
      $('bundled-hint').textContent = `This world also has a pack inside it (${formatSize(bundledPack.size)}). Pick "From the world" to send that one instead.`;
    }

    const summary = packSummary();
    if (summary.kind === 'invalid' && summary.open) $('delivery').open = true;
    const bundleProblem = saved.source === 'world' && bundledPack && !bundledPack.valid ? bundledPack.error : '';
    showMessage('pack-error', bundleProblem || (world() || saved.source !== 'world' ? summary.error : '') || '');

    $('delivery').hidden = summary.kind === 'none' || (summary.kind === 'missing' && saved.delivery !== 'url');

    for (const radio of document.querySelectorAll('input[name="pack-delivery"]')) {
      radio.checked = radio.value === saved.delivery;
      radio.disabled = locked;
    }
    $('choice-host').hidden = saved.delivery !== 'host';
    $('choice-url').hidden = saved.delivery !== 'url';
    const shared = parseAddress(config().settings.joinAddress);
    $('pack-host').placeholder = shared ? `${shared.host} (same as players join with)` : `${state.system.lanAddress} (this computer)`;
    setValue('pack-host', saved.hostAddress);
    setValue('pack-port', saved.port);
    setValue('pack-url', saved.url);
    $('pack-required').checked = saved.required;
    for (const id of ['pack-host', 'pack-port', 'pack-url', 'pack-required']) $(id).disabled = locked;

    const link = $('pack-link');
    link.hidden = summary.kind !== 'ready';
    if (summary.kind === 'ready') {
      link.replaceChildren('Players download the pack from', element('code', '', packLink()));
    }

    if (summary.kind === 'ready') setCardState('pack', 'done', 'Ready');
    else if (summary.kind === 'none') setCardState('pack', 'warn', 'No pack');
    else setCardState('pack', 'todo', 'Needed');
  }

  // -- Server --

  function renderServer() {
    const saved = config();
    const selected = world();
    const folder = state.selection.serverFolder;
    const java = state.system.java;
    const stopped = isStopped();

    const notes = $('server-notes');
    notes.replaceChildren();
    notes.append(java.installed
      ? note('good', `Java ${java.version} found`)
      : note('bad', 'Java was not found', 'The Minecraft server needs Java. Install it, then restart this app.', { label: 'Get Java', run: () => api.openLink('java') }));

    const different = Boolean(selected && folder.hasWorld && folder.worldSource && folder.worldSource !== selected.path);
    if (different) {
      notes.append(note('warn', 'The server holds a different world', `It was copied from ${folder.worldSource}. Tick the box below to switch to the selected world.`));
    } else if (folder.hasWorld) {
      const copied = folder.worldCopiedAt ? ` Copied ${formatDate(folder.worldCopiedAt)}.` : '';
      notes.append(note('info', 'The server keeps its own copy of the world', `Progress made on the server is kept between runs.${copied}`));
    }

    setValue('setting-memory', saved.settings.memoryGb);
    setValue('setting-port', saved.settings.port);
    setValue('setting-players', saved.settings.maxPlayers);
    setValue('setting-motd', saved.settings.motd);
    setValue('setting-address', saved.settings.joinAddress);
    $('setting-address').placeholder = `${state.system.lanAddress} (this computer)`;
    setValue('setting-version', saved.settings.version);
    const detected = (selected && selected.minecraftVersion) || folder.minecraftVersion;
    $('setting-version').placeholder = detected ? `${detected} (from the world)` : 'For example 26.2';
    $('server-folder').textContent = folder.path;
    $('server-folder').title = folder.path;
    for (const id of ['setting-memory', 'setting-port', 'setting-players', 'setting-motd', 'setting-version', 'setting-address', 'change-folder']) {
      $(id).disabled = !stopped;
    }

    $('replace-row').hidden = !(folder.hasWorld && selected);
    if (selected) $('replace-label').textContent = `Replace the server world with a fresh copy of "${worldTitle(selected)}"`;
    if (!folder.hasWorld) $('replace-world').checked = false;
    $('replace-world').disabled = !stopped;

    $('eula').checked = Boolean(saved.eulaAcceptedAt);
    $('eula').disabled = !stopped;

    if (!java.installed) setCardState('server', 'todo', 'Java needed');
    else if (!saved.eulaAcceptedAt) setCardState('server', 'todo', 'EULA needed');
    else setCardState('server', 'done', 'Ready');
  }

  // -- Header and live panels --

  function renderHeader() {
    const current = state.session.state;
    const stopped = isStopped();
    const preparing = current === 'preparing';
    const reason = stopped ? blocker() : null;

    $('status-pill').dataset.state = current;
    $('status-text').textContent = STATUS_TEXT[current] || current;
    renderUptime();

    $('join-address').textContent = joinAddress();

    $('start').hidden = !stopped && !preparing;
    $('start').disabled = preparing || Boolean(reason);
    $('start-label').textContent = preparing ? 'Getting ready...' : 'Start server';
    $('stop').hidden = stopped || preparing;
    $('stop-label').textContent = current === 'stopping' ? 'End now' : 'Stop';
    $('start-hint').textContent = reason ? reason.text : '';
    $('start-hint').hidden = !reason;
  }

  function renderUptime() {
    const { startedAt } = state.session;
    $('uptime').textContent = startedAt && isLive() ? formatUptime(Date.now() - startedAt) : '';
  }

  function personItem(name, badge, action) {
    const item = element('li');
    item.append(element('span', 'avatar', name.replace(/^\./, '').charAt(0).toUpperCase()));
    item.append(element('span', 'name', name));
    if (badge) item.append(element('span', 'badge', badge));
    const button = element('button', 'button small', action.label);
    button.type = 'button';
    button.disabled = !isLive();
    button.addEventListener('click', action.run);
    item.append(button);
    return item;
  }

  function renderPeople() {
    const { players, operators } = state.session;
    const live = isLive();
    $('player-count').textContent = String(players.length);

    const online = $('players');
    online.replaceChildren();
    if (!players.length) online.append(element('li', 'empty-row', live ? 'Nobody has joined yet' : 'Players appear here while the server runs'));
    for (const name of players) {
      const admin = operators.includes(name);
      online.append(personItem(name, admin ? 'Admin' : '', {
        label: admin ? 'Remove admin' : 'Make admin',
        run: () => api.setOperator(name, !admin)
      }));
    }

    const admins = $('operators');
    admins.replaceChildren();
    if (!operators.length) admins.append(element('li', 'empty-row', live ? 'No admins yet' : 'Admins can use commands in game'));
    for (const name of operators) {
      admins.append(personItem(name, '', { label: 'Remove', run: () => api.setOperator(name, false) }));
    }

    $('command').disabled = !live;
    $('send-command').disabled = !live;
    $('admin-name').disabled = !live;
    $('add-admin').disabled = !live;
    $('admin-name').placeholder = live ? 'Player name' : 'Start the server to add admins';
  }

  function render() {
    renderWorld();
    renderPack();
    renderServer();
    renderHeader();
    renderPeople();
  }

  // -- Console --

  function lineKind(text) {
    if (text.startsWith('[ZBK Server]')) return 'app';
    if (text.startsWith('> ')) return 'command';
    if (/\/(ERROR|FATAL)\]|Exception|^\s+at /.test(text)) return 'error';
    if (/\/WARN\]/.test(text)) return 'warn';
    if (/\]: \S+ (joined|left) the game$/.test(text)) return 'event';
    return '';
  }

  function clearLog() {
    $('console-output').replaceChildren();
    openLine = null;
  }

  function appendLog(text) {
    const output = $('console-output');
    const pinned = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    const parts = text.replace(/\r/g, '').split('\n');

    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (!openLine) {
        if (last && part === '') return;
        openLine = element('span');
        output.append(openLine);
      }
      openLine.textContent += part;
      if (last) return;
      openLine.className = lineKind(openLine.textContent);
      openLine.textContent += '\n';
      openLine = null;
    });

    while (output.childElementCount > MAX_CONSOLE_LINES) output.firstElementChild.remove();
    if (pinned) output.scrollTop = output.scrollHeight;
  }

  function setConsoleExpanded(expanded) {
    document.body.classList.toggle('console-full', expanded);
    $('toggle-console').setAttribute('aria-pressed', String(expanded));
    $('toggle-console-icon').setAttribute('href', expanded ? '#i-shrink' : '#i-expand');
    $('toggle-console-label').textContent = expanded ? 'Shrink' : 'Expand';
    const output = $('console-output');
    output.scrollTop = output.scrollHeight;
  }

  // -- Actions --

  function applySelection(selection) {
    state.selection = selection;
    render();
  }

  async function save(changes) {
    applySelection(await api.saveConfig(changes));
  }

  async function choose(request, errorId) {
    showMessage(errorId, '');
    const result = await request();
    if (result.canceled) return false;
    if (result.error) {
      showMessage(errorId, result.error);
      return false;
    }
    applySelection(result.selection);
    return true;
  }

  async function start() {
    showMessage('run-error', '');
    clearLog();
    const result = await api.startServer({
      replaceWorld: $('replace-world').checked,
      eulaAccepted: $('eula').checked
    });
    if (result.ok) $('replace-world').checked = false;
    else if (!result.canceled) showMessage('run-error', result.error);
    applySelection(await api.selection());
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(joinAddress());
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('join-address'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    $('copied').hidden = false;
    setTimeout(() => { $('copied').hidden = true; }, 1500);
  }

  function numberFrom(id, fallback) {
    const value = Number.parseInt($(id).value, 10);
    return Number.isFinite(value) ? value : fallback;
  }

  function bindEvents() {
    $('choose-world').addEventListener('click', () => choose(api.chooseWorld, 'world-error'));
    $('change-world').addEventListener('click', () => choose(api.chooseWorld, 'world-error'));

    for (const radio of document.querySelectorAll('input[name="pack-source"]')) {
      radio.addEventListener('change', async () => {
        if (radio.value === 'file' && !config().pack.filePath) {
          if (!await choose(api.chooseResourcePack, 'pack-error')) render();
          return;
        }
        save({ pack: { source: radio.value } });
      });
    }
    $('choose-pack').addEventListener('click', () => choose(api.chooseResourcePack, 'pack-error'));

    for (const radio of document.querySelectorAll('input[name="pack-delivery"]')) {
      radio.addEventListener('change', () => save({ pack: { delivery: radio.value } }));
    }
    $('pack-host').addEventListener('change', event => save({ pack: { hostAddress: event.target.value.trim() } }));
    $('pack-port').addEventListener('change', () => save({ pack: { port: numberFrom('pack-port', 8123) } }));
    $('pack-url').addEventListener('change', event => save({ pack: { url: event.target.value.trim() } }));
    $('pack-required').addEventListener('change', event => save({ pack: { required: event.target.checked } }));

    $('start').addEventListener('click', start);
    $('start-hint').addEventListener('click', () => {
      const reason = blocker();
      if (reason) pointAt(reason);
    });
    $('stop').addEventListener('click', () => api.stopServer(state.session.state === 'stopping'));
    $('copy-address').addEventListener('click', copyAddress);

    $('eula').addEventListener('change', event => save({
      eulaAcceptedAt: event.target.checked ? new Date().toISOString() : ''
    }));
    $('eula-link').addEventListener('click', event => {
      event.preventDefault();
      api.openLink('eula');
    });

    $('setting-memory').addEventListener('change', () => save({ settings: { memoryGb: numberFrom('setting-memory', 4) } }));
    $('setting-port').addEventListener('change', () => save({ settings: { port: numberFrom('setting-port', DEFAULT_PORT) } }));
    $('setting-players').addEventListener('change', () => save({ settings: { maxPlayers: numberFrom('setting-players', 8) } }));
    $('setting-motd').addEventListener('change', event => save({ settings: { motd: event.target.value } }));
    $('setting-address').addEventListener('change', event => save({ settings: { joinAddress: event.target.value.trim() } }));

    $('toggle-console').addEventListener('click', () => {
      setConsoleExpanded(!document.body.classList.contains('console-full'));
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.body.classList.contains('console-full')) setConsoleExpanded(false);
    });
    $('setting-version').addEventListener('change', event => save({ settings: { version: event.target.value.trim() } }));
    $('change-folder').addEventListener('click', () => choose(api.chooseServerFolder, 'run-error'));
    $('open-folder').addEventListener('click', async () => {
      const result = await api.openServerFolder();
      showMessage('run-error', result.ok ? '' : 'The server folder does not exist yet. It is created when the server first starts.');
    });

    $('command-form').addEventListener('submit', event => {
      event.preventDefault();
      const input = $('command');
      if (!input.value.trim()) return;
      api.sendCommand(input.value);
      input.value = '';
    });

    $('admin-form').addEventListener('submit', event => {
      event.preventDefault();
      const input = $('admin-name');
      const name = input.value.trim();
      if (!name) return;
      api.setOperator(name, true);
      input.value = '';
    });
  }

  function bindServerEvents() {
    api.onStatus(status => {
      state.session.state = status.state;
      state.session.startedAt = status.startedAt;
      render();
    });
    api.onPlayers(({ players, operators }) => {
      state.session.players = players;
      state.session.operators = operators;
      renderPeople();
    });
    api.onLog(appendLog);
    setInterval(renderUptime, 1000);
  }

  async function init() {
    const startup = await api.startup();
    state.system = startup.system;
    state.session = startup.session;
    state.selection = {
      config: startup.config,
      world: startup.world,
      bundledPack: startup.bundledPack,
      pack: startup.pack,
      serverFolder: startup.serverFolder
    };

    bindEvents();
    bindServerEvents();
    render();
    document.body.dataset.ready = 'true';
  }

  init();
})();
