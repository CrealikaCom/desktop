// Crealika Desktop entry point. One executable, two modes:
// - no arguments: the launcher window (launcher-app.js);
// - --service=<id>: a standalone service process with its own window (service-host.js).
import { existsSync } from 'node:fs';
import { app } from 'electron';
import { parseServiceArg } from './core/args.js';
import { displaySwitches } from './core/display.js';
import { ID_RE } from './core/manifest.js';
import { runLauncher } from './launcher-app.js';
import { runServiceHost } from './service-host.js';

// Before the app is ready: the display platform is chosen at startup.
for (const [name, value] of displaySwitches({ nvidia: existsSync('/proc/driver/nvidia/version') })) {
  app.commandLine.appendSwitch(name, value);
}

const serviceId = parseServiceArg(process.argv);
if (serviceId !== null && !ID_RE.test(serviceId)) {
  console.error(`Invalid service id: ${serviceId}`);
  process.exit(2);
}
if (serviceId) runServiceHost(serviceId);
else runLauncher();
