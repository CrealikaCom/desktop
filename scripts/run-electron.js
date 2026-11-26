// Runs the launcher from a checkout: `npm start`. Arguments are passed to Electron.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { displayArgs } from '../launcher/core/display.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// Electron-based terminals (VS Code and others) pass this flag to child processes.
delete env.ELECTRON_RUN_AS_NODE;
// Display switches up front, so the app does not have to start itself again (launcher/core/display.js).
const args = process.argv.slice(2);
const child = spawn(electron, [root, ...displayArgs({ env, argv: args }), ...args], { cwd: root, env, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(err);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
