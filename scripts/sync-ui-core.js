// Copies Crealika UI core from a local checkout into vendor/crealika-ui-core:
//   node scripts/sync-ui-core.js <path to crealika-ui-core>
// Only the runtime and license files are copied (no tests, demo or package metadata besides the version).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['crealika-ui.css', 'crealika-ui.js', 'crealika-ui.d.ts', 'i18n.js', 'crealika-prefs.js',
  'crealika-figures.js', 'crealika-figures.d.ts', 'README.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md'];
const DIRS = ['themes', 'fonts', 'brand'];

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/sync-ui-core.js <path to crealika-ui-core>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'vendor', 'crealika-ui-core');
const { version } = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
for (const file of FILES) await fs.copyFile(path.join(source, file), path.join(target, file));
for (const dir of DIRS) await fs.cp(path.join(source, dir), path.join(target, dir), { recursive: true });
await fs.writeFile(path.join(target, 'VERSION'), `${version}\n`);
console.log(`Crealika UI core ${version} -> ${path.relative(root, target)}`);
