// Which installs update themselves from GitHub Releases: the Windows installer and the Linux
// AppImage. A .deb is updated by installing the new package. macOS builds are not signed yet,
// and updates there need a signed app. CREALIKA_DESKTOP_NO_UPDATES=1 turns updates off.
export function updatesSupported({ packaged, platform = process.platform, env = process.env }) {
  if (!packaged || env.CREALIKA_DESKTOP_NO_UPDATES === '1') return false;
  if (platform === 'win32') return true;
  return platform === 'linux' && Boolean(env.APPIMAGE);
}
