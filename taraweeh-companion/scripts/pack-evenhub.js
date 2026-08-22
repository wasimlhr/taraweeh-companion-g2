/**
 * Build dist/ and pack taraweeh-companion-v{version}.ehpk for EvenHub upload.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outName = `taraweeh-companion-v${pkg.version}.ehpk`;
const check = process.argv.includes('--check');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node', ['scripts/build-evenhub-dist.js']);

const packArgs = [
  '@evenrealities/evenhub-cli@0.1.14',
  'pack',
  'app.json',
  'dist',
  '-o',
  outName,
];
if (check) packArgs.push('--check');

run('npx', packArgs);
console.log(`[pack-evenhub] Wrote ${join(root, outName)}`);
