/**
 * fake-server.js - Stands in for the Minecraft server during tests.
 *
 * Prints the same console lines the real server does and answers the commands
 * the app sends. Set FAKE_SERVER_IGNORE_STOP to test a server that hangs.
 */

const readline = require('readline');

const say = message => process.stdout.write(`[12:00:00] [Server thread/INFO]: ${message}\n`);

say('Starting minecraft server version 26.2');
say('Done (0.1s)! For help, type "help"');
say('Stew joined the game');
say('<Stew> Made Intruder a server operator');

readline.createInterface({ input: process.stdin }).on('line', line => {
  const [command, name] = line.trim().split(' ');
  if (command === 'op') say(`Made ${name} a server operator`);
  else if (command === 'deop') say(`Made ${name} no longer a server operator`);
  else if (command === 'stop' && !process.env.FAKE_SERVER_IGNORE_STOP) {
    say('Stopping the server');
    process.exit(0);
  } else say(`Unknown or incomplete command: ${line}`);
});
