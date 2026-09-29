/**
 * log-events.js - Recognise player and status events in server console output.
 *
 * Only messages written by the server itself are matched. Chat lines start
 * with "<", "[" or "*" after the log prefix, so a player cannot forge them.
 */

const PLAYER_NAME = /^[A-Za-z0-9_.]{1,32}$/;
const NAME = '([A-Za-z0-9_.]{1,32})';
const PREFIX = '^\\[[^\\]]*\\] \\[[^\\]]*\\]: ';

const PATTERNS = [
  { type: 'join', pattern: new RegExp(`${PREFIX}${NAME} joined the game$`) },
  { type: 'leave', pattern: new RegExp(`${PREFIX}${NAME} left the game$`) },
  { type: 'op', pattern: new RegExp(`${PREFIX}Made ${NAME} a server operator$`) },
  { type: 'deop', pattern: new RegExp(`${PREFIX}Made ${NAME} no longer a server operator$`) }
];

const READY = new RegExp(`${PREFIX}Done \\(`);

const HINTS = [
  {
    pattern: /UnsupportedClassVersionError/,
    hint: 'The installed Java is too old for this Minecraft version. Install the Java version shown on the Run page.'
  },
  {
    pattern: /FAILED TO BIND TO PORT|Address already in use/i,
    hint: 'The server port is already in use. Close the other server or choose a different port in Settings.'
  },
  {
    pattern: /You need to agree to the EULA/i,
    hint: 'Minecraft needs the EULA to be accepted. Tick the EULA box on the Run page and start again.'
  },
  {
    pattern: /Could not reserve enough space|Invalid maximum heap size/i,
    hint: 'This computer cannot give the server that much memory. Lower the memory in Settings.'
  }
];

function isPlayerName(name) {
  return typeof name === 'string' && PLAYER_NAME.test(name);
}

/** Interpret one console line. Returns null when the line is not an event. */
function parseServerLine(line) {
  const text = line.replace(/\r$/, '');
  for (const { type, pattern } of PATTERNS) {
    const match = text.match(pattern);
    if (match) return { type, name: match[1] };
  }
  if (READY.test(text)) return { type: 'ready' };
  for (const { pattern, hint } of HINTS) {
    if (pattern.test(text)) return { type: 'hint', hint };
  }
  return null;
}

/** Split streamed output into whole lines, keeping a partial line for later. */
function createLineSplitter(onLine) {
  let pending = '';
  return chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) onLine(line);
  };
}

module.exports = { isPlayerName, parseServerLine, createLineSplitter };
