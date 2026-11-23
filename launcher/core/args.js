// Startup mode: --service <id> or --service=<id> runs a service process, otherwise the launcher.
export function parseServiceArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--service') return argv[i + 1] ?? null;
    if (argv[i].startsWith('--service=')) return argv[i].slice('--service='.length);
  }
  return null;
}
