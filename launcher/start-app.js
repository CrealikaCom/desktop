// Starts another process of this same executable, detached: --service=<id> runs a service host,
// --show=<id> the launcher with that service's card highlighted.
import { app } from 'electron';
import { spawnApp } from './core/services.js';

export function startApp(lay, { service, show }) {
  const arg = service ? `--service=${service}` : `--show=${show}`;
  const args = app.isPackaged ? [arg] : [app.getAppPath(), arg];
  return spawnApp({ command: process.execPath, args, home: lay.home });
}
