// Launcher updates (electron-updater): checked when the launcher starts, downloaded in the
// background and installed when the launcher quits. Installing replaces the executable that
// running services use, so with services running the update waits for a later quit.
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { updatesSupported } from './core/updates.js';

const { autoUpdater } = electronUpdater;

export function startUpdates({ servicesRunning }) {
  if (!updatesSupported({ packaged: app.isPackaged })) return;
  let downloaded = false;
  let decided = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Only the first line of errors: a failed request carries all of its headers.
  autoUpdater.logger = null;
  autoUpdater.on('error', (err) => console.error(`Update check failed: ${String(err.message).split('\n')[0]}`));
  autoUpdater.on('update-downloaded', () => {
    downloaded = true;
  });
  app.on('before-quit', (e) => {
    if (!downloaded || decided) return;
    e.preventDefault();
    decided = true;
    servicesRunning().then(
      (busy) => (busy ? app.quit() : autoUpdater.quitAndInstall(true, false)),
      () => app.quit(),
    );
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
