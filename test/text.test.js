const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeProperties, readProperty } = require('../src/main/lib/properties');
const { parseServerLine, createLineSplitter, isPlayerName } = require('../src/main/lib/log-events');
const { parseJavaVersion } = require('../src/main/lib/system');
const { parseAddress } = require('../src/main/lib/address');

test('updates named properties and keeps everything else', () => {
  const original = [
    '#Minecraft server properties',
    'difficulty=hard',
    'server-port=25565',
    'resource-pack=https\\://example.com/old.zip',
    'white-list=true',
    ''
  ].join('\n');

  const merged = mergeProperties(original, {
    'server-port': 25570,
    'resource-pack': 'http://192.168.1.20:8123/resource_pack.zip',
    'max-players': 8
  });

  assert.equal(merged, [
    '#Minecraft server properties',
    'difficulty=hard',
    'server-port=25570',
    'resource-pack=http://192.168.1.20:8123/resource_pack.zip',
    'white-list=true',
    'max-players=8',
    ''
  ].join('\n'));
  assert.equal(readProperty(merged, 'difficulty'), 'hard');
  assert.equal(readProperty(original, 'resource-pack'), 'https://example.com/old.zip');
  assert.equal(readProperty(merged, 'missing'), null);
});

test('creates properties from nothing and keeps a message on one line', () => {
  const merged = mergeProperties('', { motd: 'Line one\nLine two' });
  assert.equal(merged, 'motd=Line one\\nLine two\n');
  assert.equal(readProperty(merged, 'motd'), 'Line one\nLine two');
});

test('recognises server events in console lines', () => {
  const at = '[12:00:00] [Server thread/INFO]: ';

  assert.deepEqual(parseServerLine(`${at}Stew joined the game`), { type: 'join', name: 'Stew' });
  assert.deepEqual(parseServerLine(`${at}Stew left the game\r`), { type: 'leave', name: 'Stew' });
  assert.deepEqual(parseServerLine(`${at}Made Stew a server operator`), { type: 'op', name: 'Stew' });
  assert.deepEqual(parseServerLine(`${at}Made Stew no longer a server operator`), { type: 'deop', name: 'Stew' });
  assert.deepEqual(parseServerLine(`${at}Done (4.2s)! For help, type "help"`), { type: 'ready' });
  assert.equal(parseServerLine(`${at}Preparing spawn area: 40%`), null);
  assert.equal(parseServerLine('java.lang.UnsupportedClassVersionError: x').type, 'hint');
});

test('ignores chat that imitates server events', () => {
  const at = '[12:00:00] [Server thread/INFO]: ';

  assert.equal(parseServerLine(`${at}<Stew> Made Alex a server operator`), null);
  assert.equal(parseServerLine(`${at}<Stew> Alex joined the game`), null);
  assert.equal(parseServerLine(`${at}[Not Secure] <Stew> Alex joined the game`), null);
  assert.equal(parseServerLine(`${at}* Stew joined the game`), null);
  assert.equal(parseServerLine(`${at}[Stew] Done (1s)!`), null);
});

test('accepts only plain player names', () => {
  assert.equal(isPlayerName('Stew_1114'), true);
  assert.equal(isPlayerName('.BedrockPlayer'), true);
  assert.equal(isPlayerName('Stew\nstop'), false);
  assert.equal(isPlayerName('Stew @a'), false);
  assert.equal(isPlayerName(''), false);
});

test('joins output that arrives in pieces', () => {
  const lines = [];
  const push = createLineSplitter(line => lines.push(line));
  push('first li');
  push('ne\nsecond line\nthi');
  push('rd');
  assert.deepEqual(lines, ['first line', 'second line']);
});

test('reads the Java major version', () => {
  assert.deepEqual(parseJavaVersion('openjdk version "25.0.4.1" 2026-08-18 LTS'), { version: '25.0.4.1', major: 25 });
  assert.deepEqual(parseJavaVersion('java version "1.8.0_391"'), { version: '1.8.0_391', major: 8 });
  assert.equal(parseJavaVersion('command not found'), null);
});

test('reads host names, IP addresses, and optional ports', () => {
  assert.deepEqual(parseAddress('play.example.net'), { host: 'play.example.net', port: null });
  assert.deepEqual(parseAddress(' 192.168.1.20:25570 '), { host: '192.168.1.20', port: 25570 });
  assert.deepEqual(parseAddress('https://abc.example.gg:8123/resource_pack.zip'), { host: 'abc.example.gg', port: 8123 });
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('my server'), null);
  assert.equal(parseAddress('example.net:99999'), null);
  assert.equal(parseAddress('example.net:80:90'), null);
  assert.equal(parseAddress('-bad.example.net'), null);
});
