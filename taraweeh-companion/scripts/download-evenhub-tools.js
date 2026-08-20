#!/usr/bin/env node
/**
 * Download / refresh Even Realities EvenHub CLI + glasses simulator.
 *
 * Usage:
 *   npm run evenhub:download
 *   npm run sim
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  '@evenrealities/evenhub-simulator@latest',
  '@evenrealities/evenhub-cli@latest',
];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Downloading EvenHub simulator + CLI…');
run('npm', ['install', '--save-dev', '--no-fund', '--no-audit', ...PACKAGES]);

const require = createRequire(join(root, 'package.json'));
for (const spec of PACKAGES) {
  const name = spec.replace(/@latest$/, '');
  try {
    const pkg = require(`${name}/package.json`);
    console.log(`  ${name} → ${pkg.version}`);
  } catch {
    console.log(`  ${name} installed`);
  }
}

console.log('\nRun the G2 simulator against the local app:');
console.log('  npm run sim');
console.log('Generate a glasses QR code:');
console.log('  npm run qr');
