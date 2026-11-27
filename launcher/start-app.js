// Starts another process of this same executable, detached: --service=<id> runs a service host,
// --show=<id> the launcher with that service's card highlighted.
import { app } from 'electron';
import { DISPLAY_SWITCH } from './core/display.js';
import { selfCommand, spawnApp } from './core/services.js';

export function startApp(lay, { service, show }) {
  const arg = service ? `--service=${service}` : `--show=${show}`;
  // The same display switches as this process, on the command line (see core/display.js).
  const display = process.argv.filter((a) => DISPLAY_SWITCH.test(a));
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...display, arg];
  return spawnApp({ command: selfCommand({ packaged: app.isPackaged }), args, home: lay.home });
}
