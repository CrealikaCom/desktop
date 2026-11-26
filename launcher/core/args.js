// Startup mode: --service <id> or --service=<id> runs a service process, otherwise the launcher.
export function parseServiceArg(argv) {
  return parseArg(argv, 'service');
}

// Launcher only: --show=<id> highlights that service's card.
export function parseShowArg(argv) {
  return parseArg(argv, 'show');
}

function parseArg(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(`--${name}=`.length);
  }
  return null;
}
