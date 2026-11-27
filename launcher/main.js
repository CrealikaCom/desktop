// Crealika Desktop entry point. One executable, two modes:
// - no arguments: the launcher window (launcher-app.js);
// - --service=<id>: a standalone service process with its own window (service-host.js).
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { parseServiceArg } from './core/args.js';
import { displayArgs } from './core/display.js';
import { ID_RE } from './core/manifest.js';
import { selfCommand } from './core/services.js';
import { runLauncher } from './launcher-app.js';
import { runServiceHost } from './service-host.js';

// The display platform only takes effect from the command line, so a process started without it
// (a desktop shortcut) starts again with it. Processes started by the app get it right away.
// Not app.relaunch(): its helper runs from the AppImage mount, which goes away with this process.
const missing = displayArgs();
const serviceId = parseServiceArg(process.argv);
if (missing.length) {
  const command = selfCommand({ packaged: app.isPackaged });
  spawn(command, [...process.argv.slice(1), ...missing], { detached: true, stdio: 'inherit' }).unref();
  app.exit(0);
} else if (serviceId !== null && !ID_RE.test(serviceId)) {
  console.error(`Invalid service id: ${serviceId}`);
  process.exit(2);
} else if (serviceId) runServiceHost(serviceId);
else runLauncher();
