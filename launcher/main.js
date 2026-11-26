// Crealika Desktop entry point. One executable, two modes:
// - no arguments: the launcher window (launcher-app.js);
// - --service=<id>: a standalone service process with its own window (service-host.js).
import { app } from 'electron';
import { parseServiceArg } from './core/args.js';
import { displayArgs } from './core/display.js';
import { ID_RE } from './core/manifest.js';
import { runLauncher } from './launcher-app.js';
import { runServiceHost } from './service-host.js';

// The display platform only takes effect from the command line, so a process started without it
// (a desktop shortcut) starts again with it. Processes started by the app get it right away.
const missing = displayArgs();
const serviceId = parseServiceArg(process.argv);
if (missing.length) {
  app.relaunch({ args: [...process.argv.slice(1), ...missing] });
  app.exit(0);
} else if (serviceId !== null && !ID_RE.test(serviceId)) {
  console.error(`Invalid service id: ${serviceId}`);
  process.exit(2);
} else if (serviceId) runServiceHost(serviceId);
else runLauncher();
