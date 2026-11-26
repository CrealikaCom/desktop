// Display server for the windows on Linux. Under Wayland one app cannot bring another app's
// window to the front without an activation token, and Electron cannot hand one to another
// process, so switching between services would leave the focus where it was. With XWayland
// available the launcher and the service hosts run as X11 clients, where they can.
// Under XWayland the NVIDIA driver crashes Chromium's default GL path (the windows fall back to
// software rendering), so there the GPU is used through ANGLE on Vulkan.
// CREALIKA_DESKTOP_WAYLAND=1 keeps native Wayland; switches given on the command line win.
// Returns Chromium switches as [name, value] pairs.
export function displaySwitches({
  platform = process.platform, env = process.env, argv = process.argv, nvidia = false,
} = {}) {
  if (platform !== 'linux' || env.CREALIKA_DESKTOP_WAYLAND === '1') return [];
  const given = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (given('ozone-platform') || !env.WAYLAND_DISPLAY || !env.DISPLAY) return [];
  const out = [['ozone-platform', 'x11']];
  if (nvidia && !given('use-angle') && !given('use-gl')) out.push(['use-angle', 'vulkan']);
  return out;
}
